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
    {deleteErr&&<div style={{marginTop:8,fontSize:12,color:'#991b1b'}}>{deleteErr}</div>}
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
  });

  async function save(){
    setWorking(true);setErr('');
    try{
      if(bucket==='flagged_out_of_area'||bucket==='geocode_failed'){
        await Customer.retryGeocode(row.id,{address:draft.address,city:draft.city,state:draft.state,zip:draft.zip});
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
          <input value={draft.address} onChange={e=>setDraft(d=>({...d,address:e.target.value}))} placeholder="Address"/>
          <input value={draft.city} onChange={e=>setDraft(d=>({...d,city:e.target.value}))} placeholder="City"/>
          <input value={draft.state} onChange={e=>setDraft(d=>({...d,state:e.target.value}))} placeholder="ST" style={{width:60}}/>
          <input value={draft.zip} onChange={e=>setDraft(d=>({...d,zip:e.target.value}))} placeholder="ZIP" style={{width:80}}/>
          <input value={draft.contact_name} onChange={e=>setDraft(d=>({...d,contact_name:e.target.value}))} placeholder="Contact"/>
          <input value={draft.phone} onChange={e=>setDraft(d=>({...d,phone:e.target.value}))} placeholder="Phone"/>
        </div>
      ):(
        <>
          <div className="wizard-row-name">{row.company||<em style={{color:'#9ca3af'}}>(no company)</em>}</div>
          <div className="wizard-row-addr">{addr||<em style={{color:'#9ca3af'}}>(no address)</em>}</div>
          {contact&&<div className="wizard-row-addr">{contact}</div>}
          {bucket==='assigned'&&row.bakery?.name&&
            <div style={{fontSize:11,color:'#15803d',marginTop:4,fontWeight:500}}>→ {row.bakery.name}</div>
          }
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
