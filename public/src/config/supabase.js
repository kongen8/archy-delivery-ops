// ===== SUPABASE CONFIG =====
const SUPABASE_URL = window.__SUPABASE_URL__ || 'https://vqmjevtthpedzdfotaie.supabase.co';
const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__ || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxbWpldnR0aHBlZHpkZm90YWllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzODIwODcsImV4cCI6MjA5MTk1ODA4N30.mct_oZri4PLJVkrhZC3uzkq0qMYZExM7Y_30mQP30S8';

// Resolved in tenant.js (runs first). When present, every Supabase request
// carries `x-tenant-token: <token>` as a header; RLS policies in migration
// 004_rls.sql consult this header to scope rows to the tenant.
const _tenantToken = window.__TENANT_TOKEN__ || null;

const _supabaseReady = SUPABASE_URL !== 'PLACEHOLDER_NOT_SET' && typeof supabase !== 'undefined';
const _tenantClientOpts = _tenantToken
  ? { global: { headers: { 'x-tenant-token': _tenantToken } } }
  : undefined;
const sb = _supabaseReady
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, _tenantClientOpts)
  : null;

// Build an additional tenant-scoped client on demand (e.g. to temporarily act
// as a different tenant in tests). Normal app code should just use `sb`.
function makeTenantClient(token) {
  if (!_supabaseReady || !token) return null;
  return supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { 'x-tenant-token': token } }
  });
}
window.makeTenantClient = makeTenantClient;

// If a token is present, probe the server to confirm it's still valid. If it
// was revoked/deleted the RLS helpers return NULL and the app would otherwise
// render as an empty shell with no obvious way to sign out. On rejection,
// clear the stashed token and bounce back to the login gate.
if (sb && _tenantToken) {
  sb.rpc('tenant_is_authenticated').then(({ data, error }) => {
    if (error) {
      console.warn('Tenant auth probe failed (keeping token for now):', error.message);
      return;
    }
    if (data === false && typeof window.tenantSignOut === 'function') {
      console.warn('Tenant token was rejected by the server; signing out.');
      window.tenantSignOut();
    }
  });
}

// ===== PERSISTENCE LAYER =====
const DB = {
  ready: !!sb,

  // --- Delivery Statuses ---
  async loadStatuses() {
    if (!sb) return {};
    try {
      const { data, error } = await sb.from('delivery_statuses').select('*');
      if (error) throw error;
      const statuses = {};
      (data || []).forEach(row => {
        if (row.status !== 'pending') statuses[row.id] = row.status;
        if (row.note) statuses[row.id + '_note'] = row.note;
        if (row.photo_url) statuses[row.id + '_photo'] = row.photo_url;
        if (row.delivered_at) statuses[row.id + '_time'] = new Date(row.delivered_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      });
      return statuses;
    } catch (e) { console.warn('DB loadStatuses failed:', e); return {}; }
  },

  async saveStatus(id, status, note, photoUrl) {
    if (!sb) return;
    try {
      await sb.from('delivery_statuses').upsert({
        id,
        status,
        note: note || null,
        photo_url: photoUrl || null,
        delivered_at: status === 'delivered' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      });
    } catch (e) { console.warn('DB saveStatus failed:', e); }
  },

  async deleteStatus(id) {
    if (!sb) return;
    try {
      await sb.from('delivery_statuses').delete().eq('id', id);
    } catch (e) { console.warn('DB deleteStatus failed:', e); }
  },

  // --- Photo Upload ---
  async uploadPhoto(stopId, file) {
    if (!sb) return URL.createObjectURL(file);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${stopId}_${Date.now()}.${ext}`;
      const { data, error } = await sb.storage.from('delivery-photos').upload(path, file, { upsert: true });
      if (error) throw error;
      const { data: urlData } = sb.storage.from('delivery-photos').getPublicUrl(path);
      return urlData.publicUrl;
    } catch (e) {
      console.warn('Photo upload failed, using local URL:', e);
      return URL.createObjectURL(file);
    }
  },

  // --- Route Overrides ---
  async loadRouteOverrides() {
    if (!sb) return {};
    try {
      const { data, error } = await sb.from('route_overrides').select('*');
      if (error) throw error;
      const overrides = {};
      (data || []).forEach(row => { overrides[row.region] = row.data; });
      return overrides;
    } catch (e) { console.warn('DB loadRouteOverrides failed:', e); return {}; }
  },

  async saveRouteOverride(region, routeData) {
    if (!sb) return;
    try {
      if (routeData === null) {
        await sb.from('route_overrides').delete().eq('region', region);
      } else {
        await sb.from('route_overrides').upsert({ region, data: routeData, updated_at: new Date().toISOString() });
      }
    } catch (e) { console.warn('DB saveRouteOverride failed:', e); }
  },

  // --- Depot Overrides ---
  async loadDepotOverrides() {
    if (!sb) return {};
    try {
      const { data, error } = await sb.from('depot_overrides').select('*');
      if (error) throw error;
      const overrides = {};
      (data || []).forEach(row => { overrides[row.region] = row.depots; });
      return overrides;
    } catch (e) { console.warn('DB loadDepotOverrides failed:', e); return {}; }
  },

  async saveDepotOverride(region, depots) {
    if (!sb) return;
    try {
      await sb.from('depot_overrides').upsert({ region, depots, updated_at: new Date().toISOString() });
    } catch (e) { console.warn('DB saveDepotOverride failed:', e); }
  },

  // --- Realtime subscription ---
  subscribeStatuses(callback) {
    if (!sb) return () => {};
    const channel = sb.channel('statuses-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_statuses' }, () => {
        DB.loadStatuses().then(callback);
      })
      .subscribe();
    return () => sb.removeChannel(channel);
  },

  // --- Photo Databank ---
  async loadAllPhotos() {
    if (!sb) return [];
    try {
      const { data, error } = await sb.from('delivery_statuses')
        .select('id,status,note,photo_url,delivered_at,updated_at')
        .not('photo_url', 'is', null);
      if (error) throw error;
      return (data || []).sort((a, b) => {
        const ta = new Date(a.delivered_at || a.updated_at || 0).getTime();
        const tb = new Date(b.delivered_at || b.updated_at || 0).getTime();
        return tb - ta;
      });
    } catch (e) { console.warn('DB loadAllPhotos failed:', e); return []; }
  }
};
