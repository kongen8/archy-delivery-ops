// Mapbox geocoding with a Supabase-side cache.
//
// Cache key: lowercased "address, city, state, zip" join (empty parts dropped).
// On miss we hit Mapbox (US-only, limit=1), retry up to 3 times on 429 with
// exponential backoff, and persist successful hits via UPSERT/ignore so two
// concurrent ingest calls can race the same address without erroring.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface GeocodeResult { lat: number; lon: number; display_name: string }

export interface GeocodeInput {
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

const MAPBOX_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places/';

// Exported for unit tests + index.ts callers that want to reuse the same
// cache key (e.g. the geocode-single sub-route in Task 9).
export function normalizeAddress(parts: GeocodeInput): string {
  return [parts.address, parts.city, parts.state, parts.zip]
    .map(p => (p || '').trim())
    .filter(Boolean)
    .join(', ')
    .toLowerCase();
}

async function geocodeOne(query: string, token: string): Promise<GeocodeResult | null> {
  const url = MAPBOX_URL + encodeURIComponent(query)
    + '.json?access_token=' + encodeURIComponent(token)
    + '&country=US&limit=1';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      // Drain body so the Deno HTTP client releases the connection before we sleep.
      try { await res.text(); } catch (_) { /* ignore */ }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      continue;
    }
    if (!res.ok) {
      try { await res.text(); } catch (_) { /* ignore */ }
      return null;
    }
    const json = await res.json();
    const f = json.features?.[0];
    if (!f) return null;
    return { lon: f.center[0], lat: f.center[1], display_name: f.place_name };
  }
  return null;
}

export async function geocodeRows(
  sb: SupabaseClient,
  rows: GeocodeInput[],
): Promise<Array<GeocodeResult | null>> {
  const token = Deno.env.get('MAPBOX_SECRET_TOKEN');
  if (!token) throw new Error('MAPBOX_SECRET_TOKEN not set');

  const normalized = rows.map(normalizeAddress);
  const results: Array<GeocodeResult | null> = new Array(rows.length).fill(null);
  const toFetch: number[] = [];

  // 1. Cache lookup, batched in chunks of 100 so the .in() query string stays
  //    well under PostgREST's URL limit even on 1k-row uploads.
  for (let i = 0; i < normalized.length; i += 100) {
    const chunk = normalized
      .slice(i, i + 100)
      .map((n, k) => ({ idx: i + k, n }))
      .filter(x => x.n);
    if (chunk.length === 0) continue;
    const { data: hits, error } = await sb.from('geocode_cache')
      .select('normalized_address, lat, lon, display_name')
      .in('normalized_address', chunk.map(c => c.n));
    if (error) throw new Error('geocode_cache lookup failed: ' + error.message);
    const hitMap = new Map((hits || []).map(h => [h.normalized_address, h]));
    for (const c of chunk) {
      const hit = hitMap.get(c.n);
      if (hit) results[c.idx] = { lat: hit.lat, lon: hit.lon, display_name: hit.display_name || '' };
      else toFetch.push(c.idx);
    }
  }

  // 2. Mapbox calls for cache misses, max 4 in flight to keep within the
  //    permanent-token rate limit (600/min) without burning quota.
  let cursor = 0;
  const cacheWrites: Array<Record<string, unknown>> = [];
  async function worker() {
    while (cursor < toFetch.length) {
      const my = cursor++;
      const idx = toFetch[my];
      const query = normalized[idx];
      if (!query) continue;
      const hit = await geocodeOne(query, token);
      results[idx] = hit;
      if (hit) cacheWrites.push({
        normalized_address: query,
        lat: hit.lat,
        lon: hit.lon,
        display_name: hit.display_name,
        provider: 'mapbox',
      });
    }
  }
  const pool = Array(Math.min(4, toFetch.length)).fill(0).map(() => worker());
  await Promise.all(pool);

  // 3. Persist new cache entries (best effort; ignore conflicts on the PK so
  //    concurrent ingests don't error on duplicate keys).
  if (cacheWrites.length > 0) {
    // Two rows in the same batch can share a normalized_address (e.g. two
    // identical Acmes pointing to the same address). Dedup before upsert to
    // avoid the same "command cannot affect row a second time" pitfall the
    // recipients upsert hit.
    const seen = new Set<string>();
    const dedupedWrites = cacheWrites.filter(w => {
      const k = w.normalized_address as string;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    await sb.from('geocode_cache').upsert(dedupedWrites, {
      onConflict: 'normalized_address',
      ignoreDuplicates: true,
    });
  }

  return results;
}
