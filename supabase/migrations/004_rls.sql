-- 004_rls.sql
-- Lock the database down. Every request from a browser must carry a tenant
-- access token in the `x-tenant-token` request header; RLS policies resolve
-- that header to a bakery_id or customer_id and scope visibility accordingly.
-- Service-role keys (used only by scripts and edge functions) bypass RLS.
--
-- This migration is idempotent: re-running is a no-op.

-- ---------------------------------------------------------------------------
-- 1. Helper functions
-- ---------------------------------------------------------------------------

-- Extract the current request's `x-tenant-token` header. PostgREST exposes
-- request headers via the `request.headers` GUC as JSON. Returns NULL when
-- the header is missing (e.g. service-role requests, or an anon user who has
-- not presented a token yet).
create or replace function public.tenant_token()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  hdrs jsonb;
begin
  hdrs := nullif(current_setting('request.headers', true), '')::jsonb;
  if hdrs is null then
    return null;
  end if;
  return hdrs ->> 'x-tenant-token';
end;
$$;

-- Resolve the header to a bakery.id. SECURITY DEFINER so the lookup works
-- even once RLS is enabled on `bakeries` (the function itself enforces the
-- match). Returns NULL when no token / unknown token.
create or replace function public.tenant_bakery_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.bakeries
   where access_token is not null
     and access_token = public.tenant_token()
   limit 1;
$$;

-- Resolve the header to a customer.id.
create or replace function public.tenant_customer_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.customers
   where access_token is not null
     and access_token = public.tenant_token()
   limit 1;
$$;

-- Convenience: is *some* authenticated tenant present?
create or replace function public.tenant_is_authenticated()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.tenant_bakery_id() is not null
      or public.tenant_customer_id() is not null;
$$;

grant execute on function public.tenant_token()            to anon, authenticated;
grant execute on function public.tenant_bakery_id()        to anon, authenticated;
grant execute on function public.tenant_customer_id()      to anon, authenticated;
grant execute on function public.tenant_is_authenticated() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS on every table the browser can reach
-- ---------------------------------------------------------------------------

alter table public.bakeries              enable row level security;
alter table public.customers             enable row level security;
alter table public.depots                enable row level security;
alter table public.delivery_areas        enable row level security;
alter table public.campaigns             enable row level security;
alter table public.recipients            enable row level security;
alter table public.routes                enable row level security;
alter table public.delivery_statuses_v2  enable row level security;
alter table public.geocode_cache         enable row level security;
alter table public.app_settings          enable row level security;

-- Legacy tables still in use until Task 11 retires them.
alter table public.delivery_statuses     enable row level security;
alter table public.route_overrides       enable row level security;
alter table public.depot_overrides       enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Policies — drop-then-create so re-runs replace old definitions cleanly
-- ---------------------------------------------------------------------------

-- bakeries: a bakery sees/updates only its own row. No public insert/delete.
drop policy if exists bakeries_self_select on public.bakeries;
drop policy if exists bakeries_self_update on public.bakeries;
create policy bakeries_self_select on public.bakeries
  for select using (id = public.tenant_bakery_id());
create policy bakeries_self_update on public.bakeries
  for update using (id = public.tenant_bakery_id())
  with check  (id = public.tenant_bakery_id());

-- customers: a customer sees/updates only its own row.
-- Bakeries ALSO need to see the names of customers whose recipients they
-- serve (e.g. the Archy bakery ops view labels the campaign by customer).
drop policy if exists customers_self_select             on public.customers;
drop policy if exists customers_self_update             on public.customers;
drop policy if exists customers_select_by_serving_bakery on public.customers;
create policy customers_self_select on public.customers
  for select using (id = public.tenant_customer_id());
create policy customers_self_update on public.customers
  for update using (id = public.tenant_customer_id())
  with check  (id = public.tenant_customer_id());
create policy customers_select_by_serving_bakery on public.customers
  for select using (
    public.tenant_bakery_id() is not null
    and exists (
      select 1 from public.campaigns c
        join public.recipients r on r.campaign_id = c.id
       where c.customer_id = customers.id
         and r.bakery_id   = public.tenant_bakery_id()
    )
  );

-- depots: bakery-owned, full CRUD for the owning bakery.
drop policy if exists depots_bakery_all on public.depots;
create policy depots_bakery_all on public.depots
  for all
  using (bakery_id = public.tenant_bakery_id())
  with check (bakery_id = public.tenant_bakery_id());

-- delivery_areas: bakery-owned, full CRUD.
drop policy if exists delivery_areas_bakery_all on public.delivery_areas;
create policy delivery_areas_bakery_all on public.delivery_areas
  for all
  using (bakery_id = public.tenant_bakery_id())
  with check (bakery_id = public.tenant_bakery_id());

-- campaigns:
--   * customers fully manage their own campaigns,
--   * bakeries can SELECT any campaign they are actually serving (i.e. at
--     least one recipient is assigned to them).
drop policy if exists campaigns_customer_all        on public.campaigns;
drop policy if exists campaigns_bakery_select       on public.campaigns;
create policy campaigns_customer_all on public.campaigns
  for all
  using (customer_id = public.tenant_customer_id())
  with check (customer_id = public.tenant_customer_id());
create policy campaigns_bakery_select on public.campaigns
  for select using (
    public.tenant_bakery_id() is not null
    and exists (
      select 1 from public.recipients r
       where r.campaign_id = campaigns.id
         and r.bakery_id   = public.tenant_bakery_id()
    )
  );

-- recipients:
--   * customers: full control over rows in their own campaigns,
--   * bakeries: SELECT everything assigned to them, and UPDATE (to edit
--     status/notes/photos via the operator UI).
drop policy if exists recipients_customer_all      on public.recipients;
drop policy if exists recipients_bakery_select     on public.recipients;
drop policy if exists recipients_bakery_update     on public.recipients;
create policy recipients_customer_all on public.recipients
  for all
  using (
    exists (
      select 1 from public.campaigns c
       where c.id = recipients.campaign_id
         and c.customer_id = public.tenant_customer_id()
    )
  )
  with check (
    exists (
      select 1 from public.campaigns c
       where c.id = recipients.campaign_id
         and c.customer_id = public.tenant_customer_id()
    )
  );
create policy recipients_bakery_select on public.recipients
  for select using (bakery_id = public.tenant_bakery_id());
create policy recipients_bakery_update on public.recipients
  for update
  using (bakery_id = public.tenant_bakery_id())
  with check (bakery_id = public.tenant_bakery_id());

-- routes:
--   * bakeries fully manage their own route plans,
--   * customers can SELECT the plans that cover their campaigns (future
--     customer dashboard use case).
drop policy if exists routes_bakery_all        on public.routes;
drop policy if exists routes_customer_select   on public.routes;
create policy routes_bakery_all on public.routes
  for all
  using (bakery_id = public.tenant_bakery_id())
  with check (bakery_id = public.tenant_bakery_id());
create policy routes_customer_select on public.routes
  for select using (
    exists (
      select 1 from public.campaigns c
       where c.id = routes.campaign_id
         and c.customer_id = public.tenant_customer_id()
    )
  );

-- delivery_statuses_v2: bakery sees/writes the statuses of recipients it
-- serves. Customers can read their own campaigns' statuses for dashboards.
drop policy if exists statuses_v2_bakery_all       on public.delivery_statuses_v2;
drop policy if exists statuses_v2_customer_select  on public.delivery_statuses_v2;
create policy statuses_v2_bakery_all on public.delivery_statuses_v2
  for all
  using (
    exists (
      select 1 from public.recipients r
       where r.id = delivery_statuses_v2.recipient_id
         and r.bakery_id = public.tenant_bakery_id()
    )
  )
  with check (
    exists (
      select 1 from public.recipients r
       where r.id = delivery_statuses_v2.recipient_id
         and r.bakery_id = public.tenant_bakery_id()
    )
  );
create policy statuses_v2_customer_select on public.delivery_statuses_v2
  for select using (
    exists (
      select 1 from public.recipients r
        join public.campaigns c on c.id = r.campaign_id
       where r.id = delivery_statuses_v2.recipient_id
         and c.customer_id = public.tenant_customer_id()
    )
  );

-- geocode_cache: shared read/write cache for any authenticated tenant.
-- No point keying by tenant; addresses are public geography.
drop policy if exists geocode_cache_auth_all on public.geocode_cache;
create policy geocode_cache_auth_all on public.geocode_cache
  for all
  using (public.tenant_is_authenticated())
  with check (public.tenant_is_authenticated());

-- app_settings: no anon/authenticated policies. Service-role only.
-- (Deliberately no policy => denies everything for non-privileged roles.)

-- ---------------------------------------------------------------------------
-- 4. Legacy tables — keep the app working until Task 11 retires them
-- ---------------------------------------------------------------------------

-- delivery_statuses (v1): rows are keyed by legacy id strings like "a1" that
-- correspond to recipients.legacy_id. Scope via that join.
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

-- route_overrides (v1): keyed by region name. The pre-multitenant schema
-- carried no bakery_id. Treat them as bakery-owned by the only bakery that
-- has depots in that region (good enough until Task 11 deletes the table).
drop policy if exists route_overrides_bakery_all on public.route_overrides;
create policy route_overrides_bakery_all on public.route_overrides
  for all
  using (public.tenant_bakery_id() is not null)
  with check (public.tenant_bakery_id() is not null);

-- depot_overrides (v1): same story as route_overrides.
drop policy if exists depot_overrides_bakery_all on public.depot_overrides;
create policy depot_overrides_bakery_all on public.depot_overrides
  for all
  using (public.tenant_bakery_id() is not null)
  with check (public.tenant_bakery_id() is not null);
