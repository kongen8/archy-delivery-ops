// ===== STOP CARD (with inline photo capture + move) =====
function StopCard({stop,index,onAction,statuses,onPhotoUpload,onMoveStop,moveTargets,currentDay,currentDrv}){
  const status=statuses[stop.id]||'pending';
  const mapUrl=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.ad+', '+stop.ci+', '+stop.st+' '+stop.zp)}`;
  const isDelivered=status==='delivered';
  const isFailed=status==='failed';
  const hasPhoto=!!statuses[stop.id+'_photo'];
  const fileRef=useRef();
  const[showMove,setShowMove]=useState(false);

  const[uploading,setUploading]=useState(false);
  const handleDone=()=>{fileRef.current.click();};
  const handlePhotoTaken=async(e)=>{
    if(e.target.files&&e.target.files[0]){
      setUploading(true);
      const url=await DB.uploadPhoto(stop.id,e.target.files[0]);
      onPhotoUpload(stop.id,url);
      onAction(stop.id,'delivered');
      setUploading(false);
    }
  };
  const handleFailed=()=>{
    let note=prompt('Why did delivery fail? (required)');
    while(note!==null&&note.trim()===''){
      note=prompt('A reason is required. Why did delivery fail?');
    }
    if(note!==null&&note.trim()!==''){
      onAction(stop.id,'failed',note.trim());
    }
  };

  return <div className={`stop-card ${isDelivered?'delivered':''} ${isFailed?'failed':''}`}
    style={{background:'white',borderRadius:8,padding:'12px 16px',marginBottom:8}}>
    <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{display:'none'}}
      onChange={handlePhotoTaken}/>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
      <div style={{flex:1}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
          <span style={{
            background:isDelivered?'#dcfce7':isFailed?'#fef2f2':'#f1f5f9',
            color:isDelivered?'#16a34a':isFailed?'#dc2626':'#64748b',
            borderRadius:12,padding:'2px 8px',fontSize:12,fontWeight:600,minWidth:24,textAlign:'center'
          }}>{isDelivered?'✓':isFailed?'✕':index+1}</span>
          <span style={{fontWeight:600,fontSize:15,color:'#0f172a'}}>{stop.co}</span>
        </div>
        <a href={mapUrl} target="_blank" rel="noopener"
          style={{color:'#2563eb',fontSize:13,textDecoration:'none',display:'block',marginLeft:32,marginBottom:4}}>
          {stop.ad}, {stop.ci} {stop.zp}
        </a>
        {stop.cn&&<div style={{fontSize:13,color:'#64748b',marginLeft:32}}>
          {stop.cn}
          {stop.ph&&<a href={`tel:${stop.ph}`} style={{color:'#2563eb',marginLeft:8,textDecoration:'none'}}>{stop.ph}</a>}
        </div>}
        {isFailed&&statuses[stop.id+'_note']&&
          <div style={{fontSize:12,color:'#dc2626',marginLeft:32,marginTop:4}}>Reason: {statuses[stop.id+'_note']}</div>}
        {isDelivered&&statuses[stop.id+'_time']&&
          <div style={{fontSize:12,color:'#16a34a',marginLeft:32,marginTop:2}}>Delivered {statuses[stop.id+'_time']}</div>}
        {hasPhoto&&
          <div style={{fontSize:12,color:'#2563eb',marginLeft:32,marginTop:2}}>📷 Proof photo attached</div>}
      </div>
      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:4,marginLeft:12}}>
        <span style={{fontSize:12,color:'#94a3b8'}}>ETA {fmtTime(stop.eta)}</span>
        <span style={{fontSize:11,color:'#cbd5e1'}}>{fmtDuration(stop.dt)} drive</span>
        {status==='pending'&&<div style={{display:'flex',gap:4,marginTop:4}}>
          <button onClick={handleDone}
            style={{background:'#dcfce7',color:'#16a34a',border:'none',borderRadius:6,padding:'4px 8px',fontSize:11,cursor:'pointer',fontWeight:500}}>
            📷 Done</button>
          <button onClick={handleFailed}
            style={{background:'#fef2f2',color:'#dc2626',border:'none',borderRadius:6,padding:'4px 8px',fontSize:11,cursor:'pointer',fontWeight:500}}>
            ✕ Failed</button>
        </div>}
        <button onClick={()=>setShowMove(!showMove)}
          style={{background:showMove?'#e0e7ff':'#f1f5f9',color:showMove?'#4338ca':'#64748b',border:'none',borderRadius:6,padding:'4px 8px',fontSize:11,cursor:'pointer',fontWeight:500,marginTop:2}}>
          {showMove?'Cancel':'Move'}</button>
        {isDelivered&&<button onClick={()=>onAction(stop.id,'pending')}
          style={{background:'#f1f5f9',color:'#94a3b8',border:'none',borderRadius:6,padding:'4px 8px',fontSize:11,cursor:'pointer'}}>
          Undo</button>}
        {isFailed&&<button onClick={()=>onAction(stop.id,'pending')}
          style={{background:'#f1f5f9',color:'#94a3b8',border:'none',borderRadius:6,padding:'4px 8px',fontSize:11,cursor:'pointer'}}>
          Retry</button>}
      </div>
    </div>
    {/* Move picker */}
    {showMove&&moveTargets&&<div style={{marginTop:8,marginLeft:32,padding:12,background:'#f8fafc',borderRadius:8,border:'1px solid #e2e8f0'}}>
      <div style={{fontSize:12,fontWeight:600,color:'#0f172a',marginBottom:8}}>Move to:</div>
      <div style={{display:'flex',flexDirection:'column',gap:4}}>
        {moveTargets.map(t=>{
          const isCurrent=t.day===currentDay&&t.drv===currentDrv;
          return <button key={`${t.day}-${t.drv}`} disabled={isCurrent}
            onClick={()=>{onMoveStop(stop.id,currentDay,currentDrv,t.day,t.drv);setShowMove(false);}}
            style={{
              textAlign:'left',padding:'6px 10px',borderRadius:6,fontSize:12,cursor:isCurrent?'default':'pointer',
              border:'1px solid '+(isCurrent?'#e2e8f0':'#e2e8f0'),
              background:isCurrent?'#f1f5f9':'white',
              color:isCurrent?'#94a3b8':'#0f172a',
              fontWeight:isCurrent?400:500,
              opacity:isCurrent?0.5:1
            }}>
            Day {t.day+1} → {DRIVER_NAMES[t.drv]} ({t.count} stops){isCurrent?' (current)':''}
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
