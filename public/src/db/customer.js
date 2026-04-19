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

  // Soft-delete a draft campaign. Only drafts are deletable; the .eq filters
  // make this a no-op (data === null) if the row was promoted to a non-draft
  // status or already deleted between render and click. The cascading
  // recipients/routes rows stay in the database — restoring just clears
  // deleted_at.
  async deleteDraftCampaign(id) {
    if (!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('campaigns')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'draft')
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Campaign cannot be deleted (not a draft).');
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

  // Per-row "Accept" — used when the customer has confirmed (or edited) the
  // displayed values. Always flips status to 'assigned' regardless of what
  // bucket the row was in. The edge function's geocode-single sub-route
  // handles the cases that need re-geocoding (see retryGeocode below).
  async acceptRecipient(id, fields) {
    if (!sb) throw new Error('sb not ready');
    const update = {
      assignment_status: 'assigned',
      company: fields.company ?? null,
      contact_name: fields.contact_name ?? null,
      phone: fields.phone ?? null,
      email: fields.email ?? null,
      address: fields.address ?? null,
      city: fields.city ?? null,
      state: fields.state ?? null,
      zip: fields.zip ?? null,
    };
    const { error } = await sb.from('recipients').update(update).eq('id', id);
    if (error) throw error;
  },

  // "Skip" stamps a flag in the JSONB customizations blob rather than
  // deleting the row, so the audit trail survives. Bakery views filter out
  // skipped rows in Plan 4; for now they're just hidden from totals by the
  // wizard's bucket counts via the assignment_status (we leave it where it
  // is so customers can un-skip later if they reopen the campaign).
  async skipRecipient(id) {
    if (!sb) throw new Error('sb not ready');
    const { data: r, error: rErr } = await sb.from('recipients').select('customizations').eq('id', id).single();
    if (rErr) throw rErr;
    const next = { ...(r?.customizations || {}), skipped: true };
    const { error } = await sb.from('recipients').update({ customizations: next }).eq('id', id);
    if (error) throw error;
  },

  // "Edit address" / "Edit & retry" — routes through the edge function so
  // the new address gets re-geocoded + re-area-matched + re-bucketed in one
  // round trip. Returns the new {assignment_status, lat, lon, bakery_id}.
  async retryGeocode(recipient_id, fields) {
    if (!sb) throw new Error('sb not ready');
    const url = sb.supabaseUrl.replace('.supabase.co', '.functions.supabase.co') + '/ingest-recipients/geocode-single';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + sb.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id, ...fields }),
    });
    if (!res.ok) throw new Error('retry geocode failed: ' + res.status + ' ' + await res.text());
    return await res.json();
  },
};

if (typeof window !== 'undefined') window.Customer = Customer;
