// ===== CAKE WORLD MAP =====
const CAKE = {
  fondant:      "#fce4ec",
  fondantDark:  "#f8bbd0",
  vanilla:      "#fff8e7",
  buttercream:  "#fff3cd",
  strawberry:   "#f48fb1",
  raspberry:    "#e91e63",
  mint:         "#c8e6c9",
  mintDark:     "#81c784",
  pistachio:    "#a5d6a7",
  blueberry:    "#7986cb",
  blueberryDk:  "#5c6bc0",
  lavender:     "#b39ddb",
  chocolate:    "#5d4037",
  chocolateMd:  "#795548",
  chocolateLt:  "#a1887f",
  caramel:      "#d4a056",
  wafer:        "#d7ccc8",
  sponge:       "#ffe0b2",
  spongeDark:   "#ffcc80",
  meringue:     "#fff9c4",
  macaron:      "#f8bbd0",
  cocoa:        "#4e342e",
  cocoaLight:   "#8d6e63",
  OL:           "#4e342e",
};

function setPaint(map, layerId, prop, val) {
  if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, val);
}

function applyCakeStyle(map) {
  setPaint(map, "background", "background-color", CAKE.fondant);
  setPaint(map, "landcover", "fill-color", CAKE.mint);
  setPaint(map, "landcover", "fill-opacity", 0.96);

  ["park_national_park", "park_nature_reserve"].forEach(id => {
    setPaint(map, id, "fill-color", CAKE.pistachio);
    setPaint(map, id, "fill-opacity", 0.92);
  });

  setPaint(map, "landuse_residential", "fill-color", CAKE.vanilla);
  setPaint(map, "landuse", "fill-color", CAKE.buttercream);
  setPaint(map, "landuse", "fill-opacity", 0.88);

  setPaint(map, "water", "fill-color", CAKE.blueberry);
  setPaint(map, "water_shadow", "fill-color", CAKE.blueberryDk);
  setPaint(map, "waterway", "line-color", CAKE.lavender);
  setPaint(map, "waterway", "line-width", 2.4);

  setPaint(map, "building", "fill-color", CAKE.macaron);
  setPaint(map, "building", "fill-opacity", 0.2);
  setPaint(map, "building-top", "fill-color", CAKE.sponge);
  setPaint(map, "building-top", "fill-opacity", 0);

  ["road_service_case","road_minor_case","road_pri_case_ramp","road_trunk_case_ramp","road_mot_case_ramp","road_sec_case_noramp","road_pri_case_noramp","road_trunk_case_noramp","road_mot_case_noramp"].forEach(id => setPaint(map, id, "line-color", CAKE.chocolate));

  ["road_service_fill","road_minor_fill","road_pri_fill_ramp","road_trunk_fill_ramp","road_mot_fill_ramp","road_sec_fill_noramp","road_pri_fill_noramp"].forEach(id => setPaint(map, id, "line-color", CAKE.chocolateLt));

  setPaint(map, "road_trunk_fill_noramp", "line-color", CAKE.caramel);
  setPaint(map, "road_mot_fill_noramp", "line-color", CAKE.chocolateMd);
  setPaint(map, "road_path", "line-color", CAKE.chocolateMd);

  setPaint(map, "rail", "line-color", CAKE.chocolateMd);
  setPaint(map, "rail_dash", "line-color", CAKE.wafer);

  ["tunnel_service_case","tunnel_minor_case","tunnel_sec_case","tunnel_pri_case","tunnel_trunk_case","tunnel_mot_case"].forEach(id => setPaint(map, id, "line-color", CAKE.chocolate));
  ["tunnel_service_fill","tunnel_minor_fill","tunnel_sec_fill","tunnel_pri_fill","tunnel_trunk_fill","tunnel_mot_fill"].forEach(id => setPaint(map, id, "line-color", CAKE.chocolateLt));

  ["bridge_service_case","bridge_minor_case","bridge_sec_case","bridge_pri_case","bridge_trunk_case","bridge_mot_case"].forEach(id => setPaint(map, id, "line-color", CAKE.chocolate));
  ["bridge_service_fill","bridge_minor_fill","bridge_sec_fill","bridge_pri_fill","bridge_trunk_fill","bridge_mot_fill"].forEach(id => setPaint(map, id, "line-color", CAKE.caramel));

  setPaint(map, "boundary_county", "line-color", CAKE.strawberry);
  setPaint(map, "boundary_state", "line-color", CAKE.raspberry);

  ["place_hamlet","place_suburbs","place_villages","place_town","place_city_r6","place_city_r5"].forEach(id => {
    setPaint(map, id, "text-color", CAKE.cocoa);
    setPaint(map, id, "text-halo-color", CAKE.buttercream);
    setPaint(map, id, "text-halo-width", 1.5);
  });

  ["place_city_dot_r7","place_city_dot_r4","place_city_dot_r2","place_city_dot_z7","place_capital_dot_z7"].forEach(id => {
    setPaint(map, id, "text-color", CAKE.cocoa);
    setPaint(map, id, "text-halo-color", CAKE.buttercream);
    setPaint(map, id, "text-halo-width", 1.5);
  });

  setPaint(map, "place_state", "text-color", CAKE.cocoaLight);
  setPaint(map, "place_country_1", "text-color", CAKE.cocoa);
  setPaint(map, "place_country_2", "text-color", CAKE.cocoa);

  ["watername_ocean","watername_sea","watername_lake","watername_lake_line","waterway_label"].forEach(id => {
    setPaint(map, id, "text-color", "#3949ab");
    setPaint(map, id, "text-halo-color", CAKE.lavender);
    setPaint(map, id, "text-halo-width", 1);
  });

  setPaint(map, "poi_park", "text-color", CAKE.mintDark);
  setPaint(map, "poi_stadium", "text-color", CAKE.cocoaLight);
  setPaint(map, "aeroway-runway", "line-color", CAKE.wafer);
  setPaint(map, "aeroway-taxiway", "line-color", CAKE.chocolateLt);
}

function addCakeBuildings(map) {
  if (!map.getSource("carto") || map.getLayer("cake-buildings")) return;

  const rawH = ["coalesce", ["to-number", ["get", "render_height"]], ["to-number", ["get", "height"]], 12];
  const snapH = ["max", 8, ["min", 180, ["*", ["round", ["/", rawH, 8]], 8]]];

  map.addLayer({
    id: "cake-buildings",
    type: "fill-extrusion",
    source: "carto",
    "source-layer": "building",
    minzoom: 11,
    paint: {
      "fill-extrusion-color": [
        "interpolate", ["linear"], snapH,
        8, "#ffe0b2",
        32, "#ffccbc",
        72, "#f8bbd0",
        110, "#e1bee7",
        140, "#fff9c4",
      ],
      "fill-extrusion-height": snapH,
      "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 0.88,
      "fill-extrusion-vertical-gradient": false,
    }
  }, "boundary_country_outline");
}
