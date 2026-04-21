// ===== DRIVER HOME VIEW =====
// Entry point for the driver-facing link. Drivers land here via `#/driver`
// (no bakery selected → show a bakery picker) or `#/driver/<bakery-uuid>`
// (jump straight into the read-only-ish operations view for that bakery).
//
// The actual ops UI is BakeryHomeView, mounted with `driverMode` so all
// route-adjusting controls (manage drivers & days, bakery locations, per-day
// depot activation, per-route starting depot, per-stop Move) stay hidden.
function DriverHomeView({bakeryId}){
  const[bakeries,setBakeries]=useState(null);
  const[err,setErr]=useState('');

  useEffect(()=>{
    if(bakeryId)return;
    (async()=>{
      try{
        if(typeof sb==='undefined'||!sb){setErr('Supabase not configured.');return;}
        const{data,error}=await sb.from('bakeries').select('id, name').order('name');
        if(error)throw error;
        setBakeries(data||[]);
      }catch(e){setErr(e.message||'Failed to load bakeries.');}
    })();
  },[bakeryId]);

  if(bakeryId){
    return <BakeryHomeView bakeryId={bakeryId} driverMode={true}/>;
  }

  return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:24,background:'#f9fafb',fontFamily:"'DM Sans',system-ui,sans-serif"}}>
    <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:16,padding:32,maxWidth:520,width:'100%',boxShadow:'0 1px 2px rgba(0,0,0,.05)'}}>
      <div style={{fontSize:20,fontWeight:600,margin:'0 0 4px',color:'#111827'}}>Driver — Pick your bakery</div>
      <div style={{fontSize:14,color:'#6b7280',margin:'0 0 20px'}}>Choose the bakery you're delivering for today.</div>
      {err&&<div style={{background:'#fef2f2',color:'#991b1b',padding:10,borderRadius:8,fontSize:13,marginBottom:12}}>{err}</div>}
      {!bakeries&&!err&&<div style={{fontSize:13,color:'#9ca3af'}}>Loading…</div>}
      {bakeries&&bakeries.length===0&&<div style={{fontSize:13,color:'#9ca3af'}}>No bakeries yet.</div>}
      {bakeries&&bakeries.map(b=>
        <button key={b.id} onClick={()=>window.switchProfile({type:'driver',id:b.id,name:b.name})}
          style={{display:'block',width:'100%',textAlign:'left',padding:'10px 12px',marginBottom:6,
            background:'#f3f4f6',color:'#111827',border:0,borderRadius:6,fontSize:14,cursor:'pointer',
            fontFamily:'inherit',fontWeight:500}}
          onMouseEnter={e=>e.currentTarget.style.background='#e5e7eb'}
          onMouseLeave={e=>e.currentTarget.style.background='#f3f4f6'}>
          {b.name}
        </button>
      )}
      <div style={{borderTop:'1px solid #f3f4f6',marginTop:16,paddingTop:12,fontSize:12,color:'#9ca3af',textAlign:'center'}}>
        This view only lets you mark stops as delivered or failed.
      </div>
    </div>
  </div>;
}
