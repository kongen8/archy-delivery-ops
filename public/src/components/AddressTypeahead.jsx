// ===== ADDRESS TYPEAHEAD =====
// A drop-in replacement for the address <input> in any address-edit form.
// Hits Mapbox /suggest as the user types (debounced 250ms) and shows a
// dropdown; selecting an entry calls /retrieve and fires onSelect with
// the full structured address: { address, city, state, zip, lat, lon }.
//
// Falls back to a plain controlled input if MAPBOX_API_KEY is not set,
// so the form always works.
//
// Caller pattern:
//   <AddressTypeahead value={draft.address}
//                     onChange={v => setDraft(d => ({...d, address: v}))}
//                     onSelect={parts => setDraft(d => ({...d, ...parts}))}
//                     proximity={{lat: 37.77, lon: -122.42}}/>
function AddressTypeahead({value, onChange, onSelect, proximity, placeholder = 'Address', style}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  // One Mapbox session token per instance keeps billing in "search session"
  // tier (1 cent per session vs 0.5c per individual request).
  const sessionTokenRef = useRef(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  const abortRef = useRef(null);
  const debounceRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function fetchSuggestions(q) {
    if (abortRef.current) abortRef.current.abort();
    if (!window.suggestAddress || !window.MAPBOX_API_KEY) { setSuggestions([]); return; }
    if (!q || q.trim().length < 3) { setSuggestions([]); setLoading(false); return; }
    abortRef.current = new AbortController();
    setLoading(true);
    window.suggestAddress(q, {
      sessionToken: sessionTokenRef.current,
      proximity,
      signal: abortRef.current.signal,
    }).then(r => {
      setSuggestions(r);
      setActive(0);
      setLoading(false);
    });
  }

  function handleChange(v) {
    onChange(v);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 250);
  }

  async function handlePick(s) {
    setOpen(false);
    setSuggestions([]);
    if (!window.retrieveAddress) { onChange(s.address); return; }
    const parts = await window.retrieveAddress(s.id, { sessionToken: sessionTokenRef.current });
    if (parts) {
      onSelect && onSelect(parts);
      // Mint a fresh session token for the next address - one session per
      // completed selection per Mapbox billing rules.
      sessionTokenRef.current = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    } else {
      onChange(s.address);
    }
  }

  function handleKey(e) {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); handlePick(suggestions[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  return <div ref={wrapRef} className="address-typeahead" style={{position:'relative', flex:1, minWidth:0, ...style}}>
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={e => handleChange(e.target.value)}
      onFocus={() => suggestions.length > 0 && setOpen(true)}
      onKeyDown={handleKey}
      autoComplete="off"
      style={{width:'100%'}}
    />
    {open && (loading || suggestions.length > 0) && <div className="address-suggest">
      {loading && suggestions.length === 0 && <div className="address-suggest-loading">Searching…</div>}
      {suggestions.map((s, i) => <div
        key={s.id}
        className={'address-suggest-item' + (i === active ? ' active' : '')}
        onMouseDown={e => { e.preventDefault(); handlePick(s); }}
        onMouseEnter={() => setActive(i)}
      >
        <div className="address-suggest-text">{s.text}</div>
        {s.subtext && s.subtext !== s.text && <div className="address-suggest-sub">{s.subtext}</div>}
      </div>)}
    </div>}
  </div>;
}
