function MapView({regionKey,statuses,routeOverrides,depotOverrides}){
  const region=REGIONS[regionKey];
  const data=(routeOverrides&&routeOverrides[regionKey])||ROUTE_DATA[regionKey];
  const effectiveDepots=(depotOverrides&&depotOverrides[regionKey])||(data&&data.depots)||[];

  const[selDay,setDay]=useState(0);
  const[selDrv,setDrv]=useState(0);
  const[mode,setMode]=useState('all'); // 'all' | 'active'
  const[renderTick,setRenderTick]=useState(0);

  useEffect(()=>{setDay(0);setDrv(0);},[regionKey]);

  const dayCount=data?data.days.length:0;
  const safeDay=dayCount?Math.min(selDay,dayCount-1):0;
  const dayData=data?data.days[safeDay]:null;
  const drvCount=dayData?dayData.routes.length:0;
  const safeDrv=drvCount?Math.min(selDrv,drvCount-1):0;
  const activeRoute=dayData&&dayData.routes[safeDrv];

  const shellRef=useRef(null);
  const mapContainer=useRef(null);
  const mapRef=useRef(null);
  const styleReadyRef=useRef(false);
  const lastFitKeyRef=useRef(null);

  // Differential-update refs (stop id -> marker state). Lets us update only the
  // markers whose status changed instead of rebuilding the whole DOM tree.
  const activeMarkersRef=useRef(new Map());   // stopId -> {marker, status, stopNumber, color}
  const depotMarkersRef=useRef(new Map());    // depotKey -> marker

  // Route FeatureCollection lives in a ref so async OSRM resolutions can mutate
  // it without relying on MapLibre's undocumented src._data.
  const routeFCRef=useRef({type:'FeatureCollection',features:[]});
  const inactiveFCRef=useRef({type:'FeatureCollection',features:[]});
  const activePinsFCRef=useRef({type:'FeatureCollection',features:[]});

  // Generation counter + AbortController for OSRM fetches. Stale resolutions
  // from previous selections are dropped instead of overwriting current routes.
  const osrmGenRef=useRef(0);
  const osrmAbortRef=useRef(null);

  // Region center (recomputed on region or data change)
  const regionCenter=useMemo(()=>{
    const stops=data?data.days.flatMap(d=>d.routes.flatMap(r=>r.stops||[])).filter(s=>s&&typeof s.lt==='number'&&typeof s.ln==='number'):[];
    if(stops.length>0){
      return[stops.reduce((a,s)=>a+s.ln,0)/stops.length,stops.reduce((a,s)=>a+s.lt,0)/stops.length];
    }
    return REGION_CENTERS[regionKey]||[-122.42,37.78];
  },[regionKey,data]);

  // Create / teardown the map when region changes
  useEffect(()=>{
    if(!mapContainer.current||typeof maplibregl==='undefined')return;
    styleReadyRef.current=false;
    lastFitKeyRef.current=null;

    const map=new maplibregl.Map({
      container: mapContainer.current,
      style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
      center: regionCenter,
      zoom: 11.95,
      pitch: 54,
      bearing: -24,
      minZoom: 9.5,
      maxZoom: 15.8,
      attributionControl: false,
      renderWorldCopies: false,
    });
    mapRef.current=map;

    map.addControl(new maplibregl.AttributionControl({compact:true}),'bottom-right');
    map.addControl(new maplibregl.NavigationControl({visualizePitch:true}),'bottom-right');

    // Pause any marker animation while the user is moving/zooming the map.
    const onMoveStart=()=>{
      if(shellRef.current)shellRef.current.classList.add('cake-moving');
    };
    const onMoveEnd=()=>{
      if(shellRef.current)shellRef.current.classList.remove('cake-moving');
    };
    map.on('movestart',onMoveStart);
    map.on('zoomstart',onMoveStart);
    map.on('moveend',onMoveEnd);
    map.on('zoomend',onMoveEnd);

    // Ground-plane scaling for DOM markers. Cakes are HTML elements; without
    // this they render at constant screen-pixel size, so zooming out makes
    // the map tiles shrink while the cake stays the same size — the cake
    // appears to balloon relative to its surroundings. We compute a scale
    // factor from the current zoom (softened exponent so it doesn't get
    // absurd at the extremes, then clamped) and write it as a CSS variable
    // on the shell. The CSS rule applies it to every marker wrapper with
    // transform-origin: bottom center so the pedestal stays glued to the
    // projected lnglat while the cake visually grows / shrinks with zoom.
    const REF_ZOOM=12;
    const SCALE_EXP=0.55;
    const SCALE_MIN=0.35;
    const SCALE_MAX=2.2;
    const applyCakeScale=()=>{
      if(!shellRef.current)return;
      const z=map.getZoom();
      const raw=Math.pow(2,(z-REF_ZOOM)*SCALE_EXP);
      const s=Math.max(SCALE_MIN,Math.min(SCALE_MAX,raw));
      shellRef.current.style.setProperty('--cake-scale',s.toFixed(4));
    };
    map.on('zoom',applyCakeScale);
    applyCakeScale();

    map.on('style.load',()=>{
      applyCakeStyle(map);
      addCakeBuildings(map);

      // Offset cloud positions relative to region center (CLOUD_CONFIGS are authored for SF)
      const SF_ORIGIN=[-122.42,37.78];
      const dLng=regionCenter[0]-SF_ORIGIN[0];
      const dLat=regionCenter[1]-SF_ORIGIN[1];
      CLOUD_CONFIGS.forEach(c=>{c.lng+=dLng;c.lat+=dLat;});
      addWhippedCreamClouds(map);
      addSprinkles(map);
      CLOUD_CONFIGS.forEach(c=>{c.lng-=dLng;c.lat-=dLat;});

      // Route layers — insert just under the first label layer so lines sit
      // above roads but under place/POI text. Each route is drawn as a cream
      // casing + a colored inner stroke. The cream casing provides contrast
      // against the chocolate-recolored road network so the driver colors pop.
      const beforeId=routeInsertBeforeId(map);
      if(!map.getSource('routes')){
        map.addSource('routes',{type:'geojson',data:routeFCRef.current});

        // Inactive casing (cream halo under the dashed colored line)
        map.addLayer({
          id:'routes-inactive-casing',
          type:'line',
          source:'routes',
          filter:['!=',['get','active'],true],
          paint:{
            'line-color':'#fff8e7',
            'line-width':['interpolate',['linear'],['zoom'],10,3,13,5,16,7.5],
            'line-opacity':0.85,
          },
          layout:{'line-cap':'round','line-join':'round'},
        },beforeId);
        map.addLayer({
          id:'routes-inactive',
          type:'line',
          source:'routes',
          filter:['!=',['get','active'],true],
          paint:{
            'line-color':['get','color'],
            'line-width':['interpolate',['linear'],['zoom'],10,1.6,13,3,16,4.5],
            'line-opacity':0.85,
            'line-dasharray':[3,3],
          },
          layout:{'line-cap':'round','line-join':'round'},
        },beforeId);

        // Active casing (cream halo) under the driver-colored inner line
        map.addLayer({
          id:'routes-active-casing',
          type:'line',
          source:'routes',
          filter:['==',['get','active'],true],
          paint:{
            'line-color':'#fff8e7',
            'line-width':['interpolate',['linear'],['zoom'],10,6,13,11,16,16],
            'line-opacity':1,
          },
          layout:{'line-cap':'round','line-join':'round'},
        },beforeId);
        // Thin dark cocoa stroke right under the driver color for a crisp pixel-art edge
        map.addLayer({
          id:'routes-active-edge',
          type:'line',
          source:'routes',
          filter:['==',['get','active'],true],
          paint:{
            'line-color':'#4e342e',
            'line-width':['interpolate',['linear'],['zoom'],10,4.5,13,8,16,12],
            'line-opacity':1,
          },
          layout:{'line-cap':'round','line-join':'round'},
        },beforeId);
        map.addLayer({
          id:'routes-active',
          type:'line',
          source:'routes',
          filter:['==',['get','active'],true],
          paint:{
            'line-color':['get','color'],
            'line-width':['interpolate',['linear'],['zoom'],10,3,13,5.5,16,9.5],
            'line-opacity':1,
          },
          layout:{'line-cap':'round','line-join':'round'},
        },beforeId);
      }
      if(!map.getSource('inactive-stops')){
        map.addSource('inactive-stops',{type:'geojson',data:inactiveFCRef.current});
        map.addLayer({
          id:'inactive-stops-layer',
          type:'circle',
          source:'inactive-stops',
          paint:{
            'circle-radius':['interpolate',['linear'],['zoom'],10,3,15,6],
            'circle-color':['get','color'],
            'circle-stroke-color':'#fff8e7',
            'circle-stroke-width':1.5,
            'circle-opacity':0.92,
            'circle-pitch-alignment':'map',
          },
        },beforeId);
      }
      // Ground-truth anchor pins for ACTIVE-driver stops. Rendered on the map
      // plane (pitch-aligned) so they sit flat on the ground regardless of
      // camera tilt, giving the user an unambiguous "this is the real stop
      // location" marker beneath each cupcake.
      if(!map.getSource('active-stops-pins')){
        map.addSource('active-stops-pins',{type:'geojson',data:activePinsFCRef.current});
        map.addLayer({
          id:'active-stops-pin-halo',
          type:'circle',
          source:'active-stops-pins',
          paint:{
            'circle-radius':['interpolate',['linear'],['zoom'],10,7,15,11],
            'circle-color':'#fff8e7',
            'circle-stroke-color':'#4e342e',
            'circle-stroke-width':1.5,
            'circle-opacity':0.95,
            'circle-pitch-alignment':'map',
          },
        },beforeId);
        map.addLayer({
          id:'active-stops-pin-dot',
          type:'circle',
          source:'active-stops-pins',
          paint:{
            'circle-radius':['interpolate',['linear'],['zoom'],10,4,15,7],
            'circle-color':['get','color'],
            'circle-stroke-color':'#4e342e',
            'circle-stroke-width':1.2,
            'circle-opacity':1,
            'circle-pitch-alignment':'map',
          },
        },beforeId);
      }

      styleReadyRef.current=true;
      setRenderTick(t=>t+1); // trigger the render effect once the map is ready
    });

    return ()=>{
      // Cancel any in-flight OSRM fetches and drop all markers before the map dies.
      if(osrmAbortRef.current){try{osrmAbortRef.current.abort();}catch(e){}osrmAbortRef.current=null;}
      osrmGenRef.current++;
      activeMarkersRef.current.forEach(({marker})=>marker.remove());
      activeMarkersRef.current.clear();
      depotMarkersRef.current.forEach(m=>m.remove());
      depotMarkersRef.current.clear();
      routeFCRef.current={type:'FeatureCollection',features:[]};
      inactiveFCRef.current={type:'FeatureCollection',features:[]};
      activePinsFCRef.current={type:'FeatureCollection',features:[]};
      map.off('movestart',onMoveStart);
      map.off('zoomstart',onMoveStart);
      map.off('moveend',onMoveEnd);
      map.off('zoomend',onMoveEnd);
      map.remove();
      mapRef.current=null;
      styleReadyRef.current=false;
    };
  },[regionKey]); // recreate when region switches

  // --------------------------------------------------------------------------
  // EFFECT A — "geometry": routes, inactive dots, active-stop ground pins,
  //   OSRM road geometry, and viewport fit. Deliberately does NOT depend on
  //   `statuses`, so toggling a delivery to Done/Failed never re-aborts
  //   in-flight OSRM requests. That was the main reason routes stayed as
  //   straight lines — a single status flip killed the road fetch mid-air.
  // --------------------------------------------------------------------------
  useEffect(()=>{
    const map=mapRef.current;
    if(!map||!styleReadyRef.current)return;

    // Bump generation and cancel in-flight OSRM fetches from a previous
    // selection (region/day/driver/mode change).
    if(osrmAbortRef.current){try{osrmAbortRef.current.abort();}catch(e){}}
    const ac=(typeof AbortController!=='undefined')?new AbortController():null;
    osrmAbortRef.current=ac;
    const gen=++osrmGenRef.current;

    if(!dayData){
      routeFCRef.current={type:'FeatureCollection',features:[]};
      inactiveFCRef.current={type:'FeatureCollection',features:[]};
      activePinsFCRef.current={type:'FeatureCollection',features:[]};
      const rs=map.getSource('routes');if(rs)rs.setData(routeFCRef.current);
      const is=map.getSource('inactive-stops');if(is)is.setData(inactiveFCRef.current);
      const ap=map.getSource('active-stops-pins');if(ap)ap.setData(activePinsFCRef.current);
      return;
    }

    const showRoutes=mode==='active'&&dayData.routes[safeDrv]
      ?[{r:dayData.routes[safeDrv],idx:safeDrv}]
      :dayData.routes.map((r,idx)=>({r,idx})).filter(x=>x.r&&x.r.stops&&x.r.stops.length>0);

    const routeFeatures=[];
    const inactiveStopFeatures=[];
    const activePinFeatures=[];
    const bounds=new maplibregl.LngLatBounds();
    const fitBoundsActive=new maplibregl.LngLatBounds();

    showRoutes.forEach(({r,idx})=>{
      if(!r.stops||r.stops.length===0)return;
      const color=driverColor(r.drv!==undefined?r.drv:idx);
      const isActive=idx===safeDrv;
      const depotObj=effectiveDepots.find(d=>d.name===r.depot)||effectiveDepots[0];
      const coordPairs=(depotObj&&typeof depotObj.lat==='number')
        ?[{lt:depotObj.lat,ln:depotObj.lon},...r.stops]
        :r.stops.map(s=>({lt:s.lt,ln:s.ln}));

      const straight=coordPairs.map(c=>[c.ln,c.lt]);
      const featureId=`route_${safeDay}_${idx}`;
      routeFeatures.push({
        type:'Feature',
        id:featureId,
        properties:{color,active:isActive,idx},
        geometry:{type:'LineString',coordinates:straight},
      });
      straight.forEach(c=>{bounds.extend(c);if(isActive)fitBoundsActive.extend(c);});

      // Async OSRM upgrade. A stale resolution (from an abandoned render) is
      // ignored via the gen counter.
      osrmRouteGeometry(coordPairs,ac?ac.signal:undefined).then(lngLat=>{
        if(!lngLat||!lngLat.length)return;
        if(gen!==osrmGenRef.current)return;
        const src=map.getSource('routes');if(!src)return;
        const feat=routeFCRef.current.features.find(f=>f.id===featureId);
        if(!feat)return;
        feat.geometry.coordinates=lngLat;
        src.setData(routeFCRef.current);
      });

      if(isActive){
        r.stops.forEach((s,i)=>{
          activePinFeatures.push({
            type:'Feature',
            properties:{color,n:i+1},
            geometry:{type:'Point',coordinates:[s.ln,s.lt]},
          });
          bounds.extend([s.ln,s.lt]);
          fitBoundsActive.extend([s.ln,s.lt]);
        });
      }else{
        r.stops.forEach(s=>{
          inactiveStopFeatures.push({
            type:'Feature',
            properties:{color,idx},
            geometry:{type:'Point',coordinates:[s.ln,s.lt]},
          });
          bounds.extend([s.ln,s.lt]);
        });
      }
    });

    effectiveDepots.forEach(dp=>{
      if(typeof dp.lat==='number'&&typeof dp.lon==='number')bounds.extend([dp.lon,dp.lat]);
    });

    routeFCRef.current={type:'FeatureCollection',features:routeFeatures};
    inactiveFCRef.current={type:'FeatureCollection',features:inactiveStopFeatures};
    activePinsFCRef.current={type:'FeatureCollection',features:activePinFeatures};
    const rs=map.getSource('routes');if(rs)rs.setData(routeFCRef.current);
    const is=map.getSource('inactive-stops');if(is)is.setData(inactiveFCRef.current);
    const ap=map.getSource('active-stops-pins');if(ap)ap.setData(activePinsFCRef.current);

    // Re-fit only when selection/mode/region changes; skip on pure data churn.
    const fitKey=`${regionKey}|${safeDay}|${safeDrv}|${mode}`;
    if(lastFitKeyRef.current!==fitKey){
      const fitBox=(mode==='active'&&!fitBoundsActive.isEmpty())?fitBoundsActive:bounds;
      if(!fitBox.isEmpty()){
        const camOpts={padding:{top:70,bottom:70,left:50,right:50},maxZoom:13.5,duration:700};
        if(lastFitKeyRef.current===null){camOpts.pitch=54;camOpts.bearing=-24;}
        try{map.fitBounds(fitBox,camOpts);}catch(e){}
      }
      lastFitKeyRef.current=fitKey;
    }
  },[renderTick,regionKey,safeDay,safeDrv,mode,data,depotOverrides]);

  // --------------------------------------------------------------------------
  // EFFECT B — "markers": DOM cupcake + depot markers. Reacts to `statuses`
  //   so status flips refresh cake colors/labels without disturbing OSRM.
  // --------------------------------------------------------------------------
  useEffect(()=>{
    const map=mapRef.current;
    if(!map||!styleReadyRef.current)return;

    if(!dayData){
      activeMarkersRef.current.forEach(({marker})=>marker.remove());
      activeMarkersRef.current.clear();
      depotMarkersRef.current.forEach(m=>m.remove());
      depotMarkersRef.current.clear();
      return;
    }

    const activeRouteObj=dayData.routes[safeDrv];
    const desiredActiveStops=new Map();
    if(activeRouteObj&&activeRouteObj.stops){
      const color=driverColor(activeRouteObj.drv!==undefined?activeRouteObj.drv:safeDrv);
      activeRouteObj.stops.forEach((s,i)=>{
        const rawStatus=statuses[s.id]||'pending';
        const status=['delivered','failed','pending','in-transit'].includes(rawStatus)?rawStatus:'pending';
        desiredActiveStops.set(s.id,{stop:s,stopNumber:i+1,color,status});
      });
    }

    // Remove cupcakes whose stopId is no longer in the active route.
    activeMarkersRef.current.forEach((info,stopId)=>{
      if(!desiredActiveStops.has(stopId)){
        info.marker.remove();
        activeMarkersRef.current.delete(stopId);
      }
    });
    // Add / update. A cupcake is rebuilt only if status / stopNumber / color /
    // company-name changes. Positions update in place.
    desiredActiveStops.forEach((d,stopId)=>{
      const existing=activeMarkersRef.current.get(stopId);
      const co=d.stop.co||'';
      const needsRebuild=!existing||existing.status!==d.status||existing.stopNumber!==d.stopNumber||existing.color!==d.color||existing.co!==co;
      const popupHTML=`
        <div style="font-family:'Courier New',monospace;padding:6px 10px;background:#fff5f5;color:#4e342e;border:3px solid #4e342e;font-size:12px;border-radius:4px;box-shadow:3px 3px 0 #4e342e;">
          <strong style="color:#e91e63;">#${d.stopNumber} · ${co}</strong><br/>
          <span style="font-size:10px;">${d.stop.ad||''}</span><br/>
          <span style="font-size:10px;color:#5d4037;">ETA ${d.stop.eta?fmtTime(d.stop.eta):'—'} · ${d.status.toUpperCase()}</span>
        </div>`;
      if(needsRebuild){
        if(existing)existing.marker.remove();
        const cake=createDeliveryMarker({name:co,status:d.status});
        const el=withStopNumber(cake,d.stopNumber,d.color,co);
        const popup=new maplibregl.Popup({offset:16,closeButton:false,className:'cake-popup'}).setHTML(popupHTML);
        // Offset [0,0]: the wrapper's LAYOUT bottom is now the liner base (the
        // shadow is absolute), so anchor:'bottom' pins the liner directly to
        // the lng/lat at every scale. The ground-pin circle layer sits right
        // under the liner as the true stop marker.
        const marker=new maplibregl.Marker({element:el,anchor:'bottom',offset:[0,0]})
          .setLngLat([d.stop.ln,d.stop.lt]).setPopup(popup).addTo(map);
        activeMarkersRef.current.set(stopId,{marker,status:d.status,stopNumber:d.stopNumber,color:d.color,co});
      }else{
        existing.marker.setLngLat([d.stop.ln,d.stop.lt]);
        const popup=existing.marker.getPopup();
        if(popup)popup.setHTML(popupHTML);
      }
    });

    const desiredDepots=new Map();
    effectiveDepots.forEach(dp=>{
      if(typeof dp.lat!=='number'||typeof dp.lon!=='number')return;
      const key=`${dp.name}|${dp.lat.toFixed(5)}|${dp.lon.toFixed(5)}`;
      desiredDepots.set(key,dp);
    });
    depotMarkersRef.current.forEach((m,k)=>{
      if(!desiredDepots.has(k)){m.remove();depotMarkersRef.current.delete(k);}
    });
    desiredDepots.forEach((dp,k)=>{
      if(depotMarkersRef.current.has(k))return;
      const el=createDepotMarker(dp);
      const popup=new maplibregl.Popup({offset:16,closeButton:false,className:'cake-popup'})
        .setHTML(`
          <div style="font-family:'Courier New',monospace;padding:6px 10px;background:#fff8e7;color:#4e342e;border:3px solid #4e342e;font-size:12px;border-radius:4px;box-shadow:3px 3px 0 #4e342e;">
            <strong style="color:#5d4037;">${dp.name||''}</strong><br/>
            <span style="font-size:10px;">${dp.addr||''}</span>
          </div>
        `);
      const m=new maplibregl.Marker({element:el,anchor:'bottom',offset:[0,0]})
        .setLngLat([dp.lon,dp.lat]).setPopup(popup).addTo(map);
      depotMarkersRef.current.set(k,m);
    });
  },[renderTick,regionKey,safeDay,safeDrv,mode,data,depotOverrides,statuses]);

  if(!data){
    return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>No data for this region</div>;
  }

  const activeDrvLabel=activeRoute?DRIVER_NAMES[activeRoute.drv!==undefined?activeRoute.drv:safeDrv]:'—';
  const activeDepotLabel=activeRoute&&activeRoute.depot?shortDepot(activeRoute.depot):'';

  return <div>
    {/* Day pills */}
    <div style={{display:'flex',gap:6,marginBottom:8,flexWrap:'wrap'}} className="no-print">
      {data.days.map((d,i)=>{
        const ds=d.routes.flatMap(r=>r.stops||[]);
        const dd=ds.filter(s=>(statuses[s.id]||'pending')==='delivered').length;
        return <button key={i} className={`pill ${safeDay===i?'active':''}`} onClick={()=>{setDay(i);setDrv(0);}}>
          Day {i+1} <span style={{opacity:.7}}>{dd}/{ds.length}</span>
        </button>;
      })}
    </div>

    {/* Driver pills (color-coded) */}
    <div style={{display:'flex',gap:6,marginBottom:8,flexWrap:'wrap'}} className="no-print">
      {dayData&&dayData.routes.map((r,i)=>{
        if(!r.stops||r.stops.length===0)return null;
        const color=driverColor(r.drv!==undefined?r.drv:i);
        const dd=r.stops.filter(s=>(statuses[s.id]||'pending')==='delivered').length;
        const isActive=safeDrv===i;
        return <button key={i} onClick={()=>setDrv(i)} className="pill"
          style={isActive
            ?{background:color,color:'#fff',borderColor:color,boxShadow:`2px 2px 0 ${CAKE.OL}`}
            :{borderLeft:`4px solid ${color}`}}>
          <span>{DRIVER_NAMES[r.drv!==undefined?r.drv:i]}</span>
          <span style={{opacity:.8,marginLeft:4}}>{dd}/{r.stops.length}</span>
          {effectiveDepots.length>1&&r.depot&&<span style={{display:'block',fontSize:10,opacity:.7,marginTop:1}}>{shortDepot(r.depot)}</span>}
        </button>;
      })}
    </div>

    {/* Mode toggle + active driver summary */}
    <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap',alignItems:'center'}} className="no-print">
      <button className={`pill ${mode==='all'?'active':''}`} onClick={()=>setMode('all')}>All drivers</button>
      <button className={`pill ${mode==='active'?'active':''}`} onClick={()=>setMode('active')}>Active only</button>
      {activeRoute&&<span style={{fontSize:12,color:'#64748b',marginLeft:'auto'}}>
        {activeDrvLabel} · {activeRoute.stops.length} stops · {fmtDuration(activeRoute.tt||0)}{activeDepotLabel?` · from ${activeDepotLabel}`:''}
      </span>}
    </div>

    <div className="cake-map-shell" ref={shellRef}>
      <div id="cake-map" ref={mapContainer}/>
    </div>
  </div>;
}
