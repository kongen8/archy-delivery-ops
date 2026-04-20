# Rebalance reads live recipients — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saved bakery routes self-heal against the live `recipients` table so that (a) recipients added to a campaign after a route was saved become routable via Rebalance, and (b) recipients that were deleted/moved/reassigned stop showing up as phantom stops.

**Architecture:** Two surgical changes in the browser app — no DB migration, no edge function. `buildLegacyShape()` in `archy-adapter.js` reconciles the saved-route stop list against live `matchingRecips` before publishing `ROUTE_DATA[key]`: drops phantom stops, appends net-new recipients as an "unrouted" pseudo-driver on day 1, and stamps `_unroutedCount` on the region. `OpsView` renders a banner when `_unroutedCount > 0` prompting the bakery to click Rebalance. The existing rebalance path needs no changes — `getAllStopsForRegion` already flattens all routes, so the appended unrouted stops enter the solver automatically.

**Tech Stack:** Plain-script React 18 (babel-standalone), vanilla JS helpers in `public/src/utils/`. No build step. No automated test suite — verification is manual against live Supabase data.

**Spec:** `docs/superpowers/specs/2026-04-20-rebalance-reads-live-recipients-design.md`

**Project conventions to honor:**
- All Supabase interaction uses the supabase MCP — never the Supabase CLI.
- Browser code lives in `public/src/` and is loaded via `<script type="text/babel">` tags. No module system, no bundler.
- The app has no automated UI tests. Verify manually with at least two bakery profiles.

---

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `public/src/utils/archy-adapter.js` | Modify | Reconcile saved routes against live recipients in `buildLegacyShape()`. Stamp `_unroutedCount` on each `ROUTE_DATA[key]`. |
| `public/src/components/OpsView.jsx` | Modify | Render "N unrouted" banner when `_unroutedCount > 0`. |
| `public/src/components/BakeryHomeView.jsx` | Modify | When `onRebalance` receives the new saved data, make sure the banner flag is cleared in the in-memory override (the rebuilt stops cover everything). |
| `public/index.html` | Modify | Bump `__BUILD__` cache-buster so customers pick up the new JS on next load. |

---

## Task 1: Reconcile saved routes against live recipients in `buildLegacyShape`

**Files:**
- Modify: `public/src/utils/archy-adapter.js`

- [ ] **Step 1: Add a `reconcileSavedRoute` helper**

Near the top of the IIFE (above `buildLegacyShape`), add a pure helper:

```js
// Reconcile a saved route's day/driver/stop tree against the current live
// recipient set for this bakery+area. Two corrections:
//   1. Drop stops whose recipient id is no longer live (deleted, moved to
//      another campaign, reassigned to a different bakery, or the polygon
//      was edited and they no longer point-in-poly).
//   2. Return the net-new live recipients so the caller can append them as
//      an "unrouted" pseudo-driver on day 1.
// Inputs:
//   savedData     — savedRoute.data, already remapped (legacy→uuid) by the
//                   caller. Shape: { days: [{ routes: [{ stops: [{id,...}] }] }] }.
//   liveRecipIds  — Set<string> of recipient.id for this bakery+area.
// Returns:
//   { cleanedData, droppedCount, newRecipIds: Set<string> }
//
// newRecipIds is computed by the caller using savedIds (the ids that were
// referenced by any stop in savedData, before filtering) — see usage site.
function reconcileSavedRoute(savedData, liveRecipIds) {
  if (!savedData || !Array.isArray(savedData.days)) {
    return { cleanedData: savedData, droppedCount: 0, savedIds: new Set() };
  }
  const savedIds = new Set();
  let droppedCount = 0;
  const days = savedData.days.map(dd => ({
    ...dd,
    routes: (dd.routes || []).map(rt => {
      const keptStops = [];
      for (const s of rt.stops || []) {
        if (s && s.id) savedIds.add(s.id);
        if (s && s.id && liveRecipIds.has(s.id)) keptStops.push(s);
        else droppedCount++;
      }
      return { ...rt, stops: keptStops, ns: keptStops.length };
    }),
  }));
  return { cleanedData: { ...savedData, days }, droppedCount, savedIds };
}
```

- [ ] **Step 2: Wire reconciliation into the `if (savedRoute)` branch**

Find, inside `buildLegacyShape`, the area loop block:

```js
      if (savedRoute) {
        // Saved route was serialized before multi-tenant depot ids existed; overlay
        // the authoritative depot list (with ids) so DepotManager can edit them.
        ROUTE_DATA[key] = { ...remapSavedRoute(savedRoute.data), depots };
      } else {
        const stops = matchingRecips.map(r => recipientToStop(r, bakery.name));
```

Replace the `if (savedRoute)` branch with:

```js
      if (savedRoute) {
        const remapped = remapSavedRoute(savedRoute.data);
        const liveIds = new Set(matchingRecips.map(r => r.id));
        const { cleanedData, droppedCount, savedIds } = reconcileSavedRoute(remapped, liveIds);
        // Any live recipient the saved route doesn't reference is "unrouted"
        // — append them as a synthetic driver row on day 1 so rebalance picks
        // them up via getAllStopsForRegion (which flattens all stops).
        const unrouted = matchingRecips.filter(r => !savedIds.has(r.id));
        const finalData = { ...cleanedData, depots };
        if (unrouted.length > 0) {
          const newStops = unrouted.map(r => recipientToStop(r, bakery.name));
          const days = finalData.days.length > 0 ? finalData.days : [{ day: 1, nd: 0, routes: [], depots_active: [] }];
          days[0] = {
            ...days[0],
            routes: [
              ...(days[0].routes || []),
              { drv: -1, ns: newStops.length, tt: 0, td: 0, depot: '', stops: newStops, _unrouted: true },
            ],
          };
          finalData.days = days;
        }
        finalData._unroutedCount = unrouted.length;
        finalData._droppedCount = droppedCount;
        ROUTE_DATA[key] = finalData;
      } else {
        // ... existing else branch unchanged ...
```

Leave the `else` branch as-is. A fresh fallback build doesn't need reconciliation because it uses `matchingRecips` directly.

- [ ] **Step 3: Manual verification against live Supabase data**

1. Open the Sweet Lady Jane bakery profile in a hard-refreshed browser. Expected: the banner (from Task 2) shows "15 unrouted" — actually, since SLJ's saved route was already deleted on 2026-04-20, this test won't apply to SLJ specifically. Use **Boho Petite** or **Cocola Bakery** instead; they both still have saved routes.
2. Via the supabase MCP `execute_sql`, insert a test recipient for Boho Petite inside their polygon:

```sql
insert into recipients (campaign_id, bakery_id, company, address, city, state, zip, lat, lon, assignment_status)
values (
  'd9eb6b0a-475a-4ec7-8956-57247adc94a0',
  'e3d09306-bd5e-4f65-a5d7-dddc03ab40fd',
  '__reconcile_test__', '1 test st', 'San Francisco', 'CA', '94103',
  37.7749, -122.4194, 'assigned'
) returning id;
```

3. Hard-refresh the Boho Petite bakery profile. Expected in DevTools console: `ROUTE_DATA[<key>]._unroutedCount === 1`. (Task 2 makes it visible in the UI.)
4. Clean up:

```sql
delete from recipients where company = '__reconcile_test__';
```

5. Refresh again. Expected: `_unroutedCount === 0`, `_droppedCount === 0`. No UI banner.

6. Phantom-stop check: via `execute_sql`, temporarily move one real Boho Petite recipient out of the campaign:

```sql
-- Pick any live Boho Petite recipient id from the saved route.
update recipients set campaign_id = '98accc8a-140d-484f-91e6-1238730d52dd'
 where id = '<some-boho-petite-recipient-id>'
 returning id, company, campaign_id;
```

Refresh. Expected: `ROUTE_DATA[<key>]._droppedCount === 1`. That stop no longer appears in any driver's list. Restore:

```sql
update recipients set campaign_id = 'd9eb6b0a-475a-4ec7-8956-57247adc94a0'
 where id = '<same-id>';
```

- [ ] **Step 4: Commit**

```bash
git add public/src/utils/archy-adapter.js
git commit -m "fix(routing): reconcile saved routes against live recipients"
```

---

## Task 2: Render "N unrouted" banner in OpsView

**Files:**
- Modify: `public/src/components/OpsView.jsx`

- [ ] **Step 1: Read `_unroutedCount` off the current region's data**

Near the top of `OpsView` (right after `const data = routeOverrides[regionKey] || ROUTE_DATA[regionKey];`), add:

```jsx
  const unroutedCount = data?._unroutedCount || 0;
  const droppedCount = data?._droppedCount || 0;
```

- [ ] **Step 2: Render the banner above the day/driver controls**

Find the render block that shows the rebalance controls (the `<button onClick={handleRebalance}>` area). Immediately above the outer wrapper that contains the driver chips / day buttons, insert:

```jsx
  {(unroutedCount > 0 || droppedCount > 0) && (
    <div style={{
      background:'#fef3c7',border:'1px solid #f59e0b',color:'#78350f',
      padding:'8px 12px',borderRadius:6,fontSize:13,marginBottom:12,
      display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,
    }}>
      <span>
        {unroutedCount > 0 && <>⚠️ {unroutedCount} recipient{unroutedCount===1?'':'s'} not yet routed. </>}
        {droppedCount > 0 && <>🗑 {droppedCount} stop{droppedCount===1?'':'s'} removed (recipient no longer in this campaign/area). </>}
        Click <strong>Rebalance routes</strong> to refresh.
      </span>
      <button onClick={handleRebalance} disabled={loading}
        style={{background:'#78350f',color:'white',border:'none',borderRadius:4,padding:'4px 10px',fontSize:12,cursor:loading?'wait':'pointer'}}>
        {loading?'Routing…':'Rebalance now'}
      </button>
    </div>
  )}
```

(Exact placement: the banner should be visible in both normal and edit mode, so place it above the `editMode ? <EditPanel/> : <DriverPicker/>` split, not inside either branch.)

- [ ] **Step 3: Verify the banner disappears after a successful rebalance**

In `BakeryHomeView.onRebalance` (in `public/src/components/BakeryHomeView.jsx`), the callback receives `newData` from `rebalanceRegionSmart`. That return value comes from `adaptVRPSolution` / `rebalanceRegion`, neither of which sets `_unroutedCount`, so the override naturally lacks the flag — the banner clears on re-render. No change needed in `BakeryHomeView`, but confirm by:

1. Load a bakery with unrouted recipients — banner appears.
2. Click Rebalance — banner disappears after solver completes.
3. Reload the page without saving — banner reappears (because we re-read the saved route, which still doesn't contain the new recipient).
4. Click Rebalance again — solver completes, `onRebalance` → `DB2.saveRoute` persists the new stops → refresh → banner gone permanently.

- [ ] **Step 4: Commit**

```bash
git add public/src/components/OpsView.jsx
git commit -m "feat(ops): banner surfaces unrouted/phantom recipients"
```

---

## Task 3: Bump cache-buster and smoke end-to-end

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Bump `__BUILD__`**

In `public/index.html`, find the `__BUILD__` query string on the script tags (pattern established by prior plans) and increment the date/version suffix. This forces customer browsers to pick up the new `archy-adapter.js` and `OpsView.jsx` on next hard refresh.

- [ ] **Step 2: Full scenario smoke against prod-like data**

With both tasks merged:

1. Pick an Archy bakery with a saved route (Boho Petite or Cocola Bakery).
2. In the Customer Home view, log in as the Archy customer and upload 1–2 recipients inside that bakery's polygon (or use the manual-add form).
3. Switch back to the bakery profile, hard-refresh. Expected: banner reads "1 recipient not yet routed" (or "2"). Driver tabs unchanged.
4. Click **Rebalance now** on the banner. Expected: banner disappears. Driver stops count increases to include the new recipient(s). Map pins render for them. `routes` row `updated_at` bumped to now.
5. Via supabase MCP `execute_sql`, soft-delete one of the new recipients: `update recipients set campaign_id = '<any deleted draft>' where id = '<new-recipient-id>';` Hard-refresh. Expected: banner reads "1 stop removed". Rebalance. Banner disappears. Stop is gone from all drivers.
6. Clean up test recipients.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "chore: bump __BUILD__ for route-reconciliation rollout"
```

---

## Task 4: Final verification

- [ ] **Step 1: Confirm no regression on bakeries that have no saved route**

SmallCakes currently has no saved `routes` row. Open that bakery profile. Expected: everything still renders (falls through the `else` branch of `buildLegacyShape` as before), no banner, all recipients visible as a single unsplit driver list. Rebalance still works.

- [ ] **Step 2: Confirm git state is clean**

```bash
git status
```

Expected: `nothing to commit, working tree clean`. Three feature commits should be present:

```bash
git log --oneline -4
```

Expected (most-recent first): the cache-buster commit, the banner commit, the reconciliation commit, then the prior HEAD.
