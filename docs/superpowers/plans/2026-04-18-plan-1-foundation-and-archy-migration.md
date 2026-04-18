# Plan 1 — Multi-Tenant Foundation + Archy Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `REGIONS` + `ROUTE_DATA` + `route_overrides` + `depot_overrides` with the multi-tenant schema from the spec, migrate the existing Archy campaign into it, and flip the existing Ops/Map/Customer views to read from the new schema. After this plan, the app behaves exactly as it does today, but is now backed by a multi-tenant data model ready for Plans 2–4.

**Architecture:** Add new Supabase tables alongside the old ones. Write a one-shot idempotent migration script that reads `public/data/routes.js` and populates the new tables. Introduce a tenant-aware supabase client wrapper and a new `DB2` facade that reads from the new schema. Flip the React components to use `DB2`. Enable RLS last (once data is in and the flip is verified). Old tables stay untouched on disk for 30 days as a rollback safety net.

**Tech Stack:** Supabase (Postgres + RLS), vanilla Node.js (Archy migration script, no build step), existing React + babel-standalone app, Node's built-in `node:test` runner for migration helpers.

**Spec reference:** `docs/superpowers/specs/2026-04-18-multi-tenant-delivery-platform-design.md`

**Out of scope for this plan (handled by subsequent plans):** Admin UI, delivery-area drawing, customer upload wizard, AI ingest edge function, bakery token views. This plan *only* lays the data foundation and flips existing read paths.

---

## File Structure

### Files created

- `supabase/migrations/001_multitenant_schema.sql` — full new-schema SQL, idempotent. Run via Supabase MCP or Dashboard SQL Editor.
- `supabase/migrations/002_multitenant_rls.sql` — RLS policies (run after data migration succeeds).
- `.env.example` — documents required env vars (checked into git).
- `.env` — actual values (gitignored, created by engineer).
- `.gitignore` (create or extend).
- `scripts/migrate-archy/migrate-archy.js` — migration runner (Node, uses `@supabase/supabase-js` + service role key).
- `scripts/migrate-archy/lib.js` — pure helpers (convex hull, token generator, row transformers) — the only thing unit-tested.
- `scripts/migrate-archy/lib.test.js` — Node-native `node:test` tests for `lib.js`.
- `scripts/migrate-archy/verify.js` — read-only queries that assert the migration produced the expected row counts and shapes.
- `scripts/migrate-archy/package.json` — pins `@supabase/supabase-js` and `dotenv`.
- `public/src/config/db2.js` — new tenant-aware client wrapper + new facade (reads from `recipients`, `routes`, `depots`, etc.).
- `public/src/utils/archy-adapter.js` — converts new-schema rows into the legacy shape the existing components expect (stops with `id`, `co`, `ad`, `ph`, `eta`, etc.). Same output shape as today's `ROUTE_DATA[region]`.

### Files modified

- `public/index.html` — load `db2.js` and `archy-adapter.js`; delete the `<script src="./data/routes.js">` line (last task).
- `public/src/components/App.jsx` — load routes via `DB2` + adapter instead of `ROUTE_DATA` + `DB`.
- `public/src/components/OpsView.jsx` — read depots from `DB2.loadDepotsForBakery()` instead of `depotOverrides`; save depot edits via `DB2.upsertDepot()`.
- `public/src/components/MapView.jsx` — same facade flip as OpsView for depot reads.
- `public/src/components/CustomerView.jsx` — same facade flip.
- `public/src/components/DepotManager.jsx` — accept a `bakeryId` prop; call `DB2.upsertDepot({bakeryId, ...})`.
- `public/src/constants.js` — derive `REGIONS` from DB-loaded bakeries at runtime instead of hardcoding. (Existing consumers reference `REGIONS[key].name`, `REGIONS[key].bakery`, `REGIONS[key].color` — the adapter preserves these keys so the components don't change.)
- `package.json` — add a `migrate` script entry that runs `node scripts/migrate-archy/migrate-archy.js`.

### Files deleted at end of plan

- `public/data/routes.js` — no longer loaded (last task, only after verified flip).

### Files unchanged

- All `public/src/engine/*` (VRP solver) — works on in-memory route shape, doesn't care about storage.
- All `public/src/map/*` — map layers work on route shape.
- `public/vrp/*` and `public/vrp-worker.js` — VRP solver.
- `supabase-schema.sql` (legacy) — left in place for reference. Old tables stay alive for 30 days.

---

## Sequencing (one task per section below)

1. New schema SQL (tables + indexes, no RLS yet).
2. Env + tenant-aware client wrapper.
3. Migration script helpers (pure, unit-tested).
4. Migration script runner (writes to Supabase).
5. Verification script.
6. New `DB2` facade.
7. Legacy-shape adapter.
8. Flip `App.jsx` + consuming components to `DB2` + adapter.
9. Depot edit write path (`DepotManager` → `depots` table).
10. Add RLS policies.
11. Delete `routes.js` + final cleanup.

---

## Task 1: Write new-schema SQL migration

**Files:**
- Create: `supabase/migrations/001_multitenant_schema.sql`

**Context:** Creates 9 new tables per the spec. Uses `CREATE TABLE IF NOT EXISTS` so it's safe to re-run. Does **not** enable RLS (that's Task 10, after data is in). Does **not** drop the existing `route_overrides` / `depot_overrides` / `delivery_statuses` tables — those stay alive as a rollback safety net.

Note: the new `delivery_statuses_v2` table uses `recipient_id` as PK. The legacy `delivery_statuses` table (text PK = stop ID) stays untouched and will be read+migrated by the script in Task 4.

- [ ] **Step 1: Create the SQL file**

Write the following into `supabase/migrations/001_multitenant_schema.sql`:

```sql
-- Plan 1 — multi-tenant foundation. Idempotent.
-- Safe to re-run. Enables pgcrypto for gen_random_uuid() on older Postgres.
create extension if not exists "pgcrypto";

-- 1. bakeries
create table if not exists bakeries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_email text,
  contact_phone text,
  access_token text unique not null,
  user_id uuid,
  created_at timestamptz not null default now()
);

-- 2. delivery_areas (GeoJSON Polygon or MultiPolygon stored as jsonb)
create table if not exists delivery_areas (
  id uuid primary key default gen_random_uuid(),
  bakery_id uuid not null references bakeries(id) on delete cascade,
  name text,
  geometry jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists delivery_areas_bakery_id_idx on delivery_areas(bakery_id);

-- 3. depots
create table if not exists depots (
  id uuid primary key default gen_random_uuid(),
  bakery_id uuid not null references bakeries(id) on delete cascade,
  name text not null,
  address text not null,
  lat double precision not null,
  lon double precision not null,
  created_at timestamptz not null default now()
);
create index if not exists depots_bakery_id_idx on depots(bakery_id);

-- 4. customers
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_email text,
  access_token text unique not null,
  user_id uuid,
  created_at timestamptz not null default now()
);

-- 5. campaigns
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft','assigning','active','complete')),
  created_at timestamptz not null default now()
);
create index if not exists campaigns_customer_id_idx on campaigns(customer_id);

-- 6. recipients
create table if not exists recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  bakery_id uuid references bakeries(id) on delete set null,
  company text not null,
  contact_name text,
  phone text,
  email text,
  address text not null,
  city text,
  state text,
  zip text,
  lat double precision,
  lon double precision,
  assignment_status text not null default 'needs_review'
    check (assignment_status in ('assigned','flagged_out_of_area','geocode_failed','needs_review')),
  legacy_id text,
  customizations jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists recipients_campaign_idx on recipients(campaign_id);
create index if not exists recipients_bakery_idx on recipients(bakery_id);
create unique index if not exists recipients_legacy_idx
  on recipients(campaign_id, legacy_id) where legacy_id is not null;

-- 7. geocode_cache
create table if not exists geocode_cache (
  normalized_address text primary key,
  lat double precision not null,
  lon double precision not null,
  display_name text,
  provider text not null,
  created_at timestamptz not null default now()
);

-- 8. routes (replaces route_overrides, keyed by campaign + bakery)
create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  bakery_id uuid not null references bakeries(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (campaign_id, bakery_id)
);

-- 9. delivery_statuses_v2 (FK to recipient; old delivery_statuses stays alive)
create table if not exists delivery_statuses_v2 (
  recipient_id uuid primary key references recipients(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','delivered','failed')),
  note text,
  photo_url text,
  delivered_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 10. app_settings — singleton, service-role only (RLS in 002)
create table if not exists app_settings (
  id int primary key default 1 check (id = 1),
  openai_api_key text,
  mapbox_api_key text,
  updated_at timestamptz not null default now()
);
insert into app_settings (id) values (1) on conflict do nothing;

-- Enable realtime for tables the browser subscribes to
alter publication supabase_realtime add table delivery_statuses_v2;
alter publication supabase_realtime add table routes;
alter publication supabase_realtime add table depots;
```

- [ ] **Step 2: Apply the migration**

Run via Supabase MCP (if configured), or paste the file contents into Supabase Dashboard → SQL Editor → Run.

Expected: all `create table` statements succeed, no errors.

- [ ] **Step 3: Verify table creation**

Run this check query in Supabase SQL Editor:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'bakeries','delivery_areas','depots','customers','campaigns',
    'recipients','geocode_cache','routes','delivery_statuses_v2','app_settings'
  )
order by table_name;
```

Expected: 10 rows returned (all table names).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/001_multitenant_schema.sql
git commit -m "add multi-tenant schema migration (tables only, no RLS)"
```

---

## Task 2: Env + tenant-aware supabase client wrapper

**Files:**
- Create: `.env.example`
- Create: `.env` (gitignored)
- Create or modify: `.gitignore`
- Modify: `public/src/config/supabase.js:1-7`

**Context:** Every tenant view will construct its own supabase client with an `x-tenant-token` header. We add a small factory so callers can get either the anon (unauthenticated/admin-token) client or a tenant client. Also set up `.env` for the migration script (Node-side only — browser still reads hardcoded public anon key for now).

- [ ] **Step 1: Create `.env.example`**

```bash
# Supabase — same values as public/src/config/supabase.js
SUPABASE_URL=https://vqmjevtthpedzdfotaie.supabase.co
SUPABASE_ANON_KEY=<paste-anon-key-here>

# Service role key — used only by migration scripts + edge functions.
# NEVER commit this value. Get it from Supabase Dashboard → Project Settings → API.
SUPABASE_SERVICE_ROLE_KEY=<paste-service-role-key-here>

# OpenAI — used by later plans (ingest edge function). Fine to leave blank for Plan 1.
OPENAI_API_KEY=

# Mapbox — used by later plans (geocoding). Fine to leave blank for Plan 1.
MAPBOX_API_KEY=
```

- [ ] **Step 2: Create `.env` with real values**

Copy `.env.example` to `.env` and paste your actual Supabase service role key. The URL and anon key are already in `public/src/config/supabase.js` line 3–4; copy those.

```bash
cp .env.example .env
# then open .env and fill in SUPABASE_SERVICE_ROLE_KEY
```

- [ ] **Step 3: Add `.env` to `.gitignore`**

Append (or create) `.gitignore`:

```gitignore
.env
.env.local
node_modules/
```

- [ ] **Step 4: Verify `.env` is ignored**

Run:

```bash
git check-ignore .env
```

Expected: prints `.env` and exits 0 (meaning it's ignored).

- [ ] **Step 5: Add tenant-client factory to `supabase.js`**

Modify `public/src/config/supabase.js` — replace lines 1–7 with:

```js
// ===== SUPABASE CONFIG =====
const SUPABASE_URL = window.__SUPABASE_URL__ || 'https://vqmjevtthpedzdfotaie.supabase.co';
const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__ || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxbWpldnR0aHBlZHpkZm90YWllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzODIwODcsImV4cCI6MjA5MTk1ODA4N30.mct_oZri4PLJVkrhZC3uzkq0qMYZExM7Y_30mQP30S8';

const _supabaseReady = SUPABASE_URL !== 'PLACEHOLDER_NOT_SET' && typeof supabase !== 'undefined';
const sb = _supabaseReady ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Build a tenant-scoped client that sends an x-tenant-token header on every request.
// RLS policies added in Task 10 check this header against bakeries.access_token /
// customers.access_token. Returns null if supabase-js didn't load.
function makeTenantClient(token) {
  if (!_supabaseReady || !token) return null;
  return supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { 'x-tenant-token': token } }
  });
}
window.makeTenantClient = makeTenantClient;
```

- [ ] **Step 6: Commit**

```bash
git add .gitignore .env.example public/src/config/supabase.js
git commit -m "add tenant-aware supabase client factory + env scaffolding"
```

---

## Task 3: Migration script — pure helpers + tests

**Files:**
- Create: `scripts/migrate-archy/lib.js`
- Create: `scripts/migrate-archy/lib.test.js`
- Create: `scripts/migrate-archy/package.json`

**Context:** Three pure helpers are easy to get wrong, so we TDD them first. They run in Node (no browser globals).

1. `normalizeAddress(addr)` — produces the cache key used throughout the system (lowercased, whitespace-collapsed, trimmed). Must match whatever the edge function uses later, so pin it now.
2. `convexHull(points)` — monotone-chain convex hull; used to build a starting delivery polygon for each region from its existing stops. Returns closed GeoJSON Polygon ring.
3. `generateToken(bytes=24)` — random URL-safe token for bakeries/customers. Node `crypto.randomBytes` + base64url.

- [ ] **Step 1: Create `scripts/migrate-archy/package.json`**

```json
{
  "name": "migrate-archy",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test lib.test.js",
    "migrate": "node migrate-archy.js",
    "verify": "node verify.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "dotenv": "^16.4.5"
  }
}
```

- [ ] **Step 2: Write failing tests** — `scripts/migrate-archy/lib.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAddress, convexHull, generateToken } from './lib.js';

test('normalizeAddress lowercases and collapses whitespace', () => {
  assert.equal(normalizeAddress('  390 Laurel   St #310 '), '390 laurel st #310');
});

test('normalizeAddress is idempotent', () => {
  const once = normalizeAddress('390 Laurel St #310');
  assert.equal(normalizeAddress(once), once);
});

test('normalizeAddress handles empty and nullish', () => {
  assert.equal(normalizeAddress(''), '');
  assert.equal(normalizeAddress(null), '');
  assert.equal(normalizeAddress(undefined), '');
});

test('convexHull of a square returns the 4 corners (closed ring)', () => {
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
    { lat: 0.5, lon: 0.5 } // interior point should be dropped
  ];
  const hull = convexHull(pts);
  // GeoJSON: first === last
  assert.equal(hull[0][0], hull[hull.length - 1][0]);
  assert.equal(hull[0][1], hull[hull.length - 1][1]);
  // 4 unique corners + closing point = 5
  assert.equal(hull.length, 5);
});

test('convexHull handles 3 collinear points gracefully', () => {
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 0, lon: 2 }
  ];
  const hull = convexHull(pts);
  // Degenerate — we still want something valid (at least a closed 2-vertex "polygon")
  assert.ok(hull.length >= 2);
  assert.deepEqual(hull[0], hull[hull.length - 1]);
});

test('generateToken returns 32+ char URL-safe string', () => {
  const t = generateToken();
  assert.ok(t.length >= 32);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test('generateToken is unique across calls', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd scripts/migrate-archy && npm install && npm test
```

Expected: all tests fail with `ERR_MODULE_NOT_FOUND` or similar (lib.js doesn't exist yet).

- [ ] **Step 4: Write `lib.js` to make tests pass**

```js
import { randomBytes } from 'node:crypto';

export function normalizeAddress(addr) {
  if (!addr) return '';
  return String(addr).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function generateToken(bytes = 24) {
  return randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Monotone-chain convex hull. Input: [{lat, lon}, …]. Output: GeoJSON-ring
// [[lon, lat], …] with first === last. Longitude is x, latitude is y.
export function convexHull(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  // Dedupe and sort by lon asc, lat asc
  const pts = Array.from(
    new Map(points.map(p => [`${p.lon},${p.lat}`, p])).values()
  ).sort((a, b) => a.lon - b.lon || a.lat - b.lat);

  if (pts.length === 1) {
    const p = [pts[0].lon, pts[0].lat];
    return [p, p];
  }

  const cross = (o, a, b) =>
    (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = lower.concat(upper).map(p => [p.lon, p.lat]);
  // Close the ring
  hull.push(hull[0]);
  return hull;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd scripts/migrate-archy && npm test
```

Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-archy/lib.js scripts/migrate-archy/lib.test.js scripts/migrate-archy/package.json
git commit -m "add migration helpers (normalize address, convex hull, token gen) with tests"
```

---

## Task 4: Migration script — runner

**Files:**
- Create: `scripts/migrate-archy/migrate-archy.js`

**Context:** Reads `public/data/routes.js` (evaluated into a local `ROUTE_DATA`), reads the existing `delivery_statuses`, `route_overrides`, and `depot_overrides` tables, then writes the new schema per the spec's "Migration of Existing Archy Campaign" section. Idempotent: re-runs replace the Archy customer/campaign rows only if they exist (uses `on conflict` or explicit lookups). Prints the generated Archy customer token + bakery tokens to stdout — admin copies them once.

The bakery → region mapping matches the existing `REGIONS` constant in `public/src/constants.js:2-8`.

- [ ] **Step 1: Create the runner**

```js
// scripts/migrate-archy/migrate-archy.js
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';
import { generateToken, convexHull, normalizeAddress } from './lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false }
});

// Region → bakery name (must match public/src/constants.js)
const REGION_BAKERY = {
  'SF': 'Boho Petite',
  'South Bay / Peninsula': 'Boho Petite',
  'LA': 'Sweet Lady Jane',
  'Orlando': 'SmallCakes',
  'Houston': "Roland's Swiss Pastries",
};

// Load ROUTE_DATA by evaluating public/data/routes.js in a sandbox
function loadRouteData() {
  const src = readFileSync(join(REPO_ROOT, 'public', 'data', 'routes.js'), 'utf8');
  const win = {};
  // routes.js assigns to window.ROUTE_DATA; we fake `window`
  new Function('window', src)(win);
  return win.ROUTE_DATA;
}

async function upsertByName(table, name, row) {
  // Idempotent: if a row with this name exists, return it; otherwise insert.
  const { data: existing } = await sb.from(table).select('*').eq('name', name).maybeSingle();
  if (existing) return existing;
  const { data, error } = await sb.from(table).insert(row).select('*').single();
  if (error) throw error;
  return data;
}

async function migrateBakeries() {
  const uniqueBakeries = [...new Set(Object.values(REGION_BAKERY))];
  const bakeries = {};
  for (const name of uniqueBakeries) {
    bakeries[name] = await upsertByName('bakeries', name, {
      name,
      access_token: generateToken(),
    });
  }
  return bakeries;
}

async function migrateCustomer() {
  return upsertByName('customers', 'Archy', {
    name: 'Archy',
    contact_email: 'contact@archy.com',
    access_token: generateToken(),
  });
}

async function migrateCampaign(customerId) {
  const name = 'Archy × Daymaker Q2 2026';
  const { data: existing } = await sb
    .from('campaigns')
    .select('*')
    .eq('customer_id', customerId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return existing;
  const { data, error } = await sb
    .from('campaigns')
    .insert({ customer_id: customerId, name, status: 'active' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function migrateDepots(routeData, bakeries) {
  // ROUTE_DATA[region].depots is an array of {name, addr, lat, lon}
  for (const [region, data] of Object.entries(routeData)) {
    const bakery = bakeries[REGION_BAKERY[region]];
    if (!bakery || !Array.isArray(data.depots)) continue;
    for (const d of data.depots) {
      const { data: existing } = await sb
        .from('depots')
        .select('id')
        .eq('bakery_id', bakery.id)
        .eq('name', d.name)
        .maybeSingle();
      if (existing) continue;
      const { error } = await sb.from('depots').insert({
        bakery_id: bakery.id,
        name: d.name,
        address: d.addr || '',
        lat: d.lat,
        lon: d.lon,
      });
      if (error) throw error;
    }
  }
}

async function migrateDeliveryAreas(routeData, bakeries) {
  // For each region, convex-hull its stops and insert one delivery_areas row
  // under the corresponding bakery. A bakery covering two regions gets two rows.
  for (const [region, data] of Object.entries(routeData)) {
    const bakery = bakeries[REGION_BAKERY[region]];
    if (!bakery) continue;
    const allStops = data.days.flatMap(d => d.routes.flatMap(r => r.stops));
    const points = allStops.map(s => ({ lat: s.lt, lon: s.ln }));
    const ring = convexHull(points);
    if (ring.length < 4) continue; // degenerate
    const geometry = {
      type: 'Polygon',
      coordinates: [ring],
    };
    const areaName = `${region} (migrated)`;
    const { data: existing } = await sb
      .from('delivery_areas')
      .select('id')
      .eq('bakery_id', bakery.id)
      .eq('name', areaName)
      .maybeSingle();
    if (existing) continue;
    const { error } = await sb.from('delivery_areas').insert({
      bakery_id: bakery.id,
      name: areaName,
      geometry,
    });
    if (error) throw error;
  }
}

async function migrateRecipients(routeData, campaign, bakeries) {
  // Walk every stop. Preserve old string ID in legacy_id.
  // Upsert on (campaign_id, legacy_id) via the unique index.
  const rows = [];
  for (const [region, data] of Object.entries(routeData)) {
    const bakery = bakeries[REGION_BAKERY[region]];
    if (!bakery) continue;
    for (const day of data.days) {
      for (const route of day.routes) {
        for (const s of route.stops) {
          rows.push({
            campaign_id: campaign.id,
            bakery_id: bakery.id,
            legacy_id: s.id,
            company: s.co || '',
            contact_name: s.cn || null,
            phone: s.ph || null,
            email: null,
            address: s.ad || '',
            city: s.ci || null,
            state: s.st || null,
            zip: s.zp || null,
            lat: s.lt,
            lon: s.ln,
            assignment_status: 'assigned',
          });
        }
      }
    }
  }
  // Insert in batches; skip duplicates on legacy_id unique index
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from('recipients')
      .upsert(batch, { onConflict: 'campaign_id,legacy_id', ignoreDuplicates: true });
    if (error) throw error;
    console.log(`  inserted recipients ${i + 1}–${i + batch.length}`);
  }
  return rows.length;
}

async function migrateDeliveryStatuses(campaign) {
  // Map old string PK on delivery_statuses → recipients.id via legacy_id.
  const { data: oldStatuses, error } = await sb.from('delivery_statuses').select('*');
  if (error) {
    console.warn('Skipping delivery_statuses migration (legacy table absent or inaccessible):', error.message);
    return 0;
  }
  if (!oldStatuses || !oldStatuses.length) return 0;

  // Batch-load recipient id lookups for this campaign's legacy_ids
  const { data: recips } = await sb
    .from('recipients')
    .select('id, legacy_id')
    .eq('campaign_id', campaign.id)
    .not('legacy_id', 'is', null);
  const lookup = new Map((recips || []).map(r => [r.legacy_id, r.id]));

  const toInsert = oldStatuses
    .filter(s => lookup.has(s.id))
    .map(s => ({
      recipient_id: lookup.get(s.id),
      status: s.status,
      note: s.note,
      photo_url: s.photo_url,
      delivered_at: s.delivered_at,
      updated_at: s.updated_at,
    }));

  if (!toInsert.length) return 0;
  const { error: ierr } = await sb
    .from('delivery_statuses_v2')
    .upsert(toInsert, { onConflict: 'recipient_id' });
  if (ierr) throw ierr;
  return toInsert.length;
}

async function migrateRouteOverrides(campaign, bakeries) {
  const { data: oldOverrides, error } = await sb.from('route_overrides').select('*');
  if (error) {
    console.warn('Skipping route_overrides migration (legacy table absent):', error.message);
    return 0;
  }
  if (!oldOverrides || !oldOverrides.length) return 0;

  let count = 0;
  for (const row of oldOverrides) {
    const bakery = bakeries[REGION_BAKERY[row.region]];
    if (!bakery) continue;
    const { error: uerr } = await sb.from('routes').upsert(
      { campaign_id: campaign.id, bakery_id: bakery.id, data: row.data },
      { onConflict: 'campaign_id,bakery_id' }
    );
    if (uerr) throw uerr;
    count++;
  }
  return count;
}

async function main() {
  console.log('Loading public/data/routes.js…');
  const routeData = loadRouteData();
  console.log(`  regions: ${Object.keys(routeData).join(', ')}`);

  console.log('Upserting bakeries…');
  const bakeries = await migrateBakeries();
  for (const [name, b] of Object.entries(bakeries)) {
    console.log(`  ${name}  token=${b.access_token}`);
  }

  console.log('Upserting customer Archy…');
  const customer = await migrateCustomer();
  console.log(`  Archy customer token=${customer.access_token}`);

  console.log('Upserting campaign…');
  const campaign = await migrateCampaign(customer.id);
  console.log(`  campaign_id=${campaign.id}`);

  console.log('Upserting depots…');
  await migrateDepots(routeData, bakeries);

  console.log('Upserting delivery_areas (convex hull per region)…');
  await migrateDeliveryAreas(routeData, bakeries);

  console.log('Upserting recipients…');
  const rc = await migrateRecipients(routeData, campaign, bakeries);
  console.log(`  ${rc} recipients upserted`);

  console.log('Migrating delivery_statuses → delivery_statuses_v2…');
  const sc = await migrateDeliveryStatuses(campaign);
  console.log(`  ${sc} statuses migrated`);

  console.log('Migrating route_overrides → routes…');
  const ro = await migrateRouteOverrides(campaign, bakeries);
  console.log(`  ${ro} route rows migrated`);

  console.log('\nDONE.');
  console.log('SAVE THESE TOKENS (they cannot be recovered from logs cleanly):');
  console.log(`  Archy customer: ${customer.access_token}`);
  for (const [name, b] of Object.entries(bakeries)) {
    console.log(`  Bakery "${name}": ${b.access_token}`);
  }
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the migration**

```bash
cd scripts/migrate-archy && npm run migrate
```

Expected output: prints bakery names + tokens, the Archy customer token, recipient count (should be 933 per the app header), status and route counts, then `DONE.`.

- [ ] **Step 3: Copy tokens to a safe place**

Paste the printed tokens into your password manager or a secure note. You'll need them once admin/customer/bakery views ship in later plans.

- [ ] **Step 4: Re-run to confirm idempotency**

```bash
cd scripts/migrate-archy && npm run migrate
```

Expected: no errors, recipient count stays the same (no duplicates), tokens printed from DB (same values as the first run — bakeries/customers are looked up by name, not recreated).

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-archy/migrate-archy.js
git commit -m "add Archy migration runner"
```

---

## Task 5: Verification script

**Files:**
- Create: `scripts/migrate-archy/verify.js`

**Context:** Quick read-only checks so we can confirm the migration produced sane results without clicking through the UI.

- [ ] **Step 1: Write the verifier**

```js
// scripts/migrate-archy/verify.js
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function count(table, filter = {}) {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { count: n, error } = await q;
  if (error) throw error;
  return n;
}

async function main() {
  const bakeries = await count('bakeries');
  const customers = await count('customers');
  const campaigns = await count('campaigns');
  const recipients = await count('recipients');
  const assigned = await count('recipients', { assignment_status: 'assigned' });
  const areas = await count('delivery_areas');
  const depots = await count('depots');
  const routes = await count('routes');

  console.log('Counts after migration:');
  console.log('  bakeries:       ', bakeries, '(expect 4: Boho Petite, Sweet Lady Jane, SmallCakes, Rolands)');
  console.log('  customers:      ', customers, '(expect >=1: Archy)');
  console.log('  campaigns:      ', campaigns, '(expect >=1)');
  console.log('  recipients:     ', recipients, '(expect ~933)');
  console.log('  assigned recips:', assigned, '(expect === recipients)');
  console.log('  delivery_areas: ', areas, '(expect 5: one per region)');
  console.log('  depots:         ', depots, '(expect sum of ROUTE_DATA[*].depots.length)');
  console.log('  routes:         ', routes, '(expect count of prior route_overrides rows)');

  // Spot-check: pick one recipient, make sure lat/lon and bakery_id populated
  const { data: sample } = await sb
    .from('recipients')
    .select('id, company, address, lat, lon, bakery_id, legacy_id')
    .limit(1)
    .single();
  console.log('\nSample recipient:', sample);
  if (!sample.bakery_id || !sample.lat || !sample.lon) {
    console.error('FAIL: sample recipient missing bakery_id or coordinates');
    process.exit(1);
  }

  console.log('\nOK.');
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run verification**

```bash
cd scripts/migrate-archy && npm run verify
```

Expected: 4 bakeries, ~933 recipients, assigned_count equals recipient count, sample recipient has `bakery_id` and `lat`/`lon` populated, prints `OK.`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-archy/verify.js
git commit -m "add migration verification script"
```

---

## Task 6: DB2 facade

**Files:**
- Create: `public/src/config/db2.js`

**Context:** A new facade exposing the reads the existing UI needs, backed by the new schema. Kept small and UI-agnostic — it's a thin wrapper around supabase-js. The legacy `DB` object stays intact until Task 11.

Read paths needed by the existing UI (extracted from `App.jsx`, `OpsView.jsx`, `CustomerView.jsx`):
- Load all bakeries (so we can build the region switcher).
- Load all depots for a bakery.
- Load all recipients for the Archy campaign, grouped by bakery (so we can build the legacy per-region `ROUTE_DATA` shape via the adapter in Task 7).
- Load routes for (campaign, bakery).
- Load statuses for the Archy campaign.
- Save/delete a status.
- Upsert a route.
- Upsert/delete a depot.
- Subscribe to status changes.

- [ ] **Step 1: Create `public/src/config/db2.js`**

```js
// ===== DB2 — reads/writes for the multi-tenant schema =====
// Uses the same `sb` client as DB. Later plans will switch to makeTenantClient(token)
// for bakery/customer views; for now Plan 1 runs against anon with RLS disabled.
const DB2 = {
  ready: !!sb,

  // Bootstrap: fetch the Archy campaign + its bakeries. Returns
  // { customer, campaign, bakeries: [{id, name}], error } — null on failure.
  async loadArchyContext() {
    if (!sb) return null;
    try {
      const { data: customer } = await sb.from('customers').select('*').eq('name', 'Archy').maybeSingle();
      if (!customer) return null;
      const { data: campaign } = await sb.from('campaigns')
        .select('*').eq('customer_id', customer.id).order('created_at').limit(1).maybeSingle();
      if (!campaign) return null;
      const { data: bakeries } = await sb.from('bakeries').select('*');
      return { customer, campaign, bakeries: bakeries || [] };
    } catch (e) { console.warn('DB2 loadArchyContext failed:', e); return null; }
  },

  async loadRecipients(campaignId) {
    if (!sb) return [];
    const { data, error } = await sb.from('recipients')
      .select('*').eq('campaign_id', campaignId);
    if (error) { console.warn('DB2 loadRecipients failed:', error); return []; }
    return data || [];
  },

  async loadDepots(bakeryId) {
    if (!sb) return [];
    const { data } = await sb.from('depots').select('*').eq('bakery_id', bakeryId);
    return data || [];
  },

  async loadAllDepots() {
    if (!sb) return {};
    const { data } = await sb.from('depots').select('*');
    const byBakery = {};
    (data || []).forEach(d => {
      (byBakery[d.bakery_id] = byBakery[d.bakery_id] || []).push(d);
    });
    return byBakery;
  },

  async loadRoutes(campaignId) {
    if (!sb) return [];
    const { data } = await sb.from('routes').select('*').eq('campaign_id', campaignId);
    return data || [];
  },

  async saveRoute(campaignId, bakeryId, routeData) {
    if (!sb) return;
    if (routeData === null) {
      await sb.from('routes').delete()
        .eq('campaign_id', campaignId).eq('bakery_id', bakeryId);
      return;
    }
    await sb.from('routes').upsert(
      { campaign_id: campaignId, bakery_id: bakeryId, data: routeData, updated_at: new Date().toISOString() },
      { onConflict: 'campaign_id,bakery_id' }
    );
  },

  async upsertDepot({ id, bakeryId, name, address, lat, lon }) {
    if (!sb) return null;
    const row = { bakery_id: bakeryId, name, address, lat, lon };
    if (id) {
      const { data } = await sb.from('depots').update(row).eq('id', id).select('*').single();
      return data;
    }
    const { data } = await sb.from('depots').insert(row).select('*').single();
    return data;
  },

  async deleteDepot(id) {
    if (!sb) return;
    await sb.from('depots').delete().eq('id', id);
  },

  // --- Statuses (v2) ---
  async loadStatuses(campaignId) {
    if (!sb) return {};
    // Join recipients in this campaign → delivery_statuses_v2
    const { data } = await sb
      .from('delivery_statuses_v2')
      .select('recipient_id, status, note, photo_url, delivered_at')
      .in('recipient_id',
        // subselect via a second query because supabase-js doesn't support
        // nested subqueries directly; acceptable for the Archy dataset size.
        (await sb.from('recipients').select('id').eq('campaign_id', campaignId))
          .data?.map(r => r.id) || []);
    const out = {};
    (data || []).forEach(row => {
      if (row.status !== 'pending') out[row.recipient_id] = row.status;
      if (row.note) out[row.recipient_id + '_note'] = row.note;
      if (row.photo_url) out[row.recipient_id + '_photo'] = row.photo_url;
      if (row.delivered_at) out[row.recipient_id + '_time'] =
        new Date(row.delivered_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    return out;
  },

  async saveStatus(recipientId, status, note, photoUrl) {
    if (!sb) return;
    await sb.from('delivery_statuses_v2').upsert({
      recipient_id: recipientId,
      status,
      note: note || null,
      photo_url: photoUrl || null,
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    });
  },

  async deleteStatus(recipientId) {
    if (!sb) return;
    await sb.from('delivery_statuses_v2').delete().eq('recipient_id', recipientId);
  },

  subscribeStatuses(campaignId, callback) {
    if (!sb) return () => {};
    const channel = sb.channel('statuses-v2-realtime')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_statuses_v2' },
        () => DB2.loadStatuses(campaignId).then(callback))
      .subscribe();
    return () => sb.removeChannel(channel);
  },

  // --- Photos (unchanged storage bucket) ---
  async uploadPhoto(recipientId, file) {
    if (!sb) return URL.createObjectURL(file);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${recipientId}_${Date.now()}.${ext}`;
      const { error } = await sb.storage.from('delivery-photos').upload(path, file, { upsert: true });
      if (error) throw error;
      const { data: urlData } = sb.storage.from('delivery-photos').getPublicUrl(path);
      return urlData.publicUrl;
    } catch (e) {
      console.warn('Photo upload failed, using local URL:', e);
      return URL.createObjectURL(file);
    }
  },

  async loadAllPhotos(campaignId) {
    if (!sb) return [];
    const { data: recips } = await sb.from('recipients').select('id, company, city').eq('campaign_id', campaignId);
    if (!recips?.length) return [];
    const ids = recips.map(r => r.id);
    const { data } = await sb
      .from('delivery_statuses_v2')
      .select('recipient_id, status, note, photo_url, delivered_at, updated_at')
      .not('photo_url', 'is', null)
      .in('recipient_id', ids);
    // Enrich with company/city for display
    const byId = new Map(recips.map(r => [r.id, r]));
    return (data || [])
      .map(row => ({ ...row, company: byId.get(row.recipient_id)?.company, city: byId.get(row.recipient_id)?.city }))
      .sort((a, b) => {
        const ta = new Date(a.delivered_at || a.updated_at || 0).getTime();
        const tb = new Date(b.delivered_at || b.updated_at || 0).getTime();
        return tb - ta;
      });
  },
};
window.DB2 = DB2;
```

- [ ] **Step 2: Load `db2.js` in `index.html`**

Modify `public/index.html` — between the existing `supabase.js` and `constants.js` script tags (around line 41–44), add:

```html
  <!-- Multi-tenant facade (new) -->
  <script src="./src/config/db2.js"></script>
```

So the section reads:

```html
  <!-- Persistence layer (Supabase client + DB facade) -->
  <script src="./src/config/supabase.js"></script>

  <!-- Multi-tenant facade (new) -->
  <script src="./src/config/db2.js"></script>

  <!-- Domain constants + pure utilities -->
  <script src="./src/constants.js"></script>
```

- [ ] **Step 3: Smoke-test in the browser**

Open the app. In DevTools console, run:

```js
await DB2.loadArchyContext()
```

Expected: returns `{ customer: {name: "Archy", …}, campaign: {…}, bakeries: [4 rows] }`.

Also try:

```js
const ctx = await DB2.loadArchyContext();
const recips = await DB2.loadRecipients(ctx.campaign.id);
recips.length // ~933
```

- [ ] **Step 4: Commit**

```bash
git add public/src/config/db2.js public/index.html
git commit -m "add DB2 facade for multi-tenant schema (reads only used by existing UI)"
```

---

## Task 7: Legacy-shape adapter

**Files:**
- Create: `public/src/utils/archy-adapter.js`

**Context:** The existing components (`OpsView`, `MapView`, `CustomerView`, `PhotosView`) read from the global `ROUTE_DATA[region]` with shape:

```js
{
  ts: number,                // total stops
  ndays: number,             // number of days
  nd: number,                // drivers per day
  depots: [{name, addr, lat, lon}],
  days: [{ day, nd, routes: [{drv, ns, tt, td, depot, stops: [{id, co, ci, …}]}] }]
}
```

and `statuses` as a flat `{ [stopId]: 'delivered' | 'failed', [stopId + '_note']: …, … }` map. Keys in the status map are currently *stop string IDs* (e.g. `SF_Blende_Dental_Group_46`). In the new schema, they need to be `recipient.id` (uuid).

The adapter:

1. Builds a synthetic `REGIONS`-shaped object from bakeries + their delivery_areas (one region per delivery_area, named from `delivery_areas.name`). This preserves the current "5 regions" UI.
2. Builds a `ROUTE_DATA`-shaped object per region by combining: (a) recipients assigned to the region's bakery and falling inside this region's polygon, (b) the region's `routes.data` override (if any — preserves user rebalances from the legacy migration), (c) the region's depots.
3. Builds a `statuses` object keyed by recipient id (new uuid) for UI consumption. We also expose a `legacyIdToRecipientId` map so any code currently hardcoded around legacy IDs can map forward (none of our UI code is — all stop lookups go through `s.id` which becomes the uuid).

Point-in-polygon is done client-side with a tiny inline ray-cast; adding Turf to the browser bundle for this is overkill.

- [ ] **Step 1: Create the adapter**

```js
// ===== ARCHY → legacy-shape adapter =====
// Converts the new-schema tables into the ROUTE_DATA / REGIONS shape that
// existing components expect, so OpsView/MapView/CustomerView don't need to
// change when we flip read paths.

(function () {
  // Tiny ray-cast point-in-polygon. Ring is [[lon, lat], …] closed.
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const intersect =
        (yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInGeometry(lon, lat, geom) {
    if (!geom) return false;
    if (geom.type === 'Polygon') {
      const [outer, ...holes] = geom.coordinates;
      if (!pointInRing(lon, lat, outer)) return false;
      return !holes.some(h => pointInRing(lon, lat, h));
    }
    if (geom.type === 'MultiPolygon') {
      return geom.coordinates.some(poly => {
        const [outer, ...holes] = poly;
        if (!pointInRing(lon, lat, outer)) return false;
        return !holes.some(h => pointInRing(lon, lat, h));
      });
    }
    return false;
  }

  // Recipients → legacy stops (same field names: id, co, ci, cn, ph, ad, zp,
  // lt, ln, st, bk, etc.). `s.id` is now a uuid; existing code passes it to
  // saveStatus/deleteStatus as-is which is what we want.
  function recipientToStop(r, bakeryName) {
    return {
      id: r.id,
      co: r.company,
      ci: r.city || '',
      st: r.state || '',
      cn: r.contact_name || '',
      ph: r.phone || '',
      ad: r.address,
      zp: r.zip || '',
      lt: r.lat,
      ln: r.lon,
      bk: bakeryName,
      eta: 0, // filled in after rebalance; 0 is what legacy data uses pre-rebalance
      dt: 0,
    };
  }

  // Colors: preserve the color-per-region feel. We hash the area name to a
  // stable color from the existing DRIVER_COLORS palette (defined in constants.js,
  // loaded before this file).
  function colorForArea(name) {
    const palette = (typeof DRIVER_COLORS !== 'undefined' && DRIVER_COLORS) || ['#2563eb'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }

  // Main entry point. Returns { REGIONS, ROUTE_DATA, legacyIdToRecipientId }.
  async function buildLegacyShape() {
    const ctx = await DB2.loadArchyContext();
    if (!ctx) return null;

    const [recipients, areasRes, routes, depotsByBakery] = await Promise.all([
      DB2.loadRecipients(ctx.campaign.id),
      sb.from('delivery_areas').select('*'),
      DB2.loadRoutes(ctx.campaign.id),
      DB2.loadAllDepots(),
    ]);
    const areas = areasRes.data || [];

    const bakeryById = new Map(ctx.bakeries.map(b => [b.id, b]));
    const REGIONS = {};
    const ROUTE_DATA = {};
    const legacyIdToRecipientId = {};

    // Each delivery_area becomes a "region" keyed by area.name.
    // Recipients assigned to the area's bakery AND inside the area polygon
    // are that region's stops.
    for (const area of areas) {
      const bakery = bakeryById.get(area.bakery_id);
      if (!bakery) continue;
      const key = area.name.replace(/ \(migrated\)$/, ''); // "SF (migrated)" → "SF"
      const matchingRecips = recipients.filter(r =>
        r.bakery_id === bakery.id &&
        Number.isFinite(r.lat) && Number.isFinite(r.lon) &&
        pointInGeometry(r.lon, r.lat, area.geometry)
      );
      if (!matchingRecips.length) continue;

      REGIONS[key] = {
        name: key,
        bakery: bakery.name,
        color: colorForArea(area.name),
        // Plan 2+ will add bakeryId/campaignId here; unused by Plan 1 UI.
        _bakeryId: bakery.id,
        _campaignId: ctx.campaign.id,
      };

      const depots = (depotsByBakery[bakery.id] || []).map(d => ({
        name: d.name, addr: d.address, lat: d.lat, lon: d.lon,
      }));

      // Start with a single "day 1" route containing all recipients.
      // If a saved override exists (matches this area's region key by convention),
      // prefer its data. Otherwise synthesize the minimal shape existing
      // components tolerate pre-rebalance.
      const savedRoute = routes.find(r =>
        r.bakery_id === bakery.id &&
        r.data && r.data._areaKey === key
      );

      if (savedRoute) {
        ROUTE_DATA[key] = savedRoute.data;
      } else {
        const stops = matchingRecips.map(r => {
          legacyIdToRecipientId[r.legacy_id] = r.id;
          return recipientToStop(r, bakery.name);
        });
        ROUTE_DATA[key] = {
          ts: stops.length,
          ndays: 1,
          nd: 1,
          depots,
          days: [{
            day: 1,
            nd: 1,
            routes: [{
              drv: 0,
              ns: stops.length,
              tt: 0,
              td: 0,
              depot: depots[0]?.name || '',
              stops,
            }],
            depots_active: depots.map(d => d.name),
          }],
          _areaKey: key,
          _bakeryId: bakery.id,
          _campaignId: ctx.campaign.id,
        };
      }
    }

    return { REGIONS, ROUTE_DATA, legacyIdToRecipientId, context: ctx };
  }

  window.ArchyAdapter = { buildLegacyShape };
})();
```

- [ ] **Step 2: Load the adapter in `index.html`**

Add this script line after `constants.js` (which it depends on for `DRIVER_COLORS`) and before the first component script:

```html
  <!-- Archy → legacy-shape adapter (bridges new schema to existing components) -->
  <script src="./src/utils/archy-adapter.js"></script>
```

Place between `./src/utils/osrm.js` and `./src/utils/geocode.js` load lines (order: after `constants.js`, before components).

- [ ] **Step 3: Smoke-test in the browser**

Reload the page, run in console:

```js
const shape = await ArchyAdapter.buildLegacyShape();
Object.keys(shape.REGIONS) // → ['SF', 'South Bay / Peninsula', 'LA', 'Orlando', 'Houston']
shape.ROUTE_DATA.SF.ts     // → number of SF recipients, close to legacy ROUTE_DATA.SF.ts
```

- [ ] **Step 4: Commit**

```bash
git add public/src/utils/archy-adapter.js public/index.html
git commit -m "add Archy adapter: new schema → legacy REGIONS/ROUTE_DATA shape"
```

---

## Task 8: Flip App.jsx to use adapter

**Files:**
- Modify: `public/src/components/App.jsx`
- Modify: `public/src/constants.js`

**Context:** Swap the data sources that feed `App.jsx`:
- Replace the compile-time `REGIONS` in `constants.js` with a `let REGIONS = {}` that the adapter populates at runtime.
- Replace the compile-time `ROUTE_DATA` (from `public/data/routes.js`) with the adapter's output.
- Use `DB2` for statuses/routes/depots instead of `DB`.

Existing in-component code that reads `ROUTE_DATA[key]` keeps working unchanged because we populate a `window.ROUTE_DATA` from the adapter before the first render.

- [ ] **Step 1: Make `REGIONS` mutable in `constants.js`**

Replace lines 1–10 of `public/src/constants.js` with:

```js
// ===== REGIONS & DRIVERS =====
// REGIONS is now populated at runtime by ArchyAdapter.buildLegacyShape().
// Plan 2 will replace the REGIONS concept entirely with a bakery/campaign picker,
// but Plan 1 preserves the legacy shape so existing components keep working.
window.REGIONS = {};
const DRIVER_NAMES=["Driver A","Driver B","Driver C","Driver D","Driver E","Driver F","Driver G","Driver H","Driver I","Driver J","Driver K","Driver L","Driver M","Driver N","Driver O"];
const DRIVER_COLORS=["#2563eb","#dc2626","#059669","#ea580c","#7c3aed","#0891b2","#db2777","#ca8a04","#4f46e5","#16a34a","#be123c","#0d9488","#9333ea","#b45309","#475569"];
```

(Note: `const REGIONS` becomes `window.REGIONS = {}` so the adapter can populate it without triggering a redeclaration error — existing code reads `REGIONS` which still resolves to the window property.)

- [ ] **Step 2: Flip `App.jsx` bootstrapping and DB calls**

Modify `public/src/components/App.jsx`. Replace the entire `App` function body with:

```jsx
function App(){
  const[view,setView]=useState('ops');
  const[region,setRegion]=useState(null);
  const[statuses,setStatuses]=useState({});
  const[routeOverrides,setRouteOverrides]=useState({});
  const[dbReady,setDbReady]=useState(false);
  const[syncing,setSyncing]=useState(true);
  const[bootErr,setBootErr]=useState('');
  const[archyCtx,setArchyCtx]=useState(null);

  // Bootstrap: load schema context, populate REGIONS + ROUTE_DATA, load statuses.
  useEffect(()=>{
    if(!DB2.ready){setBootErr('Supabase not configured.');setDbReady(true);setSyncing(false);return;}
    (async()=>{
      try{
        const shape=await ArchyAdapter.buildLegacyShape();
        if(!shape){setBootErr('Archy migration has not run. Run scripts/migrate-archy first.');setDbReady(true);setSyncing(false);return;}
        window.REGIONS=shape.REGIONS;
        window.ROUTE_DATA=shape.ROUTE_DATA;
        setArchyCtx(shape.context);
        // Seed first selectable region
        const firstKey=Object.keys(shape.REGIONS)[0];
        if(firstKey)setRegion(firstKey);
        // Existing saved routes are already inside shape.ROUTE_DATA; convert to
        // routeOverrides map so components detect "modified" state as before.
        const rovrs={};
        for(const[k,data]of Object.entries(shape.ROUTE_DATA)){
          if(data.rebalanced||data.modified)rovrs[k]=data;
        }
        setRouteOverrides(rovrs);
        // Statuses
        const s=await DB2.loadStatuses(shape.context.campaign.id);
        setStatuses(s);
        setDbReady(true);setSyncing(false);
      }catch(e){
        console.error('Boot failed:',e);
        setBootErr('Failed to load data. See console.');setDbReady(true);setSyncing(false);
      }
    })();

    // Subscribe to realtime status changes scoped to the Archy campaign
    let unsub=()=>{};
    DB2.loadArchyContext().then(ctx=>{
      if(!ctx)return;
      unsub=DB2.subscribeStatuses(ctx.campaign.id,newStatuses=>setStatuses(newStatuses));
    });
    return()=>unsub();
  },[]);

  const onDepotsChange=useCallback(async(regionKey,newDepots)=>{
    const r=window.REGIONS[regionKey];
    if(!r||!r._bakeryId)return;
    // Full replacement: delete current + insert new. Simple, no-op if unchanged.
    const current=await DB2.loadDepots(r._bakeryId);
    for(const d of current)await DB2.deleteDepot(d.id);
    for(const d of newDepots){
      await DB2.upsertDepot({bakeryId:r._bakeryId,name:d.name,address:d.addr||d.address||'',lat:d.lat,lon:d.lon});
    }
    // Refresh window.ROUTE_DATA so map markers update
    const shape=await ArchyAdapter.buildLegacyShape();
    if(shape){window.REGIONS=shape.REGIONS;window.ROUTE_DATA=shape.ROUTE_DATA;}
  },[]);

  const onRebalance=useCallback((regionKey,newData)=>{
    setRouteOverrides(prev=>{
      const next={...prev};
      if(newData===null){delete next[regionKey];}
      else{next[regionKey]={...newData,_areaKey:regionKey};}
      return next;
    });
    const r=window.REGIONS[regionKey];
    if(r&&r._bakeryId&&archyCtx){
      DB2.saveRoute(archyCtx.campaign.id,r._bakeryId,newData?{...newData,_areaKey:regionKey}:null);
    }
  },[archyCtx]);

  const getRouteData=useCallback((key)=>routeOverrides[key]||window.ROUTE_DATA?.[key],[routeOverrides]);

  const onAction=useCallback((id,action,note)=>{
    setStatuses(prev=>{
      const next={...prev};
      if(action==='delivered'){
        next[id]='delivered';
        next[id+'_time']=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        DB2.saveStatus(id,'delivered',null,next[id+'_photo']||null);
      }else if(action==='failed'){
        next[id]='failed';
        if(note)next[id+'_note']=note;
        DB2.saveStatus(id,'failed',note,null);
      }else if(action==='pending'){
        delete next[id];
        delete next[id+'_time'];
        delete next[id+'_note'];
        delete next[id+'_photo'];
        DB2.deleteStatus(id);
      }
      return next;
    });
  },[]);

  const onPhotoUpload=useCallback((stopId,photoUrl)=>{
    setStatuses(prev=>{
      const next={...prev,[stopId+'_photo']:photoUrl};
      if(next[stopId]==='delivered')DB2.saveStatus(stopId,'delivered',null,photoUrl);
      return next;
    });
  },[]);

  const handlePrint=()=>{
    if(!region)return;
    const data=getRouteData(region);
    if(!data)return;
    let html='<html><head><style>*{font-family:DM Sans,sans-serif}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:4px;text-align:left}th{border-bottom:1px solid #333}tr{border-bottom:1px solid #eee}.driver{page-break-inside:avoid;margin-bottom:24px}</style></head><body>';
    html+=`<h1>${window.REGIONS[region].bakery} — ${window.REGIONS[region].name}</h1>`;
    data.days.forEach((dd,di)=>{
      html+=`<h2>Day ${di+1}</h2>`;
      dd.routes.forEach(r=>{
        if(!r.ns)return;
        html+=`<div class="driver"><h3>${DRIVER_NAMES[r.drv]} — ${r.ns} stops — ${fmtDuration(r.tt)}</h3>`;
        html+='<table><tr><th>#</th><th>ETA</th><th>Practice</th><th>Address</th><th>Contact</th><th>Phone</th><th>✓</th></tr>';
        r.stops.forEach((s,i)=>{
          html+=`<tr><td>${i+1}</td><td>${fmtTime(s.eta)}</td><td><b>${s.co}</b></td><td>${s.ad}, ${s.ci}</td><td>${s.cn}</td><td>${s.ph}</td><td>☐</td></tr>`;
        });
        html+='</table></div>';
      });
    });
    html+='</body></html>';
    const win=window.open('','_blank');
    win.document.write(html);
    win.document.close();
    setTimeout(()=>win.print(),500);
  };

  const regionEntries=Object.entries(window.REGIONS||{});
  const depotOverrides={}; // legacy prop no longer used (DB2.loadDepots is authoritative); empty keeps OpsView happy

  return <div className={`app-shell${view==='ops'||view==='map'?' wide':''}`}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}} className="no-print">
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>Archy × Daymaker</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}>933 deliveries · {regionEntries.length} regions · OR-Tools optimized
          {DB2.ready&&<span style={{marginLeft:6,color:'#16a34a'}}>● Live</span>}
          {!DB2.ready&&<span style={{marginLeft:6,color:'#f59e0b'}}>○ Offline</span>}
          {syncing&&<span style={{marginLeft:6,color:'#2563eb'}}>↻ Syncing...</span>}
        </span>
      </div>
      {view==='ops'&&region&&<button onClick={handlePrint}
        style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:8,padding:'8px 14px',fontSize:13,cursor:'pointer',fontWeight:500}}>
        🖨 Print routes
      </button>}
    </div>

    {bootErr&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:8,marginBottom:12,fontSize:13}}>{bootErr}</div>}

    <div style={{display:'flex',gap:0,marginBottom:20,borderBottom:'1px solid #e2e8f0'}} className="no-print">
      {[{k:'ops',l:'Operations'},{k:'map',l:'🧁 Map'},{k:'customer',l:'Campaign'},{k:'photos',l:'Photos'}].map(t=>
        <button key={t.k} className={`view-tab ${view===t.k?'active':''}`} onClick={()=>setView(t.k)}>
          {t.l}
        </button>
      )}
    </div>

    {(view==='ops'||view==='map')&&<div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap'}} className="no-print">
      {regionEntries.map(([k,c])=>{
        const d=getRouteData(k);
        return <button key={k} onClick={()=>setRegion(k)} style={{
          padding:'6px 14px',borderRadius:8,
          border:region===k?`2px solid ${c.color}`:'1px solid #e2e8f0',
          background:region===k?`${c.color}10`:'white',
          color:region===k?c.color:'#64748b',
          cursor:'pointer',fontSize:13,fontWeight:500
        }}>{c.name} ({d?d.ts:0})</button>;
      })}
    </div>}

    {region&&view==='ops'&&<OpsView regionKey={region} statuses={statuses} onAction={onAction} onPhotoUpload={onPhotoUpload} routeOverrides={routeOverrides} onRebalance={onRebalance} depotOverrides={depotOverrides} onDepotsChange={onDepotsChange}/>}
    {region&&view==='map'&&<MapView regionKey={region} statuses={statuses} routeOverrides={routeOverrides} depotOverrides={depotOverrides}/>}
    {view==='customer'&&<CustomerView statuses={statuses} routeOverrides={routeOverrides}/>}
    {view==='photos'&&<PhotosView routeOverrides={routeOverrides}/>}
  </div>;
}
```

Key differences from the original:
- `DB` → `DB2` everywhere.
- `ROUTE_DATA` → `window.ROUTE_DATA` (populated by adapter).
- `REGIONS` → `window.REGIONS` (populated by adapter).
- Stop IDs passed to `onAction` / `onPhotoUpload` are now recipient uuids; the DB2 methods accept them unchanged.
- `depotOverrides` prop passes through empty — `OpsView` continues to receive it (for backcompat), but `DepotManager` will read/write via DB2 directly in Task 9.
- Print handler reads `window.REGIONS` for bakery/name.

- [ ] **Step 3: Smoke test in the browser**

Reload the app. Expected:
- Header shows `● Live` and stops syncing within ~1s.
- Region tabs appear (SF, South Bay / Peninsula, LA, Orlando, Houston) with stop counts matching legacy numbers.
- OpsView loads with the first region selected.
- Clicking through days/drivers renders stops (identical content to before).
- Marking a delivery as delivered persists and survives a page reload.

If stop counts don't match, run `await DB2.loadRecipients(ctx.campaign.id)` in the console and compare to `ROUTE_DATA.SF.ts` from the legacy data.

- [ ] **Step 4: Commit**

```bash
git add public/src/components/App.jsx public/src/constants.js
git commit -m "flip App.jsx to read via DB2 + Archy adapter"
```

---

## Task 9: Flip depot edit path

**Files:**
- Modify: `public/src/components/DepotManager.jsx`
- Modify: `public/src/components/OpsView.jsx:8-8` and `public/src/components/OpsView.jsx:122-122`

**Context:** Depot edits currently write to `depotOverrides` state + `depot_overrides` table (legacy). Flip them to the `depots` table via `DB2`. Adds a `bakeryId` prop to `DepotManager` and `OpsView` passes it in.

- [ ] **Step 1: Update `DepotManager.jsx`**

Replace the entire `DepotManager` function with:

```jsx
function DepotManager({regionKey,bakeryId,depots,onDepotsChange}){
  const[editing,setEditing]=useState(null);
  const[editName,setEditName]=useState('');
  const[editAddr,setEditAddr]=useState('');
  const[geocoding,setGeocoding]=useState(false);
  const[geoError,setGeoError]=useState('');

  const startEdit=(i)=>{
    setEditing(i);
    setEditName(depots[i].name);
    setEditAddr(depots[i].addr||depots[i].address||'');
    setGeoError('');
  };
  const startAdd=()=>{
    setEditing('new');setEditName('');setEditAddr('');setGeoError('');
  };
  const cancel=()=>{setEditing(null);setGeoError('');};

  const save=async()=>{
    if(!editName.trim()||!editAddr.trim())return;
    setGeocoding(true);setGeoError('');
    const geo=await geocodeAddress(editAddr.trim());
    setGeocoding(false);
    if(!geo){setGeoError('Could not geocode address. Check the address and try again.');return;}

    const row={name:editName.trim(),addr:editAddr.trim(),lat:geo.lat,lon:geo.lon};
    if(editing==='new'){
      await DB2.upsertDepot({bakeryId,name:row.name,address:row.addr,lat:row.lat,lon:row.lon});
    }else{
      const existing=depots[editing];
      await DB2.upsertDepot({id:existing.id,bakeryId,name:row.name,address:row.addr,lat:row.lat,lon:row.lon});
    }
    // Re-fetch + tell parent
    const fresh=await DB2.loadDepots(bakeryId);
    const display=fresh.map(d=>({id:d.id,name:d.name,addr:d.address,lat:d.lat,lon:d.lon}));
    onDepotsChange(regionKey,display);
    setEditing(null);
  };

  const remove=async(i)=>{
    if(depots.length<=1){alert('Must have at least one location.');return;}
    if(!confirm(`Remove "${depots[i].name}"? Routes will need rebalancing.`))return;
    if(depots[i].id)await DB2.deleteDepot(depots[i].id);
    const fresh=await DB2.loadDepots(bakeryId);
    const display=fresh.map(d=>({id:d.id,name:d.name,addr:d.address,lat:d.lat,lon:d.lon}));
    onDepotsChange(regionKey,display);
  };

  return <div style={{marginTop:12,paddingTop:10,borderTop:'1px solid #f1f5f9'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
      <div style={{fontSize:12,color:'#94a3b8',fontWeight:600}}>Bakery locations</div>
      {editing===null&&<button onClick={startAdd}
        style={{fontSize:11,color:'#2563eb',background:'#eff6ff',border:'none',borderRadius:5,padding:'3px 10px',cursor:'pointer',fontWeight:500}}>
        + Add location
      </button>}
    </div>

    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
      {depots.map((dep,i)=>
        editing===i?null:
        <div key={dep.id||i} style={{fontSize:12,color:'#475569',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:6,padding:'4px 10px',display:'flex',alignItems:'center',gap:6}}>
          <span>{dep.name}</span>
          <span style={{color:'#94a3b8',fontSize:11}}>{(dep.addr||dep.address||'').split(',')[0]}</span>
          <button onClick={()=>startEdit(i)} style={{background:'none',border:'none',color:'#2563eb',cursor:'pointer',fontSize:11,padding:0}}>edit</button>
          {depots.length>1&&<button onClick={()=>remove(i)} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontSize:11,padding:0}}>×</button>}
        </div>
      )}
    </div>

    {editing!==null&&<div style={{marginTop:8,padding:12,background:'#f8fafc',borderRadius:8,border:'1px solid #e2e8f0'}}>
      <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:'#0f172a'}}>{editing==='new'?'Add location':'Edit location'}</div>
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        <div>
          <label style={{fontSize:11,color:'#64748b',display:'block',marginBottom:2}}>Name</label>
          <input value={editName} onChange={e=>setEditName(e.target.value)} placeholder="e.g. SmallCakes - Lake Mary"
            style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #e2e8f0',fontSize:13,boxSizing:'border-box'}}/>
        </div>
        <div>
          <label style={{fontSize:11,color:'#64748b',display:'block',marginBottom:2}}>Full address</label>
          <input value={editAddr} onChange={e=>setEditAddr(e.target.value)} placeholder="e.g. 4300 W Lake Mary Blvd, Lake Mary, FL 32746"
            style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #e2e8f0',fontSize:13,boxSizing:'border-box'}}/>
        </div>
        {geoError&&<div style={{fontSize:11,color:'#dc2626'}}>{geoError}</div>}
        <div style={{display:'flex',gap:6}}>
          <button onClick={save} disabled={geocoding||!editName.trim()||!editAddr.trim()}
            style={{background:geocoding?'#94a3b8':'#1e293b',color:'white',border:'none',borderRadius:6,padding:'6px 14px',fontSize:12,cursor:geocoding?'wait':'pointer',fontWeight:600}}>
            {geocoding?'Geocoding...':'Save'}
          </button>
          <button onClick={cancel}
            style={{background:'#f1f5f9',color:'#64748b',border:'none',borderRadius:6,padding:'6px 14px',fontSize:12,cursor:'pointer',fontWeight:500}}>
            Cancel
          </button>
        </div>
      </div>
    </div>}
  </div>;
}
```

- [ ] **Step 2: Pass `bakeryId` from `OpsView` to `DepotManager`**

Modify `public/src/components/OpsView.jsx`:

- At line 8 (`const effectiveDepots=...`), change to:

```jsx
const bakeryId=REGIONS[regionKey]?._bakeryId||null;
const effectiveDepots=depotOverrides[regionKey]||data.depots||[];
```

- At line 122 (`<DepotManager regionKey={regionKey} depots={effectiveDepots} onDepotsChange={onDepotsChange}/>`), change to:

```jsx
<DepotManager regionKey={regionKey} bakeryId={bakeryId} depots={effectiveDepots} onDepotsChange={onDepotsChange}/>
```

- [ ] **Step 3: Smoke test**

In the app:
1. Navigate to OpsView for SF.
2. Click the "edit" link on an existing depot, change its name, click Save.
3. Reload the page.
4. Expected: the edit persists.
5. Add a new depot with a real address. Expected: it appears.
6. Remove the newly-added depot. Expected: gone after reload.

- [ ] **Step 4: Commit**

```bash
git add public/src/components/DepotManager.jsx public/src/components/OpsView.jsx
git commit -m "flip depot edit path to DB2.depots"
```

---

## Task 10: Enable RLS

**Files:**
- Create: `supabase/migrations/002_multitenant_rls.sql`

**Context:** We add RLS policies now that data is in place and the read paths work with the anon key. Since Plan 1 continues to run all UI code against the anon key (no tenant tokens yet), we add **permissive** policies for Plan 1 that let the anon role read/write freely — matching the current zero-auth behavior — but structured so Plan 2+ can swap them for token-checked policies without a data migration.

Specifically: we define the tables with RLS enabled + an `anon_all` policy. Later plans will replace `anon_all` with `tenant_scoped` policies on a per-table basis.

- [ ] **Step 1: Write the RLS migration**

Create `supabase/migrations/002_multitenant_rls.sql`:

```sql
-- Plan 1 — enable RLS with permissive "anon can everything" policies.
-- Plan 2+ will replace the anon policies with token-scoped ones per table.

alter table bakeries          enable row level security;
alter table delivery_areas    enable row level security;
alter table depots            enable row level security;
alter table customers         enable row level security;
alter table campaigns         enable row level security;
alter table recipients        enable row level security;
alter table geocode_cache     enable row level security;
alter table routes            enable row level security;
alter table delivery_statuses_v2 enable row level security;
alter table app_settings      enable row level security;

-- Permissive policies (Plan 1 parity with current anon-everything behavior).
-- Named with a "plan1_" prefix so Plan 2 can DROP them cleanly.
create policy plan1_bakeries_all          on bakeries          for all using (true) with check (true);
create policy plan1_delivery_areas_all    on delivery_areas    for all using (true) with check (true);
create policy plan1_depots_all            on depots            for all using (true) with check (true);
create policy plan1_customers_all         on customers         for all using (true) with check (true);
create policy plan1_campaigns_all         on campaigns         for all using (true) with check (true);
create policy plan1_recipients_all        on recipients        for all using (true) with check (true);
create policy plan1_geocode_cache_all     on geocode_cache     for all using (true) with check (true);
create policy plan1_routes_all            on routes            for all using (true) with check (true);
create policy plan1_delivery_statuses_v2_all on delivery_statuses_v2 for all using (true) with check (true);

-- app_settings is the one exception: NO anon access at all. Service role only.
-- Admin UI in Plan 2 will read/write via an edge function.
create policy plan1_app_settings_deny_all on app_settings for all using (false) with check (false);
```

- [ ] **Step 2: Apply the RLS migration**

Run via Supabase MCP or Dashboard SQL Editor.

- [ ] **Step 3: Verify the app still works**

Reload the browser app. Everything should behave identically to Task 8 — regions load, stops appear, statuses persist. The policies are effectively no-ops for anon requests.

- [ ] **Step 4: Verify app_settings is locked**

In the browser console:

```js
const { data, error } = await sb.from('app_settings').select('*');
data // → [] (RLS blocks the read; no error, just no rows)
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/002_multitenant_rls.sql
git commit -m "enable RLS with permissive anon policies (Plan 1 parity)"
```

---

## Task 11: Retire `public/data/routes.js`

**Files:**
- Modify: `public/index.html:38`
- Delete: `public/data/routes.js` (only after all prior tasks verified)

**Context:** The adapter now populates `window.ROUTE_DATA` from the DB; the embedded dataset is no longer needed. We delete it last so any issue discovered during Tasks 8–10 has a trivial rollback (just re-add the `<script src="./data/routes.js">` line and the app falls back to the static data).

- [ ] **Step 1: Remove the script tag**

In `public/index.html`, delete line 38:

```html
  <!-- Embedded route dataset (populates window.ROUTE_DATA) -->
  <script src="./data/routes.js"></script>
```

Both the comment and the script line.

- [ ] **Step 2: Reload and verify**

Hard-reload the browser. Expected: regions, stops, and statuses load exactly as before. The "933 deliveries" header still says 933.

If anything breaks, restore the script tag (one-line revert) and report what broke before continuing.

- [ ] **Step 3: Delete the file**

Once Step 2 passes:

```bash
git rm public/data/routes.js
```

- [ ] **Step 4: Final smoke test**

Full pass through the existing UI:
- All 5 region tabs show correct stop counts.
- OpsView: rebalance a region with a small change (e.g., drop drivers to 2); verify the rebalanced routes persist across reload.
- OpsView: mark one stop delivered, mark one failed with a note. Reload. Both persist.
- MapView: map renders with depots and stop markers.
- CustomerView: progress stats look right.
- PhotosView: any existing photos still render (they live in Supabase Storage, unchanged).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "retire public/data/routes.js (runtime now reads from Supabase)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Plan coverage |
|---|---|
| Data model — all 10 tables | Task 1 (schema) + Task 10 (RLS) |
| RLS via header token | Task 2 scaffolds `makeTenantClient`; Task 10 enables RLS with Plan 2-compatible structure |
| Edge functions | Deferred to Plans 2–4 (called out in Out-of-Scope) |
| UI split (admin/customer/bakery/landing) | Deferred to Plan 2 |
| Ingest pipeline | Deferred to Plan 3 |
| Admin Settings panel | Deferred to Plan 2 |
| Archy migration | Tasks 3–5 |
| Legacy tables retained 30 days | Task 10 leaves old tables alive; cleanup in a follow-up plan |
| Forward-compat `customizations jsonb` | Task 1 schema |
| `geocode_cache` | Task 1 schema (table ready; first writes happen in Plan 3 ingest) |

**Placeholder scan:** No TBD/TODO. All code blocks contain complete code, all commands contain expected output.

**Type consistency:**
- `DB2.upsertDepot({bakeryId, name, address, lat, lon, id?})` — same signature in Task 6 and Task 9. ✓
- `window.REGIONS[key]._bakeryId` / `_campaignId` — defined in Task 7 adapter, used in Task 8 App.jsx and Task 9 OpsView. ✓
- `makeTenantClient(token)` — defined Task 2, not used in Plan 1 but referenced by Plan 2. ✓
- `ArchyAdapter.buildLegacyShape()` — defined Task 7, called once in Task 8. ✓

All three checks pass.

---

## Next plans (not part of Plan 1)

- **Plan 2 — Admin + bakery onboarding:** `AdminView`, `DeliveryAreaDraw`, `create-bakery` edge function, settings panel (OpenAI + Mapbox keys), bakery token URL routing.
- **Plan 3 — Customer upload + AI ingest:** `CustomerHomeView`, `IngestWizard`, `ingest-recipients` edge function (parse → AI column map → AI row normalize → geocode → area match).
- **Plan 4 — Bakery token view + rematch:** `BakeryHomeView`, scope `OpsView` to `(campaign, bakery)` via tenant client, `rematch-recipients` edge function, polygon-edit trigger. At the end of Plan 4, drop `plan1_*_all` policies and replace with token-scoped policies; drop legacy `route_overrides` / `depot_overrides` / `delivery_statuses` tables.
