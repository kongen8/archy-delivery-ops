// DOM markers are intentionally empty. Delivery stops are rendered by the
// `active-stops-pin-halo` / `active-stops-pin-dot` / `inactive-stops-layer`
// circle layers on the map plane (see MapView.jsx). Keeping the factory
// functions around as no-ops preserves the existing call sites without
// drawing a visible teardrop or depot pin.

const REGION_CENTERS = {
  "SF":                     [-122.42, 37.78],
  "South Bay / Peninsula":  [-122.08, 37.39],
  "LA":                     [-118.24, 34.05],
  "Orlando":                 [-81.38, 28.54],
  "Houston":                 [-95.37, 29.76],
};

function _emptyMarker() {
  const el = document.createElement("div");
  el.style.width = "0";
  el.style.height = "0";
  el.style.pointerEvents = "none";
  return el;
}

function createDeliveryMarker(_stop) {
  return _emptyMarker();
}

function withStopNumber(markerEl, _stopNumber, _color, _companyName) {
  return markerEl;
}

function createDepotMarker(_depot) {
  return _emptyMarker();
}

function routeInsertBeforeId(map) {
  const layers = map.getStyle().layers || [];
  const preferredPrefixes = ["poi", "place_", "water_name", "housenumber", "road_label", "roadname", "transit"];
  for (const l of layers) {
    if (l.type !== "symbol") continue;
    const id = l.id || "";
    if (preferredPrefixes.some(p => id.startsWith(p))) return id;
  }
  for (const l of layers) { if (l.type === "symbol") return l.id; }
  return undefined;
}
