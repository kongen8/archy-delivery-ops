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
