# Manual Recipient Entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer add recipients to a campaign one at a time via a modal form (with Mapbox-powered address autocomplete that fills city/state/zip), as both an alternative to file upload on Step 1 and an "add more" affordance on Step 3 of the existing UploadWizard.

**Architecture:** A new edge sub-route `POST /ingest-recipients/manual-add` composes the existing `geocodeRows` + `loadAreas` + `findAreaIn` + `bucketFor` + `legacyId` helpers to insert a single recipient with the same bucketing semantics as bulk ingest. On the browser, we extract the existing `AddressAutocomplete` from `DepotManager.jsx` into a shared component, extend `retrieveAddress` to surface city/state/zip from Mapbox's `properties.context`, and add a `ManualRecipientForm` modal mounted from two places in `UploadWizard`.

**Tech Stack:** Deno + `@supabase/supabase-js` (edge function); React 18 (babel-standalone, JSX compiled in-browser via `<script type="text/babel">`); Mapbox Searchbox v1 suggest+retrieve; Node 18+ `node:test` for the pure parser unit test; Deno test runner for the edge integration test.

Spec: `docs/superpowers/specs/2026-04-20-manual-recipient-entry-design.md`.

---

## File structure

### Creates

- `public/src/components/AddressAutocomplete.jsx` — extracted from `DepotManager.jsx`, exposes `window.AddressAutocomplete`. Single responsibility: typeahead address input that calls `onValueChange(text)` on every keystroke and `onPick({address, city, state, zip, lat, lon} | null)` when the user selects/clears a suggestion.
- `public/src/components/ManualRecipientForm.jsx` — modal form for entering one recipient at a time. Props: `{campaignId, onSaved, onClose}`. Uses `AddressAutocomplete` and calls `Customer.addRecipient()`.
- `public/src/utils/__tests__/retrieve-address.test.mjs` — Node test runner for the new `parseRetrieveContext()` pure helper (extracted from `retrieveAddress` so it's testable without mocking `fetch`).
- `public/src/utils/__tests__/package.json` — `npm test` → `node --test retrieve-address.test.mjs`.

### Modifies

- `public/src/utils/geocode.js` — extend `retrieveAddress` to return `{lat, lon, address, city, state, zip}` (currently returns `{lat, lon, address}`). Extract a pure `parseRetrieveContext(properties)` helper that maps Mapbox's `properties.context` object to those four address strings. Existing callers (`DepotManager` via `AddressAutocomplete`) ignore the new fields and keep working.
- `public/src/components/DepotManager.jsx` — delete the inline `AddressAutocomplete` definition (lines 1–79). Component is now sourced from the new shared file via `window.AddressAutocomplete`. No behavior change for depot editing.
- `public/src/db/customer.js` — add `Customer.addRecipient({campaign_id, ...fields, lat?, lon?})` that POSTs to the new sub-route and returns the parsed JSON.
- `public/src/components/UploadWizard.jsx` — three changes:
  1. **Step 1**: render an "or" divider + "Add recipients one at a time" secondary button under the dropzone. Track entry mode in a new `entryMode` state (`'file' | 'manual'`). Continue button creates the draft campaign and routes to Step 2 (file mode) or Step 3 (manual mode).
  2. **Step 3 (Review)**: render a "+ Add recipient" button above the bucket tabs (always visible). Mount `<ManualRecipientForm>` as a modal when toggled. Render an empty-state panel (instead of bucket tabs) when `recipients.length === 0`.
  3. **Step 3 footer**: disable "Continue to designs ›" + show hint text when `recipients.length === 0`.
- `supabase/functions/ingest-recipients/index.ts` — add a `handleManualAdd(req, sb)` function and dispatch to it when the URL ends with `/manual-add`. Reuses `geocodeRows`, `loadAreas`, `findAreaIn`, `bucketFor`, `legacyId`. Uses `(campaign_id, legacy_id)` lookup for duplicate detection.
- `supabase/functions/ingest-recipients/test.ts` — add one `Deno.test` covering the manual-add success path with all 8 fields + lat/lon supplied.
- `public/index.html` — add two `<script type="text/babel">` tags for the new components. `AddressAutocomplete.jsx` MUST load **before** both `DepotManager.jsx` and `ManualRecipientForm.jsx` (which both reference it). `ManualRecipientForm.jsx` MUST load **before** `UploadWizard.jsx`. Bump the `__BUILD__` cache-buster.
- `public/src/styles.css` — add the modal classes (`.modal-backdrop`, `.modal-card`, `.manual-form`, `.manual-form-grid`, `.wizard-add-bar`, `.wizard-empty-cta`).

### Deletes

- Nothing. The inline `AddressAutocomplete` in `DepotManager.jsx` is replaced by an import-by-globals reference; no other code is removed.

---

## Task ordering rationale

- **Task 1** is the pure-helper foundation: extract + extend `retrieveAddress` with a unit test. No UI yet, no risk of breaking anything visible.
- **Task 2** extracts `AddressAutocomplete` into its own file and rewires `DepotManager` to use it. Verified by manual smoke (depot edit still works) — no observable change.
- **Task 3** lands the new `manual-add` edge sub-route + a Deno integration test against the real Supabase project. Independent of every UI task.
- **Task 4** adds the thin client wrapper `Customer.addRecipient()`. One file, one method.
- **Task 5** builds the `ManualRecipientForm` modal in isolation (no UploadWizard wiring yet). Visually verifiable by mounting it from a temporary harness or by directly proceeding to Task 6.
- **Task 6** wires both entry points into `UploadWizard`, including skip-Step-2 routing and the empty-state panel. The user-visible change lands here.
- **Task 7** is the CSS + cache-buster bump + final smoke pass.

Each task is independently committable and reviewable.

---

## Task 1: Extract `parseRetrieveContext` and extend `retrieveAddress`

**Files:**
- Modify: `public/src/utils/geocode.js`
- Create: `public/src/utils/__tests__/retrieve-address.test.mjs`
- Create: `public/src/utils/__tests__/package.json`

- [ ] **Step 1: Write the failing test**

Create `public/src/utils/__tests__/package.json`:

```json
{
  "name": "geocode-utils-tests",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test retrieve-address.test.mjs" }
}
```

Create `public/src/utils/__tests__/retrieve-address.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// We can't `import` geocode.js directly — it's a classic browser script that
// hangs assignments off `window`. Read it as text, strip the `window.*`
// re-exports, and re-eval as ESM by appending an `export {…}` line.
const src = readFileSync(new URL('../geocode.js', import.meta.url), 'utf8');
const stripped = src.replace(/window\.[A-Za-z]+\s*=\s*[A-Za-z]+;?/g, '')
  + '\nexport { parseRetrieveContext };\n';
const blobUrl = 'data:text/javascript;base64,' + Buffer.from(stripped).toString('base64');
const { parseRetrieveContext } = await import(blobUrl);

test('parses a full Mapbox Searchbox v1 retrieve context', () => {
  const properties = {
    full_address: '330 Main St, San Francisco, California 94105, United States',
    context: {
      address: { name: '330 Main St' },
      place:   { name: 'San Francisco' },
      region:  { name: 'California', region_code: 'CA' },
      postcode:{ name: '94105' },
    },
  };
  assert.deepEqual(parseRetrieveContext(properties), {
    address: '330 Main St',
    city: 'San Francisco',
    state: 'CA',
    zip: '94105',
  });
});

test('falls back to top-level address when context.address is missing', () => {
  const properties = {
    full_address: '330 Main St, SF, CA',
    address: '330 Main St',
    context: {
      place:   { name: 'SF' },
      region:  { region_code: 'CA' },
    },
  };
  assert.deepEqual(parseRetrieveContext(properties), {
    address: '330 Main St',
    city: 'SF',
    state: 'CA',
    zip: null,
  });
});

test('returns null for missing pieces, never throws on partial input', () => {
  assert.deepEqual(parseRetrieveContext({}), {
    address: null, city: null, state: null, zip: null,
  });
  assert.deepEqual(parseRetrieveContext({ context: null }), {
    address: null, city: null, state: null, zip: null,
  });
});

test('prefers region.region_code (2-letter) over region.name', () => {
  const out = parseRetrieveContext({
    context: { region: { name: 'California', region_code: 'CA' } },
  });
  assert.equal(out.state, 'CA');
});

test('falls back to region.name when region_code is missing', () => {
  const out = parseRetrieveContext({
    context: { region: { name: 'CA' } },
  });
  assert.equal(out.state, 'CA');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd public/src/utils/__tests__ && npm test`

Expected: FAIL with `parseRetrieveContext is not a function` (or similar — the symbol doesn't exist yet).

- [ ] **Step 3: Add `parseRetrieveContext` and use it inside `retrieveAddress`**

In `public/src/utils/geocode.js`, immediately above `async function retrieveAddress(...)`, insert:

```js
// Pure helper — pulls structured address pieces out of a Mapbox Searchbox v1
// `feature.properties` object. Returns nulls for absent pieces; never throws.
// Extracted as its own function so the manual-add form can autofill the
// city / state / zip inputs the moment the user picks a suggestion (and so
// the parser is unit-testable without mocking fetch).
function parseRetrieveContext(properties) {
  const ctx = (properties && properties.context) || {};
  const address =
    (ctx.address && ctx.address.name) ||
    properties?.address ||
    null;
  const city = (ctx.place && ctx.place.name) || null;
  const state =
    (ctx.region && (ctx.region.region_code || ctx.region.name)) || null;
  const zip = (ctx.postcode && ctx.postcode.name) || null;
  return { address, city, state, zip };
}
```

Replace the body of `retrieveAddress` (the `if (!f) return null;` … `return { lat, lon, address: ... };` portion) with:

```js
    if (!f) return null;
    const [lon, lat] = f.geometry?.coordinates || [];
    const parts = parseRetrieveContext(f.properties || {});
    return {
      lat, lon,
      address: f.properties?.full_address || f.properties?.place_formatted || parts.address || f.properties?.name || '',
      street: parts.address,  // raw street line without city/state suffix
      city:   parts.city,
      state:  parts.state,
      zip:    parts.zip,
    };
```

At the bottom of the file, alongside the existing `window.suggestAddress = …` lines, add:

```js
window.parseRetrieveContext = parseRetrieveContext;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd public/src/utils/__tests__ && npm test`

Expected: `# pass 5` (all five tests pass).

- [ ] **Step 5: Commit**

```bash
git add public/src/utils/geocode.js public/src/utils/__tests__/
git commit -m "feat(geocode): parse city/state/zip out of Mapbox retrieve context

Adds parseRetrieveContext() and threads its output through retrieveAddress
so callers get {address, street, city, state, zip} alongside lat/lon.
Existing callers ignoring the new fields keep working unchanged."
```

---

## Task 2: Extract `AddressAutocomplete` into its own component

**Files:**
- Create: `public/src/components/AddressAutocomplete.jsx`
- Modify: `public/src/components/DepotManager.jsx` (delete inline copy, lines 1–79)
- Modify: `public/index.html` (add `<script type="text/babel">` tag for the new file, before `DepotManager.jsx`)

- [ ] **Step 1: Create the shared component file**

Create `public/src/components/AddressAutocomplete.jsx`:

```jsx
// ===== ADDRESS AUTOCOMPLETE (Mapbox Search Box) =====
// Typeahead input. Calls onValueChange(text) on every keystroke and
// onPick(picked) on suggestion select (or onPick(null) on free-text edit).
// `picked` is { address, street, city, state, zip, lat, lon }.
//
// Extracted from DepotManager.jsx so ManualRecipientForm can also use it.
function AddressAutocomplete({value, onValueChange, onPick, placeholder, proximity, autoFocus}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const sessionRef = useRef(null);
  const abortRef = useRef(null);
  const inputRef = useRef(null);
  const blurTimerRef = useRef(null);

  useEffect(() => { if (autoFocus && inputRef.current) inputRef.current.focus(); }, [autoFocus]);

  useEffect(() => {
    if (!dirty) return;
    if (!value || value.trim().length < 3) { setSuggestions([]); setOpen(false); return; }
    if (!sessionRef.current) sessionRef.current = Math.random().toString(36).slice(2);
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t = setTimeout(async () => {
      setLoading(true);
      const out = await suggestAddress(value, { sessionToken: sessionRef.current, proximity, signal: ctrl.signal });
      if (!ctrl.signal.aborted) { setSuggestions(out); setOpen(out.length > 0); setHighlight(-1); setLoading(false); }
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [value, dirty]);

  const pick = async (s) => {
    setOpen(false);
    setSuggestions([]);
    const token = sessionRef.current;
    sessionRef.current = null;
    onValueChange(s.address);
    const retrieved = await retrieveAddress(s.id, { sessionToken: token });
    if (retrieved) {
      onPick({
        address: retrieved.address || s.address,
        street:  retrieved.street || s.address,
        city:    retrieved.city,
        state:   retrieved.state,
        zip:     retrieved.zip,
        lat:     retrieved.lat,
        lon:     retrieved.lon,
      });
    }
  };

  const onKey = (e) => {
    if (!open || !suggestions.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') {
      if (highlight >= 0) { e.preventDefault(); pick(suggestions[highlight]); }
    }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return <div style={{position:'relative'}}>
    <input ref={inputRef} value={value}
      onChange={e => { setDirty(true); onValueChange(e.target.value); onPick(null); }}
      onFocus={() => { if (dirty && suggestions.length) setOpen(true); }}
      onBlur={() => { blurTimerRef.current = setTimeout(() => setOpen(false), 150); }}
      onKeyDown={onKey}
      placeholder={placeholder}
      style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #e2e8f0',fontSize:13,boxSizing:'border-box'}}/>
    {open && suggestions.length > 0 && <div
      onMouseDown={() => { if (blurTimerRef.current) clearTimeout(blurTimerRef.current); }}
      style={{
        position:'absolute',top:'100%',left:0,right:0,zIndex:50,marginTop:2,
        background:'white',border:'1px solid #e2e8f0',borderRadius:6,
        boxShadow:'0 4px 12px rgba(0,0,0,0.08)',maxHeight:260,overflowY:'auto',
      }}>
      {suggestions.map((s,i) => <div key={s.id} onClick={() => pick(s)}
        style={{
          padding:'8px 10px',fontSize:12,cursor:'pointer',
          borderBottom: i < suggestions.length - 1 ? '1px solid #f1f5f9' : 'none',
          background: highlight === i ? '#f1f5f9' : 'white',
        }}
        onMouseEnter={() => setHighlight(i)}>
        <div style={{color:'#0f172a',fontWeight:500}}>{s.text}</div>
        {s.subtext && s.subtext !== s.text &&
          <div style={{color:'#94a3b8',fontSize:11,marginTop:1}}>{s.subtext}</div>}
      </div>)}
    </div>}
    {loading && !open && <div style={{position:'absolute',right:8,top:8,fontSize:11,color:'#94a3b8'}}>…</div>}
  </div>;
}

if (typeof window !== 'undefined') window.AddressAutocomplete = AddressAutocomplete;
```

- [ ] **Step 2: Delete the inline copy from `DepotManager.jsx`**

Delete lines 1–79 of `public/src/components/DepotManager.jsx` (the `// ===== ADDRESS AUTOCOMPLETE … }` block). The file should now start at the old line 81:

```jsx
// ===== DEPOT MANAGER (multi-tenant: writes via DB2.depots) =====
function DepotManager({regionKey,bakeryId,depots,onDepotsChange}){
```

`DepotManager` continues to use `<AddressAutocomplete .../>` — it's now resolved via `window.AddressAutocomplete` (declared at module scope by the new file).

- [ ] **Step 3: Wire the new file into `public/index.html`**

In `public/index.html`, immediately **before** the existing `DepotManager.jsx` script tag (currently around line 120), insert:

```html
  <script type="text/babel" src="./src/components/AddressAutocomplete.jsx?v=20260420a"></script>
```

Bump the build cache-buster — change line 40 to:

```html
  <script>window.__BUILD__ = '20260420a';</script>
```

- [ ] **Step 4: Smoke-test depot editing still works**

Open the app, navigate to the bakery admin → click **edit** on a depot → start typing an address in the popover. Confirm:
- Suggestions appear as you type (≥3 chars).
- Picking one fills the address input + shows the green "· pinned" indicator.
- Save persists the depot with the picked coords.

- [ ] **Step 5: Commit**

```bash
git add public/src/components/AddressAutocomplete.jsx public/src/components/DepotManager.jsx public/index.html
git commit -m "refactor(autocomplete): extract AddressAutocomplete into shared component

Pulled the inline AddressAutocomplete out of DepotManager so the upcoming
ManualRecipientForm can reuse it. Pick callback now exposes the parsed
city/state/zip fields from retrieveAddress; DepotManager ignores those
and behaves identically to before."
```

---

## Task 3: Add `manual-add` edge sub-route + Deno test

**Files:**
- Modify: `supabase/functions/ingest-recipients/index.ts`
- Modify: `supabase/functions/ingest-recipients/test.ts`

- [ ] **Step 1: Write the failing Deno test**

Append to `supabase/functions/ingest-recipients/test.ts`:

```ts
Deno.test('manual-add: inserts a single recipient with provided lat/lon and area-matches', async () => {
  const { data: boho } = await sb.from('bakeries').select('id').eq('name', 'Boho Petite').maybeSingle();
  if (!boho) {
    console.warn('Boho Petite not seeded; skipping');
    return;
  }
  let cust, camp;
  try {
    ({ data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single());
    ({ data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single());

    // 633 Folsom St SF — known to fall inside Boho Petite's polygon.
    const res = await fetch(fnUrl + '/manual-add', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign_id: camp!.id,
        company: 'Daymaker HQ',
        contact_name: 'Front Desk',
        phone: '415-555-0100',
        email: 'front@example.com',
        address: '633 Folsom St',
        city: 'San Francisco',
        state: 'CA',
        zip: '94107',
        lat: 37.7853,
        lon: -122.3987,
      }),
    });
    const json = await res.json();
    assertEquals(res.status, 200);
    assertEquals(json.assignment_status, 'assigned', 'SF address should land in Boho Petite');
    assertEquals(json.bakery_id, boho.id);
    assert(typeof json.recipient_id === 'string');

    const { data: rows } = await sb.from('recipients').select('*').eq('campaign_id', camp!.id);
    assertEquals(rows!.length, 1);
    assertEquals(rows![0].company, 'Daymaker HQ');
    assertEquals(rows![0].contact_name, 'Front Desk');
    assertEquals(rows![0].address, '633 Folsom St');
    assertEquals(rows![0].lat, 37.7853);
    assertEquals(rows![0].lon, -122.3987);
  } finally {
    if (camp?.id) {
      await sb.from('recipients').delete().eq('campaign_id', camp.id);
      await sb.from('campaigns').delete().eq('id', camp.id);
    }
    if (cust?.id) await sb.from('customers').delete().eq('id', cust.id);
  }
});

Deno.test('manual-add: a duplicate (same legacy_id) returns the existing row, no second insert', async () => {
  let cust, camp;
  try {
    ({ data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single());
    ({ data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single());

    const body = {
      campaign_id: camp!.id,
      company: 'Acme',
      address: '123 Main St',
      lat: 37.78, lon: -122.40,
    };
    const post = async () => {
      const r = await fetch(fnUrl + '/manual-add', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await r.json();
    };
    const first  = await post();
    const second = await post();

    assertEquals(second.duplicate, true, 'second call should report duplicate');
    assertEquals(second.recipient_id, first.recipient_id, 'should return the existing row id');
    const { data: rows } = await sb.from('recipients').select('*').eq('campaign_id', camp!.id);
    assertEquals(rows!.length, 1, 'only one row should exist');
  } finally {
    if (camp?.id) {
      await sb.from('recipients').delete().eq('campaign_id', camp.id);
      await sb.from('campaigns').delete().eq('id', camp.id);
    }
    if (cust?.id) await sb.from('customers').delete().eq('id', cust.id);
  }
});

Deno.test('manual-add: missing company OR address returns 400', async () => {
  let cust, camp;
  try {
    ({ data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single());
    ({ data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single());

    const r1 = await fetch(fnUrl + '/manual-add', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: camp!.id, address: '123 Main' }),
    });
    await r1.json();
    assertEquals(r1.status, 400);

    const r2 = await fetch(fnUrl + '/manual-add', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: camp!.id, company: 'Acme' }),
    });
    await r2.json();
    assertEquals(r2.status, 400);
  } finally {
    if (camp?.id) await sb.from('campaigns').delete().eq('id', camp.id);
    if (cust?.id) await sb.from('customers').delete().eq('id', cust.id);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from the repo root:

```bash
cd supabase/functions/ingest-recipients && \
  deno test --allow-net --allow-env --env-file=../../../.env test.ts \
    --filter 'manual-add'
```

Expected: 3 failures with `404` (or `405`) from the edge function — the route isn't registered yet.

- [ ] **Step 3: Implement the `manual-add` handler**

In `supabase/functions/ingest-recipients/index.ts`, immediately above `Deno.serve(async (req) => {` (around line 112), add:

```ts
// Per-row manual entry. Wired to UploadWizard's "Add recipient" form. Uses
// (campaign_id, legacy_id) for duplicate detection so a customer who types
// the same row twice gets the existing recipient back, not a second copy.
async function handleManualAdd(req: Request, sb: SupabaseClient): Promise<Response> {
  let body: {
    campaign_id?: string;
    company?: string; contact_name?: string | null;
    phone?: string | null; email?: string | null;
    address?: string; city?: string | null; state?: string | null; zip?: string | null;
    lat?: number | null; lon?: number | null;
  };
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }

  const company = (body.company || '').trim();
  const address = (body.address || '').trim();
  if (!body.campaign_id || !company || !address) {
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  }

  const { data: campaign, error: campErr } = await sb.from('campaigns')
    .select('id').eq('id', body.campaign_id).maybeSingle();
  if (campErr) return jsonResponse({ error: 'database_error', detail: campErr.message }, 500);
  if (!campaign) return jsonResponse({ error: 'campaign_not_found' }, 404);

  const legacy_id = await legacyId(company, address);

  // Dedup check: if a recipient with this legacy_id already exists in this
  // campaign, return it untouched. The (campaign_id, legacy_id) unique index
  // is the safety net for the race window between this SELECT and the INSERT.
  const { data: existing } = await sb.from('recipients')
    .select('id, assignment_status, lat, lon, bakery_id')
    .eq('campaign_id', body.campaign_id)
    .eq('legacy_id', legacy_id)
    .maybeSingle();
  if (existing) {
    return jsonResponse({
      duplicate: true,
      recipient_id: existing.id,
      assignment_status: existing.assignment_status,
      lat: existing.lat, lon: existing.lon,
      bakery_id: existing.bakery_id,
    });
  }

  const city  = (body.city  || '').trim() || null;
  const state = (body.state || '').trim() || null;
  const zip   = (body.zip   || '').trim() || null;

  // Use client-supplied coords when present (came from a Mapbox autocomplete
  // pick); otherwise geocode the address ourselves via the same single-row
  // batch the bulk pipeline uses.
  let lat: number | null = (typeof body.lat === 'number') ? body.lat : null;
  let lon: number | null = (typeof body.lon === 'number') ? body.lon : null;
  if (lat === null || lon === null) {
    const [g] = await geocodeRows(sb, [{ address, city, state, zip }]);
    lat = g?.lat ?? null;
    lon = g?.lon ?? null;
  }

  const areas = await loadAreas(sb);
  const matched = (lat !== null && lon !== null) ? findAreaIn(areas, lon, lat) : null;
  const bucket: Bucket = bucketFor({
    hasCompany: !!company,
    hasAddress: !!address,
    aiConfidence: 'high',
    geocodeOk: lat !== null && lon !== null,
    areaMatch: matched,
  });

  const { data: inserted, error: insErr } = await sb.from('recipients').insert({
    campaign_id: body.campaign_id,
    bakery_id: matched ? matched.bakery_id : null,
    company,
    contact_name: (body.contact_name || '').trim() || null,
    phone: (body.phone || '').trim() || null,
    email: (body.email || '').trim() || null,
    address,
    city, state, zip,
    lat, lon,
    assignment_status: bucket,
    legacy_id,
    customizations: {},
  }).select('id').single();
  if (insErr) return jsonResponse({ error: 'database_error', detail: insErr.message }, 500);

  return jsonResponse({
    recipient_id: inserted!.id,
    assignment_status: bucket,
    lat, lon,
    bakery_id: matched ? matched.bakery_id : null,
    duplicate: false,
  });
}
```

In the `Deno.serve` handler (around line 120), immediately after the `/geocode-single` dispatch, add:

```ts
  if (new URL(req.url).pathname.endsWith('/manual-add')) {
    return await handleManualAdd(req, sb);
  }
```

- [ ] **Step 4: Deploy the edge function**

The Supabase MCP is the only sanctioned tool for this project (per the user's project rules). Use the `project-0-archy-delivery-ops-supabase` MCP server's deploy-function tool to push the updated `ingest-recipients` source. (The function name stays `ingest-recipients`; the manual-add path is a sub-route, not a separate function.)

- [ ] **Step 5: Run the test to verify it passes**

Run:

```bash
cd supabase/functions/ingest-recipients && \
  deno test --allow-net --allow-env --env-file=../../../.env test.ts \
    --filter 'manual-add'
```

Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/ingest-recipients/index.ts supabase/functions/ingest-recipients/test.ts
git commit -m "feat(ingest): add /manual-add sub-route for one-at-a-time recipient entry

Reuses geocodeRows + loadAreas + findAreaIn + bucketFor + legacyId so a
manually entered recipient buckets identically to a bulk-ingested one.
Uses (campaign_id, legacy_id) for duplicate detection; the pre-existing
unique index is the race safety net."
```

---

## Task 4: `Customer.addRecipient` client helper

**Files:**
- Modify: `public/src/db/customer.js`

- [ ] **Step 1: Add the helper**

In `public/src/db/customer.js`, immediately after the `retryGeocode` method (around line 105) and before the `// ===== Plan 5 — design helpers =====` divider, insert:

```js
  // POSTs a single manually-entered recipient through the edge function so
  // it goes through the same geocode + area-match + bucket pipeline as a
  // bulk row. Returns:
  //   { recipient_id, assignment_status, lat, lon, bakery_id, duplicate }
  // `duplicate: true` means an existing recipient with the same
  // (company, address) was returned without a second insert.
  async addRecipient({ campaign_id, company, contact_name, phone, email,
                       address, city, state, zip, lat, lon }) {
    if (!sb) throw new Error('sb not ready');
    const url = sb.supabaseUrl.replace('.supabase.co', '.functions.supabase.co') + '/ingest-recipients/manual-add';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + sb.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign_id, company, contact_name, phone, email,
        address, city, state, zip,
        lat: typeof lat === 'number' ? lat : null,
        lon: typeof lon === 'number' ? lon : null,
      }),
    });
    if (!res.ok) throw new Error('addRecipient failed: ' + res.status + ' ' + await res.text());
    return await res.json();
  },
```

- [ ] **Step 2: Verify in browser console**

Open the app in the browser, open devtools console, paste (substituting an actual draft campaign id):

```js
await Customer.addRecipient({
  campaign_id: '<DRAFT_CAMPAIGN_ID>',
  company: 'Console Test',
  address: '633 Folsom St',
  city: 'San Francisco', state: 'CA', zip: '94107',
  lat: 37.7853, lon: -122.3987,
});
```

Expected: an object `{recipient_id, assignment_status: 'assigned', lat: 37.7853, lon: -122.3987, bakery_id: <uuid>, duplicate: false}` (assuming the campaign belongs to a customer whose region maps to Boho Petite). Then delete the test row from Supabase before moving on.

- [ ] **Step 3: Commit**

```bash
git add public/src/db/customer.js
git commit -m "feat(customer-db): add Customer.addRecipient() for manual entry"
```

---

## Task 5: Build `ManualRecipientForm` modal

**Files:**
- Create: `public/src/components/ManualRecipientForm.jsx`

- [ ] **Step 1: Write the component**

Create `public/src/components/ManualRecipientForm.jsx`:

```jsx
// ===== MANUAL RECIPIENT FORM =====
// Modal form for adding one recipient at a time to a draft campaign.
// Used by UploadWizard from two places: Step 1 (alternative to file upload)
// and Step 3 (Review's "+ Add recipient" button).
//
// Address autocomplete: picking a Mapbox suggestion fills address + city +
// state + zip + lat + lon all at once. The four address fields stay editable
// after autofill so the user can correct anything Mapbox got wrong.
function ManualRecipientForm({campaignId, onSaved, onClose}) {
  const blank = {
    company: '', contact_name: '', phone: '', email: '',
    address: '', city: '', state: '', zip: '',
    lat: null, lon: null,
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const canSave = !saving && form.company.trim() && form.address.trim();

  async function save({ keepOpen }) {
    setSaving(true); setErr(''); setNotice('');
    try {
      const result = await Customer.addRecipient({
        campaign_id: campaignId,
        company: form.company.trim(),
        contact_name: form.contact_name.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim(),
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        zip: form.zip.trim() || null,
        lat: form.lat, lon: form.lon,
      });
      if (result.duplicate) {
        setNotice('This recipient is already in the campaign.');
      }
      onSaved && onSaved(result);
      if (keepOpen) {
        setForm(blank);
        // refocus company input via key remount
      } else {
        onClose && onClose();
      }
    } catch (e) {
      setErr(e.message || String(e));
    }
    setSaving(false);
  }

  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose && onClose(); }}>
    <div className="modal-card manual-form" role="dialog" aria-label="Add recipient">
      <div className="modal-header">
        <h3>Add recipient</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {err && <div className="wizard-err" style={{margin:'0 0 12px'}}>{err}</div>}
      {notice && <div className="wizard-warn" style={{margin:'0 0 12px'}}>{notice}</div>}

      <div className="manual-form-grid">
        <label>
          <span>Company *</span>
          <input autoFocus value={form.company}
            onChange={e => set('company', e.target.value)}
            placeholder="Acme Dental"/>
        </label>
        <label>
          <span>Contact name</span>
          <input value={form.contact_name}
            onChange={e => set('contact_name', e.target.value)}
            placeholder="Dr. Smith"/>
        </label>

        <label className="manual-form-full">
          <span>Address *</span>
          <AddressAutocomplete
            value={form.address}
            onValueChange={v => set('address', v)}
            onPick={picked => {
              if (!picked) { set('lat', null); set('lon', null); return; }
              setForm(f => ({
                ...f,
                address: picked.street || picked.address || f.address,
                city:    picked.city  || f.city,
                state:   picked.state || f.state,
                zip:     picked.zip   || f.zip,
                lat:     picked.lat,
                lon:     picked.lon,
              }));
            }}
            placeholder="Start typing an address…"/>
        </label>

        <label>
          <span>Phone</span>
          <input value={form.phone}
            onChange={e => set('phone', e.target.value)}
            placeholder="415-555-0100"/>
        </label>
        <label>
          <span>Email</span>
          <input value={form.email} type="email"
            onChange={e => set('email', e.target.value)}
            placeholder="front@acme.example"/>
        </label>

        <label>
          <span>City</span>
          <input value={form.city}
            onChange={e => set('city', e.target.value)}
            placeholder="San Francisco"/>
        </label>
        <label className="manual-form-st-zip">
          <span>State / ZIP</span>
          <div style={{display:'flex',gap:6}}>
            <input value={form.state} maxLength={2}
              onChange={e => set('state', e.target.value.toUpperCase())}
              placeholder="CA" style={{width:60}}/>
            <input value={form.zip}
              onChange={e => set('zip', e.target.value)}
              placeholder="94105" style={{flex:1}}/>
          </div>
        </label>
      </div>

      <div className="modal-footer">
        <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <div style={{flex:1}}/>
        <button className="btn-ghost" disabled={!canSave}
          onClick={() => save({ keepOpen: true })}>
          {saving ? 'Saving…' : 'Save & add another'}
        </button>
        <button className="btn-primary" disabled={!canSave}
          onClick={() => save({ keepOpen: false })}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  </div>;
}

if (typeof window !== 'undefined') window.ManualRecipientForm = ManualRecipientForm;
```

- [ ] **Step 2: Commit**

```bash
git add public/src/components/ManualRecipientForm.jsx
git commit -m "feat(ui): ManualRecipientForm modal with autocompleting address"
```

(Visual smoke happens in Task 7 after the wizard is wired up.)

---

## Task 6: Wire the form into `UploadWizard`

**Files:**
- Modify: `public/src/components/UploadWizard.jsx`

- [ ] **Step 1: Add `entryMode` state and the manual-entry option to Step 1**

In `UploadWizard.jsx`, locate the top of the `UploadWizard` function (around line 11) and add `entryMode` to the state block. Replace:

```jsx
function UploadWizard({customerId, campaignId}){
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  const [campaign, setCampaign] = useState(null);
  const [ingestResult, setIngestResult] = useState(null);
```

with:

```jsx
function UploadWizard({customerId, campaignId}){
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  const [campaign, setCampaign] = useState(null);
  const [ingestResult, setIngestResult] = useState(null);
  // 'file' = upload a CSV/XLSX; 'manual' = skip file + columns, go straight
  // to Review and add recipients one at a time. Toggled from Step 1.
  const [entryMode, setEntryMode] = useState('file');
```

- [ ] **Step 2: Update `continueToStep2` to route manual mode straight to Step 3**

Replace the existing `continueToStep2` function (around lines 45–57) with:

```jsx
  async function continueFromStep1() {
    setWorking(true); setErr('');
    try {
      let camp = campaign;
      if (!camp) {
        camp = await Customer.createDraftCampaign(customerId, name.trim());
        setCampaign(camp);
        navigate('#/customer/' + customerId + '/upload/' + camp.id);
      }
      // Manual mode skips the columns step — there's no file to map.
      setStep(entryMode === 'manual' ? 3 : 2);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }
```

- [ ] **Step 3: Update Step 1's JSX to expose the manual-entry option**

In the same file, replace the entire Step 1 block (the `{step === 1 && <section className="wizard-step">…</section>}` block, around lines 75–97) with:

```jsx
      {step === 1 && <section className="wizard-step">
        <h2>Add your recipients</h2>
        <div className="wizard-field">
          <label>Campaign name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Q3 2026 deliveries"/>
        </div>

        <div className="wizard-entry-toggle">
          <button
            className={'wizard-entry-tab' + (entryMode === 'file' ? ' active' : '')}
            onClick={() => setEntryMode('file')}>
            Upload a file
          </button>
          <button
            className={'wizard-entry-tab' + (entryMode === 'manual' ? ' active' : '')}
            onClick={() => setEntryMode('manual')}>
            Add one at a time
          </button>
        </div>

        {entryMode === 'file' && <>
          <div className="wizard-dropzone">
            <input type="file" accept=".csv,.xlsx" onChange={e => onPickFile(e.target.files[0])}/>
            <div className="wizard-dropzone-hint">CSV or XLSX, up to 5,000 rows</div>
          </div>
          {parsed && <div className="wizard-preview">
            <div className="wizard-preview-meta">{parsed.rows.length} rows · {parsed.headers.length} columns</div>
            <table className="wizard-preview-table">
              <thead><tr>{parsed.headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{parsed.rows.slice(0,5).map((r,i) => <tr key={i}>{r.map((c,j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>}
        </>}

        {entryMode === 'manual' && <div className="wizard-empty-cta">
          <div style={{fontSize:14,color:'#374151',marginBottom:4}}>You'll enter recipients one at a time.</div>
          <div style={{fontSize:12,color:'#6b7280'}}>Click <b>Continue</b> to name the campaign and start adding rows.</div>
        </div>}

        <div className="wizard-footer">
          <button className="btn-primary"
            disabled={!name.trim() || (entryMode === 'file' && !parsed) || working}
            onClick={continueFromStep1}>
            {working ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </section>}
```

- [ ] **Step 4: Add `+ Add recipient` button + modal mount + empty state on Step 3**

Replace the entire `ReviewStep` component (the `function ReviewStep({...}) {…}` definition, currently around lines 208–270) with:

```jsx
function ReviewStep({campaign, customerId, onBack, onContinue, ingestResult}) {
  const [tab, setTab] = useState('needs_review');
  const [recipients, setRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setRecipients(await Customer.listRecipients(campaign.id)); }
    catch (e) { setErr(e.message); }
    setLoading(false);
  }, [campaign.id]);

  useEffect(() => { reload(); }, [reload]);

  // Default tab to "needs_review" but jump to the first non-empty bucket if
  // that one's empty, so customers aren't greeted by an empty state.
  useEffect(() => {
    if (recipients.length === 0) return;
    const inCurrent = recipients.filter(r => r.assignment_status === tab).length;
    if (inCurrent > 0) return;
    const order = ['needs_review', 'flagged_out_of_area', 'geocode_failed', 'assigned'];
    const next = order.find(b => recipients.some(r => r.assignment_status === b));
    if (next) setTab(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipients.length]);

  const counts = {
    assigned: recipients.filter(r => r.assignment_status === 'assigned').length,
    needs_review: recipients.filter(r => r.assignment_status === 'needs_review').length,
    flagged_out_of_area: recipients.filter(r => r.assignment_status === 'flagged_out_of_area').length,
    geocode_failed: recipients.filter(r => r.assignment_status === 'geocode_failed').length,
  };
  const inTab = recipients.filter(r => r.assignment_status === tab);
  const stillProblematic = counts.needs_review + counts.flagged_out_of_area + counts.geocode_failed;
  const empty = !loading && recipients.length === 0;

  return <section className="wizard-step">
    <h2>Review &amp; finalize · v2</h2>
    <p className="wizard-step-sub">{recipients.length} rows ingested. Tabs show each bucket; counts are live.</p>
    {err && <div className="wizard-err" style={{margin:0}}>{err}</div>}

    <div className="wizard-add-bar">
      <button className="btn-primary" onClick={() => setShowAdd(true)}>+ Add recipient</button>
    </div>

    {!empty && <div className="wizard-tabs">
      <Tab label="Assigned" n={counts.assigned} active={tab==='assigned'} onClick={() => setTab('assigned')} color="#15803d"/>
      <Tab label="Needs review" n={counts.needs_review} active={tab==='needs_review'} onClick={() => setTab('needs_review')} color="#7c3aed"/>
      <Tab label="Out of area" n={counts.flagged_out_of_area} active={tab==='flagged_out_of_area'} onClick={() => setTab('flagged_out_of_area')} color="#b45309"/>
      <Tab label="Geocode failed" n={counts.geocode_failed} active={tab==='geocode_failed'} onClick={() => setTab('geocode_failed')} color="#dc2626"/>
    </div>}

    {loading
      ? <div style={{padding:24,color:'#9ca3af'}}>Loading…</div>
      : empty
        ? <div className="wizard-empty">
            <div style={{fontSize:14,color:'#374151'}}><b>No recipients yet.</b></div>
            <div style={{fontSize:12,color:'#6b7280',marginTop:4}}>Click <b>+ Add recipient</b> above to get started.</div>
          </div>
        : inTab.length === 0
          ? <div className="wizard-empty">Nothing in this bucket. 🎉</div>
          : <div className="wizard-row-list">{inTab.map(r => <RecipientRow key={r.id} row={r} bucket={tab} onChanged={reload}/>)}</div>}

    <div className="wizard-footer">
      <button className="btn-ghost" onClick={onBack}>‹ Back</button>
      <div style={{flex:1, fontSize:12, color:'#6b7280', textAlign:'right', marginRight:8}}>
        {empty
          ? 'Add at least 1 recipient to continue'
          : `${counts.assigned} will be delivered. ${stillProblematic} still need attention.`}
      </div>
      <button className="btn-primary" onClick={onContinue} disabled={empty}>Continue to designs ›</button>
    </div>

    {showAdd && <ManualRecipientForm
      campaignId={campaign.id}
      onSaved={() => { reload(); }}
      onClose={() => setShowAdd(false)}/>}
  </section>;
}
```

Note: the `‹ Back` label changed from `‹ Back to columns` → `‹ Back` because the manual path skips the columns step. Step 2 is still reachable via the rail click (existing behavior) for users who came from a file upload and want to revise mapping.

- [ ] **Step 5: Smoke-test both paths**

Reload the app, navigate to a customer → **New campaign**:

**File path (must still work)**:
1. Type a name, leave "Upload a file" selected, drop a CSV → preview appears.
2. **Continue** → land on Step 2 (Columns) → Continue → Step 3 (Review) shows the bucketed rows.

**Manual path (new)**:
1. Type a name, click **Add one at a time**, the dropzone vanishes and a hint appears.
2. **Continue** → land directly on Step 3 with the empty-state panel and a disabled **Continue to designs**.
3. Click **+ Add recipient** → modal opens with company autofocused.
4. Type "Boho Cake Co" in Company. In Address, type "633 Folsom" and pick the SF suggestion → city "San Francisco", state "CA", zip "94107" autofill.
5. **Save** → modal closes, the row appears in the **Assigned** tab, footer enables **Continue to designs**.
6. Click **+ Add recipient** again → enter another → **Save & add another** → modal stays open with cleared fields.

**Mixed path**:
1. Start a new campaign with a CSV file. After landing on Review, click **+ Add recipient** to append a manual row. Verify it appears in the correct bucket tab.

- [ ] **Step 6: Commit**

```bash
git add public/src/components/UploadWizard.jsx
git commit -m "feat(wizard): manual recipient entry on Step 1 (alt) and Step 3 (+ button)

Step 1 gets a 'Upload a file' / 'Add one at a time' toggle; manual mode
skips column mapping and lands on Review. Review gets a persistent
'+ Add recipient' button + an empty-state CTA when no rows exist yet.
The Continue-to-designs button is disabled until at least 1 row exists."
```

---

## Task 7: CSS + cache-buster + script registration

**Files:**
- Modify: `public/src/styles.css`
- Modify: `public/index.html`

- [ ] **Step 1: Add modal + entry-toggle styles**

Append to `public/src/styles.css`:

```css
/* ===== Manual recipient entry ===== */
.wizard-entry-toggle{display:flex;gap:0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;width:fit-content}
.wizard-entry-tab{background:#fff;color:#6b7280;border:0;padding:8px 16px;font-size:13px;cursor:pointer;font-weight:500}
.wizard-entry-tab.active{background:#111827;color:#fff}
.wizard-entry-tab:not(.active):hover{background:#f9fafb;color:#111827}

.wizard-empty-cta{padding:20px 16px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:8px;text-align:center}

.wizard-add-bar{display:flex;justify-content:flex-start;margin-bottom:8px}

.wizard-empty{padding:32px 16px;text-align:center;background:#f9fafb;border:1px dashed #d1d5db;border-radius:8px;color:#6b7280}

/* Modal shell — used by ManualRecipientForm */
.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,0.45);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px}
.modal-card{background:#fff;border-radius:12px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);max-width:560px;width:100%;max-height:90vh;overflow-y:auto;padding:20px}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.modal-header h3{margin:0;font-size:16px;font-weight:600;color:#111827}
.modal-close{background:none;border:0;font-size:22px;color:#6b7280;cursor:pointer;line-height:1;padding:0 4px}
.modal-close:hover{color:#111827}
.modal-footer{display:flex;gap:8px;align-items:center;margin-top:20px;padding-top:16px;border-top:1px solid #f3f4f6}

/* Manual recipient form grid: 2 columns, full-width address */
.manual-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.manual-form-grid label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:#6b7280;font-weight:500}
.manual-form-grid label span{display:block}
.manual-form-grid label input{padding:7px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;color:#111827;font-family:inherit;box-sizing:border-box;width:100%}
.manual-form-grid label input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,0.15)}
.manual-form-full{grid-column:1 / -1}
```

- [ ] **Step 2: Register the new component scripts in `public/index.html`**

In `public/index.html`, add `ManualRecipientForm.jsx` to the script-tag block. Place it immediately **after** `UploadWizard.jsx` would normally appear — but `UploadWizard` references it, so it MUST load **before** `UploadWizard.jsx`.

Locate the line:

```html
  <script type="text/babel" src="./src/components/UploadWizard.jsx?v=20260419g"></script>
```

…and replace it with:

```html
  <script type="text/babel" src="./src/components/ManualRecipientForm.jsx?v=20260420a"></script>
  <script type="text/babel" src="./src/components/UploadWizard.jsx?v=20260420a"></script>
```

(`AddressAutocomplete.jsx` was already added in Task 2, ahead of `DepotManager.jsx`. Confirm it's still there.)

Verify the cache-buster is set: line 40 should already read `window.__BUILD__ = '20260420a';` from Task 2. The CSS link at line 43 needs a bump too:

```html
  <link href="./src/styles.css?v=20260420a" rel="stylesheet"/>
```

- [ ] **Step 3: Final smoke pass**

Hard-reload the app (Cmd-Shift-R) to bust any cached JS. Re-run the three smoke scenarios from Task 6 Step 5. Confirm:
- The modal looks like a card centered on a dimmed backdrop, not unstyled HTML.
- The "Upload a file" / "Add one at a time" toggle visually reads as two tabs joined at the seam.
- The empty-state on Review is styled (dashed border, light grey bg) — not raw text.
- The form fields focus highlights with a blue ring.
- Clicking outside the modal card closes it.
- The depot editor (Task 2 regression check) still works end-to-end.

- [ ] **Step 4: Commit**

```bash
git add public/src/styles.css public/index.html
git commit -m "style: modal + entry-toggle + empty-state CSS for manual entry

Adds .modal-backdrop/.modal-card, .manual-form-grid, .wizard-entry-toggle,
.wizard-add-bar, .wizard-empty-cta. Bumps __BUILD__ + script versions to
20260420a so browsers don't serve stale JS."
```

---

## Self-review checklist (run after writing — fix inline)

**Spec coverage:**
- ✅ Two entry points (Step 1 alt + Step 3 button) — Task 6.
- ✅ Modal form with all 8 fields — Task 5.
- ✅ Address autocomplete fills city/state/zip — Tasks 1 (parser), 2 (component plumbing), 5 (form `onPick` handler).
- ✅ New `manual-add` sub-route — Task 3.
- ✅ Reuses `legacyId` + `loadAreas` + `bucketFor` — Task 3.
- ✅ Duplicate detection returns existing row — Task 3 + test.
- ✅ Skip-Step-2 routing — Task 6 Step 2.
- ✅ Empty-state on Review when 0 recipients + disabled Continue — Task 6 Step 4.
- ✅ Save & add another — Task 5 (`save({keepOpen:true})`).
- ✅ Server-side validation of company + address — Task 3 handler + 400 test case.
- ✅ Mapbox-down fallback (server geocodes when no lat/lon) — Task 3 handler.

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "add error handling". Every step shows the actual code.

**Type / signature consistency:**
- `Customer.addRecipient` arg names match the request body keys in `handleManualAdd` (Task 3 vs Task 4) ✅.
- `AddressAutocomplete`'s `onPick` payload `{address, street, city, state, zip, lat, lon}` matches what `ManualRecipientForm`'s onPick consumes (Task 2 vs Task 5) ✅.
- `parseRetrieveContext` return shape `{address, city, state, zip}` matches what `retrieveAddress` spreads (Task 1) ✅.
- New CSS class names referenced in JSX (`.modal-backdrop`, `.modal-card`, `.manual-form`, `.manual-form-grid`, `.manual-form-full`, `.wizard-entry-toggle`, `.wizard-entry-tab`, `.wizard-add-bar`, `.wizard-empty-cta`) all defined in Task 7 ✅.

No issues found.
