// ===== GEOCODE HELPER =====
async function geocodeAddress(addr){
  const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addr)}&limit=1`;
  try{
    const r=await fetch(url);const j=await r.json();
    if(j&&j[0])return{lat:parseFloat(j[0].lat),lon:parseFloat(j[0].lon),display:j[0].display_name};
  }catch(e){console.warn('Geocode failed:',e);}
  return null;
}
