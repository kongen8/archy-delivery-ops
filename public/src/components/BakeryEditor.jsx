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
  const[otherAreas,setOtherAreas]=useState([]);
  const[depots,setDepots]=useState([]);
  const[hasInvalid,setHasInvalid]=useState(false);
  const[showReassign,setShowReassign]=useState(false);

  useEffect(()=>{
    if(isNew){
      setLoaded(true);
      Admin.listOtherBakeryAreas(null).then(setOtherAreas).catch(()=>{});
      return;
    }
    (async()=>{
      try{
        const[{bakery:b,delivery_areas,depots:d},others]=await Promise.all([
          Admin.getBakery(bakeryId),
          Admin.listOtherBakeryAreas(bakeryId),
        ]);
        setBakery(b);setName(b.name||'');setEmail(b.contact_email||'');setPhone(b.contact_phone||'');
        setDeliveryAreas(delivery_areas);setDepots(d);setOtherAreas(others);setLoaded(true);
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
        <div style={{fontSize:12,color:'#9ca3af'}}>Draw polygons on the map. Red = overlap with an existing area.</div>
        {!isNew&&bakery&&deliveryAreas.length>0&&<button
          className="btn-ghost"
          style={{marginTop:8,fontSize:12,width:'100%'}}
          onClick={()=>setShowReassign(true)}
        >Recompute assignments from areas…</button>}
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
        <button className="btn-primary" disabled={saving||!name||hasInvalid} title={hasInvalid?'Fix overlapping areas first':''} onClick={save}>{saving?'Saving…':isNew?'Create bakery':'Save'}</button>
      </div>
    </aside>

    <main style={{flex:1,position:'relative',background:'#f3f4f6'}}>
      {!isNew&&bakery?<DeliveryAreaDraw
        areas={deliveryAreas}
        otherBakeryAreas={otherAreas}
        onCreate={async(f)=>{
          const saved=await Admin.upsertDeliveryArea({bakery_id:bakery.id,name:null,geometry:f.geometry});
          setDeliveryAreas(prev=>[...prev,saved]);
          return{id:saved.id,name:saved.name||''};
        }}
        onUpdate={async(id,f)=>{
          const saved=await Admin.upsertDeliveryArea({id,bakery_id:bakery.id,name:null,geometry:f.geometry});
          setDeliveryAreas(prev=>prev.map(a=>a.id===id?saved:a));
        }}
        onDelete={async(id)=>{
          await Admin.deleteDeliveryArea(id);
          setDeliveryAreas(prev=>prev.filter(a=>a.id!==id));
        }}
        onInvalidChange={setHasInvalid}
      />:<div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',color:'#9ca3af',fontSize:13}}>
        Create the bakery first, then draw delivery areas on the map.
      </div>}
    </main>

    {showReassign&&bakery&&<ReassignModal
      bakery={bakery}
      onClose={()=>setShowReassign(false)}
    />}
  </div>;
}

// ===== REASSIGN MODAL =====
// Two-step: load preview → confirm → execute. Stays lightweight; doesn't
// itself drive any point-in-polygon, just renders what the admin helpers
// return. Closes on success; leaves errors visible.
function ReassignModal({bakery,onClose}){
  const[phase,setPhase]=useState('loading');
  const[preview,setPreview]=useState(null);
  const[bakeryNames,setBakeryNames]=useState({});
  const[err,setErr]=useState('');
  const[result,setResult]=useState(null);

  useEffect(()=>{
    let alive=true;
    (async()=>{
      try{
        const[p,bakeries]=await Promise.all([
          Admin.previewReassignment(bakery.id),
          Admin.listBakeries(),
        ]);
        if(!alive)return;
        setPreview(p);
        const map={};for(const b of bakeries)map[b.id]=b.name;setBakeryNames(map);
        setPhase('preview');
      }catch(e){if(alive){setErr(e.message||String(e));setPhase('error');}}
    })();
    return()=>{alive=false;};
  },[bakery.id]);

  const apply=async()=>{
    setPhase('applying');setErr('');
    try{
      const r=await Admin.applyReassignment(bakery.id,preview);
      setResult(r);setPhase('done');
    }catch(e){setErr(e.message||String(e));setPhase('preview');}
  };

  const s=preview&&preview.summary;
  const byOldEntries=s?Object.entries(s.by_old_bakery):[];

  return <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.35)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:100}} onClick={onClose}>
    <div style={{background:'#fff',borderRadius:10,padding:24,minWidth:440,maxWidth:540,maxHeight:'80vh',overflow:'auto',boxShadow:'0 20px 50px rgba(0,0,0,0.25)'}} onClick={e=>e.stopPropagation()}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
        <div>
          <h2 style={{fontSize:16,fontWeight:700,margin:0}}>Recompute assignments</h2>
          <div style={{fontSize:12,color:'#6b7280',marginTop:2}}>{bakery.name}</div>
        </div>
        <button className="btn-ghost" onClick={onClose} disabled={phase==='applying'}>✕</button>
      </div>

      {phase==='loading'&&<div style={{padding:'20px 0',color:'#6b7280',fontSize:13}}>Scanning recipients…</div>}

      {phase==='error'&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:6,fontSize:13}}>
        Failed to build preview: {err}
      </div>}

      {phase==='preview'&&s&&<>
        <div style={{fontSize:13,color:'#374151',lineHeight:1.6,marginBottom:14}}>
          <b>{s.total_inside}</b> geocoded recipient{s.total_inside===1?'':'s'} fall inside this bakery's areas.
          <br/>
          <b>{s.already_here}</b> already belong to {bakery.name}; <b style={{color:'#dc2626'}}>{s.to_move}</b> will be moved here.
        </div>

        {s.to_move>0&&<div style={{background:'#f9fafb',border:'1px solid #e5e7eb',borderRadius:6,padding:12,marginBottom:14}}>
          <div style={{fontSize:12,fontWeight:600,color:'#374151',marginBottom:6}}>Currently owned by:</div>
          {byOldEntries.length===0?<div style={{fontSize:12,color:'#9ca3af'}}>—</div>:
            <ul style={{margin:0,padding:'0 0 0 16px',fontSize:12,color:'#4b5563'}}>
              {byOldEntries.map(([id,n])=>(
                <li key={id}>{id==='unassigned'?'Unassigned':(bakeryNames[id]||id.slice(0,6))}: <b>{n}</b></li>
              ))}
            </ul>}
        </div>}

        {preview.route_keys_old.length+preview.route_keys_new.length>0&&<div style={{fontSize:12,color:'#9ca3af',marginBottom:14}}>
          {preview.route_keys_old.length+preview.route_keys_new.length} saved route{preview.route_keys_old.length+preview.route_keys_new.length===1?'':'s'} will be cleared and rebuilt from the new assignment. Manual driver ordering for those areas will be lost.
        </div>}

        {err&&<div style={{background:'#fef2f2',color:'#991b1b',padding:10,borderRadius:6,fontSize:12,marginBottom:10}}>{err}</div>}

        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={s.to_move===0} onClick={apply}>
            {s.to_move===0?'Nothing to move':`Move ${s.to_move} recipient${s.to_move===1?'':'s'}`}
          </button>
        </div>
      </>}

      {phase==='applying'&&<div style={{padding:'20px 0',color:'#6b7280',fontSize:13}}>Applying…</div>}

      {phase==='done'&&result&&<>
        <div style={{background:'#ecfdf5',color:'#065f46',padding:12,borderRadius:6,fontSize:13,marginBottom:12}}>
          Moved <b>{result.moved}</b> recipient{result.moved===1?'':'s'}. Cleared <b>{result.routes_deleted_old+result.routes_deleted_new}</b> stale route{result.routes_deleted_old+result.routes_deleted_new===1?'':'s'}.
        </div>
        <div style={{display:'flex',justifyContent:'flex-end'}}>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </>}
    </div>
  </div>;
}
