-- 003_routes_by_delivery_area.sql
-- The original `routes` schema keyed on (campaign_id, bakery_id) unique, but a
-- single bakery can cover multiple delivery_areas (Boho Petite covers SF and
-- South Bay / Peninsula). Collapsing their route plans into one row loses data.
-- We also want to support the future case of multiple bakeries covering the
-- same area. Rekey on (campaign_id, bakery_id, delivery_area_id).

-- The one surviving row from the original migration was a collapsed mess; drop it.
truncate table routes;

-- Remove the old uniqueness.
alter table routes drop constraint if exists routes_campaign_id_bakery_id_key;

-- Add the area reference. NOT NULL is safe because the table is empty.
alter table routes add column if not exists delivery_area_id uuid not null
  references delivery_areas(id) on delete cascade;

create index if not exists routes_area_idx on routes(delivery_area_id);

create unique index if not exists routes_unique_idx
  on routes(campaign_id, bakery_id, delivery_area_id);
