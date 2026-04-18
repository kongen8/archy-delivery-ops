// ===== UPLOAD WIZARD =====
// Three-step wizard for customer recipient upload.
//   Step 1 — pick a CSV/XLSX + name the campaign
//   Step 2 — confirm AI/heuristic column mapping (Task 11)
//   Step 3 — tabbed bucket review + per-row actions (Tasks 12 + 13)
//
// Resume detection: loading the wizard for an existing campaignId that
// already has recipients jumps straight to step 3, so re-clicking the
// campaign card from CustomerHome lands on the review tabs instead of
// re-uploading.
function UploadWizard({customerId, campaignId}){
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  const [campaign, setCampaign] = useState(null);
  const [ingestResult, setIngestResult] = useState(null);

  useEffect(() => {
    if (campaignId === 'new') return;
    (async () => {
      const { data: c } = await sb.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
      if (!c) return;
      setCampaign(c); setName(c.name || '');
      const { count } = await sb.from('recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
      if ((count || 0) > 0) setStep(3);
    })();
  }, [campaignId]);

  async function onPickFile(f) {
    setErr(''); setFile(f); setParsed(null);
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const result = parseFile(buf, /\.xlsx$/i.test(f.name) ? 'xlsx' : 'csv');
      setParsed(result);
    } catch (e) { setErr(e.message || String(e)); }
  }

  async function continueToStep2() {
    setWorking(true); setErr('');
    try {
      let camp = campaign;
      if (!camp) {
        camp = await Customer.createDraftCampaign(customerId, name.trim());
        setCampaign(camp);
        navigate('#/customer/' + customerId + '/upload/' + camp.id);
      }
      setStep(2);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  return <div className="wizard-shell">
    <aside className="wizard-rail">
      <div className="wizard-rail-header">Upload</div>
      <WizardStepRail n={1} label="File" active={step===1} done={step>1}/>
      <WizardStepRail n={2} label="Columns" active={step===2} done={step>2}/>
      <WizardStepRail n={3} label="Review" active={step===3} done={false}/>
    </aside>
    <main className="wizard-main">
      <header className="wizard-header">
        <h1>{campaign ? campaign.name : 'New campaign'}</h1>
        <a className="btn-ghost" href={'#/customer/' + customerId}>Cancel</a>
      </header>

      {err && <div className="wizard-err">{err}</div>}

      {step === 1 && <section className="wizard-step">
        <h2>Upload your recipient list</h2>
        <div className="wizard-field">
          <label>Campaign name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Q3 2026 deliveries"/>
        </div>
        <div className="wizard-dropzone">
          <input type="file" accept=".csv,.xlsx" onChange={e => onPickFile(e.target.files[0])}/>
          <div className="wizard-dropzone-hint">CSV or XLSX, up to 5,000 rows</div>
        </div>
        {parsed && <div className="wizard-preview">
          <div className="wizard-preview-meta">{parsed.rows.length} rows · {parsed.headers.length} columns</div>
          <table className="wizard-preview-table">
            <thead><tr>{parsed.headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{parsed.rows.slice(0,5).map((r,i) => <tr key={i}>{r.map((c,j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>}
        <div className="wizard-footer">
          <button className="btn-primary" disabled={!name.trim() || !parsed || working} onClick={continueToStep2}>
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
      />}
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

// Stubs replaced in Tasks 11 + 12.
function ColumnMappingStep() { return <div className="wizard-step">Step 2 placeholder (Task 11)</div>; }
function ReviewStep() { return <div className="wizard-step">Step 3 placeholder (Task 12)</div>; }
