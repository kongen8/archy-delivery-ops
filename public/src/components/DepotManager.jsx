// ===== DEPOT MANAGER COMPONENT =====
function DepotManager({regionKey,depots,onDepotsChange}){
  const[editing,setEditing]=useState(null); // index or 'new'
  const[editName,setEditName]=useState('');
  const[editAddr,setEditAddr]=useState('');
  const[geocoding,setGeocoding]=useState(false);
  const[geoError,setGeoError]=useState('');

  const startEdit=(i)=>{
    setEditing(i);
    setEditName(depots[i].name);
    setEditAddr(depots[i].addr||'');
    setGeoError('');
  };
  const startAdd=()=>{
    setEditing('new');
    setEditName('');
    setEditAddr('');
    setGeoError('');
  };
  const cancel=()=>{setEditing(null);setGeoError('');};

  const save=async()=>{
    if(!editName.trim()||!editAddr.trim())return;
    setGeocoding(true);setGeoError('');
    const geo=await geocodeAddress(editAddr.trim());
    setGeocoding(false);
    if(!geo){setGeoError('Could not geocode address. Check the address and try again.');return;}

    const updated=[...depots];
    const entry={name:editName.trim(),addr:editAddr.trim(),lat:geo.lat,lon:geo.lon};
    if(editing==='new'){updated.push(entry);}
    else{updated[editing]=entry;}
    onDepotsChange(regionKey,updated);
    setEditing(null);
  };

  const remove=(i)=>{
    if(depots.length<=1){alert('Must have at least one location.');return;}
    if(!confirm(`Remove "${depots[i].name}"? Routes will need rebalancing.`))return;
    const updated=depots.filter((_,j)=>j!==i);
    onDepotsChange(regionKey,updated);
  };

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
        <div key={i} style={{fontSize:12,color:'#475569',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:6,padding:'4px 10px',display:'flex',alignItems:'center',gap:6}}>
          <span>{dep.name}</span>
          <span style={{color:'#94a3b8',fontSize:11}}>{dep.addr?dep.addr.split(',')[0]:''}</span>
          <button onClick={()=>startEdit(i)} style={{background:'none',border:'none',color:'#2563eb',cursor:'pointer',fontSize:11,padding:0}}>edit</button>
          {depots.length>1&&<button onClick={()=>remove(i)} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontSize:11,padding:0}}>×</button>}
        </div>
      )}
    </div>

    {/* Edit/Add form */}
    {editing!==null&&<div style={{marginTop:8,padding:12,background:'#f8fafc',borderRadius:8,border:'1px solid #e2e8f0'}}>
      <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:'#0f172a'}}>{editing==='new'?'Add location':'Edit location'}</div>
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        <div>
          <label style={{fontSize:11,color:'#64748b',display:'block',marginBottom:2}}>Name</label>
          <input value={editName} onChange={e=>setEditName(e.target.value)} placeholder="e.g. SmallCakes - Lake Mary"
            style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #e2e8f0',fontSize:13,boxSizing:'border-box'}}/>
        </div>
        <div>
          <label style={{fontSize:11,color:'#64748b',display:'block',marginBottom:2}}>Full address</label>
          <input value={editAddr} onChange={e=>setEditAddr(e.target.value)} placeholder="e.g. 4300 W Lake Mary Blvd, Lake Mary, FL 32746"
            style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #e2e8f0',fontSize:13,boxSizing:'border-box'}}/>
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
