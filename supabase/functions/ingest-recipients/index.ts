import { createClient } from '@supabase/supabase-js';
import { parseFile } from './parse.ts';
import { legacyId } from './legacy_id.ts';
import { bucketFor, Bucket } from './bucket.ts';

interface IngestRequest {
  campaign_id: string;
  file_b64: string;
  file_type: 'csv' | 'xlsx';
  column_mapping?: Record<string, string | null>;
  ai_disabled?: boolean;
}

const TARGETS = ['company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip'] as const;
type Target = typeof TARGETS[number];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function applyMapping(headers: string[], row: string[], mapping: Record<string, string | null>): Record<Target, string> {
  const out = {} as Record<Target, string>;
  for (const t of TARGETS) out[t] = '';
  headers.forEach((h, i) => {
    const target = mapping[h] as Target | null | undefined;
    if (target && TARGETS.includes(target)) out[target] = (row[i] || '').trim();
  });
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: IngestRequest;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }
  if (!body.campaign_id || !body.file_b64 || !body.file_type) return jsonResponse({ error: 'missing_required_fields' }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: campaign, error: campaignErr } = await sb.from('campaigns').select('id').eq('id', body.campaign_id).maybeSingle();
  if (campaignErr) return jsonResponse({ error: 'database_error', detail: campaignErr.message }, 500);
  if (!campaign) return jsonResponse({ error: 'campaign_not_found' }, 404);

  let parsed;
  try { parsed = parseFile(body.file_b64, body.file_type); }
  catch (e) { return jsonResponse({ error: 'parse_failed', detail: (e as Error).message }, 400); }

  const mapping = body.column_mapping || {};
  const totals = { assigned: 0, needs_review: 0, flagged_out_of_area: 0, geocode_failed: 0 };
  const insertRows: Array<Record<string, unknown>> = [];

  for (const row of parsed.rows) {
    const fields = applyMapping(parsed.headers, row, mapping);
    const bucket: Bucket = bucketFor({
      hasCompany: !!fields.company,
      hasAddress: !!fields.address,
      geocodeOk: false,    // Task 8 will set this
      areaMatch: null,      // Task 9 will set this
    });
    totals[bucket]++;
    insertRows.push({
      campaign_id: body.campaign_id,
      bakery_id: null,
      company: fields.company || '(unknown)',
      contact_name: fields.contact_name || null,
      phone: fields.phone || null,
      email: fields.email || null,
      address: fields.address || '(unknown)',
      city: fields.city || null, state: fields.state || null, zip: fields.zip || null,
      lat: null, lon: null,
      assignment_status: bucket,
      legacy_id: await legacyId(fields.company, fields.address),
      customizations: {},
    });
  }

  // Postgres' INSERT ... ON CONFLICT DO NOTHING raises 'command cannot affect
  // row a second time' when duplicate keys appear in the same VALUES clause —
  // ignoreDuplicates only handles conflicts against existing rows, not siblings
  // in the same batch. Dedup by legacy_id before upserting.
  const seen = new Set<string>();
  const deduped = insertRows.filter(r => {
    const k = r.legacy_id as string;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (deduped.length > 0) {
    const { error } = await sb.from('recipients')
      .upsert(deduped, { onConflict: 'campaign_id,legacy_id', ignoreDuplicates: true });
    if (error) return jsonResponse({ error: 'database_error', detail: error.message }, 500);
  }

  return jsonResponse({ totals, sample_issues: [], mapping_used: mapping });
});
