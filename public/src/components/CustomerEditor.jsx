// ===== CUSTOMER EDITOR — full impl in Task 6 =====
function CustomerEditor({customerId,isNew}){
  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>
    CustomerEditor · {isNew?'new':customerId} — pending Task 6. <button className="btn-ghost" onClick={()=>navigate('#/admin')}>Back</button>
  </div>;
}
