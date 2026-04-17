// ===== REBALANCING ENGINE =====
const SERVICE_TIME=300;

function getAllStopsForRegion(regionKey){
  const data=ROUTE_DATA[regionKey];
  if(!data)return[];
  return JSON.parse(JSON.stringify(data.days.flatMap(d=>d.routes.flatMap(r=>r.stops))));
}

function geoSort(stops){
  return[...stops].sort((a,b)=>{
    const latDiff=a.lt-b.lt;
    return Math.abs(latDiff)>0.01?latDiff:a.ln-b.ln;
  });
}

function haversineKm(lat1,lon1,lat2,lon2){
  const R=6371;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

async function osrmRouteTimes(coordPairs){
  // coordPairs: [{lt,ln},...] — gets sequential leg times including depot→first
  if(coordPairs.length<2)return[];
  const coords=coordPairs.map(c=>`${c.ln},${c.lt}`).join(';');
  const url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&steps=false`;
  try{
    const resp=await fetch(url);
    const json=await resp.json();
    if(json.code==='Ok'&&json.routes&&json.routes[0]&&json.routes[0].legs){
      return json.routes[0].legs.map(l=>Math.round(l.duration));
    }
  }catch(e){console.warn('OSRM route failed:',e);}
  return null;
}

function assignToNearestDepot(stops,depots){
  const assignments={};
  depots.forEach((_,i)=>assignments[i]=[]);
  stops.forEach(s=>{
    let best=0,bestDist=Infinity;
    depots.forEach((d,i)=>{
      const dist=haversineKm(s.lt,s.ln,d.lat,d.lon);
      if(dist<bestDist){bestDist=dist;best=i;}
    });
    assignments[best].push(s);
  });
  return assignments;
}

async function routeDriverStops(driverStops,depot,onProgress,label){
  // Sort by latitude
  driverStops.sort((a,b)=>b.lt-a.lt);

  // Build coord list: depot first, then stops
  const coordList=depot?[{lt:depot.lat,ln:depot.lon},...driverStops]:driverStops;
  const legTimes=await osrmRouteTimes(coordList);

  const START=8*3600;
  let clock=START;
  let totalDrive=0;
  const legOffset=depot?0:-1; // if depot included, leg[0] = depot→stop1

  driverStops.forEach((s,i)=>{
    let driveTime;
    if(depot&&legTimes&&legTimes.length>=i+1){
      driveTime=legTimes[i]; // leg[0]=depot→s0, leg[1]=s0→s1, etc.
    }else if(!depot&&legTimes&&i>0&&legTimes.length>=i){
      driveTime=legTimes[i-1];
    }else{
      // Fallback
      if(i===0&&depot)driveTime=Math.round(haversineKm(depot.lat,depot.lon,s.lt,s.ln)*1.4/30*3600);
      else if(i===0)driveTime=0;
      else{const p=driverStops[i-1];driveTime=Math.round(haversineKm(p.lt,p.ln,s.lt,s.ln)*1.4/30*3600);}
    }
    s.dt=driveTime;
    clock+=driveTime;
    s.eta=clock;
    totalDrive+=driveTime;
    clock+=SERVICE_TIME;
  });

  if(onProgress)onProgress(label);
  return totalDrive;
}

async function rebalanceRegion(regionKey,numDays,driversPerDay,onProgress,overrideDepots,dayDepotActive){
  const allStops=getAllStopsForRegion(regionKey);
  if(!allStops.length)return null;

  const depots=overrideDepots&&overrideDepots.length>0?overrideDepots:(ROUTE_DATA[regionKey]||{}).depots||[];
  const multiDepot=depots.length>1;

  const sorted=geoSort(allStops);
  const stopsPerDay=Math.ceil(sorted.length/numDays);
  const days=[];

  for(let d=0;d<numDays;d++){
    const dayStops=sorted.slice(d*stopsPerDay,Math.min((d+1)*stopsPerDay,sorted.length));
    if(dayStops.length===0)continue;

    const routes=[];
    let drvIdx=0;
    const activeDepots=[];

    // Determine which depots are active this day
    const dayActiveNames=dayDepotActive&&dayDepotActive[d]?dayDepotActive[d]:null;
    const dayDepots=dayActiveNames?depots.filter(dp=>dayActiveNames.includes(dp.name)):depots;
    const dayMulti=dayDepots.length>1;

    if(dayMulti){
      // Assign stops to nearest ACTIVE depot, then split per-depot into drivers
      const depotAssign=assignToNearestDepot(dayStops,dayDepots);
      for(let di=0;di<dayDepots.length;di++){
        const depStops=depotAssign[di];
        if(!depStops.length)continue;
        activeDepots.push(dayDepots[di].name);
        const depDrivers=Math.max(1,Math.round(driversPerDay*depStops.length/dayStops.length));
        const perDrv=Math.ceil(depStops.length/depDrivers);
        // Sort by longitude for driver split
        depStops.sort((a,b)=>a.ln-b.ln);
        for(let dr=0;dr<depDrivers;dr++){
          const chunk=depStops.slice(dr*perDrv,Math.min((dr+1)*perDrv,depStops.length));
          if(!chunk.length)continue;
          const td=await routeDriverStops(chunk,dayDepots[di],onProgress,`Day ${d+1}, ${DRIVER_NAMES[drvIdx]}...`);
          routes.push({drv:drvIdx,ns:chunk.length,tt:td+chunk.length*SERVICE_TIME,td,depot:dayDepots[di].name,stops:chunk});
          drvIdx++;
        }
      }
    }else{
      // Single depot (or multi-depot day with one active)
      const depot=dayDepots[0]||null;
      if(depot)activeDepots.push(depot.name);
      const daySorted=[...dayStops].sort((a,b)=>a.ln!==b.ln?a.ln-b.ln:a.lt-b.lt);
      const nd=Math.min(driversPerDay,daySorted.length);
      const perDrv=Math.ceil(daySorted.length/nd);
      for(let dr=0;dr<nd;dr++){
        const chunk=daySorted.slice(dr*perDrv,Math.min((dr+1)*perDrv,daySorted.length));
        if(!chunk.length)continue;
        const td=await routeDriverStops(chunk,depot,onProgress,`Day ${d+1}, ${DRIVER_NAMES[drvIdx]}...`);
        routes.push({drv:drvIdx,ns:chunk.length,tt:td+chunk.length*SERVICE_TIME,td,depot:depot?depot.name:'',stops:chunk});
        drvIdx++;
      }
    }

    days.push({day:d+1,nd:routes.filter(r=>r.ns>0).length,routes,depots_active:activeDepots});
  }

  return{
    ts:allStops.length,
    ndays:days.length,
    nd:driversPerDay,
    days,
    depots:depots,
    rebalanced:true
  };
}

// ===== VRP SOLVER (Web Worker-backed rebalancer) =====
//
// Feature flag. Set to false to force the legacy rebalanceRegion path even
// when the worker files are available.
const USE_VRP_SOLVER=true;

// Translate a solver Solution back into the shape ROUTE_DATA expects.
// Input:
//   solution: {days:[{day, routes:[{depotIdx, stopSequence, legTimesSec,
//                                   driveTimeSec, totalTimeSec}]}]}
//   allStops: array of original stop objects (same order as nodes[D..N-1])
//   depots:   array of original depot objects (same order as nodes[0..D-1])
//   D:        number of depots (so stopIdx = globalNodeIdx - D)
// Output: ROUTE_DATA-shaped object.
function adaptVRPSolution(solution,allStops,depots,driversPerDay,D){
  const START=8*3600;
  const outDays=[];
  let totalStopsSeen=0;
  for(const day of solution.days){
    const routes=[];
    const activeNames=new Set();
    let drvIdx=0;
    for(const r of day.routes){
      const depot=depots[r.depotIdx];
      if(!depot)continue;
      activeNames.add(depot.name);
      const stops=[];
      let clock=START;
      for(let i=0;i<r.stopSequence.length;i++){
        const orig=allStops[r.stopSequence[i]-D];
        if(!orig)continue;
        const stop=JSON.parse(JSON.stringify(orig));
        stop.dt=r.legTimesSec[i]||0;
        clock+=stop.dt;
        stop.eta=clock;
        clock+=SERVICE_TIME;
        stops.push(stop);
        totalStopsSeen++;
      }
      if(!stops.length)continue;
      routes.push({
        drv:drvIdx,
        ns:stops.length,
        tt:r.totalTimeSec,
        td:r.driveTimeSec,
        depot:depot.name,
        stops,
      });
      drvIdx++;
    }
    outDays.push({
      day:day.day,
      nd:routes.length,
      routes,
      depots_active:Array.from(activeNames),
    });
  }
  return{
    ts:totalStopsSeen,
    ndays:outDays.length,
    nd:driversPerDay,
    days:outDays,
    depots,
    rebalanced:true,
  };
}

function rebalanceRegionVRP(regionKey,numDays,driversPerDay,onProgress,overrideDepots,dayDepotActive){
  return new Promise((resolve,reject)=>{
    const allStops=getAllStopsForRegion(regionKey);
    if(!allStops.length){resolve(null);return;}
    const depots=overrideDepots&&overrideDepots.length>0?overrideDepots:(ROUTE_DATA[regionKey]||{}).depots||[];
    if(!depots.length){reject(new Error('No depots available for region'));return;}

    // Build nodes: depots first (indices 0..D-1), stops after (D..N-1).
    const D=depots.length;
    const nodes=[
      ...depots.map(d=>({lt:d.lat,ln:d.lon})),
      ...allStops.map(s=>({lt:s.lt,ln:s.ln})),
    ];
    const depotIndices=depots.map((_,i)=>i);
    const stopIndices=allStops.map((_,i)=>D+i);

    // Translate dayDepotActive (names) → per-day arrays of depot node indices.
    const dayActiveDepots=[];
    for(let d=0;d<numDays;d++){
      const names=dayDepotActive&&dayDepotActive[d];
      if(names&&names.length){
        const idxs=[];
        depots.forEach((dp,i)=>{if(names.includes(dp.name))idxs.push(i);});
        dayActiveDepots.push(idxs.length?idxs:depotIndices.slice());
      }else{
        dayActiveDepots.push(depotIndices.slice());
      }
    }

    const requestId=Math.random().toString(36).slice(2);
    let worker;
    try{worker=new Worker('/vrp-worker.js');}
    catch(e){reject(new Error('Worker unavailable: '+e.message));return;}
    let settled=false;
    const cleanup=()=>{settled=true;try{worker.terminate();}catch(_){}};

    worker.onmessage=(e)=>{
      const msg=e.data||{};
      if(msg.requestId!==requestId)return;
      if(msg.type==='progress'){
        if(onProgress)onProgress(msg.message||'Working…');
      }else if(msg.type==='result'){
        if(settled)return;
        cleanup();
        try{resolve(adaptVRPSolution(msg.solution,allStops,depots,driversPerDay,D));}
        catch(err){reject(err);}
      }else if(msg.type==='error'){
        if(settled)return;
        cleanup();
        reject(new Error(msg.message||'VRP solver error'));
      }
    };
    worker.onerror=(e)=>{
      if(settled)return;
      cleanup();
      reject(new Error((e&&e.message)||'VRP worker error'));
    };

    if(onProgress)onProgress('Building distance matrix…');
    worker.postMessage({
      type:'solve',
      requestId,
      payload:{
        nodes,depotIndices,stopIndices,
        numDays,driversPerDay,dayActiveDepots,
        serviceTimeSec:SERVICE_TIME,
        objective:'makespan+total',
        alphaTotal:0.1,
        seed:1,
        timeBudgetMs:6000,
      },
    });
  });
}

// Dispatcher: prefer the VRP solver, fall back to the legacy rebalancer on
// any error (worker unavailable, network failure, etc.). Same signature as
// rebalanceRegion so the call site is unchanged.
async function rebalanceRegionSmart(regionKey,numDays,driversPerDay,onProgress,overrideDepots,dayDepotActive){
  if(USE_VRP_SOLVER&&typeof Worker!=='undefined'){
    try{
      return await rebalanceRegionVRP(regionKey,numDays,driversPerDay,onProgress,overrideDepots,dayDepotActive);
    }catch(e){
      console.warn('VRP solver failed, falling back to legacy rebalancer:',e);
      if(onProgress)onProgress('Solver failed, using legacy rebalancer…');
    }
  }
  return rebalanceRegion(regionKey,numDays,driversPerDay,onProgress,overrideDepots,dayDepotActive);
}
