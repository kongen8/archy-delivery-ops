// ===== ADDRESS AUTOCOMPLETE (Mapbox Search Box) =====
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
    if (retrieved) onPick({ address: retrieved.address || s.address, lat: retrieved.lat, lon: retrieved.lon });
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

// ===== DEPOT MANAGER (multi-tenant: writes via DB2.depots) =====
function DepotManager({regionKey,bakeryId,depots,onDepotsChange}){
  const[editing,setEditing]=useState(null);
  const[editName,setEditName]=useState('');
  const[editAddr,setEditAddr]=useState('');
  const[pickedCoords,setPickedCoords]=useState(null);
  const[geocoding,setGeocoding]=useState(false);
  const[geoError,setGeoError]=useState('');

  const startEdit=(i)=>{
    setEditing(i);
    setEditName(depots[i].name);
    setEditAddr(depots[i].addr||depots[i].address||'');
    setPickedCoords(null);
    setGeoError('');
  };
  const startAdd=()=>{
    setEditing('new');setEditName('');setEditAddr('');setPickedCoords(null);setGeoError('');
  };
  const cancel=()=>{setEditing(null);setGeoError('');setPickedCoords(null);};

  const save=async()=>{
    if(!editName.trim()||!editAddr.trim())return;
    if(!bakeryId){setGeoError('No bakery in context — reload and try again.');return;}
    let coords=pickedCoords;
    if(!coords){
      setGeocoding(true);setGeoError('');
      const geo=await geocodeAddress(editAddr.trim());
      setGeocoding(false);
      if(!geo){setGeoError('Could not geocode. Try picking from the suggestions.');return;}
      coords={lat:geo.lat,lon:geo.lon};
    }

    if(editing==='new'){
      await DB2.upsertDepot({bakeryId,name:editName.trim(),address:editAddr.trim(),lat:coords.lat,lon:coords.lon});
    }else{
      const existing=depots[editing];
      await DB2.upsertDepot({id:existing.id,bakeryId,name:editName.trim(),address:editAddr.trim(),lat:coords.lat,lon:coords.lon});
    }
    setEditing(null);
    setPickedCoords(null);
    onDepotsChange&&onDepotsChange();
  };

  const remove=async(i)=>{
    if(depots.length<=1){alert('Must have at least one location.');return;}
    if(!confirm(`Remove "${depots[i].name}"? Routes will need rebalancing.`))return;
    if(depots[i].id)await DB2.deleteDepot(depots[i].id);
    onDepotsChange&&onDepotsChange();
  };

  // Bias suggestions near the first existing depot in this region, if any.
  const proximity=depots[0]?{lat:depots[0].lat,lon:depots[0].lon}:null;

  return <div style={{marginTop:12,paddingTop:10,borderTop:'1px solid #f1f5f9'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
      <div style={{fontSize:12,color:'#94a3b8',fontWeight:600}}>Bakery locations</div>
      {editing===null&&<button onClick={startAdd}
        style={{fontSize:11,color:'#2563eb',background:'#eff6ff',border:'none',borderRadius:5,padding:'3px 10px',cursor:'pointer',fontWeight:500}}>
        + Add location
      </button>}
    </div>

    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
      {depots.map((dep,i)=>
        editing===i?null:
        <div key={dep.id||i} style={{fontSize:12,color:'#475569',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:6,padding:'4px 10px',display:'flex',alignItems:'center',gap:6}}>
          <span>{dep.name}</span>
          <span style={{color:'#94a3b8',fontSize:11}}>{(dep.addr||dep.address||'').split(',')[0]}</span>
          <button onClick={()=>startEdit(i)} style={{background:'none',border:'none',color:'#2563eb',cursor:'pointer',fontSize:11,padding:0}}>edit</button>
          {depots.length>1&&<button onClick={()=>remove(i)} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontSize:11,padding:0}}>×</button>}
        </div>
      )}
    </div>

    {editing!==null&&<div style={{marginTop:8,padding:12,background:'#f8fafc',borderRadius:8,border:'1px solid #e2e8f0'}}>
      <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:'#0f172a'}}>{editing==='new'?'Add location':'Edit location'}</div>
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        <div>
          <label style={{fontSize:11,color:'#64748b',display:'block',marginBottom:2}}>Name</label>
          <input value={editName} onChange={e=>setEditName(e.target.value)} placeholder="e.g. SmallCakes - Lake Mary"
            style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #e2e8f0',fontSize:13,boxSizing:'border-box'}}/>
        </div>
        <div>
          <label style={{fontSize:11,color:'#64748b',display:'block',marginBottom:2}}>
            Full address {pickedCoords&&<span style={{color:'#16a34a',fontWeight:500}}>· pinned</span>}
          </label>
          <AddressAutocomplete value={editAddr}
            onValueChange={v=>{setEditAddr(v);}}
            onPick={picked=>{
              if(picked){setEditAddr(picked.address);setPickedCoords({lat:picked.lat,lon:picked.lon});}
              else setPickedCoords(null);
            }}
            proximity={proximity}
            placeholder="Start typing an address…"/>
        </div>
        {geoError&&<div style={{fontSize:11,color:'#dc2626'}}>{geoError}</div>}
        <div style={{display:'flex',gap:6}}>
          <button onClick={save} disabled={geocoding||!editName.trim()||!editAddr.trim()}
            style={{background:geocoding?'#94a3b8':'#1e293b',color:'white',border:'none',borderRadius:6,padding:'6px 14px',fontSize:12,cursor:geocoding?'wait':'pointer',fontWeight:600}}>
            {geocoding?'Geocoding...':'Save'}
          </button>
          <button onClick={cancel}
            style={{background:'#f1f5f9',color:'#64748b',border:'none',borderRadius:6,padding:'6px 14px',fontSize:12,cursor:'pointer',fontWeight:500}}>
            Cancel
          </button>
        </div>
      </div>
    </div>}
  </div>;
}
