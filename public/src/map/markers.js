function sd(styles) {
  const el = document.createElement("div");
  Object.assign(el.style, styles);
  return el;
}

// #region agent log
// Cake-marker anchor diagnostic. Given a map + shell + marker + stop, snapshots
// (a) the outer/wrapper/bobber/liner measurements and computed transforms
// (b) where MapLibre *thinks* the lnglat projects to in screen-space
// (c) the gap between the liner bottom-center and that projected point.
// If the fix is working correctly, gap.dx and gap.dy should be ~0 at all
// moments (init, movestart, moveend).
function __cakeAnchorLog(map, shell, marker, stop, label){
  try{
    if(!map||!marker||!stop)return;
    const canvas=map.getCanvas&&map.getCanvas();
    if(!canvas)return;
    const cRect=canvas.getBoundingClientRect();
    const outer=marker.getElement&&marker.getElement();
    if(!outer)return;
    const wrapper=outer.firstElementChild||null;
    const bobber=outer.querySelector('.cake-bobber');
    // wrapper children: [bobber, liner/plate, shadow(absolute)]
    const ped=wrapper&&wrapper.children&&wrapper.children[1]||null;
    // Label (company name) is a direct child of outer (sibling of wrapper),
    // not inside wrapper. Distinguishes from the shadow (which also uses
    // translateX but lives INSIDE wrapper).
    const lbl=Array.from(outer.children).find(c=>c!==wrapper&&c.textContent&&!c.textContent.match(/^\d+$/))||null;
    const bcr=el=>el?el.getBoundingClientRect():null;
    const cs=el=>el?getComputedStyle(el):null;
    const outerBCR=bcr(outer),wrapperBCR=bcr(wrapper),bobberBCR=bcr(bobber),pedBCR=bcr(ped);
    const oCS=cs(outer),wCS=cs(wrapper),bCS=cs(bobber);
    const p=map.project([stop.ln,stop.lt]);
    const projX=p.x+cRect.left,projY=p.y+cRect.top;
    const pedCenterX=pedBCR?(pedBCR.left+pedBCR.width/2):null;
    const pedBottomY=pedBCR?pedBCR.bottom:null;
    // Bobber↔pedestal gap: at rest the frosting overlaps the liner top by
    // 2px (liner.marginTop:-2). When the bobber translates up by Y, a gap
    // of Y-2 opens. Positive = visible gap; negative = overlap.
    const bobPedGap=(bobberBCR&&pedBCR)?(pedBCR.top-bobberBCR.bottom):null;
    fetch('http://127.0.0.1:7333/ingest/9665ef98-9b4b-4c13-abf9-412eeeb4ef14',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c27166'},body:JSON.stringify({
      sessionId:'c27166',location:'index.html:cake-anchor',message:'cake anchor diag: '+label,
      hypothesisId:'H1-H2-H3-H4-H5-H6',
      data:{
        label,stopId:stop.id,co:stop.co,zoom:map.getZoom(),
        shellClass:shell&&shell.className||null,
        outer:outer&&{offW:outer.offsetWidth,offH:outer.offsetHeight,tf:oCS&&oCS.transform,bcr:outerBCR&&{x:outerBCR.x,y:outerBCR.y,w:outerBCR.width,h:outerBCR.height,bot:outerBCR.bottom}},
        wrapper:wrapper&&{offW:wrapper.offsetWidth,offH:wrapper.offsetHeight,tf:wCS&&wCS.transform,bcr:wrapperBCR&&{y:wrapperBCR.y,h:wrapperBCR.height,bot:wrapperBCR.bottom}},
        bobber:bobber&&{offW:bobber.offsetWidth,offH:bobber.offsetHeight,tf:bCS&&bCS.transform,anim:bCS&&bCS.animationName,playState:bCS&&bCS.animationPlayState,bcr:bobberBCR&&{y:bobberBCR.y,h:bobberBCR.height,bot:bobberBCR.bottom}},
        pedestal:ped&&{offW:ped.offsetWidth,offH:ped.offsetHeight,bcr:pedBCR&&{x:pedBCR.x,y:pedBCR.y,w:pedBCR.width,h:pedBCR.height,bot:pedBCR.bottom,cx:pedCenterX}},
        label:lbl?{present:true,bcr:bcr(lbl)}:{present:false},
        projected:{x:projX,y:projY},
        gap:pedBCR?{dx:pedCenterX-projX,dy:pedBottomY-projY}:null,
        bobPedGap
      },
      timestamp:Date.now()
    })}).catch(()=>{});
  }catch(e){
    fetch('http://127.0.0.1:7333/ingest/9665ef98-9b4b-4c13-abf9-412eeeb4ef14',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'c27166'},body:JSON.stringify({sessionId:'c27166',location:'index.html:cake-anchor',message:'diag error',data:{err:String(e&&e.message||e),label},timestamp:Date.now()})}).catch(()=>{});
  }
}
// #endregion

function getFloatTiming(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 10000;
  return { duration: `${3.9 + (hash % 7) * 0.16}s`, delay: `${((hash >> 1) % 9) * -0.35}s` };
}

function createDeliveryMarker(stop) {
  const OL = CAKE.OL;
  const STATUS_MARKER_COLORS = {
    "delivered":  { bg: "#81c784", accent: "#c8e6c9", label: "DONE" },
    "in-transit": { bg: "#ffb74d", accent: "#ffe0b2", label: "MOVING" },
    "pending":    { bg: "#7986cb", accent: "#c5cae9", label: "WAIT" },
    "failed":     { bg: "#e57373", accent: "#ffcdd2", label: "FAIL" },
  };
  const statusCfg = STATUS_MARKER_COLORS[stop.status] || STATUS_MARKER_COLORS["pending"];
  const accent = statusCfg.bg;
  const accentLight = statusCfg.accent;

  const { duration, delay } = getFloatTiming(stop.name);

  // Structure (see reference design where icons float above fixed pedestals):
  //
  //   outer      (.maplibregl-marker root — MapLibre owns its transform)
  //    └── wrapper        (static — LAYOUT bottom = liner base = the anchor)
  //         ├── bobber     (.cake-bobber — ONLY this element carries the
  //         │              marker-float animation, so transforms here never
  //         │              move the geographic anchor)
  //         │    ├── badge / wick / cherry / frosting (+ sprinkles)
  //         ├── liner     (static pedestal — glued to the lnglat)
  //         └── shadow    (absolute, outside the layout box)
  //
  // This is the critical invariant: MapLibre anchor:'bottom' pins outer's
  // layout bottom to the lnglat. outer's layout bottom = wrapper's bottom
  // (chip/label are absolute) = liner's base (shadow is absolute, bobber's
  // transform doesn't affect layout). So the liner always sits exactly on
  // the ground-pin dot, regardless of animation state or zoom.
  const wrapper = sd({
    display: "flex", flexDirection: "column", alignItems: "center",
    cursor: "pointer", position: "relative",
  });

  const bobber = sd({
    display: "flex", flexDirection: "column", alignItems: "center",
    position: "relative",
    animationName: "marker-float", animationDuration: duration,
    animationTimingFunction: "ease-in-out", animationIterationCount: "infinite",
    animationDelay: delay, willChange: "transform",
  });
  // Class lets the `.cake-moving` CSS rule neutralize the bob transform on
  // exactly this element during pan/zoom, without touching MapLibre's
  // positioning transform on the marker root or the absolute label's
  // translateX(-50%).
  bobber.className = "cake-bobber";

  const badge = sd({
    padding: "2px 6px", background: accent, color: "#fff",
    fontFamily: "'Courier New', monospace", fontSize: "8px", fontWeight: "bold",
    border: `2px solid ${OL}`, boxShadow: `2px 2px 0 ${OL}`,
    marginBottom: "1px", whiteSpace: "nowrap", letterSpacing: "1px",
    textAlign: "center", borderRadius: "2px",
  });
  badge.textContent = statusCfg.label;
  bobber.appendChild(badge);

  bobber.appendChild(sd({
    width: "3px", height: "8px", background: CAKE.chocolateLt,
    borderLeft: `1px solid ${OL}`, borderRight: `1px solid ${OL}`,
  }));

  bobber.appendChild(sd({
    width: "8px", height: "8px", background: "#e53935",
    border: `2px solid ${OL}`, borderRadius: "50%",
    marginBottom: "-3px", position: "relative", zIndex: "3",
    boxShadow: `inset -1px -1px 0 #c62828, 1px 1px 0 ${OL}`,
  }));

  const frosting = sd({
    width: "30px", height: "14px",
    background: accent,
    border: `2px solid ${OL}`,
    borderRadius: "8px 8px 2px 2px",
    position: "relative",
    boxShadow: `inset 0 4px 0 ${accentLight}, 3px 3px 0 ${OL}`,
  });
  frosting.appendChild(sd({
    position: "absolute", bottom: "-4px", left: "3px",
    width: "5px", height: "6px", background: accent,
    borderRadius: "0 0 3px 3px", border: `1px solid ${OL}`, borderTop: "none",
  }));
  frosting.appendChild(sd({
    position: "absolute", bottom: "-5px", right: "5px",
    width: "4px", height: "7px", background: accent,
    borderRadius: "0 0 3px 3px", border: `1px solid ${OL}`, borderTop: "none",
  }));
  bobber.appendChild(frosting);

  const sprinkleColors = ["#fff176", "#f48fb1", "#80deea", "#ce93d8", "#ffcc80"];
  for (let i = 0; i < 3; i++) {
    frosting.appendChild(sd({
      position: "absolute",
      top: `${3 + Math.floor(Math.random() * 6)}px`,
      left: `${4 + i * 8 + Math.floor(Math.random() * 3)}px`,
      width: "3px", height: "3px",
      background: sprinkleColors[Math.floor(Math.random() * sprinkleColors.length)],
      borderRadius: Math.random() > 0.5 ? "50%" : "1px",
      border: `1px solid rgba(78,52,46,0.3)`,
    }));
  }

  wrapper.appendChild(bobber);

  // Liner — the static pedestal. Lives OUTSIDE the bobber so it never
  // translates. marginTop:-2px keeps a visual overlap with the frosting at
  // rest (looks like the frosting is sitting on the liner); as the bobber
  // lifts, a small gap opens up — the "floating above the pedestal" effect.
  const liner = sd({
    width: "28px", height: "18px",
    background: `repeating-linear-gradient(90deg, ${CAKE.sponge} 0px, ${CAKE.sponge} 3px, ${CAKE.spongeDark} 3px, ${CAKE.spongeDark} 4px)`,
    border: `2px solid ${OL}`,
    borderRadius: "0 0 6px 6px",
    marginTop: "-2px",
    boxShadow: `3px 3px 0 ${OL}`,
    clipPath: "polygon(8% 0%, 92% 0%, 100% 100%, 0% 100%)",
  });
  wrapper.appendChild(liner);

  // Shadow lives BELOW the wrapper visually but outside its layout box.
  wrapper.appendChild(sd({
    position: "absolute",
    top: "calc(100% + 3px)",
    left: "50%",
    transform: "translateX(-50%)",
    width: "22px", height: "6px",
    background: "rgba(78,52,46,0.25)",
    borderRadius: "50%",
    pointerEvents: "none",
  }));

  return wrapper;
}

// Fallback region centers (lng, lat)
const REGION_CENTERS = {
  "SF":                     [-122.42, 37.78],
  "South Bay / Peninsula":  [-122.08, 37.39],
  "LA":                     [-118.24, 34.05],
  "Orlando":                 [-81.38, 28.54],
  "Houston":                 [-95.37, 29.76],
};

// Wrap a cupcake marker with a stop-order chip (upper-left) and an optional
// company-name label (below the cake).
//
// Placement rules (important — these preserve the anchor invariant):
//   - chip:  attached to the .cake-bobber group, so it bobs WITH the cupcake
//            top (stays visually attached to the badge). Absolute inside the
//            bobber, so it never contributes to wrapper's layout bottom.
//   - label: sibling of the wrapper inside outer, so it stays STILL on the
//            ground (doesn't bob) and doesn't contribute to layout either.
//
// MapLibre's anchor:'bottom' still pins outer's layout bottom to the lnglat,
// and that bottom is still the liner base — the chip and label never shift
// the anchor regardless of length.
function withStopNumber(markerEl, stopNumber, color, companyName){
  const OL=CAKE.OL;
  const outer=sd({position:"relative",display:"inline-block"});
  outer.appendChild(markerEl);
  const chip=sd({
    position:"absolute", top:"-6px", left:"-14px",
    minWidth:"22px", height:"22px", padding:"0 4px",
    background:color, color:"#fff",
    fontFamily:"'Courier New', monospace",
    fontSize:"12px", fontWeight:"bold",
    border:`2px solid ${OL}`, borderRadius:"50%",
    display:"flex", alignItems:"center", justifyContent:"center",
    boxShadow:`2px 2px 0 ${OL}`, zIndex:"20",
  });
  chip.textContent=String(stopNumber);
  // Attach chip to the bobber so it floats with the cupcake top. Fallback to
  // outer if no bobber is present (shouldn't happen with createDeliveryMarker).
  const bobber=markerEl.querySelector(".cake-bobber");
  (bobber||outer).appendChild(chip);

  if(companyName){
    const short=String(companyName).length>16
      ?String(companyName).slice(0,15).trim()+'…'
      :String(companyName);
    const lbl=sd({
      position:"absolute",
      top:"calc(100% + 12px)",
      left:"50%",
      transform:"translateX(-50%)",
      padding:"2px 6px",
      background:"#fff8e7", color:OL,
      fontFamily:"'Courier New', monospace",
      fontSize:"9px", fontWeight:"bold", letterSpacing:"0.5px",
      border:`2px solid ${OL}`, borderRadius:"2px",
      boxShadow:`2px 2px 0 ${OL}`,
      whiteSpace:"nowrap", textAlign:"center",
      zIndex:"25", pointerEvents:"none",
    });
    lbl.textContent=short;
    outer.appendChild(lbl);
  }
  return outer;
}

// Bakery depot marker — layered cake with a banner label.
// Same anchoring invariant as createDeliveryMarker: plate = static pedestal
// glued to the lnglat; the cake body / frosting / cherry / banner bob above
// it inside a .cake-bobber group.
function createDepotMarker(depot){
  const OL=CAKE.OL;
  const {duration,delay}=getFloatTiming(depot&&depot.name?depot.name:"depot");

  // outer is the element handed to MapLibre (it'll get the .maplibregl-marker
  // class). wrapper is nested one level inside so the CSS selector
  // `.maplibregl-marker > div:first-child` targets the same layer for both
  // delivery and depot cakes — that layer is what carries the ground-plane
  // `transform: scale(var(--cake-scale))`.
  const outer=sd({position:"relative"});

  const wrapper=sd({
    display:"flex",flexDirection:"column",alignItems:"center",
    cursor:"pointer",position:"relative",
  });

  const bobber=sd({
    display:"flex",flexDirection:"column",alignItems:"center",
    position:"relative",
    animationName:"marker-float",animationDuration:duration,
    animationTimingFunction:"ease-in-out",animationIterationCount:"infinite",
    animationDelay:delay,willChange:"transform",
  });
  bobber.className="cake-bobber";

  const banner=sd({
    padding:"3px 8px", background:CAKE.chocolate, color:CAKE.fondant,
    fontFamily:"'Courier New', monospace",
    fontSize:"9px", fontWeight:"bold", letterSpacing:"1px",
    border:`2px solid ${OL}`, boxShadow:`2px 2px 0 ${OL}`,
    whiteSpace:"nowrap", borderRadius:"2px", marginBottom:"3px",
    textAlign:"center",
  });
  banner.textContent=(shortDepot(depot.name||"")||"BAKERY").toUpperCase();
  bobber.appendChild(banner);

  // Cherry on top
  bobber.appendChild(sd({
    width:"10px", height:"10px", background:"#e53935",
    border:`2px solid ${OL}`, borderRadius:"50%",
    marginBottom:"-4px", zIndex:"3", position:"relative",
    boxShadow:`inset -1px -1px 0 #c62828, 1px 1px 0 ${OL}`,
  }));

  // Top frosting layer (strawberry)
  bobber.appendChild(sd({
    width:"36px", height:"10px",
    background:CAKE.strawberry,
    border:`2px solid ${OL}`,
    borderRadius:"8px 8px 2px 2px",
    boxShadow:`inset 0 3px 0 ${CAKE.fondantDark}, 3px 3px 0 ${OL}`,
  }));

  // Cake body (sponge layers)
  bobber.appendChild(sd({
    width:"38px", height:"22px",
    background:`repeating-linear-gradient(0deg, ${CAKE.sponge} 0px, ${CAKE.sponge} 4px, ${CAKE.spongeDark} 4px, ${CAKE.spongeDark} 6px, ${CAKE.chocolateLt} 6px, ${CAKE.chocolateLt} 8px, ${CAKE.sponge} 8px, ${CAKE.sponge} 14px)`,
    border:`2px solid ${OL}`,
    marginTop:"-2px",
    boxShadow:`3px 3px 0 ${OL}`,
  }));

  wrapper.appendChild(bobber);

  // Plate — the static pedestal (ground anchor). Lives OUTSIDE the bobber so
  // it never translates. The cake body has boxShadow 3px 3px 0 OL which
  // visually lands on the plate top at rest.
  wrapper.appendChild(sd({
    width:"46px", height:"4px",
    background:CAKE.wafer,
    border:`2px solid ${OL}`, borderTop:"none",
    borderRadius:"0 0 6px 6px",
    boxShadow:`3px 3px 0 ${OL}`,
  }));

  wrapper.appendChild(sd({
    position:"absolute",
    top:"calc(100% + 4px)",
    left:"50%",
    transform:"translateX(-50%)",
    width:"32px", height:"6px",
    background:"rgba(78,52,46,0.25)",
    borderRadius:"50%",
    pointerEvents:"none",
  }));
  outer.appendChild(wrapper);
  return outer;
}

// Pick the first POI/road-label symbol layer so route lines sit above roads but
// still respect important place labels. If we can't find one we fall back to
// undefined, which appends the layer on top of the style.
function routeInsertBeforeId(map){
  const layers=map.getStyle().layers||[];
  const preferredPrefixes=['poi','place_','water_name','housenumber','road_label','roadname','transit'];
  for(const l of layers){
    if(l.type!=='symbol')continue;
    const id=l.id||'';
    if(preferredPrefixes.some(p=>id.startsWith(p)))return id;
  }
  // last resort: first symbol layer
  for(const l of layers){if(l.type==='symbol')return l.id;}
  return undefined;
}
