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
