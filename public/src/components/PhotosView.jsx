// ===== PHOTO DATABANK VIEW =====
function PhotosView({routeOverrides}){
  const [photos,setPhotos]=useState(null);
  const [regionFilter,setRegionFilter]=useState('all');
  const [search,setSearch]=useState('');
  const [lightbox,setLightbox]=useState(null);
  const [zipping,setZipping]=useState(false);
  const [zipProgress,setZipProgress]=useState(0);
  const [refreshing,setRefreshing]=useState(false);

  const loadPhotos=useCallback(()=>{
    if(!DB.ready){setPhotos([]);return;}
    setRefreshing(true);
    DB.loadAllPhotos().then(rows=>{
      setPhotos(rows||[]);
      setRefreshing(false);
    });
  },[]);

  useEffect(()=>{loadPhotos();},[loadPhotos]);

  // Build an index of stopId -> {co, ad, ci, st, zp, cn, region}
  const stopIndex=useMemo(()=>{
    const idx={};
    Object.keys(REGIONS).forEach(rk=>{
      const data=(routeOverrides&&routeOverrides[rk])||ROUTE_DATA[rk];
      if(!data||!data.days)return;
      data.days.forEach(day=>day.routes.forEach(rt=>rt.stops.forEach(s=>{
        idx[s.id]={...s,region:rk};
      })));
    });
    return idx;
  },[routeOverrides]);

  const enriched=useMemo(()=>{
    if(!photos)return null;
    return photos.map(p=>{
      const stop=stopIndex[p.id]||{};
      // Fallback: infer region from stop id prefix (before first underscore)
      let region=stop.region;
      if(!region){
        const parts=p.id.split('_');
        if(REGIONS[parts[0]])region=parts[0];
      }
      return {...p,stop,region:region||'Unknown'};
    });
  },[photos,stopIndex]);

  const filtered=useMemo(()=>{
    if(!enriched)return [];
    let list=enriched;
    if(regionFilter!=='all')list=list.filter(p=>p.region===regionFilter);
    if(search.trim()){
      const q=search.trim().toLowerCase();
      list=list.filter(p=>(p.stop.co||'').toLowerCase().includes(q)
        ||(p.stop.ci||'').toLowerCase().includes(q)
        ||(p.stop.cn||'').toLowerCase().includes(q)
        ||p.id.toLowerCase().includes(q));
    }
    return list;
  },[enriched,regionFilter,search]);

  const regionCounts=useMemo(()=>{
    const counts={};
    (enriched||[]).forEach(p=>{counts[p.region]=(counts[p.region]||0)+1;});
    return counts;
  },[enriched]);

  const safeFileName=(photo)=>{
    const base=(photo.stop.co||photo.id).replace(/[^a-z0-9]+/gi,'_').replace(/^_|_$/g,'');
    const ext=((photo.photo_url||'').split('?')[0].split('.').pop()||'jpg').toLowerCase();
    return `${base}__${photo.id}.${ext.length<=5?ext:'jpg'}`;
  };

  const downloadOne=async(photo)=>{
    try{
      const resp=await fetch(photo.photo_url);
      if(!resp.ok)throw new Error('fetch failed');
      const blob=await resp.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      a.download=safeFileName(photo);
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1500);
    }catch(e){
      console.warn('Download failed, opening in new tab:',e);
      window.open(photo.photo_url,'_blank');
    }
  };

  const downloadAll=async()=>{
    if(!filtered.length)return;
    if(typeof JSZip==='undefined'){
      for(const p of filtered){await downloadOne(p);await new Promise(r=>setTimeout(r,200));}
      return;
    }
    setZipping(true);setZipProgress(0);
    try{
      const zip=new JSZip();
      let done=0;
      await Promise.all(filtered.map(async(p)=>{
        try{
          const resp=await fetch(p.photo_url);
          if(!resp.ok)throw new Error('fetch failed');
          const blob=await resp.blob();
          const folder=p.region||'Unknown';
          zip.file(`${folder}/${safeFileName(p)}`,blob);
        }catch(e){console.warn('zip add failed',p.id,e);}
        done++;setZipProgress(Math.round(done/filtered.length*100));
      }));
      const blob=await zip.generateAsync({type:'blob'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      const suffix=regionFilter==='all'?'all':regionFilter.replace(/\s+/g,'_');
      a.download=`delivery-photos-${suffix}-${new Date().toISOString().slice(0,10)}.zip`;
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),2000);
    }finally{setZipping(false);setZipProgress(0);}
  };

  const fmtWhen=(iso)=>{
    if(!iso)return '';
    const d=new Date(iso);
    return d.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})+' · '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  };

  if(!DB.ready){
    return <div style={{padding:24,textAlign:'center',color:'#64748b',fontSize:14}}>
      Photo databank is only available when connected to Supabase.
    </div>;
  }
  if(photos===null){
    return <div style={{padding:24,textAlign:'center',color:'#64748b',fontSize:14}}>Loading photos…</div>;
  }

  return <div>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12,alignItems:'center'}}>
      <input type="text" placeholder="Search practice, city, contact, or stop ID..."
        value={search} onChange={e=>setSearch(e.target.value)}
        style={{flex:'1 1 260px',minWidth:200,padding:'8px 12px',border:'1px solid #e2e8f0',borderRadius:8,fontSize:13,outline:'none'}}/>
      <button onClick={loadPhotos} disabled={refreshing}
        title="Refresh"
        style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:8,padding:'8px 12px',fontSize:13,cursor:'pointer',fontWeight:500}}>
        {refreshing?'↻ Loading...':'↻ Refresh'}
      </button>
      <button onClick={downloadAll} disabled={!filtered.length||zipping}
        style={{background:filtered.length&&!zipping?'#1e293b':'#cbd5e1',color:'#fff',border:'none',borderRadius:8,padding:'8px 14px',fontSize:13,cursor:filtered.length&&!zipping?'pointer':'not-allowed',fontWeight:500}}>
        {zipping?`Zipping… ${zipProgress}%`:`⬇ Download ${filtered.length} photo${filtered.length===1?'':'s'}`}
      </button>
    </div>

    <div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap'}}>
      <button onClick={()=>setRegionFilter('all')}
        className={`pill ${regionFilter==='all'?'active':''}`}>
        All ({(enriched||[]).length})
      </button>
      {Object.entries(REGIONS).map(([k,c])=>{
        const n=regionCounts[k]||0;
        if(!n)return null;
        return <button key={k} onClick={()=>setRegionFilter(k)}
          className={`pill ${regionFilter===k?'active':''}`}
          style={regionFilter===k?{background:c.color,borderColor:c.color}:{}}>
          {c.name} ({n})
        </button>;
      })}
      {regionCounts['Unknown']&&
        <button onClick={()=>setRegionFilter('Unknown')}
          className={`pill ${regionFilter==='Unknown'?'active':''}`}>
          Unknown ({regionCounts['Unknown']})
        </button>}
    </div>

    {filtered.length===0 ? (
      <div style={{padding:40,textAlign:'center',color:'#94a3b8',fontSize:14,border:'1px dashed #e2e8f0',borderRadius:12}}>
        📷 No delivery photos {regionFilter==='all'&&!search?'have been uploaded yet':'match your filters'}.
      </div>
    ) : (
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:10}}>
        {filtered.map(p=>{
          const regionColor=REGIONS[p.region]?.color||'#64748b';
          return <div key={p.id} style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,overflow:'hidden',display:'flex',flexDirection:'column'}}>
            <button onClick={()=>setLightbox(p)}
              style={{padding:0,border:'none',background:'#f1f5f9',cursor:'zoom-in',display:'block',aspectRatio:'1/1',overflow:'hidden'}}>
              <img src={p.photo_url} alt={p.stop.co||p.id} loading="lazy"
                style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}}/>
            </button>
            <div style={{padding:'8px 10px',flex:1,display:'flex',flexDirection:'column',gap:3}}>
              <div style={{fontSize:12,fontWeight:600,lineHeight:1.3,color:'#0f172a',overflow:'hidden',textOverflow:'ellipsis',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>
                {p.stop.co||p.id}
              </div>
              {p.stop.ci&&<div style={{fontSize:11,color:'#64748b'}}>{p.stop.ci}</div>}
              <div style={{display:'flex',alignItems:'center',gap:4,marginTop:2}}>
                <span style={{display:'inline-block',width:6,height:6,borderRadius:3,background:regionColor}}/>
                <span style={{fontSize:10,color:'#64748b'}}>{REGIONS[p.region]?.name||p.region}</span>
              </div>
              {p.delivered_at&&<div style={{fontSize:10,color:'#94a3b8'}}>{fmtWhen(p.delivered_at)}</div>}
              <button onClick={()=>downloadOne(p)}
                style={{marginTop:4,background:'#f1f5f9',color:'#475569',border:'none',borderRadius:6,padding:'5px 8px',fontSize:11,cursor:'pointer',fontWeight:500}}>
                ⬇ Download
              </button>
            </div>
          </div>;
        })}
      </div>
    )}

    {lightbox&&<div onClick={()=>setLightbox(null)}
      style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.9)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20,cursor:'zoom-out'}}>
      <div onClick={e=>e.stopPropagation()}
        style={{maxWidth:'min(900px,95vw)',maxHeight:'95vh',background:'#fff',borderRadius:12,overflow:'hidden',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid #e2e8f0',display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:14,fontWeight:600,color:'#0f172a',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
              {lightbox.stop.co||lightbox.id}
            </div>
            <div style={{fontSize:12,color:'#64748b'}}>
              {lightbox.stop.ad?`${lightbox.stop.ad}, ${lightbox.stop.ci||''}`:lightbox.id}
              {lightbox.delivered_at&&<span> · {fmtWhen(lightbox.delivered_at)}</span>}
            </div>
          </div>
          <div style={{display:'flex',gap:6,flexShrink:0}}>
            <button onClick={()=>downloadOne(lightbox)}
              style={{background:'#1e293b',color:'#fff',border:'none',borderRadius:6,padding:'6px 12px',fontSize:12,cursor:'pointer',fontWeight:500}}>
              ⬇ Download
            </button>
            <button onClick={()=>setLightbox(null)}
              style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:6,padding:'6px 12px',fontSize:12,cursor:'pointer',fontWeight:500}}>
              ✕ Close
            </button>
          </div>
        </div>
        <div style={{background:'#0f172a',display:'flex',alignItems:'center',justifyContent:'center',overflow:'auto',flex:1}}>
          <img src={lightbox.photo_url} alt={lightbox.stop.co||lightbox.id}
            style={{maxWidth:'100%',maxHeight:'80vh',display:'block'}}/>
        </div>
      </div>
    </div>}
  </div>;
}
