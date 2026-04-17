// ===== PRINTABLE ROUTE SHEET =====
function PrintSheet({regionKey,dayIndex,routeOverrides}){
  const data=(routeOverrides&&routeOverrides[regionKey])||ROUTE_DATA[regionKey];
  const region=REGIONS[regionKey];
  if(!data||!data.days[dayIndex])return null;
  const dayData=data.days[dayIndex];

  return <div className="print-only" style={{fontFamily:'DM Sans,sans-serif',padding:20}}>
    <h1 style={{fontSize:20,marginBottom:4}}>{region.bakery} — {region.name}</h1>
    <p style={{fontSize:14,color:'#64748b',marginTop:0}}>Day {dayIndex+1} Route Sheet</p>
    {dayData.routes.map(route=>{
      if(route.ns===0)return null;
      return <div key={route.drv} style={{marginBottom:24,pageBreakInside:'avoid'}}>
        <h2 style={{fontSize:16,borderBottom:'2px solid #1e293b',paddingBottom:4}}>
          {DRIVER_NAMES[route.drv]} — {route.ns} stops — Est. {fmtDuration(route.tt)}
        </h2>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
          <thead><tr style={{borderBottom:'1px solid #ccc'}}>
            <th style={{textAlign:'left',padding:4}}>#</th>
            <th style={{textAlign:'left',padding:4}}>ETA</th>
            <th style={{textAlign:'left',padding:4}}>Practice</th>
            <th style={{textAlign:'left',padding:4}}>Address</th>
            <th style={{textAlign:'left',padding:4}}>Contact</th>
            <th style={{textAlign:'left',padding:4}}>Phone</th>
            <th style={{textAlign:'left',padding:4}}>✓</th>
          </tr></thead>
          <tbody>{route.stops.map((s,i)=>
            <tr key={s.id} style={{borderBottom:'1px solid #eee'}}>
              <td style={{padding:4}}>{i+1}</td>
              <td style={{padding:4}}>{fmtTime(s.eta)}</td>
              <td style={{padding:4,fontWeight:500}}>{s.co}</td>
              <td style={{padding:4}}>{s.ad}, {s.ci}</td>
              <td style={{padding:4}}>{s.cn}</td>
              <td style={{padding:4}}>{s.ph}</td>
              <td style={{padding:4}}>☐</td>
            </tr>
          )}</tbody>
        </table>
      </div>;
    })}
  </div>;
}

