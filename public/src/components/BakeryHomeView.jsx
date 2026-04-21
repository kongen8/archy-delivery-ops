// ===== BAKERY HOME VIEW =====
// Mounts the Archy-era region/day/driver flow, but filters window.REGIONS to
// only this bakery's regions. All other behavior is unchanged from the
// Plan 1 App.jsx.
//
// When `driverMode` is true, the shell is repurposed for the driver link
// (`#/driver/<bakery-uuid>`): the header reads "Driver — <bakery>", the tab
// bar is narrowed to Operations / Map / Photos, and every route-adjusting
// control further down the tree is hidden via the same flag.
function BakeryHomeView({bakeryId,driverMode}){
  const[view,setView]=useState('ops');
  const[region,setRegion]=useState(null);
  const[statuses,setStatuses]=useState({});
  const[routeOverrides,setRouteOverrides]=useState({});
  const[syncing,setSyncing]=useState(true);
  const[bootErr,setBootErr]=useState('');
  const[archyCtx,setArchyCtx]=useState(null);
  const[bakeryName,setBakeryName]=useState('');
  const[,setDepotsRev]=useState(0);
  const[searchQ,setSearchQ]=useState('');
  const[searchOpen,setSearchOpen]=useState(false);
  const[focusStop,setFocusStop]=useState(null);
  const searchBoxRef=useRef();

  useEffect(()=>{
    if(!DB2.ready){setBootErr('Supabase not configured.');setSyncing(false);return;}
    let unsub=()=>{};
    (async()=>{
      try{
        const shape=await ArchyAdapter.buildLegacyShape();
        if(!shape){setBootErr('Archy migration has not run.');setSyncing(false);return;}
        window.REGIONS=shape.REGIONS;
        window.ROUTE_DATA=shape.ROUTE_DATA;
        setArchyCtx(shape.context);
        const myBakery=(shape.context.bakeries||[]).find(b=>b.id===bakeryId);
        setBakeryName(myBakery?myBakery.name:'(unknown bakery)');

        const myKey=Object.keys(shape.REGIONS).find(k=>shape.REGIONS[k]._bakeryId===bakeryId);
        if(myKey)setRegion(myKey);

        const rovrs={};
        for(const[k,data]of Object.entries(shape.ROUTE_DATA)){
          if(shape.REGIONS[k]._bakeryId!==bakeryId)continue;
          if(data.rebalanced||data.modified)rovrs[k]=data;
        }
        setRouteOverrides(rovrs);

        const s=await DB2.loadStatuses(shape.context.campaign.id);
        setStatuses(s);
        unsub=DB2.subscribeStatuses(shape.context.campaign.id,(next)=>setStatuses(next));
        setSyncing(false);
      }catch(e){console.error(e);setBootErr('Failed to load data.');setSyncing(false);}
    })();
    return()=>unsub();
  },[bakeryId]);

  const onDepotsChange=useCallback(async()=>{
    const shape=await ArchyAdapter.buildLegacyShape();
    if(shape){window.REGIONS=shape.REGIONS;window.ROUTE_DATA=shape.ROUTE_DATA;}
    setDepotsRev(v=>v+1);
  },[]);

  const onRebalance=useCallback((regionKey,newData)=>{
    setRouteOverrides(prev=>{
      const next={...prev};
      if(newData===null)delete next[regionKey];else next[regionKey]=newData;
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
      if(action==='delivered'){next[id]='delivered';next[id+'_time']=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});DB2.saveStatus(id,'delivered',null,next[id+'_photo']||null);}
      else if(action==='failed'){next[id]='failed';if(note)next[id+'_note']=note;DB2.saveStatus(id,'failed',note,null);}
      else if(action==='pending'){delete next[id];delete next[id+'_time'];delete next[id+'_note'];delete next[id+'_photo'];DB2.deleteStatus(id);}
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
    if(!region)return;const data=getRouteData(region);if(!data)return;
    let html='<html><head><style>*{font-family:DM Sans,sans-serif}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:4px;text-align:left}th{border-bottom:1px solid #333}tr{border-bottom:1px solid #eee}.driver{page-break-inside:avoid;margin-bottom:24px}</style></head><body>';
    html+=`<h1>${window.REGIONS[region].bakery} — ${window.REGIONS[region].name}</h1>`;
    data.days.forEach((dd,di)=>{html+=`<h2>Day ${di+1}</h2>`;dd.routes.forEach(r=>{if(!r.ns)return;html+=`<div class="driver"><h3>${DRIVER_NAMES[r.drv]} — ${r.ns} stops — ${fmtDuration(r.tt)}</h3>`;html+='<table><tr><th>#</th><th>ETA</th><th>Practice</th><th>Address</th><th>Contact</th><th>Phone</th><th>✓</th></tr>';r.stops.forEach((s,i)=>{html+=`<tr><td>${i+1}</td><td>${fmtTime(s.eta)}</td><td><b>${s.co}</b></td><td>${s.ad}, ${s.ci}</td><td>${s.cn}</td><td>${s.ph}</td><td>☐</td></tr>`;});html+='</table></div>';});});
    html+='</body></html>';
    const win=window.open('','_blank');win.document.write(html);win.document.close();setTimeout(()=>win.print(),500);
  };

  const regionEntries=Object.entries(window.REGIONS||{}).filter(([,r])=>r._bakeryId===bakeryId);
  const totalStops=regionEntries.reduce((a,[k])=>a+((window.ROUTE_DATA?.[k]?.ts)||0),0);
  const depotOverrides={};

  // Order search: scan every stop across this bakery's regions/days/drivers.
  const searchResults=useMemo(()=>{
    const q=searchQ.trim().toLowerCase();
    if(q.length<2)return[];
    const out=[];
    for(const[key,r]of regionEntries){
      const data=getRouteData(key);
      if(!data||!data.days)continue;
      data.days.forEach((d,di)=>{
        d.routes.forEach((rt,ri)=>{
          (rt.stops||[]).forEach(s=>{
            const hay=[s.co,s.cn,s.ad,s.ci,s.st,s.zp,s.ph].filter(Boolean).join(' ').toLowerCase();
            if(hay.includes(q)){
              out.push({regionKey:key,regionName:r.name,regionColor:r.color,day:di,drv:ri,driverName:DRIVER_NAMES[rt.drv!==undefined?rt.drv:ri],stop:s});
            }
          });
        });
      });
    }
    return out.slice(0,30);
  },[searchQ,regionEntries,routeOverrides]);

  const handlePickResult=useCallback((res)=>{
    setRegion(res.regionKey);
    setView('ops');
    setFocusStop({day:res.day,drv:res.drv,stopId:res.stop.id,ts:Date.now()});
    setSearchQ('');
    setSearchOpen(false);
  },[]);

  useEffect(()=>{
    const onDocClick=(e)=>{
      if(searchBoxRef.current&&!searchBoxRef.current.contains(e.target))setSearchOpen(false);
    };
    document.addEventListener('mousedown',onDocClick);
    return()=>document.removeEventListener('mousedown',onDocClick);
  },[]);

  return <div className={`app-shell${view==='ops'||view==='map'?' wide':''}`}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}} className="no-print">
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{driverMode?`Driver — ${bakeryName||'Bakery'}`:(bakeryName||'Bakery')}</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}>{totalStops} deliveries · {regionEntries.length} region{regionEntries.length===1?'':'s'} · Archy × Daymaker Q2 2026
          {DB2.ready&&<span style={{marginLeft:6,color:'#16a34a'}}>● Live</span>}
          {!DB2.ready&&<span style={{marginLeft:6,color:'#f59e0b'}}>○ Offline</span>}
          {syncing&&<span style={{marginLeft:6,color:'#2563eb'}}>↻ Syncing...</span>}
        </span>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <div ref={searchBoxRef} style={{position:'relative'}}>
          <input
            type="text"
            value={searchQ}
            onChange={e=>{setSearchQ(e.target.value);setSearchOpen(true);}}
            onFocus={()=>setSearchOpen(true)}
            placeholder="Search orders…"
            style={{
              width:220,padding:'8px 12px',fontSize:13,borderRadius:8,
              border:'1px solid #e2e8f0',background:'#fff',outline:'none',
              fontFamily:'inherit'
            }}
          />
          {searchOpen&&searchQ.trim().length>=2&&
            <div style={{
              position:'absolute',top:'calc(100% + 4px)',right:0,
              minWidth:340,maxWidth:420,maxHeight:360,overflowY:'auto',
              background:'#fff',border:'1px solid #e2e8f0',borderRadius:8,
              boxShadow:'0 8px 24px rgba(15,23,42,0.08)',zIndex:50
            }}>
              {searchResults.length===0?
                <div style={{padding:'10px 12px',fontSize:12,color:'#94a3b8'}}>No matching orders</div>
                :searchResults.map((r,i)=>{
                  const st=statuses[r.stop.id]||'pending';
                  const dot=st==='delivered'?'#16a34a':st==='failed'?'#dc2626':'#cbd5e1';
                  return <button key={r.stop.id+'-'+i} onClick={()=>handlePickResult(r)}
                    style={{
                      display:'block',width:'100%',textAlign:'left',
                      padding:'8px 12px',background:'none',border:'none',
                      borderBottom:'1px solid #f1f5f9',cursor:'pointer',
                      fontFamily:'inherit'
                    }}
                    onMouseEnter={e=>e.currentTarget.style.background='#f8fafc'}
                    onMouseLeave={e=>e.currentTarget.style.background='none'}>
                    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:2}}>
                      <span style={{width:6,height:6,borderRadius:'50%',background:dot,display:'inline-block'}}></span>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{r.stop.co}</span>
                    </div>
                    <div style={{fontSize:12,color:'#64748b'}}>{r.stop.ad}, {r.stop.ci}{r.stop.zp?' '+r.stop.zp:''}</div>
                    {(r.stop.cn||r.stop.ph)&&
                      <div style={{fontSize:11,color:'#94a3b8',marginTop:1}}>
                        {r.stop.cn||''}{r.stop.cn&&r.stop.ph?' · ':''}{r.stop.ph||''}
                      </div>}
                    <div style={{fontSize:11,color:r.regionColor||'#64748b',marginTop:3,fontWeight:500}}>
                      {r.regionName} · Day {r.day+1} · {r.driverName}
                    </div>
                  </button>;
                })}
            </div>}
        </div>
        {view==='ops'&&region&&<button onClick={handlePrint} style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:8,padding:'8px 14px',fontSize:13,cursor:'pointer',fontWeight:500}}>🖨 Print routes</button>}
        <ProfileSwitcher/>
      </div>
    </div>

    {bootErr&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:8,marginBottom:12,fontSize:13}}>{bootErr}</div>}

    <div style={{display:'flex',gap:0,marginBottom:20,borderBottom:'1px solid #e2e8f0'}} className="no-print">
      {(driverMode
        ? [{k:'ops',l:'Operations'},{k:'map',l:'🧁 Map'},{k:'photos',l:'Photos'}]
        : [{k:'ops',l:'Operations'},{k:'map',l:'🧁 Map'},{k:'customer',l:'Campaign'},{k:'photos',l:'Photos'},{k:'production',l:'Production'}]
      ).map(t=>
        <button key={t.k} className={`view-tab ${view===t.k?'active':''}`} onClick={()=>setView(t.k)}>{t.l}</button>
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

    {region&&view==='ops'&&<OpsView regionKey={region} statuses={statuses} onAction={onAction} onPhotoUpload={onPhotoUpload} routeOverrides={routeOverrides} onRebalance={onRebalance} depotOverrides={depotOverrides} onDepotsChange={onDepotsChange} focusStop={focusStop&&window.REGIONS[region]?._bakeryId===bakeryId?focusStop:null} driverMode={driverMode}/>}
    {region&&view==='map'&&<MapView regionKey={region} statuses={statuses} routeOverrides={routeOverrides} depotOverrides={depotOverrides}/>}
    {view==='customer'&&<CustomerView statuses={statuses} routeOverrides={routeOverrides}/>}
    {view==='photos'&&<PhotosView routeOverrides={routeOverrides} campaignId={archyCtx&&archyCtx.campaign&&archyCtx.campaign.id}/>}
    {view==='production'&&<ProductionTab bakeryId={bakeryId}/>}
  </div>;
}
