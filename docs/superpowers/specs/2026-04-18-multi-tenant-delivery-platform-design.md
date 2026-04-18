# Multi-Tenant Delivery Platform — Design Spec

**Date:** 2026-04-18
**Status:** Approved, pending user review
**Scope:** Turn the Archy-specific delivery ops tool into a multi-tenant platform where bakeries have drawn service areas and customers upload recipient lists that get auto-assigned to the right bakery.

## Goal

Run multiple delivery campaigns for multiple customers simultaneously. Each customer uploads a recipient list (CSV/Excel); the system AI-cleans the data, geocodes it, and routes every address to the bakery whose service area contains it. Out-of-area addresses are flagged. Each bakery operates its own slice via a token-linked ops view.

Out of scope for this spec (explicitly deferred): cake type/design selection, per-cake print upload, payments, multiple bakeries covering the same area, driver-facing mobile UIs, real authentication.

## Guiding Decisions

| Decision | Choice | Why |
|---|---|---|
| Relationship to existing Archy data | Extend in place; Archy becomes Campaign #1 | Forces the new model to prove on real data; avoids two code paths |
| Auth | Token links (no passwords) for v1 | Matches current "no auth" reality; structure allows clean Supabase Auth upgrade |
| Operator model | Each bakery operates its own slice | That's what multi-tenant means in practice |
| Geocoder | Mapbox | 100k free/month, browser-safe tokens, accurate enough for US commercial addresses |
| Architecture | Stay static + Supabase Edge Functions for ingest | Preserves existing patterns; ingest is batch work that belongs off the browser |
| Data parsing | OpenAI-driven (column mapping + row normalization) | Removes the "exact columns or exact addresses" friction that would otherwise be the #1 customer failure mode |
| Polygon math | GeoJSON in jsonb + Turf.js point-in-polygon | No PostGIS needed at this scale |

## Architecture

No build step. Same `public/index.html` with babel-standalone compiling JSX in the browser. New capabilities are added as:

- New JSX components loaded via `<script type="text/babel">`.
- A tiny router inside `App.jsx` that switches root view based on URL path + token.
- Three Supabase Edge Functions in TypeScript/Deno.
- New Supabase tables; the old `route_overrides` and `depot_overrides` tables are superseded by `routes` and `depots`.

### Component map

```
index.html
└── App.jsx (router shell)
    ├── /admin?t=…           → AdminView (new)
    │   ├── BakeryList
    │   ├── BakeryCreate → DeliveryAreaDraw (MapLibre + maplibre-gl-draw)
    │   ├── CustomerList
    │   └── SettingsPanel (OpenAI API key field)
    │
    ├── /customer/:token     → CustomerHomeView (new, extends today's CustomerView)
    │   ├── CampaignList
    │   ├── IngestWizard
    │   │   ├── step 1: file upload (SheetJS)
    │   │   ├── step 2: column mapping (AI-suggested, user-editable)
    │   │   └── step 3: results (assigned / flagged / needs review)
    │   └── CampaignProgress (per-bakery breakdown, reuses ProgressBar, PhotosView-style gallery)
    │
    ├── /bakery/:token       → BakeryHomeView (new)
    │   ├── CampaignPicker
    │   └── OpsView (existing, filtered to bakery_id + campaign_id)
    │
    └── /                    → LandingStub (new) — "invitation only, email contact@daymaker.com"
```

### Supabase client plumbing

Today's `DB` facade uses one global `sb` client. Wrap it so each tenant view constructs its own client with a tenant token header:

```js
function makeTenantClient(token) {
  return supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { 'x-tenant-token': token } }
  });
}
```

RLS policies read `current_setting('request.headers', true)::jsonb->>'x-tenant-token'` and match it against `bakeries.access_token` or `customers.access_token`. Admin uses a separate token stored in an env var (or later replaced by Supabase Auth `auth.uid() = user_id`).

### Edge functions

Three Deno/TypeScript functions deployed via Supabase CLI (one-time admin setup per environment):

1. **`ingest-recipients`** — receives raw CSV/XLSX rows + the customer's column mapping, runs the AI + geocode + area-match pipeline, inserts into `recipients`, returns a summary. See "Ingest pipeline" below.
2. **`create-bakery`** — admin-only; creates a bakery + initial delivery area(s) + depot(s) in one transaction.
3. **`rematch-recipients`** — admin or on-polygon-edit trigger; re-runs area match for recipients currently `flagged_out_of_area` (so opening a new bakery area auto-rescues previously flagged rows).

All three read the OpenAI key and Mapbox key from the `app_settings` singleton (admin UI). Service role key and Supabase URL come from Edge Function environment (standard Supabase default secrets).

## Data Model

Nine tables. New ones flagged; existing tables marked re-keyed where noted.

### `bakeries` (new)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| name | text | |
| contact_email | text | |
| contact_phone | text | nullable |
| access_token | text unique | random, unguessable |
| user_id | uuid nullable | Supabase Auth upgrade path |
| created_at | timestamptz | default now() |

### `delivery_areas` (new)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| bakery_id | uuid fk → bakeries | |
| name | text | e.g. "SF core" |
| geometry | jsonb | GeoJSON Polygon or MultiPolygon |
| created_at | timestamptz | |

Multiple rows per bakery; union is the service area.

### `depots` (new, replaces `depot_overrides`)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| bakery_id | uuid fk → bakeries | |
| name | text | e.g. "Boho Petite - Chestnut St" |
| address | text | |
| lat | double precision | |
| lon | double precision | |

### `customers` (new)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| name | text | |
| contact_email | text | |
| access_token | text unique | |
| user_id | uuid nullable | |
| created_at | timestamptz | |

### `campaigns` (new)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| customer_id | uuid fk → customers | |
| name | text | |
| status | text | `draft` \| `assigning` \| `active` \| `complete` |
| created_at | timestamptz | |

### `recipients` (new)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| campaign_id | uuid fk → campaigns | |
| bakery_id | uuid fk → bakeries, nullable | null if flagged |
| company | text | |
| contact_name | text | nullable |
| phone | text | nullable |
| email | text | nullable |
| address | text | cleaned address string |
| city | text | nullable |
| state | text | nullable |
| zip | text | nullable |
| lat | double precision | nullable until geocoded |
| lon | double precision | nullable until geocoded |
| assignment_status | text | `assigned` \| `flagged_out_of_area` \| `geocode_failed` \| `needs_review` |
| legacy_id | text | nullable, for Archy migration |
| customizations | jsonb | default `'{}'`; forward slot for cake design + print |
| created_at | timestamptz | |

### `geocode_cache` (new)
| Column | Type | Notes |
|---|---|---|
| normalized_address | text pk | lowercased, whitespace-collapsed |
| lat | double precision | |
| lon | double precision | |
| display_name | text | |
| provider | text | `mapbox` |
| created_at | timestamptz | |

### `routes` (replaces `route_overrides`)
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| campaign_id | uuid fk → campaigns | |
| bakery_id | uuid fk → bakeries | |
| data | jsonb | same shape as today's `route_overrides.data` |
| updated_at | timestamptz | |

Unique `(campaign_id, bakery_id)`.

### `delivery_statuses` (re-keyed)
| Column | Type | Notes |
|---|---|---|
| recipient_id | uuid pk fk → recipients | replaces old text `id` |
| status | text | `pending` \| `delivered` \| `failed` |
| note | text | |
| photo_url | text | |
| delivered_at | timestamptz | |
| updated_at | timestamptz | |

### `app_settings` (new, singleton)
| Column | Type | Notes |
|---|---|---|
| id | int pk default 1 check (id=1) | singleton |
| openai_api_key | text | nullable; set via admin UI |
| mapbox_api_key | text | nullable |
| updated_at | timestamptz | |

Readable only by service role and admin token; hidden from tenant tokens via RLS.

### Retired
- `route_overrides` → superseded by `routes` (data migrated, table kept read-only for 30 days).
- `depot_overrides` → superseded by `depots` (data migrated, table dropped after migration).

### Row Level Security summary

All tenant-scoped tables enable RLS with policies like:

```sql
create policy "bakery reads own recipients"
  on recipients for select
  using (
    bakery_id in (
      select id from bakeries
      where access_token = current_setting('request.headers', true)::jsonb->>'x-tenant-token'
    )
  );

create policy "customer reads own recipients"
  on recipients for select
  using (
    campaign_id in (
      select c.id from campaigns c
      join customers cu on cu.id = c.customer_id
      where cu.access_token = current_setting('request.headers', true)::jsonb->>'x-tenant-token'
    )
  );
```

Admin token gets a blanket bypass policy. Edge functions use the service role key and bypass RLS entirely.

## Ingest Pipeline (`ingest-recipients`)

Input: `{ campaign_id, file_bytes, file_type, column_mapping? }`
Output: `{ assigned_count, flagged_count, needs_review_count, geocode_failed_count, sample_issues[] }`

Steps, in order, all running inside the edge function:

1. **Parse** — SheetJS (or `xlsx` Deno port) extracts rows. If `column_mapping` is absent, derive it from AI (step 2).
2. **AI column mapping** — one OpenAI call with headers + 5 sample rows. Returns `{ mapping: {company, address, …}, confidence: 0–1 }`. Confidence < 0.8 surfaces a UI step where the customer can correct the mapping before proceeding.
3. **AI row normalization** — rows processed in batches of 20. Prompt constrains the model to:
   - Reformat values only; never invent fields not supported by the row.
   - Split combined "Address" fields into address + city + state + zip when possible.
   - Return an explicit `confidence: low | medium | high` per row.
   - Return `null` (not a guess) for missing fields.
4. **Geocode** — `geocode_cache` lookup → Mapbox fallback. Cache writes are idempotent.
5. **Area match** — Turf.js `booleanPointInPolygon` against every `delivery_areas.geometry` row. On multiple matches (v1 shouldn't produce any because user confirmed one bakery per area), pick the first deterministically and log a warning.
6. **Classification** — rows are bucketed into exactly one status, evaluated in this precedence order:
   1. `needs_review` — AI confidence was `low` for a critical field (company or address). Takes priority over everything else so the customer gets a chance to fix bad data before we persist a wrong assignment.
   2. `geocode_failed` — Mapbox returned no result after AI cleaning, and AI produced no alternative worth showing.
   3. `flagged_out_of_area` — geocoded successfully but no polygon contains the point.
   4. `assigned` — geocoded + matched to exactly one bakery.

   A geocode failure where AI produced a cleaned-but-unverified alternative is classified as `needs_review` (so the customer sees the original + AI guess side-by-side) rather than `geocode_failed`.
7. **Insert** — batched insert into `recipients` with the appropriate `assignment_status`. Campaign flips to `assigning` during, `active` after.

The function is idempotent on `(campaign_id, legacy_id)` where legacy_id is a deterministic hash of `(company, address)` — re-uploading the same file doesn't duplicate rows.

### Hallucination guardrails

- Prompt explicitly forbids inventing data; model must return `null` for missing fields.
- `needs_review` surfaces original raw row + AI-cleaned row side-by-side for human confirmation.
- Unit tests on representative messy inputs (see Testing Notes) verify the model doesn't fabricate.

## Admin Onboarding Flow (bakery)

1. `/admin` → "New bakery" modal. Enter name, contact email/phone.
2. `DeliveryAreaDraw` map: polygon / circle / rectangle tools (`maplibre-gl-draw`). Save one or more shapes. Each becomes a `delivery_areas` row.
3. Add depot(s): reuse today's `DepotManager` geocode-address form.
4. Click "Save bakery". `create-bakery` edge function runs the transaction. Modal shows the generated bakery access link; admin copies it to the bakery.

Overlap check (v1): if a new delivery area overlaps an existing one (Turf.js `booleanOverlap`), admin gets a warning but can override. v1 assumes admin resolves these by hand; v2 will enforce non-overlap or support multi-bakery areas.

## Customer Upload Flow

1. `/customer/:token` → "New campaign" button.
2. Name the campaign.
3. Drop CSV/XLSX file. SheetJS parses locally; first 5 rows shown as a preview.
4. Wizard step 2 (AI column mapping): either the mapping is auto-confirmed (AI confidence ≥ 0.8) or the customer adjusts dropdowns. "Continue" posts to `ingest-recipients`.
5. Wizard step 3 (results): buckets shown as collapsible sections. Each `needs_review` row has an "Accept AI fix" / "Edit" / "Skip" button. `flagged_out_of_area` rows get a copy-paste prompt linking to `contact@daymaker.com`. `geocode_failed` rows can be edited and retried in place.
6. "Finalize campaign" → campaign flips to `active`; bakeries with assigned recipients become eligible to see the campaign in their view.

After activation, the customer's home view shows the per-bakery progress dashboard (essentially today's `CustomerView` scoped to this campaign).

## Bakery Ops Flow

1. `/bakery/:token` → list of active campaigns where `recipients.bakery_id = me`.
2. Pick a campaign → existing `OpsView` mounts, filtered to this `(campaign, bakery)`. Everything existing works unchanged:
   - Day/driver selection
   - Rebalance via VRP solver
   - Depot editing (now writes directly to the `depots` table for this bakery)
   - Mark delivered/failed, upload photos
   - Print route sheet
3. Cross-campaign batching (bakery sees all its pending deliveries across campaigns in one plan) is deferred to v2.

## Migration of Existing Archy Campaign

One-shot, idempotent migration, run once on deploy. Lives as a SQL + JS script under `scripts/migrate-archy/migrate-archy.js` (per the project convention that supabase-querying scripts live in a same-named subfolder). The script reads the Supabase URL + service role key from an `.env` file (root-level `.env`, since this repo doesn't currently have an `apps/web` layout — the plan will establish this file).

1. Insert customer "Archy" with a generated access token (stored in a vault / printed once for the admin).
2. Insert campaign "Archy × Daymaker Q2 2026" under that customer (`status = 'active'`).
3. Insert the four distinct bakeries from today's `REGIONS`: Boho Petite, Sweet Lady Jane, SmallCakes, Roland's Swiss Pastries. Each gets an access token.
4. For each region's existing `ROUTE_DATA[region].depots` array, insert `depots` rows under the matching bakery.
5. For each region, build a bounding polygon from the convex hull of that region's stops and insert as a `delivery_areas` row for the matching bakery. Admin can tighten by hand in `DeliveryAreaDraw` afterwards.
6. Walk every stop in `ROUTE_DATA`. Insert a `recipients` row:
   - Generate new uuid for `id`; preserve old string ID in `legacy_id`.
   - `bakery_id` = bakery of the region.
   - `assignment_status = 'assigned'`.
   - `campaign_id` = Archy campaign.
   - Copy company, contact, phone, address, city, state, zip, lat, lon.
7. Port existing `delivery_statuses` by joining on `legacy_id`, rewriting the PK to the new `recipient_id`.
8. Port existing `route_overrides` into `routes` keyed by `(Archy campaign, bakery_id)`. Where a bakery had multiple regions (Boho Petite = SF + South Bay), keep them as two separate `routes` rows for now.
9. Leave the old `route_overrides` and `depot_overrides` tables in place for 30 days, then drop in a follow-up migration.
10. Retire the hardcoded `REGIONS` constant and `public/data/routes.js` from runtime — still checked into the repo for reference for 30 days.

## Error Handling & Edge Cases

- **Geocode failures** — persisted as `geocode_failed`; customer can edit inline and retry one row at a time. The retry hits `geocode-single` (a tiny helper endpoint, or an inline client-side call now that the row is isolated).
- **Out-of-area flagged rows** — stay in DB with `bakery_id = null`; invisible to bakeries; visible to customer + admin. When a new `delivery_areas` row is inserted or edited, `rematch-recipients` runs and rescues any flagged rows that now fall inside a polygon.
- **Multiple polygon overlap** — warned at admin draw time (v1); not possible to resolve automatically until v2 multi-bakery support.
- **Bakery with no depots** — ingest refuses to assign to that bakery; flags as `needs_review` with reason `"bakery has no depot"`.
- **Customer re-uploads same file** — idempotent via `(campaign_id, legacy_id_hash)` unique index.
- **Polygon edit after recipients assigned** — existing assignments are not retroactively unassigned; admin can run "re-match this campaign" manually if needed.
- **AI batch failure (OpenAI down)** — fall back to a naive header-name heuristic for column mapping and skip row normalization. Customer sees a warning banner: "AI cleaning unavailable — raw data used." The pipeline still produces results.
- **Mapbox rate limit / outage** — batch retries with exponential backoff; on total failure, rows land in `geocode_failed` and the customer can retry later.

## Testing Notes

- **Unit**: CSV/XLSX parsing (happy path, weird headers, empty rows, non-ASCII), geocode cache hit/miss, point-in-polygon edge cases (on-border, multi-polygon, holes), idempotent insert on legacy_id.
- **AI contract tests**: a small fixture set of realistic messy rows with expected cleaned output. Asserts the model doesn't invent missing data (returns `null` instead). Run on CI against a deterministic model setting (`temperature=0`).
- **End-to-end**: spin up a test Supabase project, run migration, upload a 20-row CSV with a mix of in-area/out-of-area/typo rows, assert the buckets come out right.
- **RLS tests**: using a bakery token, assert you can't read another bakery's recipients or any customer's email. Using a customer token, assert you can't read another customer's campaigns.

## Sequencing (not yet a plan — the writing-plans skill will produce that)

High level ordering so the writing-plans output has shape:

1. New Supabase schema + RLS + migration SQL (without dropping old tables).
2. `create-bakery` edge function + admin UI skeleton + `DeliveryAreaDraw` component.
3. Migrate the existing Archy campaign into the new schema (read path still on old data until we flip).
4. Flip the existing ops view to read from `recipients` + `routes` instead of `ROUTE_DATA`.
5. `ingest-recipients` edge function (AI + Mapbox + area match).
6. Customer upload wizard + per-campaign progress view.
7. Admin settings panel (OpenAI key input).
8. `rematch-recipients` edge function + polygon edit flow.
9. Retire old tables; delete `public/data/routes.js`.

## Open Items (resolved before plan writing)

None. All decisions above are confirmed.
