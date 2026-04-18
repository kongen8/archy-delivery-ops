// ===== ADMIN VIEW =====
// Top-level admin surface. Switches between list / bakery-editor / customer-editor
// based on the route (from router.js). List view shows bakeries and customers
// with "View as →" shortcuts for one-click profile switching.
function AdminView({route}){
  if(route.page==='bakery-editor')return <BakeryEditor bakeryId={route.id} isNew={route.isNew}/>;
  if(route.page==='customer-editor')return <CustomerEditor customerId={route.id} isNew={route.isNew}/>;
  return <AdminList/>;
}

function AdminList(){
  const[bakeries,setBakeries]=useState(null);
  const[customers,setCustomers]=useState(null);
  const[err,setErr]=useState('');

  useEffect(()=>{(async()=>{
    try{
      const[b,c]=await Promise.all([Admin.listBakeries(),Admin.listCustomers()]);
      setBakeries(b);setCustomers(c);
    }catch(e){setErr(e.message||String(e));}
  })();},[]);

  return <div className="app-shell wide">
    <AdminHeader/>
    {err&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:8,marginBottom:12,fontSize:13}}>{err}</div>}

    <section style={{marginBottom:32}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <h2 style={{fontSize:16,fontWeight:600,margin:0}}>Bakeries</h2>
        <button className="btn-primary" onClick={()=>navigate('#/admin/bakery/new')}>+ New bakery</button>
      </div>
      {bakeries===null?<Loading/>:bakeries.length===0?<Empty msg="No bakeries yet."/>:
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {bakeries.map(b=><BakeryRow key={b.id} bakery={b}/>)}
        </div>
      }
    </section>

    <section>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <h2 style={{fontSize:16,fontWeight:600,margin:0}}>Customers</h2>
        <button className="btn-primary" onClick={()=>navigate('#/admin/customer/new')}>+ New customer</button>
      </div>
      {customers===null?<Loading/>:customers.length===0?<Empty msg="No customers yet."/>:
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {customers.map(c=><CustomerRow key={c.id} customer={c}/>)}
        </div>
      }
    </section>
  </div>;
}

function AdminHeader(){
  return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:24}}>
    <div>
      <h1 style={{fontSize:18,fontWeight:700,margin:0}}>Admin</h1>
      <span style={{fontSize:12,color:'#94a3b8'}}>Manage bakeries and customers.</span>
    </div>
    <ProfileSwitcher/>
  </div>;
}

function BakeryRow({bakery}){
  return <div className="admin-row">
    <div style={{flex:1}}>
      <div style={{fontWeight:500}}>{bakery.name}</div>
      <div style={{fontSize:12,color:'#64748b'}}>{bakery.contact_email||'—'} · {bakery.contact_phone||'—'}</div>
    </div>
    <button className="btn-link" onClick={()=>window.switchProfile({type:'bakery',id:bakery.id})}>View as bakery →</button>
    <button className="btn-ghost" onClick={()=>navigate('#/admin/bakery/'+bakery.id)}>Edit</button>
  </div>;
}

function CustomerRow({customer}){
  return <div className="admin-row">
    <div style={{flex:1}}>
      <div style={{fontWeight:500}}>{customer.name}</div>
      <div style={{fontSize:12,color:'#64748b'}}>{customer.contact_email||'—'}</div>
    </div>
    <button className="btn-link" onClick={()=>window.switchProfile({type:'customer',id:customer.id})}>View as customer →</button>
    <button className="btn-ghost" onClick={()=>navigate('#/admin/customer/'+customer.id)}>Edit</button>
  </div>;
}

function Loading(){return <div style={{color:'#94a3b8',fontSize:13,padding:'12px 0'}}>Loading…</div>;}
function Empty({msg}){return <div style={{color:'#94a3b8',fontSize:13,padding:'12px 0'}}>{msg}</div>;}
