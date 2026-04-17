// ===== OSRM road geometry — returns array of [lng, lat] pairs =====
// Successful polylines are cached forever. We intentionally do NOT cache
// failures so transient network errors or rate-limits can self-heal on the
// next render instead of permanently locking us into straight lines.
// In-flight requests are deduped via _geomInflight so repeated renders of the
// same route don't flood the public OSRM demo server.
const _geomCache=new Map();      // cacheKey -> lngLat[][]
const _geomInflight=new Map();   // cacheKey -> Promise<lngLat[][]|null>
function _osrmKey(coordPairs){
  return coordPairs.map(c=>`${c.lt.toFixed(5)},${c.ln.toFixed(5)}`).join('|');
}
async function _osrmFetchFull(coordPairs,signal){
  const coords=coordPairs.map(c=>`${c.ln},${c.lt}`).join(';');
  const url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const resp=await fetch(url,signal?{signal}:undefined);
  if(!resp.ok)throw new Error(`OSRM ${resp.status}`);
  const json=await resp.json();
  if(json.code==='Ok'&&json.routes&&json.routes[0]&&json.routes[0].geometry){
    return json.routes[0].geometry.coordinates; // [[lng,lat],...]
  }
  throw new Error('OSRM no route');
}
async function osrmLegGeometry(a,b,signal){
  const pair=[a,b];
  const key=_osrmKey(pair);
  if(_geomCache.has(key))return _geomCache.get(key);
  if(_geomInflight.has(key))return _geomInflight.get(key).catch(()=>null);
  const p=(async()=>{
    try{
      const lngLat=await _osrmFetchFull(pair,signal);
      _geomCache.set(key,lngLat);
      return lngLat;
    }catch(e){
      if(e&&e.name==='AbortError')throw e;
      return null; // don't cache — retry next time
    }
  })();
  _geomInflight.set(key,p);
  try{return await p;}
  catch(e){if(e&&e.name==='AbortError')return null;return null;}
  finally{_geomInflight.delete(key);}
}
async function osrmRouteGeometry(coordPairs,signal){
  if(!coordPairs||coordPairs.length<2)return null;
  const key=_osrmKey(coordPairs);
  if(_geomCache.has(key))return _geomCache.get(key);
  if(_geomInflight.has(key))return _geomInflight.get(key).catch(()=>null);
  const p=(async()=>{
    // Try the single multi-stop request first (fewer API hits, richer geometry)
    try{
      const lngLat=await _osrmFetchFull(coordPairs,signal);
      _geomCache.set(key,lngLat);
      return lngLat;
    }catch(e){
      if(e&&e.name==='AbortError')throw e;
      // Fallback: fetch each leg independently and concatenate whatever succeeds.
      // A single failed leg degrades to a straight line for that segment only,
      // instead of collapsing the entire route to straight lines.
      const out=[];
      let anyLeg=false;
      for(let i=0;i<coordPairs.length-1;i++){
        const seg=await osrmLegGeometry(coordPairs[i],coordPairs[i+1],signal);
        if(seg&&seg.length){
          anyLeg=true;
          if(out.length)seg.shift(); // avoid duplicating shared endpoint
          out.push(...seg);
        }else{
          // straight-line this leg only
          if(!out.length)out.push([coordPairs[i].ln,coordPairs[i].lt]);
          out.push([coordPairs[i+1].ln,coordPairs[i+1].lt]);
        }
      }
      if(anyLeg){
        _geomCache.set(key,out);
        return out;
      }
      return null;
    }
  })();
  _geomInflight.set(key,p);
  try{return await p;}
  catch(e){if(e&&e.name==='AbortError')return null;return null;}
  finally{_geomInflight.delete(key);}
}
