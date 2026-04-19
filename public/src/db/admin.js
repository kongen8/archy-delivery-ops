// ===== ADMIN DATA ACCESS =====
// Thin wrapper for Plan 2 admin CRUD. Uses the shared `sb` client; Plan 2
// runs against permissive RLS so all of these calls go straight to
// Postgres. access_token values are generated with crypto.randomUUID()
// at insert time for forward-compat (no auth is enforced today).
const Admin = {
  async listBakeries() {
    if (!sb) return [];
    const { data, error } = await sb.from('bakeries')
      .select('id, name, contact_email, contact_phone, access_token, created_at')
      .order('name');
    if (error) throw error;
    return data || [];
  },

  async listCustomers() {
    if (!sb) return [];
    const { data, error } = await sb.from('customers')
      .select('id, name, contact_email, access_token, created_at')
      .order('name');
    if (error) throw error;
    return data || [];
  },

  async getBakery(id) {
    if (!sb) throw new Error('sb not ready');
    const [{ data: bakery, error: bErr }, { data: delivery_areas, error: dErr }, { data: depots, error: pErr }] = await Promise.all([
      sb.from('bakeries').select('*').eq('id', id).single(),
      sb.from('delivery_areas').select('*').eq('bakery_id', id).order('created_at'),
      sb.from('depots').select('*').eq('bakery_id', id).order('name'),
    ]);
    if (bErr) throw bErr;
    if (dErr) throw dErr;
    if (pErr) throw pErr;
    return { bakery, delivery_areas: delivery_areas || [], depots: depots || [] };
  },

  async getCustomer(id) {
    if (!sb) throw new Error('sb not ready');
    const [{ data: customer, error: cErr }, { data: campaigns, error: pErr }] = await Promise.all([
      sb.from('customers').select('*').eq('id', id).single(),
      sb.from('campaigns').select('*').eq('customer_id', id).is('deleted_at', null).order('created_at'),
    ]);
    if (cErr) throw cErr;
    if (pErr) throw pErr;
    return { customer, campaigns: campaigns || [] };
  },

  async createBakery({ name, contact_email, contact_phone }) {
    if (!sb) throw new Error('sb not ready');
    const row = {
      name,
      contact_email: contact_email || null,
      contact_phone: contact_phone || null,
      access_token: genToken(),
    };
    const { data, error } = await sb.from('bakeries').insert(row).select('*').single();
    if (error) throw error;
    return data;
  },

  async updateBakery(id, patch) {
    if (!sb) throw new Error('sb not ready');
    const allowed = {};
    if ('name' in patch) allowed.name = patch.name;
    if ('contact_email' in patch) allowed.contact_email = patch.contact_email || null;
    if ('contact_phone' in patch) allowed.contact_phone = patch.contact_phone || null;
    const { data, error } = await sb.from('bakeries').update(allowed).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },

  async upsertDeliveryArea({ id, bakery_id, name, geometry }) {
    if (!sb) throw new Error('sb not ready');
    if (id) {
      const { data, error } = await sb.from('delivery_areas')
        .update({ name: name || null, geometry })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data;
    }
    const { data, error } = await sb.from('delivery_areas')
      .insert({ bakery_id, name: name || null, geometry })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  },

  async deleteDeliveryArea(id) {
    if (!sb) return;
    const { error } = await sb.from('delivery_areas').delete().eq('id', id);
    if (error) throw error;
  },

  async listOtherBakeryAreas(excludeBakeryId) {
    if (!sb) return [];
    let q = sb.from('delivery_areas').select('id, bakery_id, name, geometry, bakeries(name)');
    if (excludeBakeryId) q = q.neq('bakery_id', excludeBakeryId);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.id,
      bakery_id: r.bakery_id,
      bakery_name: r.bakeries?.name || '',
      name: r.name,
      geometry: r.geometry,
    }));
  },

  async createCustomer({ name, contact_email }) {
    if (!sb) throw new Error('sb not ready');
    const row = { name, contact_email: contact_email || null, access_token: genToken() };
    const { data, error } = await sb.from('customers').insert(row).select('*').single();
    if (error) throw error;
    return data;
  },

  async updateCustomer(id, patch) {
    if (!sb) throw new Error('sb not ready');
    const allowed = {};
    if ('name' in patch) allowed.name = patch.name;
    if ('contact_email' in patch) allowed.contact_email = patch.contact_email || null;
    const { data, error } = await sb.from('customers').update(allowed).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },

  // Scan every geocoded recipient and figure out which ones should be moved
  // to `bakeryId` because their lat/lon now falls inside one of its areas.
  // Uses the pure computeReassignment helper so the decision logic is unit-
  // tested. Returns the full preview shape (see reassign.js).
  async previewReassignment(bakeryId) {
    if (!sb) throw new Error('sb not ready');
    if (typeof computeReassignment !== 'function') throw new Error('computeReassignment not loaded');
    const [thisRes, othersRes, recipsRes] = await Promise.all([
      sb.from('delivery_areas').select('id, geometry').eq('bakery_id', bakeryId),
      sb.from('delivery_areas').select('id, bakery_id, name, geometry').neq('bakery_id', bakeryId),
      sb.from('recipients')
        .select('id, bakery_id, campaign_id, lat, lon, customizations, company')
        .not('lat', 'is', null)
        .not('lon', 'is', null),
    ]);
    if (thisRes.error) throw thisRes.error;
    if (othersRes.error) throw othersRes.error;
    if (recipsRes.error) throw recipsRes.error;

    const otherByBakery = new Map();
    for (const a of othersRes.data || []) {
      if (!otherByBakery.has(a.bakery_id)) otherByBakery.set(a.bakery_id, { id: a.bakery_id, areas: [] });
      otherByBakery.get(a.bakery_id).areas.push({ id: a.id, name: a.name, geometry: a.geometry });
    }

    return computeReassignment({
      thisBakeryId: bakeryId,
      thisBakeryAreas: thisRes.data || [],
      otherBakeries: Array.from(otherByBakery.values()),
      recipients: recipsRes.data || [],
    });
  },

  // Execute the plan produced by previewReassignment:
  //   1. UPDATE recipients.bakery_id (and strip customizations.legacy_region when set)
  //   2. DELETE `routes` rows for the (campaign, bakery, area) triples that had
  //      stops added or removed, so the adapter rebuilds from the new assignment.
  // Returns { moved, routes_deleted_old, routes_deleted_new }.
  async applyReassignment(bakeryId, preview) {
    if (!sb) throw new Error('sb not ready');
    if (!preview || !Array.isArray(preview.moves)) throw new Error('invalid preview');
    const moves = preview.moves;
    if (moves.length === 0) return { moved: 0, routes_deleted_old: 0, routes_deleted_new: 0 };

    const withTag = moves.filter(m => m.strip_tag).map(m => m.recipient_id);
    const withoutTag = moves.filter(m => !m.strip_tag).map(m => m.recipient_id);

    if (withoutTag.length) {
      const { error } = await sb.from('recipients')
        .update({ bakery_id: bakeryId, assignment_status: 'assigned' })
        .in('id', withoutTag);
      if (error) throw error;
    }

    // Tag-stripping has to happen per-row because PostgREST update() takes a
    // static body — `customizations - 'legacy_region'` requires a raw SQL
    // expression. We fetch current customizations, mutate, and write back.
    if (withTag.length) {
      const { data: rows, error: selErr } = await sb.from('recipients')
        .select('id, customizations')
        .in('id', withTag);
      if (selErr) throw selErr;
      for (const r of rows || []) {
        const next = { ...(r.customizations || {}) };
        delete next.legacy_region;
        const { error } = await sb.from('recipients')
          .update({ bakery_id: bakeryId, assignment_status: 'assigned', customizations: next })
          .eq('id', r.id);
        if (error) throw error;
      }
    }

    let routesOld = 0;
    let routesNew = 0;
    for (const k of preview.route_keys_old) {
      const { error, count } = await sb.from('routes').delete({ count: 'exact' })
        .eq('campaign_id', k.campaign_id).eq('bakery_id', k.bakery_id).eq('delivery_area_id', k.delivery_area_id);
      if (error) throw error;
      routesOld += count || 0;
    }
    for (const k of preview.route_keys_new) {
      const { error, count } = await sb.from('routes').delete({ count: 'exact' })
        .eq('campaign_id', k.campaign_id).eq('bakery_id', k.bakery_id).eq('delivery_area_id', k.delivery_area_id);
      if (error) throw error;
      routesNew += count || 0;
    }

    return { moved: moves.length, routes_deleted_old: routesOld, routes_deleted_new: routesNew };
  },
};

function genToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

if (typeof window !== 'undefined') window.Admin = Admin;
