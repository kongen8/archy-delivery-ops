# Plan 3 — Customer Upload Pipeline · Design Spec

Status: approved 2026-04-18 · supersedes the "Customer Upload Flow" section of `2026-04-18-multi-tenant-delivery-platform-design.md` for sequencing purposes only (the high-level decisions there still hold).

## Goal

Let any customer (today: Archy; tomorrow: anyone with a customer profile link) upload a CSV/XLSX of recipients and have the system AI-clean, geocode, area-match, and bucket every row — surfacing the things a human needs to look at and silently ingesting the rest.

## Guiding Decisions

1. **Edge function runs the pipeline.** All AI + geocoding + DB writes happen inside a single Supabase edge function; the browser only ships file bytes + the confirmed column mapping. Keeps OpenAI / Mapbox secrets server-side.
2. **Wizard is its own page**, not a modal. Each of the three steps gets the full screen + a progress sidebar. Routes are hash-based: `#/customer/<customerId>/upload/<campaignId>`.
3. **Always show the column-mapping step.** Even on a clean file the customer sees what AI decided. One extra click in exchange for zero invisible decisions.
4. **Tabbed bucket review.** Step 3 surfaces buckets as tabs (`Assigned · Needs review · Out of area · Geocode failed`) — focused triage, one bucket at a time.
5. **Finalize is non-blocking.** Persist every row at its current `assignment_status`. Bakeries see only `assigned`. Customer can return to fix the rest later.
6. **Re-upload appends + dedups** on `(campaign_id, legacy_id)` where `legacy_id = sha256(company|address)`. Same file twice is a no-op; corrected file fills in the gaps.
7. **Sync ingest with progress.** A 200-row file finishes in ~60s. The wizard shows a progress bar; HTTP request stays open. Hard cap of 5,000 rows / 5 MB to fit Supabase's 60-second function ceiling.
8. **No admin settings panel.** `OPENAI_API_KEY` and `MAPBOX_SECRET_TOKEN` are set as edge function secrets via the Supabase dashboard, once. Building a key-management UI is deferred.
9. **Auth stays off.** Plan 3 inherits the Plan 2 pivot — every customer profile link is fully trusted. The edge function uses the service role key internally; the browser still talks to Supabase via the anon key.

## Architecture

```
Browser (customer profile)              Supabase
─────────────────────────────           ──────────────────────────────
CustomerHomeView                        bakeries / customers / campaigns
  └─ "+ Upload campaign"                 / delivery_areas / depots
       └─ creates campaigns row          recipients (1 row per stop)
            (status='draft')             delivery_statuses_v2
            navigate(#/customer/X        routes
              /upload/<campaignId>)
                                        supabase/functions/ingest-recipients/  ← NEW
UploadWizard (new SPA route)              POST /ingest-recipients
  Step 1  name + dropzone (SheetJS         body: { campaign_id, file_b64,
          parses locally)                          column_mapping?, ai_disabled? }
  Step 2  column mapping table             →  parse → AI cleanup → geocode
  Step 3  tabbed bucket review                → area-match → bulk insert
  └─ POST file + mapping                   ←  { totals, sample_issues }
                                             external: OpenAI + Mapbox
```

### Component map

- `public/src/components/UploadWizard.jsx` (new) — three-step wizard, owns local state for parsed rows + column mapping + ingest result.
- `public/src/upload/parse.js` (new) — pure helper: `parseFile(arrayBuffer, mime) → { headers, rows: string[][] }`. Wraps SheetJS via the existing JSZip CDN dependency. Unit-tested.
- `public/src/upload/columns.js` (new) — pure helper: `suggestMapping(headers, sampleRows) → { mapping, confidence }` — a deterministic fallback used only when AI is disabled or down. Unit-tested.
- `public/src/components/App.jsx` (modified) — adds the `#/customer/<id>/upload/<campaignId>` route.
- `public/src/components/CustomerHomeView.jsx` (modified) — wires the existing "+ Upload campaign (coming soon)" button to create a draft campaign and route to the wizard.
- `supabase/functions/ingest-recipients/index.ts` (new) — Deno edge function. Owns the AI/geocoding/area-match loop and bulk insert.
- `supabase/migrations/007_recipients_legacy_unique.sql` (new) — adds `unique (campaign_id, legacy_id)` to `recipients` so the edge function can use `ON CONFLICT DO NOTHING`. Migration `002` already added a partial index; this tightens it to a true uniqueness constraint.

### Wizard flow

| Step | UI | Persistence at this step |
|---|---|---|
| **1 · File** | "Campaign name" input + drag-and-drop. SheetJS parses CSV/XLSX in the browser; first 5 rows preview. "Continue" is disabled until both name + file are present. | On "Continue" we INSERT `campaigns` with `status='draft'`, `name=<input>`, `customer_id=<from route>`. Route to `#/customer/X/upload/<newId>`. |
| **2 · Columns** | Table: source column · sample value · target field (dropdown of `company / contact_name / phone / email / address / city / state / zip`) · AI confidence pill (`high / medium / low`). All editable. AI's first-pass mapping is the default. | None. The mapping is held client-side and posted with the file in the next step. |
| **3 · Review** | Tabs: `Assigned · Needs review · Out of area · Geocode failed`. Each row is a card with bucket-specific actions (see below). Footer: `<count> will be delivered. <count> still need attention. [Finalize campaign]`. | All rows already inserted by the ingest function; per-row actions issue UPDATE/DELETE directly. "Finalize" flips `campaigns.status` to `'active'`. |

### Per-row actions in step 3

- **Assigned** — read-only count + sample table. No actions.
- **Needs review** — three buttons:
  - **Accept AI fix** → UPDATE `recipients` with the AI-cleaned values, set `assignment_status='assigned'`. Also re-runs area-match if the address changed (call `recompute-recipient` helper, see "Helpers" below).
  - **Edit** — opens an inline form pre-filled with raw + AI columns side-by-side; on save, behaves like Accept.
  - **Skip** — UPDATE `assignment_status='needs_review'` with a `customizations.skipped=true` flag. Row stays in DB but is invisible to bakeries; customer can come back.
- **Out of area** — address shown read-only (it geocoded fine, it's just outside every polygon). Two buttons:
  - **Edit address** — same inline editor as Needs review; on save, re-runs geocode + area-match.
  - **Tell admin** — copies a pre-filled mailto link with the address and a note.
- **Geocode failed** — inline address editor; "Retry geocode" calls a small `geocode-single` endpoint (see Helpers); success moves the row into Assigned or Out of area depending on area match.

### Helpers (small support endpoints)

- `geocode-single` — POST `{ recipient_id, address, city, state, zip }`. Re-runs geocode + area-match for one row, updates the recipients row in place. Lives inside `ingest-recipients/index.ts` as a separate route within the same function for v1; promote to its own function later if traffic warrants.

## Data Model Touches

| Table | Change |
|---|---|
| `recipients` | Add `unique (campaign_id, legacy_id)` constraint (migration 007). `assignment_status` already covers all 4 buckets. |
| `campaigns` | No schema change. Wizard uses existing `status` enum (`draft → active`). |
| `geocode_cache` | No change. Edge function reads + writes through it. |
| Everything else | Untouched. |

`legacy_id` becomes `sha256(lowercased(company) + '|' + lowercased(address))`. Stable across re-uploads of the same row even when other fields differ. The hash is a hex string (64 chars), within the existing `legacy_id text` column.

## Edge Function Pipeline (`ingest-recipients`)

Input: `{ campaign_id: uuid, file_b64: string, file_type: 'csv' | 'xlsx', column_mapping?: ColumnMapping, ai_disabled?: boolean }`

Output: `{ totals: { assigned, needs_review, flagged_out_of_area, geocode_failed }, sample_issues: [{recipient_id, reason, raw, suggested}], mapping_used: ColumnMapping }`

Pipeline, in order:

1. **Parse** — Decode `file_b64`, run through SheetJS. Reject if > 5,000 rows.
2. **Column mapping** — If `column_mapping` provided, use it as-is. Otherwise call OpenAI (1 request) with headers + 5 sample rows; expects `{ mapping, confidence }` JSON. If AI fails, fall back to the `suggestMapping` heuristic.
3. **Row normalization** — Batch rows in groups of 20, max 4 in flight. Per batch, one OpenAI call. Prompt rules:
   - Reformat existing values only; never invent missing fields (return `null` instead).
   - Split combined "Address" into address/city/state/zip.
   - Per row: `{ company, contact_name, phone, email, address, city, state, zip, confidence: 'low'|'medium'|'high' }`.
   - `temperature=0`, `response_format: json_object`.
   - On total AI failure, skip this step and use raw mapped values.
4. **Geocode** — For each row, look up `geocode_cache` by normalized address. On miss, call Mapbox Geocoding API. Cache writes are upsert. Backoff with retry on 429.
5. **Area match** — Turf.js `booleanPointInPolygon` against every `delivery_areas.geometry` row (loaded once at function start). On multiple matches, pick the first deterministically and log a warning.
6. **Bucket** in this precedence:
   1. `needs_review` — AI confidence == `low` for `company` or `address`.
   2. `geocode_failed` — Mapbox returned no result.
   3. `flagged_out_of_area` — geocoded but no polygon contains the point.
   4. `assigned` — geocoded + matched to exactly one bakery.
7. **Insert** — Single `INSERT … ON CONFLICT (campaign_id, legacy_id) DO NOTHING` with all rows. The `bakery_id` column is set for `assigned` rows; null for the others.
8. **Return** the totals + a sample of up to 10 problem rows (one per bucket type) for the UI to seed step 3.

The function uses the **service role key** from `SUPABASE_SERVICE_ROLE_KEY` env var; never exposed to the browser.

### Hallucination guardrails

- Prompt explicitly forbids inventing data; model returns `null` for missing fields.
- `needs_review` surfaces original raw row + AI-cleaned row side-by-side for confirmation.
- Unit + AI contract tests on representative messy inputs (see Testing).

## Error Handling & Edge Cases

| Failure | Behavior |
|---|---|
| OpenAI down (column mapping) | Fall back to `suggestMapping` heuristic. Wizard banner: "AI cleaning unavailable — best-guess mapping used." |
| OpenAI down (row normalization) | Skip the AI normalization pass for that batch; carry raw mapped values forward to geocoding. Bucket decision uses geocode + area outcomes only — confidence defaults to `high` so AI-down doesn't flood `needs_review`. Wizard banner: "AI cleaning unavailable — raw values used." |
| Mapbox 429 | Exponential backoff (3 retries, max 8s). On total failure, rows land in `geocode_failed`. |
| Mapbox down | Same as 429 — geocode_failed. |
| File > 5,000 rows | Reject at upload step in the browser; explain the cap. |
| File > 5 MB | Same. |
| Function times out (60s) | Whatever was inserted stays. Customer re-runs; `ON CONFLICT` prevents dupes. UI detects timeout and shows "Resume." |
| Customer closes tab mid-upload | Campaign stays `draft` with whatever was inserted. Reopening the wizard at the same URL skips the file step (we detect existing recipients on this campaign and jump straight to step 3). |
| Two browser tabs uploading the same draft simultaneously | Last writer wins on per-row UPDATEs; the `ON CONFLICT` insert is safe. Acceptable for v1. |
| Bakery polygon edited mid-upload | Edge function loads polygons once; rows ingested before the edit aren't retroactively re-matched. Use the existing "Recompute assignments" admin button afterward. |

## Testing Notes

### Unit (node:test, like Plan 2 helpers)

- `public/src/upload/parse.js` — CSV happy path, XLSX, weird headers (unicode, BOM), empty rows, mismatched row widths.
- `public/src/upload/columns.js` — heuristic mapping for common header names (Company / Business Name / Customer; Address / Street; etc.).
- Bucket precedence — pure function in the edge function package, mockable inputs.

### AI contract tests

- A small fixture set of realistic messy rows (`fixtures/messy-rows.json`) with expected cleaned output.
- Asserts the model:
  - Doesn't invent missing data (returns `null` for blank phone numbers).
  - Splits combined addresses correctly.
  - Returns `confidence: 'low'` when the company name is obviously corrupted.
- Run with `temperature=0` so output is deterministic. Skipped on CI by default; run locally with `OPENAI_API_KEY` present.

### Edge function integration test

- `supabase/functions/ingest-recipients/test.ts` — `deno test` against the live Supabase project (per the existing `admin-db.test.js` pattern).
- 20-row fixture CSV with a deliberate mix of clean / messy / out-of-area / ungeocodable rows.
- Asserts: bucket totals, the `(campaign_id, legacy_id)` unique-on-conflict behavior on a re-run, and that the `geocode_cache` is populated.
- Cleans up its test bakery + customer + campaign in `afterAll`.

### Wizard smoke

- Manual: start the local dev server, drop a fixture CSV, walk all three steps, confirm a campaign appears in CustomerHomeView with the right counts.
- Automated UI tests are out of scope for now (project doesn't have a browser test harness yet).

## Non-Goals (deferred)

- **Admin settings panel** for OpenAI / Mapbox keys. Set them once in the Supabase dashboard.
- **Async ingest with email notification.** Sync-with-progress is fine for ≤ 5,000 rows.
- **Multi-file batch uploads across campaigns.** One file per wizard run.
- **Auto re-match after polygon edits.** The Plan 2 "Recompute assignments" button covers the manual case.
- **Re-enabling auth.** Plan 3 still trusts every customer profile link.
- **Promoting `geocode-single` to its own edge function.** Lives inside `ingest-recipients` for v1.

## Sequencing (high level — `writing-plans` will refine)

1. Migration 007 (recipients unique constraint).
2. `parse.js` + `columns.js` helpers + unit tests.
3. Edge function `ingest-recipients` skeleton + integration test scaffold.
4. AI column mapping + row cleanup logic + AI contract tests.
5. Geocode + area-match + bucketing logic.
6. UploadWizard component (Step 1 → Step 2 → Step 3 with progress).
7. Per-row actions in Step 3 (Accept / Edit / Skip / Retry geocode).
8. Wire CustomerHomeView "+ Upload campaign" button + new route.
9. End-to-end smoke + commit + finishing.
