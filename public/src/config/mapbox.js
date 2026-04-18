// ===== MAPBOX CONFIG =====
// Public tokens (pk.*) are safe to ship in the browser. Restrict to your domain
// at https://account.mapbox.com/access-tokens/ once you're deployed.
const MAPBOX_API_KEY = window.__MAPBOX_API_KEY__ ||
  'pk.eyJ1Ijoid2lsbGlhbWxpbmRkaG9sbSIsImEiOiJjbW80NGxwZTEwZG04MnFxcDBldTl3OTV6In0.YMA7moUg7cvZqkW4C_xC0w';
window.MAPBOX_API_KEY = MAPBOX_API_KEY;
