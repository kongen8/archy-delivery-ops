// ===== CUSTOMER EDITOR =====
// Flat form. Create generates an access_token for forward-compat even though
// no auth is enforced today.
function CustomerEditor({customerId,isNew}){
  const[name,setName]=useState('');
  const[email,setEmail]=useState('');
  const[loaded,setLoaded]=useState(isNew);
  const[saving,setSaving]=useState(false);
  const[err,setErr]=useState('');
  const[row,setRow]=useState(null);

  useEffect(()=>{
    if(isNew)return;
    (async()=>{
      try{
        const{customer}=await Admin.getCustomer(customerId);
        setRow(customer);setName(customer.name||'');setEmail(customer.contact_email||'');setLoaded(true);
      }catch(e){setErr(e.message);setLoaded(true);}
    })();
  },[customerId,isNew]);

  const save=async()=>{
    setSaving(true);setErr('');
    try{
      if(isNew){
        const created=await Admin.createCustomer({name,contact_email:email});
        navigate('#/admin/customer/'+created.id);
      }else{
        const updated=await Admin.updateCustomer(customerId,{name,contact_email:email});
        setRow(updated);
      }
    }catch(e){setErr(e.message);}
    setSaving(false);
  };

  if(!loaded)return <div style={{padding:40}}>Loading…</div>;

  const shareLink=row?window.location.origin+window.location.pathname+'?profile=customer:'+row.id+'#/customer/'+row.id:null;

  return <div className="app-shell">
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{isNew?'New customer':name||'Customer'}</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}><a href="#/admin" style={{color:'#2563eb'}}>← Admin</a></span>
      </div>
      <div style={{display:'flex',gap:8}}>
        <button className="btn-ghost" onClick={()=>navigate('#/admin')}>Cancel</button>
        <button className="btn-primary" disabled={saving||!name} onClick={save}>{saving?'Saving…':isNew?'Create customer':'Save'}</button>
      </div>
    </div>

    {err&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:8,marginBottom:12,fontSize:13}}>{err}</div>}

    <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,padding:20,maxWidth:560}}>
      <div className="admin-field"><label>Name</label><input value={name} onChange={e=>setName(e.target.value)}/></div>
      <div className="admin-field"><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)}/></div>
      {shareLink&&<div className="admin-section">
        <label style={{display:'block',color:'#6b7280',fontSize:12,fontWeight:500,marginBottom:4}}>Share link</label>
        <div style={{display:'flex',gap:6}}>
          <input readOnly value={shareLink} style={{flex:1,padding:'6px 10px',border:'1px solid #d1d5db',borderRadius:4,fontSize:12,fontFamily:'ui-monospace,Menlo,monospace'}}/>
          <button className="btn-ghost" onClick={()=>navigator.clipboard.writeText(shareLink)}>Copy</button>
        </div>
        <div style={{fontSize:11,color:'#9ca3af',marginTop:4}}>Auth is off in Plan 2; this link just pre-selects the profile.</div>
      </div>}
    </div>
  </div>;
}
