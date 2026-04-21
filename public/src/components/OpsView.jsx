// ===== OPERATIONS VIEW (merged bakery + driver) =====
// `driverMode` (passed through from BakeryHomeView when mounted inside the
// driver link) hides every control that could mutate routing: DepotManager
// (bakery locations), per-day depot activation, the "Manage drivers & days"
// edit section, and the per-route "Starting from:" depot switcher. The Move
// button on each StopCard is also hidden via the same flag.
function OpsView({regionKey,statuses,onAction,onPhotoUpload,routeOverrides,onRebalance,depotOverrides,onDepotsChange,focusStop,driverMode}){
  const region=REGIONS[regionKey];
  const data=routeOverrides[regionKey]||ROUTE_DATA[regionKey];
  if(!data)return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>No data</div>;

  // Effective depots: overrides first, then authoritative list from window.ROUTE_DATA
  // (the adapter keeps it fresh after each DepotManager write), falling back to
  // whatever is embedded in a saved route override (which may be stale).
  const bakeryId=(REGIONS[regionKey]&&REGIONS[regionKey]._bakeryId)||null;
  const authoritativeDepots=window.ROUTE_DATA&&window.ROUTE_DATA[regionKey]&&window.ROUTE_DATA[regionKey].depots;
  const effectiveDepots=depotOverrides[regionKey]||authoritativeDepots||data.depots||[];

  const[selDay,setDay]=useState(0);
  const[selDrv,setDrv]=useState(0);
  const[editMode,setEditMode]=useState(false);
  const[numDays,setNumDays]=useState(data.ndays);
  const[numDrivers,setNumDrivers]=useState(data.nd);
  const[loading,setLoading]=useState(false);
  const[loadMsg,setLoadMsg]=useState('');
  // Per-day depot activation: {dayIndex: [depotName1, depotName2, ...]}
  const[dayDepotActive,setDayDepotActive]=useState({});
  const[highlightStopId,setHighlightStopId]=useState(null);

  // Jump to a specific stop when a search result is picked.
  useEffect(()=>{
    if(!focusStop)return;
    const d=routeOverrides[regionKey]||ROUTE_DATA[regionKey];
    if(!d||!d.days[focusStop.day])return;
    setDay(focusStop.day);
    setDrv(focusStop.drv);
    setHighlightStopId(focusStop.stopId);
    const t=setTimeout(()=>{
      const el=document.getElementById('stop-'+focusStop.stopId);
      if(el){el.scrollIntoView({behavior:'smooth',block:'center'});}
    },60);
    const t2=setTimeout(()=>setHighlightStopId(null),2400);
    return()=>{clearTimeout(t);clearTimeout(t2);};
  },[focusStop&&focusStop.ts,regionKey]);

  // Reset selection when region changes
  useEffect(()=>{
    const d=routeOverrides[regionKey]||ROUTE_DATA[regionKey];
    if(d){setNumDays(d.ndays);setNumDrivers(d.nd);}
    setDay(0);setDrv(0);
  },[regionKey]);

  // Also reset when overrides change (rebalance happened)
  useEffect(()=>{
    const d=routeOverrides[regionKey]||ROUTE_DATA[regionKey];
    if(d){setNumDays(d.ndays);setNumDrivers(d.nd);}
  },[routeOverrides[regionKey]]);

  const allStops=data.days.flatMap(d=>d.routes.flatMap(r=>r.stops));
  const totalDone=allStops.filter(s=>(statuses[s.id]||'pending')==='delivered').length;
  const totalFailed=allStops.filter(s=>(statuses[s.id]||'pending')==='failed').length;

  // Safely clamp selections
  const safeDay=Math.min(selDay,data.days.length-1);
  const dayData=data.days[safeDay];
  const safeDrv=dayData?Math.min(selDrv,dayData.routes.length-1):0;
  const route=dayData&&dayData.routes[safeDrv]?dayData.routes[safeDrv]:null;
  const stops=route?route.stops:[];

  const delivered=stops.filter(s=>(statuses[s.id]||'pending')==='delivered').length;
  const nextStop=stops.find(s=>(statuses[s.id]||'pending')==='pending');

  const handleRebalance=async()=>{
    setLoading(true);setLoadMsg('Fetching routes from OSRM...');
    try{
      const newData=await rebalanceRegionSmart(regionKey,numDays,numDrivers,(msg)=>setLoadMsg(msg),effectiveDepots,dayDepotActive);
      if(newData){
        onRebalance(regionKey,newData);
        setDay(0);setDrv(0);setEditMode(false);
      }
    }catch(e){console.error('Rebalance failed:',e);}
    setLoading(false);setLoadMsg('');
  };

  const handleReset=()=>{
    onRebalance(regionKey,null);
    const orig=ROUTE_DATA[regionKey];
    setNumDays(orig.ndays);setNumDrivers(orig.nd);
    setDay(0);setDrv(0);setEditMode(false);
  };

  const isModified=!!routeOverrides[regionKey];
  const isRebalanced=data.rebalanced===true;

  // Build move targets: list of all day+driver combos with stop counts
  const moveTargets=useMemo(()=>{
    const targets=[];
    data.days.forEach((d,di)=>{
      d.routes.forEach((r,ri)=>{
        targets.push({day:di,drv:ri,count:r.stops?r.stops.length:0});
      });
    });
    return targets;
  },[data]);

  // Move a stop from one driver/day to another
  const handleMoveStop=(stopId,fromDay,fromDrv,toDay,toDrv)=>{
    // Deep clone current effective data
    const cloned=JSON.parse(JSON.stringify(data));

    // Find and remove stop from source
    const srcRoute=cloned.days[fromDay].routes[fromDrv];
    const stopIdx=srcRoute.stops.findIndex(s=>s.id===stopId);
    if(stopIdx===-1)return;
    const[movedStop]=srcRoute.stops.splice(stopIdx,1);
    srcRoute.ns=srcRoute.stops.length;

    // Add to target
    const tgtRoute=cloned.days[toDay].routes[toDrv];
    tgtRoute.stops.push(movedStop);
    tgtRoute.ns=tgtRoute.stops.length;

    // Recalculate total stops
    cloned.ts=cloned.days.reduce((sum,d)=>sum+d.routes.reduce((s2,r)=>s2+r.stops.length,0),0);

    // Mark as modified
    cloned.modified=true;

    onRebalance(regionKey,cloned);
  };

  return <div>
    {/* Header card */}
    <div style={{background:'white',borderRadius:12,padding:20,marginBottom:16,border:'1px solid #e2e8f0'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:700,margin:0}}>{region.bakery}</h2>
          <span style={{fontSize:13,color:'#64748b'}}>{region.name} · {allStops.length} deliveries</span>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:24,fontWeight:700,color:region.color}}>{totalDone}/{allStops.length}</div>
          <div style={{fontSize:12,color:'#64748b'}}>delivered{totalFailed>0?` · ${totalFailed} failed`:''}</div>
        </div>
      </div>
      <ProgressBar done={totalDone} total={allStops.length} color={region.color}/>

      {/* Depot management (hidden for drivers — they can't edit bakery locations) */}
      {!driverMode&&<DepotManager regionKey={regionKey} bakeryId={bakeryId} depots={effectiveDepots} onDepotsChange={onDepotsChange}/>}

      {/* Per-day depot activation (multi-depot only). Hidden for drivers because
          toggling it requires a rebalance, which drivers can't run. */}
      {!driverMode&&effectiveDepots.length>1&&dayData&&<div style={{marginTop:8,padding:10,background:'#fefce8',borderRadius:8,border:'1px solid #fde68a'}}>
        <div style={{fontSize:11,color:'#92400e',fontWeight:600,marginBottom:6}}>Day {safeDay+1} — Active pickup locations</div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          {effectiveDepots.map((dep,i)=>{
            const activeList=dayDepotActive[safeDay]||(dayData.depots_active||effectiveDepots.map(d=>d.name));
            const isActive=activeList.includes(dep.name);
            const toggleDepot=()=>{
              const current=dayDepotActive[safeDay]||(dayData.depots_active||effectiveDepots.map(d=>d.name));
              let next;
              if(isActive){
                next=current.filter(n=>n!==dep.name);
                if(next.length===0){alert('At least one location must be active per day.');return;}
              }else{next=[...current,dep.name];}
              setDayDepotActive(prev=>({...prev,[safeDay]:next}));
            };
            return <button key={i} onClick={toggleDepot}
              style={{
                fontSize:12,borderRadius:6,padding:'5px 12px',cursor:'pointer',fontWeight:500,
                border:isActive?'1px solid #16a34a':'1px solid #e2e8f0',
                background:isActive?'#dcfce7':'#fff',
                color:isActive?'#15803d':'#94a3b8',
                textDecoration:isActive?'none':'line-through',
                opacity:isActive?1:0.6
              }}>
              {isActive?'✓ ':''}{shortDepot(dep.name)}
            </button>;
          })}
        </div>
        <div style={{fontSize:10,color:'#a16207',marginTop:4}}>Toggle locations on/off. Rebalance to apply changes.</div>
      </div>}

      {/* Driver/Day management controls (hidden for drivers) */}
      {!driverMode&&<div style={{marginTop:16,borderTop:'1px solid #e2e8f0',paddingTop:12}}>
        {!editMode?
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8}}>
            <span style={{fontSize:13,color:'#64748b'}}>
              {data.ndays} day{data.ndays>1?'s':''} · {data.nd} driver{data.nd>1?'s':''}/day
              {isModified&&<span style={{color:'#f59e0b',marginLeft:8,fontSize:11,fontWeight:600}}>{isRebalanced?'REBALANCED':'MODIFIED'}</span>}
            </span>
            <div style={{display:'flex',gap:6}}>
              {isModified&&<button onClick={handleReset}
                style={{background:'#fef3c7',color:'#92400e',border:'none',borderRadius:6,padding:'6px 12px',fontSize:12,cursor:'pointer',fontWeight:500}}>
                Reset to optimized
              </button>}
              <button onClick={()=>setEditMode(true)}
                style={{background:'#eff6ff',color:'#2563eb',border:'none',borderRadius:6,padding:'6px 12px',fontSize:12,cursor:'pointer',fontWeight:500}}>
                Manage drivers & days
              </button>
            </div>
          </div>:
          <div>
            <div style={{fontSize:13,fontWeight:600,marginBottom:10,color:'#0f172a'}}>Adjust routes</div>
            <div style={{display:'flex',gap:20,marginBottom:12,flexWrap:'wrap'}}>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontSize:13,color:'#64748b'}}>Days:</span>
                <button onClick={()=>setNumDays(Math.max(1,numDays-1))}
                  style={{width:28,height:28,borderRadius:6,border:'1px solid #e2e8f0',background:'white',cursor:'pointer',fontSize:16,fontWeight:600,color:'#64748b'}}>−</button>
                <span style={{fontSize:15,fontWeight:600,minWidth:20,textAlign:'center'}}>{numDays}</span>
                <button onClick={()=>setNumDays(Math.min(7,numDays+1))}
                  style={{width:28,height:28,borderRadius:6,border:'1px solid #e2e8f0',background:'white',cursor:'pointer',fontSize:16,fontWeight:600,color:'#64748b'}}>+</button>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontSize:13,color:'#64748b'}}>Drivers/day:</span>
                <button onClick={()=>setNumDrivers(Math.max(1,numDrivers-1))}
                  style={{width:28,height:28,borderRadius:6,border:'1px solid #e2e8f0',background:'white',cursor:'pointer',fontSize:16,fontWeight:600,color:'#64748b'}}>−</button>
                <span style={{fontSize:15,fontWeight:600,minWidth:20,textAlign:'center'}}>{numDrivers}</span>
                <button onClick={()=>setNumDrivers(Math.min(12,numDrivers+1))}
                  style={{width:28,height:28,borderRadius:6,border:'1px solid #e2e8f0',background:'white',cursor:'pointer',fontSize:16,fontWeight:600,color:'#64748b'}}>+</button>
              </div>
            </div>
            <div style={{fontSize:12,color:'#94a3b8',marginBottom:10}}>
              ~{Math.ceil(allStops.length/numDays/numDrivers)} stops per driver
            </div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <button onClick={handleRebalance} disabled={loading}
                style={{background:loading?'#94a3b8':'#1e293b',color:'white',border:'none',borderRadius:6,padding:'8px 16px',fontSize:13,cursor:loading?'wait':'pointer',fontWeight:600}}>
                {loading?'Routing...':'Rebalance routes'}
              </button>
              {!loading&&<button onClick={()=>{setEditMode(false);const d=routeOverrides[regionKey]||ROUTE_DATA[regionKey];setNumDays(d.ndays);setNumDrivers(d.nd);}}
                style={{background:'#f1f5f9',color:'#64748b',border:'none',borderRadius:6,padding:'8px 16px',fontSize:13,cursor:'pointer',fontWeight:500}}>
                Cancel
              </button>}
              {loading&&<span style={{fontSize:12,color:'#64748b'}}>{loadMsg}</span>}
            </div>
          </div>}
      </div>}
    </div>

    {/* Day pills */}
    <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
      {data.days.map((d,i)=>{
        const ds=d.routes.flatMap(r=>r.stops);
        const dd=ds.filter(s=>(statuses[s.id]||'pending')==='delivered').length;
        return <button key={i} className={`pill ${safeDay===i?'active':''}`} onClick={()=>{setDay(i);setDrv(0)}}>
          Day {i+1} <span style={{opacity:.7}}>{dd}/{ds.length}</span>
        </button>;
      })}
    </div>

    {/* Driver pills */}
    <div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap'}}>
      {dayData&&dayData.routes.map((r,i)=>{
        if(!r.stops||r.stops.length===0)return null;
        const dd=r.stops.filter(s=>(statuses[s.id]||'pending')==='delivered').length;
        const hasMultiDepot=data.depots&&data.depots.length>1;
        return <button key={i} className={`pill ${safeDrv===i?'active':''}`} onClick={()=>setDrv(i)}
          style={safeDrv===i?{}:{}}>
          <span>{DRIVER_NAMES[r.drv!==undefined?r.drv:i]}</span>
          <span style={{opacity:.7}}> {dd}/{r.stops.length}</span>
          {hasMultiDepot&&r.depot&&<span style={{display:'block',fontSize:10,opacity:.6,marginTop:1}}>{shortDepot(r.depot)}</span>}
        </button>;
      })}
    </div>

    {/* Selected driver summary + next stop */}
    {stops.length>0&&<div style={{background:'white',borderRadius:12,padding:16,marginBottom:12,border:'1px solid #e2e8f0'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <div>
          <div style={{fontSize:16,fontWeight:700}}>{DRIVER_NAMES[route&&route.drv!==undefined?route.drv:safeDrv]} — Day {safeDay+1}</div>
          <div style={{fontSize:13,color:'#64748b'}}>{stops.length} stops · {delivered} done{route&&stops.length>0?` · Est. ${fmtTime(stops[0].eta)}–${fmtTime(stops[stops.length-1].eta+300)}`:''}</div>
          {route&&route.depot&&effectiveDepots.length>1&&!driverMode?
            <div style={{fontSize:12,color:'#64748b',marginTop:2,display:'flex',alignItems:'center',gap:4}}>
              Starting from:
              <select value={route.depot} onChange={e=>{
                const newDepot=e.target.value;
                const cloned=JSON.parse(JSON.stringify(data));
                cloned.days[safeDay].routes[safeDrv].depot=newDepot;
                cloned.modified=true;
                onRebalance(regionKey,cloned);
              }} style={{fontSize:12,border:'1px solid #e2e8f0',borderRadius:4,padding:'2px 6px',background:'white',color:'#0f172a',cursor:'pointer'}}>
                {effectiveDepots.map((dep,i)=><option key={i} value={dep.name}>{shortDepot(dep.name)}</option>)}
              </select>
            </div>:
            route&&route.depot&&<div style={{fontSize:12,color:'#64748b',marginTop:2}}>Starting from: {driverMode?shortDepot(route.depot):route.depot}</div>}
          <div style={{fontSize:11,color:'#94a3b8',marginTop:2}}>Times from OSRM (road network routing), assuming 5 min stop time per location</div>
        </div>
        <div style={{fontSize:28,fontWeight:700,color:region.color}}>{delivered}/{stops.length}</div>
      </div>
      <ProgressBar done={delivered} total={stops.length} color={region.color}/>
      {nextStop&&<div style={{marginTop:12,padding:12,background:'#f8fafc',borderRadius:8}}>
        <div style={{fontSize:11,color:'#94a3b8',textTransform:'uppercase',fontWeight:600,marginBottom:4}}>Next stop</div>
        <div style={{fontWeight:600}}>{nextStop.co}</div>
        <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(nextStop.ad+', '+nextStop.ci+', '+nextStop.st+' '+nextStop.zp)}`}
          target="_blank" rel="noopener" style={{color:'#2563eb',fontSize:13,textDecoration:'none'}}>
          {nextStop.ad}, {nextStop.ci}
        </a>
        {nextStop.ph&&<div style={{marginTop:4}}><a href={`tel:${nextStop.ph}`} style={{color:'#2563eb',fontSize:13,textDecoration:'none'}}>
          {nextStop.ph}</a></div>}
      </div>}
    </div>}

    {/* Stop cards */}
    {stops.length>0?stops.map((s,i)=><div key={s.id}>
      <StopCard stop={s} index={i} onAction={onAction} statuses={statuses} onPhotoUpload={onPhotoUpload}
        onMoveStop={handleMoveStop} moveTargets={moveTargets} currentDay={safeDay} currentDrv={safeDrv}
        highlight={highlightStopId===s.id} driverMode={driverMode}/>
    </div>):
      <div style={{background:'white',borderRadius:12,padding:40,textAlign:'center',color:'#94a3b8',border:'1px solid #e2e8f0'}}>
        No stops for this driver
      </div>}
  </div>;
}
