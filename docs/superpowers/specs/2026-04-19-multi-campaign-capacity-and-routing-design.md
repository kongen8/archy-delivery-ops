# Multi-Campaign Capacity & Cross-Campaign Routing — Design Spec

**Date:** 2026-04-19
**Status:** Approved, pending user review
**Scope:** Make capacity a first-class concept so multiple customers can book the same bakery without manual confirmation, support per-recipient delivery dates, and pivot the bakery's ops view from per-campaign to per-day so routes optimize across campaigns. Add an external box-label print artifact so the bakery and driver can keep intertwined campaigns straight at loading time.

## Goal

Today the system runs one campaign per bakery view, and the bakery picks an abstract `ndays` spread with no calendar dates. That breaks down the moment two customers book the same bakery for the same week — the bakery has no way to enforce capacity, no way to merge stops across campaigns into one optimized route, and no way to keep boxes from getting mixed up at loading.

This spec turns that into a **capacity-aware booking** system (like grocery delivery slots): bakeries set daily capacity, customers pick from available dates at upload time, and the bakery's ops view becomes day-first so cross-campaign routing happens automatically. A new external box label replaces the manual pen markings the bakery uses today to distinguish boxes from different campaigns.

Out of scope (deferred): Stripe payment integration plumbing (the design assumes booking-time payment but doesn't build the integration), pricing models (rush surcharges, per-bakery pricing), driver-facing mobile changes beyond what the OpsView already shows, customer-facing post-booking edit flows.

## Guiding Decisions

| Decision | Choice | Why |
|---|---|---|
| Where `delivery_date` lives | On `recipients`, not on `campaigns` | Auto-split across days is trivially expressed; "all recipients at bakery X on date Y" is one query; per-recipient birthday/anniversary use cases work for free |
| Capacity unit | Per-bakery toggle: simple count OR sized (S/M/L) | Bakeries with uniform output use simple; bakeries where a 12" tiered cake is 5x the work of a cupcake box use sized |
| Capacity layering | Base capacity + dated overrides (with optional reservation) | Lets a bakery negotiate a special order ("Archy 1000 cakes, Nov 17–21") without rewriting their default capacity |
| Booking confirmation | Auto, at customer checkout (no human in the loop) | Stripe-friendly; capacity is the gate, not bakery judgment |
| Slot reservation during checkout | 15-minute soft hold | Prevents double-booking during simultaneous customer checkouts without permanent stale holds |
| Bakery OpsView grouping | Day-first, with per-campaign filter chips | The day IS the route. Per-campaign view is a spot-check lens, not the primary mental model |
| Cross-campaign route input | All assigned recipients with `(bakery_id, delivery_date)` go into one VRP solve | Routing has nothing campaign-specific in it; campaigns are a labeling layer |
| Distinguishability at the bakery | New external box label (4×2" adhesive) with stop # + recipient + campaign color band | Replaces manual pen markings; auto-printed in stop order; color band gives at-a-glance scan |
| Label default | On for days with 2+ campaigns at a bakery, off otherwise; per-campaign override | Single-campaign days don't waste paper; busy days don't require manual toggle |

## Architecture

No new top-level routes, frameworks, or services. The existing `bakery/`, `customer/`, and `admin/` views absorb new tabs and steps. The existing `ingest-recipients` edge function gains a post-step for capacity availability; one new edge function (`book-campaign-slot`) handles the atomic capacity reservation. The VRP solver is unchanged in shape — only its input set changes from "campaign's recipients" to "date's recipients across all campaigns".

### What's added

- **3 new tables**: `bakery_capacity` (one row per bakery), `capacity_overrides` (one row per bakery × date with bumps), `slot_holds` (transient, for the 15-min checkout hold)
- **2 new columns on `recipients`**: `delivery_date` (date, nullable until booked), `size` (text S/M/L, nullable when bakery is in simple mode)
- **2 new columns on `campaigns`**: `color_hex` (text, nullable; auto-assigned at create time, customer can override) and `label_print_mode` (`auto`/`always`/`never`, default `auto`)
- **2 new columns on `routes`**: `delivery_date` (date, not null) added; `campaign_id` removed. New unique on `(bakery_id, delivery_date, delivery_area_id)`.
- External labels add no new columns — they render from existing recipient + campaign fields.
- **New customer wizard step**: "Pick delivery date(s)" between ingest results and finalize. Shows the capacity-aware calendar; offers auto-split if no single date fits.
- **New bakery admin panel**: "Capacity" — sets base capacity, sizing mode, lead time, blackouts, and manages overrides.
- **New bakery OpsView shell**: date strip on top, campaign filter chips, day-merged route list. Existing Routes / Production / Photos tabs all become date-scoped.
- **New print artifact**: 4×2" external box label, 10-up letter sheet (Avery 5163-style), prints from the day-view toolbar.
- **1 new edge function**: `book-campaign-slot` — atomic reserve + commit (or release) of capacity on the chosen date(s).

### What's changed (not net-new)

- `OpsView` reorients around `(bakery, date)` instead of `(bakery, campaign)`. The campaign picker view (`/bakery/:token`) becomes a calendar landing instead of a campaign list.
- `routes` table gets a `delivery_date` column and the unique index becomes `(bakery_id, delivery_date, delivery_area_id)`. The old `campaign_id` column is dropped — routes are no longer per-campaign.
- The `ingest-recipients` edge function returns the per-bakery cake count split so the wizard can compute the available calendar without a second round trip.
- The Production tab keeps its grid of recipient cards but filters by `(bakery, date, campaign?)` instead of `(bakery, campaign)`.

### What's deleted

- The `ndays` and `nd` (number of drivers) fields baked into the old `ROUTE_DATA` shape are no longer the planning unit. Driver count is still a per-day knob in OpsView; days disappear in favor of calendar dates.

## Data Model

Three new tables and a handful of column additions. Idempotent migrations; nullable defaults on new columns to keep existing data valid.

### `bakery_capacity` (new)

| Column | Type | Notes |
|---|---|---|
| bakery_id | uuid pk fk → bakeries | one row per bakery |
| sizing_mode | text | `simple` \| `sized`; default `simple` |
| base_small | int | nullable when `simple`; required in `sized` |
| base_medium | int | required in both modes; in `simple` mode this is the single per-day capacity number |
| base_large | int | nullable when `simple`; required in `sized` |
| lead_days | int | default 3 |
| blackout_dows | int[] | array of weekday ints (0=Sun); default `'{0}'` |
| updated_at | timestamptz | |

Conventions:
- `simple` mode reads `base_medium` as "capacity per day" and ignores small/large.
- `sized` mode requires all three.
- Validation enforced in the edge function, not the DB (kept simple).

### `capacity_overrides` (new)

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| bakery_id | uuid fk → bakeries | |
| date | date | the date the override applies to |
| delta_small | int | default 0; can be negative to reduce capacity |
| delta_medium | int | default 0 |
| delta_large | int | default 0 |
| reason | text | freeform note shown in admin UI |
| reserved_for_customer_id | uuid fk → customers, nullable | when set, only that customer's bookings can consume the bumped slots |
| reserved_until | date, nullable | reservation expires after this date; bumped slots become bookable by anyone |
| created_at | timestamptz | |

Unique on `(bakery_id, date)` — at most one override row per bakery per date. Edits replace; multiple bumps on the same date are summed into one row.

### `slot_holds` (new — transient)

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| bakery_id | uuid fk → bakeries | |
| date | date | |
| campaign_id | uuid fk → campaigns | the campaign-in-progress holding the slot |
| count_small | int | default 0 |
| count_medium | int | default 0 |
| count_large | int | default 0 |
| expires_at | timestamptz | now() + 15 min on insert |

A periodic cleanup (or read-time filter on `expires_at > now()`) keeps this from accumulating. Capacity availability calculations subtract live (non-expired) holds.

### `recipients` (column additions)

| Column | Type | Notes |
|---|---|---|
| delivery_date | date, nullable | set when the campaign is booked. Until then, recipient is "assigned but not scheduled". |
| size | text, nullable | `small` \| `medium` \| `large`; only used when the recipient's bakery is in `sized` mode. Default `medium` if missing in sized mode. |

### `campaigns` (column additions)

| Column | Type | Notes |
|---|---|---|
| color_hex | text, nullable | display color for this campaign across the bakery's UI and box labels. Auto-assigned at create time from a fixed palette of 8 colors using a deterministic hash of `id`. Customer can override at campaign creation. |
| label_print_mode | text | `auto` \| `always` \| `never`; default `auto`. Controls whether external box labels print for this campaign. `auto` = print only if the day has 2+ campaigns at a bakery. |

### `routes` (re-keyed, column additions)

| Column | Type | Notes |
|---|---|---|
| delivery_date | date, not null | new |
| campaign_id | dropped | routes are no longer per-campaign |

Unique on `(bakery_id, delivery_date, delivery_area_id)`. Existing `data` jsonb shape is preserved (days, drivers, stops, etc.) but the planning unit collapses to one date per row.

## Capacity Calculation

For a `(bakery, date, size)` triple, available capacity is:

```
base[size]
  + sum(overrides[bakery, date].delta[size])
  - sum(recipients[bakery, date].size = size where assignment_status = 'assigned' and delivery_date is not null)
  - sum(slot_holds[bakery, date].count[size] where expires_at > now())
```

Reserved-overrides constrain who can consume them: when computing availability for customer C, drop overrides where `reserved_for_customer_id IS NOT NULL AND reserved_for_customer_id != C AND reserved_until > today`.

Past dates are always 0 available. Dates before `today + lead_days` are always 0. Blackout DOWs are always 0.

In `simple` mode, `size` is treated as `medium` everywhere — the small and large buckets aren't queried.

## Customer Wizard — New "Pick Delivery Date" Step

Inserted between the existing ingest-results step and finalize. Flow:

1. After ingest, the wizard knows the per-bakery cake counts (and per-size counts when bakery is sized). e.g. *"Boho Petite: 80 medium, SLJ: 60 medium, SmallCakes: 40 small, Roland's: 20 large."*
2. Wizard fetches the next 30 days of capacity from `book-campaign-slot` with action `availability`. Server returns per-date availability per bakery, intersected to a single-date verdict for the campaign:
   - **Green** — every touched bakery has room for its slice on this date.
   - **Yellow** — some bakery is short; auto-split is possible (i.e. the missing bakery has room on a nearby date).
   - **Red** — past lead time, blackout, or some bakery is full and the next date with room is too far out (>14 days).
3. Calendar shows the next 30 days as a 5-column grid (or 7 if the user prefers calendar mode). Each cell is colored, with one-line explanation on hover ("Boho Petite: 0 medium left; next open: Mon 23").
4. **Single-date booking:** click a green cell → "Book all 200 deliveries for Wed Nov 18". Slot hold created for each touched bakery (15 min), Stripe checkout opens, on success the hold becomes commitments (writes `delivery_date` on each recipient + `routes` rows for the day are scheduled for re-solve).
5. **Auto-split:** click a yellow cell → wizard proposes a 2-date split. e.g. *"Wed Nov 18 fits Boho + SLJ + Roland's (160 of 200). SmallCakes' 40 fit Thu Nov 19. Book both?"*. Customer accepts as a single payment; both dates get holds + commitments under one Stripe charge.
6. **No-fit (red) cells:** disabled, with the reason inline. Customer can still pick a green/yellow date instead.

Wizard never lets the customer commit a date that's actually full at checkout time — `book-campaign-slot` re-checks at commit and fails atomically if anything changed since the hold (rare, but possible if a reserved customer bypassed the hold). On failure, customer is bounced back to the calendar with a fresh availability fetch.

## Bakery Admin — Capacity Panel

A new tab in the bakery's existing settings area (or a top-level entry in BakeryHomeView).

Sections:

1. **Lead time** — single int input, days. Default 3.
2. **Blackout days** — weekday toggles (Sun–Sat). Default Sun off.
3. **Sizing mode** — simple / sized toggle. Sized mode reveals three capacity inputs; simple mode shows one.
4. **Daily capacity** — base numbers per size (or one number in simple mode).
5. **Overrides table** — list of dated bumps with reason and optional reservation. Add/edit modal. Date-range bulk add ("+120 medium per day, Nov 17–21, reserved for Archy until Nov 1").
6. **Calendar preview** — the next 30 days rendered with the resulting effective capacity per date, so the bakery can sanity-check.

Switching from `simple` → `sized` triggers a one-time migration prompt: "Set sizes for your existing assigned recipients." Default-bulk-medium with a per-recipient editable list, or skip and accept all-medium.

## Bakery Ops — Day-First View

The existing `OpsView` is reoriented. The route is `/bakery/:token` → calendar landing → click date → day view.

### Calendar landing

A 30-day calendar showing each date colored by load (green/yellow/red gradient by % capacity used). Stop and campaign counts on each cell. Click a date to open the day view.

### Day view

Top-to-bottom layout (mocked at `.superpowers/mockups/multi-campaign-day-view.html`):

1. **Bakery header** — name, region, selected date.
2. **Date strip** — horizontal scroll of nearby dates with stop and campaign counts. Click to switch dates.
3. **Tab bar** — Routes / Production / Photos. All three are now date-scoped.
4. **Campaign filter chips** — `All campaigns · N` plus one chip per campaign present on this date with its color swatch and stop count. Click a campaign chip to filter to just that campaign across all three tabs.
5. **Routes tab body** — per-driver merged routes. Stops show stop number, color band (campaign), recipient company, address, time window, status. Map on the right mirrors the colors.
6. **Production tab body** — same grid of recipient cards as today's plan-5 mockup, just filtered to `(bakery, date, optional campaign)`. Toolbar gains "Print all box labels" alongside "Print all box cards".
7. **Photos tab body** — same as today, date-scoped.
8. **Production summary footer** — total cakes today, per-campaign breakdown, capacity used (e.g. "42 / 80"), bulk print/download actions.

Re-optimize button at the top right runs the cross-campaign VRP for the selected date and re-saves the day's `routes` row(s).

## External Box Labels — New Print Artifact

A 4×2" adhesive label that goes on the outside of every box. 10-up on a letter sheet (Avery 5163-style). Auto-printed in stop order from the day view's "Print all box labels" action.

Per label:

- **Stop number** (large, top-left) — drives loading order.
- **Recipient company** (large) — primary identifier at the door.
- **Campaign band** (top color stripe with campaign name + delivery date) — at-a-glance distinction during loading.
- **Route + driver + time window** (small, top-right meta block).
- **Address** (small, bottom of body).
- **Footer** — bakery name, recipient short id (for support reference), cake size if sized mode.

Default visibility (`label_print_mode = 'auto'` on `campaigns`): only print labels for a campaign on a given day if 2+ campaigns share that day at the bakery. Bakery can force-print or force-skip by overriding the campaign's `label_print_mode`.

The existing 4×6 box card (inside the box, recipient-facing) is unchanged. The new label is bakery/driver-facing and additive.

Mockups:
- `.superpowers/mockups/multi-campaign-box-labels.html` — single label, loading shelf, 10-up sheet
- `.superpowers/mockups/multi-campaign-day-view.html` — bakery's day-first ops view

## Edge Function — `book-campaign-slot`

One function, three actions, all server-side authoritative.

### `availability`

Input: `{ campaign_id }`. Function:
1. Reads recipients for the campaign grouped by `(bakery_id, size)`.
2. For each touched bakery, computes the next 30 days of effective capacity (base + overrides + reservation filter, minus assigned + held).
3. Intersects across bakeries: per date, returns `{ status: green | yellow | red, reasons: [...], split_proposal?: { date2, bakeries[] } }`.
4. Returns the per-date verdict array.

### `hold`

Input: `{ campaign_id, picks: [{ bakery_id, date, count_per_size }] }`. Function:
1. Validates each pick fits current effective capacity.
2. Inserts `slot_holds` rows with `expires_at = now() + 15 min`.
3. Returns hold ids and total amount due (delegated to pricing layer when that exists; for now, returns counts).

### `commit`

Input: `{ campaign_id, hold_ids[], stripe_payment_intent_id? }`. Function:
1. Verifies all holds exist and are unexpired.
2. Verifies capacity still fits (defensive — should always pass since the holds are reserving it).
3. Writes `delivery_date` (and `size` if needed) on each recipient.
4. Deletes the holds.
5. Marks the campaign `status = 'active'`.
6. Schedules a re-solve of the affected `(bakery, date)` pairs by writing a `routes` row stub with `data = null` and `dirty = true`. Bakery's day view triggers the actual VRP solve when first opened, or on the bakery's manual "Re-optimize day" press.

### `release` (rare)

Input: `{ hold_ids[] }`. Function: deletes the holds. Called when the customer abandons checkout or Stripe fails. Holds also auto-expire after 15 min so this is belt-and-suspenders.

## Cross-Campaign Routing

Once `recipients.delivery_date` is set, routing is mechanical. The existing VRP solver wrapper changes its input query from:

```sql
select * from recipients where campaign_id = $1 and bakery_id = $2 and assignment_status = 'assigned'
```

to:

```sql
select * from recipients
where bakery_id = $1
  and delivery_date = $2
  and assignment_status = 'assigned'
```

Per-delivery-area splitting still applies — `routes` is keyed by `(bakery_id, delivery_date, delivery_area_id)`. The solver still produces the same `data` jsonb shape (days/drivers/stops). The "days" dimension collapses to 1 (one solve per calendar date) but the schema doesn't need to change.

Stops in the solver output gain a `campaign_id` (and `campaign_color_hex`) so the day view can render the color bands. This is metadata in the solver output, not new solver logic.

## Migration

The existing Archy campaign already has recipients in the new schema (per the multi-tenant migration). To bring it into the new model:

1. Add the new tables and columns. Idempotent.
2. Insert a `bakery_capacity` row per existing bakery with `simple` mode, `base_medium = 80` (sensible default), `lead_days = 3`, blackouts `{0}`. Bakeries can edit afterward.
3. Backfill `delivery_date` on all existing assigned recipients to a single fixed date passed as a migration argument (intended: the originally-planned Archy delivery date). All existing recipients land on that one date so the existing route data still maps cleanly. The migration script accepts the date as a CLI flag (`--archy-delivery-date YYYY-MM-DD`) and refuses to run without it.
4. Re-write the existing `routes` rows to include `delivery_date`. Drop the now-orphan `campaign_id` column once the old read paths are off it.
5. Auto-assign `color_hex` to existing campaigns from the palette.

The migration is idempotent and can be run multiple times safely. Existing route data continues to render in the new day-view (the day strip will show the backfilled date with all stops on it).

## Error Handling & Edge Cases

- **Customer's recipients change after booking** (re-upload, edit) → recipients added after a date is booked default to `delivery_date = null`; customer is prompted to either pick a date for the new ones or assign them to the original date if capacity still fits.
- **Bakery reduces base capacity below already-booked load** → admin UI warns; existing bookings are honored, future availability reflects the reduced number.
- **Hold expires mid-checkout** (>15 min) → `commit` fails with `HOLD_EXPIRED`; customer is bounced to calendar with refreshed availability.
- **Concurrent bookings for last slot** → first `commit` wins; second gets `INSUFFICIENT_CAPACITY` and is bounced. Stripe charge is not captured until commit succeeds.
- **Override deletes a date that already has bookings** → admin UI prevents reducing effective capacity below the date's already-booked count; soft-warning UI explains.
- **Customer in sized mode bakery but no per-recipient size data** → wizard surfaces a step to assign sizes (default-bulk-medium with edit-down).
- **Re-optimize day after some stops are delivered** → solver respects `delivered` stops as immovable (treats them as already visited).
- **A recipient's bakery changes after booking** (e.g. a polygon edit reroutes them) → `delivery_date` carries over; system re-checks capacity at the new bakery and flags if it doesn't fit, prompting bakery admin or customer to act.
- **Color collisions** (two campaigns hash to the same color) → palette has 8 colors; collision rate within one bakery's day is low. When detected at render time for a specific day, alternate-hue assignment is applied (deterministic from id, but skips already-used colors on this day).

## Testing Notes

- **Unit**: capacity math (base + overrides + reservation filter + holds + assigned), simple-vs-sized parity, blackout & lead-time gates, override edit precedence.
- **Integration**: hold→commit happy path; hold→expire→commit failure; hold→release; concurrent commits on last slot; auto-split flow producing two delivery_dates from one campaign; reserved override blocks unrelated customer but admits the reserved one.
- **End-to-end**: customer uploads CSV → ingest assigns recipients to bakeries → wizard shows calendar → customer picks date with auto-split → both dates booked → bakery's day view shows the merged route with color bands → bakery prints box labels → routes solve cross-campaign for that date.
- **VRP regression**: assert that giving the solver a single campaign's recipients on a date produces the same plan as today (back-compat); assert that mixing two campaigns on the same date produces a route that's at most as long as the sum of the two solo solves (the cross-campaign solve should never be worse).
- **RLS**: customer can read availability for their own campaign only; bakery sees overrides and capacity for their own bakery only; one customer's reserved override doesn't leak the customer name to other customers.

## Sequencing (not yet a plan — the writing-plans skill produces that)

High level ordering so writing-plans has shape:

1. New tables (`bakery_capacity`, `capacity_overrides`, `slot_holds`) + new columns on `recipients`, `campaigns`, `routes`. Idempotent migration. Backfill `bakery_capacity` defaults and existing-recipient `delivery_date`. Re-key `routes`.
2. `book-campaign-slot` edge function with all three actions; capacity-math unit tests.
3. Bakery admin Capacity panel.
4. Customer wizard new "Pick delivery date" step + availability fetch.
5. External box label print artifact (10-up sheet, single label render, "Print all box labels" wired into existing print pipeline).
6. Bakery OpsView pivot to day-first: calendar landing, date strip, day view with merged routes + filter chips, date-scoped Production/Photos tabs.
7. VRP wrapper input swap from `(campaign, bakery)` to `(bakery, date)`; solver output gains `campaign_id` + `color_hex` per stop for color bands.
8. Migration cleanup: drop `routes.campaign_id` once read paths are off it.

## Open Items

None blocking. Pricing/Stripe integration is deferred but the data model and edge function shape are designed so adding it later is additive (Stripe payment intent passes through `commit`; pricing math goes in a separate function that `book-campaign-slot` calls).
