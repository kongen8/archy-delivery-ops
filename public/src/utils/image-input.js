// ===== IMAGE INPUT NORMALIZATION (Plan 5 polish) =====
// Single entry point used by every cake/card uploader. Takes whatever
// `<input type=file>` hands us and returns a clean image File ready for
// the cropper, or throws a user-facing error string.
//
// Supports: PNG, JPEG, WebP (passthrough); HEIC/HEIF (via window.heic2any);
// PDF page 1 (via window.pdfjsLib). Anything else is rejected.
//
// Why a runtime helper instead of just expanding accept=""?
//   - HEIC: native decoders only exist on Safari/iOS. Chrome/Firefox can't
//     render HEIC at all so the cropper would silently see a broken image.
//   - PDF: not an image format; PDF.js rasterizes page 1 to a canvas and
//     hands us back a PNG blob that the cropper can deal with.
//
// Both libs are loaded lazily from a CDN — they're hefty (~150 KB combined)
// so we don't pay for them on the wizard's first paint.

const HEIC_RE = /^image\/(heic|heif)$|\.(heic|heif)$/i;
const PDF_RE  = /^application\/pdf$|\.pdf$/i;
const IMG_RE  = /^image\/(png|jpe?g|webp)$/;

const HEIC2ANY_URL = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
const PDFJS_URL    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

const MAX_BYTES = 20 * 1024 * 1024;

async function loadScript(url) {
  if (loadScript._cache && loadScript._cache[url]) return loadScript._cache[url];
  loadScript._cache = loadScript._cache || {};
  loadScript._cache[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + url));
    document.head.appendChild(s);
  });
  return loadScript._cache[url];
}

async function convertHeic(file) {
  await loadScript(HEIC2ANY_URL);
  if (!window.heic2any) throw new Error('HEIC converter unavailable.');
  const blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  // heic2any can return a single Blob or an array; normalize to one.
  const out = Array.isArray(blob) ? blob[0] : blob;
  return new File([out], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
}

async function rasterizePdfPage1(file) {
  await loadScript(PDFJS_URL);
  if (!window.pdfjsLib) throw new Error('PDF reader unavailable.');
  // Worker URL must be set before any document load. Setting it every call
  // is a no-op if it already matches, so this stays cheap.
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  // Render at ~300dpi-equivalent so the cropper has high-res pixels to work
  // with. PDF point = 1/72 in, so scale=4 ≈ 288 dpi.
  const viewport = page.getViewport({ scale: 4 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  return new File([blob], file.name.replace(/\.pdf$/i, '_p1.png'), { type: 'image/png' });
}

async function normalizeUploadedImage(file) {
  if (!file) throw new Error('No file selected.');
  if (file.size > MAX_BYTES) {
    throw new Error('File too large — please use one under 20 MB.');
  }
  if (HEIC_RE.test(file.type) || HEIC_RE.test(file.name)) {
    return await convertHeic(file);
  }
  if (PDF_RE.test(file.type) || PDF_RE.test(file.name)) {
    return await rasterizePdfPage1(file);
  }
  if (!IMG_RE.test(file.type)) {
    throw new Error('Unsupported file type — please use PNG, JPG, WebP, HEIC, or PDF.');
  }
  return file;
}

if (typeof window !== 'undefined') window.normalizeUploadedImage = normalizeUploadedImage;
