// ===== GEOCODE HELPERS =====
// Forward geocoding: Mapbox Geocoding v6 (when MAPBOX_API_KEY is set) with a
// Nominatim fallback so the app still works if Mapbox is down or the token is
// missing. Typeahead suggestions use Mapbox only (Nominatim has no suggest API).

async function geocodeAddress(addr) {
  const key = window.MAPBOX_API_KEY;
  if (key) {
    try {
      const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(addr)}&limit=1&access_token=${key}`;
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        const f = j.features && j.features[0];
        if (f && f.geometry && Array.isArray(f.geometry.coordinates)) {
          const [lon, lat] = f.geometry.coordinates;
          return { lat, lon, display: f.properties?.full_address || f.properties?.place_formatted || addr };
        }
      }
    } catch (e) { console.warn('Mapbox geocode failed, falling back to Nominatim:', e); }
  }
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addr)}&limit=1`;
    const r = await fetch(url);
    const j = await r.json();
    if (j && j[0]) return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), display: j[0].display_name };
  } catch (e) { console.warn('Nominatim geocode failed:', e); }
  return null;
}

// Live autocomplete suggestions. Returns an array of { id, text, address, lat, lon }.
// `sessionToken` is a random string per typing session — Mapbox bills one "search
// session" per token which bundles suggest + retrieve calls, massively cheaper.
async function suggestAddress(query, { sessionToken, proximity, limit = 5, signal } = {}) {
  const key = window.MAPBOX_API_KEY;
  if (!key || !query || query.trim().length < 3) return [];
  try {
    const params = new URLSearchParams({
      q: query,
      access_token: key,
      language: 'en',
      limit: String(limit),
      session_token: sessionToken || Math.random().toString(36).slice(2),
      types: 'address,place,postcode,locality,neighborhood,poi',
    });
    if (proximity) params.set('proximity', `${proximity.lon},${proximity.lat}`);
    const r = await fetch(`https://api.mapbox.com/search/searchbox/v1/suggest?${params.toString()}`, { signal });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.suggestions || []).map(s => ({
      id: s.mapbox_id,
      text: s.name || s.full_address || s.place_formatted || '',
      address: s.full_address || s.place_formatted || s.name || '',
      subtext: s.place_formatted || '',
      // lat/lon need a follow-up retrieve call
    }));
  } catch (e) {
    if (e?.name !== 'AbortError') console.warn('Mapbox suggest failed:', e);
    return [];
  }
}

// Pure helper — pulls structured address pieces out of a Mapbox Searchbox v1
// `feature.properties` object. Returns nulls for absent pieces; never throws.
// Extracted as its own function so the manual-add form can autofill the
// city / state / zip inputs the moment the user picks a suggestion (and so
// the parser is unit-testable without mocking fetch).
function parseRetrieveContext(properties) {
  const ctx = (properties && properties.context) || {};
  const address =
    (ctx.address && ctx.address.name) ||
    properties?.address ||
    null;
  const city = (ctx.place && ctx.place.name) || null;
  const state =
    (ctx.region && (ctx.region.region_code || ctx.region.name)) || null;
  const zip = (ctx.postcode && ctx.postcode.name) || null;
  return { address, city, state, zip };
}

// Retrieve full coords for a suggestion (same sessionToken as the suggest call
// keeps the search-session billing tier).
async function retrieveAddress(mapboxId, { sessionToken } = {}) {
  const key = window.MAPBOX_API_KEY;
  if (!key || !mapboxId) return null;
  try {
    const params = new URLSearchParams({
      access_token: key,
      session_token: sessionToken || Math.random().toString(36).slice(2),
    });
    const r = await fetch(`https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(mapboxId)}?${params.toString()}`);
    if (!r.ok) return null;
    const j = await r.json();
    const f = j.features && j.features[0];
    if (!f) return null;
    const [lon, lat] = f.geometry?.coordinates || [];
    const parts = parseRetrieveContext(f.properties || {});
    return {
      lat, lon,
      address: f.properties?.full_address || f.properties?.place_formatted || parts.address || f.properties?.name || '',
      street: parts.address,
      city:   parts.city,
      state:  parts.state,
      zip:    parts.zip,
    };
  } catch (e) { console.warn('Mapbox retrieve failed:', e); return null; }
}

window.geocodeAddress = geocodeAddress;
window.suggestAddress = suggestAddress;
window.retrieveAddress = retrieveAddress;
window.parseRetrieveContext = parseRetrieveContext;
