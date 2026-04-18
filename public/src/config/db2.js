// ===== DB2 — reads/writes for the multi-tenant schema =====
// Uses the same `sb` client as DB. Later plans will switch to makeTenantClient(token)
// for bakery/customer views; for now Plan 1 runs against anon with RLS disabled.
const DB2 = {
  ready: !!sb,

  async loadArchyContext() {
    if (!sb) return null;
    try {
      const { data: customer } = await sb.from('customers').select('*').eq('name', 'Archy').maybeSingle();
      if (!customer) return null;
      const { data: campaign } = await sb.from('campaigns')
        .select('*').eq('customer_id', customer.id).order('created_at').limit(1).maybeSingle();
      if (!campaign) return null;
      const { data: bakeries } = await sb.from('bakeries').select('*');
      return { customer, campaign, bakeries: bakeries || [] };
    } catch (e) { console.warn('DB2 loadArchyContext failed:', e); return null; }
  },

  async loadRecipients(campaignId) {
    if (!sb) return [];
    const { data, error } = await sb.from('recipients')
      .select('*').eq('campaign_id', campaignId);
    if (error) { console.warn('DB2 loadRecipients failed:', error); return []; }
    return data || [];
  },

  async loadDepots(bakeryId) {
    if (!sb) return [];
    const { data } = await sb.from('depots').select('*').eq('bakery_id', bakeryId);
    return data || [];
  },

  async loadAllDepots() {
    if (!sb) return {};
    const { data } = await sb.from('depots').select('*');
    const byBakery = {};
    (data || []).forEach(d => {
      (byBakery[d.bakery_id] = byBakery[d.bakery_id] || []).push(d);
    });
    return byBakery;
  },

  async loadRoutes(campaignId) {
    if (!sb) return [];
    const { data } = await sb.from('routes').select('*').eq('campaign_id', campaignId);
    return data || [];
  },

  async loadRoutesForArea(campaignId, deliveryAreaId) {
    if (!sb) return [];
    const { data } = await sb.from('routes').select('*')
      .eq('campaign_id', campaignId)
      .eq('delivery_area_id', deliveryAreaId);
    return data || [];
  },

  async saveRoute(campaignId, bakeryId, deliveryAreaId, routeData) {
    if (!sb) return;
    if (routeData === null) {
      await sb.from('routes').delete()
        .eq('campaign_id', campaignId)
        .eq('bakery_id', bakeryId)
        .eq('delivery_area_id', deliveryAreaId);
      return;
    }
    await sb.from('routes').upsert(
      {
        campaign_id: campaignId,
        bakery_id: bakeryId,
        delivery_area_id: deliveryAreaId,
        data: routeData,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'campaign_id,bakery_id,delivery_area_id' }
    );
  },

  async upsertDepot({ id, bakeryId, name, address, lat, lon }) {
    if (!sb) return null;
    const row = { bakery_id: bakeryId, name, address, lat, lon };
    if (id) {
      const { data } = await sb.from('depots').update(row).eq('id', id).select('*').single();
      return data;
    }
    const { data } = await sb.from('depots').insert(row).select('*').single();
    return data;
  },

  async deleteDepot(id) {
    if (!sb) return;
    await sb.from('depots').delete().eq('id', id);
  },

  // --- Statuses (v2) ---
  async loadStatuses(campaignId) {
    if (!sb) return {};
    const recipsRes = await sb.from('recipients').select('id').eq('campaign_id', campaignId);
    const ids = (recipsRes.data || []).map(r => r.id);
    if (!ids.length) return {};
    const { data } = await sb
      .from('delivery_statuses_v2')
      .select('recipient_id, status, note, photo_url, delivered_at')
      .in('recipient_id', ids);
    const out = {};
    (data || []).forEach(row => {
      if (row.status !== 'pending') out[row.recipient_id] = row.status;
      if (row.note) out[row.recipient_id + '_note'] = row.note;
      if (row.photo_url) out[row.recipient_id + '_photo'] = row.photo_url;
      if (row.delivered_at) out[row.recipient_id + '_time'] =
        new Date(row.delivered_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    return out;
  },

  async saveStatus(recipientId, status, note, photoUrl) {
    if (!sb) return;
    await sb.from('delivery_statuses_v2').upsert({
      recipient_id: recipientId,
      status,
      note: note || null,
      photo_url: photoUrl || null,
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    });
  },

  async deleteStatus(recipientId) {
    if (!sb) return;
    await sb.from('delivery_statuses_v2').delete().eq('recipient_id', recipientId);
  },

  subscribeStatuses(campaignId, callback) {
    if (!sb) return () => {};
    const channel = sb.channel('statuses-v2-realtime')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_statuses_v2' },
        () => DB2.loadStatuses(campaignId).then(callback))
      .subscribe();
    return () => sb.removeChannel(channel);
  },

  // --- Photos (reuse existing storage bucket: 'delivery-photos') ---
  async uploadPhoto(recipientId, file) {
    if (!sb) return URL.createObjectURL(file);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${recipientId}_${Date.now()}.${ext}`;
      const { error } = await sb.storage.from('delivery-photos').upload(path, file, { upsert: true });
      if (error) throw error;
      const { data: urlData } = sb.storage.from('delivery-photos').getPublicUrl(path);
      return urlData.publicUrl;
    } catch (e) {
      console.warn('Photo upload failed, using local URL:', e);
      return URL.createObjectURL(file);
    }
  },

  async loadAllPhotos(campaignId) {
    if (!sb) return [];
    const { data: recips } = await sb.from('recipients').select('id, company, city').eq('campaign_id', campaignId);
    if (!recips?.length) return [];
    const ids = recips.map(r => r.id);
    const { data } = await sb
      .from('delivery_statuses_v2')
      .select('recipient_id, status, note, photo_url, delivered_at, updated_at')
      .not('photo_url', 'is', null)
      .in('recipient_id', ids);
    const byId = new Map(recips.map(r => [r.id, r]));
    return (data || [])
      .map(row => ({ ...row, company: byId.get(row.recipient_id)?.company, city: byId.get(row.recipient_id)?.city }))
      .sort((a, b) => {
        const ta = new Date(a.delivered_at || a.updated_at || 0).getTime();
        const tb = new Date(b.delivered_at || b.updated_at || 0).getTime();
        return tb - ta;
      });
  },
};
window.DB2 = DB2;
