// ===== MANUAL RECIPIENT FORM =====
// Modal form for adding one recipient at a time to a draft campaign.
// Used by UploadWizard from two places: Step 1 (alternative to file upload)
// and Step 3 (Review's "+ Add recipient" button).
//
// Address autocomplete: picking a Mapbox suggestion fills address + city +
// state + zip + lat + lon all at once. The four address fields stay editable
// after autofill so the user can correct anything Mapbox got wrong.
function ManualRecipientForm({campaignId, onSaved, onClose}) {
  const blank = {
    company: '', contact_name: '', phone: '', email: '',
    address: '', city: '', state: '', zip: '',
    lat: null, lon: null,
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const companyRef = useRef(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const canSave = !saving && form.company.trim() && form.address.trim();

  async function save({ keepOpen }) {
    setSaving(true); setErr(''); setNotice('');
    try {
      const result = await Customer.addRecipient({
        campaign_id: campaignId,
        company: form.company.trim(),
        contact_name: form.contact_name.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim(),
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        zip: form.zip.trim() || null,
        lat: form.lat, lon: form.lon,
      });
      if (result.duplicate) {
        setNotice('This recipient is already in the campaign.');
      }
      onSaved && onSaved(result);
      if (keepOpen) {
        setForm(blank);
        // autoFocus only fires on initial mount, so drive the refocus by ref
        // after the form clears so the user can type the next entry immediately.
        setTimeout(() => companyRef.current?.focus(), 0);
      } else {
        onClose && onClose();
      }
    } catch (e) {
      setErr(e.message || String(e));
    }
    setSaving(false);
  }

  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose && onClose(); }}>
    <div className="modal-card manual-form" role="dialog" aria-label="Add recipient">
      <div className="modal-header">
        <h3>Add recipient</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {err && <div className="wizard-err" style={{margin:'0 0 12px'}}>{err}</div>}
      {notice && <div className="wizard-warn" style={{margin:'0 0 12px'}}>{notice}</div>}

      <div className="manual-form-grid">
        <label>
          <span>Company *</span>
          <input ref={companyRef} autoFocus value={form.company}
            onChange={e => set('company', e.target.value)}
            placeholder="Acme Dental"/>
        </label>
        <label>
          <span>Contact name</span>
          <input value={form.contact_name}
            onChange={e => set('contact_name', e.target.value)}
            placeholder="Dr. Smith"/>
        </label>

        <label className="manual-form-full">
          <span>Address *</span>
          <AddressAutocomplete
            value={form.address}
            onValueChange={v => set('address', v)}
            onPick={picked => {
              if (!picked) { set('lat', null); set('lon', null); return; }
              setForm(f => ({
                ...f,
                // prefer the parsed street line; fall back to whatever the
                // user already typed (NOT picked.address, which is the long
                // formatted "330 Main St, San Francisco, CA 94105, USA" form).
                address: picked.street || f.address,
                city:    picked.city  || f.city,
                state:   picked.state || f.state,
                zip:     picked.zip   || f.zip,
                lat:     picked.lat,
                lon:     picked.lon,
              }));
            }}
            placeholder="Start typing an address…"/>
        </label>

        <label>
          <span>Phone</span>
          <input value={form.phone}
            onChange={e => set('phone', e.target.value)}
            placeholder="415-555-0100"/>
        </label>
        <label>
          <span>Email</span>
          <input value={form.email} type="email"
            onChange={e => set('email', e.target.value)}
            placeholder="front@acme.example"/>
        </label>

        <label>
          <span>City</span>
          <input value={form.city}
            onChange={e => set('city', e.target.value)}
            placeholder="San Francisco"/>
        </label>
        <label className="manual-form-st-zip">
          <span>State / ZIP</span>
          <div style={{display:'flex',gap:6}}>
            <input value={form.state} maxLength={2}
              onChange={e => set('state', e.target.value.toUpperCase())}
              placeholder="CA" style={{width:60}}/>
            <input value={form.zip}
              onChange={e => set('zip', e.target.value)}
              placeholder="94105" style={{flex:1}}/>
          </div>
        </label>
      </div>

      <div className="modal-footer">
        <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <div style={{flex:1}}/>
        <button className="btn-ghost" disabled={!canSave}
          onClick={() => save({ keepOpen: true })}>
          {saving ? 'Saving…' : 'Save & add another'}
        </button>
        <button className="btn-primary" disabled={!canSave}
          onClick={() => save({ keepOpen: false })}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  </div>;
}

if (typeof window !== 'undefined') window.ManualRecipientForm = ManualRecipientForm;
