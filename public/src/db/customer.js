// ===== CUSTOMER DATA ACCESS =====
// Wizard-side helpers. Permissive RLS (Plan 2 pivot) makes these direct
// browser writes safe; ingestFile() routes through the edge function so
// the AI/geocode/area-match pipeline stays server-side.
const Customer = {
  async createDraftCampaign(customer_id, name) {
    if (!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('campaigns')
      .insert({ customer_id, name, status: 'draft' })
      .select('*').single();
    if (error) throw error;
    return data;
  },

  async finalizeCampaign(id) {
    if (!sb) throw new Error('sb not ready');
    const { error } = await sb.from('campaigns').update({ status: 'active' }).eq('id', id);
    if (error) throw error;
  },

  async listRecipients(campaign_id) {
    if (!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('recipients')
      .select('id, company, contact_name, phone, email, address, city, state, zip, lat, lon, assignment_status, customizations, bakery_id')
      .eq('campaign_id', campaign_id)
      .order('company');
    if (error) throw error;
    return data || [];
  },

  async ingestFile({ campaign_id, file, columnMapping }) {
    if (!sb) throw new Error('sb not ready');
    const fileType = /\.xlsx$/i.test(file.name) ? 'xlsx' : 'csv';
    const buf = await file.arrayBuffer();
    // String.fromCharCode(...new Uint8Array(buf)) blows the JS arg limit for
    // files larger than ~50KB; chunk through to keep it safe up to 5k rows.
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const b64 = btoa(bin);
    const url = sb.supabaseUrl.replace('.supabase.co', '.functions.supabase.co') + '/ingest-recipients';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + sb.supabaseKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ campaign_id, file_b64: b64, file_type: fileType, column_mapping: columnMapping }),
    });
    if (!res.ok) throw new Error('ingest failed: ' + res.status + ' ' + await res.text());
    return await res.json();
  },
};

if (typeof window !== 'undefined') window.Customer = Customer;
