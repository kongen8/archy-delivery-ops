// ===== PRODUCTION TAB (Plan 5 Task 8) =====
// Bakery-side grid of recipients with their resolved cake + card designs.
// Reads recipients for the current bakery (across all active campaigns) +
// the campaigns' default_design rows; merges per-recipient via mergeDesign().
//
// Filters: All / Missing card / Missing cake / Overridden. No per-row edits
// (bakery is read-only on designs in v1; the customer owns design data).
//
// Bulk actions:
//   - Print box cards → dispatches a 'plan5:print-box-cards' window event
//     consumed by BoxCardSheet.jsx (Task 9). The actual print() call lives
//     there so the print sheet can paint first.
//   - Download edible prints → calls window.zipEdiblePrints (Task 10). Until
//     Task 10 lands, clicking the button surfaces a clear "not yet wired"
//     error in the UI rather than a ReferenceError in the console.
function ProductionTab({bakeryId}) {
  const [rows, setRows] = useState([]);     // [{recipient, design, campaign, cakeOverride, cardOverride}]
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr('');
      try {
        const { data: recs, error: rErr } = await sb.from('recipients')
          .select('id, company, address, city, state, zip, customizations, campaign_id, assignment_status')
          .eq('bakery_id', bakeryId)
          .eq('assignment_status', 'assigned');
        if (rErr) throw rErr;
        const campIds = [...new Set((recs || []).map(r => r.campaign_id).filter(Boolean))];
        let camps = [];
        if (campIds.length > 0) {
          const { data, error: cErr } = await sb.from('campaigns')
            .select('id, name, default_design').in('id', campIds);
          if (cErr) throw cErr;
          camps = data || [];
        }
        const campMap = Object.fromEntries(camps.map(c => [c.id, c]));
        const merged = (recs || []).map(r => {
          const camp = campMap[r.campaign_id];
          const design = mergeDesign(camp && camp.default_design, r.customizations);
          const cakeOverride = !!(r.customizations && r.customizations.cake_image_url);
          const cardOverride = !!(r.customizations && r.customizations.card_image_url);
          return { recipient: r, design, campaign: camp, cakeOverride, cardOverride };
        });
        if (!cancelled) setRows(merged);
      } catch (e) {
        if (!cancelled) setErr(e.message || String(e));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [bakeryId]);

  const counts = useMemo(() => ({
    all: rows.length,
    missing_cake: rows.filter(x => !x.design.cake_image_url).length,
    missing_card: rows.filter(x => !x.design.card_image_url).length,
    overridden: rows.filter(x => x.cakeOverride || x.cardOverride).length,
  }), [rows]);

  const visible = useMemo(() => rows.filter(x => {
    if (filter === 'all') return true;
    if (filter === 'missing_cake') return !x.design.cake_image_url;
    if (filter === 'missing_card') return !x.design.card_image_url;
    if (filter === 'overridden') return x.cakeOverride || x.cardOverride;
    return true;
  }), [rows, filter]);

  function printBoxCards() {
    const visibleWithCard = visible.filter(x => x.design.card_image_url);
    if (visibleWithCard.length === 0) {
      setErr('No box cards to print in this filter.'); return;
    }
    window.__BOX_CARD_PRINT_ROWS__ = visibleWithCard.map(x => x.design.card_image_url);
    window.dispatchEvent(new Event('plan5:print-box-cards'));
  }

  async function downloadEdibleZip() {
    const withCake = visible.filter(x => x.design.cake_image_url);
    if (withCake.length === 0) {
      setErr('No edible prints to download in this filter.'); return;
    }
    if (typeof window.zipEdiblePrints !== 'function') {
      setErr('Edible-print zip download is not wired yet (Plan 5 Task 10).');
      return;
    }
    try { await window.zipEdiblePrints(withCake); }
    catch (e) { setErr(e.message || String(e)); }
  }

  if (loading) return <div style={{padding:24,color:'#9ca3af'}}>Loading production view…</div>;

  // Three distinct empty states so the bakery knows what to do next.
  if (rows.length === 0) {
    return <div className="production-empty">
      <div className="emoji">📦</div>
      <h3>No assigned recipients yet</h3>
      <p>Once a customer finalizes a campaign with deliveries in your area,
         their recipients will show up here so you can pull cake prints and
         box cards.</p>
    </div>;
  }
  const anyDesign = rows.some(x => x.design.cake_image_url || x.design.card_image_url);
  if (!anyDesign) {
    return <div className="production-empty">
      <div className="emoji">🎨</div>
      <h3>Recipients are here, but no designs yet</h3>
      <p>Your customers haven't uploaded cake or card artwork for any of
         their {rows.length} assigned {rows.length === 1 ? 'recipient' : 'recipients'} yet.
         As soon as they do, those designs appear in this grid for printing
         and the edible-print download.</p>
    </div>;
  }

  return <div>
    {err && <div className="wizard-err" style={{margin:'0 0 12px'}}>{err}</div>}

    <div className="production-toolbar">
      <div className="filters">
        <button className={'filter' + (filter==='all'?' active':'')} onClick={() => setFilter('all')}>All · {counts.all}</button>
        <button className={'filter' + (filter==='missing_card'?' active':'')} onClick={() => setFilter('missing_card')}>Missing card · {counts.missing_card}</button>
        <button className={'filter' + (filter==='missing_cake'?' active':'')} onClick={() => setFilter('missing_cake')}>Missing cake · {counts.missing_cake}</button>
        <button className={'filter' + (filter==='overridden'?' active':'')} onClick={() => setFilter('overridden')}>Overridden · {counts.overridden}</button>
      </div>
      <div className="actions">
        <button className="btn-ghost" onClick={downloadEdibleZip}>↓ Download edible prints (.zip)</button>
        <button className="btn-primary" onClick={printBoxCards}>🖨 Print box cards</button>
      </div>
    </div>

    {visible.length === 0
      ? <div style={{padding:32,textAlign:'center',color:'#9ca3af'}}>Nothing matches this filter.</div>
      : <div className="production-grid">
          {visible.map(x => <CakeCardProd key={x.recipient.id} row={x} onLightbox={setLightbox}/>)}
        </div>}

    {lightbox && <div className="cake-lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt=""/></div>}
  </div>;
}

function CakeCardProd({row, onLightbox}) {
  const {recipient: r, design, cakeOverride, cardOverride} = row;
  const sourceLabel = cakeOverride && cardOverride ? 'Override' :
                      cakeOverride ? 'Cake override' :
                      cardOverride ? 'Card override' : 'Default';
  const sourceCls = cakeOverride && cardOverride ? 'override' :
                    (cakeOverride || cardOverride) ? 'partial' : '';
  return <div className="cake-card-prod">
    <div className="images">
      <div className="img-cell"
           onClick={() => design.cake_image_url && onLightbox(design.cake_image_url)}
           style={{cursor: design.cake_image_url ? 'zoom-in' : 'default'}}>
        <span className="label">Cake</span>
        {cakeOverride && <span className="badge warn">Override</span>}
        {design.cake_image_url
          ? <img className="round" src={design.cake_image_url} alt=""/>
          : <><span className="badge">Missing</span><span className="placeholder">🎂</span></>}
      </div>
      <div className="img-cell card"
           onClick={() => design.card_image_url && onLightbox(design.card_image_url)}
           style={{cursor: design.card_image_url ? 'zoom-in' : 'default'}}>
        <span className="label">Card</span>
        {cardOverride && <span className="badge warn">Override</span>}
        {design.card_image_url
          ? <img className="rect" src={design.card_image_url} alt=""/>
          : <><span className="badge">Missing</span><span className="placeholder">🖼</span></>}
      </div>
    </div>
    <div className="body">
      <div className="left">
        <div className="co">{r.company || '(no company)'}</div>
        <div className="addr">{[r.address, r.city].filter(Boolean).join(' · ') || '(no address)'}</div>
      </div>
      <span className={'source ' + sourceCls}>{sourceLabel}</span>
    </div>
  </div>;
}
