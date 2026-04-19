# Multi-Campaign Capacity & Cross-Campaign Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make capacity a first-class per-bakery concept, give recipients individual delivery dates, pivot the bakery's OpsView from per-campaign to day-first so routes optimize across campaigns, and add an external box label so the bakery and driver can keep intertwined campaigns straight at loading time.

**Architecture:** Three new tables (`bakery_capacity`, `capacity_overrides`, `slot_holds`) plus column adds on `recipients`, `campaigns`, and `routes`. One new Deno edge function (`book-campaign-slot`) handles atomic capacity hold/commit/release. Browser-side: a new bakery admin Capacity panel, a new customer wizard step for picking delivery dates, a third print artifact (4×2" external box label), and a day-first OpsView shell that wraps the existing per-driver route UI with a date strip + campaign filter chips. The VRP solver wrapper swaps its input query from `(campaign_id, bakery_id)` to `(bakery_id, delivery_date)`; the solver itself is unchanged.

**Tech Stack:** Deno + `@supabase/supabase-js` for the new edge function; React 18 (babel-standalone, JSX compiled in-browser) for new UI; Node 18+ `node:test` for pure-helper unit tests; Supabase Postgres for migrations.

Spec: `docs/superpowers/specs/2026-04-19-multi-campaign-capacity-and-routing-design.md`.
Mockups: `.superpowers/mockups/multi-campaign-day-view.html`, `.superpowers/mockups/multi-campaign-box-labels.html`.

---

## File structure

### Creates

- `supabase/migrations/010_capacity_and_routing.sql` — three new tables, column adds, route re-keying with `delivery_date`, default `bakery_capacity` rows backfilled.
- `supabase/migrations/011_drop_routes_campaign_id.sql` — final cleanup; drops the now-unused `routes.campaign_id` column after the read paths are off it.
- `supabase/functions/book-campaign-slot/index.ts` — edge function dispatcher (availability / hold / commit / release).
- `supabase/functions/book-campaign-slot/capacity.ts` — pure capacity math (effective availability, hold subtraction, intersection across bakeries).
- `supabase/functions/book-campaign-slot/__tests__/capacity.test.mjs` — Node test runner for the pure capacity math, with the Deno file read as text and re-evaluated as ESM (mirrors the design.test.mjs pattern).
- `supabase/functions/book-campaign-slot/__tests__/package.json` — `npm test` → `node --test capacity.test.mjs`.
- `public/src/db/capacity.js` — browser-side CRUD for `bakery_capacity` and `capacity_overrides`.
- `public/src/db/booking.js` — browser-side wrapper around the `book-campaign-slot` edge function (availability fetch, hold creation, commit, release).
- `public/src/components/CapacityPanel.jsx` — bakery admin capacity settings UI (lead time, blackouts, sizing mode, base capacity, overrides table).
- `public/src/components/DeliveryDateStep.jsx` — customer wizard step inserted between "Review" and "Finalize"; shows the calendar and offers auto-split.
- `public/src/components/BoxLabel.jsx` — single 4×2" label render + 10-up letter sheet with print CSS.
- `public/src/components/DayView.jsx` — day-first OpsView shell: calendar landing, date strip, tab bar, campaign filter chips, body slot for the current tab.
- `public/src/components/DayRoutesTab.jsx` — merged routes list for a date; per-driver groups with stops color-banded by campaign; reuses `MapView`.
- `public/src/components/DayProductionTab.jsx` — date-scoped recipient cards grid; mirrors today's plan-5 production tab but filtered by `(bakery, date, optional campaign)`.
- `public/src/components/DayPhotosTab.jsx` — date-scoped photos grid.
- `public/src/db/day-view.js` — browser-side queries used by the day view (`listDates`, `loadDayRecipients`, `loadDayRoutes`, `markRouteDirty`).
- `public/src/utils/__tests__/capacity-availability.test.mjs` — covers the per-date intersection + reservation filter logic that's shared between the edge function and the wizard's optimistic UI.

### Modifies

- `public/index.html` — add 8 new script tags in correct order (`db/capacity.js`, `db/booking.js`, `db/day-view.js`, `CapacityPanel.jsx`, `DeliveryDateStep.jsx`, `BoxLabel.jsx`, `DayView.jsx`, `DayRoutesTab.jsx`, `DayProductionTab.jsx`, `DayPhotosTab.jsx`).
- `public/src/components/App.jsx` — when current profile is a bakery, render `<DayView/>` instead of the legacy region-keyed `OpsView` mount path. (Admin and customer paths unchanged.)
- `public/src/components/BakeryHomeView.jsx` — add a "Capacity" tab/route alongside the existing day routes.
- `public/src/components/UploadWizard.jsx` — insert the new `<DeliveryDateStep/>` between the existing review step and the finalize action.
- `public/src/components/OpsView.jsx` — remove the per-campaign "ndays/nd" picker (replaced by the date strip). The internal per-driver route rendering becomes a child of `<DayRoutesTab/>` in the new shell, but the existing per-driver/per-stop UI is preserved by extraction (move stop-card rendering into `DayRoutesTab` keeping the same shape).
- `public/src/engine/rebalance.js` — change the input query from `(campaign_id, bakery_id)` to `(bakery_id, delivery_date)`; pass `campaign_id` + `color_hex` through to each solver-output stop so the route view can render color bands.
- `public/src/utils/archy-adapter.js` — when adapting old `ROUTE_DATA` shape, populate the new `delivery_date` field from the migration's backfilled date so the day view renders existing data.
- `public/src/styles.css` — add the small set of utility classes the new components need (`.cap-row`, `.cap-cell`, `.box-label`, `.day-strip`, `.filter-chip`, etc).

### Deletes

- Nothing. The old `routes.campaign_id` column is dropped via migration 011 once read paths are off it; no source files are removed.

---

## Task ordering rationale

- **Task 1** (migration 010) lands the schema first so every subsequent task has the columns and tables to reference. Idempotent on re-run.
- **Task 2** (capacity math + tests) is the pure foundation the edge function and the wizard's optimistic UI both share. TDD-friendly: zero side effects.
- **Task 3** (edge function) wraps the math with database I/O and exposes the four actions. Integration-tested via curl + a fixture campaign.
- **Tasks 4–5** (db/capacity.js + CapacityPanel) make the bakery side configurable so a real customer flow can run end-to-end.
- **Tasks 6–7** (db/booking.js + DeliveryDateStep) close the customer-side loop: availability fetch, calendar render, hold + commit on book.
- **Task 8** (BoxLabel) is independent of the booking flow and only needs the schema; can be done in parallel by another developer.
- **Tasks 9–11** (DayView shell + tabs) pivot the bakery's read view to be date-first; this is the largest UI change but each tab is a self-contained sub-task.
- **Task 12** (VRP swap) flips the solver's input query; once this lands, cross-campaign routing is real.
- **Task 13** (migration 011 + smoke) drops the dead `routes.campaign_id` column and runs the full end-to-end smoke path.

---

## Task 1: Migration 010 — capacity tables + recipient/campaign/route columns

**Files:**
- Create: `supabase/migrations/010_capacity_and_routing.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/010_capacity_and_routing.sql`:

```sql
-- 010_capacity_and_routing.sql
-- Multi-campaign capacity + cross-campaign routing.
--
-- Adds three new tables (bakery_capacity, capacity_overrides, slot_holds) and
-- the columns on recipients/campaigns/routes that the new flow needs. Idempotent;
-- safe to re-run.
--
-- Keeps routes.campaign_id NOT NULL for now so existing rows still validate.
-- Migration 011 drops campaign_id once the read paths are off it.

-- 1. bakery_capacity (one row per bakery)
create table if not exists bakery_capacity (
  bakery_id uuid primary key references bakeries(id) on delete cascade,
  sizing_mode text not null default 'simple'
    check (sizing_mode in ('simple','sized')),
  base_small int,
  base_medium int not null default 80,
  base_large int,
  lead_days int not null default 3,
  blackout_dows int[] not null default '{0}'::int[],
  updated_at timestamptz not null default now()
);

-- 2. capacity_overrides (dated bumps with optional reservation)
create table if not exists capacity_overrides (
  id uuid primary key default gen_random_uuid(),
  bakery_id uuid not null references bakeries(id) on delete cascade,
  date date not null,
  delta_small int not null default 0,
  delta_medium int not null default 0,
  delta_large int not null default 0,
  reason text,
  reserved_for_customer_id uuid references customers(id) on delete set null,
  reserved_until date,
  created_at timestamptz not null default now(),
  unique (bakery_id, date)
);
create index if not exists capacity_overrides_bakery_date_idx
  on capacity_overrides(bakery_id, date);

-- 3. slot_holds (transient, ~15 min TTL)
create table if not exists slot_holds (
  id uuid primary key default gen_random_uuid(),
  bakery_id uuid not null references bakeries(id) on delete cascade,
  date date not null,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  count_small int not null default 0,
  count_medium int not null default 0,
  count_large int not null default 0,
  expires_at timestamptz not null
);
create index if not exists slot_holds_bakery_date_idx
  on slot_holds(bakery_id, date);
create index if not exists slot_holds_expires_idx
  on slot_holds(expires_at);

-- 4. recipients new columns
alter table recipients
  add column if not exists delivery_date date,
  add column if not exists size text
    check (size is null or size in ('small','medium','large'));
create index if not exists recipients_bakery_date_idx
  on recipients(bakery_id, delivery_date) where delivery_date is not null;

-- 5. campaigns new columns
alter table campaigns
  add column if not exists color_hex text,
  add column if not exists label_print_mode text not null default 'auto'
    check (label_print_mode in ('auto','always','never'));

-- 6. routes new columns + new unique
alter table routes
  add column if not exists delivery_date date;

-- Backfill delivery_date for existing routes from the recipients they cover.
-- Routes whose campaign_id maps to recipients with a single distinct
-- delivery_date inherit it; otherwise leave null and the bakery will re-solve.
update routes r
   set delivery_date = sub.delivery_date
  from (
    select rt.id, max(rec.delivery_date) as delivery_date
      from routes rt
      join recipients rec on rec.bakery_id = rt.bakery_id
                          and rec.campaign_id = rt.campaign_id
     where rec.delivery_date is not null
     group by rt.id
    having count(distinct rec.delivery_date) = 1
  ) sub
 where sub.id = r.id and r.delivery_date is null;

-- New unique on (bakery, date, area). Drop the old (campaign, bakery, area)
-- unique once delivery_date is populated for everything.
drop index if exists routes_unique_idx;
create unique index if not exists routes_unique_by_date_idx
  on routes(bakery_id, delivery_date, delivery_area_id)
  where delivery_date is not null;

-- 7. Backfill bakery_capacity defaults for every existing bakery.
insert into bakery_capacity (bakery_id)
select id from bakeries
on conflict (bakery_id) do nothing;

-- Realtime: the day view subscribes to slot_holds + capacity_overrides for
-- live availability updates while a bakery edits.
alter publication supabase_realtime add table slot_holds;
alter publication supabase_realtime add table capacity_overrides;
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use the Supabase MCP `apply_migration` tool with name `010_capacity_and_routing` and the SQL above.

Expected: `success: true`. Re-running yields the same result (no errors) because every statement is idempotent.

- [ ] **Step 3: Verify the schema landed**

Via Supabase MCP `execute_sql`:

```sql
select table_name, column_name, data_type
  from information_schema.columns
 where table_name in ('bakery_capacity','capacity_overrides','slot_holds')
    or (table_name = 'recipients' and column_name in ('delivery_date','size'))
    or (table_name = 'campaigns'  and column_name in ('color_hex','label_print_mode'))
    or (table_name = 'routes'     and column_name = 'delivery_date')
 order by table_name, ordinal_position;
```

Expected: 17+ rows covering every new column. `bakery_capacity` has one row per existing bakery (verify with `select count(*) from bakery_capacity` matching `select count(*) from bakeries`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/010_capacity_and_routing.sql
git commit -m "Migration 010: capacity tables + delivery_date columns + backfill"
```

---

## Task 2: Capacity math (pure module + tests)

**Files:**
- Create: `supabase/functions/book-campaign-slot/capacity.ts`
- Create: `supabase/functions/book-campaign-slot/__tests__/capacity.test.mjs`
- Create: `supabase/functions/book-campaign-slot/__tests__/package.json`

The pure math gets duplicated as a `.test.mjs`-friendly read because Deno's `import` paths don't run under `node --test` directly. The capacity.ts file uses only TypeScript built-ins (no Deno-specific APIs), so the test loads it as text and re-evaluates it.

- [ ] **Step 1: Write `capacity.ts` (pure functions only — no DB, no Deno globals)**

```typescript
// capacity.ts — pure capacity math. No I/O, no Deno-specific APIs.
// Imported by index.ts (Deno) and re-evaluated by capacity.test.mjs (Node).

export type Size = 'small' | 'medium' | 'large';

export interface BakeryCapacity {
  bakery_id: string;
  sizing_mode: 'simple' | 'sized';
  base_small: number | null;
  base_medium: number;
  base_large: number | null;
  lead_days: number;
  blackout_dows: number[];
}

export interface Override {
  bakery_id: string;
  date: string; // YYYY-MM-DD
  delta_small: number;
  delta_medium: number;
  delta_large: number;
  reserved_for_customer_id: string | null;
  reserved_until: string | null; // YYYY-MM-DD
}

export interface Hold {
  bakery_id: string;
  date: string;
  count_small: number;
  count_medium: number;
  count_large: number;
}

export interface AssignedCount {
  bakery_id: string;
  date: string;
  count_small: number;
  count_medium: number;
  count_large: number;
}

export interface Need {
  bakery_id: string;
  count_small: number;
  count_medium: number;
  count_large: number;
}

/**
 * Effective base capacity per size, applying simple-mode collapse.
 * In simple mode every size queried returns base_medium (the single number).
 */
export function baseFor(cap: BakeryCapacity, size: Size): number {
  if (cap.sizing_mode === 'simple') return cap.base_medium;
  if (size === 'small')  return cap.base_small  ?? 0;
  if (size === 'medium') return cap.base_medium;
  if (size === 'large')  return cap.base_large  ?? 0;
  return 0;
}

/**
 * Sum of override deltas applicable to (bakery, date), respecting reservation:
 * if `for_customer_id` is set, count overrides where the reservation matches it
 * OR where the reservation is null OR expired by today; if `for_customer_id` is
 * null (e.g. internal availability check), count only non-reserved or expired
 * overrides.
 */
export function overrideDelta(
  overrides: Override[],
  bakery_id: string,
  date: string,
  size: Size,
  for_customer_id: string | null,
  today: string,
): number {
  let sum = 0;
  for (const o of overrides) {
    if (o.bakery_id !== bakery_id || o.date !== date) continue;
    const reservedActive = o.reserved_for_customer_id !== null
      && (o.reserved_until === null || o.reserved_until >= today);
    if (reservedActive) {
      if (for_customer_id !== o.reserved_for_customer_id) continue;
    }
    if (size === 'small')  sum += o.delta_small;
    if (size === 'medium') sum += o.delta_medium;
    if (size === 'large')  sum += o.delta_large;
  }
  return sum;
}

export function consumed(
  rows: { bakery_id: string; date: string; count_small: number; count_medium: number; count_large: number }[],
  bakery_id: string,
  date: string,
  size: Size,
): number {
  let sum = 0;
  for (const r of rows) {
    if (r.bakery_id !== bakery_id || r.date !== date) continue;
    if (size === 'small')  sum += r.count_small;
    if (size === 'medium') sum += r.count_medium;
    if (size === 'large')  sum += r.count_large;
  }
  return sum;
}

/**
 * Available capacity for one (bakery, date, size).
 * Returns 0 if past today + lead_days OR weekday is blackout OR result is < 0.
 */
export function availableFor(args: {
  cap: BakeryCapacity;
  overrides: Override[];
  holds: Hold[];
  assigned: AssignedCount[];
  bakery_id: string;
  date: string; // YYYY-MM-DD
  size: Size;
  for_customer_id: string | null;
  today: string; // YYYY-MM-DD
}): number {
  const { cap, overrides, holds, assigned, bakery_id, date, size, for_customer_id, today } = args;

  if (date < addDays(today, cap.lead_days)) return 0;
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (cap.blackout_dows.includes(dow)) return 0;

  const base = baseFor(cap, size);
  const od = overrideDelta(overrides, bakery_id, date, size, for_customer_id, today);
  const usedAssigned = consumed(assigned, bakery_id, date, size);
  const usedHolds = consumed(holds, bakery_id, date, size);
  return Math.max(0, base + od - usedAssigned - usedHolds);
}

/**
 * Per-bakery verdict for a (date, need): green = fits this date,
 * red = doesn't fit and no nearby split, yellow = doesn't fit alone but
 * the missing bakery has room within `split_window_days`.
 */
export type Verdict = 'green' | 'yellow' | 'red';

export function dateVerdict(args: {
  date: string;
  needs: Need[];
  caps: BakeryCapacity[];
  overrides: Override[];
  holds: Hold[];
  assigned: AssignedCount[];
  for_customer_id: string | null;
  today: string;
  splitWindowDays: number; // 7
}): { verdict: Verdict; shortBakeries: { bakery_id: string; nextOpen: string | null }[] } {
  const { date, needs, caps, overrides, holds, assigned, for_customer_id, today, splitWindowDays } = args;
  const shortBakeries: { bakery_id: string; nextOpen: string | null }[] = [];

  for (const n of needs) {
    const cap = caps.find(c => c.bakery_id === n.bakery_id);
    if (!cap) { shortBakeries.push({ bakery_id: n.bakery_id, nextOpen: null }); continue; }
    const fitsAll = (['small','medium','large'] as Size[]).every(s => {
      const need = (s === 'small' ? n.count_small : s === 'medium' ? n.count_medium : n.count_large);
      if (need <= 0) return true;
      const avail = availableFor({ cap, overrides, holds, assigned, bakery_id: n.bakery_id, date, size: s, for_customer_id, today });
      return avail >= need;
    });
    if (!fitsAll) {
      let nextOpen: string | null = null;
      for (let i = 1; i <= splitWindowDays; i++) {
        const d = addDays(date, i);
        const ok = (['small','medium','large'] as Size[]).every(s => {
          const need = (s === 'small' ? n.count_small : s === 'medium' ? n.count_medium : n.count_large);
          if (need <= 0) return true;
          return availableFor({ cap, overrides, holds, assigned, bakery_id: n.bakery_id, date: d, size: s, for_customer_id, today }) >= need;
        });
        if (ok) { nextOpen = d; break; }
      }
      shortBakeries.push({ bakery_id: n.bakery_id, nextOpen });
    }
  }

  if (shortBakeries.length === 0) return { verdict: 'green', shortBakeries: [] };
  const allHaveSplit = shortBakeries.every(s => s.nextOpen !== null);
  return { verdict: allHaveSplit ? 'yellow' : 'red', shortBakeries };
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Write `__tests__/package.json`**

```json
{
  "name": "book-campaign-slot-tests",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test capacity.test.mjs" }
}
```

- [ ] **Step 3: Write the failing test file `__tests__/capacity.test.mjs`**

The test reads `../capacity.ts` as text, strips the `export` keywords (Node ESM doesn't accept them in the wrapped form), and instantiates with `new Function`.

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '../capacity.ts'), 'utf8');

// Strip TypeScript types: a tiny shim that's enough for our pure functions.
// Removes `: Type`, `<T>` generics in function signatures, and `export type/interface` blocks.
const stripped = src
  .replace(/export\s+type[^;]+;/g, '')
  .replace(/export\s+interface\s+\w+\s*\{[\s\S]*?\n\}/g, '')
  .replace(/:\s*[A-Z][\w<>\[\]\| ]*(?=[,)\]=}])/g, '')
  .replace(/:\s*\{[^}]*\}(?=\s*[)=])/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/as\s+\w+(?:\[\])?/g, '');

const ctx = {};
new Function('ctx', stripped + '\nctx.baseFor = baseFor;\nctx.overrideDelta = overrideDelta;\nctx.availableFor = availableFor;\nctx.dateVerdict = dateVerdict;\nctx.addDays = addDays;')(ctx);
const { baseFor, overrideDelta, availableFor, dateVerdict, addDays } = ctx;

const today = '2026-04-19';
const cap = (overrides = {}) => ({
  bakery_id: 'b1', sizing_mode: 'simple',
  base_small: null, base_medium: 80, base_large: null,
  lead_days: 3, blackout_dows: [0],
  ...overrides,
});

test('baseFor: simple mode returns base_medium for any size', () => {
  const c = cap();
  assert.equal(baseFor(c, 'small'), 80);
  assert.equal(baseFor(c, 'medium'), 80);
  assert.equal(baseFor(c, 'large'), 80);
});

test('baseFor: sized mode returns per-size base, treating null as 0', () => {
  const c = cap({ sizing_mode: 'sized', base_small: 120, base_medium: 80, base_large: 20 });
  assert.equal(baseFor(c, 'small'), 120);
  assert.equal(baseFor(c, 'large'), 20);
  const c2 = cap({ sizing_mode: 'sized', base_small: null, base_medium: 80, base_large: null });
  assert.equal(baseFor(c2, 'small'), 0);
  assert.equal(baseFor(c2, 'large'), 0);
});

test('overrideDelta: sums non-reserved bumps for the right (bakery,date)', () => {
  const o = [
    { bakery_id: 'b1', date: '2026-05-01', delta_small: 0, delta_medium: 30, delta_large: 0, reserved_for_customer_id: null, reserved_until: null },
    { bakery_id: 'b1', date: '2026-05-01', delta_small: 0, delta_medium: 20, delta_large: 0, reserved_for_customer_id: null, reserved_until: null },
    { bakery_id: 'b2', date: '2026-05-01', delta_small: 0, delta_medium: 99, delta_large: 0, reserved_for_customer_id: null, reserved_until: null },
    { bakery_id: 'b1', date: '2026-05-02', delta_small: 0, delta_medium: 99, delta_large: 0, reserved_for_customer_id: null, reserved_until: null },
  ];
  assert.equal(overrideDelta(o, 'b1', '2026-05-01', 'medium', null, today), 50);
});

test('overrideDelta: reserved override is invisible to other customers', () => {
  const o = [{ bakery_id: 'b1', date: '2026-05-01', delta_small: 0, delta_medium: 100, delta_large: 0, reserved_for_customer_id: 'archy', reserved_until: '2026-05-01' }];
  assert.equal(overrideDelta(o, 'b1', '2026-05-01', 'medium', 'someone-else', today), 0);
  assert.equal(overrideDelta(o, 'b1', '2026-05-01', 'medium', 'archy', today), 100);
});

test('overrideDelta: expired reservation becomes free for everyone', () => {
  const o = [{ bakery_id: 'b1', date: '2026-05-01', delta_small: 0, delta_medium: 100, delta_large: 0, reserved_for_customer_id: 'archy', reserved_until: '2026-04-18' }];
  assert.equal(overrideDelta(o, 'b1', '2026-05-01', 'medium', 'someone-else', today), 100);
});

test('availableFor: returns 0 when date is before today + lead_days', () => {
  const c = cap({ lead_days: 3 });
  assert.equal(availableFor({ cap: c, overrides: [], holds: [], assigned: [], bakery_id: 'b1', date: '2026-04-21', size: 'medium', for_customer_id: null, today }), 0);
  assert.equal(availableFor({ cap: c, overrides: [], holds: [], assigned: [], bakery_id: 'b1', date: '2026-04-22', size: 'medium', for_customer_id: null, today }), 80);
});

test('availableFor: returns 0 on a blackout DOW', () => {
  // 2026-04-26 is a Sunday (DOW 0)
  const c = cap({ blackout_dows: [0] });
  assert.equal(availableFor({ cap: c, overrides: [], holds: [], assigned: [], bakery_id: 'b1', date: '2026-04-26', size: 'medium', for_customer_id: null, today }), 0);
});

test('availableFor: subtracts assigned + holds, never goes below 0', () => {
  const c = cap();
  const out = availableFor({
    cap: c, overrides: [],
    holds: [{ bakery_id: 'b1', date: '2026-05-01', count_small: 0, count_medium: 30, count_large: 0 }],
    assigned: [{ bakery_id: 'b1', date: '2026-05-01', count_small: 0, count_medium: 60, count_large: 0 }],
    bakery_id: 'b1', date: '2026-05-01', size: 'medium', for_customer_id: null, today,
  });
  assert.equal(out, 0); // 80 - 30 - 60 = -10 → clamped to 0
});

test('dateVerdict: green when every bakery fits', () => {
  const caps = [cap({ bakery_id: 'b1' }), cap({ bakery_id: 'b2' })];
  const v = dateVerdict({
    date: '2026-05-01',
    needs: [
      { bakery_id: 'b1', count_small: 0, count_medium: 40, count_large: 0 },
      { bakery_id: 'b2', count_small: 0, count_medium: 60, count_large: 0 },
    ],
    caps, overrides: [], holds: [], assigned: [],
    for_customer_id: null, today, splitWindowDays: 7,
  });
  assert.equal(v.verdict, 'green');
});

test('dateVerdict: yellow when one bakery is short but a nearby date works', () => {
  const caps = [cap({ bakery_id: 'b1', base_medium: 30 })];
  const v = dateVerdict({
    date: '2026-05-01',
    needs: [{ bakery_id: 'b1', count_small: 0, count_medium: 60, count_large: 0 }],
    caps,
    overrides: [{ bakery_id: 'b1', date: '2026-05-04', delta_small: 0, delta_medium: 100, delta_large: 0, reserved_for_customer_id: null, reserved_until: null }],
    holds: [], assigned: [],
    for_customer_id: null, today, splitWindowDays: 7,
  });
  assert.equal(v.verdict, 'yellow');
  assert.equal(v.shortBakeries[0].nextOpen, '2026-05-04');
});

test('dateVerdict: red when nothing fits within the split window', () => {
  const caps = [cap({ bakery_id: 'b1', base_medium: 30 })];
  const v = dateVerdict({
    date: '2026-05-01',
    needs: [{ bakery_id: 'b1', count_small: 0, count_medium: 1000, count_large: 0 }],
    caps, overrides: [], holds: [], assigned: [],
    for_customer_id: null, today, splitWindowDays: 7,
  });
  assert.equal(v.verdict, 'red');
});

test('addDays: handles month rollover', () => {
  assert.equal(addDays('2026-04-30', 1), '2026-05-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
```

- [ ] **Step 4: Run the tests, verify they fail (capacity.ts doesn't exist yet — but step 1 just wrote it). Actually run them now and verify they pass.**

```bash
cd supabase/functions/book-campaign-slot/__tests__
npm install
npm test
```

Expected: 11 tests pass. If the type-stripping regex fails to handle a particular spot in capacity.ts, expand it.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/book-campaign-slot/capacity.ts \
        supabase/functions/book-campaign-slot/__tests__/capacity.test.mjs \
        supabase/functions/book-campaign-slot/__tests__/package.json
git commit -m "capacity.ts: pure availability/intersection math + node:test suite"
```

---

## Task 3: Edge function — `book-campaign-slot` with all four actions

**Files:**
- Create: `supabase/functions/book-campaign-slot/index.ts`

The function dispatches on URL path: `/book-campaign-slot/availability`, `/hold`, `/commit`, `/release`. Each action loads what it needs from Postgres, runs the pure capacity math, and returns JSON. Service role; bypasses RLS.

- [ ] **Step 1: Write `index.ts`**

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  BakeryCapacity, Override, Hold, AssignedCount, Need, Size,
  availableFor, dateVerdict, addDays,
} from './capacity.ts';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

const HOLD_TTL_MIN = 15;

// Today helper — uses the bakery's UTC date for consistency across viewers.
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadCampaignNeeds(sb: SupabaseClient, campaign_id: string): Promise<{
  needs: Need[];
  customer_id: string | null;
  campaign_id: string;
}> {
  const { data: campaign, error: cErr } = await sb.from('campaigns')
    .select('id, customer_id').eq('id', campaign_id).maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!campaign) throw new Error('campaign_not_found');

  const { data: rows, error: rErr } = await sb.from('recipients')
    .select('bakery_id, size')
    .eq('campaign_id', campaign_id)
    .eq('assignment_status', 'assigned')
    .is('delivery_date', null); // unscheduled portion only
  if (rErr) throw new Error(rErr.message);

  const acc = new Map<string, Need>();
  for (const r of rows || []) {
    if (!r.bakery_id) continue;
    const n = acc.get(r.bakery_id) ?? { bakery_id: r.bakery_id, count_small: 0, count_medium: 0, count_large: 0 };
    const s = (r.size as Size | null) ?? 'medium';
    if (s === 'small')  n.count_small++;
    if (s === 'medium') n.count_medium++;
    if (s === 'large')  n.count_large++;
    acc.set(r.bakery_id, n);
  }
  return { needs: [...acc.values()], customer_id: campaign.customer_id, campaign_id };
}

async function loadCapacityContext(sb: SupabaseClient, bakery_ids: string[], from: string, to: string): Promise<{
  caps: BakeryCapacity[]; overrides: Override[]; holds: Hold[]; assigned: AssignedCount[];
}> {
  if (bakery_ids.length === 0) return { caps: [], overrides: [], holds: [], assigned: [] };

  const [capsRes, oRes, hRes, aRes] = await Promise.all([
    sb.from('bakery_capacity').select('*').in('bakery_id', bakery_ids),
    sb.from('capacity_overrides').select('*').in('bakery_id', bakery_ids).gte('date', from).lte('date', to),
    sb.from('slot_holds').select('bakery_id,date,count_small,count_medium,count_large')
      .in('bakery_id', bakery_ids).gte('date', from).lte('date', to)
      .gt('expires_at', new Date().toISOString()),
    sb.rpc('assigned_counts_for_dates', { _bakery_ids: bakery_ids, _from: from, _to: to }),
  ]);
  if (capsRes.error) throw new Error(capsRes.error.message);
  if (oRes.error) throw new Error(oRes.error.message);
  if (hRes.error) throw new Error(hRes.error.message);
  if (aRes.error) {
    // Fallback: client-side aggregation if the RPC isn't there yet.
    const { data: rec, error: recErr } = await sb.from('recipients')
      .select('bakery_id, delivery_date, size')
      .in('bakery_id', bakery_ids)
      .gte('delivery_date', from).lte('delivery_date', to)
      .eq('assignment_status', 'assigned')
      .not('delivery_date', 'is', null);
    if (recErr) throw new Error(recErr.message);
    const accMap = new Map<string, AssignedCount>();
    for (const r of rec || []) {
      const k = r.bakery_id + '|' + r.delivery_date;
      const a = accMap.get(k) ?? { bakery_id: r.bakery_id, date: r.delivery_date, count_small: 0, count_medium: 0, count_large: 0 };
      const s = (r.size as Size | null) ?? 'medium';
      if (s === 'small')  a.count_small++;
      if (s === 'medium') a.count_medium++;
      if (s === 'large')  a.count_large++;
      accMap.set(k, a);
    }
    return { caps: capsRes.data || [], overrides: oRes.data || [], holds: hRes.data || [], assigned: [...accMap.values()] };
  }
  return { caps: capsRes.data || [], overrides: oRes.data || [], holds: hRes.data || [], assigned: aRes.data || [] };
}

async function handleAvailability(sb: SupabaseClient, body: { campaign_id: string; days?: number }): Promise<Response> {
  const days = Math.max(1, Math.min(60, body.days ?? 30));
  const today = todayUTC();
  const to = addDays(today, days);

  const { needs, customer_id } = await loadCampaignNeeds(sb, body.campaign_id);
  const ids = needs.map(n => n.bakery_id);
  const ctx = await loadCapacityContext(sb, ids, today, to);

  const calendar: { date: string; verdict: string; shortBakeries: { bakery_id: string; nextOpen: string | null }[] }[] = [];
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    const v = dateVerdict({
      date, needs, caps: ctx.caps, overrides: ctx.overrides, holds: ctx.holds, assigned: ctx.assigned,
      for_customer_id: customer_id, today, splitWindowDays: 7,
    });
    calendar.push({ date, verdict: v.verdict, shortBakeries: v.shortBakeries });
  }
  return jsonResponse({ needs, calendar });
}

async function handleHold(sb: SupabaseClient, body: { campaign_id: string; picks: { bakery_id: string; date: string; count_small: number; count_medium: number; count_large: number }[] }): Promise<Response> {
  if (!body.campaign_id || !Array.isArray(body.picks) || body.picks.length === 0) {
    return jsonResponse({ error: 'invalid_request' }, 400);
  }

  const ids = [...new Set(body.picks.map(p => p.bakery_id))];
  const dates = body.picks.map(p => p.date).sort();
  const ctx = await loadCapacityContext(sb, ids, dates[0], dates[dates.length - 1]);
  const { customer_id } = await loadCampaignNeeds(sb, body.campaign_id);
  const today = todayUTC();

  for (const p of body.picks) {
    const cap = ctx.caps.find(c => c.bakery_id === p.bakery_id);
    if (!cap) return jsonResponse({ error: 'bakery_capacity_missing', bakery_id: p.bakery_id }, 400);
    for (const s of ['small', 'medium', 'large'] as Size[]) {
      const want = (s === 'small' ? p.count_small : s === 'medium' ? p.count_medium : p.count_large);
      if (want <= 0) continue;
      const have = availableFor({
        cap, overrides: ctx.overrides, holds: ctx.holds, assigned: ctx.assigned,
        bakery_id: p.bakery_id, date: p.date, size: s, for_customer_id: customer_id, today,
      });
      if (have < want) return jsonResponse({ error: 'insufficient_capacity', bakery_id: p.bakery_id, date: p.date, size: s, have, want }, 409);
    }
  }

  const expires = new Date(Date.now() + HOLD_TTL_MIN * 60_000).toISOString();
  const rows = body.picks.map(p => ({
    bakery_id: p.bakery_id, date: p.date, campaign_id: body.campaign_id,
    count_small: p.count_small, count_medium: p.count_medium, count_large: p.count_large,
    expires_at: expires,
  }));
  const { data, error } = await sb.from('slot_holds').insert(rows).select('id');
  if (error) return jsonResponse({ error: 'database_error', detail: error.message }, 500);

  return jsonResponse({ hold_ids: data.map(r => r.id), expires_at: expires });
}

async function handleCommit(sb: SupabaseClient, body: { campaign_id: string; hold_ids: string[] }): Promise<Response> {
  if (!body.campaign_id || !Array.isArray(body.hold_ids) || body.hold_ids.length === 0) {
    return jsonResponse({ error: 'invalid_request' }, 400);
  }

  const { data: holds, error: hErr } = await sb.from('slot_holds')
    .select('*').in('id', body.hold_ids);
  if (hErr) return jsonResponse({ error: 'database_error', detail: hErr.message }, 500);
  if (!holds || holds.length !== body.hold_ids.length) return jsonResponse({ error: 'hold_missing' }, 410);

  const now = new Date();
  for (const h of holds) {
    if (new Date(h.expires_at) <= now) return jsonResponse({ error: 'hold_expired', hold_id: h.id }, 410);
  }

  // Map of (bakery_id|size) → ordered list of dates with remaining slots,
  // taken from the holds. We then assign delivery_date to recipients in
  // (bakery, size) order, popping from each bucket.
  type Pick = { bakery_id: string; date: string; remaining: { small: number; medium: number; large: number } };
  const picks: Pick[] = holds.map(h => ({
    bakery_id: h.bakery_id, date: h.date,
    remaining: { small: h.count_small, medium: h.count_medium, large: h.count_large },
  }));

  const { data: recipients, error: rErr } = await sb.from('recipients')
    .select('id, bakery_id, size')
    .eq('campaign_id', body.campaign_id)
    .eq('assignment_status', 'assigned')
    .is('delivery_date', null)
    .order('id');
  if (rErr) return jsonResponse({ error: 'database_error', detail: rErr.message }, 500);

  const updates: { id: string; delivery_date: string }[] = [];
  for (const r of recipients || []) {
    const s: Size = (r.size as Size | null) ?? 'medium';
    const pick = picks.find(p => p.bakery_id === r.bakery_id && p.remaining[s] > 0);
    if (!pick) {
      // Defensive: a recipient we expected to schedule has no pick. Roll back.
      return jsonResponse({ error: 'pick_recipient_mismatch', recipient_id: r.id, bakery_id: r.bakery_id, size: s }, 500);
    }
    pick.remaining[s]--;
    updates.push({ id: r.id, delivery_date: pick.date });
  }

  // Apply in batches of 100.
  for (let i = 0; i < updates.length; i += 100) {
    const slice = updates.slice(i, i + 100);
    for (const u of slice) {
      const { error: uErr } = await sb.from('recipients').update({ delivery_date: u.delivery_date }).eq('id', u.id);
      if (uErr) return jsonResponse({ error: 'database_error', detail: uErr.message }, 500);
    }
  }

  await sb.from('slot_holds').delete().in('id', body.hold_ids);

  await sb.from('campaigns').update({ status: 'active' }).eq('id', body.campaign_id);

  // Mark affected (bakery, date) routes as needing re-solve. We model this as
  // upserting a routes row with data = {dirty: true}; the bakery's day view
  // triggers the actual VRP solve when first opened.
  const affected = new Map<string, { bakery_id: string; date: string }>();
  for (const u of updates) {
    const r = recipients!.find(rr => rr.id === u.id)!;
    affected.set(r.bakery_id + '|' + u.delivery_date, { bakery_id: r.bakery_id, date: u.delivery_date });
  }
  for (const a of affected.values()) {
    const { data: areas } = await sb.from('delivery_areas').select('id').eq('bakery_id', a.bakery_id);
    for (const area of areas || []) {
      await sb.from('routes').upsert({
        bakery_id: a.bakery_id,
        delivery_date: a.date,
        delivery_area_id: area.id,
        // routes.campaign_id is still NOT NULL in this migration. Use a
        // sentinel of the booked campaign so the row validates; migration 011
        // drops this column entirely.
        campaign_id: body.campaign_id,
        data: { dirty: true },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'bakery_id,delivery_date,delivery_area_id' });
    }
  }

  return jsonResponse({ committed: updates.length, affected_routes: [...affected.values()] });
}

async function handleRelease(sb: SupabaseClient, body: { hold_ids: string[] }): Promise<Response> {
  if (!Array.isArray(body.hold_ids) || body.hold_ids.length === 0) return jsonResponse({ released: 0 });
  await sb.from('slot_holds').delete().in('id', body.hold_ids);
  return jsonResponse({ released: body.hold_ids.length });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const url = new URL(req.url);
  if (url.pathname.endsWith('/availability')) return await handleAvailability(sb, body);
  if (url.pathname.endsWith('/hold'))         return await handleHold(sb, body);
  if (url.pathname.endsWith('/commit'))       return await handleCommit(sb, body);
  if (url.pathname.endsWith('/release'))      return await handleRelease(sb, body);
  return jsonResponse({ error: 'unknown_action' }, 404);
});
```

- [ ] **Step 2: Deploy via Supabase MCP**

Use the Supabase MCP `deploy_edge_function` tool, name `book-campaign-slot`, with both files (`index.ts` and `capacity.ts`).

Expected: deploy succeeds.

- [ ] **Step 3: Smoke against a real campaign**

Pick a campaign id with at least 1 unscheduled recipient (e.g. find one with `select id from campaigns limit 1`). Then via the Supabase MCP `execute_sql`:

```sql
select id, name from campaigns limit 5;
```

Curl-equivalent against the deployed function (use the project ref from the MCP):

```bash
CAMPAIGN_ID=<id>
PROJECT_URL=<https://<ref>.supabase.co>
ANON_KEY=$(grep VITE_SUPABASE_ANON_KEY apps/web/.env | cut -d= -f2)

curl -X POST "$PROJECT_URL/functions/v1/book-campaign-slot/availability" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"campaign_id\":\"$CAMPAIGN_ID\",\"days\":14}" | jq .
```

Expected: response with `needs` array and 15-element `calendar` array; the first 3 days have `verdict: red` (lead time), Sundays have `verdict: red` (blackout), the rest are `green` or `yellow` depending on the bakery's existing load.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/book-campaign-slot/index.ts
git commit -m "book-campaign-slot: edge function with availability/hold/commit/release"
```

---

## Task 4: Browser-side capacity CRUD (`db/capacity.js`)

**Files:**
- Create: `public/src/db/capacity.js`
- Modify: `public/index.html` (add `<script src="./src/db/capacity.js">` after `db/admin.js`)

- [ ] **Step 1: Write `db/capacity.js`**

```javascript
// ===== CAPACITY DATA ACCESS =====
// Reads/writes bakery_capacity + capacity_overrides via the shared `sb` client.
// The bakery admin Capacity panel calls these directly; the DeliveryDateStep
// (customer wizard) reads bakery_capacity to compute optimistic UI before the
// edge function returns.
const Capacity = {
  async get(bakery_id) {
    if (!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('bakery_capacity').select('*').eq('bakery_id', bakery_id).maybeSingle();
    if (error) throw error;
    return data;
  },

  async update(bakery_id, patch) {
    if (!sb) throw new Error('sb not ready');
    const row = { bakery_id, ...patch, updated_at: new Date().toISOString() };
    const { data, error } = await sb.from('bakery_capacity').upsert(row, { onConflict: 'bakery_id' }).select('*').single();
    if (error) throw error;
    return data;
  },

  async listOverrides(bakery_id, fromDate, toDate) {
    if (!sb) throw new Error('sb not ready');
    let q = sb.from('capacity_overrides').select('*').eq('bakery_id', bakery_id).order('date');
    if (fromDate) q = q.gte('date', fromDate);
    if (toDate)   q = q.lte('date', toDate);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async upsertOverride({ bakery_id, date, delta_small, delta_medium, delta_large, reason, reserved_for_customer_id, reserved_until }) {
    if (!sb) throw new Error('sb not ready');
    const row = {
      bakery_id, date,
      delta_small: delta_small || 0,
      delta_medium: delta_medium || 0,
      delta_large: delta_large || 0,
      reason: reason || null,
      reserved_for_customer_id: reserved_for_customer_id || null,
      reserved_until: reserved_until || null,
    };
    const { data, error } = await sb.from('capacity_overrides').upsert(row, { onConflict: 'bakery_id,date' }).select('*').single();
    if (error) throw error;
    return data;
  },

  async deleteOverride(id) {
    if (!sb) throw new Error('sb not ready');
    const { error } = await sb.from('capacity_overrides').delete().eq('id', id);
    if (error) throw error;
  },

  async addOverrideRange({ bakery_id, from_date, to_date, delta_small, delta_medium, delta_large, reason, reserved_for_customer_id, reserved_until }) {
    if (!sb) throw new Error('sb not ready');
    const start = new Date(from_date + 'T00:00:00Z');
    const end = new Date(to_date + 'T00:00:00Z');
    const rows = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      rows.push({
        bakery_id,
        date: d.toISOString().slice(0, 10),
        delta_small: delta_small || 0,
        delta_medium: delta_medium || 0,
        delta_large: delta_large || 0,
        reason: reason || null,
        reserved_for_customer_id: reserved_for_customer_id || null,
        reserved_until: reserved_until || null,
      });
    }
    const { error } = await sb.from('capacity_overrides').upsert(rows, { onConflict: 'bakery_id,date' });
    if (error) throw error;
    return rows.length;
  },
};
```

- [ ] **Step 2: Wire into `public/index.html`**

Find the line `<script src="./src/db/admin.js"></script>` in `public/index.html` and add immediately after:

```html
<script src="./src/db/capacity.js"></script>
```

- [ ] **Step 3: Smoke in DevTools**

Open the app in the admin profile, then in the browser console:

```javascript
const bakeryId = (await Admin.listBakeries())[0].id;
console.log(await Capacity.get(bakeryId));
await Capacity.update(bakeryId, { lead_days: 4, base_medium: 100 });
console.log(await Capacity.get(bakeryId));
await Capacity.upsertOverride({ bakery_id: bakeryId, date: '2026-12-22', delta_medium: 50, reason: 'Holiday surge' });
console.log(await Capacity.listOverrides(bakeryId));
```

Expected: get returns the backfilled row; update changes lead_days to 4; override appears in the list.

- [ ] **Step 4: Commit**

```bash
git add public/src/db/capacity.js public/index.html
git commit -m "db/capacity.js: CRUD wrapper for bakery_capacity + capacity_overrides"
```

---

## Task 5: Bakery admin Capacity panel (`CapacityPanel.jsx`)

**Files:**
- Create: `public/src/components/CapacityPanel.jsx`
- Modify: `public/index.html` (add the script tag in the babel components block)
- Modify: `public/src/components/BakeryHomeView.jsx` (add a "Capacity" tab/section)

- [ ] **Step 1: Write `CapacityPanel.jsx`**

```jsx
// ===== CAPACITY PANEL (bakery admin) =====
// Bakery picks: lead time, blackout DOWs, sizing mode, base capacity per
// size, and dated overrides with optional reservation. All writes go through
// Capacity.* helpers.
function CapacityPanel({bakeryId, customers}){
  const[cap,setCap]=useState(null);
  const[overrides,setOverrides]=useState([]);
  const[saving,setSaving]=useState(false);
  const[modal,setModal]=useState(null); // {mode:'edit',row}|{mode:'add'}

  useEffect(()=>{
    let alive=true;
    (async()=>{
      const [c,o]=await Promise.all([
        Capacity.get(bakeryId),
        Capacity.listOverrides(bakeryId, new Date().toISOString().slice(0,10)),
      ]);
      if(alive){setCap(c);setOverrides(o);}
    })();
    return()=>{alive=false;};
  },[bakeryId]);

  if(!cap)return <div style={{padding:24,color:'#9ca3af'}}>Loading capacity…</div>;

  const sized = cap.sizing_mode==='sized';
  const setField=(k,v)=>setCap(p=>({...p,[k]:v}));
  const toggleDow=(d)=>{
    const set = new Set(cap.blackout_dows);
    if(set.has(d))set.delete(d);else set.add(d);
    setField('blackout_dows',[...set].sort());
  };

  const save=async()=>{
    setSaving(true);
    try{
      await Capacity.update(bakeryId, {
        sizing_mode: cap.sizing_mode,
        base_small: sized ? Number(cap.base_small||0) : null,
        base_medium: Number(cap.base_medium||0),
        base_large: sized ? Number(cap.base_large||0) : null,
        lead_days: Number(cap.lead_days||0),
        blackout_dows: cap.blackout_dows,
      });
    }finally{setSaving(false);}
  };

  const removeOverride=async(id)=>{
    if(!confirm('Delete this override?'))return;
    await Capacity.deleteOverride(id);
    setOverrides(o=>o.filter(r=>r.id!==id));
  };

  const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  return <div style={{padding:'24px',maxWidth:980,margin:'0 auto'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:18}}>
      <h2 style={{margin:0,fontSize:20,fontWeight:700}}>Capacity</h2>
      <button onClick={save} disabled={saving} style={btnPrimary}>{saving?'Saving…':'Save'}</button>
    </div>

    <Section label="Lead time">
      <input type="number" min={0} max={30} value={cap.lead_days} onChange={e=>setField('lead_days',e.target.value)} style={numInput}/>
      <span style={{marginLeft:8,fontSize:13,color:'#6b7280'}}>days minimum before delivery</span>
    </Section>

    <Section label="Blackout days">
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        {dayNames.map((n,d)=>{
          const on = cap.blackout_dows.includes(d);
          return <button key={d} onClick={()=>toggleDow(d)} style={{
            padding:'4px 12px', borderRadius:999, fontSize:12, cursor:'pointer',
            background: on?'#111':'#fff', color:on?'#fff':'#374151',
            border: on?'1px solid #111':'1px solid #d1d5db',
          }}>{n}</button>;
        })}
      </div>
    </Section>

    <Section label="Sizing mode">
      <button onClick={()=>setField('sizing_mode','simple')} style={modeBtn(!sized)}>Simple (one count)</button>
      <button onClick={()=>setField('sizing_mode','sized')} style={modeBtn(sized)}>Sized (S / M / L)</button>
    </Section>

    <Section label="Daily capacity">
      {!sized && <SizeInput label="Cakes per day" value={cap.base_medium} onChange={v=>setField('base_medium',v)}/>}
      {sized && <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:14}}>
        <SizeInput label="Small (cupcake box, 6&quot;)"  value={cap.base_small||0}  onChange={v=>setField('base_small',v)}/>
        <SizeInput label='Medium (8" round)'             value={cap.base_medium||0} onChange={v=>setField('base_medium',v)}/>
        <SizeInput label='Large (10"+ tiered)'           value={cap.base_large||0}  onChange={v=>setField('base_large',v)}/>
      </div>}
    </Section>

    <Section label="Overrides" right={<button onClick={()=>setModal({mode:'add'})} style={btnPrimary}>+ Add override</button>}>
      <div style={{border:'1px solid #e5e7eb',borderRadius:8,overflow:'hidden'}}>
        <div style={ovHead}>
          <div>Date</div><div>Bump (S / M / L)</div><div>Reason / Reserved</div><div></div>
        </div>
        {overrides.length===0 && <div style={{padding:14,fontSize:13,color:'#9ca3af',textAlign:'center'}}>No overrides yet.</div>}
        {overrides.map(o=>{
          const cust = (customers||[]).find(c=>c.id===o.reserved_for_customer_id);
          return <div key={o.id} style={ovRow}>
            <div>{o.date}</div>
            <div>+{o.delta_small} / +{o.delta_medium} / +{o.delta_large}</div>
            <div>{o.reason||''}{cust?` · Reserved for ${cust.name}${o.reserved_until?` until ${o.reserved_until}`:''}`:''}</div>
            <div style={{textAlign:'right'}}>
              <button onClick={()=>setModal({mode:'edit',row:o})} style={ovLink}>Edit</button>
              <button onClick={()=>removeOverride(o.id)} style={{...ovLink,color:'#b91c1c'}}>Delete</button>
            </div>
          </div>;
        })}
      </div>
    </Section>

    {modal && <OverrideModal
      bakeryId={bakeryId}
      customers={customers||[]}
      sized={sized}
      initial={modal.row}
      onClose={()=>setModal(null)}
      onSaved={(saved)=>{
        setOverrides(prev=>{
          const others = prev.filter(p=>p.id!==saved.id && !(p.bakery_id===saved.bakery_id && p.date===saved.date));
          return [...others, saved].sort((a,b)=>a.date.localeCompare(b.date));
        });
        setModal(null);
      }}
    />}
  </div>;
}

function Section({label, right, children}){
  return <div style={{marginBottom:22}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
      <div style={{fontSize:11,color:'#6b7280',textTransform:'uppercase',letterSpacing:'.04em',fontWeight:600}}>{label}</div>
      {right}
    </div>
    {children}
  </div>;
}
function SizeInput({label,value,onChange}){
  return <div>
    <div style={{fontSize:12,color:'#374151',marginBottom:4}}>{label}</div>
    <div style={{display:'flex',alignItems:'center',gap:6}}>
      <input type="number" min={0} value={value} onChange={e=>onChange(Number(e.target.value))} style={numInput}/>
      <span style={{fontSize:12,color:'#6b7280'}}>/day</span>
    </div>
  </div>;
}
function OverrideModal({bakeryId, customers, sized, initial, onClose, onSaved}){
  const today=new Date().toISOString().slice(0,10);
  const[mode,setMode]=useState(initial?.id?'single':'single');
  const[date,setDate]=useState(initial?.date||today);
  const[from,setFrom]=useState(today);
  const[to,setTo]=useState(today);
  const[deltas,setDeltas]=useState({
    s: initial?.delta_small||0, m: initial?.delta_medium||0, l: initial?.delta_large||0,
  });
  const[reason,setReason]=useState(initial?.reason||'');
  const[reserved,setReserved]=useState(initial?.reserved_for_customer_id||'');
  const[until,setUntil]=useState(initial?.reserved_until||'');
  const[saving,setSaving]=useState(false);

  const save=async()=>{
    setSaving(true);
    try{
      if(mode==='single'){
        const saved = await Capacity.upsertOverride({
          bakery_id: bakeryId, date,
          delta_small: sized?Number(deltas.s):0,
          delta_medium: Number(deltas.m),
          delta_large: sized?Number(deltas.l):0,
          reason, reserved_for_customer_id: reserved||null, reserved_until: until||null,
        });
        onSaved(saved);
      }else{
        await Capacity.addOverrideRange({
          bakery_id: bakeryId, from_date: from, to_date: to,
          delta_small: sized?Number(deltas.s):0,
          delta_medium: Number(deltas.m),
          delta_large: sized?Number(deltas.l):0,
          reason, reserved_for_customer_id: reserved||null, reserved_until: until||null,
        });
        // Reload all overrides — bulk insert doesn't return the rows uniformly.
        const all = await Capacity.listOverrides(bakeryId, today);
        for(const o of all) onSaved(o);
      }
    }finally{setSaving(false);}
  };

  return <div style={modalShade} onClick={onClose}>
    <div style={modalCard} onClick={e=>e.stopPropagation()}>
      <h3 style={{margin:'0 0 14px',fontSize:16,fontWeight:700}}>{initial?'Edit override':'Add override'}</h3>

      {!initial && <div style={{display:'flex',gap:8,marginBottom:14}}>
        <button onClick={()=>setMode('single')} style={modeBtn(mode==='single')}>Single date</button>
        <button onClick={()=>setMode('range')} style={modeBtn(mode==='range')}>Date range</button>
      </div>}

      {mode==='single' && <Field label="Date"><input type="date" value={date} onChange={e=>setDate(e.target.value)} style={textInput}/></Field>}
      {mode==='range' && <>
        <Field label="From"><input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={textInput}/></Field>
        <Field label="To"><input type="date" value={to} onChange={e=>setTo(e.target.value)} style={textInput}/></Field>
      </>}

      <Field label={sized?"Bump (S / M / L)":"Bump (cakes/day)"}>
        {sized && <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          <input type="number" value={deltas.s} onChange={e=>setDeltas({...deltas,s:e.target.value})} style={numInput}/>
          <input type="number" value={deltas.m} onChange={e=>setDeltas({...deltas,m:e.target.value})} style={numInput}/>
          <input type="number" value={deltas.l} onChange={e=>setDeltas({...deltas,l:e.target.value})} style={numInput}/>
        </div>}
        {!sized && <input type="number" value={deltas.m} onChange={e=>setDeltas({...deltas,m:e.target.value})} style={numInput}/>}
      </Field>

      <Field label="Reason"><input type="text" value={reason} onChange={e=>setReason(e.target.value)} placeholder="Holiday push, extra staff hired…" style={textInput}/></Field>

      <Field label="Reserved for (optional)">
        <select value={reserved} onChange={e=>setReserved(e.target.value)} style={textInput}>
          <option value="">(none — anyone can book)</option>
          {customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      {reserved && <Field label="Reservation expires"><input type="date" value={until} onChange={e=>setUntil(e.target.value)} style={textInput}/></Field>}

      <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:18}}>
        <button onClick={onClose} style={btnGhost}>Cancel</button>
        <button onClick={save} disabled={saving} style={btnPrimary}>{saving?'Saving…':'Save'}</button>
      </div>
    </div>
  </div>;
}
function Field({label,children}){return <div style={{marginBottom:12}}><div style={{fontSize:11,color:'#6b7280',textTransform:'uppercase',letterSpacing:'.04em',fontWeight:600,marginBottom:4}}>{label}</div>{children}</div>;}

const numInput={width:80,padding:'6px 8px',border:'1px solid #d1d5db',borderRadius:4,fontSize:14,fontFamily:'inherit'};
const textInput={padding:'6px 10px',border:'1px solid #d1d5db',borderRadius:4,fontSize:14,fontFamily:'inherit',width:'100%',boxSizing:'border-box'};
const btnPrimary={background:'#111',color:'#fff',border:0,padding:'8px 14px',borderRadius:6,fontSize:13,cursor:'pointer'};
const btnGhost={background:'#fff',border:'1px solid #d1d5db',padding:'8px 14px',borderRadius:6,fontSize:13,cursor:'pointer'};
const modeBtn=(on)=>({padding:'8px 14px',background:on?'#111':'#fff',color:on?'#fff':'#374151',border:on?'1px solid #111':'1px solid #d1d5db',borderRadius:6,fontSize:13,cursor:'pointer',marginRight:8});
const ovHead={display:'grid',gridTemplateColumns:'120px 1fr 1.5fr 120px',padding:'8px 12px',background:'#f9fafb',borderBottom:'1px solid #e5e7eb',fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#6b7280',fontWeight:600};
const ovRow={display:'grid',gridTemplateColumns:'120px 1fr 1.5fr 120px',padding:'12px',borderBottom:'1px solid #f3f4f6',fontSize:13,alignItems:'center'};
const ovLink={background:'transparent',border:0,color:'#6b7280',fontSize:12,cursor:'pointer',padding:'2px 6px',marginLeft:4};
const modalShade={position:'fixed',inset:0,background:'rgba(0,0,0,.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:50};
const modalCard={background:'#fff',borderRadius:12,padding:24,width:480,maxWidth:'90vw',maxHeight:'90vh',overflow:'auto'};
```

- [ ] **Step 2: Wire into `public/index.html`**

In the babel-text scripts block, after `<script type="text/babel" src="./src/components/BakeryEditor.jsx"></script>`, add:

```html
<script type="text/babel" src="./src/components/CapacityPanel.jsx"></script>
```

- [ ] **Step 3: Add a Capacity tab in `BakeryHomeView.jsx`**

Find the existing tab declarations in `public/src/components/BakeryHomeView.jsx`. Add a new tab labelled "Capacity" alongside "Routes". When that tab is active, render `<CapacityPanel bakeryId={bakeryId} customers={customers}/>` (load `customers` once via `Admin.listCustomers()` on mount).

- [ ] **Step 4: Smoke**

1. Pick a bakery profile. Click "Capacity" tab.
2. Toggle Sized mode → 3 inputs appear; toggle back → 1 input.
3. Change lead time to 5; click Save. Refresh → still 5.
4. Add an override for next Friday with +30 medium and reason "Test". Verify it appears in the table.
5. Edit it → change to +50 medium → Save → table updates.
6. Delete it → row disappears.
7. Add a date-range override (next Mon → next Fri, +20/day) → 5 rows appear in the table.

- [ ] **Step 5: Commit**

```bash
git add public/src/components/CapacityPanel.jsx public/index.html public/src/components/BakeryHomeView.jsx
git commit -m "CapacityPanel: bakery admin UI for capacity + dated overrides"
```

---

## Task 6: Browser-side booking wrapper (`db/booking.js`)

**Files:**
- Create: `public/src/db/booking.js`
- Modify: `public/index.html`

- [ ] **Step 1: Write `db/booking.js`**

```javascript
// ===== BOOKING (book-campaign-slot edge function client) =====
// Thin wrapper that calls the four actions on the deployed edge function.
// Reads SUPABASE_URL and the anon key from the same globals supabase.js uses.
const Booking = {
  async _call(action, body){
    if(!sb)throw new Error('sb not ready');
    const url = `${SUPABASE_URL}/functions/v1/book-campaign-slot/${action}`;
    const res = await fetch(url, {
      method:'POST',
      headers:{
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':'application/json',
      },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if(!res.ok) throw Object.assign(new Error(out.error||'request_failed'), out);
    return out;
  },
  availability(campaign_id, days=30){ return this._call('availability', {campaign_id, days}); },
  hold(campaign_id, picks){       return this._call('hold',         {campaign_id, picks}); },
  commit(campaign_id, hold_ids){  return this._call('commit',       {campaign_id, hold_ids}); },
  release(hold_ids){              return this._call('release',      {hold_ids}); },
};
```

- [ ] **Step 2: Wire into `public/index.html`**

After the `db/capacity.js` line, add:

```html
<script src="./src/db/booking.js"></script>
```

- [ ] **Step 3: Smoke in DevTools**

```javascript
const cs = await Admin.listCustomers();
const c = cs[0];
const camps = (await sb.from('campaigns').select('id,name').eq('customer_id',c.id)).data;
const a = await Booking.availability(camps[0].id, 14);
console.log(a);
```

Expected: same shape as the curl smoke in Task 3 step 3.

- [ ] **Step 4: Commit**

```bash
git add public/src/db/booking.js public/index.html
git commit -m "db/booking.js: browser wrapper for book-campaign-slot edge function"
```

---

## Task 7: Customer wizard — `DeliveryDateStep.jsx`

**Files:**
- Create: `public/src/components/DeliveryDateStep.jsx`
- Modify: `public/index.html`
- Modify: `public/src/components/UploadWizard.jsx`

- [ ] **Step 1: Write `DeliveryDateStep.jsx`**

```jsx
// ===== DELIVERY DATE STEP (customer wizard) =====
// Loads availability for the campaign, renders a 30-day grid color-coded by
// verdict, and on click holds + commits the slots. Auto-split UI shows a
// "deliver in 2 batches" prompt for yellow cells.
function DeliveryDateStep({campaignId, bakeries, onBooked, onBack}){
  const[avail,setAvail]=useState(null);
  const[picked,setPicked]=useState(null); // {primary:date, split?:{date2, bakeryIds[]}}
  const[holding,setHolding]=useState(false);
  const[error,setError]=useState(null);

  useEffect(()=>{
    let alive=true;
    setAvail(null);
    Booking.availability(campaignId, 30).then(r=>{if(alive)setAvail(r);}).catch(e=>{if(alive)setError(e.message);});
    return()=>{alive=false;};
  },[campaignId]);

  const bakeriesById = useMemo(()=>{
    const m=new Map(); for(const b of bakeries||[]) m.set(b.id,b); return m;
  },[bakeries]);

  if(!avail&&!error)return <div style={{padding:40,textAlign:'center',color:'#9ca3af'}}>Loading available dates…</div>;
  if(error)return <div style={{padding:40,color:'#b91c1c'}}>Couldn't load availability: {error}</div>;

  const total = avail.needs.reduce((s,n)=>s+n.count_small+n.count_medium+n.count_large, 0);

  const onPick=(cell)=>{
    if(cell.verdict==='red'){return;}
    if(cell.verdict==='green'){setPicked({primary:cell.date}); return;}
    // yellow: build split proposal
    const allShort = cell.shortBakeries.filter(s=>s.nextOpen);
    if(allShort.length===0){return;}
    // For now, pick the first short bakery's nextOpen as the secondary date.
    // (Multi-date splits are deferred — the spec covers the 2-date case.)
    const date2 = allShort.map(s=>s.nextOpen).sort()[0];
    const bakeryIds = allShort.map(s=>s.bakery_id);
    setPicked({primary: cell.date, split:{date2, bakeryIds}});
  };

  const confirm=async()=>{
    if(!picked)return;
    setHolding(true);
    try{
      // Build picks: assign each bakery's full need to either primary or
      // split.date2 depending on whether that bakery is in the split list.
      const splitIds = new Set(picked.split?.bakeryIds||[]);
      const picks = avail.needs.flatMap(n=>{
        const date = splitIds.has(n.bakery_id) ? picked.split.date2 : picked.primary;
        return [{ bakery_id:n.bakery_id, date, count_small:n.count_small, count_medium:n.count_medium, count_large:n.count_large }];
      });
      const hold = await Booking.hold(campaignId, picks);
      // (Stripe checkout would happen here in a future plan — for now commit immediately.)
      await Booking.commit(campaignId, hold.hold_ids);
      onBooked({primary:picked.primary, split:picked.split, total});
    }catch(e){
      setError(e.detail||e.message||'Booking failed');
      setPicked(null);
    }finally{setHolding(false);}
  };

  return <div style={{maxWidth:880,margin:'0 auto',padding:24}}>
    <h2 style={{margin:'0 0 4px',fontSize:20,fontWeight:700}}>Pick a delivery date</h2>
    <p style={{margin:'0 0 18px',color:'#6b7280',fontSize:14}}>
      {total} cakes across {avail.needs.length} bakeries. Green = all bakeries open. Yellow = needs split across 2 days. Red = no fit.
    </p>

    <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:6,marginBottom:18}}>
      {avail.calendar.map(c=>{
        const dow = new Date(c.date+'T00:00:00Z').getUTCDay();
        const dayLabel = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
        const day = Number(c.date.slice(8,10));
        const month = Number(c.date.slice(5,7));
        const bg = c.verdict==='green'?'#dcfce7':c.verdict==='yellow'?'#fef3c7':'#fee2e2';
        const fg = c.verdict==='green'?'#166534':c.verdict==='yellow'?'#92400e':'#991b1b';
        const pickedHere = picked && (picked.primary===c.date || picked.split?.date2===c.date);
        return <button key={c.date} onClick={()=>onPick(c)} disabled={c.verdict==='red'} style={{
          background:bg, color:fg, border: pickedHere?'2px solid #16a34a':'1px solid transparent',
          borderRadius:8, padding:'10px 6px', textAlign:'center', fontSize:11, cursor:c.verdict==='red'?'not-allowed':'pointer',
          opacity:c.verdict==='red'?.55:1, fontFamily:'inherit',
        }}>
          <div style={{fontWeight:700,fontSize:10,textTransform:'uppercase'}}>{dayLabel}</div>
          <div style={{fontSize:18,fontWeight:700,color:'#111',margin:'2px 0'}}>{day}</div>
          <div style={{fontSize:10}}>{c.verdict==='red'?reasonFor(c, bakeriesById):c.verdict==='yellow'?'Split needed':'OK'}</div>
        </button>;
      })}
    </div>

    {picked && <div style={{background:'#f0fdf4',border:'1px solid #16a34a',borderRadius:8,padding:14,marginBottom:14,fontSize:13,color:'#166534'}}>
      {!picked.split && <>Booking all {total} cakes for <strong>{picked.primary}</strong>.</>}
      {picked.split && <>
        Two-batch split:
        <ul style={{margin:'6px 0 0 18px'}}>
          <li>{avail.needs.filter(n=>!picked.split.bakeryIds.includes(n.bakery_id)).reduce((s,n)=>s+n.count_small+n.count_medium+n.count_large,0)} cakes on <strong>{picked.primary}</strong></li>
          <li>{avail.needs.filter(n=>picked.split.bakeryIds.includes(n.bakery_id)).reduce((s,n)=>s+n.count_small+n.count_medium+n.count_large,0)} cakes on <strong>{picked.split.date2}</strong> ({picked.split.bakeryIds.map(id=>bakeriesById.get(id)?.name||id).join(', ')})</li>
        </ul>
      </>}
    </div>}

    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <button onClick={onBack} style={btnGhost}>← Back</button>
      <button onClick={confirm} disabled={!picked||holding} style={{...btnPrimary, opacity:(!picked||holding)?.5:1}}>
        {holding?'Booking…':'Confirm and book'}
      </button>
    </div>
  </div>;
}

function reasonFor(cell, bakeriesById){
  const today = new Date().toISOString().slice(0,10);
  if(cell.date <= today) return 'Past';
  if(cell.shortBakeries?.length){
    const b = cell.shortBakeries[0];
    const name = bakeriesById.get(b.bakery_id)?.name || b.bakery_id;
    if(!b.nextOpen) return `${name}: full`;
    return `${name}: full`;
  }
  return 'Past lead';
}
```

- [ ] **Step 2: Wire into `public/index.html`**

In the babel-text block, after `DesignsStep.jsx`, add:

```html
<script type="text/babel" src="./src/components/DeliveryDateStep.jsx"></script>
```

- [ ] **Step 3: Insert the step in `UploadWizard.jsx`**

Find where `UploadWizard.jsx` advances from the review step to "finalize". Add a new step state value `'delivery_date'` between them. When that step is active, render:

```jsx
<DeliveryDateStep
  campaignId={campaignId}
  bakeries={bakeries /* loaded once at wizard mount via Admin.listBakeries() */}
  onBack={()=>setStep('review')}
  onBooked={(result)=>{ setBookingResult(result); setStep('finalize'); }}
/>
```

The existing finalize step shows a confirmation; change its body to read `bookingResult` and display the booked dates.

- [ ] **Step 4: Smoke (end-to-end)**

1. Pick a customer profile. Start a new campaign upload, walk through to the new "Pick delivery date" step.
2. Calendar renders with green/yellow/red cells. The first 3 days are red (lead time) and Sunday is red (blackout).
3. Click a green cell → booking summary shows "Booking all N cakes for YYYY-MM-DD".
4. Click "Confirm and book" → step advances to finalize; finalize shows the booked date.
5. Verify in DB: `select count(*), delivery_date from recipients where campaign_id = '<id>' group by delivery_date` returns the booked date with the right count.
6. Try clicking a yellow cell — split summary appears with both dates.

- [ ] **Step 5: Commit**

```bash
git add public/src/components/DeliveryDateStep.jsx public/src/components/UploadWizard.jsx public/index.html
git commit -m "DeliveryDateStep: customer wizard step for picking delivery date(s)"
```

---

## Task 8: External box label print artifact (`BoxLabel.jsx`)

**Files:**
- Create: `public/src/components/BoxLabel.jsx`
- Modify: `public/index.html`
- Modify: `public/src/styles.css` (add `@media print` rules for the label sheet)

- [ ] **Step 1: Write `BoxLabel.jsx`**

```jsx
// ===== EXTERNAL BOX LABELS =====
// Two surfaces:
//   <BoxLabel/>      — single 4x2" label render, used in previews.
//   <BoxLabelSheet/> — 10-up letter sheet, used by the Print button. Triggers
//                      window.print() with the print stylesheet active.
function BoxLabel({stop, recipient, campaign, route, driver, time_window, bakery_name}){
  return <div className="box-label" style={{
    width:'4in', height:'2in', background:'#fff', border:'1px dashed #cbd5e1',
    display:'grid', gridTemplateRows:'auto 1fr auto', overflow:'hidden', fontFamily:'DM Sans, sans-serif',
  }}>
    <div style={{
      height:18, padding:'0 12px', display:'flex', alignItems:'center', justifyContent:'space-between',
      background: campaign.color_hex || '#7c3aed', color:'#fff', fontSize:11, textTransform:'uppercase',
      letterSpacing:'.06em', fontWeight:700,
    }}>
      <span>{campaign.name}</span><span>{recipient.delivery_date}</span>
    </div>
    <div style={{padding:'14px 16px', display:'flex', flexDirection:'column', gap:6}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:10}}>
        <div style={{fontSize:42, fontWeight:800, lineHeight:1, fontFamily:'ui-monospace, Menlo, monospace'}}>{String(stop).padStart(2,'0')}</div>
        <div style={{textAlign:'right', fontSize:10, color:'#6b7280', display:'flex', flexDirection:'column'}}>
          <span>Route {route}</span>
          {driver && <span>Driver: {driver}</span>}
          {time_window && <span>{time_window}</span>}
        </div>
      </div>
      <div style={{fontSize:18, fontWeight:700, color:'#111', lineHeight:1.15, marginTop:4}}>{recipient.company}</div>
      <div style={{fontSize:11, color:'#374151', lineHeight:1.3}}>
        {[recipient.address, recipient.city, recipient.zip].filter(Boolean).join(' · ')}
      </div>
    </div>
    <div style={{padding:'6px 12px', background:'#f9fafb', fontSize:9, color:'#9ca3af', display:'flex', justifyContent:'space-between', borderTop:'1px solid #f3f4f6'}}>
      <span>{bakery_name}</span>
      <span>{recipient.id?.slice(0,6)} · {recipient.size||'medium'}</span>
    </div>
  </div>;
}

// 10-up letter sheet. Invoked by the day view's "Print all box labels" button.
// Opens a new window with just the sheet + print stylesheet, then calls print().
function BoxLabelSheet({labels, bakery_name}){
  // Pad to a multiple of 10 with empty cells.
  const padded = labels.concat(Array(((10 - labels.length % 10) % 10)).fill(null));
  const pages = [];
  for (let i = 0; i < padded.length; i += 10) pages.push(padded.slice(i, i+10));

  return <div className="box-label-sheets">
    {pages.map((page, pi) => (
      <div key={pi} className="box-label-page" style={{
        width:'8.5in', height:'11in', padding:'0.5in', display:'grid',
        gridTemplateColumns:'1fr 1fr', gridTemplateRows:'repeat(5, 2in)', gap:'0.1in',
        pageBreakAfter:'always', background:'#fff',
      }}>
        {page.map((l, li) => l ? <BoxLabel key={li} {...l} bakery_name={bakery_name}/> : <div key={li} style={{border:'1px dashed #e5e7eb'}}/>)}
      </div>
    ))}
  </div>;
}

// Helper: open a print preview window with these labels.
window.printBoxLabels = function(labels, bakery_name) {
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) { alert('Popup blocked. Allow popups and try again.'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>Box labels</title>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet"/>
    <style>
      body{margin:0;background:#f3f4f6;padding:24px;font-family:'DM Sans',sans-serif}
      @media print { body{background:#fff;padding:0} .box-label-page{margin:0} }
    </style></head><body><div id="root"></div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"><\/script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"><\/script>
    </body></html>`);
  w.document.close();
  w.onload = () => {
    const r = w.ReactDOM.createRoot(w.document.getElementById('root'));
    r.render(w.React.createElement(BoxLabelSheet, { labels, bakery_name }));
    setTimeout(() => w.print(), 600);
  };
};
```

- [ ] **Step 2: Wire into `public/index.html`**

After `DeliveryDateStep.jsx`:

```html
<script type="text/babel" src="./src/components/BoxLabel.jsx"></script>
```

- [ ] **Step 3: Smoke in DevTools**

```javascript
window.printBoxLabels([
  { stop:1, route:'2/4', driver:'Marcus', time_window:'9–11 AM',
    recipient:{ id:'7f3a2c11', company:'Acme Dental Group', address:'330 Main St', city:'San Francisco', zip:'94105', delivery_date:'2026-11-18', size:'medium' },
    campaign:{ name:'Daymaker × Archy Holidays', color_hex:'#7c3aed' } },
  { stop:2, route:'2/4', driver:'Marcus', time_window:'9–11 AM',
    recipient:{ id:'2b9d1100', company:'Lee Family Dental', address:'1234 Oak St', city:'San Francisco', zip:'94117', delivery_date:'2026-11-18', size:'medium' },
    campaign:{ name:'Archy direct', color_hex:'#0891b2' } },
], 'Boho Petite');
```

Expected: a new tab opens with the labels rendered; print dialog appears; preview shows 1 page with 2 labels populated and 8 empty cells.

- [ ] **Step 4: Commit**

```bash
git add public/src/components/BoxLabel.jsx public/index.html
git commit -m "BoxLabel: 4x2\" external label + 10-up letter sheet print pipeline"
```

---

## Task 9: Day-first OpsView shell + day-view DB helpers

**Files:**
- Create: `public/src/db/day-view.js`
- Create: `public/src/components/DayView.jsx`
- Modify: `public/index.html`
- Modify: `public/src/components/App.jsx`
- Modify: `public/src/components/BakeryHomeView.jsx`

- [ ] **Step 1: Write `db/day-view.js`**

```javascript
// ===== DAY VIEW DATA ACCESS =====
// Queries the bakery's day-scoped data: which dates have stops, recipients
// per date (optionally filtered by campaign), routes per date, and a way to
// mark a route row dirty so the next open re-solves.
const DayView = {
  // Returns [{ date, total, by_campaign: { campaign_id: { count, name, color_hex } } }, ...]
  // for the next 60 days at this bakery.
  async listDates(bakery_id){
    if(!sb) throw new Error('sb not ready');
    const today = new Date().toISOString().slice(0,10);
    const { data, error } = await sb.from('recipients')
      .select('delivery_date, campaign_id, campaigns!inner(name, color_hex)')
      .eq('bakery_id', bakery_id)
      .eq('assignment_status', 'assigned')
      .not('delivery_date', 'is', null)
      .gte('delivery_date', today)
      .order('delivery_date');
    if (error) throw error;
    const acc = new Map();
    for (const r of data || []) {
      const d = r.delivery_date;
      const cur = acc.get(d) ?? { date: d, total: 0, by_campaign: {} };
      cur.total++;
      const c = r.campaigns;
      cur.by_campaign[r.campaign_id] = cur.by_campaign[r.campaign_id]
        ? { ...cur.by_campaign[r.campaign_id], count: cur.by_campaign[r.campaign_id].count + 1 }
        : { name: c.name, color_hex: c.color_hex || hashColor(r.campaign_id), count: 1 };
      acc.set(d, cur);
    }
    return [...acc.values()];
  },

  async loadDayRecipients(bakery_id, date, campaign_id){
    if(!sb) throw new Error('sb not ready');
    let q = sb.from('recipients')
      .select('id, company, contact_name, address, city, zip, lat, lon, size, campaign_id, customizations, campaigns!inner(name, color_hex, default_design)')
      .eq('bakery_id', bakery_id)
      .eq('delivery_date', date)
      .eq('assignment_status', 'assigned')
      .order('company');
    if (campaign_id) q = q.eq('campaign_id', campaign_id);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  async loadDayRoutes(bakery_id, date){
    if(!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('routes')
      .select('id, delivery_area_id, data, updated_at')
      .eq('bakery_id', bakery_id).eq('delivery_date', date);
    if (error) throw error;
    return data || [];
  },

  async markRouteDirty(bakery_id, date){
    if(!sb) throw new Error('sb not ready');
    const { data: rows } = await sb.from('routes').select('id').eq('bakery_id', bakery_id).eq('delivery_date', date);
    for (const r of rows || []) {
      await sb.from('routes').update({ data: { dirty: true }, updated_at: new Date().toISOString() }).eq('id', r.id);
    }
  },
};

// Deterministic palette of 8 distinguishable colors. campaigns.color_hex
// overrides this; this is the fallback when a campaign was created before
// color_hex was populated.
const COLOR_PALETTE = ['#7c3aed','#0891b2','#ea580c','#16a34a','#db2777','#0d9488','#ca8a04','#4f46e5'];
function hashColor(id){
  let h = 0;
  for (let i = 0; i < id.length; i++) { h = ((h<<5) - h) + id.charCodeAt(i); h |= 0; }
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}
```

- [ ] **Step 2: Write `DayView.jsx` (shell only — tabs become full in tasks 10/11)**

```jsx
// ===== DAY-FIRST OPS VIEW =====
// Top-to-bottom layout: bakery header, date strip, tab bar, campaign filter
// chips, body. Each tab body lives in its own component (DayRoutesTab,
// DayProductionTab, DayPhotosTab).
function DayView({bakeryId, bakeryName}){
  const[dates,setDates]=useState([]);
  const[selectedDate,setSelectedDate]=useState(null);
  const[tab,setTab]=useState('routes');
  const[campaignFilter,setCampaignFilter]=useState(null);

  useEffect(()=>{
    DayView_loadDates();
    function handler(){DayView_loadDates();}
    // Re-load when slot_holds or routes change via realtime.
    const ch = sb.channel('day-view').on('postgres_changes',{event:'*',schema:'public',table:'routes'},handler).subscribe();
    return()=>{sb.removeChannel(ch);};
    // eslint-disable-next-line
  },[bakeryId]);

  async function DayView_loadDates(){
    const ds = await DayView.listDates(bakeryId);
    setDates(ds);
    setSelectedDate(prev => prev || (ds[0]?.date ?? null));
  }

  if(dates.length===0){
    return <div style={{padding:60,textAlign:'center',color:'#6b7280'}}>
      <div style={{fontSize:18,fontWeight:600,color:'#374151'}}>No upcoming deliveries</div>
      <div style={{marginTop:6,fontSize:13}}>Once customers book delivery dates, they'll show up here.</div>
    </div>;
  }

  const day = dates.find(d=>d.date===selectedDate);
  const campaigns = day ? Object.entries(day.by_campaign).map(([id,v])=>({id,...v})) : [];

  return <div style={{background:'#f3f4f6',minHeight:'100vh'}}>
    <div style={{padding:'16px 24px',background:'#fff',borderBottom:'1px solid #f3f4f6'}}>
      <div style={{maxWidth:1400,margin:'0 auto',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div>
          <h1 style={{margin:0,fontSize:18,fontWeight:700}}>{bakeryName}</h1>
          <div style={{fontSize:12,color:'#6b7280',marginTop:2}}>{selectedDate || '—'}</div>
        </div>
      </div>
    </div>

    <DateStrip dates={dates} selected={selectedDate} onSelect={setSelectedDate}/>

    <div style={{maxWidth:1400,margin:'16px auto 0',background:'#fff',borderRadius:12,border:'1px solid #e5e7eb',overflow:'hidden'}}>
      <div style={{display:'flex',gap:0,borderBottom:'1px solid #e5e7eb',padding:'0 24px'}}>
        <TabBtn label="Routes" active={tab==='routes'} count={day?.total} onClick={()=>setTab('routes')}/>
        <TabBtn label="Production" active={tab==='production'} count={day?.total} onClick={()=>setTab('production')}/>
        <TabBtn label="Photos" active={tab==='photos'} count={day?.total} onClick={()=>setTab('photos')}/>
      </div>

      <FilterChips campaigns={campaigns} selected={campaignFilter} onSelect={setCampaignFilter} total={day?.total}/>

      {tab==='routes'    && <DayRoutesTab    bakeryId={bakeryId} bakeryName={bakeryName} date={selectedDate} campaignFilter={campaignFilter} campaigns={campaigns}/>}
      {tab==='production'&& <DayProductionTab bakeryId={bakeryId} bakeryName={bakeryName} date={selectedDate} campaignFilter={campaignFilter} campaigns={campaigns}/>}
      {tab==='photos'    && <DayPhotosTab    bakeryId={bakeryId} bakeryName={bakeryName} date={selectedDate} campaignFilter={campaignFilter} campaigns={campaigns}/>}
    </div>
  </div>;
}

function DateStrip({dates, selected, onSelect}){
  return <div style={{padding:'14px 24px',background:'#f9fafb',borderBottom:'1px solid #e5e7eb',overflowX:'auto'}}>
    <div style={{maxWidth:1400,margin:'0 auto',display:'flex',gap:6,alignItems:'center'}}>
      {dates.map(d=>{
        const dt = new Date(d.date+'T00:00:00Z');
        const day = dt.getUTCDate();
        const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getUTCDay()];
        const active = d.date===selected;
        return <button key={d.date} onClick={()=>onSelect(d.date)} style={{
          display:'flex',flexDirection:'column',alignItems:'center',padding:'8px 14px',
          background:active?'#111':'#fff', color:active?'#fff':'#6b7280',
          border: active?'1px solid #111':'1px solid #e5e7eb', borderRadius:8,
          fontSize:11, cursor:'pointer', minWidth:78, flexShrink:0, fontFamily:'inherit',
        }}>
          <span style={{textTransform:'uppercase',letterSpacing:'.04em',fontWeight:600}}>{dow}</span>
          <span style={{fontSize:18,fontWeight:700,color:active?'#fff':'#111',lineHeight:1.1,margin:'2px 0'}}>{day}</span>
          <span style={{fontSize:10,color:active?'#cbd5e1':'#9ca3af'}}>{d.total} stops · {Object.keys(d.by_campaign).length} camp</span>
        </button>;
      })}
    </div>
  </div>;
}

function TabBtn({label, active, count, onClick}){
  return <button onClick={onClick} style={{
    background:'none', border:0, borderBottom:'2px solid '+(active?'#111':'transparent'),
    padding:'12px 18px', fontSize:13, color:active?'#111':'#6b7280',
    fontFamily:'inherit', fontWeight:active?600:500, cursor:'pointer',
  }}>{label}{count!=null && <span style={{display:'inline-block',background:'#f3f4f6',color:'#374151',fontSize:11,fontWeight:600,padding:'1px 7px',borderRadius:999,marginLeft:6}}>{count}</span>}</button>;
}

function FilterChips({campaigns, selected, onSelect, total}){
  return <div style={{padding:'14px 24px',background:'#f9fafb',borderBottom:'1px solid #f3f4f6',display:'flex',gap:8,flexWrap:'wrap'}}>
    <Chip active={!selected} onClick={()=>onSelect(null)}>All campaigns · {total||0}</Chip>
    {campaigns.map(c=>
      <Chip key={c.id} active={selected===c.id} onClick={()=>onSelect(c.id)} swatch={c.color_hex}>{c.name} · {c.count}</Chip>
    )}
  </div>;
}
function Chip({active,onClick,swatch,children}){
  return <button onClick={onClick} style={{
    background:active?'#111':'#fff', color:active?'#fff':'#374151',
    border:active?'1px solid #111':'1px solid #e5e7eb', padding:'5px 11px',
    borderRadius:999, fontSize:12, cursor:'pointer', display:'flex',alignItems:'center',gap:6,
    fontFamily:'inherit',
  }}>
    {swatch && <span style={{display:'inline-block',width:10,height:10,borderRadius:2,background:swatch}}/>}
    {children}
  </button>;
}
```

- [ ] **Step 3: Wire into `public/index.html`**

```html
<script src="./src/db/day-view.js"></script>
```
(after `db/booking.js`)

In the babel block, after `BoxLabel.jsx`:

```html
<script type="text/babel" src="./src/components/DayView.jsx"></script>
<script type="text/babel" src="./src/components/DayRoutesTab.jsx"></script>
<script type="text/babel" src="./src/components/DayProductionTab.jsx"></script>
<script type="text/babel" src="./src/components/DayPhotosTab.jsx"></script>
```

(The latter three files are stubbed in this task and filled in tasks 10/11.)

Create stubs for the three tab files now so the index.html script loads don't 404:

```jsx
// public/src/components/DayRoutesTab.jsx
function DayRoutesTab({bakeryId, bakeryName, date, campaignFilter, campaigns}){
  return <div style={{padding:40,color:'#9ca3af'}}>Routes for {date} (filter: {campaignFilter||'all'}) — coming in Task 10.</div>;
}
```

```jsx
// public/src/components/DayProductionTab.jsx
function DayProductionTab({bakeryId, bakeryName, date, campaignFilter, campaigns}){
  return <div style={{padding:40,color:'#9ca3af'}}>Production for {date} — coming in Task 11.</div>;
}
```

```jsx
// public/src/components/DayPhotosTab.jsx
function DayPhotosTab({bakeryId, bakeryName, date, campaignFilter, campaigns}){
  return <div style={{padding:40,color:'#9ca3af'}}>Photos for {date} — coming in Task 11.</div>;
}
```

- [ ] **Step 4: Mount `<DayView/>` in `BakeryHomeView`**

In `public/src/components/BakeryHomeView.jsx`, where the existing OpsView is mounted, wrap it with the new shell. The existing per-region `OpsView` keeps working as a fallback when there are no scheduled-by-date recipients yet (i.e. before any campaign has a `delivery_date`). When a date is selected, render `<DayView bakeryId={bakeryId} bakeryName={bakeryName}/>` instead.

- [ ] **Step 5: Smoke**

1. Pick a bakery profile.
2. If recipients have been backfilled with `delivery_date` (per the migration's join), the date strip shows them; otherwise the empty state renders.
3. Click a date in the strip — header date updates.
4. Click filter chips — selection highlights.
5. Routes tab shows the stub message; Production/Photos do too.

- [ ] **Step 6: Commit**

```bash
git add public/src/db/day-view.js public/src/components/DayView.jsx \
        public/src/components/DayRoutesTab.jsx public/src/components/DayProductionTab.jsx public/src/components/DayPhotosTab.jsx \
        public/index.html public/src/components/BakeryHomeView.jsx
git commit -m "DayView: day-first OpsView shell with date strip + filter chips + tab stubs"
```

---

## Task 10: Day Routes tab — merged routes + map color bands

**Files:**
- Modify: `public/src/components/DayRoutesTab.jsx` (replace stub with full implementation)
- Modify: `public/src/components/MapView.jsx` (accept per-stop `color_hex` for marker fill)
- Modify: `public/src/components/StopCard.jsx` (accept and render the campaign band)

- [ ] **Step 1: Replace `DayRoutesTab.jsx` stub with the full implementation**

```jsx
// ===== DAY ROUTES TAB =====
// Loads the day's routes (one row per delivery_area). If any are dirty,
// triggers re-solve via Booking._call('rebalance', ...) — wait, no — via
// the existing rebalance helper. Renders per-driver merged routes with
// stops color-banded by campaign.
function DayRoutesTab({bakeryId, bakeryName, date, campaignFilter, campaigns}){
  const[routes,setRoutes]=useState([]);
  const[loading,setLoading]=useState(false);
  const[err,setErr]=useState(null);

  useEffect(()=>{ if(date) load(); /* eslint-disable-next-line */ },[bakeryId, date]);

  async function load(){
    setLoading(true); setErr(null);
    try {
      let rs = await DayView.loadDayRoutes(bakeryId, date);
      const dirty = rs.filter(r => r.data?.dirty);
      if (dirty.length) {
        await rebalanceForDate(bakeryId, date);
        rs = await DayView.loadDayRoutes(bakeryId, date);
      }
      setRoutes(rs);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }

  if(loading) return <div style={{padding:40,color:'#9ca3af'}}>Loading routes…</div>;
  if(err)     return <div style={{padding:40,color:'#b91c1c'}}>Failed: {err}</div>;
  if(routes.length===0) return <div style={{padding:40,color:'#9ca3af'}}>No routes for {date}.</div>;

  // Merge stops across all delivery_area routes, applying optional filter.
  const allStops = routes.flatMap(r => (r.data?.days?.[0]?.routes || []).flatMap(driverRoute =>
    (driverRoute.stops||[]).map(s => ({ ...s, _driver: driverRoute.driver || 'Driver', _route_id: r.id, _area_id: r.delivery_area_id }))
  ));
  const filtered = campaignFilter ? allStops.filter(s => s.campaign_id === campaignFilter) : allStops;

  // Group by driver string (preserves the per-driver split from the solver).
  const byDriver = new Map();
  for (const s of filtered) {
    const k = s._driver;
    const cur = byDriver.get(k) || { driver: k, stops: [] };
    cur.stops.push(s);
    byDriver.set(k, cur);
  }
  const drivers = [...byDriver.values()];

  // Build the labels list for "Print all box labels" — uses campaign color
  // resolved either from the stop or the campaigns prop.
  const printLabels = () => {
    const labels = [];
    let stopIdx = 0;
    for (const driver of drivers) {
      let i = 0;
      for (const s of driver.stops) {
        i++; stopIdx++;
        const camp = campaigns.find(c => c.id === s.campaign_id) || { name: s.campaign_name||'?', color_hex: s.color_hex||'#7c3aed' };
        labels.push({
          stop: i, route: `${drivers.indexOf(driver)+1}/${drivers.length}`,
          driver: driver.driver, time_window: s.time_window || '',
          recipient: { id: s.id, company: s.company || s.label || '?', address: s.address, city: s.city, zip: s.zip, delivery_date: date, size: s.size||'medium' },
          campaign: { name: camp.name, color_hex: camp.color_hex },
        });
      }
    }
    window.printBoxLabels(labels, bakeryName);
  };

  return <div>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'14px 24px',background:'#fff',borderBottom:'1px solid #f3f4f6'}}>
      <div style={{fontSize:12,color:'#6b7280'}}>
        <strong style={{color:'#111'}}>{drivers.length}</strong> drivers · <strong style={{color:'#111'}}>{filtered.length}</strong> stops
      </div>
      <div style={{display:'flex',gap:8}}>
        <button onClick={load} style={btnGhost}>↻ Re-optimize day</button>
        <button onClick={printLabels} style={btnPrimary}>🖨 Print all box labels</button>
      </div>
    </div>

    <div style={{display:'grid',gridTemplateColumns:'1fr 480px',minHeight:600}}>
      <div style={{overflow:'auto',maxHeight:760}}>
        {drivers.map((d, di) => <div key={d.driver+di} style={{borderBottom:'1px solid #f3f4f6'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 24px',background:'#f9fafb'}}>
            <h3 style={{margin:0,fontSize:13,fontWeight:700,textTransform:'uppercase',letterSpacing:'.04em'}}>Route {di+1} · {d.driver}</h3>
            <div style={{fontSize:11,color:'#6b7280'}}>{d.stops.length} stops</div>
          </div>
          {d.stops.map((s, si) => {
            const camp = campaigns.find(c => c.id === s.campaign_id);
            const color = camp?.color_hex || s.color_hex || '#7c3aed';
            return <div key={s.id||si} style={{display:'grid',gridTemplateColumns:'48px 8px 1fr auto',gap:12,padding:'12px 24px',borderTop:si===0?0:'1px solid #f3f4f6',alignItems:'center',background:'#fff'}}>
              <div style={{fontSize:20,fontWeight:800,color:'#9ca3af',fontFamily:'ui-monospace, Menlo, monospace',textAlign:'right'}}>{String(si+1).padStart(2,'0')}</div>
              <div style={{alignSelf:'stretch',background:color,borderRadius:2}}/>
              <div>
                <div style={{fontSize:14,fontWeight:600,color:'#111'}}>{s.company||s.label||'?'}</div>
                <div style={{fontSize:11,color:'#6b7280',marginTop:2,display:'flex',gap:10}}>
                  <span style={{color, fontWeight:600, textTransform:'uppercase', letterSpacing:'.04em', fontSize:10}}>{camp?.name || s.campaign_name || '?'}</span>
                  {s.address && <span>{s.address}</span>}
                </div>
              </div>
              <div style={{fontSize:10,padding:'2px 8px',borderRadius:999,textTransform:'uppercase',letterSpacing:'.04em',fontWeight:600,background:'#f3f4f6',color:'#6b7280'}}>pending</div>
            </div>;
          })}
        </div>)}
      </div>

      {/* Map slot — pass merged stops with color_hex; MapView change in step 2. */}
      <div style={{borderLeft:'1px solid #e5e7eb'}}>
        <MapView regionKey={null} forcedStops={filtered.map(s => ({ ...s, color_hex: (campaigns.find(c=>c.id===s.campaign_id)?.color_hex) || s.color_hex }))} forcedDepots={routes[0]?.data?.depots || []}/>
      </div>
    </div>
  </div>;
}

// Helper that asks the existing rebalance engine to solve for the day rather
// than for a campaign. Wires into the engine change in Task 12.
async function rebalanceForDate(bakery_id, date) {
  if (typeof window.rebalanceForDate !== 'function') {
    // Fallback: just clear the dirty flag so the UI stops re-trying.
    const rs = await DayView.loadDayRoutes(bakery_id, date);
    for (const r of rs) {
      await sb.from('routes').update({ data: { ...(r.data||{}), dirty: false } }).eq('id', r.id);
    }
    return;
  }
  return window.rebalanceForDate(bakery_id, date);
}
```

- [ ] **Step 2: Modify `MapView.jsx` to accept forced stops + colors**

In `public/src/components/MapView.jsx`, accept `forcedStops` and `forcedDepots` props that override the region-keyed lookup. When a stop has `color_hex`, use it for the marker fill instead of the default per-driver color. (Look up the existing marker-creation code; swap the fill color logic to prefer `stop.color_hex`.)

- [ ] **Step 3: Modify `StopCard.jsx`** if it's used elsewhere too — accept an optional `colorHex` prop and render an 8px left band when present. No-op for callers that don't pass it.

- [ ] **Step 4: Smoke**

1. With recipients backfilled to a delivery_date, open a bakery profile, click that date.
2. Routes tab loads. If there's a single solo-campaign route data row, it renders with one color throughout. Otherwise, multi-color bands.
3. Map shows colored pins matching the row colors.
4. Click "Re-optimize day" → routes re-fetch.
5. Click "Print all box labels" → preview window with labeled stops opens.
6. Click a campaign chip → list + map filter to just that campaign.

- [ ] **Step 5: Commit**

```bash
git add public/src/components/DayRoutesTab.jsx public/src/components/MapView.jsx public/src/components/StopCard.jsx
git commit -m "DayRoutesTab: merged per-driver routes with campaign color bands + box-label print"
```

---

## Task 11: Day Production + Photos tabs (date-scoped)

**Files:**
- Modify: `public/src/components/DayProductionTab.jsx`
- Modify: `public/src/components/DayPhotosTab.jsx`

- [ ] **Step 1: Replace `DayProductionTab.jsx` stub**

```jsx
// ===== DAY PRODUCTION TAB =====
// Recipient cards filtered by (bakery, date, optional campaign). Mirrors the
// existing plan-5 production tab but reads via DayView.loadDayRecipients.
function DayProductionTab({bakeryId, bakeryName, date, campaignFilter, campaigns}){
  const[items,setItems]=useState([]);
  const[loading,setLoading]=useState(false);

  useEffect(()=>{ if(date) load(); /* eslint-disable-next-line */ },[bakeryId, date, campaignFilter]);

  async function load(){
    setLoading(true);
    try {
      const rows = await DayView.loadDayRecipients(bakeryId, date, campaignFilter);
      setItems(rows.map(r => mergeRecipientDesign(r)));
    } finally { setLoading(false); }
  }

  function mergeRecipientDesign(r){
    // Use existing mergeDesign helper from Plan 5 — campaign default + recipient override.
    const def = r.campaigns?.default_design || {};
    const ov  = r.customizations?.design   || {};
    const merged = (typeof mergeDesign === 'function') ? mergeDesign(def, ov) : { cake_image_url: ov.cake_image_url || def.cake_image_url || null, card_message: ov.card_message || def.card_message || null };
    return { ...r, _merged: merged, _campaign_color: r.campaigns?.color_hex || '#7c3aed', _campaign_name: r.campaigns?.name };
  }

  if(loading) return <div style={{padding:40,color:'#9ca3af'}}>Loading…</div>;
  if(items.length===0) return <div style={{padding:40,color:'#9ca3af'}}>No recipients for this filter.</div>;

  return <div>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'14px 24px',background:'#fff',borderBottom:'1px solid #f3f4f6'}}>
      <div style={{fontSize:12,color:'#6b7280'}}><strong style={{color:'#111'}}>{items.length}</strong> recipients · <strong style={{color:'#111'}}>{items.filter(i=>!i._merged?.cake_image_url).length}</strong> missing image</div>
      <div style={{display:'flex',gap:8}}>
        <button onClick={()=>downloadEdiblePrintsZip(items)} style={btnGhost}>↓ Edible prints (.zip)</button>
        <button onClick={()=>printBoxCards(items)} style={btnPrimary}>🖨 Print box cards</button>
      </div>
    </div>

    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:14,padding:'20px 24px'}}>
      {items.map(it=>(
        <div key={it.id} style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:10,overflow:'hidden',display:'flex',flexDirection:'column'}}>
          <div style={{aspectRatio:'1/1',background:'#f3f4f6',display:'flex',alignItems:'center',justifyContent:'center',padding:24,position:'relative'}}>
            <span style={{position:'absolute',top:8,left:8,background:it._campaign_color,color:'#fff',fontSize:9,fontWeight:700,textTransform:'uppercase',padding:'3px 8px',borderRadius:999}}>{it._campaign_name}</span>
            {it._merged?.cake_image_url
              ? <img src={it._merged.cake_image_url} style={{width:'100%',height:'100%',borderRadius:'9999px',objectFit:'cover'}} alt=""/>
              : <span style={{fontSize:34,color:'#cbd5e1'}}>🖼</span>}
          </div>
          <div style={{padding:14,display:'flex',flexDirection:'column',gap:6,borderTop:'1px solid #f3f4f6'}}>
            <div style={{fontSize:14,fontWeight:600}}>{it.company}</div>
            <div style={{fontSize:11,color:'#9ca3af'}}>{[it.address, it.city].filter(Boolean).join(' · ')}</div>
            {it._merged?.card_message
              ? <div style={{fontSize:12,color:'#374151',fontStyle:'italic',background:'#f9fafb',borderLeft:'3px solid '+it._campaign_color,padding:'6px 8px',borderRadius:'0 4px 4px 0',marginTop:4}}>{it._merged.card_message}</div>
              : <div style={{fontSize:12,color:'#9ca3af',background:'#f9fafb',borderLeft:'3px solid #fecaca',padding:'6px 8px',borderRadius:'0 4px 4px 0',marginTop:4}}>No message yet</div>}
          </div>
        </div>
      ))}
    </div>
  </div>;
}

// Stubs that delegate to the plan-5 print pipeline if it exists in this repo.
function downloadEdiblePrintsZip(items){
  if (typeof window.downloadEdiblePrintsZip === 'function') return window.downloadEdiblePrintsZip(items);
  alert('Edible-print zip pipeline not wired in this repo yet.');
}
function printBoxCards(items){
  if (typeof window.printBoxCards === 'function') return window.printBoxCards(items);
  alert('Box-card print pipeline not wired in this repo yet.');
}
```

- [ ] **Step 2: Replace `DayPhotosTab.jsx` stub**

```jsx
// ===== DAY PHOTOS TAB =====
// Mirrors today's PhotosView but date-scoped via DayView.loadDayRecipients.
function DayPhotosTab({bakeryId, bakeryName, date, campaignFilter, campaigns}){
  const[items,setItems]=useState([]);
  const[loading,setLoading]=useState(false);

  useEffect(()=>{ if(date) load(); /* eslint-disable-next-line */ },[bakeryId, date, campaignFilter]);

  async function load(){
    setLoading(true);
    try {
      const recs = await DayView.loadDayRecipients(bakeryId, date, campaignFilter);
      const ids = recs.map(r => r.id);
      const { data } = await sb.from('delivery_statuses_v2').select('recipient_id, photo_url, delivered_at').in('recipient_id', ids);
      const map = new Map((data||[]).map(d => [d.recipient_id, d]));
      setItems(recs.map(r => ({ ...r, _status: map.get(r.id) || null })));
    } finally { setLoading(false); }
  }

  if(loading) return <div style={{padding:40,color:'#9ca3af'}}>Loading…</div>;
  const withPhotos = items.filter(i => i._status?.photo_url);

  return <div>
    <div style={{padding:'14px 24px',background:'#fff',borderBottom:'1px solid #f3f4f6',fontSize:12,color:'#6b7280'}}>
      <strong style={{color:'#111'}}>{withPhotos.length}</strong> / {items.length} delivered with photo
    </div>
    {withPhotos.length===0 && <div style={{padding:40,color:'#9ca3af'}}>No delivery photos yet.</div>}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:14,padding:'20px 24px'}}>
      {withPhotos.map(it=>(
        <div key={it.id} style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,overflow:'hidden'}}>
          <img src={it._status.photo_url} alt="" style={{width:'100%',aspectRatio:'1/1',objectFit:'cover'}}/>
          <div style={{padding:'8px 10px',fontSize:11}}>
            <div style={{fontWeight:600}}>{it.company}</div>
            <div style={{color:'#9ca3af',marginTop:2}}>{new Date(it._status.delivered_at).toLocaleString()}</div>
          </div>
        </div>
      ))}
    </div>
  </div>;
}
```

- [ ] **Step 3: Smoke**

1. Open a bakery's day view, click Production tab. Cards render with the campaign color band on the badge and message border. Filter chips work.
2. Photos tab shows the count line; if no photos yet, the empty state.

- [ ] **Step 4: Commit**

```bash
git add public/src/components/DayProductionTab.jsx public/src/components/DayPhotosTab.jsx
git commit -m "DayProductionTab + DayPhotosTab: date-scoped grids with campaign filter"
```

---

## Task 12: VRP wrapper — input swap to (bakery, delivery_date)

**Files:**
- Modify: `public/src/engine/rebalance.js`

The current `rebalance.js` builds the VRP input from `(campaign_id, bakery_id)`. We need a sibling function `rebalanceForDate(bakery_id, date)` that builds it from `(bakery_id, delivery_date)`, runs the same solver, and writes back to the per-area `routes` rows.

- [ ] **Step 1: Add `rebalanceForDate` to `rebalance.js`**

In `public/src/engine/rebalance.js`, alongside the existing region-keyed rebalance function, add:

```javascript
// Cross-campaign solve: input is every assigned recipient at this bakery on
// this delivery_date, regardless of campaign. Output stops carry campaign_id
// and color_hex so the day view can render colored bands.
window.rebalanceForDate = async function rebalanceForDate(bakery_id, date) {
  if (!sb) throw new Error('sb not ready');
  const [{ data: recs, error: rErr }, { data: areas, error: aErr }, { data: depots, error: dErr }, { data: bakery, error: bErr }] = await Promise.all([
    sb.from('recipients').select('id, company, address, city, zip, lat, lon, size, campaign_id, campaigns!inner(name, color_hex)')
      .eq('bakery_id', bakery_id).eq('delivery_date', date).eq('assignment_status','assigned').not('lat','is',null),
    sb.from('delivery_areas').select('id, geometry').eq('bakery_id', bakery_id),
    sb.from('depots').select('id, name, address, lat, lon').eq('bakery_id', bakery_id),
    sb.from('bakeries').select('id, name').eq('id', bakery_id).single(),
  ]);
  if (rErr) throw rErr; if (aErr) throw aErr; if (dErr) throw dErr; if (bErr) throw bErr;

  // For each area, filter the recipients whose lat/lon falls inside.
  const turf = window.turf;
  const perArea = {};
  for (const a of areas || []) {
    const poly = { type:'Feature', geometry:a.geometry, properties:{} };
    perArea[a.id] = (recs || []).filter(r => {
      const pt = { type:'Feature', geometry:{ type:'Point', coordinates:[r.lon, r.lat] }, properties:{} };
      try { return turf.booleanPointInPolygon(pt, poly); } catch { return false; }
    });
  }

  // Solve per area using the same engine as the legacy rebalance. Tag each
  // output stop with campaign metadata.
  for (const area of areas || []) {
    const stops = perArea[area.id];
    if (stops.length === 0) {
      await sb.from('routes').upsert({
        bakery_id, delivery_date: date, delivery_area_id: area.id,
        campaign_id: stops[0]?.campaign_id || (recs?.[0]?.campaign_id),  // satisfy NOT NULL until 011 drops it
        data: { ndays: 1, nd: 0, days: [{ routes: [] }], depots, bakery_name: bakery.name },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'bakery_id,delivery_date,delivery_area_id' });
      continue;
    }
    // Existing solver entry point — assumes a function buildRouteData(stops, depots, ndays, nd) exists.
    // ndays collapses to 1 (single date); nd defaults to a sensible per-area number, e.g. ceil(stops/12).
    const nd = Math.max(1, Math.ceil(stops.length / 12));
    const data = await window.buildRouteData({
      stops: stops.map(s => ({
        id: s.id, label: s.company, company: s.company,
        address: s.address, city: s.city, zip: s.zip,
        lat: s.lat, lon: s.lon, size: s.size,
        campaign_id: s.campaign_id, campaign_name: s.campaigns.name, color_hex: s.campaigns.color_hex,
      })),
      depots, ndays: 1, nd,
    });
    await sb.from('routes').upsert({
      bakery_id, delivery_date: date, delivery_area_id: area.id,
      campaign_id: stops[0].campaign_id,  // satisfy NOT NULL until 011 drops it
      data, updated_at: new Date().toISOString(),
    }, { onConflict: 'bakery_id,delivery_date,delivery_area_id' });
  }
};
```

If your repo's solver entry point isn't `window.buildRouteData`, find the equivalent in `rebalance.js` and adapt the call shape accordingly. The key contract: each output stop has `campaign_id` and `color_hex`.

- [ ] **Step 2: Smoke**

1. From DevTools after picking a bakery profile:

```javascript
const today = (await DayView.listDates(bakeryId))[0]?.date;
await rebalanceForDate(bakeryId, today);
const rs = await DayView.loadDayRoutes(bakeryId, today);
console.log(rs[0]?.data?.days?.[0]?.routes?.[0]?.stops?.[0]); // should include campaign_id + color_hex
```

2. Open Routes tab → driver split renders, color bands present, map pins colored.

- [ ] **Step 3: Commit**

```bash
git add public/src/engine/rebalance.js
git commit -m "rebalance.js: rebalanceForDate solves cross-campaign by (bakery, delivery_date)"
```

---

## Task 13: Migration 011 — drop `routes.campaign_id` + final smoke

**Files:**
- Create: `supabase/migrations/011_drop_routes_campaign_id.sql`

Once the day view + rebalance are off `campaign_id`, drop the column.

- [ ] **Step 1: Verify nothing reads `routes.campaign_id` anymore**

```bash
rg "routes.*campaign_id|campaign_id.*routes" public/src/ supabase/functions/ scripts/ -n
```

Expected: only the `campaign_id: stops[0].campaign_id` writes inside `rebalance.js` and the `book-campaign-slot` `commit` action. Both write the value (so the NOT NULL satisfies) but neither reads it. Removing the writes would also be required before the column drop.

Update both call sites to omit `campaign_id` from the upsert payload, then re-run rg to confirm zero references.

- [ ] **Step 2: Write migration 011**

```sql
-- 011_drop_routes_campaign_id.sql
-- Once the day view + rebalance no longer read or write routes.campaign_id,
-- drop the column. Idempotent.
alter table routes drop column if exists campaign_id;
```

- [ ] **Step 3: Apply via Supabase MCP `apply_migration`**

Name: `011_drop_routes_campaign_id`. Expected: success.

- [ ] **Step 4: Run the full smoke path**

1. Pick admin → set Boho Petite's capacity to medium=80, lead=3, sized=simple. Add an override `+50 medium on next Friday, reason "Test surge"`.
2. Pick a customer (Archy) → start a new campaign upload with a 30-row CSV mostly in Boho's area.
3. After ingest, advance to the new "Pick delivery date" step. Verify next 3 days are red, Sunday is red, the override-bumped Friday shows extra room.
4. Click a green date 5 days out → confirm and book. Step advances to finalize with the booked date.
5. Verify in DB: `select count(*) from recipients where campaign_id = '<id>' and delivery_date = '<date>'` returns 30.
6. Switch to Boho Petite's profile. Day strip shows the new date with "30 stops · 1 camp". Click into it.
7. Routes tab triggers re-solve, then shows N drivers with stops listed. Colors uniform (single campaign).
8. Click "Print all box labels" → preview window with 30 labels (3+ pages) opens.
9. Production tab → 30 cards filtered to this date. Photos tab → empty.
10. Now book a *second* campaign for the same date with a different customer, ~10 recipients in the same Boho area. Switch back to Boho's day view: the date shows "40 stops · 2 camp", filter chips show both campaigns, routes are merged with two-color bands, labels print mixed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/011_drop_routes_campaign_id.sql
git commit -m "Migration 011: drop routes.campaign_id (cross-campaign routing is canonical)"
```

---

## Notes

- **Plan 5 print pipeline** — the Production tab references `window.downloadEdiblePrintsZip` and `window.printBoxCards`. If plan 5 is not yet shipped in this branch, those buttons are no-ops and an alert fires; the rest of the flow still works. Wire them up when plan 5 lands.
- **Stripe** — deferred. The current `commit` action runs immediately after `hold` (see DeliveryDateStep.confirm). When Stripe is added, insert the payment intent step between `hold` and `commit` and pass `stripe_payment_intent_id` through.
- **Realtime** — `slot_holds` and `capacity_overrides` are added to `supabase_realtime` so concurrent admin edits in the Capacity panel propagate live. The day view subscribes only to `routes`; subscribing to `slot_holds`/`capacity_overrides` from the customer wizard would also be valuable but is left for a follow-up.
- **Color collisions** — `hashColor()` deterministic 8-color palette. Two campaigns hashing to the same color on the same date is rare. When detected at render time, deferred — left as a follow-up; v1 ships with hash-only.
