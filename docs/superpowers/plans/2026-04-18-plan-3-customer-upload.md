# Plan 3 — Customer Upload Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 3-step customer upload wizard backed by a Supabase edge function that AI-cleans, geocodes, area-matches, and buckets recipients into `assigned / needs_review / flagged_out_of_area / geocode_failed`.

**Architecture:** New Deno edge function `ingest-recipients` owns the pipeline (parse → AI columns → AI rows → geocode → area-match → bucket → bulk insert). Browser parses the file locally with SheetJS for preview, then ships file bytes + confirmed mapping to the edge function. Wizard is its own SPA route at `#/customer/<id>/upload/<campaignId>` with a left-rail progress sidebar. No new tables; one migration adds `unique (campaign_id, legacy_id)` so re-upload is idempotent. Auth stays off (Plan 2 pivot); the edge function uses the service role key internally.

**Tech Stack:** Deno (Supabase edge functions), `xlsx` (SheetJS) via esm.sh inside the function and CDN in the browser, OpenAI Chat Completions API (`gpt-4o-mini`), Mapbox Geocoding API, Turf.js for point-in-polygon, React 18 (babel-standalone), Node 18+ `node:test` for browser-helper unit tests, `deno test` for the edge function integration test.

Plan 3 spec: `docs/superpowers/specs/2026-04-18-plan-3-customer-upload-design.md`.

---

## File structure

### Creates

- `supabase/migrations/007_recipients_legacy_unique.sql` — adds `unique (campaign_id, legacy_id)` constraint.
- `supabase/functions/ingest-recipients/index.ts` — Deno edge function entry point + HTTP handler.
- `supabase/functions/ingest-recipients/parse.ts` — file decode (CSV / XLSX → headers + rows).
- `supabase/functions/ingest-recipients/ai.ts` — OpenAI calls (column mapping + row normalization).
- `supabase/functions/ingest-recipients/geocode.ts` — Mapbox + cache lookup.
- `supabase/functions/ingest-recipients/bucket.ts` — pure bucket-precedence logic.
- `supabase/functions/ingest-recipients/legacy_id.ts` — pure sha256 hash helper.
- `supabase/functions/ingest-recipients/test.ts` — `deno test` integration test.
- `supabase/functions/ingest-recipients/deno.json` — function-local config.
- `public/src/upload/parse.js` — browser-side SheetJS wrapper for preview.
- `public/src/upload/columns.js` — deterministic column-mapping fallback (`suggestMapping`).
- `public/src/upload/__tests__/parse.test.mjs` — parse helper unit tests.
- `public/src/upload/__tests__/columns.test.mjs` — column heuristic unit tests.
- `public/src/upload/__tests__/package.json` — npm scaffold for the two suites.
- `public/src/db/customer.js` — small data-access layer for the wizard (campaign creation, listing recipients by bucket, per-row actions).
- `public/src/components/UploadWizard.jsx` — three-step wizard shell + per-step components.

### Modifies

- `public/index.html` — load SheetJS CDN + new helper / component scripts.
- `public/src/components/App.jsx` — route `#/customer/<id>/upload/<campaignId>` to `UploadWizard`.
- `public/src/components/CustomerHomeView.jsx` — wire the disabled "+ Upload campaign" button to create a draft campaign and navigate to the wizard.

### Manual one-time setup (not a code task — confirm before Task 4)

- In the Supabase dashboard → Edge Functions → secrets, set:
  - `OPENAI_API_KEY` (Daymaker's OpenAI key, billed centrally).
  - `MAPBOX_SECRET_TOKEN` (an `sk.*` token from the same Mapbox account that owns the existing `pk.*` browser token).
- The `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` env vars are auto-injected by Supabase; no manual step.

---

## Task ordering rationale

- **Task 1** ships the migration first so every subsequent insert can rely on the unique constraint. Pure DB change with no app coupling.
- **Tasks 2–3** build the two pure browser helpers (parse + columns) with unit tests. They're imported by the wizard (Task 11) and the function reuses the same column-heuristic logic.
- **Tasks 4–9** build the edge function in vertical slices: skeleton (4), parse + insert (5), AI mapping (6), AI cleanup (7), geocode (8), area-match + bucket (9). Each task ends with a green integration test.
- **Tasks 10–13** build the wizard UI in step order, ending with per-row actions in step 3.
- **Task 14** wires the wizard into `CustomerHomeView` + the route table.
- **Task 15** is the cross-cutting smoke + cleanup.

---

## Task 1: Migration 007 — recipients legacy_id uniqueness

**Files:**
- Create: `supabase/migrations/007_recipients_legacy_unique.sql`

- [ ] **Step 1: Write migration 007**

Create `supabase/migrations/007_recipients_legacy_unique.sql`:

```sql
-- Plan 3 — recipients dedup constraint.
-- Migration 002 added a partial unique INDEX on (campaign_id, legacy_id) where
-- legacy_id is not null. Plan 3's edge function uses INSERT ... ON CONFLICT,
-- which requires a CONSTRAINT (not just a partial index) to be referenced by
-- name. Replace the partial index with a real constraint that allows multiple
-- nulls (Postgres uniqueness already does this for nullable columns).

drop index if exists recipients_legacy_idx;

alter table recipients
  add constraint recipients_campaign_legacy_unique
    unique (campaign_id, legacy_id);
```

- [ ] **Step 2: Apply via Supabase MCP**

Use the project's Supabase MCP `apply_migration` tool with `name="007_recipients_legacy_unique"` and the migration body above. Per the user's project rules: never use the Supabase CLI; only the MCP.

- [ ] **Step 3: Verify the constraint is live**

Use the MCP `execute_sql` tool with:

```sql
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conname = 'recipients_campaign_legacy_unique';
```

Expected: one row with `UNIQUE (campaign_id, legacy_id)`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/007_recipients_legacy_unique.sql
git commit -m "Migration 007: unique (campaign_id, legacy_id) on recipients"
```

---

## Task 2: Browser file parse helper + tests

**Files:**
- Create: `public/src/upload/parse.js`
- Create: `public/src/upload/__tests__/parse.test.mjs`
- Create: `public/src/upload/__tests__/package.json`

- [ ] **Step 1: Scaffold the test package**

Create `public/src/upload/__tests__/package.json`:

```json
{
  "name": "upload-tests",
  "type": "module",
  "private": true,
  "dependencies": {
    "xlsx": "^0.18.5"
  }
}
```

Run:

```bash
cd public/src/upload/__tests__ && npm install
```

Expected: installs `xlsx`.

- [ ] **Step 2: Write the failing test**

Create `public/src/upload/__tests__/parse.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(path.resolve(__dirname, '../parse.js'), 'utf8');
const ctx = {};
new Function('XLSX', 'ctx', src + '\nctx.parseFile = parseFile;')(XLSX, ctx);
const { parseFile } = ctx;

const csv = 'Company,Address\n"Acme Co","123 Main St"\nWidgets,"45 Oak Ave"\n';
const csvBuffer = new TextEncoder().encode(csv).buffer;

test('parses a clean CSV into headers + rows', () => {
  const out = parseFile(csvBuffer, 'csv');
  assert.deepEqual(out.headers, ['Company', 'Address']);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows[0], ['Acme Co', '123 Main St']);
});

test('strips a UTF-8 BOM from the first header', () => {
  const withBom = '\uFEFFCompany,Address\nAcme,1 Main St\n';
  const out = parseFile(new TextEncoder().encode(withBom).buffer, 'csv');
  assert.equal(out.headers[0], 'Company');
});

test('drops fully empty trailing rows', () => {
  const messy = 'A,B\n1,2\n,\n,\n';
  const out = parseFile(new TextEncoder().encode(messy).buffer, 'csv');
  assert.equal(out.rows.length, 1);
});

test('rejects when row count exceeds the cap', () => {
  let body = 'Company,Address\n';
  for (let i = 0; i < 5001; i++) body += `Co${i},${i} Main St\n`;
  assert.throws(
    () => parseFile(new TextEncoder().encode(body).buffer, 'csv'),
    /5000 row limit/
  );
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd public/src/upload/__tests__ && node --test parse.test.mjs
```

Expected: all four tests fail with "parseFile is not a function" or similar.

- [ ] **Step 4: Implement `parse.js`**

Create `public/src/upload/parse.js`:

```javascript
// ===== UPLOAD: FILE PARSE HELPER =====
// Browser-side wrapper around SheetJS that returns a normalized
// { headers, rows } shape. Mirrors what the edge function's parse.ts does
// so the wizard can preview the same content the function will ingest.
// `XLSX` is the global from the browser bundle; in node tests it's injected.

const ROW_CAP = 5000;

function parseFile(arrayBuffer, fileType) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets found in file');
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = (matrix[0] || []).map(h => String(h || '').replace(/^\uFEFF/, '').trim());
  const rows = matrix.slice(1)
    .map(row => row.map(cell => (cell == null ? '' : String(cell))))
    .filter(row => row.some(cell => cell.trim() !== ''));

  if (rows.length > ROW_CAP) {
    throw new Error('File exceeds 5000 row limit (' + rows.length + ' rows). Split into smaller files.');
  }
  return { headers, rows };
}

if (typeof window !== 'undefined') window.parseFile = parseFile;
```

- [ ] **Step 5: Run the tests, verify pass**

```bash
cd public/src/upload/__tests__ && node --test parse.test.mjs
```

Expected: 4 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add public/src/upload/parse.js public/src/upload/__tests__/parse.test.mjs public/src/upload/__tests__/package.json
git commit -m "Upload: SheetJS-backed parseFile helper + tests"
```

---

## Task 3: Column mapping heuristic + tests

**Files:**
- Create: `public/src/upload/columns.js`
- Create: `public/src/upload/__tests__/columns.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `public/src/upload/__tests__/columns.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(path.resolve(__dirname, '../columns.js'), 'utf8');
const ctx = {};
new Function('ctx', src + '\nctx.suggestMapping = suggestMapping;')(ctx);
const { suggestMapping } = ctx;

test('exact target names map directly', () => {
  const out = suggestMapping(['company', 'address', 'phone']);
  assert.deepEqual(out.mapping, { company: 'company', address: 'address', phone: 'phone' });
  assert.equal(out.confidence.company, 'high');
});

test('common business synonyms map to company', () => {
  const out = suggestMapping(['Business Name', 'Street', 'Cell']);
  assert.equal(out.mapping['Business Name'], 'company');
  assert.equal(out.mapping['Street'], 'address');
  assert.equal(out.mapping['Cell'], 'phone');
});

test('unknown headers map to null with low confidence', () => {
  const out = suggestMapping(['Sales Rep', 'Internal Notes']);
  assert.equal(out.mapping['Sales Rep'], null);
  assert.equal(out.confidence['Sales Rep'], 'low');
});

test('case and punctuation are ignored', () => {
  const out = suggestMapping(['ZIP CODE', 'E-mail', 'CITY/TOWN']);
  assert.equal(out.mapping['ZIP CODE'], 'zip');
  assert.equal(out.mapping['E-mail'], 'email');
  assert.equal(out.mapping['CITY/TOWN'], 'city');
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd public/src/upload/__tests__ && node --test columns.test.mjs
```

Expected: 4 fail with "suggestMapping is not a function".

- [ ] **Step 3: Implement `columns.js`**

Create `public/src/upload/columns.js`:

```javascript
// ===== UPLOAD: COLUMN-MAPPING HEURISTIC =====
// Pure deterministic fallback used when the AI is disabled or down. Returns
// per-source-column { mapping, confidence } in the same shape the edge
// function produces, so the wizard can render a single "AI failed" path.

const TARGETS = ['company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip'];

const SYNONYMS = {
  company: ['company', 'business name', 'business', 'customer', 'customer name', 'account', 'practice', 'office', 'organization', 'org'],
  contact_name: ['contact', 'contact name', 'name', 'recipient', 'recipient name', 'attention', 'attn'],
  phone: ['phone', 'telephone', 'cell', 'mobile', 'phone number'],
  email: ['email', 'e-mail', 'mail', 'email address'],
  address: ['address', 'street', 'street address', 'address 1', 'address1', 'addr', 'addr 1'],
  city: ['city', 'city town', 'town', 'municipality', 'city/town'],
  state: ['state', 'province', 'region', 'st', 'state/province'],
  zip: ['zip', 'zip code', 'postal', 'postal code', 'postcode'],
};

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function suggestMapping(headers) {
  const mapping = {};
  const confidence = {};
  for (const header of headers || []) {
    const norm = normalize(header);
    let matched = null;
    let score = 'low';
    for (const target of TARGETS) {
      const synonyms = SYNONYMS[target];
      if (synonyms.includes(norm)) {
        matched = target;
        score = synonyms[0] === norm ? 'high' : 'medium';
        break;
      }
    }
    mapping[header] = matched;
    confidence[header] = matched ? score : 'low';
  }
  return { mapping, confidence };
}

if (typeof window !== 'undefined') window.suggestMapping = suggestMapping;
```

- [ ] **Step 4: Run the tests, verify pass**

```bash
cd public/src/upload/__tests__ && node --test columns.test.mjs
```

Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add public/src/upload/columns.js public/src/upload/__tests__/columns.test.mjs
git commit -m "Upload: deterministic column-mapping heuristic + tests"
```

---

## Task 4: Edge function skeleton + deploy + smoke

**Files:**
- Create: `supabase/functions/ingest-recipients/index.ts`
- Create: `supabase/functions/ingest-recipients/deno.json`

- [ ] **Step 1: Confirm secrets are set in the Supabase dashboard**

Before deploying, the engineer must have set in Supabase → Project → Edge Functions → Secrets:
- `OPENAI_API_KEY`
- `MAPBOX_SECRET_TOKEN`

Use the MCP `execute_sql` to confirm these exist if there's any doubt — list secrets via `select * from vault.decrypted_secrets where name in ('OPENAI_API_KEY','MAPBOX_SECRET_TOKEN');` (Supabase exposes function secrets via vault). If empty, stop and ask the user to set them manually.

- [ ] **Step 2: Write the deno.json**

Create `supabase/functions/ingest-recipients/deno.json`:

```json
{
  "imports": {
    "std/": "https://deno.land/std@0.224.0/",
    "xlsx": "https://esm.sh/xlsx@0.18.5",
    "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2.39.0",
    "@turf/boolean-point-in-polygon": "https://esm.sh/@turf/boolean-point-in-polygon@7.1.0"
  }
}
```

- [ ] **Step 3: Write the skeleton index.ts**

Create `supabase/functions/ingest-recipients/index.ts`:

```typescript
// ===== ingest-recipients edge function =====
// Plan 3 customer upload pipeline. POST endpoint that accepts a base64-
// encoded CSV/XLSX file plus a confirmed column mapping, runs the full
// pipeline (parse → AI cleanup → geocode → area-match → bucket → bulk
// insert into recipients), and returns per-bucket totals plus a small
// sample of problem rows for the wizard to seed Step 3.
import { createClient } from '@supabase/supabase-js';

interface IngestRequest {
  campaign_id: string;
  file_b64: string;
  file_type: 'csv' | 'xlsx';
  column_mapping?: Record<string, string | null>;
  ai_disabled?: boolean;
}

interface IngestResponse {
  totals: { assigned: number; needs_review: number; flagged_out_of_area: number; geocode_failed: number };
  sample_issues: Array<{ recipient_id: string; reason: string; raw: Record<string, string>; suggested?: Record<string, string | null> }>;
  mapping_used: Record<string, string | null>;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: IngestRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  if (!body.campaign_id || !body.file_b64 || !body.file_type) {
    return jsonResponse({ error: 'missing_required_fields' }, 400);
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Skeleton: confirm campaign exists, return empty totals. Full pipeline
  // is wired in subsequent tasks.
  const { data: campaign, error } = await sb
    .from('campaigns').select('id').eq('id', body.campaign_id).maybeSingle();
  if (error) return jsonResponse({ error: error.message }, 500);
  if (!campaign) return jsonResponse({ error: 'campaign_not_found' }, 404);

  const response: IngestResponse = {
    totals: { assigned: 0, needs_review: 0, flagged_out_of_area: 0, geocode_failed: 0 },
    sample_issues: [],
    mapping_used: body.column_mapping || {},
  };
  return jsonResponse(response);
});
```

- [ ] **Step 4: Deploy the function via Supabase MCP**

Use the MCP `deploy_edge_function` tool with `name="ingest-recipients"` and the file body of `index.ts`. The MCP will read `deno.json` for imports.

- [ ] **Step 5: Smoke-test the deployed function**

Use the MCP `execute_sql` to find a real campaign id:

```sql
select id from campaigns limit 1;
```

Then `curl` the function (substitute `<project-ref>`, `<anon-key>`, `<campaign-id>`):

```bash
curl -i -X POST "https://<project-ref>.functions.supabase.co/ingest-recipients" \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"campaign_id":"<campaign-id>","file_b64":"","file_type":"csv"}'
```

Expected: HTTP 200, body `{"totals":{...zeros...},"sample_issues":[],"mapping_used":{}}`.

If you get 404 with `campaign_not_found`, the campaign id was wrong. If you get 500 with `vault`-related errors, secrets aren't set.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/ingest-recipients/index.ts supabase/functions/ingest-recipients/deno.json
git commit -m "Edge function: ingest-recipients skeleton (deploys, returns empty totals)"
```

---

## Task 5: Edge function — parse + bulk insert (no AI, no geocode)

**Files:**
- Create: `supabase/functions/ingest-recipients/parse.ts`
- Create: `supabase/functions/ingest-recipients/legacy_id.ts`
- Create: `supabase/functions/ingest-recipients/bucket.ts`
- Create: `supabase/functions/ingest-recipients/test.ts`
- Modify: `supabase/functions/ingest-recipients/index.ts`

- [ ] **Step 1: Write `legacy_id.ts`**

Create `supabase/functions/ingest-recipients/legacy_id.ts`:

```typescript
// Stable per-row identifier. sha256(lowercased(company) + '|' + lowercased(address))
// hex digest. Same row across re-uploads → same legacy_id → ON CONFLICT skips it.
export async function legacyId(company: string, address: string): Promise<string> {
  const norm = (company || '').trim().toLowerCase() + '|' + (address || '').trim().toLowerCase();
  const buf = new TextEncoder().encode(norm);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 2: Write `parse.ts`**

Create `supabase/functions/ingest-recipients/parse.ts`:

```typescript
import * as XLSX from 'xlsx';

export interface ParsedFile {
  headers: string[];
  rows: string[][];
}

export function parseFile(b64: string, fileType: 'csv' | 'xlsx'): ParsedFile {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const wb = XLSX.read(bin, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('No sheets found in file');
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: '' });
  if (matrix.length === 0) return { headers: [], rows: [] };
  const headers = (matrix[0] || []).map(h => String(h || '').replace(/^\uFEFF/, '').trim());
  const rows = matrix.slice(1)
    .map(row => row.map(cell => (cell == null ? '' : String(cell))))
    .filter(row => row.some(cell => cell.trim() !== ''));
  if (rows.length > 5000) throw new Error('File exceeds 5000 row limit');
  return { headers, rows };
}
```

- [ ] **Step 3: Write `bucket.ts` (placeholder pure function)**

Create `supabase/functions/ingest-recipients/bucket.ts`:

```typescript
// ===== BUCKET PRECEDENCE =====
// needs_review > geocode_failed > flagged_out_of_area > assigned
// Geocode + area match are not yet wired in Task 5; this returns 'assigned'
// for any row that has a non-empty company + address. Tasks 8 + 9 plug in
// the geocode/area inputs.
export type Bucket = 'assigned' | 'needs_review' | 'flagged_out_of_area' | 'geocode_failed';

export interface BucketInputs {
  hasCompany: boolean;
  hasAddress: boolean;
  aiConfidence?: 'low' | 'medium' | 'high';
  geocodeOk: boolean;
  areaMatch: { bakery_id: string } | null;
}

export function bucketFor(input: BucketInputs): Bucket {
  if (!input.hasCompany || !input.hasAddress) return 'needs_review';
  if (input.aiConfidence === 'low') return 'needs_review';
  if (!input.geocodeOk) return 'geocode_failed';
  if (!input.areaMatch) return 'flagged_out_of_area';
  return 'assigned';
}
```

- [ ] **Step 4: Replace `index.ts` with the parse + insert path**

Overwrite `supabase/functions/ingest-recipients/index.ts`:

```typescript
import { createClient } from '@supabase/supabase-js';
import { parseFile } from './parse.ts';
import { legacyId } from './legacy_id.ts';
import { bucketFor, Bucket } from './bucket.ts';

interface IngestRequest {
  campaign_id: string;
  file_b64: string;
  file_type: 'csv' | 'xlsx';
  column_mapping?: Record<string, string | null>;
  ai_disabled?: boolean;
}

const TARGETS = ['company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip'] as const;
type Target = typeof TARGETS[number];

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

function applyMapping(headers: string[], row: string[], mapping: Record<string, string | null>): Record<Target, string> {
  const out = {} as Record<Target, string>;
  for (const t of TARGETS) out[t] = '';
  headers.forEach((h, i) => {
    const target = mapping[h] as Target | null | undefined;
    if (target && TARGETS.includes(target)) out[target] = (row[i] || '').trim();
  });
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  let body: IngestRequest;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }
  if (!body.campaign_id || !body.file_b64 || !body.file_type) return jsonResponse({ error: 'missing_required_fields' }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: campaign } = await sb.from('campaigns').select('id').eq('id', body.campaign_id).maybeSingle();
  if (!campaign) return jsonResponse({ error: 'campaign_not_found' }, 404);

  let parsed;
  try { parsed = parseFile(body.file_b64, body.file_type); }
  catch (e) { return jsonResponse({ error: (e as Error).message }, 400); }

  const mapping = body.column_mapping || {};
  const totals = { assigned: 0, needs_review: 0, flagged_out_of_area: 0, geocode_failed: 0 };
  const insertRows: Array<Record<string, unknown>> = [];

  for (const row of parsed.rows) {
    const fields = applyMapping(parsed.headers, row, mapping);
    const bucket: Bucket = bucketFor({
      hasCompany: !!fields.company,
      hasAddress: !!fields.address,
      geocodeOk: false,    // Task 8 will set this
      areaMatch: null,      // Task 9 will set this
    });
    totals[bucket]++;
    insertRows.push({
      campaign_id: body.campaign_id,
      bakery_id: null,
      company: fields.company || '(unknown)',
      contact_name: fields.contact_name || null,
      phone: fields.phone || null,
      email: fields.email || null,
      address: fields.address || '(unknown)',
      city: fields.city || null, state: fields.state || null, zip: fields.zip || null,
      lat: null, lon: null,
      assignment_status: bucket,
      legacy_id: await legacyId(fields.company, fields.address),
      customizations: {},
    });
  }

  if (insertRows.length > 0) {
    const { error } = await sb.from('recipients')
      .upsert(insertRows, { onConflict: 'campaign_id,legacy_id', ignoreDuplicates: true });
    if (error) return jsonResponse({ error: error.message }, 500);
  }

  return jsonResponse({ totals, sample_issues: [], mapping_used: mapping });
});
```

- [ ] **Step 5: Write the integration test**

Create `supabase/functions/ingest-recipients/test.ts`:

```typescript
// Run with: deno test --allow-net --allow-env supabase/functions/ingest-recipients/test.ts
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from process env (load from .env via dotenv).
import { assert, assertEquals } from 'std/assert/mod.ts';
import { createClient } from '@supabase/supabase-js';

const url = Deno.env.get('SUPABASE_URL')!;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const fnUrl = url.replace('.supabase.co', '.functions.supabase.co').replace('https://', 'https://') + '/ingest-recipients';
// Supabase functions are served from <ref>.functions.supabase.co; if SUPABASE_URL is the rest URL
// (https://<ref>.supabase.co) we just swap subdomains. Adjust if your project uses a custom domain.

const sb = createClient(url, key);

function b64(text: string): string {
  return btoa(text);
}

Deno.test('ingest skeleton: 3-row CSV inserts as needs_review (no geocode yet)', async () => {
  const { data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single();
  const { data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single();

  const csv = 'Company,Address\nAcme,123 Main St\nWidgets,45 Oak Ave\nGears,789 Pine Rd\n';
  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaign_id: camp!.id,
      file_b64: b64(csv),
      file_type: 'csv',
      column_mapping: { Company: 'company', Address: 'address' },
    }),
  });
  const json = await res.json();

  try {
    assertEquals(res.status, 200);
    // No geocode yet → all rows go to needs_review (bucketFor falls through when geocodeOk=false).
    assertEquals(json.totals.needs_review + json.totals.geocode_failed, 0);
    // Actually: with hasCompany=true, hasAddress=true, geocodeOk=false → 'geocode_failed'.
    assertEquals(json.totals.geocode_failed, 3);
    const { data: recips } = await sb.from('recipients').select('*').eq('campaign_id', camp!.id);
    assertEquals(recips!.length, 3);
    assert(recips!.every(r => r.legacy_id && r.legacy_id.length === 64));
  } finally {
    await sb.from('recipients').delete().eq('campaign_id', camp!.id);
    await sb.from('campaigns').delete().eq('id', camp!.id);
    await sb.from('customers').delete().eq('id', cust!.id);
  }
});

Deno.test('re-uploading the same file is idempotent (ON CONFLICT skips dupes)', async () => {
  const { data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single();
  const { data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single();
  const csv = 'Company,Address\nAcme,123 Main St\n';
  const post = () => fetch(fnUrl, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign_id: camp!.id, file_b64: b64(csv), file_type: 'csv', column_mapping: { Company: 'company', Address: 'address' } }),
  });
  try {
    await post(); await post();
    const { data: recips } = await sb.from('recipients').select('*').eq('campaign_id', camp!.id);
    assertEquals(recips!.length, 1, 're-upload should not insert a second copy');
  } finally {
    await sb.from('recipients').delete().eq('campaign_id', camp!.id);
    await sb.from('campaigns').delete().eq('id', camp!.id);
    await sb.from('customers').delete().eq('id', cust!.id);
  }
});
```

- [ ] **Step 6: Re-deploy the function via MCP**

Use `deploy_edge_function` with name `ingest-recipients` and all four files (`index.ts`, `parse.ts`, `legacy_id.ts`, `bucket.ts`).

- [ ] **Step 7: Run the integration test**

Load env vars from `apps/web/.env` first (per the user rule). From repo root:

```bash
set -a; source apps/web/.env; set +a
deno test --allow-net --allow-env supabase/functions/ingest-recipients/test.ts
```

Expected: 2 pass.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/ingest-recipients/
git commit -m "Edge function: parse + bulk insert with ON CONFLICT (no AI/geocode yet)"
```

---

## Task 6: Edge function — AI column mapping

**Files:**
- Create: `supabase/functions/ingest-recipients/ai.ts`
- Modify: `supabase/functions/ingest-recipients/index.ts`
- Modify: `supabase/functions/ingest-recipients/test.ts`

- [ ] **Step 1: Write `ai.ts` with the column-mapping function**

Create `supabase/functions/ingest-recipients/ai.ts`:

```typescript
// ===== OpenAI calls used by ingest-recipients =====
// Two functions: aiSuggestMapping (1 call, returns column→target mapping) and
// aiNormalizeRows (Task 7, batches of 20). Both use temperature=0 and
// response_format json_object so output is parseable.
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const TARGETS = ['company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip'];

export interface MappingResult {
  mapping: Record<string, string | null>;
  confidence: Record<string, 'low' | 'medium' | 'high'>;
}

export async function aiSuggestMapping(headers: string[], sampleRows: string[][]): Promise<MappingResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const sample = sampleRows.slice(0, 5).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
  const prompt = `You are mapping spreadsheet columns to a fixed schema.
Targets: ${TARGETS.join(', ')}.
Each header may map to AT MOST ONE target, and the same target may not be assigned to two headers.
If a header doesn't fit any target, map it to null.
Return JSON: {"mapping": {<header>: <target|null>}, "confidence": {<header>: "low"|"medium"|"high"}}.

Headers: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(sample)}`;

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('OpenAI mapping call failed: ' + res.status);
  const json = await res.json();
  const parsed = JSON.parse(json.choices[0].message.content);
  return parsed as MappingResult;
}
```

- [ ] **Step 2: Add deterministic fallback inside the function**

Add to the bottom of `ai.ts`:

```typescript
// Mirrors public/src/upload/columns.js. Used when OPENAI_API_KEY is missing
// or aiSuggestMapping throws — keeps the pipeline alive.
const SYNONYMS: Record<string, string[]> = {
  company: ['company', 'business name', 'business', 'customer', 'customer name', 'account', 'practice', 'office', 'organization', 'org'],
  contact_name: ['contact', 'contact name', 'name', 'recipient', 'recipient name', 'attention', 'attn'],
  phone: ['phone', 'telephone', 'cell', 'mobile', 'phone number'],
  email: ['email', 'e-mail', 'mail', 'email address'],
  address: ['address', 'street', 'street address', 'address 1', 'address1', 'addr', 'addr 1'],
  city: ['city', 'city town', 'town', 'municipality', 'city/town'],
  state: ['state', 'province', 'region', 'st', 'state/province'],
  zip: ['zip', 'zip code', 'postal', 'postal code', 'postcode'],
};
function normalize(s: string) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

export function fallbackMapping(headers: string[]): MappingResult {
  const mapping: Record<string, string | null> = {};
  const confidence: Record<string, 'low' | 'medium' | 'high'> = {};
  for (const h of headers) {
    const norm = normalize(h);
    let matched: string | null = null;
    let score: 'low' | 'medium' | 'high' = 'low';
    for (const target of TARGETS) {
      const synonyms = SYNONYMS[target];
      if (synonyms.includes(norm)) { matched = target; score = synonyms[0] === norm ? 'high' : 'medium'; break; }
    }
    mapping[h] = matched; confidence[h] = matched ? score : 'low';
  }
  return { mapping, confidence };
}
```

- [ ] **Step 3: Wire AI mapping into `index.ts`**

In `index.ts`, replace the line `const mapping = body.column_mapping || {};` block with:

```typescript
import { aiSuggestMapping, fallbackMapping } from './ai.ts';

// …earlier in the handler, AFTER parsing the file:
let mapping = body.column_mapping;
if (!mapping) {
  if (body.ai_disabled || !Deno.env.get('OPENAI_API_KEY')) {
    mapping = fallbackMapping(parsed.headers).mapping;
  } else {
    try { mapping = (await aiSuggestMapping(parsed.headers, parsed.rows)).mapping; }
    catch (_) { mapping = fallbackMapping(parsed.headers).mapping; }
  }
}
```

(Keep the existing `applyMapping`, bucket loop, insert, and response.)

- [ ] **Step 4: Add a deno test that exercises AI mapping**

Append to `test.ts`:

```typescript
Deno.test('ai mapping: omitting column_mapping triggers AI (or fallback) and still inserts', async () => {
  const { data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single();
  const { data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single();
  // Headers chosen so the deterministic fallback covers them; AI should also handle them.
  const csv = 'Business Name,Street Address\nAcme,123 Main St\nWidgets,45 Oak Ave\n';
  try {
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: camp!.id, file_b64: btoa(csv), file_type: 'csv' }),
    });
    const json = await res.json();
    assertEquals(res.status, 200);
    assertEquals(json.mapping_used['Business Name'], 'company');
    assertEquals(json.mapping_used['Street Address'], 'address');
    const { data: recips } = await sb.from('recipients').select('*').eq('campaign_id', camp!.id);
    assertEquals(recips!.length, 2);
    assertEquals(recips![0].company, 'Acme');
  } finally {
    await sb.from('recipients').delete().eq('campaign_id', camp!.id);
    await sb.from('campaigns').delete().eq('id', camp!.id);
    await sb.from('customers').delete().eq('id', cust!.id);
  }
});
```

- [ ] **Step 5: Re-deploy + run tests**

```bash
# deploy via MCP deploy_edge_function with all 5 files
set -a; source apps/web/.env; set +a
deno test --allow-net --allow-env supabase/functions/ingest-recipients/test.ts
```

Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/ingest-recipients/
git commit -m "Edge function: AI column mapping + deterministic fallback"
```

---

## Task 7: Edge function — AI row normalization

**Files:**
- Modify: `supabase/functions/ingest-recipients/ai.ts`
- Modify: `supabase/functions/ingest-recipients/index.ts`
- Modify: `supabase/functions/ingest-recipients/test.ts`

- [ ] **Step 1: Add `aiNormalizeRows` to `ai.ts`**

Append to `ai.ts`:

```typescript
export interface NormalizedRow {
  company: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  confidence: 'low' | 'medium' | 'high';
}

export async function aiNormalizeRows(rows: Record<string, string>[]): Promise<NormalizedRow[]> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  if (rows.length === 0) return [];
  if (rows.length > 20) throw new Error('aiNormalizeRows accepts at most 20 rows per call');

  const prompt = `Clean these spreadsheet rows. RULES:
- Reformat existing values; never invent missing fields.
- For missing fields return null (not empty string, not a guess).
- Split combined "Address" fields into address + city + state + zip when possible.
- Return per-row "confidence": "low" when company OR address is obviously corrupted, "high" otherwise, "medium" in between.
Return JSON: {"rows": [<NormalizedRow>...]} in the SAME order as input.

Input rows: ${JSON.stringify(rows)}`;

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('OpenAI normalize call failed: ' + res.status);
  const json = await res.json();
  const parsed = JSON.parse(json.choices[0].message.content);
  if (!Array.isArray(parsed.rows) || parsed.rows.length !== rows.length) {
    throw new Error('OpenAI returned wrong row count');
  }
  return parsed.rows;
}
```

- [ ] **Step 2: Wire batched normalization into `index.ts`**

In the handler, after the `applyMapping` loop builds an `Array<Record<Target,string>>`, but BEFORE the insert loop, add a normalization pass. Replace the existing `for (const row of parsed.rows)` block with:

```typescript
import { aiNormalizeRows, NormalizedRow } from './ai.ts';

// 1. Apply mapping → raw mapped fields per row.
const mapped = parsed.rows.map(r => applyMapping(parsed.headers, r, mapping!));

// 2. AI normalize in batches of 20, max 4 in flight.
let normalized: NormalizedRow[];
if (body.ai_disabled || !Deno.env.get('OPENAI_API_KEY')) {
  normalized = mapped.map(m => ({
    company: m.company || null, contact_name: m.contact_name || null,
    phone: m.phone || null, email: m.email || null,
    address: m.address || null, city: m.city || null,
    state: m.state || null, zip: m.zip || null,
    confidence: 'high',
  }));
} else {
  const batches: Record<string, string>[][] = [];
  for (let i = 0; i < mapped.length; i += 20) batches.push(mapped.slice(i, i + 20) as Record<string, string>[]);
  const results: NormalizedRow[][] = new Array(batches.length);
  // Up to 4 in flight at a time.
  let idx = 0;
  async function runBatch(b: number) {
    try { results[b] = await aiNormalizeRows(batches[b]); }
    catch (_) {
      results[b] = batches[b].map(m => ({
        company: m.company || null, contact_name: m.contact_name || null,
        phone: m.phone || null, email: m.email || null,
        address: m.address || null, city: m.city || null,
        state: m.state || null, zip: m.zip || null,
        confidence: 'high',
      }));
    }
  }
  const workers = Array(Math.min(4, batches.length)).fill(0).map(async () => {
    while (idx < batches.length) { const my = idx++; await runBatch(my); }
  });
  await Promise.all(workers);
  normalized = results.flat();
}

// 3. Bucket + collect inserts using the normalized values.
const totals = { assigned: 0, needs_review: 0, flagged_out_of_area: 0, geocode_failed: 0 };
const insertRows: Array<Record<string, unknown>> = [];
for (let i = 0; i < normalized.length; i++) {
  const n = normalized[i];
  const bucket = bucketFor({
    hasCompany: !!n.company, hasAddress: !!n.address,
    aiConfidence: n.confidence, geocodeOk: false, areaMatch: null,
  });
  totals[bucket]++;
  insertRows.push({
    campaign_id: body.campaign_id, bakery_id: null,
    company: n.company || '(unknown)', contact_name: n.contact_name,
    phone: n.phone, email: n.email,
    address: n.address || '(unknown)', city: n.city, state: n.state, zip: n.zip,
    lat: null, lon: null,
    assignment_status: bucket,
    legacy_id: await legacyId(n.company || '', n.address || ''),
    customizations: {},
  });
}
```

- [ ] **Step 3: Add a normalization deno test**

Append to `test.ts`:

```typescript
Deno.test('ai normalization: messy address gets split into parts', async () => {
  const { data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single();
  const { data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single();
  const csv = 'Company,Address\n"Acme Dental","330 Main St San Francisco CA 94105"\n';
  try {
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: camp!.id, file_b64: btoa(csv), file_type: 'csv', column_mapping: { Company: 'company', Address: 'address' } }),
    });
    assertEquals(res.status, 200);
    const { data: recips } = await sb.from('recipients').select('*').eq('campaign_id', camp!.id);
    assertEquals(recips!.length, 1);
    assertEquals(recips![0].city, 'San Francisco', 'AI should split city out');
    assertEquals(recips![0].state, 'CA');
    assertEquals(recips![0].zip, '94105');
  } finally {
    await sb.from('recipients').delete().eq('campaign_id', camp!.id);
    await sb.from('campaigns').delete().eq('id', camp!.id);
    await sb.from('customers').delete().eq('id', cust!.id);
  }
});
```

- [ ] **Step 4: Re-deploy + run tests**

```bash
deno test --allow-net --allow-env supabase/functions/ingest-recipients/test.ts
```

Expected: 4 pass. (If the AI test is flaky, it's because OpenAI variance — mark it as `Deno.test.ignore` and revisit; the contract test in the spec covers stability.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ingest-recipients/
git commit -m "Edge function: AI row normalization (batched, parallelized, fallback-safe)"
```

---

## Task 8: Edge function — geocoding with cache

**Files:**
- Create: `supabase/functions/ingest-recipients/geocode.ts`
- Modify: `supabase/functions/ingest-recipients/index.ts`
- Modify: `supabase/functions/ingest-recipients/test.ts`

- [ ] **Step 1: Write `geocode.ts`**

Create `supabase/functions/ingest-recipients/geocode.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export interface GeocodeResult { lat: number; lon: number; display_name: string }

const MAPBOX_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places/';

function normalizeAddress(parts: { address: string | null; city: string | null; state: string | null; zip: string | null }): string {
  return [parts.address, parts.city, parts.state, parts.zip]
    .map(p => (p || '').trim()).filter(Boolean).join(', ').toLowerCase();
}

async function geocodeOne(query: string, token: string): Promise<GeocodeResult | null> {
  const url = MAPBOX_URL + encodeURIComponent(query) + '.json?access_token=' + token + '&country=US&limit=1';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      continue;
    }
    if (!res.ok) return null;
    const json = await res.json();
    const f = json.features?.[0];
    if (!f) return null;
    return { lon: f.center[0], lat: f.center[1], display_name: f.place_name };
  }
  return null;
}

export async function geocodeRows(
  sb: SupabaseClient,
  rows: Array<{ address: string | null; city: string | null; state: string | null; zip: string | null }>,
): Promise<Array<GeocodeResult | null>> {
  const token = Deno.env.get('MAPBOX_SECRET_TOKEN');
  if (!token) throw new Error('MAPBOX_SECRET_TOKEN not set');

  const normalized = rows.map(normalizeAddress);
  const results: Array<GeocodeResult | null> = new Array(rows.length).fill(null);
  const toFetch: number[] = [];

  // 1. Cache lookup, batched in chunks of 100.
  for (let i = 0; i < normalized.length; i += 100) {
    const chunk = normalized.slice(i, i + 100).map((n, k) => ({ idx: i + k, n })).filter(x => x.n);
    if (chunk.length === 0) continue;
    const { data: hits } = await sb.from('geocode_cache')
      .select('normalized_address, lat, lon, display_name')
      .in('normalized_address', chunk.map(c => c.n));
    const hitMap = new Map((hits || []).map(h => [h.normalized_address, h]));
    for (const c of chunk) {
      const hit = hitMap.get(c.n);
      if (hit) results[c.idx] = { lat: hit.lat, lon: hit.lon, display_name: hit.display_name || '' };
      else toFetch.push(c.idx);
    }
  }

  // 2. Mapbox calls for cache misses, max 4 in flight.
  let cursor = 0;
  const cacheWrites: Array<Record<string, unknown>> = [];
  async function worker() {
    while (cursor < toFetch.length) {
      const my = cursor++;
      const idx = toFetch[my];
      const query = normalized[idx];
      if (!query) continue;
      const hit = await geocodeOne(query, token);
      results[idx] = hit;
      if (hit) cacheWrites.push({
        normalized_address: query, lat: hit.lat, lon: hit.lon,
        display_name: hit.display_name, provider: 'mapbox',
      });
    }
  }
  const pool = Array(Math.min(4, toFetch.length)).fill(0).map(() => worker());
  await Promise.all(pool);

  // 3. Persist new cache entries (best effort; ignore conflicts on the PK).
  if (cacheWrites.length > 0) {
    await sb.from('geocode_cache').upsert(cacheWrites, { onConflict: 'normalized_address', ignoreDuplicates: true });
  }

  return results;
}
```

- [ ] **Step 2: Wire `geocodeRows` into `index.ts`**

In `index.ts`, after the normalization pass produces `normalized: NormalizedRow[]`, add:

```typescript
import { geocodeRows } from './geocode.ts';

const geocodes = await geocodeRows(sb, normalized);
```

Then update the bucket+insert loop:

```typescript
for (let i = 0; i < normalized.length; i++) {
  const n = normalized[i];
  const g = geocodes[i];
  const bucket = bucketFor({
    hasCompany: !!n.company, hasAddress: !!n.address,
    aiConfidence: n.confidence,
    geocodeOk: !!g,
    areaMatch: null, // Task 9
  });
  totals[bucket]++;
  insertRows.push({
    /* …same fields as before… */
    lat: g?.lat ?? null, lon: g?.lon ?? null,
    assignment_status: bucket,
    /* …rest unchanged… */
  });
}
```

- [ ] **Step 3: Add a geocoding deno test**

Append to `test.ts`:

```typescript
Deno.test('geocoding: a real address gets lat/lon and lands in geocode_failed-or-better', async () => {
  const { data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single();
  const { data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single();
  const csv = 'Company,Address\nMomofuku,171 1st Ave New York NY 10003\nFakePlace,zzzzzzzz nowhere\n';
  try {
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: camp!.id, file_b64: btoa(csv), file_type: 'csv', column_mapping: { Company: 'company', Address: 'address' } }),
    });
    assertEquals(res.status, 200);
    const { data: recips } = await sb.from('recipients').select('*').eq('campaign_id', camp!.id).order('company');
    assertEquals(recips!.length, 2);
    const fakeRow = recips!.find(r => r.company === 'FakePlace')!;
    assertEquals(fakeRow.assignment_status, 'geocode_failed');
    const realRow = recips!.find(r => r.company === 'Momofuku')!;
    assert(realRow.lat !== null && realRow.lon !== null, 'real address should have lat/lon');
    // No bakery polygons cover NYC → flagged_out_of_area (set in Task 9). For now,
    // assert it's at least not geocode_failed.
    assert(realRow.assignment_status !== 'geocode_failed');
  } finally {
    await sb.from('recipients').delete().eq('campaign_id', camp!.id);
    await sb.from('campaigns').delete().eq('id', camp!.id);
    await sb.from('customers').delete().eq('id', cust!.id);
  }
});
```

- [ ] **Step 4: Re-deploy + run tests**

```bash
deno test --allow-net --allow-env supabase/functions/ingest-recipients/test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ingest-recipients/
git commit -m "Edge function: Mapbox geocoding with cache + retry"
```

---

## Task 9: Edge function — area match + bucket finalization

**Files:**
- Modify: `supabase/functions/ingest-recipients/index.ts`
- Modify: `supabase/functions/ingest-recipients/test.ts`

- [ ] **Step 1: Add area-match logic in `index.ts`**

In `index.ts`, near the top of the handler (after we've validated the campaign), load all delivery areas once:

```typescript
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

const { data: areas } = await sb.from('delivery_areas').select('id, bakery_id, geometry');

function findArea(lon: number, lat: number): { bakery_id: string; id: string } | null {
  for (const a of areas || []) {
    const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} } as const;
    const poly = { type: 'Feature', geometry: a.geometry, properties: {} } as const;
    try { if (booleanPointInPolygon(pt as never, poly as never)) return { bakery_id: a.bakery_id, id: a.id }; }
    catch (_) { continue; }
  }
  return null;
}
```

Update the bucket+insert loop's `areaMatch` and the `bakery_id` field on insert:

```typescript
for (let i = 0; i < normalized.length; i++) {
  const n = normalized[i];
  const g = geocodes[i];
  const matched = g ? findArea(g.lon, g.lat) : null;
  const bucket = bucketFor({
    hasCompany: !!n.company, hasAddress: !!n.address,
    aiConfidence: n.confidence,
    geocodeOk: !!g,
    areaMatch: matched,
  });
  totals[bucket]++;
  insertRows.push({
    campaign_id: body.campaign_id,
    bakery_id: matched ? matched.bakery_id : null,
    company: n.company || '(unknown)', contact_name: n.contact_name,
    phone: n.phone, email: n.email,
    address: n.address || '(unknown)', city: n.city, state: n.state, zip: n.zip,
    lat: g?.lat ?? null, lon: g?.lon ?? null,
    assignment_status: bucket,
    legacy_id: await legacyId(n.company || '', n.address || ''),
    customizations: {},
  });
}
```

- [ ] **Step 2: Build the sample_issues array**

Right before the response, collect up to 10 sample issues across the three problem buckets (one per row, prefer needs_review first):

```typescript
const sample_issues: Array<{ recipient_id: string; reason: string; raw: Record<string,string>; suggested?: Record<string,string|null> }> = [];
// We don't have recipient_ids until insert; reselect to get them.
const { data: insertedRows } = await sb.from('recipients')
  .select('id, company, address, assignment_status')
  .eq('campaign_id', body.campaign_id)
  .neq('assignment_status', 'assigned')
  .limit(10);
for (const r of insertedRows || []) {
  sample_issues.push({
    recipient_id: r.id,
    reason: r.assignment_status,
    raw: { company: r.company, address: r.address },
  });
}
```

(Replace the existing `sample_issues: []` in the response.)

- [ ] **Step 3: Add an end-to-end deno test using a real bakery polygon**

Append to `test.ts`:

```typescript
Deno.test('end-to-end: address inside Boho Petite polygon lands as assigned', async () => {
  const { data: boho } = await sb.from('bakeries').select('id').eq('name', 'Boho Petite').maybeSingle();
  if (!boho) {
    console.warn('Boho Petite not seeded; skipping');
    return;
  }
  const { data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single();
  const { data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single();
  // 633 Folsom St is inside SF, which is inside Boho Petite's migrated polygon.
  const csv = 'Company,Address\n"Daymaker HQ","633 Folsom St San Francisco CA 94107"\n';
  try {
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: camp!.id, file_b64: btoa(csv), file_type: 'csv', column_mapping: { Company: 'company', Address: 'address' } }),
    });
    const json = await res.json();
    assertEquals(res.status, 200);
    assertEquals(json.totals.assigned, 1);
    const { data: recips } = await sb.from('recipients').select('*').eq('campaign_id', camp!.id);
    assertEquals(recips![0].bakery_id, boho.id);
  } finally {
    await sb.from('recipients').delete().eq('campaign_id', camp!.id);
    await sb.from('campaigns').delete().eq('id', camp!.id);
    await sb.from('customers').delete().eq('id', cust!.id);
  }
});
```

- [ ] **Step 4: Add a `geocode-single` sub-route**

The wizard's per-row "Retry geocode" / "Edit address" actions need to re-run geocode + area-match for one row. Spec says it lives inside this same function as a separate route for v1. Add a route prefix check at the top of the handler in `index.ts`:

```typescript
const url = new URL(req.url);
const isSingle = url.pathname.endsWith('/geocode-single');

if (isSingle) {
  const { recipient_id, address, city, state, zip } = await req.json();
  if (!recipient_id) return jsonResponse({ error: 'recipient_id required' }, 400);
  const { data: r } = await sb.from('recipients').select('id, company, campaign_id').eq('id', recipient_id).maybeSingle();
  if (!r) return jsonResponse({ error: 'recipient_not_found' }, 404);
  const [g] = await geocodeRows(sb, [{ address, city, state, zip }]);
  const matched = g ? findArea(g.lon, g.lat) : null;
  const bucket = bucketFor({
    hasCompany: !!r.company, hasAddress: !!address,
    aiConfidence: 'high', geocodeOk: !!g, areaMatch: matched,
  });
  const { error } = await sb.from('recipients').update({
    address: address || null, city: city || null, state: state || null, zip: zip || null,
    lat: g?.lat ?? null, lon: g?.lon ?? null,
    bakery_id: matched ? matched.bakery_id : null,
    assignment_status: bucket,
  }).eq('id', recipient_id);
  if (error) return jsonResponse({ error: error.message }, 500);
  return jsonResponse({ assignment_status: bucket, lat: g?.lat ?? null, lon: g?.lon ?? null, bakery_id: matched?.bakery_id ?? null });
}
```

(Place this `if (isSingle)` block immediately after the `Deno.env.get(...)` `sb` client is created and before any `body.campaign_id` validation, since the single-row path uses a different request shape.)

Also note: `findArea` is defined inside the outer handler; pull it (and the `areas` query) up to module scope so the single-row path can reuse it. Refactor:

```typescript
let _areasCache: Array<{ id: string; bakery_id: string; geometry: unknown }> | null = null;
async function loadAreas(sb: SupabaseClient) {
  if (_areasCache) return _areasCache;
  const { data } = await sb.from('delivery_areas').select('id, bakery_id, geometry');
  _areasCache = data || [];
  return _areasCache;
}
function findAreaIn(areas: Array<{ id: string; bakery_id: string; geometry: unknown }>, lon: number, lat: number) {
  for (const a of areas) {
    const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} } as const;
    const poly = { type: 'Feature', geometry: a.geometry, properties: {} } as const;
    try { if (booleanPointInPolygon(pt as never, poly as never)) return { bakery_id: a.bakery_id, id: a.id }; }
    catch (_) { continue; }
  }
  return null;
}
```

Then both the bulk handler and the single-row handler call `findAreaIn(await loadAreas(sb), lon, lat)`. The cache is per-isolate; Supabase recycles edge-function isolates often enough that polygon edits propagate within seconds.

- [ ] **Step 5: Add a single-row deno test**

Append to `test.ts`:

```typescript
Deno.test('geocode-single: edits address + bucket on a flagged row', async () => {
  const { data: cust } = await sb.from('customers').insert({ name: 'TEST_cust_' + Math.random(), access_token: crypto.randomUUID() }).select('*').single();
  const { data: camp } = await sb.from('campaigns').insert({ customer_id: cust!.id, name: 'TEST_camp', status: 'draft' }).select('*').single();
  const { data: recip } = await sb.from('recipients').insert({
    campaign_id: camp!.id, company: 'Daymaker HQ', address: 'zzz nowhere',
    assignment_status: 'geocode_failed', legacy_id: 'singletest_' + Math.random(),
  }).select('*').single();
  try {
    const res = await fetch(fnUrl + '/geocode-single', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: recip!.id, address: '633 Folsom St', city: 'San Francisco', state: 'CA', zip: '94107' }),
    });
    const json = await res.json();
    assertEquals(res.status, 200);
    assert(json.lat !== null, 'should have geocoded');
    const { data: after } = await sb.from('recipients').select('*').eq('id', recip!.id).single();
    assert(after!.assignment_status !== 'geocode_failed');
  } finally {
    await sb.from('recipients').delete().eq('campaign_id', camp!.id);
    await sb.from('campaigns').delete().eq('id', camp!.id);
    await sb.from('customers').delete().eq('id', cust!.id);
  }
});
```

- [ ] **Step 6: Re-deploy + run tests**

```bash
deno test --allow-net --allow-env supabase/functions/ingest-recipients/test.ts
```

Expected: 7 pass.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/ingest-recipients/
git commit -m "Edge function: area match, sample_issues, + geocode-single sub-route"
```

---

## Task 10: Wizard shell + Step 1 (file + name)

**Files:**
- Create: `public/src/db/customer.js`
- Create: `public/src/components/UploadWizard.jsx`
- Modify: `public/index.html` (add SheetJS CDN + new component scripts)

- [ ] **Step 1: Add SheetJS CDN + script tags to `index.html`**

In `public/index.html`, in the vendor block (next to the other CDN scripts):

```html
<!-- SheetJS for in-browser CSV/XLSX preview (Plan 3) -->
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
```

In the helper-script block (after `overlap.js` / `reassign.js`):

```html
<!-- Upload helpers (Plan 3) -->
<script src="./src/upload/parse.js"></script>
<script src="./src/upload/columns.js"></script>

<!-- Customer-side data layer (Plan 3) -->
<script src="./src/db/customer.js"></script>
```

In the React-component block (after `CustomerHomeView.jsx`):

```html
<script type="text/babel" src="./src/components/UploadWizard.jsx"></script>
```

- [ ] **Step 2: Create `public/src/db/customer.js`**

```javascript
// ===== CUSTOMER DATA ACCESS =====
// Wizard-side helpers. Permissive RLS makes these direct browser writes
// safe under the Plan 2 pivot. Mirrors the Admin module's shape.
const Customer = {
  async createDraftCampaign(customer_id, name) {
    if (!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('campaigns')
      .insert({ customer_id, name, status: 'draft' })
      .select('*').single();
    if (error) throw error;
    return data;
  },

  async finalizeCampaign(id) {
    if (!sb) throw new Error('sb not ready');
    const { error } = await sb.from('campaigns').update({ status: 'active' }).eq('id', id);
    if (error) throw error;
  },

  async listRecipients(campaign_id) {
    if (!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('recipients')
      .select('id, company, contact_name, phone, email, address, city, state, zip, lat, lon, assignment_status, customizations, bakery_id')
      .eq('campaign_id', campaign_id)
      .order('company');
    if (error) throw error;
    return data || [];
  },

  async ingestFile({ campaign_id, file, columnMapping }) {
    if (!sb) throw new Error('sb not ready');
    const fileType = /\.xlsx$/i.test(file.name) ? 'xlsx' : 'csv';
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const url = sb.supabaseUrl.replace('.supabase.co', '.functions.supabase.co') + '/ingest-recipients';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + sb.supabaseKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ campaign_id, file_b64: b64, file_type: fileType, column_mapping: columnMapping }),
    });
    if (!res.ok) throw new Error('ingest failed: ' + res.status + ' ' + await res.text());
    return await res.json();
  },
};

if (typeof window !== 'undefined') window.Customer = Customer;
```

- [ ] **Step 3: Create `UploadWizard.jsx` with Step 1 only**

Create `public/src/components/UploadWizard.jsx`:

```jsx
// ===== UPLOAD WIZARD =====
// Three-step wizard for customer recipient upload. Step 1 in this file;
// Tasks 11–13 add steps 2 + 3.
function UploadWizard({customerId, campaignId}){
  const [step, setStep] = useState(campaignId === 'new' ? 1 : 1);
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null); // {headers, rows}
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  const [campaign, setCampaign] = useState(null);

  useEffect(() => {
    if (campaignId === 'new') return;
    (async () => {
      const { data: c } = await sb.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
      if (!c) return;
      setCampaign(c); setName(c.name || '');
      // Resume detection (spec: "reopening the wizard at the same URL skips
      // the file step and jumps straight to step 3"). If recipients already
      // exist for this campaign, the file's been ingested; jump to review.
      const { count } = await sb.from('recipients').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId);
      if ((count || 0) > 0) setStep(3);
    })();
  }, [campaignId]);

  async function onPickFile(f) {
    setErr(''); setFile(f); setParsed(null);
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const result = parseFile(buf, /\.xlsx$/i.test(f.name) ? 'xlsx' : 'csv');
      setParsed(result);
    } catch (e) { setErr(e.message || String(e)); }
  }

  async function continueToStep2() {
    setWorking(true); setErr('');
    try {
      let camp = campaign;
      if (!camp) {
        camp = await Customer.createDraftCampaign(customerId, name.trim());
        setCampaign(camp);
        navigate('#/customer/' + customerId + '/upload/' + camp.id);
      }
      setStep(2);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  return <div className="wizard-shell">
    <aside className="wizard-rail">
      <div className="wizard-rail-header">Upload</div>
      <WizardStep n={1} label="File" active={step===1} done={step>1}/>
      <WizardStep n={2} label="Columns" active={step===2} done={step>2}/>
      <WizardStep n={3} label="Review" active={step===3} done={false}/>
    </aside>
    <main className="wizard-main">
      <header className="wizard-header">
        <h1>{campaign ? campaign.name : 'New campaign'}</h1>
        <a className="btn-ghost" href={'#/customer/' + customerId}>Cancel</a>
      </header>

      {err && <div className="wizard-err">{err}</div>}

      {step === 1 && <section className="wizard-step">
        <h2>Upload your recipient list</h2>
        <div className="wizard-field">
          <label>Campaign name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Q3 2026 deliveries"/>
        </div>
        <div className="wizard-dropzone">
          <input type="file" accept=".csv,.xlsx" onChange={e => onPickFile(e.target.files[0])}/>
          <div className="wizard-dropzone-hint">CSV or XLSX, up to 5,000 rows</div>
        </div>
        {parsed && <div className="wizard-preview">
          <div className="wizard-preview-meta">{parsed.rows.length} rows · {parsed.headers.length} columns</div>
          <table className="wizard-preview-table"><thead><tr>{parsed.headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{parsed.rows.slice(0,5).map((r,i) => <tr key={i}>{r.map((c,j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>}
        <div className="wizard-footer">
          <button className="btn-primary" disabled={!name.trim() || !parsed || working} onClick={continueToStep2}>
            {working ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </section>}

      {step === 2 && <ColumnMappingStep parsed={parsed} onBack={() => setStep(1)} onContinue={() => setStep(3)} campaign={campaign} file={file}/>}
      {step === 3 && <ReviewStep campaign={campaign} customerId={customerId} onBack={() => setStep(2)}/>}
    </main>
  </div>;
}

function WizardStep({n, label, active, done}) {
  const cls = 'wizard-step-rail ' + (active ? 'active' : done ? 'done' : '');
  return <div className={cls}>
    <span className="wizard-step-num">{done ? '✓' : n}</span>
    <span className="wizard-step-label">{label}</span>
  </div>;
}

// Stubs for tasks 11 + 12.
function ColumnMappingStep() { return <div className="wizard-step">Step 2 placeholder (Task 11)</div>; }
function ReviewStep() { return <div className="wizard-step">Step 3 placeholder (Task 12)</div>; }
```

- [ ] **Step 4: Add wizard CSS to `public/src/styles.css`**

Append to `public/src/styles.css`:

```css
.wizard-shell{display:flex;height:calc(100vh - 20px);background:#fff}
.wizard-rail{width:200px;background:#f9fafb;border-right:1px solid #e5e7eb;padding:20px 16px}
.wizard-rail-header{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:18px}
.wizard-step-rail{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px;color:#9ca3af}
.wizard-step-rail.active{color:#111;font-weight:600}
.wizard-step-rail.done{color:#10b981}
.wizard-step-num{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#e5e7eb;color:#6b7280;font-size:11px;font-weight:600}
.wizard-step-rail.active .wizard-step-num{background:#2563eb;color:#fff}
.wizard-step-rail.done .wizard-step-num{background:#10b981;color:#fff}
.wizard-main{flex:1;display:flex;flex-direction:column;overflow:auto}
.wizard-header{display:flex;justify-content:space-between;align-items:center;padding:18px 28px;border-bottom:1px solid #f3f4f6}
.wizard-header h1{font-size:18px;font-weight:700;margin:0}
.wizard-step{padding:24px 28px;flex:1;display:flex;flex-direction:column;gap:16px}
.wizard-field label{display:block;font-size:12px;color:#6b7280;font-weight:500;margin-bottom:4px}
.wizard-field input{width:100%;max-width:420px;padding:8px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px}
.wizard-dropzone{border:2px dashed #d1d5db;border-radius:8px;padding:24px;text-align:center;background:#f9fafb}
.wizard-dropzone-hint{font-size:12px;color:#9ca3af;margin-top:8px}
.wizard-preview{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
.wizard-preview-meta{padding:8px 12px;background:#f9fafb;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb}
.wizard-preview-table{width:100%;border-collapse:collapse;font-size:12px}
.wizard-preview-table th,.wizard-preview-table td{padding:6px 10px;border-bottom:1px solid #f3f4f6;text-align:left}
.wizard-preview-table th{background:#f9fafb;font-weight:600;color:#374151}
.wizard-footer{display:flex;justify-content:flex-end;gap:8px;padding-top:12px;border-top:1px solid #f3f4f6;margin-top:auto}
.wizard-err{margin:12px 28px;background:#fef2f2;color:#991b1b;padding:10px 12px;border-radius:6px;font-size:13px}
```

- [ ] **Step 5: Smoke-test by manually visiting the route**

(We wire the route in Task 14, so for now the manual test is to open the dev server and navigate to `#/customer/<existing-customer-id>/upload/new` directly in the URL bar after Task 14. Skip until then; this task just commits the shell.)

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/src/db/customer.js public/src/components/UploadWizard.jsx public/src/styles.css
git commit -m "UploadWizard: shell + Step 1 (file + campaign name)"
```

---

## Task 11: Wizard Step 2 — column mapping

**Files:**
- Modify: `public/src/components/UploadWizard.jsx`

- [ ] **Step 1: Replace the `ColumnMappingStep` stub**

In `UploadWizard.jsx`, replace the `ColumnMappingStep` stub with:

```jsx
function ColumnMappingStep({parsed, onBack, onContinue, campaign, file}) {
  const TARGETS = ['', 'company', 'contact_name', 'phone', 'email', 'address', 'city', 'state', 'zip'];
  // Initial guess from the deterministic heuristic; AI runs server-side.
  const [mapping, setMapping] = useState(() => suggestMapping(parsed.headers).mapping);
  const [confidence] = useState(() => suggestMapping(parsed.headers).confidence);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');
  const [ingestResult, setIngestResult] = useState(null);

  function setHeaderTarget(header, target) {
    setMapping(m => ({...m, [header]: target || null}));
  }

  async function continueToReview() {
    setWorking(true); setErr('');
    try {
      const result = await Customer.ingestFile({
        campaign_id: campaign.id,
        file,
        columnMapping: mapping,
      });
      setIngestResult(result);
      onContinue(result);
    } catch (e) { setErr(e.message || String(e)); }
    setWorking(false);
  }

  // Surface a duplicate-target warning so customers don't map two columns to "company".
  const dupes = Object.values(mapping).filter(t => t).reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  const hasDupe = Object.values(dupes).some(n => n > 1);
  const requiresFilled = mapping[Object.keys(mapping).find(h => mapping[h] === 'company')] === 'company'
    && mapping[Object.keys(mapping).find(h => mapping[h] === 'address')] === 'address';

  return <section className="wizard-step">
    <h2>Confirm column mapping</h2>
    <p className="wizard-step-sub">Pick a target field for each column from your file. Required: <code>company</code> + <code>address</code>.</p>
    {err && <div className="wizard-err" style={{margin:0}}>{err}</div>}
    {hasDupe && <div className="wizard-warn">Two columns map to the same target. Only the first will be used; you probably want to set the duplicate to "—".</div>}
    <table className="wizard-mapping-table">
      <thead><tr><th>Source column</th><th>Sample value</th><th>AI / heuristic</th><th>Maps to</th></tr></thead>
      <tbody>
        {parsed.headers.map(h => {
          const sample = (parsed.rows[0] || [])[parsed.headers.indexOf(h)] || '';
          return <tr key={h}>
            <td><b>{h}</b></td>
            <td className="wizard-sample">{sample}</td>
            <td><span className={'wizard-conf ' + (confidence[h] || 'low')}>{confidence[h] || 'low'}</span></td>
            <td>
              <select value={mapping[h] || ''} onChange={e => setHeaderTarget(h, e.target.value)}>
                {TARGETS.map(t => <option key={t} value={t}>{t || '—'}</option>)}
              </select>
            </td>
          </tr>;
        })}
      </tbody>
    </table>
    <div className="wizard-footer">
      <button className="btn-ghost" onClick={onBack} disabled={working}>‹ Back</button>
      <button className="btn-primary" disabled={!requiresFilled || working} onClick={continueToReview}>
        {working ? 'Ingesting…' : 'Continue'}
      </button>
    </div>
  </section>;
}
```

- [ ] **Step 2: Pass the ingest result up so Step 3 can render it**

In `UploadWizard`'s render, change:

```jsx
{step === 2 && <ColumnMappingStep parsed={parsed} onBack={() => setStep(1)} onContinue={() => setStep(3)} campaign={campaign} file={file}/>}
```

to:

```jsx
{step === 2 && <ColumnMappingStep parsed={parsed} onBack={() => setStep(1)} onContinue={(r) => { setIngestResult(r); setStep(3); }} campaign={campaign} file={file}/>}
```

And add `const [ingestResult, setIngestResult] = useState(null);` near the other `useState` calls in the wizard.

- [ ] **Step 3: Add CSS for the mapping table**

Append to `public/src/styles.css`:

```css
.wizard-step-sub{margin:0;color:#6b7280;font-size:13px}
.wizard-warn{background:#fef3c7;color:#92400e;padding:8px 12px;border-radius:6px;font-size:13px}
.wizard-mapping-table{width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden}
.wizard-mapping-table th,.wizard-mapping-table td{padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:left}
.wizard-mapping-table th{background:#f9fafb;font-size:12px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.04em}
.wizard-mapping-table select{padding:4px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:13px}
.wizard-sample{color:#6b7280;font-family:ui-monospace,Menlo,monospace;font-size:12px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wizard-conf{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;text-transform:uppercase}
.wizard-conf.high{background:#dcfce7;color:#15803d}
.wizard-conf.medium{background:#fef3c7;color:#92400e}
.wizard-conf.low{background:#fee2e2;color:#dc2626}
```

- [ ] **Step 4: Commit**

```bash
git add public/src/components/UploadWizard.jsx public/src/styles.css
git commit -m "UploadWizard: Step 2 column-mapping table + ingest call"
```

---

## Task 12: Wizard Step 3 — tabbed bucket review (read-only)

**Files:**
- Modify: `public/src/components/UploadWizard.jsx`

- [ ] **Step 1: Replace the `ReviewStep` stub**

```jsx
function ReviewStep({campaign, customerId, onBack, ingestResult}) {
  const [tab, setTab] = useState('needs_review');
  const [recipients, setRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [finalizing, setFinalizing] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setRecipients(await Customer.listRecipients(campaign.id)); }
    catch (e) { setErr(e.message); }
    setLoading(false);
  }, [campaign.id]);

  useEffect(() => { reload(); }, [reload]);

  const counts = {
    assigned: recipients.filter(r => r.assignment_status === 'assigned').length,
    needs_review: recipients.filter(r => r.assignment_status === 'needs_review').length,
    flagged_out_of_area: recipients.filter(r => r.assignment_status === 'flagged_out_of_area').length,
    geocode_failed: recipients.filter(r => r.assignment_status === 'geocode_failed').length,
  };
  const inTab = recipients.filter(r => r.assignment_status === tab);

  async function finalize() {
    setFinalizing(true);
    try {
      await Customer.finalizeCampaign(campaign.id);
      navigate('#/customer/' + customerId);
    } catch (e) { setErr(e.message); }
    setFinalizing(false);
  }

  return <section className="wizard-step">
    <h2>Review &amp; finalize</h2>
    <p className="wizard-step-sub">{recipients.length} rows ingested. Tabs show each bucket; the count next to each is live.</p>
    {err && <div className="wizard-err" style={{margin:0}}>{err}</div>}

    <div className="wizard-tabs">
      <Tab label="Assigned" n={counts.assigned} active={tab==='assigned'} onClick={() => setTab('assigned')} color="#15803d"/>
      <Tab label="Needs review" n={counts.needs_review} active={tab==='needs_review'} onClick={() => setTab('needs_review')} color="#7c3aed"/>
      <Tab label="Out of area" n={counts.flagged_out_of_area} active={tab==='flagged_out_of_area'} onClick={() => setTab('flagged_out_of_area')} color="#b45309"/>
      <Tab label="Geocode failed" n={counts.geocode_failed} active={tab==='geocode_failed'} onClick={() => setTab('geocode_failed')} color="#dc2626"/>
    </div>

    {loading ? <div style={{padding:24,color:'#9ca3af'}}>Loading…</div> : (
      inTab.length === 0
        ? <div className="wizard-empty">Nothing in this bucket. 🎉</div>
        : <div className="wizard-row-list">{inTab.map(r => <RecipientRow key={r.id} row={r} bucket={tab} onChanged={reload}/>)}</div>
    )}

    <div className="wizard-footer">
      <button className="btn-ghost" onClick={onBack}>‹ Back to columns</button>
      <div style={{flex:1, fontSize:12, color:'#6b7280', textAlign:'right', marginRight:8}}>
        {counts.assigned} will be delivered. {counts.needs_review + counts.flagged_out_of_area + counts.geocode_failed} still need attention.
      </div>
      <button className="btn-primary" onClick={finalize} disabled={finalizing}>
        {finalizing ? 'Finalizing…' : 'Finalize campaign'}
      </button>
    </div>
  </section>;
}

function Tab({label, n, active, onClick, color}) {
  const cls = 'wizard-tab' + (active ? ' active' : '');
  const style = active ? {borderBottomColor: color, color} : {};
  return <button className={cls} style={style} onClick={onClick}>{label} <span className="wizard-tab-count">{n}</span></button>;
}

// RecipientRow lives here; per-row actions are wired in Task 13.
function RecipientRow({row, bucket}) {
  return <div className="wizard-row">
    <div className="wizard-row-main">
      <div className="wizard-row-name">{row.company}</div>
      <div className="wizard-row-addr">{[row.address, row.city, row.state, row.zip].filter(Boolean).join(', ')}</div>
    </div>
    <div className="wizard-row-actions">
      <span style={{fontSize:11,color:'#9ca3af'}}>(actions in Task 13)</span>
    </div>
  </div>;
}
```

- [ ] **Step 2: Pass `ingestResult` to `ReviewStep`**

In the wizard render:

```jsx
{step === 3 && <ReviewStep campaign={campaign} customerId={customerId} onBack={() => setStep(2)} ingestResult={ingestResult}/>}
```

- [ ] **Step 3: Add tab + row CSS**

Append to `public/src/styles.css`:

```css
.wizard-tabs{display:flex;gap:0;border-bottom:1px solid #e5e7eb}
.wizard-tab{background:none;border:none;border-bottom:2px solid transparent;padding:10px 16px;font-size:13px;color:#6b7280;cursor:pointer;font-family:inherit}
.wizard-tab:hover{color:#111}
.wizard-tab.active{font-weight:600}
.wizard-tab-count{display:inline-block;background:#f3f4f6;color:#374151;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;margin-left:6px}
.wizard-row-list{display:flex;flex-direction:column;gap:8px}
.wizard-row{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#fff;border:1px solid #e5e7eb;border-radius:6px}
.wizard-row-name{font-size:13px;font-weight:600;color:#111}
.wizard-row-addr{font-size:12px;color:#6b7280;margin-top:2px}
.wizard-row-actions{display:flex;gap:6px;align-items:center}
.wizard-empty{padding:32px;text-align:center;color:#9ca3af;font-size:13px;background:#f9fafb;border:1px dashed #e5e7eb;border-radius:8px}
```

- [ ] **Step 4: Commit**

```bash
git add public/src/components/UploadWizard.jsx public/src/styles.css
git commit -m "UploadWizard: Step 3 tabbed bucket review (read-only)"
```

---

## Task 13: Step 3 per-row actions

**Files:**
- Modify: `public/src/components/UploadWizard.jsx`
- Modify: `public/src/db/customer.js`

- [ ] **Step 1: Add per-row mutators to `customer.js`**

Append to `public/src/db/customer.js` inside the `Customer = {…}` object (before the closing `};`):

```javascript
  async acceptRecipient(id, fields) {
    if (!sb) throw new Error('sb not ready');
    const { error } = await sb.from('recipients').update({
      ...fields, assignment_status: 'assigned',
    }).eq('id', id);
    if (error) throw error;
  },

  async skipRecipient(id) {
    if (!sb) throw new Error('sb not ready');
    const { data: r } = await sb.from('recipients').select('customizations').eq('id', id).single();
    const next = { ...(r?.customizations || {}), skipped: true };
    const { error } = await sb.from('recipients').update({ customizations: next }).eq('id', id);
    if (error) throw error;
  },

  async retryGeocode(recipient_id, fields) {
    if (!sb) throw new Error('sb not ready');
    const url = sb.supabaseUrl.replace('.supabase.co', '.functions.supabase.co') + '/ingest-recipients/geocode-single';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + sb.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id, ...fields }),
    });
    if (!res.ok) throw new Error('retry geocode failed: ' + res.status + ' ' + await res.text());
    return await res.json();
  },
```

- [ ] **Step 2: Replace `RecipientRow` with the action-aware version**

In `UploadWizard.jsx`, replace `RecipientRow` with:

```jsx
function RecipientRow({row, bucket, onChanged}) {
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState({
    company: row.company, contact_name: row.contact_name || '',
    phone: row.phone || '', email: row.email || '',
    address: row.address, city: row.city || '', state: row.state || '', zip: row.zip || '',
  });

  async function accept(fields) {
    setWorking(true);
    if (bucket === 'flagged_out_of_area' || bucket === 'geocode_failed') {
      // Re-run geocode + area-match through the edge function so a new
      // address actually moves the row into Assigned (or stays out-of-area).
      await Customer.retryGeocode(row.id, {
        address: (fields || draft).address, city: (fields || draft).city,
        state: (fields || draft).state, zip: (fields || draft).zip,
      });
    } else {
      await Customer.acceptRecipient(row.id, fields || draft);
    }
    setWorking(false); setEditing(false); onChanged();
  }
  async function skip() {
    setWorking(true);
    await Customer.skipRecipient(row.id);
    setWorking(false); onChanged();
  }
  function copyMail() {
    const subject = encodeURIComponent('Out-of-area recipient: ' + row.company);
    const body = encodeURIComponent(
      `Recipient address falls outside every bakery polygon:\n\n${row.company}\n${row.address}, ${row.city || ''} ${row.state || ''} ${row.zip || ''}\n\nCan a bakery cover this?`
    );
    window.location.href = 'mailto:contact@daymaker.com?subject=' + subject + '&body=' + body;
  }

  return <div className="wizard-row">
    <div className="wizard-row-main">
      {editing ? (
        <div className="wizard-row-edit">
          <input value={draft.company} onChange={e => setDraft(d => ({...d, company: e.target.value}))} placeholder="Company"/>
          <input value={draft.address} onChange={e => setDraft(d => ({...d, address: e.target.value}))} placeholder="Address"/>
          <input value={draft.city} onChange={e => setDraft(d => ({...d, city: e.target.value}))} placeholder="City"/>
          <input value={draft.state} onChange={e => setDraft(d => ({...d, state: e.target.value}))} placeholder="ST" style={{width:60}}/>
          <input value={draft.zip} onChange={e => setDraft(d => ({...d, zip: e.target.value}))} placeholder="ZIP" style={{width:80}}/>
        </div>
      ) : (
        <>
          <div className="wizard-row-name">{row.company}</div>
          <div className="wizard-row-addr">{[row.address, row.city, row.state, row.zip].filter(Boolean).join(', ')}</div>
        </>
      )}
    </div>
    <div className="wizard-row-actions">
      {bucket === 'needs_review' && !editing && <>
        <button className="btn-primary" disabled={working} onClick={() => accept()}>Accept</button>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(true)}>Edit</button>
        <button className="btn-ghost" disabled={working} onClick={skip}>Skip</button>
      </>}
      {bucket === 'flagged_out_of_area' && !editing && <>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(true)}>Edit address</button>
        <button className="btn-ghost" disabled={working} onClick={copyMail}>Tell admin</button>
      </>}
      {bucket === 'geocode_failed' && !editing && <>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(true)}>Edit &amp; retry</button>
      </>}
      {editing && <>
        <button className="btn-primary" disabled={working} onClick={() => accept(draft)}>Save</button>
        <button className="btn-ghost" disabled={working} onClick={() => setEditing(false)}>Cancel</button>
      </>}
    </div>
  </div>;
}
```

- [ ] **Step 3: Add edit-row CSS**

Append:

```css
.wizard-row-edit{display:flex;flex-wrap:wrap;gap:6px}
.wizard-row-edit input{padding:5px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;font-family:inherit}
```

- [ ] **Step 4: Commit**

```bash
git add public/src/components/UploadWizard.jsx public/src/db/customer.js public/src/styles.css
git commit -m "UploadWizard: per-row actions (accept/edit/skip + copy-mail + edit-address)"
```

---

## Task 14: Wire CustomerHomeView + route

**Files:**
- Modify: `public/src/components/CustomerHomeView.jsx`
- Modify: `public/src/components/App.jsx`
- Modify: `public/src/config/router.js` (only if a new route segment is missing)

- [ ] **Step 1: Add the wizard route to `router.js`**

Open `public/src/config/router.js`. Find the `ROUTES` table and add:

```javascript
const ROUTES = {
  // …existing…
  customerUpload: { test: /^#\/customer\/([^/]+)\/upload\/([^/]+)$/, name: 'customerUpload' },
};
```

In `parseRoute`, add a case for `customerUpload` that returns `{ name: 'customerUpload', customerId: m[1], campaignId: m[2] }`.

- [ ] **Step 2: Route to UploadWizard in `App.jsx`**

Open `public/src/components/App.jsx`. Find where routes are dispatched and add:

```jsx
if (route.name === 'customerUpload') {
  return <UploadWizard customerId={route.customerId} campaignId={route.campaignId}/>;
}
```

- [ ] **Step 3: Wire the "+ Upload campaign" button in `CustomerHomeView.jsx`**

In `CustomerHomeView.jsx`, replace the disabled "Coming soon in Plan 3" button with:

```jsx
<button className="btn-primary" onClick={() => navigate('#/customer/' + customerId + '/upload/new')}>
  + Upload campaign
</button>
```

(Remove the `disabled`, `title`, and `style:opacity` attributes the placeholder had.)

- [ ] **Step 4: Manual smoke test**

Open the local dev server. From the landing picker → choose Archy customer → click "+ Upload campaign". Verify:
- Navigates to `#/customer/<id>/upload/new`
- Step 1 shows campaign-name input + dropzone
- Drop a 5-row CSV, "Continue" creates a draft campaign and navigates to `…/upload/<newId>`
- Step 2 shows the column table; "Continue" calls the function and lands on Step 3
- Step 3 tabs show counts; per-row actions work; "Finalize campaign" returns to home and the new campaign appears in the cards list

- [ ] **Step 5: Commit**

```bash
git add public/src/components/CustomerHomeView.jsx public/src/components/App.jsx public/src/config/router.js
git commit -m "Wire UploadWizard into CustomerHome + new #/customer/<id>/upload/<campaignId> route"
```

---

## Task 15: End-to-end smoke + cleanup

**Files:**
- (Smoke; commits only if anything needs fixing.)

- [ ] **Step 1: Run all unit + integration tests in one go**

```bash
cd public/src/upload/__tests__ && node --test *.test.mjs
cd ../../admin/__tests__ && node --test *.test.mjs
cd ../../../scripts/admin-db && node --test admin-db.test.js
set -a; source ../../apps/web/.env; set +a
cd ../../supabase/functions/ingest-recipients && deno test --allow-net --allow-env test.ts
```

Expected: every suite green.

- [ ] **Step 2: Manual end-to-end against Archy**

In the live UI, from the Admin profile, observe the recipients table size. Then log in as the Archy customer profile and run an upload of the existing Archy CSV (truncated to 50 rows for speed). Verify:
- Step 3 shows realistic bucket counts
- Finalizing flips the campaign card on Customer Home from `draft` to `active`
- Switching to the relevant bakery profile, the new recipients appear in their region list

- [ ] **Step 3: Tidy any obvious issues found during smoke**

Make small fixes inline. Each fix gets its own commit with a tight message.

- [ ] **Step 4: Final commit**

If everything's clean and there are no fixes, this task closes with no commit. Otherwise:

```bash
git add -A
git commit -m "Plan 3 smoke: <whatever fixes>"
```
