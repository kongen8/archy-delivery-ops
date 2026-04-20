// ===== CUSTOMER DATA ACCESS =====
// Wizard-side helpers. Permissive RLS (Plan 2 pivot) makes these direct
// browser writes safe; ingestFile() routes through the edge function so
// the AI/geocode/area-match pipeline stays server-side.
const Customer = {
  async createDraftCampaign(customer_id, name, notes) {
    if (!sb) throw new Error('sb not ready');
    const insert = { customer_id, name, status: 'draft' };
    // Trim and ignore empty so a blank textarea doesn't write '' to the column.
    if (notes && notes.trim()) insert.notes = notes.trim();
    const { data, error } = await sb.from('campaigns')
      .insert(insert)
      .select('*').single();
    if (error) throw error;
    return data;
  },

  async setCampaignNote(campaign_id, note) {
    if (!sb) throw new Error('sb not ready');
    const value = note && note.trim() ? note.trim() : null;
    const { error } = await sb.from('campaigns').update({ notes: value }).eq('id', campaign_id);
    if (error) throw error;
  },

  async finalizeCampaign(id) {
    if (!sb) throw new Error('sb not ready');
    const { error } = await sb.from('campaigns').update({ status: 'active' }).eq('id', id);
    if (error) throw error;
  },

  async listRecipients(campaign_id) {
    if (!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('recipients')
      .select('id, company, contact_name, phone, email, address, city, state, zip, notes, lat, lon, assignment_status, customizations, bakery_id, bakery:bakeries(name)')
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
    // Notes is optional on the form — only write it when the caller actually
    // included the key, so the simpler "Edit address" flow doesn't blow away
    // an existing note by passing undefined.
    if ('notes' in fields) update.notes = fields.notes && fields.notes.trim() ? fields.notes.trim() : null;
    const { error } = await sb.from('recipients').update(update).eq('id', id);
    if (error) throw error;
  },

  async setRecipientNote(recipient_id, note) {
    if (!sb) throw new Error('sb not ready');
    const value = note && note.trim() ? note.trim() : null;
    const { error } = await sb.from('recipients').update({ notes: value }).eq('id', recipient_id);
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

  // POSTs a single manually-entered recipient through the edge function so
  // it goes through the same geocode + area-match + bucket pipeline as a
  // bulk row. Returns:
  //   { recipient_id, assignment_status, lat, lon, bakery_id, duplicate }
  // `duplicate: true` means an existing recipient with the same
  // (company, address) was returned without a second insert.
  async addRecipient({ campaign_id, company, contact_name, phone, email,
                       address, city, state, zip, lat, lon }) {
    if (!sb) throw new Error('sb not ready');
    const url = sb.supabaseUrl.replace('.supabase.co', '.functions.supabase.co') + '/ingest-recipients/manual-add';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + sb.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign_id, company, contact_name, phone, email,
        address, city, state, zip,
        lat: typeof lat === 'number' ? lat : null,
        lon: typeof lon === 'number' ? lon : null,
      }),
    });
    if (!res.ok) throw new Error('addRecipient failed: ' + res.status + ' ' + await res.text());
    return await res.json();
  },

  // ===== Plan 5 — design helpers =====

  async setCampaignDefaultDesign(campaign_id, design) {
    if (!sb) throw new Error('sb not ready');
    const { error } = await sb.from('campaigns')
      .update({ default_design: design || {} })
      .eq('id', campaign_id);
    if (error) throw error;
  },

  // Updates ONLY the design-relevant keys on a recipient's customizations
  // jsonb, preserving any other keys (e.g. Plan 3's `skipped: true`).
  async setRecipientOverride(recipient_id, design) {
    if (!sb) throw new Error('sb not ready');
    const { data: r, error: rErr } = await sb.from('recipients')
      .select('customizations').eq('id', recipient_id).single();
    if (rErr) throw rErr;
    const next = { ...(r?.customizations || {}) };
    if (design.cake_image_url === null || design.cake_image_url === '') delete next.cake_image_url;
    else if (design.cake_image_url !== undefined) next.cake_image_url = design.cake_image_url;
    if (design.card_image_url === null || design.card_image_url === '') delete next.card_image_url;
    else if (design.card_image_url !== undefined) next.card_image_url = design.card_image_url;
    const { error } = await sb.from('recipients')
      .update({ customizations: next }).eq('id', recipient_id);
    if (error) throw error;
  },

  async removeRecipientOverride(recipient_id) {
    return this.setRecipientOverride(recipient_id, { cake_image_url: null, card_image_url: null });
  },

  // Uploads a Blob to cake-prints/<campaign>/<kind>_<recipient|default>.png
  // and returns the public URL. Overwrites in place — Storage path is
  // deterministic so re-uploading a slot doesn't leave orphaned blobs.
  // We append a ?v=<ts> cache-buster so the CDN-cached prior version of
  // a re-uploaded path isn't served to the browser.
  async uploadDesignAsset(campaign_id, kind, recipient_id_or_default, blob) {
    if (!sb) throw new Error('sb not ready');
    if (kind !== 'cake' && kind !== 'card') throw new Error('kind must be cake|card');
    const path = `${campaign_id}/${kind}_${recipient_id_or_default}.png`;
    const { error } = await sb.storage.from('cake-prints')
      .upload(path, blob, { upsert: true, contentType: 'image/png' });
    if (error) throw error;
    const { data } = sb.storage.from('cake-prints').getPublicUrl(path);
    return data.publicUrl + '?v=' + Date.now();
  },
};

if (typeof window !== 'undefined') window.Customer = Customer;
