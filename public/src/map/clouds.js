function parseCloudShape(art) {
  const px = [];
  for (let y = 0; y < art.length; y++)
    for (let x = 0; x < art[y].length; x++)
      if (art[y][x] === "#") px.push([x, y]);
  return px;
}

const CLOUD_SHAPES = [
  parseCloudShape([
    "            ######                        ",
    "         ############      ####           ",
    "       ################  ########         ",
    "      ####################################",
    "     ######################################",
    "    ########################################",
    "   ##########################################",
    "  ############################################",
    "  ############################################",
    "   ##########################################",
    "    ########################################",
    "      ####################################",
    "        ################################  ",
    "           ##########################     ",
  ]),
  parseCloudShape([
    "          ######         ####      ",
    "        ##########     ########    ",
    "      ##################################",
    "     ####################################",
    "    ######################################",
    "   ########################################",
    "   ########################################",
    "    ######################################",
    "      ##################################",
    "        ##############################  ",
    "           ########################     ",
  ]),
  parseCloudShape([
    "        ######        ",
    "      ##########      ",
    "    ##############    ",
    "   ################   ",
    "  ##################  ",
    " #################### ",
    "######################",
    "######################",
    " #################### ",
    "  ##################  ",
    "    ##############    ",
    "       ########       ",
  ]),
  parseCloudShape([
    "         ######           ######       ",
    "       ##########       ##########     ",
    "     ########################################",
    "    ##########################################",
    "   ############################################",
    "    ##########################################",
    "     ########################################",
    "       ####################################  ",
    "          ##############################     ",
  ]),
];

function buildBoxShadow(pixels, size, color) {
  return pixels.map(([x, y]) => `${x * size}px ${y * size}px 0 0 ${color}`).join(",");
}

function createCloudEl(shapeIdx, size, opacity) {
  const el = document.createElement("div");
  el.style.pointerEvents = "none";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  const colors = ["#fff5f5", "#fff0f3", "#ffeef0", "#fffaf0"];
  const color = colors[shapeIdx % colors.length];
  el.style.boxShadow = buildBoxShadow(CLOUD_SHAPES[shapeIdx], size, color);
  el.style.opacity = String(opacity);
  return el;
}

const CLOUD_CONFIGS = [
  { shape: 0, size: 4, lat: 37.806, lng: -122.387, speed: 0.0006, opacity: 0.55 },
  { shape: 1, size: 3, lat: 37.795, lng: -122.375, speed: 0.0008, opacity: 0.45 },
  { shape: 2, size: 4, lat: 37.782, lng: -122.365, speed: 0.0005, opacity: 0.60 },
  { shape: 3, size: 3, lat: 37.772, lng: -122.380, speed: 0.0010, opacity: 0.40 },
  { shape: 0, size: 3, lat: 37.810, lng: -122.420, speed: 0.0007, opacity: 0.50 },
  { shape: 2, size: 4, lat: 37.760, lng: -122.395, speed: 0.0004, opacity: 0.60 },
  { shape: 1, size: 3, lat: 37.800, lng: -122.440, speed: 0.0009, opacity: 0.35 },
  { shape: 3, size: 4, lat: 37.785, lng: -122.355, speed: 0.0012, opacity: 0.48 },
];

function addWhippedCreamClouds(map) {
  const markers = [];
  let startTime = null;

  CLOUD_CONFIGS.forEach(cfg => {
    const el = createCloudEl(cfg.shape, cfg.size, cfg.opacity);
    const m = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([cfg.lng, cfg.lat])
      .addTo(map);
    markers.push({ marker: m, config: cfg, baseLng: cfg.lng });
  });

  function animate(ts) {
    if (!startTime) startTime = ts;
    const elapsed = (ts - startTime) / 1000;
    markers.forEach(({ marker, config, baseLng }) => {
      const newLng = baseLng - elapsed * config.speed;
      const bounds = map.getBounds();
      const wrapped = newLng < bounds.getWest() - 0.02
        ? bounds.getEast() + 0.02
        : newLng;
      if (wrapped !== newLng) {
        markers.find(m => m.marker === marker).baseLng = wrapped + elapsed * config.speed;
      }
      marker.setLngLat([newLng < bounds.getWest() - 0.02 ? wrapped : newLng, config.lat]);
    });
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

function addSprinkles(map) {
  const container = map.getCanvasContainer();
  const SPRINKLE_COLORS = ["#e91e63", "#ff9800", "#4caf50", "#7986cb", "#fff176", "#f48fb1", "#80deea", "#ce93d8"];

  function spawnSprinkle() {
    const el = document.createElement("div");
    const color = SPRINKLE_COLORS[Math.floor(Math.random() * SPRINKLE_COLORS.length)];
    const isRound = Math.random() > 0.5;
    const size = 3 + Math.floor(Math.random() * 4);
    Object.assign(el.style, {
      position: "absolute",
      width: isRound ? `${size}px` : `${size * 2.5}px`,
      height: `${size}px`,
      background: color,
      borderRadius: isRound ? "50%" : `${size}px`,
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
      pointerEvents: "none",
      zIndex: "1",
      opacity: "0",
      animation: `sprinkle-fall ${4 + Math.random() * 6}s linear ${Math.random() * 8}s infinite`,
      transform: `rotate(${Math.random() * 360}deg)`,
    });
    container.appendChild(el);
    return el;
  }

  for (let i = 0; i < 40; i++) spawnSprinkle();
}
