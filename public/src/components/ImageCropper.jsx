// ===== IMAGE CROPPER =====
// Plan 5 — modal that crops a single source image to a locked aspect ratio
// + output size, with optional circular alpha mask. Uses crop.js helpers
// for the actual canvas math.
//
// Props:
//   { sourceFile,       // File object the customer picked
//     sourceUrl,        // OR a URL the customer pasted (CORS-fetched)
//     aspectRatio,      // e.g. 4/6 for box card, 1 for cake
//     outputW, outputH, // e.g. 1200/1800 for card, 2250/2250 for cake
//     mask,             // 'rect' or 'round'
//     title,            // header text
//     onSave(blob),     // called when user clicks Save
//     onCancel() }      // called on backdrop click / X / Cancel
function ImageCropper({sourceFile, sourceUrl, aspectRatio, outputW, outputH, mask, title, onSave, onCancel}) {
  const [imgEl, setImgEl] = useState(null);
  const [stageBox, setStageBox] = useState(null);   // {w, h, scale} of the displayed image
  const [rect, setRect] = useState(null);           // crop rect in source-image px
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');
  const stageRef = useRef();
  const dragRef = useRef(null);
  const moveRef = useRef(null);
  const upRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let blobUrl;
    (async () => {
      try {
        let url;
        if (sourceFile) {
          blobUrl = URL.createObjectURL(sourceFile);
          url = blobUrl;
        } else if (sourceUrl) {
          url = sourceUrl;
        } else {
          throw new Error('no sourceFile or sourceUrl');
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error('Image failed to load'));
          img.src = url;
        });
        if (cancelled) return;
        setImgEl(img);
        setRect(fitCropRect(img.naturalWidth, img.naturalHeight, aspectRatio));
      } catch (e) {
        if (!cancelled) setErr(e.message || String(e));
      }
    })();
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [sourceFile, sourceUrl, aspectRatio]);

  // After the <img> renders inside the stage, measure how it was scaled so
  // we can convert mouse pixels ↔ source pixels.
  function onImgLoad(e) {
    const stage = stageRef.current;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const pad = 18; // matches .cropper-stage padding in styles.css
    const maxW = stageRect.width - pad * 2;
    const maxH = stageRect.height - pad * 2;
    const sw = imgEl?.naturalWidth || e.target.naturalWidth;
    const sh = imgEl?.naturalHeight || e.target.naturalHeight;
    const scale = Math.min(maxW / sw, maxH / sh, 1);
    setStageBox({ w: sw * scale, h: sh * scale, scale });
  }

  function onMouseDown(e, mode, corner) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, corner, startX: e.clientX, startY: e.clientY, startRect: { ...rect } };
    moveRef.current = (ev) => onMouseMove(ev);
    upRef.current = () => onMouseUp();
    window.addEventListener('mousemove', moveRef.current);
    window.addEventListener('mouseup', upRef.current);
  }

  function onMouseMove(e) {
    const d = dragRef.current;
    if (!d || !stageBox || !imgEl) return;
    const dxImg = (e.clientX - d.startX) / stageBox.scale;
    const dyImg = (e.clientY - d.startY) / stageBox.scale;
    let { x, y, w, h } = d.startRect;

    if (d.mode === 'move') {
      x = clamp(x + dxImg, 0, imgEl.naturalWidth - w);
      y = clamp(y + dyImg, 0, imgEl.naturalHeight - h);
    } else {
      const sign = (d.corner === 'tl' || d.corner === 'bl') ? -1 : 1;
      let newW = clamp(d.startRect.w + sign * dxImg, 80, imgEl.naturalWidth);
      let newH = newW / aspectRatio;
      if (newH > imgEl.naturalHeight) { newH = imgEl.naturalHeight; newW = newH * aspectRatio; }
      if (d.corner === 'tl' || d.corner === 'bl') x = d.startRect.x + (d.startRect.w - newW);
      if (d.corner === 'tl' || d.corner === 'tr') y = d.startRect.y + (d.startRect.h - newH);
      x = clamp(x, 0, imgEl.naturalWidth - newW);
      y = clamp(y, 0, imgEl.naturalHeight - newH);
      w = newW;
      h = newH;
    }
    setRect({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  }

  function onMouseUp() {
    dragRef.current = null;
    if (moveRef.current) window.removeEventListener('mousemove', moveRef.current);
    if (upRef.current) window.removeEventListener('mouseup', upRef.current);
    moveRef.current = null;
    upRef.current = null;
  }

  useEffect(() => () => onMouseUp(), []);

  async function save() {
    if (!imgEl || !rect) return;
    setWorking(true); setErr('');
    try {
      const canvas = cropToCanvas(imgEl, rect, outputW, outputH, mask);
      const blob = await canvasToPngBlob(canvas);
      onSave(blob);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  const lowRes = rect && (rect.w * rect.h) < (outputW * outputH * 0.5);

  const overlay = (rect && stageBox) ? {
    left: 18 + rect.x * stageBox.scale,
    top: 18 + rect.y * stageBox.scale,
    width: rect.w * stageBox.scale,
    height: rect.h * stageBox.scale,
    borderRadius: mask === 'round' ? '9999px' : 0,
  } : null;

  return <div className="cropper-backdrop" onClick={onCancel}>
    <div className="cropper-modal" onClick={e => e.stopPropagation()}>
      <div className="cropper-header">
        <h3>{title}</h3>
        <button className="x" onClick={onCancel}>×</button>
      </div>
      <div className="cropper-stage" ref={stageRef}>
        {err && <div style={{color:'#fca5a5',fontSize:13,padding:20,textAlign:'center'}}>{err}</div>}
        {imgEl && !err && <img className="cropper-source"
          src={imgEl.src}
          onLoad={onImgLoad}
          style={{opacity:0.55}}
          draggable={false}/>}
        {overlay && <div className="cropper-rect" style={overlay}
          onMouseDown={e => onMouseDown(e, 'move')}>
          <span className="ratio">{ratioLabel(aspectRatio, mask)}</span>
          <span className="handle tl" onMouseDown={e => onMouseDown(e, 'resize', 'tl')}></span>
          <span className="handle tr" onMouseDown={e => onMouseDown(e, 'resize', 'tr')}></span>
          <span className="handle bl" onMouseDown={e => onMouseDown(e, 'resize', 'bl')}></span>
          <span className="handle br" onMouseDown={e => onMouseDown(e, 'resize', 'br')}></span>
        </div>}
      </div>
      <div className="cropper-footer">
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <span className="cropper-meta">Drag to choose what to keep · aspect locked</span>
          {lowRes && <span className="cropper-warn">Low resolution — print may be blurry</span>}
        </div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn-ghost" onClick={onCancel} disabled={working}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={working || !rect}>{working ? 'Saving…' : 'Save crop'}</button>
        </div>
      </div>
    </div>
  </div>;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function ratioLabel(a, mask) {
  if (mask === 'round') return '1 : 1 round (cake top)';
  if (Math.abs(a - 4/6) < 0.01) return '4 : 6 (box card)';
  return a.toFixed(2) + ' : 1';
}
