import { createClient } from '@supabase/supabase-js';
import { parseFile } from './parse.ts';
import { legacyId } from './legacy_id.ts';
import { bucketFor, Bucket } from './bucket.ts';
import { aiSuggestMapping, fallbackMapping, aiNormalizeRows } from './ai.ts';
import type { NormalizedRow } from './ai.ts';

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

  let mapping: Record<string, string | null> = body.column_mapping ?? {};
  if (!body.column_mapping) {
    if (body.ai_disabled || !Deno.env.get('OPENAI_API_KEY')) {
      mapping = fallbackMapping(parsed.headers).mapping;
    } else {
      try { mapping = (await aiSuggestMapping(parsed.headers, parsed.rows)).mapping; }
      catch (_) { mapping = fallbackMapping(parsed.headers).mapping; }
    }
  }
  // 1. Apply mapping → raw mapped fields per row.
  const mapped = parsed.rows.map(r => applyMapping(parsed.headers, r, mapping));

  // 2. AI normalize in batches of 20, max 4 in flight. Per-batch fallback so
  //    an OpenAI failure on one batch doesn't take down the whole ingest.
  let normalized: NormalizedRow[];
  if (body.ai_disabled || !Deno.env.get('OPENAI_API_KEY')) {
    normalized = mapped.map(m => ({
      company: m.company || null, contact_name: m.contact_name || null,
      phone: m.phone || null, email: m.email || null,
      address: m.address || null, city: m.city || null,
      state: m.state || null, zip: m.zip || null,
      confidence: 'high',
    }));
  } else {
    const batches: Record<string, string>[][] = [];
    for (let i = 0; i < mapped.length; i += 20) batches.push(mapped.slice(i, i + 20) as Record<string, string>[]);
    const results: NormalizedRow[][] = new Array(batches.length);
    let idx = 0;
    async function runBatch(b: number) {
      try { results[b] = await aiNormalizeRows(batches[b]); }
      catch (_) {
        results[b] = batches[b].map(m => ({
          company: m.company || null, contact_name: m.contact_name || null,
          phone: m.phone || null, email: m.email || null,
          address: m.address || null, city: m.city || null,
          state: m.state || null, zip: m.zip || null,
          confidence: 'high',
        }));
      }
    }
    const workers = Array(Math.min(4, batches.length)).fill(0).map(async () => {
      while (idx < batches.length) { const my = idx++; await runBatch(my); }
    });
    await Promise.all(workers);
    normalized = results.flat();
  }

  // 3. Bucket + collect inserts using the normalized values.
  const totals = { assigned: 0, needs_review: 0, flagged_out_of_area: 0, geocode_failed: 0 };
  const insertRows: Array<Record<string, unknown>> = [];
  for (const n of normalized) {
    const bucket: Bucket = bucketFor({
      hasCompany: !!n.company, hasAddress: !!n.address,
      aiConfidence: n.confidence,
      geocodeOk: false,    // Task 8 will set this
      areaMatch: null,      // Task 9 will set this
    });
    totals[bucket]++;
    insertRows.push({
      campaign_id: body.campaign_id,
      bakery_id: null,
      company: n.company || '(unknown)',
      contact_name: n.contact_name,
      phone: n.phone, email: n.email,
      address: n.address || '(unknown)',
      city: n.city, state: n.state, zip: n.zip,
      lat: null, lon: null,
      assignment_status: bucket,
      legacy_id: await legacyId(n.company || '', n.address || ''),
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
