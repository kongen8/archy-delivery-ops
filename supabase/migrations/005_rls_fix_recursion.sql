-- 005_rls_fix_recursion.sql
-- Fix "infinite recursion detected in policy" errors introduced by 004.
--
-- The problem: 004 wrote policies with cross-table EXISTS subqueries (e.g.
-- the `campaigns` policy joins `recipients`, the `recipients` policy joins
-- `campaigns`). Once RLS is enabled on both tables, each subquery invokes
-- the OTHER table's policies, which invoke the first table's policies, and
-- Postgres detects the loop and bails out.
--
-- The fix: move the cross-table checks into SECURITY DEFINER helper
-- functions. SECURITY DEFINER functions run with the privileges of the
-- function owner (postgres), which has BYPASSRLS on Supabase, so the
-- subqueries inside the helpers don't re-trigger RLS evaluation.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Helper functions (RLS-bypassing)
-- ---------------------------------------------------------------------------

-- True iff the given campaign_id belongs to the current tenant customer.
create or replace function public.tenant_customer_owns_campaign(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.campaigns
     where id = cid
       and customer_id = public.tenant_customer_id()
  );
$$;

-- True iff the current tenant bakery has at least one recipient in the
-- given campaign.
create or replace function public.tenant_bakery_serves_campaign(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.recipients
     where campaign_id = cid
       and bakery_id = public.tenant_bakery_id()
  );
$$;

-- True iff the given recipient_id belongs to the current tenant bakery.
create or replace function public.tenant_bakery_owns_recipient(rid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.recipients
     where id = rid
       and bakery_id = public.tenant_bakery_id()
  );
$$;

-- True iff the given recipient sits in a campaign owned by the current
-- tenant customer.
create or replace function public.tenant_customer_owns_recipient(rid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.recipients r
     join public.campaigns c on c.id = r.campaign_id
     where r.id = rid
       and c.customer_id = public.tenant_customer_id()
  );
$$;

-- True iff the current tenant bakery serves any recipient whose campaign
-- is owned by the given customer_id.
create or replace function public.tenant_bakery_serves_customer(cust_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.campaigns c
     join public.recipients r on r.campaign_id = c.id
     where c.customer_id = cust_id
       and r.bakery_id  = public.tenant_bakery_id()
  );
$$;

grant execute on function public.tenant_customer_owns_campaign(uuid)   to anon, authenticated;
grant execute on function public.tenant_bakery_serves_campaign(uuid)   to anon, authenticated;
grant execute on function public.tenant_bakery_owns_recipient(uuid)    to anon, authenticated;
grant execute on function public.tenant_customer_owns_recipient(uuid)  to anon, authenticated;
grant execute on function public.tenant_bakery_serves_customer(uuid)   to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rewrite the recursive policies to call the helpers instead
-- ---------------------------------------------------------------------------

-- customers: bakery can SELECT a customer it serves.
drop policy if exists customers_select_by_serving_bakery on public.customers;
create policy customers_select_by_serving_bakery on public.customers
  for select using (
    public.tenant_bakery_id() is not null
    and public.tenant_bakery_serves_customer(customers.id)
  );

-- campaigns: bakery can SELECT campaigns it serves.
drop policy if exists campaigns_bakery_select on public.campaigns;
create policy campaigns_bakery_select on public.campaigns
  for select using (
    public.tenant_bakery_id() is not null
    and public.tenant_bakery_serves_campaign(campaigns.id)
  );

-- recipients: customer has full control over their campaigns' recipients.
drop policy if exists recipients_customer_all on public.recipients;
create policy recipients_customer_all on public.recipients
  for all
  using (public.tenant_customer_owns_campaign(recipients.campaign_id))
  with check (public.tenant_customer_owns_campaign(recipients.campaign_id));

-- routes: customer can SELECT plans for their campaigns.
drop policy if exists routes_customer_select on public.routes;
create policy routes_customer_select on public.routes
  for select using (public.tenant_customer_owns_campaign(routes.campaign_id));

-- delivery_statuses_v2: bakery writes statuses for its recipients.
drop policy if exists statuses_v2_bakery_all on public.delivery_statuses_v2;
create policy statuses_v2_bakery_all on public.delivery_statuses_v2
  for all
  using (public.tenant_bakery_owns_recipient(delivery_statuses_v2.recipient_id))
  with check (public.tenant_bakery_owns_recipient(delivery_statuses_v2.recipient_id));

-- delivery_statuses_v2: customer reads statuses for their campaigns.
drop policy if exists statuses_v2_customer_select on public.delivery_statuses_v2;
create policy statuses_v2_customer_select on public.delivery_statuses_v2
  for select using (public.tenant_customer_owns_recipient(delivery_statuses_v2.recipient_id));

-- delivery_statuses (v1 legacy): bakery owns rows by recipients.legacy_id.
drop policy if exists statuses_v1_bakery_all on public.delivery_statuses;
create policy statuses_v1_bakery_all on public.delivery_statuses
  for all
  using (
    exists (
      select 1 from public.recipients r
       where r.legacy_id = delivery_statuses.id
         and r.bakery_id = public.tenant_bakery_id()
    )
  )
  with check (
    exists (
      select 1 from public.recipients r
       where r.legacy_id = delivery_statuses.id
         and r.bakery_id = public.tenant_bakery_id()
    )
  );
-- ^ delivery_statuses is legacy and `recipients` policies don't loop back
-- here, so the plain EXISTS is fine — kept for clarity after the DROP.
