// ===== PROFILE SWITCHER =====
// Pill showing the current profile. Clicking reveals a dropdown with
// "Admin", a list of bakeries, a list of customers, and "Sign out"
// (= clear localStorage + reload). Pure client-side switching via
// window.switchProfile; no auth check needed in Plan 2.
function ProfileSwitcher(){
  const[open,setOpen]=useState(false);
  const[profiles,setProfiles]=useState({bakeries:[],customers:[]});
  const[loaded,setLoaded]=useState(false);
  const ref=useRef(null);
  const current=window.__CURRENT_PROFILE__||{type:'landing'};

  useEffect(()=>{
    if(!open||loaded)return;
    (async()=>{
      try{
        const[bakeries,customers]=await Promise.all([Admin.listBakeries(),Admin.listCustomers()]);
        setProfiles({bakeries,customers});setLoaded(true);
      }catch(e){setLoaded(true);}
    })();
  },[open,loaded]);

  useEffect(()=>{
    if(!open)return;
    const onDoc=(e)=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener('mousedown',onDoc);
    return()=>document.removeEventListener('mousedown',onDoc);
  },[open]);

  const label=current.type==='admin'?'Admin':current.type==='bakery'?`Bakery · ${current.name||current.id?.slice(0,6)}`:current.type==='customer'?`Customer · ${current.name||current.id?.slice(0,6)}`:'Profile';

  return <div ref={ref} style={{position:'relative'}}>
    <button className="btn-ghost" onClick={()=>setOpen(o=>!o)} style={{display:'inline-flex',alignItems:'center',gap:6}}>
      <span>{label}</span><span style={{fontSize:10,opacity:0.6}}>▾</span>
    </button>
    {open&&<div style={{position:'absolute',top:'calc(100% + 4px)',right:0,background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,boxShadow:'0 10px 25px rgba(0,0,0,0.08)',minWidth:260,maxHeight:360,overflow:'auto',zIndex:50,padding:6}}>
      <ProfileRow label="Admin" active={current.type==='admin'} onClick={()=>{window.switchProfile({type:'admin'});setOpen(false);}}/>
      {!loaded?<div style={{padding:'8px 12px',fontSize:12,color:'#9ca3af'}}>Loading…</div>:<>
        {profiles.bakeries.length>0&&<SectionHeader>Bakeries</SectionHeader>}
        {profiles.bakeries.map(b=><ProfileRow key={b.id} label={b.name||b.id.slice(0,6)} active={current.type==='bakery'&&current.id===b.id} onClick={()=>{window.switchProfile({type:'bakery',id:b.id,name:b.name});setOpen(false);}}/>)}
        {profiles.customers.length>0&&<SectionHeader>Customers</SectionHeader>}
        {profiles.customers.map(c=><ProfileRow key={c.id} label={c.name||c.id.slice(0,6)} active={current.type==='customer'&&current.id===c.id} onClick={()=>{window.switchProfile({type:'customer',id:c.id,name:c.name});setOpen(false);}}/>)}
      </>}
      <div style={{borderTop:'1px solid #f3f4f6',marginTop:4,paddingTop:4}}>
        <ProfileRow label="Sign out" danger onClick={()=>{window.signOutProfile();}}/>
      </div>
    </div>}
  </div>;
}

function ProfileRow({label,active,danger,onClick}){
  return <button onClick={onClick} style={{
    display:'block',width:'100%',textAlign:'left',background:active?'#eff6ff':'transparent',color:danger?'#991b1b':active?'#1e40af':'#374151',
    border:'none',padding:'7px 12px',borderRadius:4,fontSize:13,cursor:'pointer',fontWeight:active?600:400,
  }} onMouseEnter={e=>{if(!active)e.currentTarget.style.background='#f9fafb';}}
     onMouseLeave={e=>{if(!active)e.currentTarget.style.background='transparent';}}>
    {label}
  </button>;
}

function SectionHeader({children}){
  return <div style={{padding:'8px 12px 3px',fontSize:10,color:'#9ca3af',textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:600}}>{children}</div>;
}
