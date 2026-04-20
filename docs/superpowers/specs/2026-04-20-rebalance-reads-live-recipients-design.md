# Rebalance reads live recipients — Design

## Problem

When recipients are added to (or moved into) a campaign after a bakery's route has been saved, those new recipients never appear in that bakery's Ops view — even after the bakery clicks **Rebalance routes**. The stale saved-route snapshot wins.

Concretely: on 2026-04-20, after moving 15 Sweet Lady Jane recipients from campaign `ar18` into the main campaign `Archy × Daymaker Q2 2026`, the SLJ bakery view kept showing 273 stops (the frozen saved total) instead of the 288 the `recipients` table now holds. Clicking Rebalance produced the same 273-stop solution repeatedly. The only workaround we had was deleting the saved `routes` row via SQL.

## Root cause

`buildLegacyShape()` in `public/src/utils/archy-adapter.js` builds the in-memory `ROUTE_DATA` shape that every bakery view reads. Its contract:

1. Load all recipients for the campaign.
2. For each `delivery_areas` row (filtered to the bakery), compute `matchingRecips` by point-in-polygon.
3. **If a saved route exists for that area**, use the saved JSON blob verbatim (modulo a legacy→uuid remap). `matchingRecips` is ignored.
4. **Else**, build a fresh single-driver/single-day structure from `matchingRecips`.

`rebalanceRegion*()` (VRP and legacy) re-solves `getAllStopsForRegion(regionKey)`, which reads from `ROUTE_DATA[regionKey].days[*].routes[*].stops` — i.e., the same frozen snapshot. Rebalance never reads the `recipients` table.

Symmetric bug: saved routes also keep stops whose recipient has since been deleted, moved to another campaign, or re-assigned to a different bakery. Those phantom stops stay visible until the route is manually rebuilt.

## Design

Two companion fixes:

### A. `buildLegacyShape` reconciles saved routes with live recipients

When a saved route exists for an area, compute:

- `savedIds = set of recipient ids referenced by savedRoute.data`
- `liveIds  = set of ids in matchingRecips (after pointInPolygon + bakery filter)`

Apply two corrections before publishing into `ROUTE_DATA[key]`:

1. **Drop phantom stops** — filter `stops` within every `route` to `liveIds.has(s.id)`. Recompute `route.ns = stops.length`. This removes stops for recipients that got deleted, re-assigned, or moved to a different campaign (exactly the SLJ case, in reverse).
2. **Append unrouted stops** — any recipient in `liveIds \ savedIds` is a net-new addition. Build stop objects via `recipientToStop(r, bakery.name)` and park them on a synthetic driver entry `{ drv: -1, _unrouted: true, depot: '', stops: [...] }` on `days[0]`. `getAllStopsForRegion` already flattens all routes, so the next rebalance picks them up naturally.

Also flag the region:

- `ROUTE_DATA[key]._unroutedCount = unrouted.length` so the UI can surface it.

### B. OpsView shows an "N unrouted" banner

When `data._unroutedCount > 0`, render a dismissable-but-persistent banner above the day/driver picker: *"3 recipients added since last rebalance. Click Rebalance routes to include them."* The banner disappears once a fresh rebalance saves a new `routes` row.

This closes the loop: customer adds a recipient → bakery sees "1 unrouted" on next load → one click of Rebalance → fully integrated.

### Out of scope

- **Real-time invalidation** of saved routes when a customer uploads. The banner + "reload to see it" flow is acceptable for a day-scale workflow.
- **Multi-campaign routing.** Still picks the earliest non-deleted Archy campaign, as today. Covered by the separate `2026-04-19-multi-campaign-capacity-and-routing` plan.
- **Silent deletion of phantom delivered stops.** If a stop's recipient was deleted but `delivery_statuses_v2` still has a row (because it's keyed on `recipient_id`, not route), the status row will orphan. Not new — already possible today via direct DB delete. Separate problem.

## Why not the alternatives

- **Rebalance re-reads from DB directly.** Cleaner but duplicates the bakery/area filtering + point-in-polygon logic that already lives in `buildLegacyShape`. Cheaper to fix at shape-build time and let rebalance stay pure.
- **Invalidate saved route on any recipient write.** Requires a DB trigger or edge function, plus race conditions with in-flight rebalances. The reconciliation fix makes saved routes self-healing without coordination.
- **Drop saved routes entirely and always rebuild.** Loses the multi-day/multi-driver splits bakeries have invested in, and the drive-time data from OSRM. Unacceptable.

## Files touched

- `public/src/utils/archy-adapter.js` — reconciliation logic in `buildLegacyShape()`.
- `public/src/components/OpsView.jsx` — unrouted banner.
- `public/src/components/BakeryHomeView.jsx` — pass `_unroutedCount` through `routeOverrides` on fresh load (it's already stored on `ROUTE_DATA[key]`, but the view reads `routeOverrides[key] || ROUTE_DATA[key]`, so no prop changes needed — just make sure `onRebalance` clears the flag when a new rebalance completes).

## Risk / rollback

Pure JS, no DB migration. If reconciliation misbehaves (e.g., drops a legit stop due to a legacy-id remap edge case), the fallback is to clear `routes` for the affected bakery area — same recovery as today. Low risk.
