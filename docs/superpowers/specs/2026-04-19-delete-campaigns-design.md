# Delete Campaigns — Design

**Date:** 2026-04-19
**Status:** Draft (awaiting review)

## Goal

Let customers and admins delete campaigns that have not yet started. Deletes are *soft* — the row stays in the database with a `deleted_at` timestamp, hidden from normal reads, recoverable by an admin if needed.

## Non-goals

- Restoring deleted campaigns from the customer UI.
- Hard purge of soft-deleted rows.
- Deleting non-draft campaigns (`assigning`, `active`, `complete`).
- Admin web UI for deletion. The `AdminView` component is not yet implemented; admins use a CLI script for now.

## Constraints

- A campaign can only be deleted while `status = 'draft'`. Drafts have no in-flight routes or delivery state, so soft-deleting them has no operational consequences.
- Soft-deleted campaigns must disappear from every customer-facing list.
- The deletion path must be safe against a status-change race (e.g. a draft transitioning to `assigning` mid-click).

## Data model

Single migration: `supabase/migrations/008_campaigns_soft_delete.sql`.

```sql
alter table public.campaigns
  add column if not exists deleted_at timestamptz;

-- Most reads filter "alive" campaigns by customer; partial index keeps that fast.
create index if not exists campaigns_customer_alive_idx
  on public.campaigns (customer_id)
  where deleted_at is null;
```

No RLS changes are required: the existing `campaigns_customer_all` policy already grants the tenant customer full `SELECT/INSERT/UPDATE/DELETE` on their own rows, which covers setting `deleted_at`. Service-role (used by the admin script) bypasses RLS.

### Why `deleted_at` and not `status = 'deleted'`

Lifecycle status (`draft → assigning → active → complete`) and delete state are orthogonal — folding them together would force every status check to also exclude deleted rows. A separate column with a partial index is cleaner and keeps the existing `status` enum intact.

## Read paths

Every list query for campaigns must filter `deleted_at is null`. Audited surfaces:

| File | Function | Change |
| --- | --- | --- |
| `public/src/db/admin.js` | `getCustomer(id)` | Add `.is('deleted_at', null)` to the `campaigns` select. |

Recipients, routes, and delivery-status reads are scoped to a known `campaign_id` and are reached only via a campaign that's already been listed. Once the parent campaign is hidden from the list, no UI path reaches them, so they don't need extra filtering.

## Write path — customer

New function in `public/src/db/customer.js`:

```js
async deleteDraftCampaign(id) {
  if (!sb) throw new Error('sb not ready');
  const { data, error } = await sb.from('campaigns')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'draft')
    .is('deleted_at', null)
    .select('id')
    .single();
  if (error) throw error;
  if (!data) throw new Error('Campaign cannot be deleted (not a draft).');
}
```

Race-safety: scoping the `UPDATE` with `.eq('status','draft').is('deleted_at', null)` means the no-op case (status changed, or already deleted) returns zero rows, which `.single()` surfaces as `data === null`. We translate that to a user-visible error rather than silently succeeding.

## UI — customer

`public/src/components/CustomerHomeView.jsx`, in the `CampaignCard` component:

- Render a small "Delete" affordance (text button, top-right of the card) **only when `campaign.status === 'draft'`**. Other statuses show nothing.
- The card itself is clickable for drafts (opens the wizard). The delete button must call `e.stopPropagation()` so clicking it doesn't also navigate.
- Click handler:
  1. `if (!confirm('Delete draft campaign "<name>"? Recipients will be removed.')) return;`
  2. Call `Customer.deleteDraftCampaign(campaign.id)`.
  3. On success, trigger the parent's reload. Implementation: `CustomerHomeView` keeps a `reloadCounter` state (`useState(0)`), the `useEffect` that loads campaigns lists `reloadCounter` in its dependency array, and `CampaignCard` receives an `onDeleted` callback prop that calls `setReloadCounter(n => n + 1)`.
  4. On failure, show the error inline on the card (small red text under the card body) — no global toast system exists yet, so keep it local.

Visual treatment: muted gray text link with a hover state, not a destructive red button. The confirm dialog provides the safety; the affordance itself should not shout.

## Admin script

Per the user rule, scripts that query Supabase live in their own folder under `scripts/` and use `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the repo-root `.env`. (There is no `apps/web/.env` in this repo; the root `.env` is the canonical one and matches existing scripts like `scripts/check-sweet-lady-jane/`.)

**Path:** `scripts/delete-campaign/delete-campaign.mjs`

**Usage:**

```bash
node scripts/delete-campaign/delete-campaign.mjs --campaign-id <uuid>
node scripts/delete-campaign/delete-campaign.mjs --campaign-id <uuid> --restore
```

**Behavior:**

1. Parse `--campaign-id` (required) and `--restore` (optional flag).
2. Load the campaign by id (service role, bypasses RLS). If not found, exit non-zero with a clear message.
3. **Delete mode** (default):
   - Refuse if `status !== 'draft'`. Print the current status and exit non-zero.
   - Refuse if `deleted_at is not null` (already deleted).
   - Print campaign id, name, customer name, recipient count.
   - Prompt `Soft-delete this campaign? [y/N] ` on stdin; only `y` / `Y` proceeds.
   - `UPDATE campaigns SET deleted_at = now() WHERE id = $1`.
   - Print confirmation with the new `deleted_at` value.
4. **Restore mode** (`--restore`):
   - Refuse if `deleted_at is null` (nothing to restore).
   - Print campaign info as above.
   - Prompt `Restore this campaign? [y/N] `.
   - `UPDATE campaigns SET deleted_at = NULL WHERE id = $1`.

The script does not enforce `status='draft'` for restore — restoring a non-draft is a hypothetical only an admin would do, and they've already passed the interactive prompt.

## Error handling summary

| Scenario | Customer UI | Admin script |
| --- | --- | --- |
| Campaign not found | (UI never lists it) | Exit 1, "Campaign <id> not found" |
| Status not draft | Shouldn't render button; if raced, show "Campaign cannot be deleted (not a draft)." | Exit 1, "Status is <status>, only drafts can be deleted" |
| Already deleted | (UI never lists it) | Exit 1, "Already deleted at <ts>" |
| Network/DB error | Show error message under the card | Print error, exit 1 |

## Testing

- **Schema:** Run the migration; verify the column and partial index exist.
- **Customer flow (manual):**
  - Create a draft campaign, see Delete button, click → confirm → card disappears.
  - Confirm a second list refresh still hides it.
  - Promote a draft to `active` (via existing wizard "finalize"); confirm Delete button does not render.
- **Race:** In a console, manually `UPDATE campaigns SET status='assigning' WHERE id=...` then click Delete. Expect the inline error.
- **Script:**
  - Happy path on a draft (with `--restore` reversing it).
  - Non-draft refusal.
  - Missing/malformed `--campaign-id`.

## Open questions

None blocking. If a future need arises to delete non-draft campaigns, we'd revisit the `status='draft'` constraint and likely require harder confirmation (typed name) and a paper trail.
