# Plan 5 — Cake Design + Print Pipeline · Design Spec

Status: brainstormed 2026-04-18 · pending user review · supersedes the "out of scope" line in `2026-04-18-multi-tenant-delivery-platform-design.md` ("cake type/design selection, per-cake print upload" is now in scope).

## Goal

Let customers attach a per-recipient cake design + box card design to every recipient on a campaign — set once as a campaign default, optionally overridden per recipient — and let bakeries see/print/download those artifacts in their existing OpsView. The customer designs the artwork themselves (Canva, Figma, whatever); the system handles upload, crop-to-spec, storage, per-recipient resolution, box-card sheet printing, and edible-print ZIP download.

## Guiding Decisions

1. **Image-only design.** No `message` field, no `signoff`, no system-rendered text. Each "design" is two image URLs: one for the cake top (round) and one for the box card (4×6). All personalization happens by uploading a different image for that recipient.
2. **Default + override merge.** `campaigns.default_design` jsonb at the campaign level; `recipients.customizations` jsonb at the recipient level. Effective design at read time = `{ ...campaign.default_design, ...recipient.customizations }`. A null/missing field on the recipient falls back to the default.
3. **Crop happens in the browser, at upload time.** Customer uploads a raw image → drags a locked-aspect-ratio rectangle (4:6 for card, 1:1 for cake) → confirms. We compute the crop, render to a canvas at the target DPI, upload the resulting PNG to Supabase Storage. The bakery downstream sees a print-ready asset.
4. **Cropper opens as a modal**, not inline. Stacking inline croppers in a 50-row override list would be unusable. Modal hosts the source image + the crop rectangle + Save/Cancel.
5. **Wizard gains Step 4 "Designs"** — sits between "Review" and "Finalize". Resume detection: if `campaign.status='draft'` and recipients exist, jumping into the wizard lands on Step 4 (Step 3 is reachable via "‹ Back to review").
6. **Bakery surface is a new "Production" tab in OpsView** — sibling to Routes/Photos. Grid of cards (cake + card thumbnails per recipient), filters for missing pieces, two bulk actions: "Print all box cards" (browser print) and "Download all edible prints" (ZIP).
7. **Print artifacts are dumb tilers.** Box card PDF/HTML = the customer's pre-cropped card image, tiled 8 per letter sheet, with cut marks. Edible print ZIP = the customer's pre-cropped cake images, one PNG per recipient. No system-side compositing at print time.
8. **Asset storage = new Supabase Storage bucket `cake-prints`**, public read, permissive write (Plan 2 pivot pattern). Pathing: `<campaign_id>/<cake|card>_<recipient_id|default>.png`.
9. **One required image per design.** A campaign cannot be finalized until both `default_design.cake_image_url` and `default_design.card_image_url` are set. Per-recipient overrides are optional. (We don't want a cake going out with no edible print and no box card.)
10. **Bakery is read-only on designs.** No bakery-side editing in v1; if the artwork is wrong, the bakery contacts the customer to re-upload. Bakery editing requires merging UX between two tenants and is deferred.

## Architecture

```
Browser (customer profile)              Supabase
─────────────────────────────           ──────────────────────────────
UploadWizard                            campaigns
  Step 4 · Designs (NEW)                  + default_design jsonb        ← migration 008
    ├─ default cake slot                recipients.customizations jsonb (existing)
    ├─ default card slot                  → { cake_image_url?, card_image_url? }
    └─ override list
         + add-override modal           cake-prints/  ← new Storage bucket (public)
                                          <campaignId>/cake_default.png
ImageCropper (NEW component)              <campaignId>/cake_<recipientId>.png
  source <img> + drag-rect overlay        <campaignId>/card_default.png
  → canvas → blob → Storage upload        <campaignId>/card_<recipientId>.png

Browser (bakery profile)
─────────────────────────────
OpsView
  └─ Production tab (NEW)
       grid of {recipient, effective design}
       "Print all box cards"  → BoxCardSheet (CSS @media print, tiles 8/page)
       "Download all edible prints" → ZIP via JSZip (cake images only)
```

No new edge functions. No new external services. The existing `ingest-recipients` function does not change. The existing `delivery-areas` / `bakeries` / `customers` tables do not change.

### Component map

- `public/src/components/UploadWizard.jsx` (modify) — add Step 4 to the rail; add `DesignsStep` section; gate the Finalize button on default images being present.
- `public/src/components/DesignsStep.jsx` (new) — Step 4 contents. Owns local state for default + override edits, persists to `campaigns.default_design` / `recipients.customizations` on save.
- `public/src/components/ImageCropper.jsx` (new) — modal with the crop UI. Props: `{ sourceFile, aspectRatio, outputW, outputH, output: 'rect' | 'round', onSave(blob), onCancel }`.
- `public/src/upload/crop.js` (new, pure) — `cropToCanvas(sourceImage, sourceRect, outputW, outputH, mask) → HTMLCanvasElement` and `canvasToPng(canvas) → Promise<Blob>`. Unit-tested with node-canvas fixtures.
- `public/src/db/customer.js` (modify) — add `setCampaignDefaultDesign(campaignId, design)`, `setRecipientOverride(recipientId, design)`, `removeRecipientOverride(recipientId)`, `uploadDesignAsset(campaignId, kind, recipientIdOrDefault, blob) → publicUrl`.
- `public/src/components/BakeryHomeView.jsx` / `OpsView` (modify) — add Production tab to the existing tab strip.
- `public/src/components/ProductionTab.jsx` (new) — grid of `<CakeCard>`s, filter chips, bulk action toolbar.
- `public/src/components/BoxCardSheet.jsx` (new) — render-only component for the print sheet (uses `@media print` from `styles.css`). Mounted in a hidden div; clicking "Print all box cards" calls `window.print()` after we set a flag that hides everything except this component.
- `public/src/utils/design.js` (new, pure) — `mergeDesign(campaignDefault, recipientOverride) → { cake_image_url, card_image_url }`. Unit-tested.
- `public/src/utils/zip-prints.js` (new) — small wrapper around the JSZip vendor lib that fetches every cake image URL, names each entry `<safe-company>__<recipient-id-short>.png`, and triggers a browser download.
- `supabase/migrations/008_cake_design.sql` (new) — adds the two columns + creates the storage bucket via `INSERT INTO storage.buckets`.

### Wizard flow update

| Step | Existing | Change |
|---|---|---|
| 1 · File | unchanged | — |
| 2 · Columns | unchanged | — |
| 3 · Review | unchanged content | "Finalize campaign" button is removed; replaced with "Continue to designs ›" |
| **4 · Designs** (NEW) | — | Two default-image slots + override list + footer with "‹ Back to review" and "Finalize campaign" |

Resume detection (already in `UploadWizard.jsx`):

- `campaign.status='draft'` + 0 recipients → Step 1
- `campaign.status='draft'` + recipients exist + (default_design.cake or card missing) → **Step 4** (was Step 3)
- `campaign.status='draft'` + recipients exist + both default images set → Step 4 (lets the customer add overrides)
- `campaign.status='active'` → kick back to CustomerHomeView (campaign already shipped)

(Current behavior of jumping to Step 3 if recipients exist gets changed to jumping to Step 4 instead. Step 3 stays accessible from Step 4 via "‹ Back to review".)

### Step 4 layout

```
┌──────────────────────────────────────────────────────────────┐
│  Designs                                                      │
│  Upload one cake-top image and one box-card image.            │
│                                                               │
│  CAMPAIGN DEFAULT                                             │
│  ┌────────────┐  ┌────────────┐                               │
│  │ Cake print │  │ Box card   │                               │
│  │ (round)    │  │ (4×6)      │                               │
│  │ [preview]  │  │ [preview]  │                               │
│  │ Re-crop /  │  │ Re-crop /  │                               │
│  │ Replace    │  │ Replace    │                               │
│  └────────────┘  └────────────┘                               │
│                                                               │
│  PER-RECIPIENT OVERRIDES · 0 of 124       [+ Add override]    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ [search recipients…]                                  │    │
│  │                                                       │    │
│  │ (empty until customer clicks Add override)            │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  [‹ Back to review]   124 use default · 0 overrides   [Finalize] │
└──────────────────────────────────────────────────────────────┘
```

The "Add override" modal is a small picker: search recipients by company/contact/address (re-uses the existing `Customer.listRecipients` query, filters client-side), pick one, opens an editor that's the same shape as the default-design slot pair (two upload slots), Save persists `recipients.customizations` for that row.

### Production tab layout (bakery side)

```
┌──────────────────────────────────────────────────────────────────┐
│ Routes  Photos  Production                                        │
├──────────────────────────────────────────────────────────────────┤
│ [All · 124] [Day 1 · 31] [Missing card · 0] [Missing cake · 2]   │
│ [Overridden · 2]                                                  │
│                            [↓ Download edible prints] [🖨 Print box cards] │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐    │
│ │ ⚪round  ▭rect  │ │ ⚪round  ▭rect  │ │ ⚪round  ▭rect  │    │
│ │ Acme Dental     │ │ Lee Family Dent │ │ Stanford Pediatr│    │
│ │ 330 Main St     │ │ Override        │ │ Card override   │    │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘    │
│ … 121 more cards …                                                │
└──────────────────────────────────────────────────────────────────┘
```

Each card shows the *resolved* (merged) design. The "Override" / "Card override" / "Missing" badges are visual hints for the decorator, not interactive. Clicking a card opens a lightbox preview at full resolution (so the decorator can inspect the artwork before printing).

## Data Model Touches

| Table | Change |
|---|---|
| `campaigns` | Add `default_design jsonb DEFAULT '{}'::jsonb NOT NULL`. Schema: `{ cake_image_url?: string, card_image_url?: string }`. |
| `recipients` | No schema change. `customizations` jsonb already exists; we now write `{ cake_image_url?: string, card_image_url?: string }` into it. Existing keys (e.g. `skipped: true` from Plan 3) coexist via shallow merge. |
| Storage | New bucket `cake-prints`, public read, permissive write. Created via `INSERT INTO storage.buckets (id, name, public) VALUES ('cake-prints', 'cake-prints', true) ON CONFLICT DO NOTHING`. |

### Effective-design merge

```js
// public/src/utils/design.js
function mergeDesign(campaignDefault = {}, recipientOverride = {}) {
  return {
    cake_image_url: recipientOverride.cake_image_url ?? campaignDefault.cake_image_url ?? null,
    card_image_url: recipientOverride.card_image_url ?? campaignDefault.card_image_url ?? null,
  };
}
```

`null` / undefined / missing all fall through to the default. An explicit empty string is treated as missing too — the cropper guarantees uploads are non-empty PNG URLs, so we don't need a "user wants no image" sentinel.

### Storage pathing

```
cake-prints/<campaign_id>/cake_default.png
cake-prints/<campaign_id>/card_default.png
cake-prints/<campaign_id>/cake_<recipient_id>.png
cake-prints/<campaign_id>/card_<recipient_id>.png
```

Pathing is deterministic so re-uploading a slot overwrites the previous file (no orphaned blobs). Removing an override deletes the recipient-keyed file.

## Crop Pipeline (browser-side)

Steps inside `ImageCropper.jsx`:

1. Customer picks a file (or pastes a URL — we fetch via `fetch()` first; CORS-blocked URLs fall back to "save the URL as-is, skip crop" with a warning).
2. Render the source `<img>` into the modal stage.
3. Overlay a crop rectangle with locked aspect ratio (`aspectRatio = outputW / outputH`). Default to a centered rectangle that fits the image. Drag the rectangle (whole) and the corner handles (proportional resize). Min size = 200px on the source's smaller dimension.
4. On Save, compute crop coords in source-image pixels, draw to an offscreen canvas of size `(outputW, outputH)`. For round outputs, apply a circular `clip()` first so corners are transparent.
5. `canvas.toBlob(..., 'image/png')` → upload to Supabase Storage at the deterministic path → write the public URL back to the field.
6. Cancel discards everything; the underlying field is unchanged.

Output specs:

| Asset | Aspect | Output px (300dpi) | Mask |
|---|---|---|---|
| Cake print | 1:1 | 2250 × 2250 | circular alpha |
| Box card | 4:6 (portrait) | 1200 × 1800 | none (rectangular) |

Browser memory note: a 4000×3000 source image takes ~48 MB as an `ImageBitmap`. We accept up to 20 MB source files; larger uploads get a "please resize first" error. Chrome and Safari both handle the 2250×2250 canvas without blowing up.

### Re-crop

The "Re-crop" button on a populated slot re-opens the cropper with the *original* source image. We don't keep the source — the customer would have to re-upload to re-crop a saved asset. This is acceptable because (a) the most common change is "actually I uploaded the wrong image," not "I want a different crop of the same image," and (b) keeping originals doubles the storage. If users complain, we can stash the source as a sibling `*_source.png` later.

## Print Pipeline (bakery-side)

### Box card sheet (browser print)

`BoxCardSheet.jsx` mounts a hidden `<div class="box-card-sheet print-only">` containing one mini `.card` per recipient (in delivery order: by route then by stop index). Each `.card` is a 4×6 box with `background-image` set to the resolved card URL plus 4 corner cut marks.

`styles.css` adds:

```css
@page { size: letter; margin: 0.25in; }
@media print {
  body > *:not(.box-card-sheet) { display: none !important; }
  .box-card-sheet { display: grid; grid-template-columns: 1fr 1fr;
                    grid-template-rows: repeat(4, 1fr); gap: 0;
                    width: 8in; height: 10.5in; }
  .box-card-sheet .card { aspect-ratio: 4/6; background-size: cover;
                          background-position: center; position: relative; }
  .box-card-sheet .card::before, .card::after { /* corner cut marks */ }
  .box-card-sheet .card:nth-child(8n+1) { page-break-before: always; }
}
```

Clicking "Print all box cards" calls `window.print()`. The user picks their printer in the OS dialog. No PDF library, no server compute.

For 124 recipients → 16 letter pages (8 cards × 16 = 128, with 4 trailing blanks).

### Edible print ZIP

`zip-prints.js` uses the existing JSZip vendor lib. Pseudocode:

```js
async function downloadEdiblePrintsZip(recipients, mergedDesigns, campaignName) {
  const zip = new JSZip();
  await Promise.all(recipients.map(async (r, i) => {
    const url = mergedDesigns[r.id]?.cake_image_url;
    if (!url) return;
    const blob = await fetch(url).then(res => res.blob());
    const safeName = r.company.replace(/[^a-z0-9]/gi, '_').slice(0, 32);
    zip.file(`${String(i+1).padStart(3,'0')}_${safeName}_${r.id.slice(0,8)}.png`, blob);
  }));
  const out = await zip.generateAsync({ type: 'blob' });
  triggerBrowserDownload(out, `${campaignName}_edible_prints.zip`);
}
```

Files are named `001_Acme_Dental_Group_a3b1c4f2.png` etc. so the bakery can match each PNG to a recipient from the Production tab.

## Error Handling & Edge Cases

| Scenario | Behavior |
|---|---|
| Customer uploads a non-image (e.g. PDF) | Cropper rejects with "Only PNG/JPG accepted." |
| Source file > 20 MB | "Please resize to under 20 MB before uploading." |
| Crop rectangle ends up smaller than the output px | Save still works (canvas upscales); show a "Low resolution — print may be blurry" warning under the slot. Threshold: source crop area < 50% of output px. |
| Customer pastes a URL we can't fetch (CORS) | Persist the URL as-is, skip crop. Bakery sees "External URL · uncropped" badge on the card. They handle the crop downstream. |
| Customer removes campaign default after some recipients have overrides | Allowed. Recipients with overrides keep their overrides; recipients on the default now have nothing → they show as "Missing cake / Missing card" in the Production tab. Wizard's Finalize gate re-engages: must restore the default to finalize again. |
| Bakery clicks Print with 0 recipients in the current filter | Button is disabled; tooltip "No box cards to print." |
| Bakery clicks Download edible prints with some missing cake images | ZIP includes only the recipients with a resolved cake image; UI surfaces "12 of 124 missing — they were skipped." Download still proceeds. |
| Two customers concurrently edit the same campaign's default_design | Last write wins (the customer profile is shared today). Acceptable per Plan 2 pivot. |
| Storage bucket missing (migration didn't run) | Cropper Save fails with a 404 from the upload; surfaces as "Upload failed — bucket missing. Run migration 008." |
| `customizations` jsonb already has Plan 3 keys (e.g. `skipped: true`) | Shallow merge preserves them. Removing an override clears only the cake/card keys, not `skipped`. |

## Testing

| Layer | Tests |
|---|---|
| **Unit** | `mergeDesign` truth table; `cropToCanvas` against fixture PNGs (node-canvas) — checks that a 1000×1000 source cropped to top-left 500×500 produces an exact pixel-equal output; `canvasToPng` round-trip; `zip-prints` filename safety (special chars, non-ASCII). |
| **Integration** | Customer flow: upload + crop a default cake + card → save → reload wizard → assets are visible. Override flow: add override → reload → override is visible. Bakery flow: log in as bakery → Production tab → counts match. |
| **Print** | Snapshot test of `BoxCardSheet` HTML output for a 5-recipient fixture (asserts class names + grid layout + page-break-before on every 8th card). |
| **Manual smoke** | Real upload + crop in Chrome/Safari; verify 8-up sheet prints correctly via `window.print()` → "Save as PDF" → check the PDF visually. |

## Migration

`supabase/migrations/008_cake_design.sql`:

```sql
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS default_design jsonb DEFAULT '{}'::jsonb NOT NULL;

INSERT INTO storage.buckets (id, name, public)
VALUES ('cake-prints', 'cake-prints', true)
ON CONFLICT (id) DO NOTHING;

-- Permissive RLS to match the Plan 2 pivot (every profile is trusted).
CREATE POLICY IF NOT EXISTS "anyone can read cake-prints"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'cake-prints');

CREATE POLICY IF NOT EXISTS "anyone can write cake-prints"
  ON storage.objects FOR INSERT
  TO public
  WITH CHECK (bucket_id = 'cake-prints');

CREATE POLICY IF NOT EXISTS "anyone can update cake-prints"
  ON storage.objects FOR UPDATE
  TO public
  USING (bucket_id = 'cake-prints');

CREATE POLICY IF NOT EXISTS "anyone can delete cake-prints"
  ON storage.objects FOR DELETE
  TO public
  USING (bucket_id = 'cake-prints');
```

(Idempotent — safe to re-run.)

## Out of Scope (deferred to later plans)

- **Per-bakery cake-size config** (6"/8"/10"). v1 assumes 8" cakes everywhere; the 7.5" round edible image is sized for that. A future plan adds `bakeries.cake_size` and per-bakery output dims.
- **Signed Storage URLs.** v1 bucket is public — anyone who guesses the URL can fetch the artwork. Acceptable per Plan 2 pivot; signed URLs ship with real auth.
- **Bakery-side editing.** v1 bakery is read-only on designs; if artwork is wrong, the customer re-uploads. Two-tenant edit UX deferred.
- **AI-detected `card_image`/`cake_image` columns in upload.** Plan 3's column-mapping step has no concept of image columns. A future plan can add "if Step 2 sees a `card_image_url` column, pre-seed those as overrides."
- **Source-image archive for re-crop.** v1 doesn't keep the original; "Re-crop" requires re-uploading the source. A future plan can stash sources as `*_source.png` if customers complain.
- **PDF export of the box card sheet.** v1 uses browser print only; the OS dialog can "Save as PDF" if the customer needs a digital copy.
- **System-rendered text overlays** (per-recipient name on a shared image template). Explicitly punted in this plan in favor of the image-only model.
- **All-overrides campaigns** (no campaign default at all, every recipient has their own images). v1 requires both default images to finalize — customers who want every cake unique must still upload "any" image as the default. We can relax the gate later if customers complain; the alternative ("every recipient must have both images via override") adds a per-row gate that's harder to communicate.

## Sequencing (writing-plans will produce the actual task breakdown)

High-level order so the implementation plan has shape:

1. Migration 008 (columns + bucket + RLS) and the pure helpers (`design.js`, `crop.js`, `zip-prints.js`).
2. `ImageCropper.jsx` standalone — testable in isolation against any image.
3. Wizard Step 4 + `DesignsStep.jsx` — uses cropper for default slots; gate Finalize on default images present; persist to DB.
4. Override list + add-override modal — per-recipient.
5. Production tab + `CakeCard` grid + filters.
6. `BoxCardSheet.jsx` + print CSS + "Print all box cards" wiring.
7. `zip-prints.js` integration + "Download edible prints" wiring.
8. Resume-detection update in `UploadWizard.jsx` (jump to Step 4 instead of Step 3).
9. End-to-end smoke (real upload, real crop, real print preview, real ZIP download).
