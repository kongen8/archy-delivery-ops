// ===== CUSTOMER (ARCHY) VIEW =====
function CustomerView({statuses,routeOverrides}){
  const regionStats=useMemo(()=>{
    const stats={};
    for(const[key,config]of Object.entries(REGIONS)){
      const data=routeOverrides[key]||ROUTE_DATA[key];
      if(!data)continue;
      const allStops=data.days.flatMap(d=>d.routes.flatMap(r=>r.stops));
      const done=allStops.filter(s=>(statuses[s.id]||'pending')==='delivered').length;
      const failed=allStops.filter(s=>(statuses[s.id]||'pending')==='failed').length;
      stats[key]={total:allStops.length,done,failed,config,data};
    }
    return stats;
  },[statuses,routeOverrides]);

  const allStops=Object.keys(REGIONS).map(k=>routeOverrides[k]||ROUTE_DATA[k]).filter(Boolean).flatMap(d=>d.days.flatMap(dd=>dd.routes.flatMap(r=>r.stops)));
  const totalDone=allStops.filter(s=>(statuses[s.id]||'pending')==='delivered').length;
  const totalFailed=allStops.filter(s=>(statuses[s.id]||'pending')==='failed').length;

  // Flatten every stop with full route context so the EOD sheet has Region/Day/Driver/Depot
  // alongside the practice info the Archy team needs to match against HubSpot.
  const buildExportRows=()=>{
    const rows=[];
    for(const regionKey of Object.keys(REGIONS)){
      const cfg=REGIONS[regionKey];
      const data=routeOverrides[regionKey]||ROUTE_DATA[regionKey];
      if(!data)continue;
      data.days.forEach(d=>{
        d.routes.forEach((r,rIdx)=>{
          r.stops.forEach((s,sIdx)=>{
            const st=statuses[s.id]||'pending';
            rows.push({
              stopId:s.id,
              practice:s.co||'',
              contact:s.cn||'',
              phone:s.ph||'',
              address:s.ad||'',
              city:s.ci||'',
              state:s.st||'',
              zip:s.zp||'',
              region:cfg.name,
              bakery:cfg.bakery||'',
              depot:r.depot||'',
              day:d.day||'',
              driver:DRIVER_NAMES[r.drv]||`Driver ${r.drv+1}`,
              stopOrder:sIdx+1,
              scheduledEta:s.eta?fmtTime(s.eta):'',
              status:st,
              statusNote:statuses[s.id+'_note']||'',
              deliveredAt:fmtDeliveredAtForSheet(statuses[s.id+'_delivered_at'])||statuses[s.id+'_time']||'',
              photoUrl:statuses[s.id+'_photo']||'',
              latitude:s.lt,
              longitude:s.ln,
              hubspotOwner:'',
              followUpNotes:''
            });
          });
        });
      });
    }
    return rows;
  };

  const csvEscape=v=>{
    if(v===null||v===undefined)return'';
    const s=String(v);
    return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
  };

  const exportCSV=()=>{
    const rows=buildExportRows();
    const headers=[
      ['stopId','Stop ID'],
      ['practice','Practice Name'],
      ['contact','Contact'],
      ['phone','Phone'],
      ['address','Address'],
      ['city','City'],
      ['state','State'],
      ['zip','Zip'],
      ['region','Region'],
      ['bakery','Bakery'],
      ['depot','Depot'],
      ['day','Day'],
      ['driver','Driver'],
      ['stopOrder','Stop #'],
      ['scheduledEta','Scheduled ETA'],
      ['status','Status'],
      ['statusNote','Status Note'],
      ['deliveredAt','Delivered At'],
      ['photoUrl','Photo URL'],
      ['latitude','Latitude'],
      ['longitude','Longitude'],
      ['hubspotOwner','HubSpot Owner'],
      ['followUpNotes','Follow-up Notes']
    ];
    const lines=[headers.map(h=>csvEscape(h[1])).join(',')];
    rows.forEach(r=>{
      lines.push(headers.map(h=>csvEscape(r[h[0]])).join(','));
    });
    const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=`archy-eod-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();URL.revokeObjectURL(url);
  };

  return <div>
    <div style={{background:'white',borderRadius:12,padding:24,marginBottom:20,border:'1px solid #e2e8f0'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div>
          <h2 style={{fontSize:20,fontWeight:700,margin:0}}>Archy × Daymaker</h2>
          <span style={{fontSize:14,color:'#64748b'}}>Delivery campaign progress</span>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:32,fontWeight:700}}>{totalDone}</div>
          <div style={{fontSize:13,color:'#64748b'}}>of {allStops.length} delivered</div>
        </div>
      </div>
      <ProgressBar done={totalDone} total={allStops.length}/>
      <div style={{display:'flex',justifyContent:'space-between',marginTop:8}}>
        <span style={{fontSize:12,color:'#94a3b8'}}>{Math.round(totalDone/allStops.length*100)}% complete{totalFailed>0?` · ${totalFailed} failed`:''}</span>
        <button onClick={exportCSV} className="no-print"
          title="Full practice list with address, contact, status & a blank HubSpot Owner column for assigning follow-up."
          style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:6,padding:'4px 12px',fontSize:12,cursor:'pointer',fontWeight:500}}>
          ↓ Export EOD Spreadsheet
        </button>
      </div>
    </div>

    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12,marginBottom:20}}>
      {Object.entries(regionStats).map(([key,stat])=>
        <div key={key} style={{background:'white',borderRadius:12,padding:16,border:'1px solid #e2e8f0',transition:'all .15s'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
            <div>
              <div style={{fontWeight:600,fontSize:15}}>{stat.config.name}</div>
              <div style={{fontSize:12,color:'#64748b'}}>{stat.config.bakery} · {stat.data.ndays} days · {stat.data.nd} drivers</div>
            </div>
            <div style={{fontSize:20,fontWeight:700,color:stat.config.color}}>{stat.done}/{stat.total}</div>
          </div>
          <ProgressBar done={stat.done} total={stat.total} color={stat.config.color}/>
          <div style={{fontSize:12,color:'#94a3b8',marginTop:4}}>
            {stat.total-stat.done-stat.failed} remaining{stat.failed>0?` · ${stat.failed} need retry`:''}
          </div>
        </div>
      )}
    </div>

    {/* Failed deliveries needing retry */}
    {totalFailed>0&&<div style={{background:'white',borderRadius:12,padding:16,marginBottom:16,border:'1px solid #fecaca'}}>
      <h3 style={{fontSize:15,fontWeight:600,margin:'0 0 12px',color:'#dc2626'}}>Failed deliveries — need retry ({totalFailed})</h3>
      {allStops.filter(s=>(statuses[s.id]||'pending')==='failed').map(s=>
        <div key={s.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid #fef2f2'}}>
          <div>
            <span style={{fontWeight:500,fontSize:14}}>{s.co}</span>
            <span style={{fontSize:12,color:'#94a3b8',marginLeft:8}}>{s.ci}</span>
            {statuses[s.id+'_note']&&<div style={{fontSize:12,color:'#dc2626'}}>Note: {statuses[s.id+'_note']}</div>}
          </div>
          <span style={{color:'#dc2626',fontSize:12,fontWeight:500}}>✕ Failed</span>
        </div>
      )}
    </div>}

    {/* Recent deliveries */}
    {totalDone>0&&<div style={{background:'white',borderRadius:12,padding:16,border:'1px solid #e2e8f0'}}>
      <h3 style={{fontSize:15,fontWeight:600,margin:'0 0 12px'}}>Recent deliveries</h3>
      {allStops.filter(s=>(statuses[s.id]||'pending')==='delivered').slice(-15).reverse().map(s=>
        <div key={s.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid #f1f5f9'}}>
          <div>
            <span style={{fontWeight:500,fontSize:14}}>{s.co}</span>
            <span style={{fontSize:12,color:'#94a3b8',marginLeft:8}}>{s.ci}</span>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            {statuses[s.id+'_photo']&&<span style={{fontSize:12}}>📷</span>}
            <span style={{color:'#16a34a',fontSize:12,fontWeight:500}}>✓ Delivered</span>
          </div>
        </div>
      )}
    </div>}
  </div>;
}
