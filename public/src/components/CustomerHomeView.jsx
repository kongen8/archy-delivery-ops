// ===== CUSTOMER HOME VIEW =====
// Read-only per-campaign dashboard. Plan 3 wires the "Upload campaign" CTA.
// Each count pill on a campaign card is clickable: it pops a modal listing
// the recipients in that bucket so customers can investigate (and, for the
// Flagged bucket, copy addresses out to ask another bakery for coverage).
function CustomerHomeView({customerId}){
  const[state,setState]=useState({loading:true,customer:null,campaigns:[],counts:{},progress:{},err:''});
  const[detail,setDetail]=useState(null); // {campaign, bucket}

  const reload=useCallback(async()=>{
    try{
      if(!sb){setState(s=>({...s,err:'Supabase not configured',loading:false}));return;}
      const{customer,campaigns}=await Admin.getCustomer(customerId);
      const counts={};const progress={};
      for(const camp of campaigns){
        const[{data:recips},{data:stats}]=await Promise.all([
          sb.from('recipients').select('assignment_status').eq('campaign_id',camp.id),
          sb.from('delivery_statuses_v2').select('status,recipients!inner(campaign_id)').eq('recipients.campaign_id',camp.id),
        ]);
        const countsByStatus={assigned:0,flagged_out_of_area:0,geocode_failed:0,needs_review:0};
        (recips||[]).forEach(r=>{countsByStatus[r.assignment_status]=(countsByStatus[r.assignment_status]||0)+1;});
        counts[camp.id]=countsByStatus;
        const total=(recips||[]).length;
        const delivered=(stats||[]).filter(s=>s.status==='delivered').length;
        progress[camp.id]={total,delivered};
      }
      setState({loading:false,customer,campaigns,counts,progress,err:''});
    }catch(e){setState(s=>({...s,err:e.message||String(e),loading:false}));}
  },[customerId]);

  useEffect(()=>{reload();},[reload]);

  const{loading,customer,campaigns,counts,progress,err}=state;
  if(loading)return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>Loading…</div>;
  if(err)return <div style={{padding:40,color:'#991b1b'}}>Failed: {err}</div>;

  return <div className="app-shell">
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{customer.name}</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}>Campaigns · Delivery progress</span>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <button className="btn-primary" onClick={()=>navigate('#/customer/'+customerId+'/upload/new')}>+ Upload campaign</button>
        <ProfileSwitcher/>
      </div>
    </div>

    {campaigns.length===0?<div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>No campaigns yet.</div>:
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        {campaigns.map(c=><CampaignCard key={c.id} campaign={c} customerId={customerId} counts={counts[c.id]} progress={progress[c.id]} onPillClick={(bucket)=>setDetail({campaign:c,bucket})} onDeleted={reload}/>)}
      </div>
    }

    {detail&&<RecipientBucketModal
      campaign={detail.campaign}
      initialBucket={detail.bucket}
      onClose={()=>{setDetail(null);reload();}}
    />}
  </div>;
}

function CampaignCard({campaign,customerId,counts,progress,onPillClick,onDeleted}){
  const[deleting,setDeleting]=useState(false);
  const[deleteErr,setDeleteErr]=useState('');
  const[exporting,setExporting]=useState(false);
  const[exportErr,setExportErr]=useState('');
  const[photosOpen,setPhotosOpen]=useState(false);
  const pct=progress&&progress.total?Math.round(100*progress.delivered/progress.total):0;
  // Drafts open the wizard so customers can resume; active campaigns stay
  // on the dashboard but the count pills below are now drill-ins.
  const isDraft=campaign.status==='draft';
  const onCardClick=isDraft?()=>navigate('#/customer/'+customerId+'/upload/'+campaign.id):undefined;
  // Clicks on pills/buttons must not bubble up to the card-level draft handler.
  const stop=e=>e.stopPropagation();

  async function handleDelete(e){
    e.stopPropagation();
    if(deleting)return;
    if(!confirm('Delete draft campaign "'+campaign.name+'"? Recipients will be removed.'))return;
    setDeleting(true);setDeleteErr('');
    try{
      await Customer.deleteDraftCampaign(campaign.id);
      onDeleted&&onDeleted();
    }catch(err){
      setDeleteErr(err.message||String(err));
      setDeleting(false);
    }
  }

  async function handleExport(e){
    e.stopPropagation();
    if(exporting)return;
    setExporting(true);setExportErr('');
    try{
      await exportCampaignEodCsv(campaign);
    }catch(err){
      setExportErr(err.message||String(err));
    }
    setExporting(false);
  }

  function handleOpenPhotos(e){
    e.stopPropagation();
    setPhotosOpen(true);
  }

  return <div onClick={onCardClick} style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,padding:16,cursor:onCardClick?'pointer':'default',opacity:deleting?0.5:1}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
      <div style={{fontWeight:600}}>{campaign.name}</div>
      <div style={{display:'flex',alignItems:'center',gap:12}}>
        <div style={{fontSize:11,color:'#6b7280',textTransform:'uppercase',letterSpacing:'0.05em'}}>{campaign.status}</div>
        {isDraft&&<button onClick={handleDelete} disabled={deleting} style={{background:'none',border:'none',padding:0,color:'#6b7280',fontSize:12,cursor:deleting?'default':'pointer',textDecoration:'underline'}}>{deleting?'Deleting…':'Delete'}</button>}
      </div>
    </div>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}} onClick={stop}>
      <CountPill label="Assigned"      n={counts?.assigned||0}            color="#2563eb" onClick={()=>onPillClick('assigned')}/>
      <CountPill label="Flagged"       n={counts?.flagged_out_of_area||0} color="#dc2626" onClick={()=>onPillClick('flagged_out_of_area')}/>
      <CountPill label="Geocode failed" n={counts?.geocode_failed||0}     color="#f59e0b" onClick={()=>onPillClick('geocode_failed')}/>
      <CountPill label="Needs review"  n={counts?.needs_review||0}        color="#7c3aed" onClick={()=>onPillClick('needs_review')}/>
    </div>
    <div style={{fontSize:12,color:'#6b7280',marginBottom:4}}>Delivered {progress?.delivered||0} of {progress?.total||0} ({pct}%)</div>
    <div style={{background:'#f3f4f6',height:6,borderRadius:3,overflow:'hidden'}}>
      <div style={{width:`${pct}%`,height:'100%',background:'#10b981',transition:'width 0.2s'}}></div>
    </div>
    {!isDraft&&<div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:10}} onClick={stop}>
      <button
        onClick={handleExport}
        disabled={exporting}
        title="Full practice list with address, contact, bakery, status & delivery photo URL."
        style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:6,padding:'5px 10px',fontSize:12,cursor:exporting?'default':'pointer',fontWeight:500}}>
        {exporting?'Exporting…':'↓ Export EOD Spreadsheet'}
      </button>
      <button
        onClick={handleOpenPhotos}
        title="View every delivery photo uploaded for this campaign across all bakeries."
        style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:6,padding:'5px 10px',fontSize:12,cursor:'pointer',fontWeight:500}}>
        📷 Delivery photos
      </button>
    </div>}
    {exportErr&&<div style={{marginTop:6,fontSize:12,color:'#991b1b'}}>{exportErr}</div>}
    {deleteErr&&<div style={{marginTop:8,fontSize:12,color:'#991b1b'}}>{deleteErr}</div>}
    {photosOpen&&<CampaignPhotosModal campaign={campaign} onClose={()=>setPhotosOpen(false)}/>}
  </div>;
}

// ===== EOD spreadsheet export =====
// Pulls recipients (with their bakery) and delivery_statuses_v2 rows for the
// given campaign and emits one CSV row per recipient. Matches the legacy
// Archy EOD columns the customer team uses to reconcile against HubSpot,
// plus the bakery assignment that multi-bakery campaigns introduced.
async function exportCampaignEodCsv(campaign){
  if(!sb)throw new Error('Supabase not configured');
  const[recipients,statuses]=await Promise.all([
    Customer.listRecipients(campaign.id),
    DB2.loadStatuses(campaign.id),
  ]);
  const photoMap={};
  for(const[k,v]of Object.entries(statuses||{})){
    if(k.endsWith('_photo'))photoMap[k.slice(0,-6)]=v;
  }
  const noteMap={};
  for(const[k,v]of Object.entries(statuses||{})){
    if(k.endsWith('_note'))noteMap[k.slice(0,-5)]=v;
  }
  const timeMap={};
  for(const[k,v]of Object.entries(statuses||{})){
    if(k.endsWith('_time'))timeMap[k.slice(0,-5)]=v;
  }
  const statusFor=id=>statuses[id]||'pending';

  const headers=[
    ['company','Practice Name'],
    ['contact_name','Contact'],
    ['phone','Phone'],
    ['email','Email'],
    ['address','Address'],
    ['city','City'],
    ['state','State'],
    ['zip','Zip'],
    ['bakery','Bakery'],
    ['assignment_status','Assignment Status'],
    ['delivery_status','Delivery Status'],
    ['delivered_at','Delivered At'],
    ['status_note','Status Note'],
    ['photo_url','Photo URL'],
    ['recipient_notes','Recipient Notes'],
    ['latitude','Latitude'],
    ['longitude','Longitude'],
    ['hubspot_owner','HubSpot Owner'],
    ['follow_up_notes','Follow-up Notes'],
  ];
  const esc=v=>{
    if(v===null||v===undefined)return'';
    const s=String(v);
    return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
  };
  const lines=[headers.map(h=>esc(h[1])).join(',')];
  recipients.forEach(r=>{
    const row={
      company:r.company||'',
      contact_name:r.contact_name||'',
      phone:r.phone||'',
      email:r.email||'',
      address:r.address||'',
      city:r.city||'',
      state:r.state||'',
      zip:r.zip||'',
      bakery:r.bakery?.name||'',
      assignment_status:r.assignment_status||'',
      delivery_status:statusFor(r.id),
      delivered_at:timeMap[r.id]||'',
      status_note:noteMap[r.id]||'',
      photo_url:photoMap[r.id]||'',
      recipient_notes:r.notes||'',
      latitude:r.lat??'',
      longitude:r.lon??'',
      hubspot_owner:'',
      follow_up_notes:'',
    };
    lines.push(headers.map(h=>esc(row[h[0]])).join(','));
  });
  const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const safe=(campaign.name||'campaign').replace(/[^a-z0-9]+/gi,'_').replace(/^_|_$/g,'');
  const a=document.createElement('a');
  a.href=url;
  a.download=`${safe}-eod-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}

// ===== Per-campaign delivery-photo modal =====
// Lightweight cousin of PhotosView. Pulls every photo Supabase has for this
// campaign, shows a filmstrip grouped by bakery with search, and lets the
// customer download a single image or a zipped bundle of the current filter.
function CampaignPhotosModal({campaign,onClose}){
  const[photos,setPhotos]=useState(null);
  const[bakeryFilter,setBakeryFilter]=useState('all');
  const[search,setSearch]=useState('');
  const[lightbox,setLightbox]=useState(null);
  const[zipping,setZipping]=useState(false);
  const[zipProgress,setZipProgress]=useState(0);
  const[err,setErr]=useState('');

  // Recipient lookup so we can show company + bakery on each tile even
  // though the JOIN on delivery_statuses_v2 only gives us company/city.
  const[recipientIndex,setRecipientIndex]=useState({});

  const load=useCallback(async()=>{
    setErr('');
    try{
      const[rows,recips]=await Promise.all([
        DB2.loadAllPhotos(campaign.id),
        Customer.listRecipients(campaign.id),
      ]);
      const idx={};
      (recips||[]).forEach(r=>{idx[r.id]=r;});
      setRecipientIndex(idx);
      setPhotos(rows||[]);
    }catch(e){setErr(e.message||String(e));setPhotos([]);}
  },[campaign.id]);

  useEffect(()=>{load();},[load]);

  useEffect(()=>{
    const onKey=e=>{if(e.key==='Escape')onClose();};
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[onClose]);

  const enriched=useMemo(()=>{
    if(!photos)return null;
    return photos.map(p=>{
      const r=recipientIndex[p.recipient_id]||{};
      return {
        ...p,
        company:r.company||p.company||'',
        city:r.city||p.city||'',
        address:r.address||'',
        bakery_id:r.bakery_id||null,
        bakery_name:r.bakery?.name||'',
      };
    });
  },[photos,recipientIndex]);

  const bakeryOptions=useMemo(()=>{
    const m=new Map();
    (enriched||[]).forEach(p=>{
      const key=p.bakery_id||'_unassigned';
      const label=p.bakery_name||'Unassigned';
      const entry=m.get(key)||{key,label,count:0};
      entry.count++;
      m.set(key,entry);
    });
    return Array.from(m.values()).sort((a,b)=>b.count-a.count);
  },[enriched]);

  const filtered=useMemo(()=>{
    if(!enriched)return[];
    let list=enriched;
    if(bakeryFilter!=='all'){
      list=list.filter(p=>(p.bakery_id||'_unassigned')===bakeryFilter);
    }
    if(search.trim()){
      const q=search.trim().toLowerCase();
      list=list.filter(p=>
        (p.company||'').toLowerCase().includes(q)
        ||(p.city||'').toLowerCase().includes(q)
        ||(p.address||'').toLowerCase().includes(q)
        ||(p.bakery_name||'').toLowerCase().includes(q)
      );
    }
    return list;
  },[enriched,bakeryFilter,search]);

  const safeFileName=p=>{
    const base=(p.company||p.recipient_id||'photo').replace(/[^a-z0-9]+/gi,'_').replace(/^_|_$/g,'');
    const ext=((p.photo_url||'').split('?')[0].split('.').pop()||'jpg').toLowerCase();
    return `${base}__${p.recipient_id}.${ext.length<=5?ext:'jpg'}`;
  };

  const downloadOne=async(p)=>{
    try{
      const resp=await fetch(p.photo_url);
      if(!resp.ok)throw new Error('fetch failed');
      const blob=await resp.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download=safeFileName(p);
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1500);
    }catch(e){
      console.warn('download failed, opening in new tab',e);
      window.open(p.photo_url,'_blank');
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
          const folder=(p.bakery_name||'Unassigned').replace(/[^a-z0-9]+/gi,'_');
          zip.file(`${folder}/${safeFileName(p)}`,blob);
        }catch(e){console.warn('zip add failed',p.recipient_id,e);}
        done++;setZipProgress(Math.round(done/filtered.length*100));
      }));
      const blob=await zip.generateAsync({type:'blob'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      const safe=(campaign.name||'campaign').replace(/[^a-z0-9]+/gi,'_').replace(/^_|_$/g,'');
      const suffix=bakeryFilter==='all'?'all':(bakeryOptions.find(b=>b.key===bakeryFilter)?.label||'bakery').replace(/[^a-z0-9]+/gi,'_');
      a.download=`${safe}-photos-${suffix}-${new Date().toISOString().slice(0,10)}.zip`;
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),2000);
    }finally{setZipping(false);setZipProgress(0);}
  };

  const fmtWhen=iso=>{
    if(!iso)return'';
    const d=new Date(iso);
    return d.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})+' · '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  };

  return <div className="cropper-backdrop" onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:'#fff',borderRadius:12,width:'100%',maxWidth:960,maxHeight:'calc(100vh - 48px)',display:'flex',flexDirection:'column',overflow:'hidden'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'14px 20px',borderBottom:'1px solid #e5e7eb'}}>
        <div>
          <div style={{fontSize:14,fontWeight:700}}>{campaign.name}</div>
          <div style={{fontSize:12,color:'#6b7280'}}>Delivery photos · all bakeries</div>
        </div>
        <button onClick={onClose} className="btn-ghost" style={{padding:'4px 10px',fontSize:18,lineHeight:1}}>×</button>
      </div>

      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',padding:'12px 20px',borderBottom:'1px solid #f1f5f9'}}>
        <input type="text" placeholder="Search practice, city, bakery…"
          value={search} onChange={e=>setSearch(e.target.value)}
          style={{flex:'1 1 240px',minWidth:180,padding:'6px 10px',border:'1px solid #e2e8f0',borderRadius:8,fontSize:13,outline:'none'}}/>
        <button onClick={downloadAll} disabled={!filtered.length||zipping}
          style={{background:filtered.length&&!zipping?'#1e293b':'#cbd5e1',color:'#fff',border:'none',borderRadius:8,padding:'7px 12px',fontSize:12,cursor:filtered.length&&!zipping?'pointer':'not-allowed',fontWeight:500}}>
          {zipping?`Zipping… ${zipProgress}%`:`⬇ Download ${filtered.length} photo${filtered.length===1?'':'s'}`}
        </button>
      </div>

      {bakeryOptions.length>1&&<div style={{display:'flex',gap:6,flexWrap:'wrap',padding:'8px 20px',borderBottom:'1px solid #f1f5f9'}}>
        <button onClick={()=>setBakeryFilter('all')} className={`pill ${bakeryFilter==='all'?'active':''}`}>
          All ({(enriched||[]).length})
        </button>
        {bakeryOptions.map(b=>
          <button key={b.key} onClick={()=>setBakeryFilter(b.key)}
            className={`pill ${bakeryFilter===b.key?'active':''}`}>
            {b.label} ({b.count})
          </button>
        )}
      </div>}

      {err&&<div className="wizard-err" style={{margin:'12px 20px'}}>{err}</div>}

      <div style={{padding:'16px 20px',overflowY:'auto',flex:1}}>
        {photos===null?(
          <div style={{padding:24,color:'#9ca3af',textAlign:'center'}}>Loading photos…</div>
        ):filtered.length===0?(
          <div style={{padding:40,textAlign:'center',color:'#94a3b8',fontSize:14,border:'1px dashed #e2e8f0',borderRadius:12}}>
            📷 No delivery photos {bakeryFilter==='all'&&!search?'have been uploaded yet for this campaign':'match your filters'}.
          </div>
        ):(
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:10}}>
            {filtered.map(p=>
              <div key={p.recipient_id} style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,overflow:'hidden',display:'flex',flexDirection:'column'}}>
                <button onClick={()=>setLightbox(p)}
                  style={{padding:0,border:'none',background:'#f1f5f9',cursor:'zoom-in',display:'block',aspectRatio:'1/1',overflow:'hidden'}}>
                  <img src={p.photo_url} alt={p.company||p.recipient_id} loading="lazy"
                    style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}}/>
                </button>
                <div style={{padding:'8px 10px',flex:1,display:'flex',flexDirection:'column',gap:3}}>
                  <div style={{fontSize:12,fontWeight:600,lineHeight:1.3,color:'#0f172a',overflow:'hidden',textOverflow:'ellipsis',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>
                    {p.company||'(no company)'}
                  </div>
                  {p.city&&<div style={{fontSize:11,color:'#64748b'}}>{p.city}</div>}
                  {p.bakery_name&&<div style={{fontSize:10,color:'#15803d',fontWeight:500}}>→ {p.bakery_name}</div>}
                  {p.delivered_at&&<div style={{fontSize:10,color:'#94a3b8'}}>{fmtWhen(p.delivered_at)}</div>}
                  <button onClick={()=>downloadOne(p)}
                    style={{marginTop:4,background:'#f1f5f9',color:'#475569',border:'none',borderRadius:6,padding:'5px 8px',fontSize:11,cursor:'pointer',fontWeight:500}}>
                    ⬇ Download
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    {lightbox&&<div onClick={()=>setLightbox(null)}
      style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.9)',zIndex:1100,display:'flex',alignItems:'center',justifyContent:'center',padding:20,cursor:'zoom-out'}}>
      <div onClick={e=>e.stopPropagation()}
        style={{maxWidth:'min(900px,95vw)',maxHeight:'95vh',background:'#fff',borderRadius:12,overflow:'hidden',display:'flex',flexDirection:'column'}}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid #e2e8f0',display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:14,fontWeight:600,color:'#0f172a',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
              {lightbox.company||lightbox.recipient_id}
            </div>
            <div style={{fontSize:12,color:'#64748b'}}>
              {lightbox.address?`${lightbox.address}${lightbox.city?', '+lightbox.city:''}`:lightbox.city||''}
              {lightbox.bakery_name&&<span> · {lightbox.bakery_name}</span>}
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
          <img src={lightbox.photo_url} alt={lightbox.company||lightbox.recipient_id}
            style={{maxWidth:'100%',maxHeight:'80vh',display:'block'}}/>
        </div>
      </div>
    </div>}
  </div>;
}

function CountPill({label,n,color,onClick}){
  const clickable=!!onClick&&n>0;
  return <button
    type="button"
    onClick={clickable?onClick:undefined}
    disabled={!clickable}
    title={clickable?`View ${n} ${label.toLowerCase()}`:`No ${label.toLowerCase()} recipients`}
    style={{
      display:'flex',alignItems:'center',gap:6,padding:'3px 10px',borderRadius:999,
      background:`${color}15`,color,fontSize:12,fontWeight:500,
      border:'1px solid transparent',fontFamily:'inherit',
      cursor:clickable?'pointer':'default',opacity:clickable?1:0.6,
    }}
    onMouseEnter={e=>{if(clickable)e.currentTarget.style.borderColor=color;}}
    onMouseLeave={e=>{e.currentTarget.style.borderColor='transparent';}}
  >
    <span>{n}</span><span style={{opacity:0.7}}>{label}</span>
  </button>;
}

// ===== Per-bucket recipient drill-in modal =====
// Shared modal for all four buckets. Tabs at the top let customers swap
// buckets without re-opening; rows reuse the same edit/retry/skip
// machinery as the upload-wizard ReviewStep so this works on active
// campaigns the same way it works mid-upload.
const BUCKET_META={
  assigned:           {label:'Assigned',         color:'#15803d', help:'These recipients are routed to a bakery.'},
  flagged_out_of_area:{label:'Out of area',      color:'#b45309', help:'No bakery covers this address. Edit it or contact admin to find coverage.'},
  geocode_failed:     {label:'Geocode failed',   color:'#dc2626', help:'Address could not be geocoded. Fix and retry.'},
  needs_review:       {label:'Needs review',     color:'#7c3aed', help:'AI/heuristic ingest flagged these for confirmation.'},
};

function RecipientBucketModal({campaign,initialBucket,onClose}){
  const [bucket,setBucket]=useState(initialBucket||'flagged_out_of_area');
  const [recipients,setRecipients]=useState([]);
  const [loading,setLoading]=useState(true);
  const [err,setErr]=useState('');
  const [copied,setCopied]=useState(false);

  const reload=useCallback(async()=>{
    setLoading(true);setErr('');
    try{setRecipients(await Customer.listRecipients(campaign.id));}
    catch(e){setErr(e.message||String(e));}
    setLoading(false);
  },[campaign.id]);

  useEffect(()=>{reload();},[reload]);

  // Esc closes
  useEffect(()=>{
    const onKey=e=>{if(e.key==='Escape')onClose();};
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[onClose]);

  const counts={
    assigned:           recipients.filter(r=>r.assignment_status==='assigned').length,
    needs_review:       recipients.filter(r=>r.assignment_status==='needs_review').length,
    flagged_out_of_area:recipients.filter(r=>r.assignment_status==='flagged_out_of_area').length,
    geocode_failed:     recipients.filter(r=>r.assignment_status==='geocode_failed').length,
  };
  const inBucket=recipients.filter(r=>r.assignment_status===bucket);

  const copyAddresses=async()=>{
    const lines=inBucket.map(r=>{
      const addr=[r.address,r.city,r.state,r.zip].filter(Boolean).join(', ');
      return `${r.company||'(no company)'}\t${addr}${r.contact_name?'\t'+r.contact_name:''}${r.phone?'\t'+r.phone:''}`;
    }).join('\n');
    try{
      await navigator.clipboard.writeText(lines);
      setCopied(true);setTimeout(()=>setCopied(false),1500);
    }catch{
      // Fallback: open mailto with the same payload
      const body=encodeURIComponent('Recipients needing coverage:\n\n'+lines);
      window.location.href=`mailto:contact@daymaker.com?subject=${encodeURIComponent('Find coverage for '+campaign.name)}&body=${body}`;
    }
  };

  return <div className="cropper-backdrop" onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:'#fff',borderRadius:12,width:'100%',maxWidth:880,maxHeight:'calc(100vh - 48px)',display:'flex',flexDirection:'column',overflow:'hidden'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'14px 20px',borderBottom:'1px solid #e5e7eb'}}>
        <div>
          <div style={{fontSize:14,fontWeight:700}}>{campaign.name}</div>
          <div style={{fontSize:12,color:'#6b7280'}}>Recipient details</div>
        </div>
        <button onClick={onClose} className="btn-ghost" style={{padding:'4px 10px',fontSize:18,lineHeight:1}}>×</button>
      </div>

      <div className="wizard-tabs" style={{paddingLeft:8}}>
        {['assigned','needs_review','flagged_out_of_area','geocode_failed'].map(b=>{
          const m=BUCKET_META[b];
          return <button key={b} className={'wizard-tab'+(bucket===b?' active':'')}
            style={bucket===b?{borderBottomColor:m.color,color:m.color}:{}}
            onClick={()=>setBucket(b)}>
            {m.label} <span className="wizard-tab-count">{counts[b]}</span>
          </button>;
        })}
      </div>

      <div style={{padding:'8px 20px',fontSize:12,color:'#6b7280',display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <span>{BUCKET_META[bucket].help}</span>
        {(bucket==='flagged_out_of_area'||bucket==='geocode_failed')&&inBucket.length>0&&
          <button className="btn-ghost" onClick={copyAddresses} style={{fontSize:12}}>
            {copied?'✓ Copied':`Copy ${inBucket.length} address${inBucket.length===1?'':'es'}`}
          </button>
        }
      </div>

      {err&&<div className="wizard-err" style={{margin:'0 20px'}}>{err}</div>}

      <div style={{padding:'4px 20px 20px',overflowY:'auto',flex:1}}>
        {loading
          ? <div style={{padding:24,color:'#9ca3af'}}>Loading…</div>
          : inBucket.length===0
            ? <div className="wizard-empty">Nothing in this bucket.</div>
            : <div className="wizard-row-list">
                {inBucket.map(r=><BucketRow key={r.id} row={r} bucket={bucket} onChanged={reload}/>)}
              </div>
        }
      </div>
    </div>
  </div>;
}

// Modal-side row. Mirrors UploadWizard's RecipientRow but adds the bakery
// name on assigned rows so customers can see which bakery picked it up.
function BucketRow({row,bucket,onChanged}){
  const [editing,setEditing]=useState(false);
  const [working,setWorking]=useState(false);
  const [err,setErr]=useState('');
  const [draft,setDraft]=useState({
    company:row.company||'',contact_name:row.contact_name||'',
    phone:row.phone||'',email:row.email||'',
    address:row.address||'',city:row.city||'',state:row.state||'',zip:row.zip||'',
    notes:row.notes||'',
  });
  const [editingNote,setEditingNote]=useState(false);
  const [noteDraft,setNoteDraft]=useState(row.notes||'');
  const [savingNote,setSavingNote]=useState(false);

  async function saveNote(){
    setSavingNote(true);
    try{
      await Customer.setRecipientNote(row.id,noteDraft);
      setEditingNote(false);onChanged();
    }catch(e){setErr(e.message||String(e));}
    setSavingNote(false);
  }

  async function save(){
    setWorking(true);setErr('');
    try{
      if(bucket==='flagged_out_of_area'||bucket==='geocode_failed'){
        await Customer.retryGeocode(row.id,{address:draft.address,city:draft.city,state:draft.state,zip:draft.zip});
        // retryGeocode skips notes — persist note edits separately.
        if((draft.notes||'')!==(row.notes||'')){
          await Customer.setRecipientNote(row.id,draft.notes);
        }
      }else{
        await Customer.acceptRecipient(row.id,draft);
      }
      setEditing(false);onChanged();
    }catch(e){setErr(e.message||String(e));}
    setWorking(false);
  }

  async function accept(){
    setWorking(true);setErr('');
    try{await Customer.acceptRecipient(row.id,draft);onChanged();}
    catch(e){setErr(e.message||String(e));}
    setWorking(false);
  }

  async function skip(){
    setWorking(true);setErr('');
    try{await Customer.skipRecipient(row.id);onChanged();}
    catch(e){setErr(e.message||String(e));}
    setWorking(false);
  }

  function tellAdmin(){
    const subject=encodeURIComponent('Out-of-area recipient: '+(row.company||''));
    const body=encodeURIComponent(
      `Recipient address falls outside every bakery polygon:\n\n${row.company||''}\n${row.address||''}, ${row.city||''} ${row.state||''} ${row.zip||''}\n\nCan a bakery cover this?`
    );
    window.location.href='mailto:contact@daymaker.com?subject='+subject+'&body='+body;
  }

  const addr=[row.address,row.city,row.state,row.zip].filter(Boolean).join(', ');
  const contact=[row.contact_name,row.phone,row.email].filter(Boolean).join(' · ');

  return <div className="wizard-row" style={{alignItems:'flex-start'}}>
    <div className="wizard-row-main" style={{flex:1,minWidth:0}}>
      {editing?(
        <div className="wizard-row-edit">
          <input value={draft.company} onChange={e=>setDraft(d=>({...d,company:e.target.value}))} placeholder="Company"/>
          <AddressTypeahead
            value={draft.address}
            onChange={v=>setDraft(d=>({...d,address:v}))}
            onSelect={parts=>setDraft(d=>({
              ...d,
              address:parts.address||d.address,
              city:parts.city||d.city,
              state:parts.state||d.state,
              zip:parts.zip||d.zip,
            }))}
            placeholder="Address"
          />
          <input value={draft.city} onChange={e=>setDraft(d=>({...d,city:e.target.value}))} placeholder="City"/>
          <input value={draft.state} onChange={e=>setDraft(d=>({...d,state:e.target.value}))} placeholder="ST" style={{width:60}}/>
          <input value={draft.zip} onChange={e=>setDraft(d=>({...d,zip:e.target.value}))} placeholder="ZIP" style={{width:80}}/>
          <input value={draft.contact_name} onChange={e=>setDraft(d=>({...d,contact_name:e.target.value}))} placeholder="Contact"/>
          <input value={draft.phone} onChange={e=>setDraft(d=>({...d,phone:e.target.value}))} placeholder="Phone"/>
          <textarea
            value={draft.notes}
            onChange={e=>setDraft(d=>({...d,notes:e.target.value}))}
            placeholder="Note for this recipient (optional)"
            rows={2}
            style={{flexBasis:'100%',padding:'6px 8px',border:'1px solid #d1d5db',borderRadius:6,fontFamily:'inherit',fontSize:12,resize:'vertical'}}
          />
        </div>
      ):(
        <>
          <div className="wizard-row-name">{row.company||<em style={{color:'#9ca3af'}}>(no company)</em>}</div>
          <div className="wizard-row-addr">{addr||<em style={{color:'#9ca3af'}}>(no address)</em>}</div>
          {contact&&<div className="wizard-row-addr">{contact}</div>}
          {bucket==='assigned'&&row.bakery?.name&&
            <div style={{fontSize:11,color:'#15803d',marginTop:4,fontWeight:500}}>→ {row.bakery.name}</div>
          }
          {row.notes&&!editingNote&&<div className="wizard-row-note" style={{marginTop:4,fontSize:12,color:'#7c3aed',background:'#faf5ff',padding:'4px 8px',borderRadius:4,borderLeft:'2px solid #7c3aed'}}>
            <span style={{fontWeight:600}}>Note: </span>{row.notes}
            <button onClick={()=>{setNoteDraft(row.notes||'');setEditingNote(true);}} style={{background:'none',border:'none',color:'#7c3aed',fontSize:11,marginLeft:6,cursor:'pointer',textDecoration:'underline',padding:0}}>edit</button>
          </div>}
          {!row.notes&&!editingNote&&<button onClick={()=>{setNoteDraft('');setEditingNote(true);}} style={{background:'none',border:'none',color:'#9ca3af',fontSize:11,cursor:'pointer',textDecoration:'underline',padding:0,marginTop:4}}>+ add note</button>}
          {editingNote&&<div style={{marginTop:6}}>
            <textarea value={noteDraft} onChange={e=>setNoteDraft(e.target.value)} rows={2} placeholder="Note for this recipient" style={{width:'100%',padding:'6px 8px',border:'1px solid #d1d5db',borderRadius:6,fontFamily:'inherit',fontSize:12,resize:'vertical',boxSizing:'border-box'}}/>
            <div style={{marginTop:4,display:'flex',gap:6}}>
              <button className="btn-primary" disabled={savingNote} onClick={saveNote} style={{padding:'4px 10px',fontSize:12}}>{savingNote?'Saving…':'Save note'}</button>
              <button className="btn-ghost" disabled={savingNote} onClick={()=>setEditingNote(false)} style={{padding:'4px 10px',fontSize:12}}>Cancel</button>
            </div>
          </div>}
          {err&&<div style={{fontSize:11,color:'#991b1b',marginTop:4}}>{err}</div>}
        </>
      )}
    </div>
    <div className="wizard-row-actions">
      {!editing&&bucket==='needs_review'&&<>
        <button className="btn-primary" disabled={working} onClick={accept}>Accept</button>
        <button className="btn-ghost"   disabled={working} onClick={()=>setEditing(true)}>Edit</button>
        <button className="btn-ghost"   disabled={working} onClick={skip}>Skip</button>
      </>}
      {!editing&&bucket==='flagged_out_of_area'&&<>
        <button className="btn-ghost" disabled={working} onClick={()=>setEditing(true)}>Edit address</button>
        <button className="btn-ghost" disabled={working} onClick={tellAdmin}>Tell admin</button>
      </>}
      {!editing&&bucket==='geocode_failed'&&
        <button className="btn-ghost" disabled={working} onClick={()=>setEditing(true)}>Edit &amp; retry</button>
      }
      {!editing&&bucket==='assigned'&&
        <button className="btn-ghost" disabled={working} onClick={()=>setEditing(true)}>Edit</button>
      }
      {editing&&<>
        <button className="btn-primary" disabled={working} onClick={save}>{working?'Saving…':'Save'}</button>
        <button className="btn-ghost"   disabled={working} onClick={()=>setEditing(false)}>Cancel</button>
      </>}
    </div>
  </div>;
}
