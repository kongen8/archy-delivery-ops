// ===== BAKERY EDITOR — full impl in Tasks 7 + 8 =====
function BakeryEditor({bakeryId,isNew}){
  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>
    BakeryEditor · {isNew?'new':bakeryId} — pending Tasks 7, 8. <button className="btn-ghost" onClick={()=>navigate('#/admin')}>Back</button>
  </div>;
}
