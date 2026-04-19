# Delete Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let customers soft-delete their own draft campaigns from the home view, and let admins do the same (or restore) via a CLI script.

**Architecture:** Add a `deleted_at timestamptz` column to `campaigns`. Customer browser writes the column directly via existing RLS (`campaigns_customer_all`). Reads filter `deleted_at is null`. Admin CLI uses the service role key to bypass RLS. Hard constraint: deletion only allowed while `status = 'draft'` (enforced by the UPDATE filter).

**Tech Stack:** Postgres / Supabase (RLS), vanilla JS browser app loaded via plain `<script>` tags (`public/src`), Node `.mjs` admin scripts using `@supabase/supabase-js` + `dotenv`, supabase MCP for migrations.

**Spec:** `docs/superpowers/specs/2026-04-19-delete-campaigns-design.md`

**Project conventions to honor:**
- All Supabase interaction uses the supabase MCP — never the Supabase CLI.
- Scripts that query Supabase live in their own folder under `scripts/<name>/<name>.mjs` and read `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the repo-root `.env` (there is no `apps/web/.env`).
- The browser app has no automated UI/db-layer test suite; verification is manual against a live Supabase project. Don't invent a Jest setup.

---

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `supabase/migrations/008_campaigns_soft_delete.sql` | Create | Adds `deleted_at` column + partial index. Idempotent. |
| `public/src/db/admin.js` | Modify | `getCustomer()` filters out soft-deleted campaigns. |
| `public/src/db/customer.js` | Modify | New `deleteDraftCampaign(id)` method. |
| `public/src/components/CustomerHomeView.jsx` | Modify | Reload counter in parent; Delete button + confirm + error display in `CampaignCard`. |
| `scripts/delete-campaign/delete-campaign.mjs` | Create | CLI to soft-delete or restore a campaign by id (service role). |
| `scripts/delete-campaign/package.json` | Create | Pins `@supabase/supabase-js` + `dotenv`, matches sibling scripts. |

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/008_campaigns_soft_delete.sql`
- Apply via: supabase MCP `apply_migration` tool

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/008_campaigns_soft_delete.sql` with exactly:

```sql
-- 008_campaigns_soft_delete.sql
-- Soft-delete column for campaigns. The customer UI and the admin script
-- set `deleted_at` instead of issuing a DELETE so the row (and its
-- recipients/routes via cascade) survives in case we need to restore it.
--
-- Reads must filter `deleted_at is null`. The partial index keeps the
-- common "list a customer's live campaigns" query fast.
--
-- Idempotent: safe to re-run.

alter table public.campaigns
  add column if not exists deleted_at timestamptz;

create index if not exists campaigns_customer_alive_idx
  on public.campaigns (customer_id)
  where deleted_at is null;
```

- [ ] **Step 2: Apply the migration via the supabase MCP**

Call the `apply_migration` tool on the `project-0-archy-delivery-ops-supabase` MCP server with:
- `name`: `008_campaigns_soft_delete`
- `query`: the full SQL from Step 1

Expected: tool returns success. If it errors, fix the SQL and re-apply (it's idempotent).

- [ ] **Step 3: Verify the column and index exist**

Call the `execute_sql` tool on the same MCP server with:

```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'campaigns' and column_name = 'deleted_at';

select indexname, indexdef
  from pg_indexes
 where schemaname = 'public' and tablename = 'campaigns' and indexname = 'campaigns_customer_alive_idx';
```

Expected: one row from each query. The index def should include `WHERE (deleted_at IS NULL)`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/008_campaigns_soft_delete.sql
git commit -m "Add campaigns.deleted_at + partial index for soft delete"
```

---

## Task 2: Filter deleted campaigns from the admin read path

**Files:**
- Modify: `public/src/db/admin.js` (function `getCustomer`, currently around lines 38-47)

- [ ] **Step 1: Update `getCustomer` to filter deleted campaigns**

In `public/src/db/admin.js`, find:

```js
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
```

Replace the campaigns query so it excludes soft-deleted rows:

```js
  async getCustomer(id) {
    if (!sb) throw new Error('sb not ready');
    const [{ data: customer, error: cErr }, { data: campaigns, error: pErr }] = await Promise.all([
      sb.from('customers').select('*').eq('id', id).single(),
      sb.from('campaigns').select('*').eq('customer_id', id).is('deleted_at', null).order('created_at'),
    ]);
    if (cErr) throw cErr;
    if (pErr) throw pErr;
    return { customer, campaigns: campaigns || [] };
  },
```

- [ ] **Step 2: Commit**

```bash
git add public/src/db/admin.js
git commit -m "Hide soft-deleted campaigns from getCustomer()"
```

---

## Task 3: Customer DB layer — `deleteDraftCampaign`

**Files:**
- Modify: `public/src/db/customer.js` (insert new method after `finalizeCampaign`, currently around lines 15-19)

- [ ] **Step 1: Add the `deleteDraftCampaign` method**

In `public/src/db/customer.js`, find:

```js
  async finalizeCampaign(id) {
    if (!sb) throw new Error('sb not ready');
    const { error } = await sb.from('campaigns').update({ status: 'active' }).eq('id', id);
    if (error) throw error;
  },
```

Insert this method directly after it (before `listRecipients`):

```js
  // Soft-delete a draft campaign. Only drafts are deletable; the .eq filters
  // make this a no-op (data === null) if the row was promoted to a non-draft
  // status or already deleted between render and click. The cascading
  // recipients/routes rows stay in the database — restoring just clears
  // deleted_at.
  async deleteDraftCampaign(id) {
    if (!sb) throw new Error('sb not ready');
    const { data, error } = await sb.from('campaigns')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'draft')
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Campaign cannot be deleted (not a draft).');
  },
```

(Using `.maybeSingle()` rather than `.single()` so the no-row case returns `data === null` instead of throwing a "JSON object requested, multiple (or no) rows returned" PostgREST error — that lets us produce the human-readable message above.)

- [ ] **Step 2: Commit**

```bash
git add public/src/db/customer.js
git commit -m "Add Customer.deleteDraftCampaign for soft-deleting drafts"
```

---

## Task 4: Customer UI — Delete button + parent reload

**Files:**
- Modify: `public/src/components/CustomerHomeView.jsx`

This task changes both the parent (`CustomerHomeView`) to support reloading and the child (`CampaignCard`) to show the delete button. Do them in one commit since the prop wiring spans both.

- [ ] **Step 1: Add a reload counter to `CustomerHomeView` and pass `onDeleted` to each card**

In `public/src/components/CustomerHomeView.jsx`, find the current `CustomerHomeView` (lines 3-49) and replace it with:

```jsx
function CustomerHomeView({customerId}){
  const[state,setState]=useState({loading:true,customer:null,campaigns:[],counts:{},progress:{},err:''});
  const[reloadCounter,setReloadCounter]=useState(0);

  useEffect(()=>{(async()=>{
    try{
      if(!sb){setState(s=>({...s,err:'Supabase not configured',loading:false}));return;}
      setState(s=>({...s,loading:true}));
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
  })();},[customerId,reloadCounter]);

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
        <button className="btn-primary" onClick={()=>navigate('#/customer/'+customerId+'/upload/new')}>+ Upload campaign</button>
        <ProfileSwitcher/>
      </div>
    </div>

    {campaigns.length===0?<div style={{padding:40,textAlign:'center',color:'#94a3b8'}}>No campaigns yet.</div>:
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        {campaigns.map(c=><CampaignCard key={c.id} campaign={c} customerId={customerId} counts={counts[c.id]} progress={progress[c.id]} onDeleted={()=>setReloadCounter(n=>n+1)}/>)}
      </div>
    }
  </div>;
}
```

(Three edits versus the original: declare `reloadCounter`, add it to the `useEffect` dependency array, and pass `onDeleted` into each `CampaignCard`.)

- [ ] **Step 2: Replace `CampaignCard` with the version that has a Delete button**

In the same file, find the current `CampaignCard` (lines 51-72) and replace it with:

```jsx
function CampaignCard({campaign,customerId,counts,progress,onDeleted}){
  const[deleting,setDeleting]=useState(false);
  const[deleteErr,setDeleteErr]=useState('');
  const pct=progress&&progress.total?Math.round(100*progress.delivered/progress.total):0;
  const onClick=campaign.status==='draft'?()=>navigate('#/customer/'+customerId+'/upload/'+campaign.id):undefined;

  async function handleDelete(e){
    e.stopPropagation();
    if(deleting)return;
    if(!confirm('Delete draft campaign "'+campaign.name+'"? Recipients will be removed.'))return;
    setDeleting(true);setDeleteErr('');
    try{
      await Customer.deleteDraftCampaign(campaign.id);
      onDeleted&&onDeleted();
    }catch(err){
      setDeleteErr(err.message||String(err));
      setDeleting(false);
    }
  }

  return <div onClick={onClick} style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,padding:16,cursor:onClick?'pointer':'default',opacity:deleting?0.5:1}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:10}}>
      <div style={{fontWeight:600}}>{campaign.name}</div>
      <div style={{display:'flex',alignItems:'center',gap:12}}>
        <div style={{fontSize:11,color:'#6b7280',textTransform:'uppercase',letterSpacing:'0.05em'}}>{campaign.status}</div>
        {campaign.status==='draft'&&<button onClick={handleDelete} disabled={deleting} style={{background:'none',border:'none',padding:0,color:'#6b7280',fontSize:12,cursor:deleting?'default':'pointer',textDecoration:'underline'}}>{deleting?'Deleting…':'Delete'}</button>}
      </div>
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
    {deleteErr&&<div style={{marginTop:8,fontSize:12,color:'#991b1b'}}>{deleteErr}</div>}
  </div>;
}
```

(Changes versus the original: accept `onDeleted` prop, manage local `deleting`/`deleteErr` state, render a Delete button next to the status badge for drafts only, dim the card while deleting, show the error inline on failure. The card's existing top-level `onClick` still navigates for drafts; `e.stopPropagation()` in `handleDelete` prevents the click bubbling.)

- [ ] **Step 3: Manual smoke test**

Open the app in a browser logged in as a customer with at least one draft campaign:

1. Confirm the Delete link appears only on draft cards, not on `assigning`/`active`/`complete` cards.
2. Click Delete, dismiss the confirm — card stays.
3. Click Delete, accept the confirm — card disappears, no other cards are affected.
4. Refresh the page — the deleted card stays gone.
5. (Optional race check) In the Supabase SQL editor: pick a draft campaign id, run `update campaigns set status='assigning' where id='...';`, then click Delete in the still-open browser. Expected: red error text "Campaign cannot be deleted (not a draft)." appears under the card. Roll the status back: `update campaigns set status='draft' where id='...';`.

- [ ] **Step 4: Commit**

```bash
git add public/src/components/CustomerHomeView.jsx
git commit -m "Add delete button to draft campaign cards"
```

---

## Task 5: Admin script — `delete-campaign.mjs`

**Files:**
- Create: `scripts/delete-campaign/package.json`
- Create: `scripts/delete-campaign/delete-campaign.mjs`

- [ ] **Step 1: Create `scripts/delete-campaign/package.json`**

Match the pattern of sibling scripts (e.g. `scripts/check-sweet-lady-jane/package.json`). Write:

```json
{
  "name": "delete-campaign",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "dotenv": "^16.4.5"
  }
}
```

- [ ] **Step 2: Install the script's dependencies**

Run from the repo root:

```bash
cd scripts/delete-campaign && npm install && cd -
```

Expected: `node_modules/` created inside `scripts/delete-campaign/`, no errors.

- [ ] **Step 3: Create `scripts/delete-campaign/delete-campaign.mjs`**

Write the file with this exact content:

```js
// Soft-delete (or restore) a campaign by id. Service-role only — bypasses
// RLS so admins can act on any tenant. Defaults to delete; pass --restore
// to clear deleted_at.
//
// Usage:
//   node scripts/delete-campaign/delete-campaign.mjs --campaign-id <uuid>
//   node scripts/delete-campaign/delete-campaign.mjs --campaign-id <uuid> --restore
//
// Refuses to delete unless status='draft'. Restore has no status check
// (admins decide what's appropriate).

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: resolve(REPO_ROOT, '.env') });

function parseArgs(argv) {
  const out = { campaignId: null, restore: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--campaign-id') { out.campaignId = argv[++i]; }
    else if (a === '--restore') { out.restore = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else { console.error('Unknown argument:', a); process.exit(2); }
  }
  return out;
}

function usage() {
  console.log('Usage: node scripts/delete-campaign/delete-campaign.mjs --campaign-id <uuid> [--restore]');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (!args.campaignId) { usage(); process.exit(2); }

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(2);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: campaign, error: cErr } = await sb
  .from('campaigns')
  .select('id, name, status, deleted_at, customer_id, created_at')
  .eq('id', args.campaignId)
  .maybeSingle();
if (cErr) { console.error('Lookup failed:', cErr.message); process.exit(1); }
if (!campaign) { console.error('Campaign', args.campaignId, 'not found'); process.exit(1); }

const { data: customer } = await sb
  .from('customers')
  .select('name')
  .eq('id', campaign.customer_id)
  .maybeSingle();

const { count: recipientCount } = await sb
  .from('recipients')
  .select('id', { count: 'exact', head: true })
  .eq('campaign_id', campaign.id);

console.log('Campaign:');
console.log('  id:         ', campaign.id);
console.log('  name:       ', campaign.name);
console.log('  customer:   ', customer?.name || '(unknown)', '(' + campaign.customer_id + ')');
console.log('  status:     ', campaign.status);
console.log('  created_at: ', campaign.created_at);
console.log('  deleted_at: ', campaign.deleted_at || '(null)');
console.log('  recipients: ', recipientCount ?? '?');
console.log('');

if (args.restore) {
  if (!campaign.deleted_at) {
    console.error('Refusing to restore: campaign is not deleted (deleted_at is null).');
    process.exit(1);
  }
} else {
  if (campaign.status !== 'draft') {
    console.error('Refusing to delete: status is "' + campaign.status + '". Only drafts can be deleted.');
    process.exit(1);
  }
  if (campaign.deleted_at) {
    console.error('Refusing to delete: already deleted at', campaign.deleted_at);
    process.exit(1);
  }
}

const rl = readline.createInterface({ input, output });
const prompt = args.restore ? 'Restore this campaign? [y/N] ' : 'Soft-delete this campaign? [y/N] ';
const answer = (await rl.question(prompt)).trim().toLowerCase();
rl.close();
if (answer !== 'y') { console.log('Aborted.'); process.exit(0); }

const update = args.restore ? { deleted_at: null } : { deleted_at: new Date().toISOString() };
const { data: updated, error: uErr } = await sb
  .from('campaigns')
  .update(update)
  .eq('id', campaign.id)
  .select('deleted_at')
  .single();
if (uErr) { console.error('Update failed:', uErr.message); process.exit(1); }

console.log(args.restore ? 'Restored.' : 'Soft-deleted.', 'deleted_at =', updated.deleted_at);
```

- [ ] **Step 4: Smoke-test the script (delete + restore round trip)**

Find a real draft campaign id you can safely toggle. Either:
- Create a throwaway draft via the customer UI ("+ Upload campaign", give it a name, then close the wizard before finalizing), OR
- Pick an existing draft from the Supabase dashboard / `select id, name, status from campaigns where status='draft' limit 5;`.

Then run, from the repo root:

```bash
node scripts/delete-campaign/delete-campaign.mjs --campaign-id <DRAFT_UUID>
```

Expected output: prints campaign info, asks `Soft-delete this campaign? [y/N]`. Type `y`. Expect final line `Soft-deleted. deleted_at = 2026-...`.

Verify it disappeared from the customer home view (refresh the browser).

Then restore it:

```bash
node scripts/delete-campaign/delete-campaign.mjs --campaign-id <DRAFT_UUID> --restore
```

Type `y` at the prompt. Expect `Restored. deleted_at = null`. Refresh the customer home view — the campaign should reappear.

Negative checks:

```bash
node scripts/delete-campaign/delete-campaign.mjs --campaign-id <NON_DRAFT_UUID>
```

Expect exit 1 with `Refusing to delete: status is "active"...` (or whatever the non-draft status is).

```bash
node scripts/delete-campaign/delete-campaign.mjs --campaign-id 00000000-0000-0000-0000-000000000000
```

Expect exit 1 with `Campaign 00000000-... not found`.

- [ ] **Step 5: Commit**

```bash
git add scripts/delete-campaign/package.json scripts/delete-campaign/delete-campaign.mjs
git commit -m "Add admin script to soft-delete or restore campaigns"
```

(Repo `.gitignore` already excludes `node_modules/`, so it won't be staged.)

---

## Task 6: Final verification

- [ ] **Step 1: End-to-end manual sweep**

With everything merged in the working copy:

1. Customer home view loads campaigns and shows Delete only on draft cards.
2. Customer-side delete works, card disappears, persists across reload.
3. Admin script deletes a draft, customer no longer sees it.
4. Admin script restores it, customer sees it again.
5. Admin script refuses non-draft deletes and unknown ids.
6. Drafts that were soft-deleted retain their `recipients` rows in the database (sanity-check via the supabase MCP `execute_sql` tool: `select count(*) from recipients where campaign_id = '<deleted-id>';` — should be > 0 for a campaign that had any recipients).

- [ ] **Step 2: Confirm git state is clean**

```bash
git status
```

Expected: `nothing to commit, working tree clean`. All five feature commits should be present:

```bash
git log --oneline -6
```

Expected (most-recent first): the verification step doesn't add a commit, so the top of the log is the admin-script commit, then the UI commit, then the customer DB-layer commit, then the admin DB-layer commit, then the migration commit, then the spec commit.
