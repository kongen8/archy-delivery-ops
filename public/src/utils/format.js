// ===== FORMATTING HELPERS =====
function driverColor(i){return DRIVER_COLORS[((i%DRIVER_COLORS.length)+DRIVER_COLORS.length)%DRIVER_COLORS.length];}
function fmtTime(seconds){
  const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60);
  const ampm=h>=12?'PM':'AM',h12=h>12?h-12:h===0?12:h;
  return `${h12}:${m.toString().padStart(2,'0')} ${ampm}`;
}
function fmtDuration(seconds){
  const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60);
  return h>0?`${h}h ${m}m`:`${m}m`;
}
// Short depot label (e.g. "SmallCakes - Lake Mary" → "Lake Mary")
function shortDepot(name){
  if(!name)return'';
  const parts=name.split(' - ');
  return parts.length>1?parts[parts.length-1]:name;
}
// EOD / CSV: local calendar date + time so spreadsheets show which day (not hour-only).
function fmtDeliveredAtForSheet(iso){
  if(!iso)return'';
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return'';
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  const h=String(d.getHours()).padStart(2,'0');
  const min=String(d.getMinutes()).padStart(2,'0');
  return `${y}-${m}-${day} ${h}:${min}`;
}
