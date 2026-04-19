// ===== MAIN APP =====
function App(){
  const profile=window.__CURRENT_PROFILE__||{type:'landing'};
  const route=useRoute();

  // BoxCardSheet is mounted unconditionally so the print event handler is
  // always alive (it returns null until urls are populated).
  return <>
    <BoxCardSheet/>
    <AppRoute profile={profile} route={route}/>
  </>;
}

function AppRoute({profile, route}){
  if(profile.type==='admin'){
    return <AdminView route={route}/>;
  }
  if(profile.type==='bakery'&&profile.id){
    return <BakeryHomeView bakeryId={profile.id}/>;
  }
  if(profile.type==='customer'&&profile.id){
    if(route.view==='customer'&&route.page==='upload'){
      return <UploadWizard customerId={route.customerId} campaignId={route.campaignId}/>;
    }
    return <CustomerHomeView customerId={profile.id}/>;
  }

  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>Loading…</div>;
}
