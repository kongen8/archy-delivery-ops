// ===== ADDRESS AUTOCOMPLETE (Mapbox Search Box) =====
// Typeahead input. Calls onValueChange(text) on every keystroke and
// onPick(picked) on suggestion select (or onPick(null) on free-text edit).
// `picked` is { address, street, city, state, zip, lat, lon }.
//
// Extracted from DepotManager.jsx so ManualRecipientForm can also use it.
function AddressAutocomplete({value, onValueChange, onPick, placeholder, proximity, autoFocus}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const sessionRef = useRef(null);
  const abortRef = useRef(null);
  const inputRef = useRef(null);
  const blurTimerRef = useRef(null);

  useEffect(() => { if (autoFocus && inputRef.current) inputRef.current.focus(); }, [autoFocus]);

  useEffect(() => {
    if (!dirty) return;
    if (!value || value.trim().length < 3) { setSuggestions([]); setOpen(false); return; }
    if (!sessionRef.current) sessionRef.current = Math.random().toString(36).slice(2);
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t = setTimeout(async () => {
      setLoading(true);
      const out = await suggestAddress(value, { sessionToken: sessionRef.current, proximity, signal: ctrl.signal });
      if (!ctrl.signal.aborted) { setSuggestions(out); setOpen(out.length > 0); setHighlight(-1); setLoading(false); }
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [value, dirty]);

  const pick = async (s) => {
    setOpen(false);
    setSuggestions([]);
    const token = sessionRef.current;
    sessionRef.current = null;
    onValueChange(s.address);
    const retrieved = await retrieveAddress(s.id, { sessionToken: token });
    if (retrieved) {
      // street is intentionally NOT falling back to s.address (the full
      // formatted "330 Main St, San Francisco, CA 94105, USA" line). When
      // Mapbox doesn't return properties.context.address, leave street null
      // and let the consumer keep whatever was already in their input.
      onPick({
        address: retrieved.address || s.address,
        street:  retrieved.street,
        city:    retrieved.city,
        state:   retrieved.state,
        zip:     retrieved.zip,
        lat:     retrieved.lat,
        lon:     retrieved.lon,
      });
    }
  };

  const onKey = (e) => {
    if (!open || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      if (highlight >= 0) { e.preventDefault(); pick(suggestions[highlight]); }
    }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return <div style={{position:'relative'}}>
    <input ref={inputRef} value={value}
      onChange={e => { setDirty(true); onValueChange(e.target.value); onPick(null); }}
      onFocus={() => { if (dirty && suggestions.length) setOpen(true); }}
      onBlur={() => { blurTimerRef.current = setTimeout(() => setOpen(false), 150); }}
      onKeyDown={onKey}
      placeholder={placeholder}
      style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #e2e8f0',fontSize:13,boxSizing:'border-box'}}/>
    {open && suggestions.length > 0 && <div
      onMouseDown={() => { if (blurTimerRef.current) clearTimeout(blurTimerRef.current); }}
      style={{
        position:'absolute',top:'100%',left:0,right:0,zIndex:50,marginTop:2,
        background:'white',border:'1px solid #e2e8f0',borderRadius:6,
        boxShadow:'0 4px 12px rgba(0,0,0,0.08)',maxHeight:260,overflowY:'auto',
      }}>
      {suggestions.map((s,i) => <div key={s.id} onClick={() => pick(s)}
        style={{
          padding:'8px 10px',fontSize:12,cursor:'pointer',
          borderBottom: i < suggestions.length - 1 ? '1px solid #f1f5f9' : 'none',
          background: highlight === i ? '#f1f5f9' : 'white',
        }}
        onMouseEnter={() => setHighlight(i)}>
        <div style={{color:'#0f172a',fontWeight:500}}>{s.text}</div>
        {s.subtext && s.subtext !== s.text &&
          <div style={{color:'#94a3b8',fontSize:11,marginTop:1}}>{s.subtext}</div>}
      </div>)}
    </div>}
    {loading && !open && <div style={{position:'absolute',right:8,top:8,fontSize:11,color:'#94a3b8'}}>…</div>}
  </div>;
}

if (typeof window !== 'undefined') window.AddressAutocomplete = AddressAutocomplete;
