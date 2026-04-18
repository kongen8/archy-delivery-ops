// ===== PROFILE SWITCHER =====
// Temporary minimal version; Task 9 adds the real dropdown UI.
function ProfileSwitcher(){
  return <button className="btn-ghost" onClick={()=>window.signOutProfile()}>Switch profile</button>;
}
