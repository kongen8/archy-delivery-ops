// ===== MAIN APP =====
function App(){
  const[view,setView]=useState('ops');
  const[region,setRegion]=useState(null);
  const[statuses,setStatuses]=useState({});
  const[routeOverrides,setRouteOverrides]=useState({});
  const[dbReady,setDbReady]=useState(false);
  const[syncing,setSyncing]=useState(true);
  const[bootErr,setBootErr]=useState('');
  const[archyCtx,setArchyCtx]=useState(null);
  const[depotsRev,setDepotsRev]=useState(0);

  useEffect(()=>{
    if(!DB2.ready){
      setBootErr('Supabase not configured.');
      setDbReady(true);setSyncing(false);
      return;
    }
    let unsub=()=>{};
    (async()=>{
      try{
        const shape=await ArchyAdapter.buildLegacyShape();
        if(!shape){
          setBootErr('Archy migration has not run. Run scripts/migrate-archy first.');
          setDbReady(true);setSyncing(false);
          return;
        }
        window.REGIONS=shape.REGIONS;
        window.ROUTE_DATA=shape.ROUTE_DATA;
        setArchyCtx(shape.context);

        const firstKey=Object.keys(shape.REGIONS)[0];
        if(firstKey)setRegion(firstKey);

        // If a saved route override exists for a region, mirror it into routeOverrides
        // so UI "modified" affordances behave like before. Saved data is already inside
        // window.ROUTE_DATA at this point; routeOverrides just signals "user-edited".
        const rovrs={};
        for(const[k,data]of Object.entries(shape.ROUTE_DATA)){
          if(data.rebalanced||data.modified)rovrs[k]=data;
        }
        setRouteOverrides(rovrs);

        const s=await DB2.loadStatuses(shape.context.campaign.id);
        setStatuses(s);

        unsub=DB2.subscribeStatuses(shape.context.campaign.id,(newStatuses)=>setStatuses(newStatuses));

        setDbReady(true);setSyncing(false);
      }catch(e){
        console.error('Boot failed:',e);
        setBootErr('Failed to load data. See console.');
        setDbReady(true);setSyncing(false);
      }
    })();
    return()=>unsub();
  },[]);

  const onDepotsChange=useCallback(async()=>{
    const shape=await ArchyAdapter.buildLegacyShape();
    if(shape){window.REGIONS=shape.REGIONS;window.ROUTE_DATA=shape.ROUTE_DATA;}
    setDepotsRev(v=>v+1);
  },[]);

  const onRebalance=useCallback((regionKey,newData)=>{
    setRouteOverrides(prev=>{
      const next={...prev};
      if(newData===null)delete next[regionKey];
      else next[regionKey]=newData;
      return next;
    });
    const r=window.REGIONS[regionKey];
    if(r&&r._bakeryId&&r._deliveryAreaId&&archyCtx){
      DB2.saveRoute(archyCtx.campaign.id,r._bakeryId,r._deliveryAreaId,newData);
    }
  },[archyCtx]);

  const getRouteData=useCallback((key)=>routeOverrides[key]||window.ROUTE_DATA?.[key],[routeOverrides]);

  const onAction=useCallback((id,action,note)=>{
    setStatuses(prev=>{
      const next={...prev};
      if(action==='delivered'){
        next[id]='delivered';
        next[id+'_time']=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        DB2.saveStatus(id,'delivered',null,next[id+'_photo']||null);
      }else if(action==='failed'){
        next[id]='failed';
        if(note)next[id+'_note']=note;
        DB2.saveStatus(id,'failed',note,null);
      }else if(action==='pending'){
        delete next[id];
        delete next[id+'_time'];
        delete next[id+'_note'];
        delete next[id+'_photo'];
        DB2.deleteStatus(id);
      }
      return next;
    });
  },[]);

  const onPhotoUpload=useCallback((stopId,photoUrl)=>{
    setStatuses(prev=>{
      const next={...prev,[stopId+'_photo']:photoUrl};
      if(next[stopId]==='delivered')DB2.saveStatus(stopId,'delivered',null,photoUrl);
      return next;
    });
  },[]);

  const handlePrint=()=>{
    if(!region)return;
    const data=getRouteData(region);
    if(!data)return;
    let html='<html><head><style>*{font-family:DM Sans,sans-serif}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:4px;text-align:left}th{border-bottom:1px solid #333}tr{border-bottom:1px solid #eee}.driver{page-break-inside:avoid;margin-bottom:24px}</style></head><body>';
    html+=`<h1>${window.REGIONS[region].bakery} — ${window.REGIONS[region].name}</h1>`;
    data.days.forEach((dd,di)=>{
      html+=`<h2>Day ${di+1}</h2>`;
      dd.routes.forEach(r=>{
        if(!r.ns)return;
        html+=`<div class="driver"><h3>${DRIVER_NAMES[r.drv]} — ${r.ns} stops — ${fmtDuration(r.tt)}</h3>`;
        html+='<table><tr><th>#</th><th>ETA</th><th>Practice</th><th>Address</th><th>Contact</th><th>Phone</th><th>✓</th></tr>';
        r.stops.forEach((s,i)=>{
          html+=`<tr><td>${i+1}</td><td>${fmtTime(s.eta)}</td><td><b>${s.co}</b></td><td>${s.ad}, ${s.ci}</td><td>${s.cn}</td><td>${s.ph}</td><td>☐</td></tr>`;
        });
        html+='</table></div>';
      });
    });
    html+='</body></html>';
    const win=window.open('','_blank');
    win.document.write(html);
    win.document.close();
    setTimeout(()=>win.print(),500);
  };

  const regionEntries=Object.entries(window.REGIONS||{});
  const totalStops=regionEntries.reduce((a,[k])=>a+((window.ROUTE_DATA?.[k]?.ts)||0),0);
  const depotOverrides={};

  return <div className={`app-shell${view==='ops'||view==='map'?' wide':''}`}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}} className="no-print">
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>Archy × Daymaker</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}>{totalStops} deliveries · {regionEntries.length} regions · OR-Tools optimized
          {DB2.ready&&<span style={{marginLeft:6,color:'#16a34a'}}>● Live</span>}
          {!DB2.ready&&<span style={{marginLeft:6,color:'#f59e0b'}}>○ Offline</span>}
          {syncing&&<span style={{marginLeft:6,color:'#2563eb'}}>↻ Syncing...</span>}
        </span>
      </div>
      {view==='ops'&&region&&<button onClick={handlePrint}
        style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:8,padding:'8px 14px',fontSize:13,cursor:'pointer',fontWeight:500}}>
        🖨 Print routes
      </button>}
    </div>

    {bootErr&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:8,marginBottom:12,fontSize:13}}>{bootErr}</div>}

    <div style={{display:'flex',gap:0,marginBottom:20,borderBottom:'1px solid #e2e8f0'}} className="no-print">
      {[{k:'ops',l:'Operations'},{k:'map',l:'🧁 Map'},{k:'customer',l:'Campaign'},{k:'photos',l:'Photos'}].map(t=>
        <button key={t.k} className={`view-tab ${view===t.k?'active':''}`} onClick={()=>setView(t.k)}>
          {t.l}
        </button>
      )}
    </div>

    {(view==='ops'||view==='map')&&<div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap'}} className="no-print">
      {regionEntries.map(([k,c])=>{
        const d=getRouteData(k);
        return <button key={k} onClick={()=>setRegion(k)} style={{
          padding:'6px 14px',borderRadius:8,
          border:region===k?`2px solid ${c.color}`:'1px solid #e2e8f0',
          background:region===k?`${c.color}10`:'white',
          color:region===k?c.color:'#64748b',
          cursor:'pointer',fontSize:13,fontWeight:500
        }}>{c.name} ({d?d.ts:0})</button>;
      })}
    </div>}

    {region&&view==='ops'&&<OpsView regionKey={region} statuses={statuses} onAction={onAction} onPhotoUpload={onPhotoUpload} routeOverrides={routeOverrides} onRebalance={onRebalance} depotOverrides={depotOverrides} onDepotsChange={onDepotsChange}/>}
    {region&&view==='map'&&<MapView regionKey={region} statuses={statuses} routeOverrides={routeOverrides} depotOverrides={depotOverrides}/>}
    {view==='customer'&&<CustomerView statuses={statuses} routeOverrides={routeOverrides}/>}
    {view==='photos'&&<PhotosView routeOverrides={routeOverrides}/>}
  </div>;
}
