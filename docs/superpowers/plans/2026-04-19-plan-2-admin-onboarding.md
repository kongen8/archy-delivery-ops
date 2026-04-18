# Plan 2 — Admin + Bakery Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an admin UI that creates and edits bakeries (with polygon service areas and depots) and customers, plus profile-picker routing — while temporarily relaxing RLS so any visitor can pick any profile.

**Architecture:** Keep the static + babel-standalone browser app. Replace the token gate (`tenant.js`) with a profile picker (`profile.js`) and a hash router. Add a direct-from-browser `admin.js` data-access module (permissive RLS makes this safe for a wide-open single-deployment). Bakery editor uses the existing MapLibre instance plus `@mapbox/mapbox-gl-draw` via CDN. No new edge functions.

**Tech Stack:** React 18 (babel-standalone, JSX compiled in-browser), MapLibre GL JS 5.x, `@mapbox/mapbox-gl-draw` 1.4.x via CDN, `@turf/turf` via CDN for polygon overlap checks, Supabase (permissive RLS), Node 18+ `node:test` for the two small test suites.

Plan 2 spec: `docs/superpowers/specs/2026-04-19-plan-2-admin-onboarding-design.md`.

---

## File structure

### Creates

- `supabase/migrations/006_relax_rls.sql` — revert 004/005 policies to permissive `plan2_*_all`.
- `public/src/config/profile.js` — replaces `tenant.js`; profile resolution + `LandingPicker` + `window.switchProfile`.
- `public/src/config/router.js` — hash parser + `window.navigate` + `onRouteChange` subscription.
- `public/src/db/admin.js` — list/get/create/update helpers for bakeries, customers, delivery_areas.
- `public/src/components/AdminView.jsx` — admin shell with BakeryList + CustomerList.
- `public/src/components/BakeryEditor.jsx` — new/edit bakery screen (sidebar form + map).
- `public/src/components/CustomerEditor.jsx` — new/edit customer flat form.
- `public/src/components/BakeryHomeView.jsx` — thin wrapper that scopes `App`'s existing region flow to one bakery.
- `public/src/components/CustomerHomeView.jsx` — read-only per-campaign dashboard with disabled upload CTA.
- `public/src/components/ProfileSwitcher.jsx` — header dropdown mounted in every view.
- `scripts/admin-db/admin-db.test.js` — integration test for `admin.js` against the live Supabase project.
- `scripts/admin-db/package.json` — dependencies for the test.
- `public/src/admin/__tests__/overlap.test.mjs` — Turf.js overlap detection unit tests (ESM).
- `public/src/admin/overlap.js` — pure overlap helper used by BakeryEditor and the test.

### Modifies

- `public/src/config/supabase.js` — remove the `tenant_is_authenticated` probe + remove the implicit `x-tenant-token` header wiring (keep `makeTenantClient` export).
- `public/src/components/App.jsx` — switch on `window.__CURRENT_PROFILE__.type` → render Admin / BakeryHome / CustomerHome.
- `public/index.html` — replace `tenant.js` script tag with `profile.js`, add `router.js`, add new component scripts in order, add CDN scripts for `mapbox-gl-draw` and `turf`.

### Deletes

- `public/src/config/tenant.js` — replaced by `profile.js`.

---

## Task ordering rationale

- **Task 1** ships the RLS relaxation migration first so the browser app stops enforcing tokens before we tear down the gate UI. If we did it the other way around, the browser would have a half-removed token path pointing at a DB that still rejects anon writes.
- **Tasks 2–3** replace the gate with a profile picker and router, so every subsequent task runs under the new routing model.
- **Task 4** (admin.js + tests) is the data foundation for every subsequent UI task.
- **Tasks 5–9** build the UI in order of payoff: list screens (5), customer side (6), bakery editor form (7), bakery editor map (8), switcher polish (9).
- **Task 10** is the cross-cutting smoke + cleanup.

---

## Task 1: Migration 006 — relax RLS

**Files:**
- Create: `supabase/migrations/006_relax_rls.sql`
- Modify: `public/src/config/supabase.js` (remove lines 5–14 and 28–43 — the `_tenantToken`/`_tenantClientOpts` wiring and the auth probe)

- [ ] **Step 1: Write migration 006**

Create `supabase/migrations/006_relax_rls.sql`:

```sql
-- Plan 2 — temporarily relax RLS to permissive "anon can everything".
-- Restores the Plan 1 Task 9 posture. When auth is re-enabled (later plan),
-- drop every plan2_*_all policy and reinstate the token-scoped ones from
-- 004_rls.sql / 005_rls_fix_recursion.sql. Helper functions from those
-- migrations stay in place; they're harmless and reused later.
--
-- RLS stays ENABLED on every table; we just let everything through with
-- permissive USING / WITH CHECK clauses. This keeps the RLS-on-by-default
-- posture and simplifies the future re-enable migration.

-- 1. Drop policies from 004_rls.sql and 005_rls_fix_recursion.sql.
--    Named explicitly; `if exists` makes this idempotent in dev.

drop policy if exists bakeries_select_self on bakeries;
drop policy if exists bakeries_update_self on bakeries;
drop policy if exists bakeries_anon_basic_read on bakeries;
drop policy if exists customers_select_self on customers;
drop policy if exists customers_update_self on customers;
drop policy if exists customers_anon_basic_read on customers;
drop policy if exists delivery_areas_select on delivery_areas;
drop policy if exists delivery_areas_write_self on delivery_areas;
drop policy if exists depots_select on depots;
drop policy if exists depots_write_self on depots;
drop policy if exists campaigns_select_customer on campaigns;
drop policy if exists campaigns_select_bakery on campaigns;
drop policy if exists campaigns_write_customer on campaigns;
drop policy if exists recipients_select_customer on recipients;
drop policy if exists recipients_select_bakery on recipients;
drop policy if exists recipients_write_customer on recipients;
drop policy if exists routes_select_bakery on routes;
drop policy if exists routes_select_customer on routes;
drop policy if exists routes_write_bakery on routes;
drop policy if exists delivery_statuses_v2_select_bakery on delivery_statuses_v2;
drop policy if exists delivery_statuses_v2_select_customer on delivery_statuses_v2;
drop policy if exists delivery_statuses_v2_write_bakery on delivery_statuses_v2;
drop policy if exists geocode_cache_all on geocode_cache;

-- 2. Create permissive "everything allowed" policies. Named plan2_*_all
--    so a future re-enable migration can DROP them cleanly.

create policy plan2_bakeries_all           on bakeries           for all using (true) with check (true);
create policy plan2_customers_all          on customers          for all using (true) with check (true);
create policy plan2_delivery_areas_all     on delivery_areas     for all using (true) with check (true);
create policy plan2_depots_all             on depots             for all using (true) with check (true);
create policy plan2_campaigns_all          on campaigns          for all using (true) with check (true);
create policy plan2_recipients_all         on recipients         for all using (true) with check (true);
create policy plan2_routes_all             on routes             for all using (true) with check (true);
create policy plan2_delivery_statuses_v2_all on delivery_statuses_v2 for all using (true) with check (true);
create policy plan2_geocode_cache_all      on geocode_cache      for all using (true) with check (true);

-- 3. app_settings keeps its deny-all posture (service role only). Not touched.
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `execute_sql` tool (the user rule forbids the Supabase CLI). Paste the full file contents into one `execute_sql` call. Expected response: no error rows.

- [ ] **Step 3: Verify RLS posture in the DB**

Via the Supabase MCP `execute_sql`:

```sql
select tablename, policyname from pg_policies
where schemaname = 'public' and policyname like 'plan2_%'
order by tablename, policyname;
```

Expected: 9 rows, one per table listed in Step 1's `create policy` block.

- [ ] **Step 4: Remove the tenant auth probe + header from supabase.js**

Modify `public/src/config/supabase.js`. Replace lines 1–44 (everything above `// ===== PERSISTENCE LAYER =====`) with:

```js
// ===== SUPABASE CONFIG =====
const SUPABASE_URL = window.__SUPABASE_URL__ || 'https://vqmjevtthpedzdfotaie.supabase.co';
const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__ || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxbWpldnR0aHBlZHpkZm90YWllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzODIwODcsImV4cCI6MjA5MTk1ODA4N30.mct_oZri4PLJVkrhZC3uzkq0qMYZExM7Y_30mQP30S8';

const _supabaseReady = SUPABASE_URL !== 'PLACEHOLDER_NOT_SET' && typeof supabase !== 'undefined';
const sb = _supabaseReady ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Forward-compat: lets a future plan temporarily act as a specific tenant by
// attaching the x-tenant-token header. Plan 2 does not use this — RLS is
// permissive — but keeping the factory means the re-enable-auth migration
// has a drop-in path.
function makeTenantClient(token) {
  if (!_supabaseReady || !token) return null;
  return supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { 'x-tenant-token': token } }
  });
}
window.makeTenantClient = makeTenantClient;
```

Leave the `DB = { ... }` facade (line 46 onward) untouched.

- [ ] **Step 5: Sanity-check the app still loads**

Reload the browser app. Expected: the existing tenant paste-token gate appears (we haven't replaced it yet in Task 2). Paste any of the existing bakery/customer tokens from `scripts/print-tenant-tokens`. The app should render Archy data as before. RLS is now permissive, so reads/writes all work.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/006_relax_rls.sql public/src/config/supabase.js
git commit -m "migration 006: relax RLS to permissive plan2_*_all policies"
```

---

## Task 2: Replace tenant.js with profile.js + LandingPicker

**Files:**
- Create: `public/src/config/profile.js`
- Delete: `public/src/config/tenant.js`
- Modify: `public/index.html` (rename the script tag, update the mount guard)

- [ ] **Step 1: Create profile.js with resolution + landing picker**

Create `public/src/config/profile.js`:

```js
// ===== PROFILE BOOTSTRAP =====
// Resolves the current profile (admin | bakery | customer) from, in order:
//   1. window.location.hash           — canonical address (`#/admin`, `#/bakery/<uuid>`, `#/customer/<uuid>`)
//   2. ?profile=<type>:<uuid> query   — handoff from "Share link" URLs
//   3. localStorage 'profile'          — returning visitor
//   4. otherwise                       — render LandingPicker
//
// Plan 2 has no authentication: the profile is purely "which hat am I wearing".
// Token infrastructure from Plan 1 stays dormant in supabase.js (makeTenantClient).
(function () {
  const STORAGE_KEY = 'profile';
  const QUERY_PARAM = 'profile';

  const hashProfile = parseHash(window.location.hash);
  if (hashProfile) {
    persist(hashProfile);
    expose(hashProfile);
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const urlProfile = parseQuery(params.get(QUERY_PARAM));
  if (urlProfile) {
    persist(urlProfile);
    params.delete(QUERY_PARAM);
    const qs = params.toString();
    const targetHash = '#/' + urlProfile.type + (urlProfile.id ? '/' + urlProfile.id : '');
    const cleanUrl = window.location.pathname + (qs ? '?' + qs : '') + targetHash;
    try { window.history.replaceState(null, '', cleanUrl); } catch (e) {}
    expose(urlProfile);
    return;
  }

  const stored = readStored();
  if (stored) {
    const targetHash = '#/' + stored.type + (stored.id ? '/' + stored.id : '');
    window.location.hash = targetHash;
    expose(stored);
    return;
  }

  // No profile → render the landing picker into #root and short-circuit.
  window.__PROFILE_GATE_ACTIVE__ = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderLandingPicker);
  } else {
    renderLandingPicker();
  }

  // ----------------- helpers -----------------

  function parseHash(hash) {
    if (!hash) return null;
    const m = hash.match(/^#\/(admin|bakery|customer)(?:\/([a-f0-9-]{36}))?/i);
    if (!m) return null;
    return { type: m[1].toLowerCase(), id: m[2] || null };
  }

  function parseQuery(value) {
    if (!value) return null;
    const [type, id] = value.split(':');
    if (!type || !/^(admin|bakery|customer)$/i.test(type)) return null;
    if (type !== 'admin' && !id) return null;
    return { type: type.toLowerCase(), id: id || null };
  }

  function readStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.type) return null;
      return { type: obj.type, id: obj.id || null };
    } catch (e) { return null; }
  }

  function persist(p) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (e) {}
  }

  function expose(p) {
    window.__CURRENT_PROFILE__ = p;
    window.switchProfile = function (next) {
      persist(next);
      const h = '#/' + next.type + (next.id ? '/' + next.id : '');
      if (window.location.hash === h) {
        window.location.reload();
      } else {
        window.location.hash = h;
        window.location.reload();
      }
    };
    window.signOutProfile = function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      window.location.replace(window.location.pathname);
    };
  }

  async function renderLandingPicker() {
    const root = document.getElementById('root');
    if (!root) return;
    root.innerHTML = landingShell();
    const sbClient = typeof sb !== 'undefined' ? sb : null;
    const bakeriesEl = root.querySelector('#landing-bakeries');
    const customersEl = root.querySelector('#landing-customers');
    if (!sbClient) {
      bakeriesEl.textContent = 'Supabase not configured.';
      customersEl.textContent = '';
      return;
    }
    try {
      const [{ data: bakeries }, { data: customers }] = await Promise.all([
        sbClient.from('bakeries').select('id, name').order('name'),
        sbClient.from('customers').select('id, name').order('name'),
      ]);
      bakeriesEl.innerHTML = (bakeries || []).map(b =>
        `<button class="landing-row" data-type="bakery" data-id="${b.id}">${escapeHtml(b.name)}</button>`
      ).join('') || '<div class="landing-empty">No bakeries yet.</div>';
      customersEl.innerHTML = (customers || []).map(c =>
        `<button class="landing-row" data-type="customer" data-id="${c.id}">${escapeHtml(c.name)}</button>`
      ).join('') || '<div class="landing-empty">No customers yet.</div>';
      root.querySelectorAll('.landing-row').forEach(el => {
        el.addEventListener('click', () => {
          window.switchProfile({ type: el.dataset.type, id: el.dataset.id });
        });
      });
      root.querySelector('#landing-admin').addEventListener('click', () => {
        window.switchProfile({ type: 'admin', id: null });
      });
    } catch (e) {
      bakeriesEl.textContent = 'Failed to load: ' + e.message;
    }
  }

  function landingShell() {
    return `
      <style>
        .landing-page { min-height:100vh; display:flex; align-items:center; justify-content:center;
          padding:24px; background:#f9fafb; font-family:'DM Sans',system-ui,sans-serif; }
        .landing-card { background:#fff; border:1px solid #e5e7eb; border-radius:16px; padding:32px;
          max-width:860px; width:100%; box-shadow:0 1px 2px rgba(0,0,0,.05); }
        .landing-title { font-size:20px; font-weight:600; margin:0 0 4px; color:#111827; }
        .landing-subtitle { font-size:14px; color:#6b7280; margin:0 0 24px; }
        .landing-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
        .landing-col { border:1px solid #e5e7eb; border-radius:8px; padding:16px; }
        .landing-col h3 { margin:0 0 8px; font-size:12px; font-weight:600; text-transform:uppercase;
          letter-spacing:0.05em; color:#6b7280; }
        #landing-admin { display:block; width:100%; padding:12px; background:#111827; color:#fff;
          border:0; border-radius:6px; font-weight:500; font-size:13px; cursor:pointer; }
        .landing-row { display:block; width:100%; text-align:left; padding:8px 10px; margin-bottom:4px;
          background:#f3f4f6; color:#111827; border:0; border-radius:4px; font-size:13px; cursor:pointer; }
        .landing-row:hover { background:#e5e7eb; }
        .landing-empty { font-size:12px; color:#9ca3af; }
      </style>
      <div class="landing-page">
        <div class="landing-card">
          <div class="landing-title">Archy × Daymaker — Delivery Operations</div>
          <div class="landing-subtitle">Pick a profile to continue.</div>
          <div class="landing-grid">
            <div class="landing-col">
              <h3>Admin</h3>
              <button id="landing-admin">Enter admin</button>
            </div>
            <div class="landing-col">
              <h3>Bakeries</h3>
              <div id="landing-bakeries">Loading…</div>
            </div>
            <div class="landing-col">
              <h3>Customers</h3>
              <div id="landing-customers">Loading…</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }
})();
```

- [ ] **Step 2: Delete tenant.js**

```bash
git rm public/src/config/tenant.js
```

- [ ] **Step 3: Wire profile.js into index.html**

Modify `public/index.html`. Replace the block at lines 37–40:

```html
  <!-- Tenant token bootstrap (runs before supabase.js). Renders a login gate
       into #root when no token is found, and sets window.__TENANT_TOKEN__ /
       window.__TENANT_GATE_ACTIVE__ for the scripts below. -->
  <script src="./src/config/tenant.js"></script>
```

with:

```html
  <!-- Profile bootstrap (runs before supabase.js). Renders the landing picker
       into #root when no profile is selected and sets window.__CURRENT_PROFILE__
       + window.__PROFILE_GATE_ACTIVE__ for the scripts below. -->
  <script src="./src/config/profile.js"></script>
```

Then update the mount guard at the bottom (line ~84):

```html
  <script type="text/babel">
    if (!window.__PROFILE_GATE_ACTIVE__) {
      ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
    }
  </script>
```

- [ ] **Step 4: Clear stale localStorage keys**

Open the app in the browser. In DevTools console:

```js
localStorage.removeItem('tenantToken');
localStorage.removeItem('profile');
location.reload();
```

Expected: the new landing picker renders, listing four bakeries (Boho Petite, Sweet Lady Jane, SmallCakes, Roland's) and one customer (Archy). "Enter admin" is a dark button in the first column.

- [ ] **Step 5: Smoke — click through each profile**

1. Click "Enter admin" → URL changes to `#/admin`, page reloads, app tries to render and fails because `App.jsx` doesn't yet handle admin (expected; fixed in Task 3). For now, assert the URL contains `#/admin` and localStorage has `{"type":"admin","id":null}`.
2. `localStorage.removeItem('profile'); location.reload();` → picker again.
3. Click "Boho Petite" → URL contains `#/bakery/<uuid>`, app renders the existing Ops view exactly as today (App.jsx still boots Archy).
4. `localStorage.removeItem('profile'); location.reload();` → picker. Click "Archy" → URL contains `#/customer/<uuid>`, app renders the existing Ops view as today.

- [ ] **Step 6: Commit**

```bash
git add public/src/config/profile.js public/index.html
git commit -m "replace tenant token gate with profile picker (no auth in plan 2)"
```

---

## Task 3: Hash router + App.jsx routing split

**Files:**
- Create: `public/src/config/router.js`
- Modify: `public/src/components/App.jsx` (wrap current body behind a profile-type switch)
- Modify: `public/index.html` (load router.js after profile.js)

- [ ] **Step 1: Create router.js**

Create `public/src/config/router.js`:

```js
// ===== HASH ROUTER =====
// Ultra-thin router. Parses location.hash into a structured route and
// exposes subscribe/navigate helpers. React components read the current
// route via useRoute() (below) which subscribes to hashchange.
(function () {
  const ROUTES = [
    // Order matters: more specific patterns first.
    { pattern: /^#\/admin\/bakery\/new$/i, build: () => ({ view: 'admin', page: 'bakery-editor', id: null, isNew: true }) },
    { pattern: /^#\/admin\/bakery\/([a-f0-9-]{36})$/i, build: m => ({ view: 'admin', page: 'bakery-editor', id: m[1], isNew: false }) },
    { pattern: /^#\/admin\/customer\/new$/i, build: () => ({ view: 'admin', page: 'customer-editor', id: null, isNew: true }) },
    { pattern: /^#\/admin\/customer\/([a-f0-9-]{36})$/i, build: m => ({ view: 'admin', page: 'customer-editor', id: m[1], isNew: false }) },
    { pattern: /^#\/admin$/i, build: () => ({ view: 'admin', page: 'list', id: null }) },
    { pattern: /^#\/bakery\/([a-f0-9-]{36})$/i, build: m => ({ view: 'bakery', page: 'home', id: m[1] }) },
    { pattern: /^#\/customer\/([a-f0-9-]{36})$/i, build: m => ({ view: 'customer', page: 'home', id: m[1] }) },
  ];

  function parseRoute(hash) {
    for (const r of ROUTES) {
      const m = hash.match(r.pattern);
      if (m) return r.build(m);
    }
    // Unknown hash → fall back to the profile's home.
    const p = window.__CURRENT_PROFILE__;
    if (!p) return { view: 'landing' };
    if (p.type === 'admin') return { view: 'admin', page: 'list', id: null };
    if (p.type === 'bakery' && p.id) return { view: 'bakery', page: 'home', id: p.id };
    if (p.type === 'customer' && p.id) return { view: 'customer', page: 'home', id: p.id };
    return { view: 'landing' };
  }

  function currentRoute() {
    return parseRoute(window.location.hash);
  }

  window.currentRoute = currentRoute;
  window.navigate = function (hash) {
    if (window.location.hash === hash) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = hash;
    }
  };

  // React hook: re-renders on hashchange.
  window.useRoute = function () {
    const [route, setRoute] = React.useState(currentRoute());
    React.useEffect(() => {
      const on = () => setRoute(currentRoute());
      window.addEventListener('hashchange', on);
      return () => window.removeEventListener('hashchange', on);
    }, []);
    return route;
  };
})();
```

- [ ] **Step 2: Load router.js in index.html**

Modify `public/index.html`. Under the `profile.js` script tag, add:

```html
  <!-- Hash router (depends on profile having been resolved) -->
  <script src="./src/config/router.js"></script>
```

Placement: immediately after `./src/config/profile.js`, before `./src/config/supabase.js`.

- [ ] **Step 3: Restructure App.jsx to switch on route**

Modify `public/src/components/App.jsx`. Replace the entire file with:

```jsx
// ===== MAIN APP =====
function App(){
  const profile=window.__CURRENT_PROFILE__||{type:'landing'};
  const route=useRoute();

  if(profile.type==='admin'){
    return <AdminView route={route}/>;
  }
  if(profile.type==='bakery'&&profile.id){
    return <BakeryHomeView bakeryId={profile.id}/>;
  }
  if(profile.type==='customer'&&profile.id){
    return <CustomerHomeView customerId={profile.id}/>;
  }

  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>Loading…</div>;
}
```

Now cut the old `App` body into a new file `public/src/components/BakeryHomeView.jsx` — see Task 5b below. For this task we need a working stub so the app still renders when profile is bakery or customer:

Create `public/src/components/BakeryHomeView.jsx`:

```jsx
// ===== BAKERY HOME VIEW — Plan 2 thin wrapper =====
// Mounts the existing Archy-era region/day/driver flow scoped to a single
// bakery. Full logic arrives in Task 5b; this stub keeps the app rendering
// while the router is wired up.
function BakeryHomeView({bakeryId}){
  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>
    BakeryHomeView for <code>{bakeryId}</code> — pending Task 5b.
  </div>;
}
```

Create `public/src/components/CustomerHomeView.jsx`:

```jsx
// ===== CUSTOMER HOME VIEW — Plan 2 stub =====
// Full dashboard + disabled upload CTA arrives in Task 6.
function CustomerHomeView({customerId}){
  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>
    CustomerHomeView for <code>{customerId}</code> — pending Task 6.
  </div>;
}
```

Create `public/src/components/AdminView.jsx`:

```jsx
// ===== ADMIN VIEW — Plan 2 stub =====
// Full list + editor screens arrive in Tasks 5 / 7 / 8.
function AdminView({route}){
  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>
    AdminView · <code>{route.page}</code> — pending Tasks 5, 7, 8.
  </div>;
}
```

- [ ] **Step 4: Wire the new components into index.html**

Modify `public/index.html`. Replace the `App.jsx` script tag with the new ordering (new components must be defined before App):

```html
  <script type="text/babel" src="./src/components/ProgressBar.jsx"></script>
  <script type="text/babel" src="./src/components/StopCard.jsx"></script>
  <script type="text/babel" src="./src/components/DepotManager.jsx"></script>
  <script type="text/babel" src="./src/components/MapView.jsx"></script>
  <script type="text/babel" src="./src/components/PrintSheet.jsx"></script>
  <script type="text/babel" src="./src/components/OpsView.jsx"></script>
  <script type="text/babel" src="./src/components/CustomerView.jsx"></script>
  <script type="text/babel" src="./src/components/PhotosView.jsx"></script>

  <!-- Plan 2 views (depend on everything above) -->
  <script type="text/babel" src="./src/components/AdminView.jsx"></script>
  <script type="text/babel" src="./src/components/BakeryHomeView.jsx"></script>
  <script type="text/babel" src="./src/components/CustomerHomeView.jsx"></script>

  <!-- Route-aware app shell (depends on every component above) -->
  <script type="text/babel" src="./src/components/App.jsx"></script>
```

- [ ] **Step 5: Smoke the routing**

Reload the app, pick each profile from the landing picker, and verify:

1. Admin → "AdminView · list — pending Tasks 5, 7, 8."
2. Bakery (Boho Petite) → "BakeryHomeView for <uuid> — pending Task 5b."
3. Customer (Archy) → "CustomerHomeView for <uuid> — pending Task 6."

Hand-edit the URL to `#/admin/bakery/new` while in admin → stub text changes to `AdminView · bakery-editor — pending Tasks 5, 7, 8.`.

- [ ] **Step 6: Commit**

```bash
git add public/src/config/router.js public/src/components/App.jsx public/src/components/AdminView.jsx public/src/components/BakeryHomeView.jsx public/src/components/CustomerHomeView.jsx public/index.html
git commit -m "hash router + route-aware App shell; stubs for admin/bakery/customer views"
```

---

## Task 4: admin.js DB helpers + integration tests

**Files:**
- Create: `public/src/db/admin.js`
- Create: `scripts/admin-db/admin-db.test.js`
- Create: `scripts/admin-db/package.json`
- Modify: `public/index.html` (load admin.js)

- [ ] **Step 1: Write the failing test file**

Create `scripts/admin-db/package.json`:

```json
{
  "name": "admin-db-test",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test admin-db.test.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "dotenv": "^16.4.5"
  }
}
```

Create `scripts/admin-db/admin-db.test.js`:

```js
// Integration tests for admin.js. Runs against the live Supabase project
// with the service role key (read from apps/web .env per the user rule,
// with a fallback to the repo root .env).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

const candidates = [
  path.resolve(process.cwd(), '../../apps/web/.env'),
  path.resolve(process.cwd(), '../../.env'),
];
for (const p of candidates) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
const sb = createClient(url, key);

// The test mirrors admin.js exactly. We load admin.js source and eval it
// against a shim that exposes `sb`, then call the functions it defines.
const src = fs.readFileSync(path.resolve(process.cwd(), '../../public/src/db/admin.js'), 'utf8');
const mod = {};
new Function('sb', 'mod', src + '\nmod.Admin = Admin;')(sb, mod);
const Admin = mod.Admin;

const suffix = Math.random().toString(36).slice(2, 8);
const mkName = kind => `TEST_${kind}_${suffix}`;

let createdBakeryId = null;
let createdCustomerId = null;
let createdAreaId = null;

after(async () => {
  if (createdAreaId) await sb.from('delivery_areas').delete().eq('id', createdAreaId);
  if (createdBakeryId) await sb.from('bakeries').delete().eq('id', createdBakeryId);
  if (createdCustomerId) await sb.from('customers').delete().eq('id', createdCustomerId);
});

test('createBakery mints an access_token and returns the row', async () => {
  const row = await Admin.createBakery({ name: mkName('bakery'), contact_email: 'ops@example.com' });
  assert.ok(row && row.id);
  assert.ok(row.access_token && row.access_token.length >= 16);
  assert.equal(row.contact_email, 'ops@example.com');
  createdBakeryId = row.id;
});

test('updateBakery patches name and email', async () => {
  const updated = await Admin.updateBakery(createdBakeryId, {
    name: mkName('bakery-renamed'), contact_email: 'renamed@example.com'
  });
  assert.equal(updated.contact_email, 'renamed@example.com');
});

test('listBakeries includes the new bakery', async () => {
  const rows = await Admin.listBakeries();
  const match = rows.find(r => r.id === createdBakeryId);
  assert.ok(match, 'new bakery should appear in listBakeries');
});

test('upsertDeliveryArea inserts then updates', async () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]],
  };
  const inserted = await Admin.upsertDeliveryArea({
    bakery_id: createdBakeryId, name: 'Test area', geometry,
  });
  assert.ok(inserted.id);
  createdAreaId = inserted.id;

  const newGeom = {
    type: 'Polygon',
    coordinates: [[[0,0],[0,2],[2,2],[2,0],[0,0]]],
  };
  const updated = await Admin.upsertDeliveryArea({
    id: createdAreaId, bakery_id: createdBakeryId, name: 'Test area v2', geometry: newGeom,
  });
  assert.equal(updated.id, createdAreaId);
  assert.equal(updated.name, 'Test area v2');
  assert.deepEqual(updated.geometry, newGeom);
});

test('getBakery returns bakery + delivery_areas + depots', async () => {
  const { bakery, delivery_areas, depots } = await Admin.getBakery(createdBakeryId);
  assert.equal(bakery.id, createdBakeryId);
  assert.ok(Array.isArray(delivery_areas));
  assert.equal(delivery_areas.length, 1);
  assert.equal(delivery_areas[0].id, createdAreaId);
  assert.ok(Array.isArray(depots));
  assert.equal(depots.length, 0);
});

test('deleteDeliveryArea removes the row', async () => {
  await Admin.deleteDeliveryArea(createdAreaId);
  const { delivery_areas } = await Admin.getBakery(createdBakeryId);
  assert.equal(delivery_areas.length, 0);
  createdAreaId = null;
});

test('createCustomer mints access_token and returns the row', async () => {
  const row = await Admin.createCustomer({ name: mkName('customer'), contact_email: 'cust@example.com' });
  assert.ok(row && row.id);
  assert.ok(row.access_token && row.access_token.length >= 16);
  createdCustomerId = row.id;
});

test('getCustomer returns customer + campaigns', async () => {
  const { customer, campaigns } = await Admin.getCustomer(createdCustomerId);
  assert.equal(customer.id, createdCustomerId);
  assert.ok(Array.isArray(campaigns));
});
```

- [ ] **Step 2: Verify the test fails (admin.js does not exist yet)**

```bash
cd scripts/admin-db && npm install && npm test
```

Expected: node throws `ENOENT` on `public/src/db/admin.js` or an `Admin is not defined` failure from every test.

- [ ] **Step 3: Implement admin.js**

Create `public/src/db/admin.js`:

```js
// ===== ADMIN DATA ACCESS =====
// Thin wrapper for Plan 2 admin CRUD. Uses the shared `sb` client; Plan 2
// runs against permissive RLS so all of these calls go straight to
// Postgres. access_token values are generated with crypto.randomUUID()
// at insert time for forward-compat (no auth is enforced today).
const Admin = {
  async listBakeries() {
    if (!sb) return [];
    const { data, error } = await sb.from('bakeries')
      .select('id, name, contact_email, contact_phone, access_token, created_at')
      .order('name');
    if (error) throw error;
    return data || [];
  },

  async listCustomers() {
    if (!sb) return [];
    const { data, error } = await sb.from('customers')
      .select('id, name, contact_email, access_token, created_at')
      .order('name');
    if (error) throw error;
    return data || [];
  },

  async getBakery(id) {
    if (!sb) throw new Error('sb not ready');
    const [{ data: bakery, error: bErr }, { data: delivery_areas, error: dErr }, { data: depots, error: pErr }] = await Promise.all([
      sb.from('bakeries').select('*').eq('id', id).single(),
      sb.from('delivery_areas').select('*').eq('bakery_id', id).order('created_at'),
      sb.from('depots').select('*').eq('bakery_id', id).order('name'),
    ]);
    if (bErr) throw bErr;
    if (dErr) throw dErr;
    if (pErr) throw pErr;
    return { bakery, delivery_areas: delivery_areas || [], depots: depots || [] };
  },

  async getCustomer(id) {
    if (!sb) throw new Error('sb not ready');
    const [{ data: customer, error: cErr }, { data: campaigns, error: pErr }] = await Promise.all([
      sb.from('customers').select('*').eq('id', id).single(),
      sb.from('campaigns').select('*').eq('customer_id', id).order('created_at'),
    ]);
    if (cErr) throw cErr;
    if (pErr) throw pErr;
    return { customer, campaigns: campaigns || [] };
  },

  async createBakery({ name, contact_email, contact_phone }) {
    if (!sb) throw new Error('sb not ready');
    const row = {
      name,
      contact_email: contact_email || null,
      contact_phone: contact_phone || null,
      access_token: genToken(),
    };
    const { data, error } = await sb.from('bakeries').insert(row).select('*').single();
    if (error) throw error;
    return data;
  },

  async updateBakery(id, patch) {
    if (!sb) throw new Error('sb not ready');
    const allowed = {};
    if ('name' in patch) allowed.name = patch.name;
    if ('contact_email' in patch) allowed.contact_email = patch.contact_email || null;
    if ('contact_phone' in patch) allowed.contact_phone = patch.contact_phone || null;
    const { data, error } = await sb.from('bakeries').update(allowed).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },

  async upsertDeliveryArea({ id, bakery_id, name, geometry }) {
    if (!sb) throw new Error('sb not ready');
    if (id) {
      const { data, error } = await sb.from('delivery_areas')
        .update({ name: name || null, geometry })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data;
    }
    const { data, error } = await sb.from('delivery_areas')
      .insert({ bakery_id, name: name || null, geometry })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  },

  async deleteDeliveryArea(id) {
    if (!sb) return;
    const { error } = await sb.from('delivery_areas').delete().eq('id', id);
    if (error) throw error;
  },

  async createCustomer({ name, contact_email }) {
    if (!sb) throw new Error('sb not ready');
    const row = { name, contact_email: contact_email || null, access_token: genToken() };
    const { data, error } = await sb.from('customers').insert(row).select('*').single();
    if (error) throw error;
    return data;
  },

  async updateCustomer(id, patch) {
    if (!sb) throw new Error('sb not ready');
    const allowed = {};
    if ('name' in patch) allowed.name = patch.name;
    if ('contact_email' in patch) allowed.contact_email = patch.contact_email || null;
    const { data, error } = await sb.from('customers').update(allowed).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  },
};

function genToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

if (typeof window !== 'undefined') window.Admin = Admin;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd scripts/admin-db && npm test
```

Expected: all 8 tests pass. The `after` hook cleans up the test rows.

- [ ] **Step 5: Wire admin.js into index.html**

Modify `public/index.html`. After the `db2.js` script tag, add:

```html
  <!-- Admin data-access layer (Plan 2) -->
  <script src="./src/db/admin.js"></script>
```

- [ ] **Step 6: Commit**

```bash
git add public/src/db/admin.js scripts/admin-db/ public/index.html
git commit -m "admin.js data access + integration tests (bakeries, customers, delivery_areas)"
```

---

## Task 5: AdminView shell — BakeryList + CustomerList with "View as →"

**Files:**
- Modify: `public/src/components/AdminView.jsx` (replace stub)

- [ ] **Step 1: Replace AdminView stub with list shell**

Replace `public/src/components/AdminView.jsx` with:

```jsx
// ===== ADMIN VIEW =====
// Top-level admin surface. Switches between list / bakery-editor / customer-editor
// based on the route (from router.js). List view shows bakeries and customers
// with "View as →" shortcuts for one-click profile switching.
function AdminView({route}){
  if(route.page==='bakery-editor')return <BakeryEditor bakeryId={route.id} isNew={route.isNew}/>;
  if(route.page==='customer-editor')return <CustomerEditor customerId={route.id} isNew={route.isNew}/>;
  return <AdminList/>;
}

function AdminList(){
  const[bakeries,setBakeries]=useState(null);
  const[customers,setCustomers]=useState(null);
  const[err,setErr]=useState('');

  useEffect(()=>{(async()=>{
    try{
      const[b,c]=await Promise.all([Admin.listBakeries(),Admin.listCustomers()]);
      setBakeries(b);setCustomers(c);
    }catch(e){setErr(e.message||String(e));}
  })();},[]);

  return <div className="app-shell wide">
    <AdminHeader/>
    {err&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:8,marginBottom:12,fontSize:13}}>{err}</div>}

    <section style={{marginBottom:32}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <h2 style={{fontSize:16,fontWeight:600,margin:0}}>Bakeries</h2>
        <button className="btn-primary" onClick={()=>navigate('#/admin/bakery/new')}>+ New bakery</button>
      </div>
      {bakeries===null?<Loading/>:bakeries.length===0?<Empty msg="No bakeries yet."/>:
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {bakeries.map(b=><BakeryRow key={b.id} bakery={b}/>)}
        </div>
      }
    </section>

    <section>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <h2 style={{fontSize:16,fontWeight:600,margin:0}}>Customers</h2>
        <button className="btn-primary" onClick={()=>navigate('#/admin/customer/new')}>+ New customer</button>
      </div>
      {customers===null?<Loading/>:customers.length===0?<Empty msg="No customers yet."/>:
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {customers.map(c=><CustomerRow key={c.id} customer={c}/>)}
        </div>
      }
    </section>
  </div>;
}

function AdminHeader(){
  return <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:24}}>
    <div>
      <h1 style={{fontSize:18,fontWeight:700,margin:0}}>Admin</h1>
      <span style={{fontSize:12,color:'#94a3b8'}}>Manage bakeries and customers.</span>
    </div>
    <ProfileSwitcher/>
  </div>;
}

function BakeryRow({bakery}){
  return <div className="row" style={rowStyle}>
    <div style={{flex:1}}>
      <div style={{fontWeight:500}}>{bakery.name}</div>
      <div style={{fontSize:12,color:'#64748b'}}>{bakery.contact_email||'—'} · {bakery.contact_phone||'—'}</div>
    </div>
    <button className="btn-link" onClick={()=>window.switchProfile({type:'bakery',id:bakery.id})}>View as bakery →</button>
    <button className="btn-ghost" onClick={()=>navigate('#/admin/bakery/'+bakery.id)}>Edit</button>
  </div>;
}

function CustomerRow({customer}){
  return <div className="row" style={rowStyle}>
    <div style={{flex:1}}>
      <div style={{fontWeight:500}}>{customer.name}</div>
      <div style={{fontSize:12,color:'#64748b'}}>{customer.contact_email||'—'}</div>
    </div>
    <button className="btn-link" onClick={()=>window.switchProfile({type:'customer',id:customer.id})}>View as customer →</button>
    <button className="btn-ghost" onClick={()=>navigate('#/admin/customer/'+customer.id)}>Edit</button>
  </div>;
}

const rowStyle={display:'flex',gap:12,alignItems:'center',padding:'12px 14px',border:'1px solid #e5e7eb',borderRadius:6,background:'#fff'};

function Loading(){return <div style={{color:'#94a3b8',fontSize:13,padding:'12px 0'}}>Loading…</div>;}
function Empty({msg}){return <div style={{color:'#94a3b8',fontSize:13,padding:'12px 0'}}>{msg}</div>;}
```

- [ ] **Step 2: Add admin-specific button styles**

Modify `public/src/styles.css`. Append at the end:

```css
/* ===== Plan 2 admin styles ===== */
.btn-primary{background:#111827;color:#fff;border:0;padding:8px 14px;border-radius:6px;font-weight:500;font-size:13px;cursor:pointer}
.btn-primary:hover{background:#1f2937}
.btn-ghost{background:#fff;color:#374151;border:1px solid #e5e7eb;padding:7px 12px;border-radius:6px;font-size:13px;cursor:pointer}
.btn-ghost:hover{background:#f9fafb}
.btn-link{background:transparent;color:#2563eb;border:0;padding:6px 8px;font-size:13px;cursor:pointer}
.btn-link:hover{text-decoration:underline}
.admin-sidebar{width:360px;flex:none;padding:20px;border-right:1px solid #e5e7eb;overflow-y:auto;background:#fff}
.admin-sidebar h4{margin:0 0 8px;font-size:13px;font-weight:600}
.admin-field{display:block;margin-bottom:10px;font-size:12px}
.admin-field label{display:block;color:#6b7280;margin-bottom:3px;font-weight:500}
.admin-field input,.admin-field textarea{width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;font-family:inherit;box-sizing:border-box}
.admin-section{border-top:1px solid #f3f4f6;padding-top:14px;margin-top:14px}
```

- [ ] **Step 3: Create a temporary ProfileSwitcher stub**

Create `public/src/components/ProfileSwitcher.jsx`:

```jsx
// ===== PROFILE SWITCHER =====
// Temporary minimal version; Task 9 adds the real dropdown UI.
function ProfileSwitcher(){
  return <button className="btn-ghost" onClick={()=>window.signOutProfile()}>Switch profile</button>;
}
```

Load it in `public/index.html` before `AdminView.jsx`:

```html
  <script type="text/babel" src="./src/components/ProfileSwitcher.jsx"></script>
  <script type="text/babel" src="./src/components/AdminView.jsx"></script>
```

- [ ] **Step 4: Create BakeryEditor + CustomerEditor stubs (filled in later tasks)**

Create `public/src/components/BakeryEditor.jsx`:

```jsx
// ===== BAKERY EDITOR — full impl in Tasks 7 + 8 =====
function BakeryEditor({bakeryId,isNew}){
  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>
    BakeryEditor · {isNew?'new':bakeryId} — pending Tasks 7, 8. <button className="btn-ghost" onClick={()=>navigate('#/admin')}>Back</button>
  </div>;
}
```

Create `public/src/components/CustomerEditor.jsx`:

```jsx
// ===== CUSTOMER EDITOR — full impl in Task 6 =====
function CustomerEditor({customerId,isNew}){
  return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>
    CustomerEditor · {isNew?'new':customerId} — pending Task 6. <button className="btn-ghost" onClick={()=>navigate('#/admin')}>Back</button>
  </div>;
}
```

Load both in `public/index.html` before `AdminView.jsx`:

```html
  <script type="text/babel" src="./src/components/BakeryEditor.jsx"></script>
  <script type="text/babel" src="./src/components/CustomerEditor.jsx"></script>
  <script type="text/babel" src="./src/components/ProfileSwitcher.jsx"></script>
  <script type="text/babel" src="./src/components/AdminView.jsx"></script>
```

- [ ] **Step 5: Smoke AdminView**

Pick "Admin" from the landing picker. Expected:

- Heading "Admin — Manage bakeries and customers."
- Bakeries section lists four rows (Boho Petite, Roland's, SmallCakes, Sweet Lady Jane — alphabetical).
- Customers section lists one row (Archy).
- Click "View as bakery →" on Boho Petite → app reloads into BakeryHomeView stub.
- Click "Switch profile" in header → returns to landing picker.
- Pick Admin again → click "Edit" on a bakery → URL changes to `#/admin/bakery/<uuid>`, BakeryEditor stub renders.

- [ ] **Step 6: Commit**

```bash
git add public/src/components/AdminView.jsx public/src/components/BakeryEditor.jsx public/src/components/CustomerEditor.jsx public/src/components/ProfileSwitcher.jsx public/src/styles.css public/index.html
git commit -m "AdminView list shell with BakeryList/CustomerList and view-as shortcuts"
```

---

## Task 5b: BakeryHomeView — scope existing Ops flow to one bakery

**Files:**
- Modify: `public/src/components/BakeryHomeView.jsx` (replace stub)

The existing `App` body (pre-Plan-2) boots the Archy campaign and renders every region. For `BakeryHomeView`, we want the same behavior but filter `window.REGIONS` to regions belonging to this bakery.

- [ ] **Step 1: Replace the stub with the full wrapper**

Replace `public/src/components/BakeryHomeView.jsx` with the code below. This is essentially the pre-Plan-2 `App` body plus a region filter and a profile switcher in the header.

```jsx
// ===== BAKERY HOME VIEW =====
// Mounts the Archy-era region/day/driver flow, but filters window.REGIONS to
// only this bakery's regions. All other behavior is unchanged from the
// Plan 1 App.jsx.
function BakeryHomeView({bakeryId}){
  const[view,setView]=useState('ops');
  const[region,setRegion]=useState(null);
  const[statuses,setStatuses]=useState({});
  const[routeOverrides,setRouteOverrides]=useState({});
  const[syncing,setSyncing]=useState(true);
  const[bootErr,setBootErr]=useState('');
  const[archyCtx,setArchyCtx]=useState(null);
  const[bakeryName,setBakeryName]=useState('');
  const[,setDepotsRev]=useState(0);

  useEffect(()=>{
    if(!DB2.ready){setBootErr('Supabase not configured.');setSyncing(false);return;}
    let unsub=()=>{};
    (async()=>{
      try{
        const shape=await ArchyAdapter.buildLegacyShape();
        if(!shape){setBootErr('Archy migration has not run.');setSyncing(false);return;}
        window.REGIONS=shape.REGIONS;
        window.ROUTE_DATA=shape.ROUTE_DATA;
        setArchyCtx(shape.context);
        const myBakery=(shape.context.bakeries||[]).find(b=>b.id===bakeryId);
        setBakeryName(myBakery?myBakery.name:'(unknown bakery)');

        const myKey=Object.keys(shape.REGIONS).find(k=>shape.REGIONS[k]._bakeryId===bakeryId);
        if(myKey)setRegion(myKey);

        const rovrs={};
        for(const[k,data]of Object.entries(shape.ROUTE_DATA)){
          if(shape.REGIONS[k]._bakeryId!==bakeryId)continue;
          if(data.rebalanced||data.modified)rovrs[k]=data;
        }
        setRouteOverrides(rovrs);

        const s=await DB2.loadStatuses(shape.context.campaign.id);
        setStatuses(s);
        unsub=DB2.subscribeStatuses(shape.context.campaign.id,(next)=>setStatuses(next));
        setSyncing(false);
      }catch(e){console.error(e);setBootErr('Failed to load data.');setSyncing(false);}
    })();
    return()=>unsub();
  },[bakeryId]);

  const onDepotsChange=useCallback(async()=>{
    const shape=await ArchyAdapter.buildLegacyShape();
    if(shape){window.REGIONS=shape.REGIONS;window.ROUTE_DATA=shape.ROUTE_DATA;}
    setDepotsRev(v=>v+1);
  },[]);

  const onRebalance=useCallback((regionKey,newData)=>{
    setRouteOverrides(prev=>{
      const next={...prev};
      if(newData===null)delete next[regionKey];else next[regionKey]=newData;
      return next;
    });
    const r=window.REGIONS[regionKey];
    if(r&&r._bakeryId&&r._deliveryAreaId&&archyCtx){
      DB2.saveRoute(archyCtx.campaign.id,r._bakeryId,r._deliveryAreaId,newData);
    }
  },[archyCtx]);

  const getRouteData=useCallback((key)=>routeOverrides[key]||window.ROUTE_DATA?.[key],[routeOverrides]);

  const onAction=useCallback((id,action,note)=>{
    setStatuses(prev=>{
      const next={...prev};
      if(action==='delivered'){next[id]='delivered';next[id+'_time']=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});DB2.saveStatus(id,'delivered',null,next[id+'_photo']||null);}
      else if(action==='failed'){next[id]='failed';if(note)next[id+'_note']=note;DB2.saveStatus(id,'failed',note,null);}
      else if(action==='pending'){delete next[id];delete next[id+'_time'];delete next[id+'_note'];delete next[id+'_photo'];DB2.deleteStatus(id);}
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

  const handlePrint=()=>{/* identical to pre-Plan-2 App.handlePrint — reuse PrintSheet patterns */
    if(!region)return;const data=getRouteData(region);if(!data)return;
    let html='<html><head><style>*{font-family:DM Sans,sans-serif}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:4px;text-align:left}th{border-bottom:1px solid #333}tr{border-bottom:1px solid #eee}.driver{page-break-inside:avoid;margin-bottom:24px}</style></head><body>';
    html+=`<h1>${window.REGIONS[region].bakery} — ${window.REGIONS[region].name}</h1>`;
    data.days.forEach((dd,di)=>{html+=`<h2>Day ${di+1}</h2>`;dd.routes.forEach(r=>{if(!r.ns)return;html+=`<div class="driver"><h3>${DRIVER_NAMES[r.drv]} — ${r.ns} stops — ${fmtDuration(r.tt)}</h3>`;html+='<table><tr><th>#</th><th>ETA</th><th>Practice</th><th>Address</th><th>Contact</th><th>Phone</th><th>✓</th></tr>';r.stops.forEach((s,i)=>{html+=`<tr><td>${i+1}</td><td>${fmtTime(s.eta)}</td><td><b>${s.co}</b></td><td>${s.ad}, ${s.ci}</td><td>${s.cn}</td><td>${s.ph}</td><td>☐</td></tr>`;});html+='</table></div>';});});
    html+='</body></html>';
    const win=window.open('','_blank');win.document.write(html);win.document.close();setTimeout(()=>win.print(),500);
  };

  const regionEntries=Object.entries(window.REGIONS||{}).filter(([,r])=>r._bakeryId===bakeryId);
  const totalStops=regionEntries.reduce((a,[k])=>a+((window.ROUTE_DATA?.[k]?.ts)||0),0);
  const depotOverrides={};

  return <div className={`app-shell${view==='ops'||view==='map'?' wide':''}`}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}} className="no-print">
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{bakeryName||'Bakery'}</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}>{totalStops} deliveries · {regionEntries.length} region{regionEntries.length===1?'':'s'} · Archy × Daymaker Q2 2026
          {DB2.ready&&<span style={{marginLeft:6,color:'#16a34a'}}>● Live</span>}
          {!DB2.ready&&<span style={{marginLeft:6,color:'#f59e0b'}}>○ Offline</span>}
          {syncing&&<span style={{marginLeft:6,color:'#2563eb'}}>↻ Syncing...</span>}
        </span>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        {view==='ops'&&region&&<button onClick={handlePrint} style={{background:'#f1f5f9',color:'#475569',border:'none',borderRadius:8,padding:'8px 14px',fontSize:13,cursor:'pointer',fontWeight:500}}>🖨 Print routes</button>}
        <ProfileSwitcher/>
      </div>
    </div>

    {bootErr&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:8,marginBottom:12,fontSize:13}}>{bootErr}</div>}

    <div style={{display:'flex',gap:0,marginBottom:20,borderBottom:'1px solid #e2e8f0'}} className="no-print">
      {[{k:'ops',l:'Operations'},{k:'map',l:'🧁 Map'},{k:'customer',l:'Campaign'},{k:'photos',l:'Photos'}].map(t=>
        <button key={t.k} className={`view-tab ${view===t.k?'active':''}`} onClick={()=>setView(t.k)}>{t.l}</button>
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

- [ ] **Step 2: Smoke bakery scoping**

Pick "Boho Petite" from the landing picker. Expected:

- Heading reads "Boho Petite", not "Archy × Daymaker".
- The region tabs list only Boho Petite's regions (SF core, South Bay).
- Stops load; "Rebalance" and status toggles still work.
- "Switch profile" in header returns to landing.

Repeat for SmallCakes: tabs list only SmallCakes' regions. Confirm a mark-delivered write round-trips.

- [ ] **Step 3: Commit**

```bash
git add public/src/components/BakeryHomeView.jsx
git commit -m "BakeryHomeView: scope Archy ops flow to a single bakery"
```

---

## Task 6: CustomerEditor + CustomerHomeView

**Files:**
- Modify: `public/src/components/CustomerEditor.jsx` (replace stub)
- Modify: `public/src/components/CustomerHomeView.jsx` (replace stub)

- [ ] **Step 1: Replace CustomerEditor stub**

Replace `public/src/components/CustomerEditor.jsx` with:

```jsx
// ===== CUSTOMER EDITOR =====
// Flat form. Create generates an access_token for forward-compat even though
// no auth is enforced today.
function CustomerEditor({customerId,isNew}){
  const[name,setName]=useState('');
  const[email,setEmail]=useState('');
  const[loaded,setLoaded]=useState(isNew);
  const[saving,setSaving]=useState(false);
  const[err,setErr]=useState('');
  const[row,setRow]=useState(null);

  useEffect(()=>{
    if(isNew)return;
    (async()=>{
      try{
        const{customer}=await Admin.getCustomer(customerId);
        setRow(customer);setName(customer.name||'');setEmail(customer.contact_email||'');setLoaded(true);
      }catch(e){setErr(e.message);setLoaded(true);}
    })();
  },[customerId,isNew]);

  const save=async()=>{
    setSaving(true);setErr('');
    try{
      if(isNew){
        const created=await Admin.createCustomer({name,contact_email:email});
        navigate('#/admin/customer/'+created.id);
      }else{
        const updated=await Admin.updateCustomer(customerId,{name,contact_email:email});
        setRow(updated);
      }
    }catch(e){setErr(e.message);}
    setSaving(false);
  };

  if(!loaded)return <div style={{padding:40}}>Loading…</div>;

  const shareLink=row?window.location.origin+window.location.pathname+'?profile=customer:'+row.id+'#/customer/'+row.id:null;

  return <div className="app-shell">
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{isNew?'New customer':name||'Customer'}</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}><a href="#/admin" style={{color:'#2563eb'}}>← Admin</a></span>
      </div>
      <div style={{display:'flex',gap:8}}>
        <button className="btn-ghost" onClick={()=>navigate('#/admin')}>Cancel</button>
        <button className="btn-primary" disabled={saving||!name} onClick={save}>{saving?'Saving…':isNew?'Create customer':'Save'}</button>
      </div>
    </div>

    {err&&<div style={{background:'#fef2f2',color:'#991b1b',padding:12,borderRadius:8,marginBottom:12,fontSize:13}}>{err}</div>}

    <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,padding:20,maxWidth:560}}>
      <div className="admin-field"><label>Name</label><input value={name} onChange={e=>setName(e.target.value)}/></div>
      <div className="admin-field"><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)}/></div>
      {shareLink&&<div className="admin-section">
        <label style={{display:'block',color:'#6b7280',fontSize:12,fontWeight:500,marginBottom:4}}>Share link</label>
        <div style={{display:'flex',gap:6}}>
          <input readOnly value={shareLink} style={{flex:1,padding:'6px 10px',border:'1px solid #d1d5db',borderRadius:4,fontSize:12,fontFamily:'ui-monospace,Menlo,monospace'}}/>
          <button className="btn-ghost" onClick={()=>navigator.clipboard.writeText(shareLink)}>Copy</button>
        </div>
        <div style={{fontSize:11,color:'#9ca3af',marginTop:4}}>Auth is off in Plan 2; this link just pre-selects the profile.</div>
      </div>}
    </div>
  </div>;
}
```

- [ ] **Step 2: Replace CustomerHomeView stub**

Replace `public/src/components/CustomerHomeView.jsx` with:

```jsx
// ===== CUSTOMER HOME VIEW =====
// Read-only per-campaign dashboard. Plan 3 wires the "Upload campaign" CTA.
function CustomerHomeView({customerId}){
  const[state,setState]=useState({loading:true,customer:null,campaigns:[],counts:{},progress:{},err:''});

  useEffect(()=>{(async()=>{
    try{
      if(!sb){setState(s=>({...s,err:'Supabase not configured',loading:false}));return;}
      const{customer,campaigns}=await Admin.getCustomer(customerId);
      const counts={};const progress={};
      for(const camp of campaigns){
        const[{data:recips},{data:stats}]=await Promise.all([
          sb.from('recipients').select('assignment_status').eq('campaign_id',camp.id),
          sb.from('delivery_statuses_v2').select('status,recipients!inner(campaign_id)').eq('recipients.campaign_id',camp.id),
        ]);
        const countsByStatus={assigned:0,flagged_out_of_area:0,geocode_failed:0,needs_review:0};
        (recips||[]).forEach(r=>{countsByStatus[r.assignment_status]=(countsByStatus[r.assignment_status]||0)+1;});
        counts[camp.id]=countsByStatus;
        const total=(recips||[]).length;
        const delivered=(stats||[]).filter(s=>s.status==='delivered').length;
        progress[camp.id]={total,delivered};
      }
      setState({loading:false,customer,campaigns,counts,progress,err:''});
    }catch(e){setState(s=>({...s,err:e.message||String(e),loading:false}));}
  })();},[customerId]);

  const{loading,customer,campaigns,counts,progress,err}=state;
  if(loading)return <div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>Loading…</div>;
  if(err)return <div style={{padding:40,color:'#991b1b'}}>Failed: {err}</div>;

  return <div className="app-shell">
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
      <div>
        <h1 style={{fontSize:18,fontWeight:700,margin:0}}>{customer.name}</h1>
        <span style={{fontSize:12,color:'#94a3b8'}}>Campaigns · Delivery progress</span>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <button className="btn-primary" disabled title="Coming soon in Plan 3" style={{opacity:0.5,cursor:'not-allowed'}}>+ Upload campaign (coming soon)</button>
        <ProfileSwitcher/>
      </div>
    </div>

    {campaigns.length===0?<div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>No campaigns yet.</div>:
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        {campaigns.map(c=><CampaignCard key={c.id} campaign={c} counts={counts[c.id]} progress={progress[c.id]}/>)}
      </div>
    }
  </div>;
}

function CampaignCard({campaign,counts,progress}){
  const pct=progress&&progress.total?Math.round(100*progress.delivered/progress.total):0;
  return <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,padding:16}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
      <div style={{fontWeight:600}}>{campaign.name}</div>
      <div style={{fontSize:11,color:'#6b7280',textTransform:'uppercase',letterSpacing:'0.05em'}}>{campaign.status}</div>
    </div>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
      <CountPill label="Assigned" n={counts?.assigned||0} color="#2563eb"/>
      <CountPill label="Flagged" n={counts?.flagged_out_of_area||0} color="#dc2626"/>
      <CountPill label="Geocode failed" n={counts?.geocode_failed||0} color="#f59e0b"/>
      <CountPill label="Needs review" n={counts?.needs_review||0} color="#7c3aed"/>
    </div>
    <div style={{fontSize:12,color:'#6b7280',marginBottom:4}}>Delivered {progress?.delivered||0} of {progress?.total||0} ({pct}%)</div>
    <div style={{background:'#f3f4f6',height:6,borderRadius:3,overflow:'hidden'}}>
      <div style={{width:`${pct}%`,height:'100%',background:'#10b981',transition:'width 0.2s'}}></div>
    </div>
  </div>;
}

function CountPill({label,n,color}){
  return <div style={{display:'flex',alignItems:'center',gap:6,padding:'3px 10px',borderRadius:999,background:`${color}15`,color,fontSize:12,fontWeight:500}}>
    <span>{n}</span><span style={{opacity:0.7}}>{label}</span>
  </div>;
}
```

- [ ] **Step 3: Smoke**

1. From Admin, click "Edit" on Archy → CustomerEditor loads name "Archy" + email. Share link field shows `?profile=customer:<uuid>#/customer/<uuid>`. Click Cancel → back at admin list.
2. Click "+ New customer" → blank form. Type "Test Customer" + email, click Create customer → URL changes to `#/admin/customer/<newUuid>`. Name shows in header. Share link appears.
3. Refresh → form reloads with saved values.
4. Back to admin. Click "View as customer" on Archy → CustomerHomeView loads. Shows "Archy × Daymaker Q2 2026" campaign card with counts and a progress bar. Upload button is disabled and greyed out.
5. Click "Switch profile" → returns to landing. Delete test customer manually via Supabase MCP if desired.

- [ ] **Step 4: Commit**

```bash
git add public/src/components/CustomerEditor.jsx public/src/components/CustomerHomeView.jsx
git commit -m "CustomerEditor (create/edit) + CustomerHomeView (read-only campaign dashboard)"
```

---

## Task 7: BakeryEditor — sidebar form + DepotManager reuse (no map yet)

**Files:**
- Modify: `public/src/components/BakeryEditor.jsx` (replace stub with form + sidebar layout)

- [ ] **Step 1: Replace the stub**

Replace `public/src/components/BakeryEditor.jsx` with:

```jsx
// ===== BAKERY EDITOR (form + sidebar; map wired in Task 8) =====
function BakeryEditor({bakeryId,isNew}){
  const[name,setName]=useState('');
  const[email,setEmail]=useState('');
  const[phone,setPhone]=useState('');
  const[loaded,setLoaded]=useState(isNew);
  const[saving,setSaving]=useState(false);
  const[err,setErr]=useState('');
  const[bakery,setBakery]=useState(null);
  const[deliveryAreas,setDeliveryAreas]=useState([]);
  const[depots,setDepots]=useState([]);
  const[depotsRev,setDepotsRev]=useState(0);

  useEffect(()=>{
    if(isNew){setLoaded(true);return;}
    (async()=>{
      try{
        const{bakery:b,delivery_areas,depots:d}=await Admin.getBakery(bakeryId);
        setBakery(b);setName(b.name||'');setEmail(b.contact_email||'');setPhone(b.contact_phone||'');
        setDeliveryAreas(delivery_areas);setDepots(d);setLoaded(true);
      }catch(e){setErr(e.message);setLoaded(true);}
    })();
  },[bakeryId,isNew,depotsRev]);

  const refreshDepots=useCallback(async()=>{
    if(!bakery)return;
    const{depots:d}=await Admin.getBakery(bakery.id);
    setDepots(d);
  },[bakery]);

  const save=async()=>{
    setSaving(true);setErr('');
    try{
      if(isNew){
        const created=await Admin.createBakery({name,contact_email:email,contact_phone:phone});
        navigate('#/admin/bakery/'+created.id);
      }else{
        const updated=await Admin.updateBakery(bakeryId,{name,contact_email:email,contact_phone:phone});
        setBakery(updated);
      }
    }catch(e){setErr(e.message);}
    setSaving(false);
  };

  if(!loaded)return <div style={{padding:40}}>Loading…</div>;

  const shareLink=bakery?window.location.origin+window.location.pathname+'?profile=bakery:'+bakery.id+'#/bakery/'+bakery.id:null;

  return <div className="app-shell wide" style={{padding:0,display:'flex',height:'calc(100vh - 20px)'}}>
    <aside className="admin-sidebar">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <a href="#/admin" style={{color:'#2563eb',fontSize:12,textDecoration:'none'}}>← Admin</a>
        <ProfileSwitcher/>
      </div>
      <h1 style={{fontSize:18,fontWeight:700,margin:'0 0 16px'}}>{isNew?'New bakery':name||'Bakery'}</h1>

      {err&&<div style={{background:'#fef2f2',color:'#991b1b',padding:10,borderRadius:6,marginBottom:12,fontSize:12}}>{err}</div>}

      <h4>Details</h4>
      <div className="admin-field"><label>Name</label><input value={name} onChange={e=>setName(e.target.value)}/></div>
      <div className="admin-field"><label>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)}/></div>
      <div className="admin-field"><label>Phone</label><input value={phone} onChange={e=>setPhone(e.target.value)}/></div>

      <div className="admin-section">
        <h4>Delivery areas ({deliveryAreas.length})</h4>
        <div style={{fontSize:12,color:'#9ca3af'}}>Polygon draw tools arrive in Task 8. Existing areas are listed below.</div>
        <ul style={{listStyle:'none',padding:0,margin:'8px 0 0'}}>
          {deliveryAreas.map(a=><li key={a.id} style={{padding:'6px 0',fontSize:12,color:'#374151'}}>{a.name||'(unnamed area)'}</li>)}
        </ul>
      </div>

      {!isNew&&<div className="admin-section">
        <h4>Depots ({depots.length})</h4>
        <DepotManager depots={depots} bakeryId={bakery.id} onChange={refreshDepots}/>
      </div>}

      {shareLink&&<div className="admin-section">
        <label style={{display:'block',color:'#6b7280',fontSize:12,fontWeight:500,marginBottom:4}}>Share link</label>
        <div style={{display:'flex',gap:6}}>
          <input readOnly value={shareLink} style={{flex:1,padding:'6px 10px',border:'1px solid #d1d5db',borderRadius:4,fontSize:11,fontFamily:'ui-monospace,Menlo,monospace'}}/>
          <button className="btn-ghost" onClick={()=>navigator.clipboard.writeText(shareLink)}>Copy</button>
        </div>
        <div style={{fontSize:11,color:'#9ca3af',marginTop:4}}>Auth is off in Plan 2; this link just pre-selects the profile.</div>
      </div>}

      <div style={{position:'sticky',bottom:0,background:'#fff',paddingTop:14,marginTop:14,borderTop:'1px solid #f3f4f6',display:'flex',gap:8,justifyContent:'flex-end'}}>
        <button className="btn-ghost" onClick={()=>navigate('#/admin')}>Cancel</button>
        <button className="btn-primary" disabled={saving||!name} onClick={save}>{saving?'Saving…':isNew?'Create bakery':'Save'}</button>
      </div>
    </aside>

    <main style={{flex:1,background:'#f3f4f6',display:'flex',alignItems:'center',justifyContent:'center',color:'#9ca3af',fontSize:13}}>
      Map · polygon drawing wired up in Task 8.
    </main>
  </div>;
}
```

Note: the existing `DepotManager` expects props `depots, bakeryId, onChange`. Verify that signature is correct against the current component — if the real signature differs, adjust this task before merging.

- [ ] **Step 2: Verify DepotManager signature**

Open `public/src/components/DepotManager.jsx`. If the prop names differ from `{depots, bakeryId, onChange}`, adjust the snippet above to match its actual interface. Document any signature change by noting it in the commit message.

- [ ] **Step 3: Smoke**

1. Admin → "+ New bakery" → form appears, map pane is a placeholder. Fill "Test Bakery", email, phone → "Create bakery" → URL becomes `#/admin/bakery/<newUuid>`.
2. Refresh → form reloads with saved values. Delivery areas section says "0" (no draw yet). Depots section shows DepotManager with 0 depots, plus its "Add depot" affordance.
3. Add a depot via the DepotManager address autocomplete → depot row appears under "Depots".
4. Rename the bakery → Save → name persists after refresh.
5. Click "View as bakery →" from admin — Wait, that's on the list page. From the editor, use the back link. On the admin list, click "View as bakery →" for Test Bakery → BakeryHomeView stub/empty state (no campaigns yet for this bakery, expected).
6. Delete the test bakery via Supabase MCP when done (Plan 2 deliberately omits deletion UI).

- [ ] **Step 4: Commit**

```bash
git add public/src/components/BakeryEditor.jsx
git commit -m "BakeryEditor: sidebar form + DepotManager integration (map placeholder)"
```

---

## Task 8: BakeryEditor — map + mapbox-gl-draw + overlap warnings

**Files:**
- Create: `public/src/admin/overlap.js`
- Create: `public/src/admin/__tests__/overlap.test.mjs`
- Modify: `public/index.html` (add mapbox-gl-draw + turf CDN scripts)
- Modify: `public/src/components/BakeryEditor.jsx` (replace the map placeholder with a real map)

- [ ] **Step 1: Add draw + turf CDN scripts to index.html**

Modify `public/index.html`. After the maplibre-gl script/link pair, add:

```html
  <!-- Polygon draw tools + polygon math (Plan 2) -->
  <script src="https://unpkg.com/@mapbox/mapbox-gl-draw@1.4.3/dist/mapbox-gl-draw.js"></script>
  <link href="https://unpkg.com/@mapbox/mapbox-gl-draw@1.4.3/dist/mapbox-gl-draw.css" rel="stylesheet"/>
  <script src="https://unpkg.com/mapbox-gl-draw-rectangle-mode@1.0.4/dist/mapbox-gl-draw-rectangle-mode.js"></script>
  <script src="https://unpkg.com/@turf/turf@7/turf.min.js"></script>
```

- [ ] **Step 2: Write the overlap test**

Create `public/src/admin/__tests__/overlap.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load Turf from disk if available; otherwise expect the suite to be run in
// an environment where a `turf` global exists. For CI the simplest path is
// to install @turf/turf in this directory.
const turfSrc = path.resolve(__dirname, '../../../../node_modules/@turf/turf/turf.min.js');
if (fs.existsSync(turfSrc)) {
  const mod = await import('@turf/turf');
  globalThis.turf = mod;
}

const src = fs.readFileSync(path.resolve(__dirname, '../overlap.js'), 'utf8');
const ctx = { turf: globalThis.turf };
new Function('turf', 'ctx', src + '\nctx.anyOverlap = anyOverlap; ctx.polygon = poly => poly;')(ctx.turf, ctx);
const { anyOverlap } = ctx;

function poly(coords) {
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

test('disjoint polygons report no overlap', () => {
  const a = poly([[0,0],[0,1],[1,1],[1,0],[0,0]]);
  const b = poly([[2,2],[2,3],[3,3],[3,2],[2,2]]);
  assert.equal(anyOverlap(a, [b]), false);
});

test('polygons sharing only an edge do not overlap', () => {
  const a = poly([[0,0],[0,1],[1,1],[1,0],[0,0]]);
  const b = poly([[1,0],[1,1],[2,1],[2,0],[1,0]]);
  assert.equal(anyOverlap(a, [b]), false);
});

test('truly overlapping polygons are flagged', () => {
  const a = poly([[0,0],[0,2],[2,2],[2,0],[0,0]]);
  const b = poly([[1,1],[1,3],[3,3],[3,1],[1,1]]);
  assert.equal(anyOverlap(a, [b]), true);
});

test('a fully contained polygon is flagged', () => {
  const outer = poly([[0,0],[0,10],[10,10],[10,0],[0,0]]);
  const inner = poly([[2,2],[2,3],[3,3],[3,2],[2,2]]);
  assert.equal(anyOverlap(inner, [outer]), true);
});

test('overlap flag counts across a list', () => {
  const a = poly([[0,0],[0,2],[2,2],[2,0],[0,0]]);
  const b = poly([[5,5],[5,6],[6,6],[6,5],[5,5]]);
  const c = poly([[1,1],[1,3],[3,3],[3,1],[1,1]]);
  assert.equal(anyOverlap(a, [b]), false);
  assert.equal(anyOverlap(a, [b, c]), true);
});
```

Create `public/src/admin/__tests__/package.json`:

```json
{
  "name": "overlap-test",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test overlap.test.mjs" },
  "dependencies": { "@turf/turf": "^7.0.0" }
}
```

- [ ] **Step 3: Verify the test fails (overlap.js does not exist yet)**

```bash
cd public/src/admin/__tests__ && npm install && npm test
```

Expected: fails with `ENOENT` on `overlap.js` or `anyOverlap is not a function`.

- [ ] **Step 4: Implement overlap.js**

Create `public/src/admin/overlap.js`:

```js
// ===== OVERLAP HELPER =====
// Returns true if `feature` overlaps any feature in `others`. Edge-only
// contact does not count as overlap (booleanOverlap returns false for it).
// Full containment is counted as overlap via booleanContains either way.
function anyOverlap(feature, others) {
  if (!feature || !Array.isArray(others) || others.length === 0) return false;
  if (typeof turf === 'undefined') return false;
  for (const o of others) {
    if (!o || !o.geometry) continue;
    try {
      if (turf.booleanOverlap(feature, o)) return true;
      if (turf.booleanContains(feature, o)) return true;
      if (turf.booleanContains(o, feature)) return true;
    } catch (e) { /* skip malformed geometry */ }
  }
  return false;
}

if (typeof window !== 'undefined') window.anyOverlap = anyOverlap;
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd public/src/admin/__tests__ && npm test
```

Expected: all 5 tests pass.

- [ ] **Step 6: Load overlap.js in index.html**

Modify `public/index.html`. After the `admin.js` script tag:

```html
  <script src="./src/admin/overlap.js"></script>
```

- [ ] **Step 7: Replace the map placeholder in BakeryEditor**

Modify `public/src/components/BakeryEditor.jsx`. Find the `<main>` element (the placeholder from Task 7) and replace it with the full draw-enabled map. Also add the `BakeryEditorMap` child component inside the same file:

```jsx
// Inside BakeryEditor, replace the <main>...</main> placeholder with:
    <main style={{flex:1,position:'relative'}}>
      <BakeryEditorMap
        bakery={bakery}
        deliveryAreas={deliveryAreas}
        depots={depots}
        onDeliveryAreasSaved={newList=>setDeliveryAreas(newList)}
      />
    </main>
```

Append this component definition at the bottom of the same file:

```jsx
// ===== BAKERY EDITOR MAP =====
// Loads existing delivery_areas into mapbox-gl-draw, tracks feature ↔ row
// correspondence, saves diffs on demand.
function BakeryEditorMap({bakery,deliveryAreas,depots,onDeliveryAreasSaved}){
  const containerRef=useRef(null);
  const mapRef=useRef(null);
  const drawRef=useRef(null);
  const[overlapBanner,setOverlapBanner]=useState('');
  const[saving,setSaving]=useState(false);
  const[saveErr,setSaveErr]=useState('');

  // featureId → { rowId, snapshotGeom } for change detection
  const featureMapRef=useRef(new Map());
  // allPolygons (from all bakeries, used for overlap check against OTHER bakeries' areas)
  const otherFeaturesRef=useRef([]);

  useEffect(()=>{
    if(!containerRef.current||typeof maplibregl==='undefined'||typeof MapboxDraw==='undefined')return;
    // MapboxDraw + MapLibre compat shim — see Mapbox GL Draw maplibre docs.
    // Polyfills are the widely-used two-line fix that lets Draw treat MapLibre
    // as Mapbox GL JS.
    MapboxDraw.constants.classes.CONTROL_BASE='maplibregl-ctrl';
    MapboxDraw.constants.classes.CONTROL_PREFIX='maplibregl-ctrl-';
    MapboxDraw.constants.classes.CONTROL_GROUP='maplibregl-ctrl-group';

    const map=new maplibregl.Map({
      container:containerRef.current,
      style:'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
      center:[-98,39],zoom:3,attributionControl:false,
    });
    map.addControl(new maplibregl.AttributionControl({compact:true}));
    map.addControl(new maplibregl.NavigationControl(),'top-left');

    const modes={...MapboxDraw.modes,draw_rectangle:DrawRectangle};
    const draw=new MapboxDraw({displayControlsDefault:false,controls:{polygon:true,trash:true},modes});
    map.addControl(draw,'top-right');

    mapRef.current=map;drawRef.current=draw;

    map.on('load',async()=>{
      // Load existing areas as draw features, track id correspondence
      const fmap=new Map();
      const bounds=new maplibregl.LngLatBounds();let hasBounds=false;
      for(const a of (deliveryAreas||[])){
        const feature={type:'Feature',geometry:a.geometry,properties:{name:a.name||''}};
        const[id]=draw.add(feature);
        fmap.set(id,{rowId:a.id,snapshotGeom:JSON.stringify(a.geometry)});
        extendBoundsFromGeom(bounds,a.geometry);hasBounds=true;
      }
      featureMapRef.current=fmap;

      // Plot depot pins (read-only)
      for(const d of (depots||[])){
        if(typeof d.lat!=='number'||typeof d.lon!=='number')continue;
        const el=document.createElement('div');
        el.style.cssText='width:18px;height:18px;background:#dc2626;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.3);';
        new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([d.lon,d.lat]).addTo(map);
        bounds.extend([d.lon,d.lat]);hasBounds=true;
      }

      if(hasBounds)map.fitBounds(bounds,{padding:40,duration:0});

      // Load OTHER bakeries' areas for overlap checks
      if(sb){
        const myBakeryId=bakery?bakery.id:null;
        const q=sb.from('delivery_areas').select('bakery_id,geometry');
        const{data}=await q;
        otherFeaturesRef.current=(data||[])
          .filter(r=>r.bakery_id!==myBakeryId)
          .map(r=>({type:'Feature',geometry:r.geometry,properties:{}}));
      }
    });

    // Draw event handlers — run overlap check on create/update
    const onChange=()=>{
      const features=draw.getAll().features;
      let overlapCount=0;
      for(const f of features){
        const ownOthers=features.filter(x=>x.id!==f.id);
        if(anyOverlap(f,[...ownOthers,...otherFeaturesRef.current])){overlapCount++;}
      }
      setOverlapBanner(overlapCount>0?`${overlapCount} drawn area(s) overlap with other polygons. Plan 2 allows this; the first match wins during assignment.`:'');
    };
    map.on('draw.create',onChange);
    map.on('draw.update',onChange);
    map.on('draw.delete',onChange);

    return()=>{
      try{map.remove();}catch(e){}
      mapRef.current=null;drawRef.current=null;
    };
  // Intentionally mount once per bakery — deliveryAreas is used for initial fill only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[bakery?.id]);

  const saveAreas=async()=>{
    const draw=drawRef.current;if(!draw||!bakery)return;
    setSaving(true);setSaveErr('');
    const features=draw.getAll().features;
    const fmap=featureMapRef.current;
    const seenRowIds=new Set();
    const inserts=[];const updates=[];
    for(const f of features){
      const tracked=fmap.get(f.id);
      if(tracked){
        seenRowIds.add(tracked.rowId);
        if(JSON.stringify(f.geometry)!==tracked.snapshotGeom){
          updates.push({id:tracked.rowId,bakery_id:bakery.id,name:f.properties?.name||null,geometry:f.geometry});
        }
      }else{
        inserts.push({bakery_id:bakery.id,name:f.properties?.name||null,geometry:f.geometry,_drawId:f.id});
      }
    }
    const deletes=[];
    for(const[drawId,info] of fmap.entries()){
      if(!draw.get(drawId))deletes.push(info.rowId);
    }
    try{
      for(const u of updates){await Admin.upsertDeliveryArea(u);}
      for(const i of inserts){
        const inserted=await Admin.upsertDeliveryArea({bakery_id:i.bakery_id,name:i.name,geometry:i.geometry});
        fmap.set(i._drawId,{rowId:inserted.id,snapshotGeom:JSON.stringify(inserted.geometry)});
      }
      for(const rowId of deletes){await Admin.deleteDeliveryArea(rowId);fmap.forEach((v,k)=>{if(v.rowId===rowId)fmap.delete(k);});}
      // Refresh snapshots for updated rows
      updates.forEach(u=>{
        fmap.forEach((v,k)=>{if(v.rowId===u.id){fmap.set(k,{rowId:u.id,snapshotGeom:JSON.stringify(u.geometry)});}});
      });
      if(onDeliveryAreasSaved){
        const{delivery_areas}=await Admin.getBakery(bakery.id);
        onDeliveryAreasSaved(delivery_areas);
      }
    }catch(e){setSaveErr(e.message||String(e));}
    setSaving(false);
  };

  return <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column'}}>
    {overlapBanner&&<div style={{background:'#fef3c7',color:'#92400e',padding:10,fontSize:12}}>{overlapBanner}</div>}
    {saveErr&&<div style={{background:'#fef2f2',color:'#991b1b',padding:10,fontSize:12}}>{saveErr}</div>}
    <div ref={containerRef} style={{flex:1}}/>
    <div style={{position:'absolute',bottom:12,right:12,display:'flex',gap:8}}>
      <button className="btn-primary" onClick={saveAreas} disabled={saving||!bakery}>{saving?'Saving…':'Save areas'}</button>
    </div>
  </div>;
}

function extendBoundsFromGeom(bounds,geom){
  const rings=geom.type==='Polygon'?geom.coordinates:geom.type==='MultiPolygon'?geom.coordinates.flat():[];
  for(const ring of rings){for(const[lon,lat] of ring){bounds.extend([lon,lat]);}}
}
```

- [ ] **Step 8: Smoke the draw flow**

1. Admin → edit Boho Petite. Map loads, two existing polygons render (SF core + South Bay convex hulls from the Archy migration). Depots appear as red pins. Camera fits to them.
2. Click the polygon tool in the top-right control; draw a new triangle in the bay area → release → the banner reads "1 drawn area(s) overlap …" (new polygon likely overlaps existing SF core).
3. Click "Save areas" → toast-free save. Reload the page → the new polygon is still there, confirmed via Admin.getBakery showing 3 delivery_areas.
4. Click the trash control → delete the new polygon → Save areas → page reload → back to 2 areas.
5. Drag a vertex of SF core → overlap banner updates → Save → refresh → the updated geometry persists.
6. Create a brand-new bakery (Task 7 flow), open it in the editor, draw a polygon in an empty area → save → refresh → polygon persists.

- [ ] **Step 9: Commit**

```bash
git add public/src/admin/ public/src/components/BakeryEditor.jsx public/index.html
git commit -m "BakeryEditor map: MapLibre + mapbox-gl-draw polygon CRUD + overlap warnings"
```

---

## Task 9: ProfileSwitcher dropdown

**Files:**
- Modify: `public/src/components/ProfileSwitcher.jsx` (replace stub with real dropdown)

- [ ] **Step 1: Replace the stub with a real dropdown**

Replace `public/src/components/ProfileSwitcher.jsx` with:

```jsx
// ===== PROFILE SWITCHER =====
// Dropdown in every view's header. Lists Admin + all bakeries + all customers.
// Clicking an entry calls window.switchProfile() which updates localStorage,
// sets the hash, and reloads.
function ProfileSwitcher(){
  const current=window.__CURRENT_PROFILE__||{type:'landing'};
  const[open,setOpen]=useState(false);
  const[bakeries,setBakeries]=useState([]);
  const[customers,setCustomers]=useState([]);
  const[loaded,setLoaded]=useState(false);
  const ref=useRef(null);

  useEffect(()=>{
    if(!open||loaded)return;
    (async()=>{
      try{
        const[b,c]=await Promise.all([Admin.listBakeries(),Admin.listCustomers()]);
        setBakeries(b);setCustomers(c);setLoaded(true);
      }catch(e){console.warn('ProfileSwitcher load failed:',e);}
    })();
  },[open,loaded]);

  useEffect(()=>{
    if(!open)return;
    const onDoc=(e)=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener('mousedown',onDoc);
    return()=>document.removeEventListener('mousedown',onDoc);
  },[open]);

  const label=current.type==='admin'?'Admin':
    current.type==='bakery'?('Bakery: '+(bakeries.find(b=>b.id===current.id)?.name||'…')):
    current.type==='customer'?('Customer: '+(customers.find(c=>c.id===current.id)?.name||'…')):'Profile';

  return <div style={{position:'relative'}} ref={ref}>
    <button className="btn-ghost" onClick={()=>setOpen(o=>!o)}>{label} ▾</button>
    {open&&<div style={{
      position:'absolute',right:0,top:'calc(100% + 4px)',background:'#fff',border:'1px solid #e5e7eb',
      borderRadius:6,boxShadow:'0 4px 12px rgba(0,0,0,0.08)',padding:6,minWidth:220,zIndex:10,fontSize:13
    }}>
      <SwitchItem label="Admin" active={current.type==='admin'} onClick={()=>window.switchProfile({type:'admin',id:null})}/>
      <div style={{fontSize:11,color:'#9ca3af',padding:'6px 10px 2px',textTransform:'uppercase',letterSpacing:'0.05em'}}>Bakeries</div>
      {bakeries.map(b=><SwitchItem key={b.id} label={b.name} active={current.type==='bakery'&&current.id===b.id} onClick={()=>window.switchProfile({type:'bakery',id:b.id})}/>)}
      <div style={{fontSize:11,color:'#9ca3af',padding:'6px 10px 2px',textTransform:'uppercase',letterSpacing:'0.05em'}}>Customers</div>
      {customers.map(c=><SwitchItem key={c.id} label={c.name} active={current.type==='customer'&&current.id===c.id} onClick={()=>window.switchProfile({type:'customer',id:c.id})}/>)}
      <div style={{borderTop:'1px solid #f3f4f6',marginTop:6,paddingTop:6}}>
        <SwitchItem label="Sign out" active={false} onClick={()=>window.signOutProfile()}/>
      </div>
    </div>}
  </div>;
}

function SwitchItem({label,active,onClick}){
  return <button onClick={onClick} style={{
    display:'block',width:'100%',textAlign:'left',padding:'6px 10px',border:0,borderRadius:3,
    background:active?'#eff6ff':'transparent',color:active?'#1d4ed8':'#111827',
    fontWeight:active?500:400,cursor:'pointer',fontSize:13
  }}>{label}</button>;
}
```

- [ ] **Step 2: Smoke**

1. Pick Admin. Top-right "Admin ▾" button opens a dropdown listing: Admin (highlighted), four bakeries, one customer, Sign out.
2. Click a bakery → reload → BakeryHomeView for that bakery, label reads "Bakery: <name>".
3. Open dropdown → click Admin → back to admin view.
4. From Admin, click "View as customer →" on Archy → CustomerHomeView, label "Customer: Archy".
5. Open dropdown → Sign out → landing picker.

- [ ] **Step 3: Commit**

```bash
git add public/src/components/ProfileSwitcher.jsx
git commit -m "ProfileSwitcher: full dropdown with bakeries/customers and sign-out"
```

---

## Task 10: End-to-end smoke + cleanup

**Files:**
- No code changes; this task is verification + final polish commits only.

- [ ] **Step 1: Run the full smoke path from the spec**

Verify each of the eight steps in the spec's "Manual smoke path":

1. Landing picker renders with four bakeries + one customer.
2. Enter admin. Create "Test Bakery", draw two polygons, add one depot. Save.
3. Refresh → new bakery appears in list with token populated (check DevTools: `Admin.listBakeries().then(console.log)`).
4. Click "View as →" on the new bakery → BakeryHomeView mounts. No campaigns yet (expected — nothing seeded for this bakery).
5. Switch back to admin via dropdown. Polygon edits persist.
6. Click "View as →" on Boho Petite → OpsView mounts, scoped to Boho Petite's Archy campaign slice. Regions, stops, depots render as before.
7. "View as →" on Archy customer → CustomerHomeView shows the Archy × Daymaker Q2 2026 campaign with recipient counts. Upload button is disabled.
8. Delete one of the test bakery's polygons from the map → save → row disappears in DB (confirm via Supabase MCP SQL: `select count(*) from delivery_areas where bakery_id = '<test-id>'`).

- [ ] **Step 2: Run the two test suites one last time**

```bash
cd scripts/admin-db && npm test
cd public/src/admin/__tests__ && npm test
```

Expected: both suites pass.

- [ ] **Step 3: Clean up the test bakery**

Via Supabase MCP `execute_sql`:

```sql
delete from delivery_areas where bakery_id in (select id from bakeries where name like 'Test %');
delete from depots where bakery_id in (select id from bakeries where name like 'Test %');
delete from bakeries where name like 'Test %';
delete from customers where name like 'Test %';
```

- [ ] **Step 4: Final commit**

If any trailing tweaks (CSS, copy, tiny fixes) accumulated during the smoke test, commit them with a final:

```bash
git add -A
git commit -m "plan 2: final smoke fixes"
```

If nothing changed, skip this step.

---

## Notes on Plan 1 artifacts that remain unused

- `public/src/config/supabase.js → makeTenantClient` — still exported, still unused in Plan 2.
- `supabase/migrations/004_rls.sql` + `005_rls_fix_recursion.sql` — helper functions stay in the DB; their policies are overridden by 006's permissive ones.
- `scripts/print-tenant-tokens` — keeps working; it just prints tokens nothing enforces today.

All three come back alive when a later plan re-enables auth.
