// ===== DELIVERY AREA DRAW =====
// Map with mapbox-gl-draw polygon tool. Parent passes existing areas as
// GeoJSON features (with `id` = delivery_areas.id) plus callbacks for
// create/update/delete. Invalid (overlapping) polygons turn red and the
// parent is told they're invalid so "Save" can block.
function DeliveryAreaDraw({
  areas,               // [{id,name,geometry}]
  otherBakeryAreas,    // [{id,geometry,bakery_name}]  — read-only, shown for context
  onCreate,            // (featureGeoJSON) => Promise<{id, name}>
  onUpdate,            // (id, featureGeoJSON) => Promise<void>
  onDelete,            // (id) => Promise<void>
  onInvalidChange,     // (hasInvalid) => void
}){
  const mapRef=useRef(null);
  const containerRef=useRef(null);
  const drawRef=useRef(null);
  const[invalidIds,setInvalidIds]=useState(new Set());
  const areasRef=useRef(areas);
  useEffect(()=>{areasRef.current=areas;},[areas]);

  useEffect(()=>{
    if(!containerRef.current||typeof maplibregl==='undefined'||typeof MapboxDraw==='undefined')return;

    let initialCenter=[-81.35,28.6];let initialZoom=9.5;
    const first=areas[0]||otherBakeryAreas[0];
    if(first&&first.geometry&&typeof turf!=='undefined'){
      try{
        const c=turf.centroid({type:'Feature',geometry:first.geometry,properties:{}});
        initialCenter=c.geometry.coordinates;
      }catch(e){}
    }

    const map=new maplibregl.Map({
      container:containerRef.current,
      style:'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
      center:initialCenter, zoom:initialZoom,
    });
    mapRef.current=map;

    const draw=new MapboxDraw({
      displayControlsDefault:false,
      controls:{polygon:true,trash:true},
      userProperties:true,
      styles:drawStyles(),
    });
    drawRef.current=draw;
    map.addControl(draw,'top-left');

    map.on('load',()=>{
      if(otherBakeryAreas&&otherBakeryAreas.length){
        map.addSource('other-bakeries',{
          type:'geojson',
          data:{type:'FeatureCollection',features:otherBakeryAreas.map(a=>({
            type:'Feature',id:a.id,properties:{bakery_name:a.bakery_name||''},geometry:a.geometry,
          }))},
        });
        map.addLayer({id:'other-bakeries-fill',type:'fill',source:'other-bakeries',paint:{'fill-color':'#9ca3af','fill-opacity':0.15}});
        map.addLayer({id:'other-bakeries-line',type:'line',source:'other-bakeries',paint:{'line-color':'#6b7280','line-width':1,'line-dasharray':[2,2]}});
      }

      (areas||[]).forEach(a=>{
        if(!a.geometry)return;
        draw.add({type:'Feature',id:a.id,properties:{name:a.name||'',persisted:true},geometry:a.geometry});
      });
      recomputeInvalids();
    });

    function featuresList(){
      const fc=draw.getAll();return fc.features;
    }

    function recomputeInvalids(){
      const feats=featuresList();
      const bad=new Set();
      for(let i=0;i<feats.length;i++){
        const a=feats[i];
        const others=feats.filter((_,j)=>j!==i).concat(otherBakeryAreas.map(o=>({
          type:'Feature',geometry:o.geometry,properties:{},
        })));
        if(anyOverlap(a,others))bad.add(a.id);
      }
      feats.forEach(f=>draw.setFeatureProperty(f.id,'invalid',bad.has(f.id)?1:0));
      setInvalidIds(bad);
      onInvalidChange&&onInvalidChange(bad.size>0);
    }

    map.on('draw.create',async e=>{
      const f=e.features[0];
      recomputeInvalids();
      const others=featuresList().filter(x=>x.id!==f.id).concat(otherBakeryAreas.map(o=>({type:'Feature',geometry:o.geometry,properties:{}})));
      if(anyOverlap(f,others))return;
      try{
        const created=await onCreate(f);
        draw.setFeatureProperty(f.id,'persisted',1);
        if(created&&created.id){
          draw.delete(f.id);
          draw.add({type:'Feature',id:created.id,properties:{name:created.name||'',persisted:true},geometry:f.geometry});
          recomputeInvalids();
        }
      }catch(err){alert('Save failed: '+err.message);}
    });

    map.on('draw.update',async e=>{
      recomputeInvalids();
      for(const f of e.features){
        const others=featuresList().filter(x=>x.id!==f.id).concat(otherBakeryAreas.map(o=>({type:'Feature',geometry:o.geometry,properties:{}})));
        if(anyOverlap(f,others))continue;
        try{await onUpdate(f.id,f);}catch(err){alert('Save failed: '+err.message);}
      }
    });

    map.on('draw.delete',async e=>{
      for(const f of e.features){
        if(f.properties&&f.properties.persisted){
          try{await onDelete(f.id);}catch(err){alert('Delete failed: '+err.message);}
        }
      }
      recomputeInvalids();
    });

    return ()=>{try{map.remove();}catch(e){}};
  },[]);

  return <div style={{position:'relative',width:'100%',height:'100%'}}>
    <div ref={containerRef} style={{position:'absolute',inset:0}}/>
    {invalidIds.size>0&&<div style={{position:'absolute',bottom:12,left:12,background:'#fef2f2',color:'#991b1b',padding:'8px 12px',borderRadius:6,fontSize:12,border:'1px solid #fecaca'}}>
      {invalidIds.size} area{invalidIds.size===1?'':'s'} overlap — fix before saving.
    </div>}
  </div>;
}

// Red fill for invalid polygons, blue fill otherwise. We drive this through
// feature properties so we don't have to remount the draw instance.
function drawStyles(){
  return [
    // Inactive fill
    {id:'gl-draw-polygon-fill-inactive',type:'fill',filter:['all',['==','active','false'],['==','$type','Polygon'],['!=','mode','static']],
      paint:{'fill-color':['case',['==',['get','user_invalid'],1],'#dc2626','#2563eb'],'fill-opacity':0.2}},
    {id:'gl-draw-polygon-stroke-inactive',type:'line',filter:['all',['==','active','false'],['==','$type','Polygon'],['!=','mode','static']],
      paint:{'line-color':['case',['==',['get','user_invalid'],1],'#dc2626','#2563eb'],'line-width':2}},
    // Active (selected) fill
    {id:'gl-draw-polygon-fill-active',type:'fill',filter:['all',['==','active','true'],['==','$type','Polygon']],
      paint:{'fill-color':['case',['==',['get','user_invalid'],1],'#dc2626','#1e40af'],'fill-opacity':0.25}},
    {id:'gl-draw-polygon-stroke-active',type:'line',filter:['all',['==','active','true'],['==','$type','Polygon']],
      paint:{'line-color':['case',['==',['get','user_invalid'],1],'#dc2626','#1e40af'],'line-width':2,'line-dasharray':[0.2,2]}},
    // Vertices
    {id:'gl-draw-polygon-and-line-vertex-halo',type:'circle',filter:['all',['==','meta','vertex'],['==','$type','Point']],
      paint:{'circle-radius':6,'circle-color':'#ffffff'}},
    {id:'gl-draw-polygon-and-line-vertex',type:'circle',filter:['all',['==','meta','vertex'],['==','$type','Point']],
      paint:{'circle-radius':4,'circle-color':'#1e40af'}},
    // Midpoint
    {id:'gl-draw-polygon-midpoint',type:'circle',filter:['all',['==','$type','Point'],['==','meta','midpoint']],
      paint:{'circle-radius':3,'circle-color':'#1e40af'}},
    // Active line while drawing
    {id:'gl-draw-line-active',type:'line',filter:['all',['==','$type','LineString'],['==','active','true']],
      paint:{'line-color':'#1e40af','line-width':2,'line-dasharray':[0.2,2]}},
  ];
}
