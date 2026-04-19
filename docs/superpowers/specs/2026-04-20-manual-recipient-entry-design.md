# Manual Recipient Entry — Design

**Date:** 2026-04-20
**Status:** Draft, awaiting user review

## Problem

Today, the Upload Wizard's only path to add recipients is **Step 1 (File)** → upload CSV/XLSX → **Step 2 (Columns)** map → **Step 3 (Review)**. Customers who want to add a single recipient (or a small handful) must construct a spreadsheet first. They've asked to enter recipients manually, one at a time, without a file.

## Goals

- Let a customer create an entire campaign by typing recipients in, no file required.
- Let a customer **append** manual recipients to a campaign that *was* started from a file.
- Reuse the existing geocode + area-match + bucket pipeline so manually entered rows behave identically to ingested rows (same buckets, same actions, same dedup).
- Make address entry fast: typing the street auto-suggests the full address, and picking a suggestion fills `address`, `city`, `state`, and `zip` in one click.

## Non-goals

- Bulk paste (e.g., multi-row paste from Excel into the form). Out of scope.
- Inline editable grid in Review. The form is a modal; row editing in Review continues to work as it does today.
- New permissions or auth model. Same RLS as the existing flow.

## Two entry points

### A. Step 1 (File) alternative

Below the existing file dropzone, a divider (**or**) and a secondary action:

> **Add recipients one at a time** — skip the file, enter recipients manually

Picking this still requires a campaign name. Clicking **Continue** creates the draft campaign (same `Customer.createDraftCampaign` call as today's file path) and **jumps straight to Step 3 (Review)** — Step 2 (Columns) is bypassed because there is no file to map. The wizard rail visually marks Step 2 as skipped (✓ greyed out, no click target).

### B. Step 3 (Review) "+ Add recipient" button

A primary button anchored above the bucket tabs, **always visible** on Review regardless of how the campaign was started. Clicking it opens the same modal form. New rows appear in their bucketed tab as soon as the server responds.

Both entry points open the **same** `ManualRecipientForm` modal — single source of truth.

## The form (modal)

Layout: a tight 2-column grid, ~520px wide.

| Required | Optional |
|---|---|
| Company * | Contact name |
| Address * (autocomplete) | Phone |
| City | Email |
| State, ZIP | |

### Address autocomplete

The **Address** input uses Mapbox Searchbox `suggest` (typeahead) + `retrieve` (resolve to coords + structured pieces). The wizard already has a working implementation embedded inside `DepotManager.jsx` — we extract it to a shared component `public/src/components/AddressAutocomplete.jsx` and reuse it in both places.

When the user picks a suggestion, the form **autofills four fields at once**:

- `address` — the street line (e.g., `"330 Main St"`)
- `city` — from Mapbox `properties.context.place.name`
- `state` — from Mapbox `properties.context.region.region_code` (2-letter code)
- `zip` — from Mapbox `properties.context.postcode.name`

…plus stashes `lat / lon` in component state for the submit call (avoids a second server-side geocode).

All four fields remain **editable** after autofill — Mapbox occasionally splits things wrong, and we trust the human override.

If Mapbox returns no suggestions or fails (no token, network error, etc.), the field falls back to a plain text input. The user can still type the full address; the server's geocode pipeline (Mapbox forward → Nominatim cascade) handles it on submit.

### Form actions

- **Save** — disabled until `company` and `address` are non-empty. On click, POSTs to the server, closes the modal on success, refreshes the Review list.
- **Save & add another** — same as Save but keeps the modal open; clears `company`, `contact_name`, `phone`, `email`, `address`, `city`, `state`, `zip` and refocuses Company. Designed for entering many recipients in a row.
- **Cancel** — closes the modal, discards form state.

## Submission path

A new edge sub-route **`POST /ingest-recipients/manual-add`**, sibling to the existing `/geocode-single`.

**Request:**

```json
{
  "campaign_id": "uuid",
  "company": "Acme Dental",
  "contact_name": "Dr. Smith",
  "phone": "415-555-0100",
  "email": "front@acme.example",
  "address": "330 Main St",
  "city": "San Francisco",
  "state": "CA",
  "zip": "94105",
  "lat": 37.7891,
  "lon": -122.3942
}
```

`lat / lon` are optional. If supplied (from a Mapbox `retrieve`), the server **skips its own geocode** and trusts them. If absent, the server geocodes via the existing `geocodeRows` (single-row batch).

**Server logic** (composes existing helpers — no new pipeline):

1. Validate `campaign_id` exists and `company` + `address` are non-empty (returns `400` otherwise).
2. Compute `legacy_id = await legacyId(company, address)`.
3. Check for an existing recipient in this campaign with the same `legacy_id`. If found, return `{ duplicate: true, recipient_id: <existing>, ... }` without inserting.
4. If `lat/lon` not provided → `geocodeRows(sb, [{address, city, state, zip}])`.
5. `loadAreas(sb)` → `findAreaIn(areas, lon, lat)` → `bucketFor({hasCompany, hasAddress, aiConfidence: 'high', geocodeOk, areaMatch})`.
6. INSERT into `recipients` with the resulting `assignment_status`, `bakery_id`, `lat`, `lon`, `legacy_id`, and `customizations: {}`.

**Response:**

```json
{
  "recipient_id": "uuid",
  "assignment_status": "assigned" | "needs_review" | "flagged_out_of_area" | "geocode_failed",
  "lat": 37.7891,
  "lon": -122.3942,
  "bakery_id": "uuid|null",
  "duplicate": false
}
```

**Why a new sub-route, not extending `/geocode-single`?** `/geocode-single` updates an existing recipient by `recipient_id`. Manual-add *creates* a new one. The contracts are genuinely different. They share internals (`geocodeRows`, `loadAreas`, `findAreaIn`, `bucketFor`, `legacyId`) — the duplication is one URL string and one dispatch line, not pipeline logic.

## Client API

New helper in `public/src/db/customer.js`:

```js
async addRecipient({ campaign_id, company, contact_name, phone, email,
                     address, city, state, zip, lat, lon }) {
  // POST to ingest-recipients/manual-add, return parsed JSON.
  // Throws on non-2xx.
}
```

Review's existing `reload()` is invoked after the call resolves, picking up the new row and routing it to the correct bucket tab automatically.

## Empty-state on Review

Today, Review with zero recipients shows "Loading…" then four empty bucket tabs. With the manual-only path, that *is* the normal starting state, so we treat it explicitly:

- When `recipients.length === 0`, render a single empty-state panel:
  > **No recipients yet.** Click **+ Add recipient** above to get started.

  …instead of the bucket tabs row.
- The wizard footer's **Continue to designs ›** is disabled until `recipients.length >= 1`. The footer hint reads `"Add at least 1 recipient to continue"` in this state.

## Files touched

**New files**

- `public/src/components/AddressAutocomplete.jsx` — extracted from `DepotManager.jsx`, exposed via `window.AddressAutocomplete` like sibling components.
- `public/src/components/ManualRecipientForm.jsx` — the modal form; takes `{campaignId, onSaved, onClose}` props.

**Modified files**

- `public/src/components/UploadWizard.jsx` — Step 1 alternative entry option, Step 3 "+ Add recipient" button + modal mount, skip-Step-2 routing, empty-state on Review, disabled Continue when zero recipients.
- `public/src/components/DepotManager.jsx` — replace inline `AddressAutocomplete` with import from new shared component.
- `public/src/db/customer.js` — add `addRecipient()` helper.
- `public/src/utils/geocode.js` — extend `retrieveAddress` to also return `{city, state, zip}` parsed from Mapbox's `properties.context`. Existing callers (DepotManager) ignore those new fields and continue to work unchanged.
- `supabase/functions/ingest-recipients/index.ts` — register `manual-add` sub-route + handler.
- `public/index.html` — add `<script>` tags for the two new component files (matches the project's no-bundler convention).

## Edge cases & decisions

1. **Duplicate detection** — re-uses `legacyId(company, address)` (the same hash the bulk path uses for upsert dedup). Manual entries that collide with an existing row in the campaign return `{duplicate: true, recipient_id}`; the modal shows a toast: *"This recipient is already in the campaign."* and offers a **Jump to row** link that scrolls Review to it. The existing row is left untouched.
2. **Server geocode fallback** — if the user typed an address without picking a suggestion (no `lat/lon` in the request), the server runs the same geocode + area-match + bucket cascade as the bulk path. A row that fails geocoding lands in the `geocode_failed` bucket and the modal closes — the user sees it appear in that tab and can use the existing **Edit & retry** action.
3. **Resume detection** — today, opening a campaign that already has recipients jumps straight to Step 4 (Designs). We preserve that. The Step-3 "+ Add recipient" button is still reachable by clicking **‹ Back** from Designs.
4. **Validation parity** — server enforces `company.trim().length > 0` and `address.trim().length > 0` (matches the bulk path's requirement implied by the column-mapping check). 400 with `{error: "missing_required_fields"}` if either is empty, even though the client also blocks Save in that case.
5. **No new RLS work** — the edge function uses the service-role key (same as bulk ingest). Browser-side calls to `Customer.addRecipient` go through the edge function, not direct table writes.
6. **Concurrency** — if two `manual-add` calls land at the same instant for the same `(campaign_id, legacy_id)`, the table's existing `(campaign_id, legacy_id)` unique constraint (used by the bulk upsert) protects us. The handler does the duplicate-check first; the unique index is the safety net for the race.

## Testing

The new sub-route is a thin composition of pieces already covered by `supabase/functions/ingest-recipients/test.ts`. We add **one** integration test there:

- `manual-add succeeds with all 8 fields and lat/lon supplied` — POST → 200 → row exists in `recipients` with the correct `assignment_status`.

Manual smoke (out-of-band): try the empty path (campaign with only manual entries), the append path (file + manual), and the duplicate-collision path.
