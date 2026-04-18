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
      sb.from('campaigns').select('*').eq('customer_id', id).order('created_at'),
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
};

function genToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

if (typeof window !== 'undefined') window.Admin = Admin;
