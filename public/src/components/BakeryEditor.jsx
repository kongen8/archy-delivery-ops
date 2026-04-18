// ===== BAKERY EDITOR (form + sidebar; map wired in Task 8) =====
function BakeryEditor({bakeryId,isNew}){
  const[name,setName]=useState('');
  const[email,setEmail]=useState('');
  const[phone,setPhone]=useState('');
  const[loaded,setLoaded]=useState(isNew);
  const[saving,setSaving]=useState(false);
  const[err,setErr]=useState('');
  const[bakery,setBakery]=useState(null);
  const[deliveryAreas,setDeliveryAreas]=useState([]);
  const[depots,setDepots]=useState([]);

  useEffect(()=>{
    if(isNew){setLoaded(true);return;}
    (async()=>{
      try{
        const{bakery:b,delivery_areas,depots:d}=await Admin.getBakery(bakeryId);
        setBakery(b);setName(b.name||'');setEmail(b.contact_email||'');setPhone(b.contact_phone||'');
        setDeliveryAreas(delivery_areas);setDepots(d);setLoaded(true);
      }catch(e){setErr(e.message);setLoaded(true);}
    })();
  },[bakeryId,isNew]);

  const refreshDepots=useCallback(async()=>{
    if(!bakery)return;
    const{depots:d}=await Admin.getBakery(bakery.id);
    setDepots(d);
  },[bakery]);

  const save=async()=>{
    setSaving(true);setErr('');
    try{
      if(isNew){
        const created=await Admin.createBakery({name,contact_email:email,contact_phone:phone});
        navigate('#/admin/bakery/'+created.id);
      }else{
        const updated=await Admin.updateBakery(bakeryId,{name,contact_email:email,contact_phone:phone});
        setBakery(updated);
      }
    }catch(e){setErr(e.message);}
    setSaving(false);
  };

  if(!loaded)return <div style={{padding:40}}>Loading…</div>;

  const shareLink=bakery?window.location.origin+window.location.pathname+'?profile=bakery:'+bakery.id+'#/bakery/'+bakery.id:null;

  return <div className="app-shell wide" style={{padding:0,display:'flex',height:'calc(100vh - 20px)'}}>
    <aside className="admin-sidebar">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <a href="#/admin" style={{color:'#2563eb',fontSize:12,textDecoration:'none'}}>← Admin</a>
        <ProfileSwitcher/>
      </div>
      <h1 style={{fontSize:18,fontWeight:700,margin:'0 0 16px'}}>{isNew?'New bakery':name||'Bakery'}</h1>

      {err&&<div style={{background:'#fef2f2',color:'#991b1b',padding:10,borderRadius:6,marginBottom:12,fontSize:12}}>{err}</div>}

      <h4>Details</h4>
      <div className="admin-field"><label>Name</label><input value={name} onChange={e=>setName(e.target.value)}/></div>
      <div className="admin-field"><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)}/></div>
      <div className="admin-field"><label>Phone</label><input value={phone} onChange={e=>setPhone(e.target.value)}/></div>

      <div className="admin-section">
        <h4>Delivery areas ({deliveryAreas.length})</h4>
        <div style={{fontSize:12,color:'#9ca3af'}}>Polygon draw tools arrive in Task 8. Existing areas are listed below.</div>
        <ul style={{listStyle:'none',padding:0,margin:'8px 0 0'}}>
          {deliveryAreas.map(a=><li key={a.id} style={{padding:'6px 0',fontSize:12,color:'#374151'}}>{a.name||'(unnamed area)'}</li>)}
        </ul>
      </div>

      {!isNew&&bakery&&<div className="admin-section">
        <h4>Depots ({depots.length})</h4>
        <DepotManager bakeryId={bakery.id} depots={depots} onDepotsChange={refreshDepots}/>
      </div>}

      {shareLink&&<div className="admin-section">
        <label style={{display:'block',color:'#6b7280',fontSize:12,fontWeight:500,marginBottom:4}}>Share link</label>
        <div style={{display:'flex',gap:6}}>
          <input readOnly value={shareLink} style={{flex:1,padding:'6px 10px',border:'1px solid #d1d5db',borderRadius:4,fontSize:11,fontFamily:'ui-monospace,Menlo,monospace'}}/>
          <button className="btn-ghost" onClick={()=>navigator.clipboard.writeText(shareLink)}>Copy</button>
        </div>
        <div style={{fontSize:11,color:'#9ca3af',marginTop:4}}>Auth is off in Plan 2; this link just pre-selects the profile.</div>
      </div>}

      <div style={{position:'sticky',bottom:0,background:'#fff',paddingTop:14,marginTop:14,borderTop:'1px solid #f3f4f6',display:'flex',gap:8,justifyContent:'flex-end'}}>
        <button className="btn-ghost" onClick={()=>navigate('#/admin')}>Cancel</button>
        <button className="btn-primary" disabled={saving||!name} onClick={save}>{saving?'Saving…':isNew?'Create bakery':'Save'}</button>
      </div>
    </aside>

    <main style={{flex:1,background:'#f3f4f6',display:'flex',alignItems:'center',justifyContent:'center',color:'#9ca3af',fontSize:13}}>
      Map · polygon drawing wired up in Task 8.
    </main>
  </div>;
}
