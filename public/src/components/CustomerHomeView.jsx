// ===== CUSTOMER HOME VIEW =====
// Read-only per-campaign dashboard. Plan 3 wires the "Upload campaign" CTA.
function CustomerHomeView({customerId}){
  const[state,setState]=useState({loading:true,customer:null,campaigns:[],counts:{},progress:{},err:''});

  useEffect(()=>{(async()=>{
    try{
      if(!sb){setState(s=>({...s,err:'Supabase not configured',loading:false}));return;}
      const{customer,campaigns}=await Admin.getCustomer(customerId);
      const counts={};const progress={};
      for(const camp of campaigns){
        const[{data:recips},{data:stats}]=await Promise.all([
          sb.from('recipients').select('assignment_status').eq('campaign_id',camp.id),
          sb.from('delivery_statuses_v2').select('status,recipients!inner(campaign_id)').eq('recipients.campaign_id',camp.id),
        ]);
        const countsByStatus={assigned:0,flagged_out_of_area:0,geocode_failed:0,needs_review:0};
        (recips||[]).forEach(r=>{countsByStatus[r.assignment_status]=(countsByStatus[r.assignment_status]||0)+1;});
        counts[camp.id]=countsByStatus;
        const total=(recips||[]).length;
        const delivered=(stats||[]).filter(s=>s.status==='delivered').length;
        progress[camp.id]={total,delivered};
      }
      setState({loading:false,customer,campaigns,counts,progress,err:''});
    }catch(e){setState(s=>({...s,err:e.message||String(e),loading:false}));}
  })();},[customerId]);

  const{loading,customer,campaigns,counts,progress,err}=state;
  if(loading)return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>Loading…</div>;
  if(err)return <div style={{padding:40,color:'#991b1b'}}>Failed: {err}</div>;

  return <div className="app-shell">
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{customer.name}</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}>Campaigns · Delivery progress</span>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <button className="btn-primary" disabled title="Coming soon in Plan 3" style={{opacity:0.5,cursor:'not-allowed'}}>+ Upload campaign (coming soon)</button>
        <ProfileSwitcher/>
      </div>
    </div>

    {campaigns.length===0?<div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>No campaigns yet.</div>:
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        {campaigns.map(c=><CampaignCard key={c.id} campaign={c} counts={counts[c.id]} progress={progress[c.id]}/>)}
      </div>
    }
  </div>;
}

function CampaignCard({campaign,counts,progress}){
  const pct=progress&&progress.total?Math.round(100*progress.delivered/progress.total):0;
  return <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,padding:16}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
      <div style={{fontWeight:600}}>{campaign.name}</div>
      <div style={{fontSize:11,color:'#6b7280',textTransform:'uppercase',letterSpacing:'0.05em'}}>{campaign.status}</div>
    </div>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
      <CountPill label="Assigned" n={counts?.assigned||0} color="#2563eb"/>
      <CountPill label="Flagged" n={counts?.flagged_out_of_area||0} color="#dc2626"/>
      <CountPill label="Geocode failed" n={counts?.geocode_failed||0} color="#f59e0b"/>
      <CountPill label="Needs review" n={counts?.needs_review||0} color="#7c3aed"/>
    </div>
    <div style={{fontSize:12,color:'#6b7280',marginBottom:4}}>Delivered {progress?.delivered||0} of {progress?.total||0} ({pct}%)</div>
    <div style={{background:'#f3f4f6',height:6,borderRadius:3,overflow:'hidden'}}>
      <div style={{width:`${pct}%`,height:'100%',background:'#10b981',transition:'width 0.2s'}}></div>
    </div>
  </div>;
}

function CountPill({label,n,color}){
  return <div style={{display:'flex',alignItems:'center',gap:6,padding:'3px 10px',borderRadius:999,background:`${color}15`,color,fontSize:12,fontWeight:500}}>
    <span>{n}</span><span style={{opacity:0.7}}>{label}</span>
  </div>;
}
