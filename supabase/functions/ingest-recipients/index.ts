import { createClient, SupabaseClient } from '@supabase/supabase-js';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { parseFile } from './parse.ts';
import { legacyId } from './legacy_id.ts';
import { bucketFor, Bucket } from './bucket.ts';
import { aiSuggestMapping, fallbackMapping, aiNormalizeRows } from './ai.ts';
import type { NormalizedRow } from './ai.ts';
import { geocodeRows } from './geocode.ts';

interface IngestRequest {
  campaign_id: string;
  file_b64: string;
  file_type: 'csv' | 'xlsx';
  column_mapping?: Record<string, string | null>;
  ai_disabled?: boolean;
}

const TARGETS = ['company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip', 'notes'] as const;
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

// Areas are loaded lazily and cached per-isolate. Supabase recycles edge
// isolates often enough that polygon edits propagate within seconds; an
// admin who needs an instant refresh can redeploy the function.
type DeliveryArea = { id: string; bakery_id: string; geometry: unknown };
let _areasCache: DeliveryArea[] | null = null;
async function loadAreas(sb: SupabaseClient): Promise<DeliveryArea[]> {
  if (_areasCache) return _areasCache;
  const { data, error } = await sb.from('delivery_areas').select('id, bakery_id, geometry');
  if (error) throw new Error('delivery_areas load failed: ' + error.message);
  _areasCache = data || [];
  return _areasCache;
}
function findAreaIn(areas: DeliveryArea[], lon: number, lat: number): { bakery_id: string; id: string } | null {
  for (const a of areas) {
    const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} } as const;
    const poly = { type: 'Feature', geometry: a.geometry, properties: {} } as const;
    try {
      if (booleanPointInPolygon(pt as never, poly as never)) return { bakery_id: a.bakery_id, id: a.id };
    } catch (_) { continue; }
  }
  return null;
}

// Per-row re-geocode + re-bucket. Wired to the wizard's "Retry geocode" /
// "Edit address" actions in Task 13.
async function handleGeocodeSingle(req: Request, sb: SupabaseClient): Promise<Response> {
  let body: { recipient_id?: string; address?: string | null; city?: string | null; state?: string | null; zip?: string | null };
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }
  if (!body.recipient_id) return jsonResponse({ error: 'recipient_id_required' }, 400);

  const { data: r, error: rErr } = await sb.from('recipients')
    .select('id, company, campaign_id')
    .eq('id', body.recipient_id)
    .maybeSingle();
  if (rErr) return jsonResponse({ error: 'database_error', detail: rErr.message }, 500);
  if (!r) return jsonResponse({ error: 'recipient_not_found' }, 404);

  const address = body.address ?? null;
  const city = body.city ?? null;
  const state = body.state ?? null;
  const zip = body.zip ?? null;

  const [g] = await geocodeRows(sb, [{ address, city, state, zip }]);
  const areas = await loadAreas(sb);
  const matched = g ? findAreaIn(areas, g.lon, g.lat) : null;
  const bucket: Bucket = bucketFor({
    hasCompany: !!r.company,
    hasAddress: !!address,
    aiConfidence: 'high',
    geocodeOk: !!g,
    areaMatch: matched,
  });
  const { error: upErr } = await sb.from('recipients').update({
    address: address || null, city: city || null, state: state || null, zip: zip || null,
    lat: g?.lat ?? null, lon: g?.lon ?? null,
    bakery_id: matched ? matched.bakery_id : null,
    assignment_status: bucket,
  }).eq('id', body.recipient_id);
  if (upErr) return jsonResponse({ error: 'database_error', detail: upErr.message }, 500);

  return jsonResponse({
    assignment_status: bucket,
    lat: g?.lat ?? null,
    lon: g?.lon ?? null,
    bakery_id: matched?.bakery_id ?? null,
  });
}

// Per-row manual entry. Wired to UploadWizard's "Add recipient" form. Uses
// (campaign_id, legacy_id) for duplicate detection so a customer who types
// the same row twice gets the existing recipient back, not a second copy.
async function handleManualAdd(req: Request, sb: SupabaseClient): Promise<Response> {
  let body: {
    campaign_id?: string;
    company?: string; contact_name?: string | null;
    phone?: string | null; email?: string | null;
    address?: string; city?: string | null; state?: string | null; zip?: string | null;
    lat?: number | null; lon?: number | null;
  };
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const company = (body.company || '').trim();
  const address = (body.address || '').trim();
  if (!body.campaign_id || !company || !address) {
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  }

  const { data: campaign, error: campErr } = await sb.from('campaigns')
    .select('id').eq('id', body.campaign_id).maybeSingle();
  if (campErr) return jsonResponse({ error: 'database_error', detail: campErr.message }, 500);
  if (!campaign) return jsonResponse({ error: 'campaign_not_found' }, 404);

  const legacy_id = await legacyId(company, address);

  // Dedup check: if a recipient with this legacy_id already exists in this
  // campaign, return it untouched. The (campaign_id, legacy_id) unique index
  // is the safety net for the race window between this SELECT and the INSERT.
  const { data: existing } = await sb.from('recipients')
    .select('id, assignment_status, lat, lon, bakery_id')
    .eq('campaign_id', body.campaign_id)
    .eq('legacy_id', legacy_id)
    .maybeSingle();
  if (existing) {
    return jsonResponse({
      duplicate: true,
      recipient_id: existing.id,
      assignment_status: existing.assignment_status,
      lat: existing.lat, lon: existing.lon,
      bakery_id: existing.bakery_id,
    });
  }

  const city  = (body.city  || '').trim() || null;
  const state = (body.state || '').trim() || null;
  const zip   = (body.zip   || '').trim() || null;

  // Use client-supplied coords when present (came from a Mapbox autocomplete
  // pick); otherwise geocode the address ourselves via the same single-row
  // batch the bulk pipeline uses.
  let lat: number | null = (typeof body.lat === 'number') ? body.lat : null;
  let lon: number | null = (typeof body.lon === 'number') ? body.lon : null;
  if (lat === null || lon === null) {
    const [g] = await geocodeRows(sb, [{ address, city, state, zip }]);
    lat = g?.lat ?? null;
    lon = g?.lon ?? null;
  }

  const areas = await loadAreas(sb);
  const matched = (lat !== null && lon !== null) ? findAreaIn(areas, lon, lat) : null;
  const bucket: Bucket = bucketFor({
    hasCompany: !!company,
    hasAddress: !!address,
    aiConfidence: 'high',
    geocodeOk: lat !== null && lon !== null,
    areaMatch: matched,
  });

  const { data: inserted, error: insErr } = await sb.from('recipients').insert({
    campaign_id: body.campaign_id,
    bakery_id: matched ? matched.bakery_id : null,
    company,
    contact_name: (body.contact_name || '').trim() || null,
    phone: (body.phone || '').trim() || null,
    email: (body.email || '').trim() || null,
    address,
    city, state, zip,
    lat, lon,
    assignment_status: bucket,
    legacy_id,
    customizations: {},
  }).select('id').single();
  if (insErr) {
    // 23505 = Postgres unique_violation. Reachable when two concurrent calls
    // both pass the maybeSingle() dedup check and race to insert. The
    // (campaign_id, legacy_id) unique index makes one of them lose; surface
    // that as the same `duplicate: true` response the SELECT branch returns
    // so the UI shows the friendly notice instead of a generic 500.
    if ((insErr as { code?: string }).code === '23505') {
      const { data: again } = await sb.from('recipients')
        .select('id, assignment_status, lat, lon, bakery_id')
        .eq('campaign_id', body.campaign_id)
        .eq('legacy_id', legacy_id)
        .maybeSingle();
      if (again) {
        return jsonResponse({
          duplicate: true,
          recipient_id: again.id,
          assignment_status: again.assignment_status,
          lat: again.lat, lon: again.lon,
          bakery_id: again.bakery_id,
        });
      }
    }
    return jsonResponse({ error: 'database_error', detail: insErr.message }, 500);
  }

  return jsonResponse({
    recipient_id: inserted!.id,
    assignment_status: bucket,
    lat, lon,
    bakery_id: matched ? matched.bakery_id : null,
    duplicate: false,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Sub-route: per-row re-geocode. Different request shape, so dispatch
  // before we try to parse the bulk-ingest body.
  if (new URL(req.url).pathname.endsWith('/geocode-single')) {
    return await handleGeocodeSingle(req, sb);
  }

  if (new URL(req.url).pathname.endsWith('/manual-add')) {
    return await handleManualAdd(req, sb);
  }

  let body: IngestRequest;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }
  if (!body.campaign_id || !body.file_b64 || !body.file_type) return jsonResponse({ error: 'missing_required_fields' }, 400);

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
      notes: m.notes || null,
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
          notes: m.notes || null,
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

  // 3. Geocode every row in one batched pass (cache lookup + Mapbox for misses).
  //    Throws only if MAPBOX_SECRET_TOKEN is missing — individual lookup
  //    failures yield `null` so they fall into the geocode_failed bucket.
  const geocodes = await geocodeRows(sb, normalized.map(n => ({
    address: n.address, city: n.city, state: n.state, zip: n.zip,
  })));

  // 4. Load bakery delivery areas once for point-in-polygon checks.
  const areas = await loadAreas(sb);

  // 5. Bucket + collect inserts using normalized + geocoded + area-matched values.
  const totals = { assigned: 0, needs_review: 0, flagged_out_of_area: 0, geocode_failed: 0 };
  const insertRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < normalized.length; i++) {
    const n = normalized[i];
    const g = geocodes[i];
    const matched = g ? findAreaIn(areas, g.lon, g.lat) : null;
    const bucket: Bucket = bucketFor({
      hasCompany: !!n.company, hasAddress: !!n.address,
      aiConfidence: n.confidence,
      geocodeOk: !!g,
      areaMatch: matched,
    });
    totals[bucket]++;
    insertRows.push({
      campaign_id: body.campaign_id,
      bakery_id: matched ? matched.bakery_id : null,
      company: n.company || '(unknown)',
      contact_name: n.contact_name,
      phone: n.phone, email: n.email,
      address: n.address || '(unknown)',
      city: n.city, state: n.state, zip: n.zip,
      notes: n.notes,
      lat: g?.lat ?? null, lon: g?.lon ?? null,
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

  // 6. Sample up to 10 problem rows (any non-'assigned' status) for the
  //    wizard's review-step preview. Re-query so we get database-assigned ids.
  const sample_issues: Array<{ recipient_id: string; reason: string; raw: Record<string, string> }> = [];
  const { data: insertedRows } = await sb.from('recipients')
    .select('id, company, address, assignment_status')
    .eq('campaign_id', body.campaign_id)
    .neq('assignment_status', 'assigned')
    .limit(10);
  for (const r of insertedRows || []) {
    sample_issues.push({
      recipient_id: r.id,
      reason: r.assignment_status,
      raw: { company: r.company, address: r.address },
    });
  }

  return jsonResponse({ totals, sample_issues, mapping_used: mapping });
});
