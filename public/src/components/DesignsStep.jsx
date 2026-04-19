// ===== DESIGNS STEP (Plan 5 · Wizard Step 4) =====
// Step 4 of the upload wizard. Two responsibilities:
//   1. Campaign default — two upload slots (cake round, card 4×6) that every
//      recipient inherits unless overridden. Persists to
//      campaigns.default_design jsonb.
//   2. Per-recipient overrides — opens an `OverrideEditor` modal where the
//      user can pick a recipient and replace cake/card images. Per-recipient
//      images are stored on `recipients.customizations` jsonb; the same two
//      keys (`cake_image_url`, `card_image_url`) override the campaign default
//      via `mergeDesign()` at print time. Removing an override clears the
//      keys + best-effort deletes the blob from the bucket so the campaign
//      default is used again.
function DesignsStep({campaign, customerId, onBack, onFinalize}) {
  const [design, setDesign] = useState(campaign.default_design || {});
  const [cropping, setCropping] = useState(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');

  const [recipients, setRecipients] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'add' | <recipient row>

  const reload = useCallback(async () => {
    try { setRecipients(await Customer.listRecipients(campaign.id)); }
    catch (e) { setErr(e.message || String(e)); }
  }, [campaign.id]);

  useEffect(() => { reload(); }, [reload]);

  const overrideRecipients = useMemo(
    () => recipients.filter(r =>
      (r.customizations?.cake_image_url) || (r.customizations?.card_image_url)),
    [recipients]
  );

  function pickFile(kind, file) {
    setErr('');
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      setErr('Only PNG/JPG/WebP accepted.'); return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setErr('Image too large — please resize to under 20 MB.'); return;
    }
    setCropping({ kind, file });
  }

  async function onCropSave(blob) {
    const { kind } = cropping;
    setWorking(true); setErr('');
    try {
      const url = await Customer.uploadDesignAsset(campaign.id, kind, 'default', blob);
      const next = { ...design, [kind + '_image_url']: url };
      await Customer.setCampaignDefaultDesign(campaign.id, next);
      setDesign(next);
      setCropping(null);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  const hasCake = !!design.cake_image_url;
  const hasCard = !!design.card_image_url;
  const canFinalize = hasCake && hasCard;

  async function finalize() {
    setWorking(true); setErr('');
    try { await onFinalize(); } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  async function removeOverride(r) {
    try {
      await Customer.removeRecipientOverride(r.id);
      // Best-effort blob cleanup. RLS on cake-prints allows public delete in
      // dev; if it ever fails (e.g. CORS), we silently swallow because the
      // metadata clear is the source of truth.
      const c = r.customizations || {};
      if (c.cake_image_url) sb.storage.from('cake-prints')
        .remove([`${campaign.id}/cake_${r.id}.png`]).catch(() => {});
      if (c.card_image_url) sb.storage.from('cake-prints')
        .remove([`${campaign.id}/card_${r.id}.png`]).catch(() => {});
      reload();
    } catch (e) { setErr(e.message || String(e)); }
  }

  return <section className="designs-step">
    <div>
      <h2>Designs</h2>
      <p className="subtle">Upload one cake-top image and one box-card image. Drag a crop rectangle to fit. Add per-recipient overrides for anyone who needs a unique print.</p>
    </div>

    {err && <div className="wizard-err" style={{margin:0}}>{err}</div>}

    <div>
      <h3 className="designs-section-title"><span>Campaign default</span></h3>
      <div className="designs-slots">
        <Slot kind="cake" title="Cake print" spec='7.5" round · 2250×2250' mask="round"
              url={design.cake_image_url} onPick={f => pickFile('cake', f)} working={working}/>
        <Slot kind="card" title="Box card"   spec='4×6 portrait · 1200×1800' mask="rect"
              url={design.card_image_url} onPick={f => pickFile('card', f)} working={working}/>
      </div>
    </div>

    <div>
      <h3 className="designs-section-title">
        <span>Per-recipient overrides · {overrideRecipients.length} of {recipients.length}</span>
        <button className="btn-primary" style={{fontSize:12,padding:'6px 12px'}}
                onClick={() => setEditing('add')} disabled={recipients.length === 0}>
          + Add override
        </button>
      </h3>
      {overrideRecipients.length === 0
        ? <div className="overrides-empty standalone">All recipients use the campaign default.</div>
        : <div className="overrides-block">
            {overrideRecipients.map(r => <OverrideRow key={r.id} row={r}
              onEdit={() => setEditing(r)}
              onRemove={() => removeOverride(r)}/>)}
          </div>}
    </div>

    <div className="wizard-footer">
      <button className="btn-ghost" onClick={onBack} disabled={working}>‹ Back to review</button>
      <div style={{flex:1, fontSize:12, color:'#6b7280', textAlign:'right', marginRight:8}}>
        {!hasCake && 'Cake image required · '}
        {!hasCard && 'Box card image required · '}
        {canFinalize && (
          overrideRecipients.length === 0
            ? 'All ' + recipients.length + ' recipients use the default'
            : (recipients.length - overrideRecipients.length) + ' use default · ' + overrideRecipients.length + ' use overrides'
        )}
      </div>
      <button className="btn-primary" onClick={finalize} disabled={!canFinalize || working}>
        {working ? 'Finalizing…' : 'Finalize campaign'}
      </button>
    </div>

    {cropping && <ImageCropper
      sourceFile={cropping.file}
      aspectRatio={cropping.kind === 'cake' ? 1 : 4/6}
      outputW={cropping.kind === 'cake' ? 2250 : 1200}
      outputH={cropping.kind === 'cake' ? 2250 : 1800}
      mask={cropping.kind === 'cake' ? 'round' : 'rect'}
      title={'Crop · ' + (cropping.kind === 'cake' ? 'Cake print (1:1 round)' : 'Box card (4:6)')}
      onSave={onCropSave}
      onCancel={() => setCropping(null)}/>}

    {editing && <OverrideEditor
      campaign={campaign}
      initialRecipient={editing === 'add' ? null : editing}
      recipients={recipients}
      onClose={() => setEditing(null)}
      onSaved={() => { setEditing(null); reload(); }}/>}
  </section>;
}

function OverrideRow({row, onEdit, onRemove}) {
  const c = row.customizations || {};
  return <div className="override-row">
    <div className="override-thumbs">
      <div className="t cake">{c.cake_image_url ? <img src={c.cake_image_url} alt=""/> : '–'}</div>
      <div className="t card">{c.card_image_url ? <img src={c.card_image_url} alt=""/> : '–'}</div>
    </div>
    <div className="override-main">
      <div className="who">{row.company || <em style={{color:'#9ca3af'}}>(no company)</em>}</div>
      <div className="what">
        {[c.cake_image_url && 'Cake', c.card_image_url && 'Card'].filter(Boolean).join(' + ')} overridden ·{' '}
        {[row.address, row.city].filter(Boolean).join(', ')}
      </div>
    </div>
    <div className="override-actions">
      <button onClick={onEdit}>Edit</button>
      <button onClick={onRemove}>Remove</button>
    </div>
  </div>;
}

// Two-mode modal:
//   1. If `initialRecipient` is null, show a search picker. After the user
//      picks, transition to mode 2.
//   2. Show the same two cake/card slots as the campaign default editor,
//      scoped to the picked recipient. Each save uploads to the bucket and
//      updates `recipients.customizations`. The parent reloads on close.
function OverrideEditor({campaign, initialRecipient, recipients, onClose, onSaved}) {
  const [picked, setPicked] = useState(initialRecipient);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState(null); // {cake_image_url, card_image_url}
  const [cropping, setCropping] = useState(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (picked) setDraft({
      cake_image_url: picked.customizations?.cake_image_url || null,
      card_image_url: picked.customizations?.card_image_url || null,
    });
  }, [picked && picked.id]);

  function pickFile(kind, file) {
    setErr('');
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      setErr('Only PNG/JPG/WebP accepted.'); return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setErr('Image too large — under 20 MB.'); return;
    }
    setCropping({ kind, file });
  }

  async function onCropSave(blob) {
    const { kind } = cropping;
    setWorking(true); setErr('');
    try {
      const url = await Customer.uploadDesignAsset(campaign.id, kind, picked.id, blob);
      const nextDraft = { ...draft, [kind + '_image_url']: url };
      setDraft(nextDraft);
      await Customer.setRecipientOverride(picked.id, nextDraft);
      setCropping(null);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter(r =>
      (r.company || '').toLowerCase().includes(q)
      || (r.address || '').toLowerCase().includes(q));
  }, [recipients, search]);

  return <div className="cropper-backdrop" onClick={onClose}>
    <div className="cropper-modal" style={{maxWidth:680}} onClick={e => e.stopPropagation()}>
      <div className="cropper-header">
        <h3>{picked
          ? 'Override · ' + (picked.company || '(no company)')
          : 'Pick a recipient'}</h3>
        <button className="x" onClick={onClose}>×</button>
      </div>
      <div style={{padding:18, overflow:'auto'}}>
        {err && <div className="wizard-err" style={{margin:'0 0 12px'}}>{err}</div>}
        {!picked
          ? <>
              <input placeholder="Search by company or address…"
                     value={search} onChange={e => setSearch(e.target.value)}
                     style={{margin:0,width:'100%',padding:'7px 12px',border:'1px solid #e5e7eb',borderRadius:6,fontSize:13,fontFamily:'inherit'}}/>
              <div className="recipient-picker">
                {filtered.slice(0, 200).map(r => <div key={r.id} className="row" onClick={() => setPicked(r)}>
                  <b>{r.company || '(no company)'}</b>
                  <span>{[r.address, r.city, r.state, r.zip].filter(Boolean).join(', ') || '(no address)'}</span>
                </div>)}
                {filtered.length === 0 && <div className="overrides-empty">No matches.</div>}
              </div>
              {filtered.length > 200 && <p className="subtle" style={{marginTop:8}}>Showing first 200 of {filtered.length} matches — refine the search.</p>}
            </>
          : <div className="designs-slots">
              <Slot kind="cake" title="Cake print" spec='7.5" round' mask="round"
                    url={draft && draft.cake_image_url} onPick={f => pickFile('cake', f)} working={working}/>
              <Slot kind="card" title="Box card"   spec='4×6 portrait' mask="rect"
                    url={draft && draft.card_image_url} onPick={f => pickFile('card', f)} working={working}/>
            </div>}
      </div>
      <div className="cropper-footer">
        <span className="cropper-meta">
          {picked ? 'Override saves automatically as you crop.' : 'Pick a recipient to start an override.'}
        </span>
        <div style={{display:'flex',gap:8}}>
          <button className="btn-ghost" onClick={onClose}>Close</button>
          {picked && <button className="btn-primary" onClick={onSaved}>Done</button>}
        </div>
      </div>
    </div>
    {cropping && picked && <ImageCropper
      sourceFile={cropping.file}
      aspectRatio={cropping.kind === 'cake' ? 1 : 4/6}
      outputW={cropping.kind === 'cake' ? 2250 : 1200}
      outputH={cropping.kind === 'cake' ? 2250 : 1800}
      mask={cropping.kind === 'cake' ? 'round' : 'rect'}
      title={'Crop · ' + (cropping.kind === 'cake' ? 'Cake print' : 'Box card')}
      onSave={onCropSave}
      onCancel={() => setCropping(null)}/>}
  </div>;
}

function Slot({kind, title, spec, mask, url, onPick, working}) {
  const inputRef = useRef();
  return <div className="designs-slot">
    <div className="designs-slot-header">
      <span className="designs-slot-title">{title}</span>
      <span className="designs-slot-spec">{spec}</span>
    </div>
    <div className="designs-canvas" onClick={() => inputRef.current?.click()}>
      {url
        ? <img className={mask === 'round' ? 'round' : ''} src={url} alt=""/>
        : <div className="empty"><div className="icon">⊕</div>Drop a PNG/JPG here<br/>or click to upload</div>}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp"
             onChange={e => onPick(e.target.files?.[0])}/>
    </div>
    <div className="designs-slot-actions">
      <div className="left">
        <button className="btn-ghost" disabled={working} onClick={() => inputRef.current?.click()}>
          {url ? 'Replace' : 'Upload & crop'}
        </button>
      </div>
      <span className="right">{url ? 'Cropped · stored in cake-prints' : 'Required'}</span>
    </div>
  </div>;
}
