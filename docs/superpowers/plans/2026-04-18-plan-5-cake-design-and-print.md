# Plan 5 — Cake Design + Print Pipeline · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customer attaches a per-recipient cake-top image + box-card image to every recipient on a campaign (default + override), and the bakery sees, prints, and downloads those artifacts from a new Production tab in OpsView.

**Architecture:** Image-only design model. Two image URLs per design. Customer uploads → in-browser crop with locked aspect ratio (1:1 round for cake, 4:6 portrait for card) → upload to a new Supabase Storage bucket. Bakery's Production tab reads the merged design (`{...campaign.default_design, ...recipient.customizations}`), prints box cards via `window.print()` + CSS @media print, and downloads edible prints as a JSZip. No edge functions.

**Tech Stack:** React + babel-standalone, Supabase JS (storage + DB), JSZip (already in vendor), node:test for unit tests, Supabase MCP for migrations.

**Reference spec:** [`docs/superpowers/specs/2026-04-18-plan-5-cake-design-and-print-design.md`](../specs/2026-04-18-plan-5-cake-design-and-print-design.md)

---

## File Structure

**Created:**
- `supabase/migrations/009_cake_design.sql`
- `public/src/utils/design.js` — pure `mergeDesign()` helper
- `public/src/utils/__tests__/design.test.mjs` + `package.json`
- `public/src/upload/crop.js` — pure crop math + canvas helpers
- `public/src/upload/__tests__/crop.test.mjs` (extends existing test setup)
- `public/src/components/ImageCropper.jsx` — modal cropper
- `public/src/components/DesignsStep.jsx` — wizard Step 4
- `public/src/components/ProductionTab.jsx` — bakery grid + filters + bulk actions
- `public/src/components/BoxCardSheet.jsx` — print-only render component
- `public/src/utils/zip-prints.js` — JSZip wrapper

**Modified:**
- `public/index.html` — add new `<script>` tags
- `public/src/styles.css` — Step 4 styles, Production grid styles, `@media print` rules
- `public/src/db/customer.js` — add 4 design helpers
- `public/src/components/UploadWizard.jsx` — add Step 4 to rail; gate Finalize; update resume detection
- `public/src/components/BakeryHomeView.jsx` — add Production tab to the tab strip

---

## Task 1: Migration 009 — schema + Storage bucket + RLS

**Files:**
- Create: `supabase/migrations/009_cake_design.sql`
- Apply via Supabase MCP

- [ ] **Step 1: Write the migration file**

```sql
-- 009_cake_design.sql
-- Plan 5 — adds the campaign-level "default_design" jsonb column and creates
-- the public `cake-prints` Storage bucket where the customer's cropped cake
-- and box-card images live. Permissive RLS policies match the Plan 2 pivot
-- (every profile is trusted; no per-row owner check).
--
-- Idempotent: safe to re-run.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS default_design jsonb DEFAULT '{}'::jsonb NOT NULL;

INSERT INTO storage.buckets (id, name, public)
VALUES ('cake-prints', 'cake-prints', true)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "anyone can read cake-prints"
    ON storage.objects FOR SELECT TO public
    USING (bucket_id = 'cake-prints');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anyone can write cake-prints"
    ON storage.objects FOR INSERT TO public
    WITH CHECK (bucket_id = 'cake-prints');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anyone can update cake-prints"
    ON storage.objects FOR UPDATE TO public
    USING (bucket_id = 'cake-prints');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anyone can delete cake-prints"
    ON storage.objects FOR DELETE TO public
    USING (bucket_id = 'cake-prints');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

(`CREATE POLICY` doesn't accept `IF NOT EXISTS` in some Postgres versions; the `DO $$ ... EXCEPTION` blocks make this idempotent.)

- [ ] **Step 2: Apply via Supabase MCP**

Use the `apply_migration` tool with the SQL above. Migration name: `009_cake_design`.

Expected: success. Verify with the `list_migrations` MCP tool that 009 appears.

- [ ] **Step 3: Verify schema + bucket**

Use the `execute_sql` MCP tool:

```sql
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'campaigns' AND column_name = 'default_design';

SELECT id, name, public FROM storage.buckets WHERE id = 'cake-prints';

SELECT policyname FROM pg_policies
 WHERE tablename = 'objects' AND policyname LIKE '%cake-prints%';
```

Expected: column exists with `jsonb`/default `'{}'::jsonb`/not nullable; bucket row present + public; 4 policies listed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/009_cake_design.sql
git commit -m "Migration 009: campaigns.default_design + cake-prints Storage bucket"
```

---

## Task 2: `design.js` — pure mergeDesign helper + tests

**Files:**
- Create: `public/src/utils/design.js`
- Create: `public/src/utils/__tests__/design.test.mjs`
- Create: `public/src/utils/__tests__/package.json`

- [ ] **Step 1: Write the failing test**

`public/src/utils/__tests__/design.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../design.js'), 'utf8');
const ctx = {};
new Function('ctx', src + '\nctx.mergeDesign = mergeDesign;')(ctx);
const { mergeDesign } = ctx;

test('uses recipient values when both sides have them', () => {
  const out = mergeDesign(
    { cake_image_url: 'A_cake', card_image_url: 'A_card' },
    { cake_image_url: 'B_cake', card_image_url: 'B_card' });
  assert.deepEqual(out, { cake_image_url: 'B_cake', card_image_url: 'B_card' });
});

test('falls back to campaign default when recipient is missing a key', () => {
  const out = mergeDesign(
    { cake_image_url: 'A_cake', card_image_url: 'A_card' },
    { cake_image_url: 'B_cake' });
  assert.deepEqual(out, { cake_image_url: 'B_cake', card_image_url: 'A_card' });
});

test('treats null and "" as missing', () => {
  const out = mergeDesign(
    { cake_image_url: 'A_cake', card_image_url: 'A_card' },
    { cake_image_url: null, card_image_url: '' });
  assert.deepEqual(out, { cake_image_url: 'A_cake', card_image_url: 'A_card' });
});

test('returns null fields when nothing is set on either side', () => {
  const out = mergeDesign({}, {});
  assert.deepEqual(out, { cake_image_url: null, card_image_url: null });
});

test('handles undefined arguments without throwing', () => {
  const out = mergeDesign(undefined, undefined);
  assert.deepEqual(out, { cake_image_url: null, card_image_url: null });
});

test('ignores extra keys in either argument (e.g. Plan 3 skipped flag)', () => {
  const out = mergeDesign(
    { cake_image_url: 'A_cake', card_image_url: 'A_card', extra: 'x' },
    { skipped: true });
  assert.deepEqual(out, { cake_image_url: 'A_cake', card_image_url: 'A_card' });
});
```

`public/src/utils/__tests__/package.json`:

```json
{
  "name": "utils-tests",
  "type": "module",
  "private": true
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd public/src/utils/__tests__ && node --test design.test.mjs
```

Expected: FAIL with `ENOENT` because `../design.js` doesn't exist yet.

- [ ] **Step 3: Implement `design.js`**

`public/src/utils/design.js`:

```js
// ===== DESIGN MERGE =====
// Plan 5 — combine a campaign's default_design with a recipient's
// customizations to get the effective design for one cake.
//
// Inputs are jsonb-shaped: { cake_image_url?, card_image_url? }.
// Recipient values win except when null/""/missing — then we fall back to
// the campaign default. Extra keys on either side (e.g. Plan 3's `skipped`
// flag in customizations) are ignored — this helper only returns the
// design-relevant fields.
function mergeDesign(campaignDefault, recipientOverride) {
  const d = campaignDefault || {};
  const r = recipientOverride || {};
  return {
    cake_image_url: pick(r.cake_image_url, d.cake_image_url),
    card_image_url: pick(r.card_image_url, d.card_image_url),
  };
}

function pick(over, fallback) {
  if (over === null || over === undefined || over === '') {
    return (fallback === undefined || fallback === '') ? null : (fallback ?? null);
  }
  return over;
}

if (typeof window !== 'undefined') window.mergeDesign = mergeDesign;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd public/src/utils/__tests__ && node --test design.test.mjs
```

Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add public/src/utils/design.js public/src/utils/__tests__/
git commit -m "design.js: pure mergeDesign helper for campaign default + recipient override"
```

---

## Task 3: `crop.js` — pure crop math + canvas helpers

**Files:**
- Create: `public/src/upload/crop.js`
- Create: `public/src/upload/__tests__/crop.test.mjs`
- Modify: `public/src/upload/__tests__/package.json` (add `canvas` dev dep)

- [ ] **Step 1: Add `canvas` to test deps**

Edit `public/src/upload/__tests__/package.json`:

```json
{
  "name": "upload-tests",
  "type": "module",
  "private": true,
  "dependencies": {
    "xlsx": "^0.18.5",
    "canvas": "^2.11.2"
  }
}
```

Then:

```bash
cd public/src/upload/__tests__ && npm install
```

(Note: `node-canvas` requires Cairo on macOS; `brew install pkg-config cairo pango libpng jpeg giflib librsvg pixman` if `npm install` fails. Skip if the test machine is preconfigured.)

- [ ] **Step 2: Write the failing test**

`public/src/upload/__tests__/crop.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, ImageData } from 'canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// crop.js is a browser script — under node we shim the globals it touches.
globalThis.HTMLCanvasElement = function(){};
globalThis.document = { createElement: (tag) => tag === 'canvas' ? createCanvas(1,1) : null };

const src = fs.readFileSync(path.resolve(__dirname, '../crop.js'), 'utf8');
const ctx = {};
new Function('ctx', src + '\nctx.cropToCanvas = cropToCanvas;\nctx.fitCropRect = fitCropRect;')(ctx);
const { cropToCanvas, fitCropRect } = ctx;

test('fitCropRect centers a 4:6 rect inside a 1000x1000 source', () => {
  const r = fitCropRect(1000, 1000, 4 / 6);
  // 4:6 aspect = 2/3; max width is bounded by height: w = 1000 * 2/3 ≈ 666
  assert.equal(r.w, Math.round(1000 * (4/6)));
  assert.equal(r.h, 1000);
  assert.equal(r.x, Math.round((1000 - r.w) / 2));
  assert.equal(r.y, 0);
});

test('fitCropRect centers a 1:1 rect inside a wide 1600x900 source', () => {
  const r = fitCropRect(1600, 900, 1);
  // square fits inside the shorter dim (900)
  assert.equal(r.w, 900);
  assert.equal(r.h, 900);
  assert.equal(r.x, Math.round((1600 - 900) / 2));
  assert.equal(r.y, 0);
});

test('cropToCanvas produces a 200x300 PNG from a top-left 100x150 crop', async () => {
  const src = createCanvas(400, 600);
  const sctx = src.getContext('2d');
  sctx.fillStyle = '#ff0000';
  sctx.fillRect(0, 0, 400, 600);
  sctx.fillStyle = '#0000ff';
  sctx.fillRect(0, 0, 100, 150); // top-left blue square

  const out = cropToCanvas(src, { x: 0, y: 0, w: 100, h: 150 }, 200, 300, 'rect');
  assert.equal(out.width, 200);
  assert.equal(out.height, 300);
  // Verify the entire output is blue (since the crop area was 100% blue)
  const px = out.getContext('2d').getImageData(100, 150, 1, 1).data;
  assert.equal(px[2], 255); // blue channel
  assert.equal(px[0], 0);   // red channel
});

test('cropToCanvas with round mask leaves the center opaque and corners transparent', () => {
  const src = createCanvas(200, 200);
  src.getContext('2d').fillStyle = '#00ff00';
  src.getContext('2d').fillRect(0, 0, 200, 200);
  const out = cropToCanvas(src, { x: 0, y: 0, w: 200, h: 200 }, 100, 100, 'round');
  const center = out.getContext('2d').getImageData(50, 50, 1, 1).data;
  const corner = out.getContext('2d').getImageData(0, 0, 1, 1).data;
  assert.equal(center[3], 255, 'center pixel opaque');
  assert.equal(corner[3], 0, 'corner pixel transparent (clipped by circular mask)');
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd public/src/upload/__tests__ && node --test crop.test.mjs
```

Expected: FAIL — `crop.js` doesn't exist.

- [ ] **Step 4: Implement `crop.js`**

`public/src/upload/crop.js`:

```js
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
  // aspect = w / h. Take the larger of "fit by width" vs "fit by height".
  let w = sourceW, h = Math.round(sourceW / aspect);
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
    srcRect.x, srcRect.y, srcRect.w, srcRect.h,  // source rect
    0, 0, outputW, outputH                         // dest rect
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd public/src/upload/__tests__ && node --test crop.test.mjs
```

Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add public/src/upload/crop.js public/src/upload/__tests__/crop.test.mjs public/src/upload/__tests__/package.json public/src/upload/__tests__/package-lock.json
git commit -m "crop.js: pure cropToCanvas + fitCropRect helpers (round + rect masks)"
```

---

## Task 4: `customer.js` — design DB helpers

**Files:**
- Modify: `public/src/db/customer.js` — append 4 methods

- [ ] **Step 1: Read existing `customer.js`**

Note its style (the `Customer = {…}` object literal pattern, `if (!sb) throw` guard, `return data` shape).

- [ ] **Step 2: Add the 4 helpers as new methods on the `Customer` object**

Insert immediately before the `if (typeof window !== 'undefined') window.Customer = Customer;` line:

```js
  // ===== Plan 5 — design helpers =====

  async setCampaignDefaultDesign(campaign_id, design) {
    if (!sb) throw new Error('sb not ready');
    const { error } = await sb.from('campaigns')
      .update({ default_design: design || {} })
      .eq('id', campaign_id);
    if (error) throw error;
  },

  // Updates ONLY the design-relevant keys on a recipient's customizations
  // jsonb, preserving any other keys (e.g. Plan 3's `skipped: true`).
  async setRecipientOverride(recipient_id, design) {
    if (!sb) throw new Error('sb not ready');
    const { data: r, error: rErr } = await sb.from('recipients')
      .select('customizations').eq('id', recipient_id).single();
    if (rErr) throw rErr;
    const next = { ...(r?.customizations || {}) };
    if (design.cake_image_url === null || design.cake_image_url === '') delete next.cake_image_url;
    else if (design.cake_image_url !== undefined) next.cake_image_url = design.cake_image_url;
    if (design.card_image_url === null || design.card_image_url === '') delete next.card_image_url;
    else if (design.card_image_url !== undefined) next.card_image_url = design.card_image_url;
    const { error } = await sb.from('recipients')
      .update({ customizations: next }).eq('id', recipient_id);
    if (error) throw error;
  },

  async removeRecipientOverride(recipient_id) {
    return this.setRecipientOverride(recipient_id, { cake_image_url: null, card_image_url: null });
  },

  // Uploads a Blob to cake-prints/<campaign>/<kind>_<recipient|default>.png
  // and returns the public URL. Overwrites in place — Storage path is
  // deterministic so re-uploading a slot doesn't leave orphaned blobs.
  async uploadDesignAsset(campaign_id, kind, recipient_id_or_default, blob) {
    if (!sb) throw new Error('sb not ready');
    if (kind !== 'cake' && kind !== 'card') throw new Error('kind must be cake|card');
    const path = `${campaign_id}/${kind}_${recipient_id_or_default}.png`;
    const { error } = await sb.storage.from('cake-prints')
      .upload(path, blob, { upsert: true, contentType: 'image/png' });
    if (error) throw error;
    const { data } = sb.storage.from('cake-prints').getPublicUrl(path);
    // Cache-bust by appending a version query — Storage's public URL is
    // CDN-cached and a re-upload to the same path otherwise serves the
    // old image until the cache expires.
    return data.publicUrl + '?v=' + Date.now();
  },
```

- [ ] **Step 3: Smoke-test in the browser console**

Open the app at `http://localhost:8765/#/customer/<customerId>` (any draft campaign of that customer works). In DevTools console:

```js
const camp = (await sb.from('campaigns').select('id').limit(1)).data[0];
await Customer.setCampaignDefaultDesign(camp.id, { cake_image_url: 'TEST_URL' });
const c = (await sb.from('campaigns').select('default_design').eq('id', camp.id).single()).data;
console.log(c.default_design); // expected: { cake_image_url: 'TEST_URL' }
await Customer.setCampaignDefaultDesign(camp.id, {}); // cleanup
```

Expected: console logs the update; cleanup leaves campaign with `default_design = {}`.

- [ ] **Step 4: Commit**

```bash
git add public/src/db/customer.js
git commit -m "customer.js: add design helpers (set default, set/remove override, upload asset)"
```

---

## Task 5: `ImageCropper.jsx` — modal cropper component

**Files:**
- Create: `public/src/components/ImageCropper.jsx`
- Modify: `public/index.html` — add `<script>` tag for it
- Modify: `public/src/styles.css` — append cropper styles

- [ ] **Step 1: Append cropper CSS**

Append to `public/src/styles.css`:

```css
/* ===== ImageCropper modal (Plan 5) ===== */
.cropper-backdrop{position:fixed;inset:0;background:rgba(15,23,42,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px}
.cropper-modal{background:#fff;border-radius:12px;width:100%;max-width:760px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;overflow:hidden}
.cropper-header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #f3f4f6}
.cropper-header h3{margin:0;font-size:14px;font-weight:600}
.cropper-header .x{background:none;border:0;font-size:20px;color:#9ca3af;cursor:pointer;padding:0;line-height:1}
.cropper-stage{flex:1;background:#0f172a;display:flex;align-items:center;justify-content:center;padding:18px;position:relative;overflow:hidden;min-height:340px}
.cropper-source{max-width:100%;max-height:100%;display:block;user-select:none;-webkit-user-drag:none}
.cropper-rect{position:absolute;border:2px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.55);box-sizing:border-box;cursor:move}
.cropper-rect .ratio{position:absolute;top:-22px;left:50%;transform:translateX(-50%);background:#111;color:#fff;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;white-space:nowrap;pointer-events:none}
.cropper-rect .handle{position:absolute;width:12px;height:12px;background:#fff;border:1px solid #0f172a;box-sizing:border-box}
.cropper-rect .handle.tl{top:-6px;left:-6px;cursor:nwse-resize}
.cropper-rect .handle.tr{top:-6px;right:-6px;cursor:nesw-resize}
.cropper-rect .handle.bl{bottom:-6px;left:-6px;cursor:nesw-resize}
.cropper-rect .handle.br{bottom:-6px;right:-6px;cursor:nwse-resize}
.cropper-footer{padding:14px 18px;border-top:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center;gap:10px}
.cropper-meta{font-size:11px;color:#6b7280}
.cropper-warn{font-size:11px;color:#92400e;background:#fef3c7;padding:4px 10px;border-radius:4px}
```

- [ ] **Step 2: Implement `ImageCropper.jsx`**

`public/src/components/ImageCropper.jsx`:

```jsx
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

  // Load the source File or URL into an HTMLImageElement we control.
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
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Image failed to load')); img.src = url; });
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
    const pad = 18; // stage CSS padding
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
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
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
      // Resize from a corner with locked aspect ratio (driven by horizontal drag).
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
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

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

  // Convert source-px rect into stage-px for the overlay.
  const overlay = (rect && stageBox) ? {
    left: 18 + rect.x * stageBox.scale,
    top: 18 + rect.y * stageBox.scale,
    width: rect.w * stageBox.scale,
    height: rect.h * stageBox.scale,
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
```

- [ ] **Step 3: Add `<script>` tag in `public/index.html`**

Insert after the existing component scripts (e.g. after `UploadWizard.jsx`):

```html
<script type="text/babel" src="./src/components/ImageCropper.jsx"></script>
```

- [ ] **Step 4: Smoke-test in the browser**

Temporarily render the cropper from the DevTools console to confirm it works:

```js
ReactDOM.render(
  React.createElement(ImageCropper, {
    sourceUrl: 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=800',
    aspectRatio: 4/6, outputW: 1200, outputH: 1800, mask: 'rect',
    title: 'Test', onCancel: () => alert('cancel'), onSave: (b) => console.log('saved blob', b),
  }),
  document.body.appendChild(document.createElement('div'))
);
```

Expected: modal opens with the image, drag rectangle visible, dragging the rectangle moves it, dragging corners resizes it (aspect locked), Save logs a Blob.

- [ ] **Step 5: Commit**

```bash
git add public/src/components/ImageCropper.jsx public/index.html public/src/styles.css
git commit -m "ImageCropper: standalone modal cropper with locked aspect ratio + round/rect masks"
```

---

## Task 6: `DesignsStep.jsx` — wizard Step 4 (default slots) + UploadWizard integration

**Files:**
- Create: `public/src/components/DesignsStep.jsx`
- Modify: `public/index.html` — add `<script>` tag
- Modify: `public/src/styles.css` — append Step 4 styles
- Modify: `public/src/components/UploadWizard.jsx` — add Step 4 to rail; remove Finalize from Step 3; gate Finalize on default images present; update resume detection

- [ ] **Step 1: Append Step 4 CSS**

Append to `public/src/styles.css`:

```css
/* ===== Designs step (Plan 5) ===== */
.designs-step{display:flex;flex-direction:column;gap:24px;padding:24px 28px;flex:1}
.designs-step h2{font-size:16px;font-weight:600;margin:0}
.designs-step .subtle{margin:0;color:#6b7280;font-size:13px}
.designs-section-title{font-size:11px;font-weight:600;margin:0 0 10px;color:#374151;text-transform:uppercase;letter-spacing:.04em;display:flex;justify-content:space-between;align-items:center}
.designs-slots{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.designs-slot{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:10px}
.designs-slot-header{display:flex;justify-content:space-between;align-items:baseline}
.designs-slot-title{font-size:13px;font-weight:600;color:#111}
.designs-slot-spec{font-size:11px;color:#9ca3af}
.designs-canvas{flex:1;background:#fff;border:1px dashed #d1d5db;border-radius:6px;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;min-height:180px}
.designs-canvas img{max-width:100%;max-height:100%;display:block}
.designs-canvas img.round{border-radius:9999px}
.designs-canvas .empty{font-size:13px;color:#9ca3af;text-align:center;padding:14px}
.designs-canvas .empty .icon{font-size:30px;margin-bottom:6px}
.designs-canvas input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}
.designs-slot-actions{display:flex;gap:8px;justify-content:space-between;align-items:center}
.designs-slot-actions .left{display:flex;gap:6px;align-items:center}
.designs-slot-actions .right{font-size:10px;color:#9ca3af}
```

- [ ] **Step 2: Implement `DesignsStep.jsx`** (default slots only — overrides come in Task 7)

`public/src/components/DesignsStep.jsx`:

```jsx
// ===== DESIGNS STEP (Plan 5 · Wizard Step 4) =====
// Two upload slots for the campaign default (cake + card). Each slot opens
// the ImageCropper modal on file pick. Persists to campaigns.default_design.
// Per-recipient overrides land in Task 7 — for now this file owns just the
// default slots + the back/finalize footer.
function DesignsStep({campaign, customerId, onBack, onFinalize}) {
  const [design, setDesign] = useState(campaign.default_design || {});
  const [cropping, setCropping] = useState(null);   // {kind:'cake'|'card', file, sourceUrl}
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');

  function pickFile(kind, file) {
    setErr('');
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      setErr('Only PNG/JPG/WebP accepted.'); return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setErr('Image too large — please resize to under 20 MB.'); return;
    }
    setCropping({ kind, file });
  }

  async function onCropSave(blob) {
    const { kind } = cropping;
    setWorking(true); setErr('');
    try {
      const url = await Customer.uploadDesignAsset(campaign.id, kind, 'default', blob);
      const next = { ...design, [kind + '_image_url']: url };
      await Customer.setCampaignDefaultDesign(campaign.id, next);
      setDesign(next);
      setCropping(null);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  const hasCake = !!design.cake_image_url;
  const hasCard = !!design.card_image_url;
  const canFinalize = hasCake && hasCard;

  async function finalize() {
    setWorking(true); setErr('');
    try { await onFinalize(); } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  return <section className="designs-step">
    <div>
      <h2>Designs</h2>
      <p className="subtle">Upload one cake-top image and one box-card image. Drag a crop rectangle to fit. (Per-recipient overrides come in Task 7.)</p>
    </div>

    {err && <div className="wizard-err" style={{margin:0}}>{err}</div>}

    <div>
      <h3 className="designs-section-title">Campaign default</h3>
      <div className="designs-slots">
        <Slot kind="cake" title="Cake print" spec='7.5" round · 2250×2250' mask="round"
              url={design.cake_image_url} onPick={f => pickFile('cake', f)} working={working}/>
        <Slot kind="card" title="Box card"   spec='4×6 portrait · 1200×1800' mask="rect"
              url={design.card_image_url} onPick={f => pickFile('card', f)} working={working}/>
      </div>
    </div>

    <div className="wizard-footer">
      <button className="btn-ghost" onClick={onBack} disabled={working}>‹ Back to review</button>
      <div style={{flex:1, fontSize:12, color:'#6b7280', textAlign:'right', marginRight:8}}>
        {!hasCake && 'Cake image required · '}
        {!hasCard && 'Box card image required · '}
        {canFinalize && 'Both default images set'}
      </div>
      <button className="btn-primary" onClick={finalize} disabled={!canFinalize || working}>
        {working ? 'Finalizing…' : 'Finalize campaign'}
      </button>
    </div>

    {cropping && <ImageCropper
      sourceFile={cropping.file}
      aspectRatio={cropping.kind === 'cake' ? 1 : 4/6}
      outputW={cropping.kind === 'cake' ? 2250 : 1200}
      outputH={cropping.kind === 'cake' ? 2250 : 1800}
      mask={cropping.kind === 'cake' ? 'round' : 'rect'}
      title={'Crop · ' + (cropping.kind === 'cake' ? 'Cake print (1:1 round)' : 'Box card (4:6)')}
      onSave={onCropSave}
      onCancel={() => setCropping(null)}/>}
  </section>;
}

function Slot({kind, title, spec, mask, url, onPick, working}) {
  const inputRef = useRef();
  return <div className="designs-slot">
    <div className="designs-slot-header">
      <span className="designs-slot-title">{title}</span>
      <span className="designs-slot-spec">{spec}</span>
    </div>
    <div className={'designs-canvas'} onClick={() => inputRef.current?.click()}>
      {url
        ? <img className={mask === 'round' ? 'round' : ''} src={url} alt=""/>
        : <div className="empty"><div className="icon">⊕</div>Drop a PNG/JPG here<br/>or click to upload</div>}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp"
             onChange={e => onPick(e.target.files?.[0])}/>
    </div>
    <div className="designs-slot-actions">
      <div className="left">
        <button className="btn-ghost" disabled={working} onClick={() => inputRef.current?.click()}>
          {url ? 'Replace' : 'Upload & crop'}
        </button>
      </div>
      <span className="right">{url ? 'Cropped · stored in cake-prints' : 'Required'}</span>
    </div>
  </div>;
}
```

- [ ] **Step 3: Add `<script>` tag in `public/index.html`**

```html
<script type="text/babel" src="./src/components/DesignsStep.jsx"></script>
```

(Place after `ImageCropper.jsx` so DesignsStep can reference it.)

- [ ] **Step 4: Wire Step 4 into UploadWizard**

Edit `public/src/components/UploadWizard.jsx`:

(a) Add a 4th step to the rail in the `<aside>`:

```jsx
<WizardStepRail n={4} label="Designs" active={step===4} done={false}/>
```

(Update existing rail items so step 3 shows as `done` when `step > 3`.)

(b) Replace the Step 3 `<ReviewStep>` JSX prop `onBack={() => setStep(2)}` to also pass an `onContinue` that goes to step 4:

```jsx
{step === 3 && <ReviewStep
  campaign={campaign}
  customerId={customerId}
  ingestResult={ingestResult}
  onBack={() => setStep(2)}
  onContinue={() => setStep(4)}/>}

{step === 4 && <DesignsStep
  campaign={campaign}
  customerId={customerId}
  onBack={() => setStep(3)}
  onFinalize={async () => {
    await Customer.finalizeCampaign(campaign.id);
    navigate('#/customer/' + customerId);
  }}/>}
```

(c) Inside `ReviewStep`, replace the existing `Finalize campaign` button with `Continue to designs ›`:

```jsx
<button className="btn-primary" onClick={onContinue}>Continue to designs ›</button>
```

(Drop the `finalize`, `finalizing`, `setFinalizing` state from ReviewStep — finalize moves to DesignsStep.)

(d) Update resume detection in the existing `useEffect` so it lands on Step 4 when applicable:

```jsx
useEffect(() => {
  if (campaignId === 'new') return;
  (async () => {
    const { data: c } = await sb.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
    if (!c) return;
    setCampaign(c); setName(c.name || '');
    if (c.status === 'active') { navigate('#/customer/' + customerId); return; }
    const { count } = await sb.from('recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
    if ((count || 0) > 0) {
      // Recipients exist → skip File + Columns. Land on Designs (Step 4)
      // unless the customer wants to revisit Review — they can click ‹ Back.
      setStep(4);
    }
  })();
}, [campaignId, customerId]);
```

- [ ] **Step 5: Smoke-test the wizard in the browser**

Open the Archy customer's existing draft campaign. Expected:

- Wizard lands on Step 4 directly (recipients already exist).
- Two empty slots show "Upload & crop".
- "Finalize campaign" is disabled with the message "Cake image required · Box card image required".
- Picking a JPG opens the cropper. Saving uploads + closes the modal + slot now shows the round/rect preview.
- Repeat for the other slot. Once both are set, Finalize enables.
- Clicking Finalize navigates to CustomerHomeView and the campaign now shows status ACTIVE.

(Roll back the campaign to `draft` after testing: in Supabase MCP, `UPDATE campaigns SET status='draft', default_design='{}' WHERE id='<id>'` and delete the uploaded blobs from the bucket.)

- [ ] **Step 6: Commit**

```bash
git add public/src/components/DesignsStep.jsx public/src/components/UploadWizard.jsx public/index.html public/src/styles.css
git commit -m "DesignsStep: wizard Step 4 (default slots), Finalize gated on both images set"
```

---

## Task 7: Add-override modal + override list in DesignsStep

**Files:**
- Modify: `public/src/components/DesignsStep.jsx` — add `OverrideList` + `OverrideEditor` sections
- Modify: `public/src/styles.css` — append override list styles

- [ ] **Step 1: Append override list CSS**

Append to `public/src/styles.css`:

```css
.overrides-block{border:1px solid #e5e7eb;border-radius:8px;background:#fff}
.overrides-block .search{margin:12px 16px;width:calc(100% - 32px);padding:7px 12px;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;font-family:inherit}
.override-row{display:flex;gap:14px;align-items:center;padding:10px 16px;border-top:1px solid #f3f4f6}
.override-thumbs{display:flex;gap:6px;flex-shrink:0}
.override-thumbs .t{background:#f3f4f6;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:14px;color:#9ca3af}
.override-thumbs .t.cake{width:38px;height:38px;border-radius:9999px}
.override-thumbs .t.card{width:30px;height:38px;border-radius:4px}
.override-thumbs .t img{width:100%;height:100%;object-fit:cover}
.override-main{flex:1;min-width:0}
.override-main .who{font-size:13px;font-weight:600;color:#111}
.override-main .what{font-size:11px;color:#6b7280;margin-top:2px}
.override-actions button{margin-left:6px;background:#fff;color:#374151;border:1px solid #e5e7eb;padding:5px 10px;border-radius:6px;font-size:12px;cursor:pointer}
.overrides-empty{padding:24px;text-align:center;color:#9ca3af;font-size:13px;background:#fafafa;border-top:1px solid #f3f4f6}
.recipient-picker{max-height:340px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px;margin-top:10px}
.recipient-picker .row{padding:8px 12px;border-bottom:1px solid #f3f4f6;cursor:pointer;font-size:13px}
.recipient-picker .row:hover{background:#f9fafb}
.recipient-picker .row b{display:block}
.recipient-picker .row span{font-size:11px;color:#6b7280}
```

- [ ] **Step 2: Extend `DesignsStep.jsx` to load recipients and render the override section**

After the `setDesign(...)` call in `DesignsStep`, add recipient state and a loader:

```jsx
const [recipients, setRecipients] = useState([]);
const [editing, setEditing] = useState(null); // recipient row (or 'add')

const reload = useCallback(async () => {
  try { setRecipients(await Customer.listRecipients(campaign.id)); }
  catch (e) { setErr(e.message); }
}, [campaign.id]);

useEffect(() => { reload(); }, [reload]);

const overrideRecipients = recipients.filter(r =>
  (r.customizations?.cake_image_url) || (r.customizations?.card_image_url));
```

Then render the override block after the default slots block, before the `<wizard-footer>`:

```jsx
<div>
  <h3 className="designs-section-title">
    <span>Per-recipient overrides · {overrideRecipients.length} of {recipients.length}</span>
    <button className="btn-primary" style={{fontSize:12,padding:'6px 12px'}}
            onClick={() => setEditing('add')}>+ Add override</button>
  </h3>
  <div className="overrides-block">
    {overrideRecipients.length === 0
      ? <div className="overrides-empty">All recipients use the campaign default.</div>
      : overrideRecipients.map(r => <OverrideRow key={r.id} row={r}
          onEdit={() => setEditing(r)}
          onRemove={async () => {
            await Customer.removeRecipientOverride(r.id);
            // Also clean up the blobs (best-effort; bucket policy allows delete).
            const c = r.customizations || {};
            if (c.cake_image_url) sb.storage.from('cake-prints').remove([`${campaign.id}/cake_${r.id}.png`]).catch(()=>{});
            if (c.card_image_url) sb.storage.from('cake-prints').remove([`${campaign.id}/card_${r.id}.png`]).catch(()=>{});
            reload();
          }}/>)}
  </div>
</div>

{editing && <OverrideEditor
  campaign={campaign}
  initialRecipient={editing === 'add' ? null : editing}
  recipients={recipients}
  onClose={() => setEditing(null)}
  onSaved={() => { setEditing(null); reload(); }}/>}
```

(Update the footer summary line to:
```jsx
{recipients.length - overrideRecipients.length} use default · {overrideRecipients.length} use overrides
```
once `canFinalize` is true.)

- [ ] **Step 3: Implement `OverrideRow` and `OverrideEditor` in the same file**

```jsx
function OverrideRow({row, onEdit, onRemove}) {
  const c = row.customizations || {};
  return <div className="override-row">
    <div className="override-thumbs">
      <div className="t cake">{c.cake_image_url ? <img src={c.cake_image_url} alt=""/> : '–'}</div>
      <div className="t card">{c.card_image_url ? <img src={c.card_image_url} alt=""/> : '–'}</div>
    </div>
    <div className="override-main">
      <div className="who">{row.company || <em style={{color:'#9ca3af'}}>(no company)</em>}</div>
      <div className="what">
        {[c.cake_image_url && 'Cake', c.card_image_url && 'Card'].filter(Boolean).join(' + ')} overridden ·{' '}
        {[row.address, row.city].filter(Boolean).join(', ')}
      </div>
    </div>
    <div className="override-actions">
      <button onClick={onEdit}>Edit</button>
      <button onClick={onRemove}>Remove</button>
    </div>
  </div>;
}

// Two-mode modal: pick a recipient (if initialRecipient is null) → then show
// the same two slots as the default editor, scoped to that recipient.
function OverrideEditor({campaign, initialRecipient, recipients, onClose, onSaved}) {
  const [picked, setPicked] = useState(initialRecipient);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState(null);   // {cake_image_url, card_image_url}
  const [cropping, setCropping] = useState(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (picked) setDraft({
      cake_image_url: picked.customizations?.cake_image_url || null,
      card_image_url: picked.customizations?.card_image_url || null,
    });
  }, [picked?.id]);

  function pickFile(kind, file) {
    setErr('');
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setErr('Image too large — under 20 MB.'); return; }
    setCropping({ kind, file });
  }

  async function onCropSave(blob) {
    const { kind } = cropping;
    setWorking(true); setErr('');
    try {
      const url = await Customer.uploadDesignAsset(campaign.id, kind, picked.id, blob);
      const nextDraft = { ...draft, [kind + '_image_url']: url };
      setDraft(nextDraft);
      await Customer.setRecipientOverride(picked.id, nextDraft);
      setCropping(null);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  const filtered = recipients.filter(r =>
    !search || (r.company || '').toLowerCase().includes(search.toLowerCase())
            || (r.address || '').toLowerCase().includes(search.toLowerCase()));

  return <div className="cropper-backdrop" onClick={onClose}>
    <div className="cropper-modal" style={{maxWidth:680}} onClick={e => e.stopPropagation()}>
      <div className="cropper-header">
        <h3>{picked ? 'Override · ' + picked.company : 'Pick a recipient'}</h3>
        <button className="x" onClick={onClose}>×</button>
      </div>
      <div style={{padding:18, overflow:'auto'}}>
        {err && <div className="wizard-err" style={{margin:'0 0 12px'}}>{err}</div>}
        {!picked
          ? <>
              <input className="search" placeholder="Search by company or address…"
                     value={search} onChange={e => setSearch(e.target.value)}
                     style={{margin:0,width:'100%',padding:'7px 12px',border:'1px solid #e5e7eb',borderRadius:6,fontSize:13}}/>
              <div className="recipient-picker">
                {filtered.slice(0, 200).map(r => <div key={r.id} className="row" onClick={() => setPicked(r)}>
                  <b>{r.company}</b>
                  <span>{[r.address, r.city, r.state, r.zip].filter(Boolean).join(', ')}</span>
                </div>)}
                {filtered.length === 0 && <div className="overrides-empty">No matches.</div>}
              </div>
            </>
          : <div className="designs-slots">
              <Slot kind="cake" title="Cake print" spec='7.5" round' mask="round"
                    url={draft?.cake_image_url} onPick={f => pickFile('cake', f)} working={working}/>
              <Slot kind="card" title="Box card"   spec='4×6 portrait' mask="rect"
                    url={draft?.card_image_url} onPick={f => pickFile('card', f)} working={working}/>
            </div>}
      </div>
      <div className="cropper-footer">
        <span className="cropper-meta">
          {picked ? 'Override saves automatically as you crop.' : 'Pick a recipient to start an override.'}
        </span>
        <div style={{display:'flex',gap:8}}>
          <button className="btn-ghost" onClick={onClose}>Close</button>
          {picked && <button className="btn-primary" onClick={onSaved}>Done</button>}
        </div>
      </div>
    </div>
    {cropping && picked && <ImageCropper
      sourceFile={cropping.file}
      aspectRatio={cropping.kind === 'cake' ? 1 : 4/6}
      outputW={cropping.kind === 'cake' ? 2250 : 1200}
      outputH={cropping.kind === 'cake' ? 2250 : 1800}
      mask={cropping.kind === 'cake' ? 'round' : 'rect'}
      title={'Crop · ' + (cropping.kind === 'cake' ? 'Cake print' : 'Box card')}
      onSave={onCropSave}
      onCancel={() => setCropping(null)}/>}
  </div>;
}
```

- [ ] **Step 4: Smoke-test overrides**

Reload the wizard at Step 4. Expected:

- Override section shows "All recipients use the campaign default."
- Click "+ Add override" → modal opens with the recipient picker.
- Pick a recipient → modal switches to two slots.
- Upload + crop a cake image → slot fills with the round preview; the override row appears in the wizard's overrides list (visible behind the modal).
- Click Done → modal closes; the row shows in the list with the cake thumbnail.
- Click "Remove" on the row → row disappears + the recipient's `customizations` clears the design keys.

- [ ] **Step 5: Commit**

```bash
git add public/src/components/DesignsStep.jsx public/src/styles.css
git commit -m "DesignsStep: per-recipient override modal + list (picker + slots + remove)"
```

---

## Task 8: Production tab in `BakeryHomeView` + `ProductionTab.jsx` + `CakeCard`

**Files:**
- Create: `public/src/components/ProductionTab.jsx`
- Modify: `public/index.html` — add `<script>` tag
- Modify: `public/src/components/BakeryHomeView.jsx` — add Production tab + handler
- Modify: `public/src/styles.css` — append Production grid styles

- [ ] **Step 1: Append Production CSS**

Append to `public/src/styles.css`:

```css
/* ===== Production tab (Plan 5) ===== */
.production-toolbar{display:flex;justify-content:space-between;align-items:center;padding:14px 0;gap:14px;flex-wrap:wrap}
.production-toolbar .filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.production-toolbar .filter{background:#fff;border:1px solid #e5e7eb;color:#374151;padding:5px 11px;border-radius:999px;font-size:12px;cursor:pointer;font-family:inherit}
.production-toolbar .filter.active{background:#111;color:#fff;border-color:#111}
.production-toolbar .actions{display:flex;gap:8px}
.production-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}
.cake-card-prod{background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.cake-card-prod .images{display:grid;grid-template-columns:1fr 1fr}
.cake-card-prod .img-cell{aspect-ratio:1/1;background:#f3f4f6;display:flex;align-items:center;justify-content:center;position:relative;padding:14px;border-right:1px solid #f3f4f6}
.cake-card-prod .img-cell.card{aspect-ratio:2/3;padding:8px;background:#fafafa;border-right:0}
.cake-card-prod .img-cell .label{position:absolute;top:6px;left:6px;background:rgba(255,255,255,.85);color:#374151;font-size:9px;font-weight:600;padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em}
.cake-card-prod .img-cell img.round{width:100%;height:100%;border-radius:9999px;object-fit:cover}
.cake-card-prod .img-cell img.rect{width:100%;height:100%;object-fit:cover;border-radius:2px}
.cake-card-prod .img-cell .placeholder{font-size:24px;color:#cbd5e1}
.cake-card-prod .img-cell .badge{position:absolute;top:6px;right:6px;background:#fef2f2;color:#991b1b;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:4px}
.cake-card-prod .img-cell .badge.warn{background:#fef3c7;color:#92400e}
.cake-card-prod .body{padding:12px 14px;border-top:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center;gap:8px}
.cake-card-prod .body .left{min-width:0;flex:1}
.cake-card-prod .body .co{font-size:13px;font-weight:600;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cake-card-prod .body .addr{font-size:11px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cake-card-prod .body .source{font-size:9px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em;font-weight:600;flex-shrink:0}
.cake-card-prod .body .source.override{color:#7c3aed}
.cake-card-prod .body .source.partial{color:#d97706}
.cake-lightbox{position:fixed;inset:0;background:rgba(15,23,42,.85);z-index:1500;display:flex;align-items:center;justify-content:center;padding:32px;cursor:zoom-out}
.cake-lightbox img{max-width:100%;max-height:100%;background:#fff;border-radius:8px}
```

- [ ] **Step 2: Implement `ProductionTab.jsx`**

`public/src/components/ProductionTab.jsx`:

```jsx
// ===== PRODUCTION TAB (Plan 5) =====
// Bakery-side grid of recipients with their resolved cake + card designs.
// Reads recipients for the current bakery (across all active campaigns) +
// the campaigns' default_design rows; merges per-recipient via mergeDesign.
//
// Filters: Missing card / Missing cake / Overridden / All. No per-row edits
// (bakery is read-only on designs in v1).
//
// Bulk actions: Print all box cards (calls window.print() — actual print
// CSS lives in BoxCardSheet.jsx) + Download all edible prints (zip-prints.js).
function ProductionTab({bakeryId}) {
  const [rows, setRows] = useState([]);     // [{recipient, design, campaign}]
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data: recs, error: rErr } = await sb.from('recipients')
          .select('id, company, address, city, state, zip, customizations, campaign_id, assignment_status')
          .eq('bakery_id', bakeryId)
          .eq('assignment_status', 'assigned');
        if (rErr) throw rErr;
        const campIds = [...new Set((recs || []).map(r => r.campaign_id))];
        const { data: camps, error: cErr } = await sb.from('campaigns')
          .select('id, name, default_design').in('id', campIds);
        if (cErr) throw cErr;
        const campMap = Object.fromEntries((camps || []).map(c => [c.id, c]));
        setRows((recs || []).map(r => {
          const camp = campMap[r.campaign_id];
          const design = mergeDesign(camp?.default_design, r.customizations);
          const cakeOverride = !!r.customizations?.cake_image_url;
          const cardOverride = !!r.customizations?.card_image_url;
          return { recipient: r, design, campaign: camp, cakeOverride, cardOverride };
        }));
      } catch (e) { setErr(e.message || String(e)); }
      setLoading(false);
    })();
  }, [bakeryId]);

  const counts = {
    all: rows.length,
    missing_cake: rows.filter(x => !x.design.cake_image_url).length,
    missing_card: rows.filter(x => !x.design.card_image_url).length,
    overridden: rows.filter(x => x.cakeOverride || x.cardOverride).length,
  };

  const visible = rows.filter(x => {
    if (filter === 'all') return true;
    if (filter === 'missing_cake') return !x.design.cake_image_url;
    if (filter === 'missing_card') return !x.design.card_image_url;
    if (filter === 'overridden') return x.cakeOverride || x.cardOverride;
    return true;
  });

  function printBoxCards() {
    const visibleWithCard = visible.filter(x => x.design.card_image_url);
    if (visibleWithCard.length === 0) return alert('No box cards to print in this filter.');
    window.__BOX_CARD_PRINT_ROWS__ = visibleWithCard.map(x => x.design.card_image_url);
    window.dispatchEvent(new Event('plan5:print-box-cards'));
  }

  async function downloadEdibleZip() {
    const withCake = visible.filter(x => x.design.cake_image_url);
    if (withCake.length === 0) return alert('No edible prints to download in this filter.');
    try {
      await zipEdiblePrints(withCake);
    } catch (e) { setErr(e.message || String(e)); }
  }

  if (loading) return <div style={{padding:24,color:'#9ca3af'}}>Loading…</div>;
  if (err) return <div className="wizard-err">{err}</div>;

  return <div>
    <div className="production-toolbar">
      <div className="filters">
        <button className={'filter' + (filter==='all'?' active':'')} onClick={() => setFilter('all')}>All · {counts.all}</button>
        <button className={'filter' + (filter==='missing_card'?' active':'')} onClick={() => setFilter('missing_card')}>Missing card · {counts.missing_card}</button>
        <button className={'filter' + (filter==='missing_cake'?' active':'')} onClick={() => setFilter('missing_cake')}>Missing cake · {counts.missing_cake}</button>
        <button className={'filter' + (filter==='overridden'?' active':'')} onClick={() => setFilter('overridden')}>Overridden · {counts.overridden}</button>
      </div>
      <div className="actions">
        <button className="btn-ghost" onClick={downloadEdibleZip}>↓ Download edible prints (.zip)</button>
        <button className="btn-primary" onClick={printBoxCards}>🖨 Print box cards</button>
      </div>
    </div>

    {visible.length === 0
      ? <div style={{padding:32,textAlign:'center',color:'#9ca3af'}}>Nothing matches this filter.</div>
      : <div className="production-grid">
          {visible.map(x => <CakeCardProd key={x.recipient.id} row={x} onLightbox={setLightbox}/>)}
        </div>}

    {lightbox && <div className="cake-lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt=""/></div>}
  </div>;
}

function CakeCardProd({row, onLightbox}) {
  const {recipient: r, design, cakeOverride, cardOverride} = row;
  const sourceLabel = cakeOverride && cardOverride ? 'Override' :
                      cakeOverride ? 'Cake override' :
                      cardOverride ? 'Card override' : 'Default';
  const sourceCls = cakeOverride && cardOverride ? 'override' :
                    (cakeOverride || cardOverride) ? 'partial' : '';
  return <div className="cake-card-prod">
    <div className="images">
      <div className="img-cell" onClick={() => design.cake_image_url && onLightbox(design.cake_image_url)} style={{cursor: design.cake_image_url ? 'zoom-in' : 'default'}}>
        <span className="label">Cake</span>
        {cakeOverride && <span className="badge warn">Override</span>}
        {design.cake_image_url
          ? <img className="round" src={design.cake_image_url} alt=""/>
          : (<><span className="badge">Missing</span><span className="placeholder">🎂</span></>)}
      </div>
      <div className="img-cell card" onClick={() => design.card_image_url && onLightbox(design.card_image_url)} style={{cursor: design.card_image_url ? 'zoom-in' : 'default'}}>
        <span className="label">Card</span>
        {cardOverride && <span className="badge warn">Override</span>}
        {design.card_image_url
          ? <img className="rect" src={design.card_image_url} alt=""/>
          : (<><span className="badge">Missing</span><span className="placeholder">🖼</span></>)}
      </div>
    </div>
    <div className="body">
      <div className="left">
        <div className="co">{r.company}</div>
        <div className="addr">{[r.address, r.city].filter(Boolean).join(' · ')}</div>
      </div>
      <span className={'source ' + sourceCls}>{sourceLabel}</span>
    </div>
  </div>;
}
```

(`zipEdiblePrints` lives in `zip-prints.js`, implemented in Task 10. For Task 8 the button will throw `ReferenceError`; that's expected.)

- [ ] **Step 3: Wire Production tab into `BakeryHomeView.jsx`**

In `BakeryHomeView.jsx`, edit the tab array (line ~118):

```jsx
{[{k:'ops',l:'Operations'},{k:'map',l:'🧁 Map'},{k:'customer',l:'Campaign'},{k:'photos',l:'Photos'},{k:'production',l:'Production'}].map(t=>
```

Then add a new view branch after the `{view==='photos'&&…}` line:

```jsx
{view==='production'&&<ProductionTab bakeryId={bakeryId}/>}
```

(The existing `bakeryId` prop on `BakeryHomeView` is already in scope.)

- [ ] **Step 4: Add `<script>` tag in `public/index.html`**

```html
<script type="text/babel" src="./src/components/ProductionTab.jsx"></script>
```

(Place after `BakeryHomeView.jsx` in the script order doesn't matter — they're both loaded before App boots — but keep components together.)

- [ ] **Step 5: Smoke-test the Production tab**

Switch to the Boho Petite bakery profile. Open OpsView → click the new "Production" tab. Expected:

- Grid of cake cards for every recipient assigned to this bakery, across active campaigns.
- For the Archy campaign (with default images set in Task 6), every card shows the round + 4×6 thumbnails.
- "All · N" filter chip shows the recipient count; clicking other filters narrows the list.
- Clicking a thumbnail opens the lightbox; clicking the lightbox closes it.
- The "Print box cards" and "Download edible prints" buttons render but the latter throws `ReferenceError: zipEdiblePrints is not defined` in console — wired in Task 10.

- [ ] **Step 6: Commit**

```bash
git add public/src/components/ProductionTab.jsx public/src/components/BakeryHomeView.jsx public/index.html public/src/styles.css
git commit -m "ProductionTab: bakery-side grid of merged designs + filters + lightbox"
```

---

## Task 9: `BoxCardSheet.jsx` + print CSS + "Print box cards" wiring

**Files:**
- Create: `public/src/components/BoxCardSheet.jsx`
- Modify: `public/index.html` — add `<script>` tag
- Modify: `public/src/styles.css` — append `@media print` rules

- [ ] **Step 1: Append print CSS**

Append to `public/src/styles.css`:

> **Spec deviation:** the spec calls for "8 per letter sheet" at 4×6 portrait, which is geometrically impossible (8 × 4×6 = 192 sq in, letter usable area at 0.25" margins = 8 × 10.5 = 84 sq in). This task uses **4 per page** in a 2×2 grid (each cell 4 in × 5 in — slightly shorter than 4×6, which is fine because the card image is `background-size: cover`). Note this in the commit message.

Append to `public/src/styles.css`:

```css
/* ===== Box card print sheet (Plan 5) ===== */
.box-card-sheet{display:none}
@page { size: letter; margin: 0.25in; }
@media print {
  body > *:not(.box-card-sheet){display:none !important;}
  .box-card-sheet{display:grid !important;
    grid-template-columns:1fr 1fr;
    grid-template-rows:1fr 1fr;
    gap:0;
    width:8in;height:10.5in;}
  .box-card-sheet .card{
    width:4in;height:5in;
    background-size:cover;background-position:center;
    position:relative;
    box-sizing:border-box;
    border:1px dashed #d1d5db;}
  .box-card-sheet .card > .cut-tl,
  .box-card-sheet .card > .cut-tr,
  .box-card-sheet .card > .cut-bl,
  .box-card-sheet .card > .cut-br{
    position:absolute;width:0.1in;height:0.1in;
    border:1pt solid #000;}
  .box-card-sheet .card > .cut-tl{top:-1px;left:-1px;border-right:0;border-bottom:0;}
  .box-card-sheet .card > .cut-tr{top:-1px;right:-1px;border-left:0;border-bottom:0;}
  .box-card-sheet .card > .cut-bl{bottom:-1px;left:-1px;border-right:0;border-top:0;}
  .box-card-sheet .card > .cut-br{bottom:-1px;right:-1px;border-left:0;border-top:0;}
  /* New page after every 4 cards. */
  .box-card-sheet .card:nth-child(4n+1):not(:first-child){page-break-before:always;}
}
```

- [ ] **Step 2: Implement `BoxCardSheet.jsx`**

`public/src/components/BoxCardSheet.jsx`:

```jsx
// ===== BOX CARD SHEET (Plan 5) =====
// Render-only component: a fixed div that's hidden on screen and visible
// only under @media print. Listens for 'plan5:print-box-cards' events
// dispatched by ProductionTab, reads window.__BOX_CARD_PRINT_ROWS__ for
// the list of card image URLs, populates the grid, then calls window.print().
function BoxCardSheet() {
  const [urls, setUrls] = useState([]);

  useEffect(() => {
    function onPrint() {
      const list = window.__BOX_CARD_PRINT_ROWS__ || [];
      setUrls(list);
      // Defer print() so React paints the new <div> first.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.print();
        // Clear after a tick so the screen doesn't blink-display the cards.
        setTimeout(() => setUrls([]), 500);
      }));
    }
    window.addEventListener('plan5:print-box-cards', onPrint);
    return () => window.removeEventListener('plan5:print-box-cards', onPrint);
  }, []);

  if (urls.length === 0) return null;

  return <div className="box-card-sheet">
    {urls.map((u, i) => <div key={i} className="card" style={{backgroundImage: `url("${u}")`}}>
      <span className="cut-tl"/><span className="cut-tr"/><span className="cut-bl"/><span className="cut-br"/>
    </div>)}
  </div>;
}
```

- [ ] **Step 3: Add `<script>` tag in `public/index.html` AND mount it globally**

```html
<script type="text/babel" src="./src/components/BoxCardSheet.jsx"></script>
```

In `App.jsx`, mount `<BoxCardSheet/>` once at the root so it's always alive to receive the event. Add it inside the `App` component's return, as a sibling of the route switch:

```jsx
function App(){
  // ... existing state/route ...
  return <>
    <BoxCardSheet/>
    {/* existing routing JSX */}
  </>;
}
```

(If the existing return isn't a fragment, wrap it.)

- [ ] **Step 4: Smoke-test box card printing**

In the Production tab, click "🖨 Print box cards". Expected:

- Browser print dialog opens.
- Preview shows the resolved card images, 4 per letter page, with cut marks at the corners.
- Cancel the dialog → screen returns to the Production tab unchanged.
- Click "Save as PDF" in the dialog → PDF has every visible recipient's card image, in the order they appear in the grid.

Edge: filter to "Missing card" → click Print → alert "No box cards to print in this filter."

- [ ] **Step 5: Commit**

```bash
git add public/src/components/BoxCardSheet.jsx public/src/components/App.jsx public/index.html public/src/styles.css
git commit -m "BoxCardSheet: 4-up letter print template, triggered by Production tab event"
```

---

## Task 10: `zip-prints.js` + "Download all edible prints" wiring

**Files:**
- Create: `public/src/utils/zip-prints.js`
- Modify: `public/index.html` — add `<script>` tag
- (`ProductionTab.jsx` already calls `zipEdiblePrints(...)` — no change there)

- [ ] **Step 1: Implement `zip-prints.js`**

`public/src/utils/zip-prints.js`:

```js
// ===== ZIP EDIBLE PRINTS (Plan 5) =====
// Bakery-side helper. Takes an array of {recipient, design, campaign} rows
// (only those with a resolved cake_image_url), fetches each PNG, zips them
// with safe filenames, and triggers a browser download.
//
// Naming: <ordinal>_<safe-company>_<recipient_id_short>.png — ordinal lets
// the bakery sort by delivery order in their printer's queue UI.
async function zipEdiblePrints(rows) {
  if (!window.JSZip) throw new Error('JSZip not loaded — check public/index.html');
  const zip = new window.JSZip();
  let added = 0;
  await Promise.all(rows.map(async (x, i) => {
    const url = x.design.cake_image_url;
    if (!url) return;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const safe = (x.recipient.company || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 32);
      const ord = String(i + 1).padStart(3, '0');
      zip.file(`${ord}_${safe}_${x.recipient.id.slice(0, 8)}.png`, blob);
      added++;
    } catch (e) {
      console.warn('zip-prints: skipped', x.recipient.id, e.message);
    }
  }));
  if (added === 0) throw new Error('No images could be fetched.');
  const out = await zip.generateAsync({ type: 'blob' });
  const campName = rows[0]?.campaign?.name || 'campaign';
  const safeCamp = campName.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  triggerBrowserDownload(out, `${safeCamp}_edible_prints.zip`);
  return added;
}

function triggerBrowserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
}

if (typeof window !== 'undefined') window.zipEdiblePrints = zipEdiblePrints;
```

- [ ] **Step 2: Add `<script>` tag in `public/index.html`**

Place AFTER the existing `jszip.min.js` CDN (so JSZip is available when zip-prints.js loads):

```html
<script src="./src/utils/zip-prints.js"></script>
```

- [ ] **Step 3: Smoke-test the zip download**

In the Production tab, click "↓ Download edible prints (.zip)". Expected:

- Browser downloads `<campaign-name>_edible_prints.zip`.
- Open the zip — contains one PNG per recipient with a resolved cake image. Filenames like `001_Acme_Dental_Group_a3b1c4f2.png`.
- Each PNG is the round 2250×2250 cake image with transparent corners.

Edge: filter to "Missing cake" → click Download → alert "No edible prints to download in this filter." (Or, if all visible rows lack a cake URL, the function throws "No images could be fetched.")

- [ ] **Step 4: Commit**

```bash
git add public/src/utils/zip-prints.js public/index.html
git commit -m "zip-prints.js: zip + download bakery-side edible prints with safe filenames"
```

---

## Task 11: End-to-end smoke + cleanup

**Files:** none modified — verification only.

- [ ] **Step 1: Run all unit tests**

```bash
cd public/src/utils/__tests__ && node --test design.test.mjs
cd public/src/upload/__tests__ && node --test parse.test.mjs columns.test.mjs crop.test.mjs
cd ../../../scripts/admin-db && node --test admin-db.test.js
cd ../../supabase/functions/ingest-recipients && deno test --config deno.json --allow-net --allow-env --env-file=../../../.env test.ts
```

Expected: every suite green. (Plan 3's ignored AI test stays ignored.)

- [ ] **Step 2: Customer end-to-end**

In Chrome, on the running app:

1. Profile-pick the Archy customer.
2. Click "+ Upload campaign". Name it "Plan 5 smoke". Upload a small CSV (5 rows of valid SF addresses).
3. Walk through Steps 1 → 2 → 3 → 4.
4. In Step 4: upload a cake image (any PNG/JPG), drag the crop, save. Repeat for the box card.
5. Click "+ Add override", pick a recipient, upload a different cake image, save.
6. Click Finalize.

Expected: campaign appears in CustomerHomeView with status `ACTIVE`.

- [ ] **Step 3: Bakery end-to-end**

Profile-pick Boho Petite. Open OpsView → Production tab.

Expected: the smoke campaign's recipients appear with their merged designs. The overridden recipient shows "Cake override" badge. Click "Print box cards" → preview shows the right images. Click "Download edible prints" → zip downloads with the right number of PNGs.

- [ ] **Step 4: Cleanup**

Delete the smoke campaign + its recipients via Supabase MCP, and the bucket blobs:

```sql
DELETE FROM recipients WHERE campaign_id = '<smoke-campaign-id>';
DELETE FROM campaigns  WHERE id = '<smoke-campaign-id>';
```

```js
// In DevTools console while on the app:
await sb.storage.from('cake-prints').remove([
  '<smoke-campaign-id>/cake_default.png',
  '<smoke-campaign-id>/card_default.png',
  // …+ any per-recipient overrides
]);
```

- [ ] **Step 5: Final commit**

If smoke surfaces any small fixes (typos, copy, off-by-one), apply them and commit. Otherwise:

```bash
git log --oneline -15  # sanity check that all 11 task commits are present
```

Plan 5 is complete.
