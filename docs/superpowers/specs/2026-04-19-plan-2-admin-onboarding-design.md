# Plan 2 — Admin + Bakery Onboarding — Design Spec

**Date:** 2026-04-19
**Status:** Draft, pending user review
**Scope:** Add an admin UI so new bakeries and customers can be onboarded from the browser. Temporarily disable tenant authentication so any visitor can act as admin, as any bakery, or as any customer, while the infrastructure for tokenized tenant auth stays in place for a later plan.

## Goal

After Plan 2, an operator visiting the app can:

1. Land on a profile picker and choose to act as Admin, any bakery, or any customer.
2. As Admin, see a list of bakeries and customers, create new ones, edit existing ones, and jump into any tenant's view via "View as →".
3. As Admin, draw (or redraw) one or more polygon service areas for a bakery on a map and manage its depots, saving everything in one click.
4. As any bakery, continue using the existing `OpsView` scoped to that bakery's campaign.
5. As any customer, see a read-only dashboard of their campaigns with a disabled "Upload campaign" CTA that Plan 3 will wire up.

## Explicit Non-Goals

- Real authentication (tokens, passwords, Supabase Auth). Token infrastructure from Plan 1 stays in the repo for a later reactivation.
- Admin-auth plumbing (no `admins` table, no admin-only edge functions).
- `create-bakery` / `create-customer` edge functions. Writes go direct from the browser against permissive RLS.
- `SettingsPanel` for OpenAI / Mapbox keys. Deferred to Plan 3 when ingest actually needs them.
- Customer CSV upload, AI ingest, geocoding pipeline (Plan 3).
- Rematch-on-polygon-edit for previously flagged recipients (Plan 4).
- Path-based routing. Plan 2 uses hash-based routes (`#/admin`, `#/bakery/<id>`, `#/customer/<id>`).
- Bakery deletion with cascade to assigned recipients. Deferred until we decide the cascade UX.

## Guiding Decisions

| Decision | Choice | Why |
|---|---|---|
| Authentication posture for this plan | None. Open to all visitors. | User request: "just let users freely access any profile since Archy is our first run." Keeps onboarding shippable; token work already done is preserved for a later plan. |
| Profile selection UX | Landing picker + persistent header dropdown + "View as →" links on each admin row | Admin constantly needs to sanity-check "what will this bakery see after I draw their polygon?" — a one-click "View as" makes that a second-nature loop. |
| Routing | Hash router (`#/admin`, `#/bakery/<id>`, `#/customer/<id>`) | Deep-linkable, refresh-safe, zero server config. Static-hosting friendly. Upgradable to path-based later with a server rewrite. |
| Bakery editor layout | Single-page sidebar form + live map (layout A of the mockup) | Unified create/edit UI. One component to build and maintain. Form fields stay visible while the map takes most of the space. |
| Map library | Keep MapLibre GL (already loaded). `@mapbox/mapbox-gl-draw` for drawing via CDN. | Avoids adding a second map library. `mapbox-gl-draw` works with MapLibre via a tiny well-known compat shim. |
| Polygon tools | Polygon, rectangle, edit-vertex, delete. No circle. | Circle → polygon conversion adds code for zero payoff; admin can polygon an approximate circle in under a minute. |
| Polygon overlap between bakeries | Warn with banner, do not block | Spec allows one bakery per area in v1 but operators occasionally need to stage overlaps temporarily. Warn, let them decide. |
| `access_token` generation | Client-side `crypto.randomUUID()` on insert | No auth today, but we keep the column populated so the day we re-enable tokens every existing tenant already has one. |
| Customer upload button | Rendered but disabled with "(coming soon)" label | Locks the layout for Plan 3 so that plan only wires the click handler. |

## Architecture

No build step, no new backend. Same `public/index.html` loading JSX via babel-standalone. New capabilities arrive as:

- One SQL migration that reverts RLS enforcement.
- Renamed tenant config → profile config, plus a new hash router.
- Two new data-access modules (`admin.js` + reuse of existing `DB2.js`).
- New React components: `AdminView`, `BakeryEditor`, `CustomerEditor`, `CustomerHomeView`, `BakeryHomeView`, `ProfileSwitcher`, `LandingPicker`.

### Component map

```
public/index.html
└── App.jsx (route-aware shell)
    ├── LandingPicker (new)  — mounts when no profile selected
    ├── AdminView (new)
    │   ├── BakeryList → "View as →" + "Edit" per row + "+ New bakery"
    │   ├── BakeryEditor (new — shared create/edit)
    │   │   ├── sidebar: bakery form, delivery-area list, DepotManager (existing, reused)
    │   │   └── map: MapLibre + mapbox-gl-draw
    │   ├── CustomerList → "View as →" + "Edit" per row + "+ New customer"
    │   └── CustomerEditor (new — flat form)
    ├── BakeryHomeView (new thin wrapper) → mounts existing OpsView scoped to (bakery_id, campaign_id)
    ├── CustomerHomeView (new) → campaign progress cards + disabled upload CTA
    └── ProfileSwitcher (new) — dropdown rendered in every view's header
```

### Profile model

`public/src/config/tenant.js` is renamed to `public/src/config/profile.js` and rewritten. Its job:

1. Parse `window.location.hash`. If it matches `#/admin`, `#/bakery/<uuid>`, or `#/customer/<uuid>`, use that as the active profile.
2. Else if `?profile=<type>:<uuid>` is in the URL, write it to `localStorage` (mirror of Plan 1's `?tok=` behavior) and redirect to the matching hash.
3. Else if `localStorage.getItem('profile')` is set, redirect to the matching hash.
4. Else mount the `LandingPicker` component.

Exports:

```js
window.__CURRENT_PROFILE__ = { type: 'admin' | 'bakery' | 'customer', id: uuid | null, name: string };
window.switchProfile({ type, id });   // updates localStorage, sets hash, triggers re-render
window.signOutProfile();              // clears localStorage, navigates to landing
```

No tenant token is attached to the supabase client. `makeTenantClient` stays exported from `supabase.js` but unused — kept for the re-enable-auth plan later.

### Routing

New file: `public/src/config/router.js` (≈40 lines).

Responsibilities:

- Parse `location.hash` into `{ view: 'admin'|'bakery'|'customer'|'landing', subroute?, id? }`.
- Subscribe to `hashchange`; re-render `App` on change.
- Expose `window.navigate(hash)` for internal use (used by `switchProfile` and "View as →").

`App.jsx` becomes a thin switch that picks a component based on the current route and the current profile. Landing picker is rendered when no profile is set, regardless of hash.

### RLS migration 006

New file: `supabase/migrations/006_relax_rls.sql`.

1. `drop policy if exists …` for every policy created by migrations 004 and 005 (named explicitly; see migration for full list).
2. `drop function if exists` for the 005 cross-table helpers is **not** done — helpers stay in the DB for reuse when auth is re-enabled.
3. For each table (`bakeries`, `customers`, `delivery_areas`, `depots`, `campaigns`, `recipients`, `routes`, `delivery_statuses_v2`, `geocode_cache`): create a single `plan2_<table>_all` policy `for all using (true) with check (true)`.
4. `app_settings` is not touched — it keeps its deny-all posture (service role only).
5. RLS stays **enabled** on every table; we rely on permissive policies rather than `disable row level security`. The re-enable migration then only has to drop the `plan2_*_all` policies and add the real token-scoped ones; no table-level flip needed.

The tenant-auth probe in `supabase.js` (the `rpc('tenant_is_authenticated')` call that signs out on rejection) is removed — nothing to probe.

### Data access

**Reads/writes** go through the existing `sb` client. No new client needed.

**New module: `public/src/db/admin.js`.** A thin façade grouping Plan 2's writes:

```js
listBakeries()                                    // → [{id, name, contact_email, contact_phone, access_token}]
listCustomers()                                   // → [{id, name, contact_email, access_token}]
getBakery(id)                                     // → { bakery, delivery_areas: [], depots: [] }
getCustomer(id)                                   // → { customer, campaigns: [] }
createBakery({ name, contact_email, contact_phone })  // generates access_token, returns row
updateBakery(id, patch)                           // name/email/phone
upsertDeliveryArea({ id?, bakery_id, name, geometry })  // geometry is GeoJSON Polygon
deleteDeliveryArea(id)
createCustomer({ name, contact_email })           // generates access_token, returns row
updateCustomer(id, patch)
```

Depot CRUD is **not** in `admin.js` — it reuses `DB2.upsertDepot` / `DB2.deleteDepot` already built in Plan 1.

`access_token` values are generated with `crypto.randomUUID()` at insert time. Both editors (`BakeryEditor`, `CustomerEditor`) surface the token as a "Share link" field with a copy-to-clipboard button and the URL shape `https://app/?profile=<type>:<id>#/<type>/<id>`. The `?profile=…` query param is parsed by `profile.js` to seed localStorage on first visit, mirroring the old `?tok=` handoff.

## Bakery Editor Internals

**Map instance.** A new MapLibre map constructed in `BakeryEditor.jsx`, separate from the OpsView map. Same basemap style as `MapView.jsx` to avoid basemap-key fork. Initial camera:

1. Fit to the union of existing polygons if any.
2. Else fit to the union of existing depot markers.
3. Else default to continental US at zoom 4.

**Draw plugin.** `@mapbox/mapbox-gl-draw@1.4.3` loaded via `https://unpkg.com/@mapbox/mapbox-gl-draw@1.4.3/dist/mapbox-gl-draw.js` (and the matching `.css`). A ~10-line MapLibre compat shim is inlined at the top of `BakeryEditor.jsx` — this is the canonical Draw-on-MapLibre workaround, well-understood and avoids pulling in a third dependency.

Tools enabled: `draw_polygon`, `draw_rectangle` (via [mapbox-gl-draw-rectangle-mode](https://github.com/geoman-io/mapbox-gl-draw-rectangle-mode), included from the same CDN), `direct_select` (vertex edit), `simple_select` (delete).

**Polygon ↔ row mapping.** Each Draw feature maps 1:1 to a `delivery_areas` row. Feature-id → row-id correspondence is tracked in a local state Map so the save handler can classify features as new / updated / deleted.

On editor load the existing `delivery_areas` rows for the bakery are inserted into `mapbox-gl-draw` and each one's Draw feature id is recorded in a local `featureIdToRowId` state Map together with a snapshot of the loaded GeoJSON. On save:

- Features whose Draw id is not in `featureIdToRowId` → `insert` into `delivery_areas`.
- Features whose Draw id is in `featureIdToRowId` and whose current GeoJSON differs from the saved snapshot → `update`.
- Row ids in `featureIdToRowId` whose Draw feature no longer exists (operator clicked delete) → `delete`.

Features untouched by the operator produce no write. Deletion is scoped strictly to features the user removed from the map during this editing session.

**Overlap warnings.** On `draw.create` and `draw.update`, call `Turf.booleanOverlap` of the newly-changed feature against every other feature — from every bakery, not just this one. If any overlap is detected, show a yellow banner at the top of the editor: *"This area overlaps with [N] existing area(s). Plan 2 allows this; when a recipient's point falls inside multiple polygons, the first match wins."* The save button remains enabled.

**Depot interaction.** Depots render as pins on the map (read-only — no drag, no click-to-add). Adding/editing depots happens via the sidebar, which embeds the existing `DepotManager` component scoped to the current bakery. `DepotManager` already handles address autocomplete + geocode + insert; no changes needed.

**Save semantics.** "Save bakery" triggers, in order:

1. `createBakery` (if new) or `updateBakery` (if editing).
2. Parallel `upsertDeliveryArea` / `deleteDeliveryArea` calls for every changed feature.
3. Toast confirmation.

No single transaction (no browser-side tx support without an edge function). Partial failures show an error toast naming the step that failed and what did persist. Acceptable because this is an admin-only wide-open UI and the operator can retry from a known state.

## Customer Home Stub

Scoped to `profile.id`. Renders:

- Customer name in header.
- For each `campaigns` row where `customer_id = profile.id`:
  - Campaign name, `status` pill.
  - Recipient counts by `assignment_status` (four small count pills: assigned / flagged / geocode_failed / needs_review).
  - A `ProgressBar` of delivered recipients over total (reading `delivery_statuses_v2`).
- A disabled "Upload campaign" button styled as a CTA, with secondary text "coming soon".

No map, no photo gallery, no drilldowns in Plan 2. That logic already exists in `CustomerView.jsx` and Plan 3/4 will wire it into this stub.

## Error Handling

- **Supabase insert/update fails** → toast with the error's message; form keeps user input intact for retry.
- **Geocode fails for a new depot** → handled by existing `DepotManager` (unchanged).
- **Invalid profile id in hash** (e.g. hand-edited `#/bakery/<non-existent-uuid>`) → fall back to landing picker with a one-line banner "Profile not found."
- **Drawing a self-intersecting polygon** → `mapbox-gl-draw` allows it; Turf.js `booleanOverlap` can still reason about them. We don't add validation; we accept weird shapes and let the Plan 3 area-match logic pick-first-match.
- **Concurrent edits** (two operators editing the same bakery) → last write wins; not addressed in Plan 2.

## Testing Notes

- **DB helper integration tests.** `scripts/admin-db/admin-db.test.js` (matches the `migrate-archy/lib.test.js` pattern). Verifies roundtrips for every `admin.js` function against the live Supabase project with the service role key. Ensures `access_token` is auto-generated and unique.
- **Turf overlap unit tests.** `public/src/admin/__tests__/overlap.test.js` for polygon overlap detection: disjoint, touching-only-edge, true-overlap, containment, multi-polygon. Runs in a tiny Node harness (matches existing `lib.test.js` style).
- **Manual smoke path** (verified at the end of the plan, before committing):
  1. Landing picker renders with four bakeries + one customer.
  2. Enter admin. Create "Test Bakery", draw two polygons, add one depot. Save.
  3. Refresh → new bakery appears in list with token populated.
  4. Click "View as →" on the new bakery → BakeryHomeView mounts. No campaigns yet (expected — nothing seeded for this bakery).
  5. Switch back to admin via dropdown. Polygon edits persist.
  6. Click "View as →" on Boho Petite → OpsView mounts, scoped to Boho Petite's Archy campaign slice. Regions, stops, depots render as before.
  7. "View as →" on Archy customer → CustomerHomeView shows the Archy × Daymaker Q2 2026 campaign with recipient counts. Upload button is disabled.
  8. Delete one of the test bakery's polygons from the map → save → row disappears in DB.

## Sequencing

The writing-plans skill will produce the detailed task list. High-level ordering:

1. Migration 006 (relax RLS) + remove the tenant-auth probe from `supabase.js`.
2. Rename `tenant.js` → `profile.js`; remove gate UI; add profile resolution + `LandingPicker` + `window.switchProfile`.
3. Add `router.js` (hash-based) and restructure `App.jsx` to mount the route-appropriate component.
4. Add `admin.js` DB helpers. Wire integration tests.
5. Build `AdminView` shell + `BakeryList` + `CustomerList` with "View as →" links (no editor yet).
6. Build `BakeryEditor` — sidebar form, `DepotManager` reuse, map placeholder.
7. Wire MapLibre + `mapbox-gl-draw` into `BakeryEditor`. Implement create/update/delete for `delivery_areas`. Overlap warnings.
8. Build `CustomerEditor` and `CustomerHomeView` stub.
9. Add `ProfileSwitcher` dropdown; mount it in every view's header.
10. End-to-end smoke test. Split commits by task. Done.

## Open Items

None. Design is resolved.
