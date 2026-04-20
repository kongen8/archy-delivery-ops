// ===== UPLOAD WIZARD =====
// Four-step wizard for customer recipient upload.
//   Step 1 — pick a CSV/XLSX + name the campaign
//   Step 2 — confirm AI/heuristic column mapping
//   Step 3 — tabbed bucket review + per-row actions
//   Step 4 — designs (Plan 5: cake + box-card images)
//
// Resume detection: loading the wizard for an existing campaignId that
// already has recipients jumps straight to step 4 (Designs) — the
// customer can click ‹ Back to revisit Review if they want.
function UploadWizard({customerId, campaignId}){
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [campaignNote, setCampaignNote] = useState('');
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  const [campaign, setCampaign] = useState(null);
  const [ingestResult, setIngestResult] = useState(null);
  // 'file' = upload a CSV/XLSX; 'manual' = skip file + columns, go straight
  // to Review and add recipients one at a time. Toggled from Step 1.
  const [entryMode, setEntryMode] = useState('file');

  useEffect(() => {
    if (campaignId === 'new') return;
    (async () => {
      const { data: c } = await sb.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
      if (!c) return;
      setCampaign(c); setName(c.name || ''); setCampaignNote(c.notes || '');
      if (c.status === 'active') { navigate('#/customer/' + customerId); return; }
      const { count } = await sb.from('recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
      // Recipients already exist → skip File + Columns and land on Designs.
      // The customer can ‹ Back to Review if they want to retouch buckets.
      if ((count || 0) > 0) setStep(4);
    })();
  }, [campaignId, customerId]);

  async function onPickFile(f) {
    setErr(''); setFile(f); setParsed(null);
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const result = parseFile(buf, /\.xlsx$/i.test(f.name) ? 'xlsx' : 'csv');
      setParsed(result);
    } catch (e) { setErr(e.message || String(e)); }
  }

  async function continueFromStep1() {
    setWorking(true); setErr('');
    try {
      let camp = campaign;
      if (!camp) {
        camp = await Customer.createDraftCampaign(customerId, name.trim(), campaignNote);
        setCampaign(camp);
        navigate('#/customer/' + customerId + '/upload/' + camp.id);
      } else if ((camp.notes || '') !== (campaignNote || '')) {
        // Customer edited the note on a resumed draft.
        await Customer.setCampaignNote(camp.id, campaignNote);
        setCampaign({ ...camp, notes: campaignNote || null });
      }
      // Manual mode skips the columns step — there's no file to map.
      setStep(entryMode === 'manual' ? 3 : 2);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  return <div className="wizard-shell">
    <aside className="wizard-rail">
      <div className="wizard-rail-header">Upload</div>
      <WizardStepRail n={1} label="File" active={step===1} done={step>1}/>
      <WizardStepRail n={2} label="Columns" active={step===2} done={step>2}/>
      <WizardStepRail n={3} label="Review" active={step===3} done={step>3}/>
      <WizardStepRail n={4} label="Designs" active={step===4} done={false}/>
    </aside>
    <main className="wizard-main">
      <header className="wizard-header">
        <h1>{campaign ? campaign.name : 'New campaign'}</h1>
        <a className="btn-ghost" href={'#/customer/' + customerId}>Cancel</a>
      </header>

      {err && <div className="wizard-err">{err}</div>}

      {step === 1 && <section className="wizard-step">
        <h2>Add your recipients</h2>
        <div className="wizard-field">
          <label>Campaign name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Q3 2026 deliveries"/>
        </div>
        <div className="wizard-field">
          <label>Campaign note <span style={{color:'#9ca3af',fontWeight:400}}>(optional)</span></label>
          <textarea
            value={campaignNote}
            onChange={e => setCampaignNote(e.target.value)}
            placeholder="Anything the bakery should know about this whole campaign — e.g. allergens to avoid, preferred drop-off windows."
            rows={3}
            style={{width:'100%',padding:'8px 10px',border:'1px solid #d1d5db',borderRadius:6,fontFamily:'inherit',fontSize:13,resize:'vertical',boxSizing:'border-box'}}
          />
          <div style={{fontSize:11,color:'#9ca3af',marginTop:4}}>
            We'll do our best to honor special requests but can't guarantee them.
          </div>
        </div>

        <div className="wizard-entry-toggle">
          <button
            className={'wizard-entry-tab' + (entryMode === 'file' ? ' active' : '')}
            onClick={() => setEntryMode('file')}>
            Upload a file
          </button>
          <button
            className={'wizard-entry-tab' + (entryMode === 'manual' ? ' active' : '')}
            onClick={() => setEntryMode('manual')}>
            Add one at a time
          </button>
        </div>

        {entryMode === 'file' && <>
          <div className="wizard-dropzone">
            <input type="file" accept=".csv,.xlsx" onChange={e => onPickFile(e.target.files[0])}/>
            <div className="wizard-dropzone-hint">CSV or XLSX, up to 5,000 rows. Add a "notes" column for per-recipient instructions.</div>
          </div>
          {parsed && <div className="wizard-preview">
            <div className="wizard-preview-meta">{parsed.rows.length} rows · {parsed.headers.length} columns</div>
            <table className="wizard-preview-table">
              <thead><tr>{parsed.headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{parsed.rows.slice(0,5).map((r,i) => <tr key={i}>{r.map((c,j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>}
        </>}

        {entryMode === 'manual' && <div className="wizard-empty-cta">
          <div style={{fontSize:14,color:'#374151',marginBottom:4}}>You'll enter recipients one at a time.</div>
          <div style={{fontSize:12,color:'#6b7280'}}>Click <b>Continue</b> to name the campaign and start adding rows.</div>
        </div>}

        <div className="wizard-footer">
          <button className="btn-primary"
            disabled={!name.trim() || (entryMode === 'file' && !parsed) || working}
            onClick={continueFromStep1}>
            {working ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </section>}

      {step === 2 && <ColumnMappingStep
        parsed={parsed}
        campaign={campaign}
        file={file}
        onBack={() => setStep(1)}
        onContinue={(r) => { setIngestResult(r); setStep(3); }}
      />}

      {step === 3 && <ReviewStep
        campaign={campaign}
        customerId={customerId}
        ingestResult={ingestResult}
        onBack={() => setStep(2)}
        onContinue={() => setStep(4)}
      />}

      {step === 4 && campaign && <DesignsStep
        campaign={campaign}
        customerId={customerId}
        onBack={() => setStep(3)}
        onFinalize={async () => {
          await Customer.finalizeCampaign(campaign.id);
          navigate('#/customer/' + customerId);
        }}/>}
    </main>
  </div>;
}

function WizardStepRail({n, label, active, done}) {
  const cls = 'wizard-step-rail ' + (active ? 'active' : done ? 'done' : '');
  return <div className={cls}>
    <span className="wizard-step-num">{done ? '✓' : n}</span>
    <span className="wizard-step-label">{label}</span>
  </div>;
}

// ===== Step 2: column mapping =====
// Initial guess uses the deterministic browser heuristic; the AI runs
// server-side inside ingest-recipients (it sees the same headers + sample
// rows). We present the heuristic guess up front so the table never starts
// empty even if the customer's network is slow / AI is down.
function ColumnMappingStep({parsed, onBack, onContinue, campaign, file}) {
  const TARGETS = ['', 'company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip', 'notes'];
  const initial = useMemo(() => suggestMapping(parsed.headers), [parsed.headers]);
  const [mapping, setMapping] = useState(initial.mapping);
  const confidence = initial.confidence;
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');

  function setHeaderTarget(header, target) {
    setMapping(m => ({...m, [header]: target || null}));
  }

  async function continueToReview() {
    setWorking(true); setErr('');
    try {
      const result = await Customer.ingestFile({
        campaign_id: campaign.id,
        file,
        columnMapping: mapping,
      });
      onContinue(result);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  // Surface duplicates so customers don't unintentionally map two columns to
  // the same target (only one would actually be used by the edge function).
  const targetCounts = Object.values(mapping).filter(Boolean).reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  const hasDupe = Object.values(targetCounts).some(n => n > 1);
  const hasCompany = Object.values(mapping).includes('company');
  const hasAddress = Object.values(mapping).includes('address');
  const canContinue = hasCompany && hasAddress && !hasDupe;

  return <section className="wizard-step">
    <h2>Confirm column mapping</h2>
    <p className="wizard-step-sub">Pick a target field for each column from your file. Required: <code>company</code> + <code>address</code>.</p>
    {err && <div className="wizard-err" style={{margin:0}}>{err}</div>}
    {hasDupe && <div className="wizard-warn">Two columns map to the same target. Set duplicates to "—" before continuing.</div>}
    <table className="wizard-mapping-table">
      <thead><tr><th>Source column</th><th>Sample value</th><th>Heuristic</th><th>Maps to</th></tr></thead>
      <tbody>
        {parsed.headers.map((h, hi) => {
          const sample = (parsed.rows[0] || [])[hi] || '';
          return <tr key={h}>
            <td><b>{h}</b></td>
            <td className="wizard-sample">{sample}</td>
            <td><span className={'wizard-conf ' + (confidence[h] || 'low')}>{confidence[h] || 'low'}</span></td>
            <td>
              <select value={mapping[h] || ''} onChange={e => setHeaderTarget(h, e.target.value)}>
                {TARGETS.map(t => <option key={t} value={t}>{t || '—'}</option>)}
              </select>
            </td>
          </tr>;
        })}
      </tbody>
    </table>
    <div className="wizard-footer">
      <button className="btn-ghost" onClick={onBack} disabled={working}>‹ Back</button>
      <button className="btn-primary" disabled={!canContinue || working} onClick={continueToReview}>
        {working ? 'Ingesting…' : 'Continue'}
      </button>
    </div>
  </section>;
}

// ===== Step 3: tabbed bucket review =====
// Re-queries recipients on every action so counts stay live. Per-row
// actions (accept/edit/skip/retry-geocode) live in RecipientRow below.
function ReviewStep({campaign, customerId, onBack, onContinue, ingestResult}) {
  const [tab, setTab] = useState('needs_review');
  const [recipients, setRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setRecipients(await Customer.listRecipients(campaign.id)); }
    catch (e) { setErr(e.message); }
    setLoading(false);
  }, [campaign.id]);

  useEffect(() => { reload(); }, [reload]);

  // Default tab to "needs_review" but jump to the first non-empty bucket if
  // that one's empty, so customers aren't greeted by an empty state.
  useEffect(() => {
    if (recipients.length === 0) return;
    const inCurrent = recipients.filter(r => r.assignment_status === tab).length;
    if (inCurrent > 0) return;
    const order = ['needs_review', 'flagged_out_of_area', 'geocode_failed', 'assigned'];
    const next = order.find(b => recipients.some(r => r.assignment_status === b));
    if (next) setTab(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipients.length]);

  const counts = {
    assigned: recipients.filter(r => r.assignment_status === 'assigned').length,
    needs_review: recipients.filter(r => r.assignment_status === 'needs_review').length,
    flagged_out_of_area: recipients.filter(r => r.assignment_status === 'flagged_out_of_area').length,
    geocode_failed: recipients.filter(r => r.assignment_status === 'geocode_failed').length,
  };
  const inTab = recipients.filter(r => r.assignment_status === tab);
  const stillProblematic = counts.needs_review + counts.flagged_out_of_area + counts.geocode_failed;
  const empty = !loading && recipients.length === 0;

  return <section className="wizard-step">
    <h2>Review &amp; finalize · v2</h2>
    <p className="wizard-step-sub">{recipients.length} rows ingested. Tabs show each bucket; counts are live.</p>
    {err && <div className="wizard-err" style={{margin:0}}>{err}</div>}

    <div className="wizard-add-bar">
      <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add recipient</button>
    </div>

    {!empty && <div className="wizard-tabs">
      <Tab label="Assigned" n={counts.assigned} active={tab==='assigned'} onClick={() => setTab('assigned')} color="#15803d"/>
      <Tab label="Needs review" n={counts.needs_review} active={tab==='needs_review'} onClick={() => setTab('needs_review')} color="#7c3aed"/>
      <Tab label="Out of area" n={counts.flagged_out_of_area} active={tab==='flagged_out_of_area'} onClick={() => setTab('flagged_out_of_area')} color="#b45309"/>
      <Tab label="Geocode failed" n={counts.geocode_failed} active={tab==='geocode_failed'} onClick={() => setTab('geocode_failed')} color="#dc2626"/>
    </div>}

    {loading
      ? <div style={{padding:24,color:'#9ca3af'}}>Loading…</div>
      : empty
        ? <div className="wizard-empty">
            <div style={{fontSize:14,color:'#374151'}}><b>No recipients yet.</b></div>
            <div style={{fontSize:12,color:'#6b7280',marginTop:4}}>Click <b>+ Add recipient</b> above to get started.</div>
          </div>
        : inTab.length === 0
          ? <div className="wizard-empty">Nothing in this bucket. 🎉</div>
          : <div className="wizard-row-list">{inTab.map(r => <RecipientRow key={r.id} row={r} bucket={tab} onChanged={reload}/>)}</div>}

    <div className="wizard-footer">
      <button className="btn-ghost" onClick={onBack}>‹ Back</button>
      <div style={{flex:1, fontSize:12, color:'#6b7280', textAlign:'right', marginRight:8}}>
        {empty
          ? 'Add at least 1 recipient to continue'
          : `${counts.assigned} will be delivered. ${stillProblematic} still need attention.`}
      </div>
      <button className="btn-primary" onClick={onContinue} disabled={empty}>Continue to designs ›</button>
    </div>

    {showAdd && <ManualRecipientForm
      campaignId={campaign.id}
      onSaved={() => { reload(); }}
      onClose={() => setShowAdd(false)}/>}
  </section>;
}

function Tab({label, n, active, onClick, color}) {
  const cls = 'wizard-tab' + (active ? ' active' : '');
  const style = active ? {borderBottomColor: color, color} : {};
  return <button className={cls} style={style} onClick={onClick}>{label} <span className="wizard-tab-count">{n}</span></button>;
}

// Per-row action surface. Different bucket → different default action set:
//   needs_review        → Accept / Edit / Skip
//   flagged_out_of_area → Edit address (re-runs geocode + area-match) / Tell admin
//   geocode_failed      → Edit & retry (re-runs geocode + area-match)
//   assigned            → Edit only (re-bucket happens automatically on save)
function RecipientRow({row, bucket, onChanged}) {
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState({
    company: row.company || '',
    contact_name: row.contact_name || '',
    phone: row.phone || '',
    email: row.email || '',
    address: row.address || '',
    city: row.city || '',
    state: row.state || '',
    zip: row.zip || '',
    notes: row.notes || '',
  });
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(row.notes || '');
  const [savingNote, setSavingNote] = useState(false);

  async function saveNote() {
    setSavingNote(true);
    try {
      await Customer.setRecipientNote(row.id, noteDraft);
      setEditingNote(false);
      onChanged();
    } catch (e) { setErr(e.message || String(e)); }
    setSavingNote(false);
  }

  async function accept(fields) {
    setWorking(true); setErr('');
    try {
      const f = fields || draft;
      // For out-of-area / geocode_failed rows, the address probably changed
      // and we need to re-run Mapbox + the polygon check before the row can
      // legitimately become 'assigned'. Plain UPDATE wouldn't move it.
      if (bucket === 'flagged_out_of_area' || bucket === 'geocode_failed') {
        await Customer.retryGeocode(row.id, {
          address: f.address, city: f.city, state: f.state, zip: f.zip,
        });
        // retryGeocode doesn't touch notes — persist any note edit separately
        // so the customer's edit during the same Save click isn't dropped.
        if ((f.notes || '') !== (row.notes || '')) {
          await Customer.setRecipientNote(row.id, f.notes);
        }
      } else {
        await Customer.acceptRecipient(row.id, f);
      }
      setEditing(false);
      onChanged();
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  async function skip() {
    setWorking(true); setErr('');
    try { await Customer.skipRecipient(row.id); onChanged(); }
    catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  function copyMail() {
    const subject = encodeURIComponent('Out-of-area recipient: ' + row.company);
    const body = encodeURIComponent(
      `Recipient address falls outside every bakery polygon:\n\n${row.company}\n${row.address || ''}, ${row.city || ''} ${row.state || ''} ${row.zip || ''}\n\nCan a bakery cover this?`
    );
    window.location.href = 'mailto:contact@daymaker.com?subject=' + subject + '&body=' + body;
  }

  return <div className="wizard-row">
    <div className="wizard-row-main" style={{flex:1, minWidth:0}}>
      {editing ? (
        <div className="wizard-row-edit">
          <input value={draft.company} onChange={e => setDraft(d => ({...d, company: e.target.value}))} placeholder="Company"/>
          <AddressTypeahead
            value={draft.address}
            onChange={v => setDraft(d => ({...d, address: v}))}
            onSelect={parts => setDraft(d => ({
              ...d,
              address: parts.address || d.address,
              city: parts.city || d.city,
              state: parts.state || d.state,
              zip: parts.zip || d.zip,
            }))}
            placeholder="Address"
          />
          <input value={draft.city} onChange={e => setDraft(d => ({...d, city: e.target.value}))} placeholder="City"/>
          <input value={draft.state} onChange={e => setDraft(d => ({...d, state: e.target.value}))} placeholder="ST" style={{width:60}}/>
          <input value={draft.zip} onChange={e => setDraft(d => ({...d, zip: e.target.value}))} placeholder="ZIP" style={{width:80}}/>
          <textarea
            value={draft.notes}
            onChange={e => setDraft(d => ({...d, notes: e.target.value}))}
            placeholder="Note for this recipient (optional) — e.g. 'deliver before 3pm', 'leave at front desk'"
            rows={2}
            style={{flexBasis:'100%',padding:'6px 8px',border:'1px solid #d1d5db',borderRadius:6,fontFamily:'inherit',fontSize:12,resize:'vertical'}}
          />
        </div>
      ) : (
        <>
          <div className="wizard-row-name">{row.company || <em style={{color:'#9ca3af'}}>(no company)</em>}</div>
          <div className="wizard-row-addr">{[row.address, row.city, row.state, row.zip].filter(Boolean).join(', ') || <em style={{color:'#9ca3af'}}>(no address)</em>}</div>
          {row.notes && !editingNote && <div className="wizard-row-note" style={{marginTop:4,fontSize:12,color:'#7c3aed',background:'#faf5ff',padding:'4px 8px',borderRadius:4,borderLeft:'2px solid #7c3aed'}}>
            <span style={{fontWeight:600}}>Note: </span>{row.notes}
            <button onClick={() => { setNoteDraft(row.notes || ''); setEditingNote(true); }} style={{background:'none',border:'none',color:'#7c3aed',fontSize:11,marginLeft:6,cursor:'pointer',textDecoration:'underline',padding:0}}>edit</button>
          </div>}
          {!row.notes && !editingNote && <button onClick={() => { setNoteDraft(''); setEditingNote(true); }} style={{background:'none',border:'none',color:'#9ca3af',fontSize:11,cursor:'pointer',textDecoration:'underline',padding:0,marginTop:4}}>+ add note</button>}
          {editingNote && <div style={{marginTop:6}}>
            <textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} rows={2} placeholder="Note for this recipient" style={{width:'100%',padding:'6px 8px',border:'1px solid #d1d5db',borderRadius:6,fontFamily:'inherit',fontSize:12,resize:'vertical',boxSizing:'border-box'}}/>
            <div style={{marginTop:4,display:'flex',gap:6}}>
              <button className="btn-primary" disabled={savingNote} onClick={saveNote} style={{padding:'4px 10px',fontSize:12}}>{savingNote ? 'Saving…' : 'Save note'}</button>
              <button className="btn-ghost" disabled={savingNote} onClick={() => setEditingNote(false)} style={{padding:'4px 10px',fontSize:12}}>Cancel</button>
            </div>
          </div>}
          {err && <div style={{fontSize:11,color:'#991b1b',marginTop:4}}>{err}</div>}
        </>
      )}
    </div>
    <div className="wizard-row-actions">
      {!editing && bucket === 'needs_review' && <>
        <button className="btn-primary" disabled={working} onClick={() => accept()}>Accept</button>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(true)}>Edit</button>
        <button className="btn-ghost" disabled={working} onClick={skip}>Skip</button>
      </>}
      {!editing && bucket === 'flagged_out_of_area' && <>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(true)}>Edit address</button>
        <button className="btn-ghost" disabled={working} onClick={copyMail}>Tell admin</button>
      </>}
      {!editing && bucket === 'geocode_failed' && <>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(true)}>Edit &amp; retry</button>
      </>}
      {!editing && bucket === 'assigned' && <>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(true)}>Edit</button>
      </>}
      {editing && <>
        <button className="btn-primary" disabled={working} onClick={() => accept(draft)}>{working ? 'Saving…' : 'Save'}</button>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(false)}>Cancel</button>
      </>}
    </div>
  </div>;
}
