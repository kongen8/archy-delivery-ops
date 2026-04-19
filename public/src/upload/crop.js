// ===== IMAGE CROP =====
// Plan 5 — pure helpers used by ImageCropper.jsx.
//
//   fitCropRect(sourceW, sourceH, aspect) → {x,y,w,h}
//     Initial crop rectangle: maximum-area rect of the requested aspect that
//     fits inside the source, centered.
//
//   cropToCanvas(sourceImgOrCanvas, srcRect, outputW, outputH, mask) → HTMLCanvasElement
//     Draws the requested source rectangle into a fresh canvas of the
//     requested output size. mask='round' applies a circular alpha mask
//     (transparent corners); mask='rect' is a plain rectangular crop.
//
// Both helpers are framework-free. The browser's built-in CanvasRenderingContext2D
// handles scaling for us via the 9-arg drawImage form.

function fitCropRect(sourceW, sourceH, aspect) {
  let w = sourceW;
  let h = Math.round(sourceW / aspect);
  if (h > sourceH) {
    h = sourceH;
    w = Math.round(sourceH * aspect);
  }
  return {
    x: Math.round((sourceW - w) / 2),
    y: Math.round((sourceH - h) / 2),
    w, h,
  };
}

function cropToCanvas(source, srcRect, outputW, outputH, mask) {
  const canvas = document.createElement('canvas');
  canvas.width = outputW;
  canvas.height = outputH;
  const ctx = canvas.getContext('2d');

  if (mask === 'round') {
    ctx.save();
    ctx.beginPath();
    const r = Math.min(outputW, outputH) / 2;
    ctx.arc(outputW / 2, outputH / 2, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  }

  ctx.drawImage(
    source,
    srcRect.x, srcRect.y, srcRect.w, srcRect.h,
    0, 0, outputW, outputH
  );

  if (mask === 'round') ctx.restore();

  return canvas;
}

// canvasToPngBlob is a thin promise wrapper around canvas.toBlob — only used
// in the browser, never under node tests, so we don't bother shimming it.
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('toBlob produced null')),
      'image/png'
    );
  });
}

if (typeof window !== 'undefined') {
  window.cropToCanvas = cropToCanvas;
  window.fitCropRect = fitCropRect;
  window.canvasToPngBlob = canvasToPngBlob;
}
