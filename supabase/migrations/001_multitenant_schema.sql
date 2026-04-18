-- Plan 1 — multi-tenant foundation. Idempotent.
-- Safe to re-run. Enables pgcrypto for gen_random_uuid() on older Postgres.
create extension if not exists "pgcrypto";

-- 1. bakeries
create table if not exists bakeries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_email text,
  contact_phone text,
  access_token text unique not null,
  user_id uuid,
  created_at timestamptz not null default now()
);

-- 2. delivery_areas (GeoJSON Polygon or MultiPolygon stored as jsonb)
create table if not exists delivery_areas (
  id uuid primary key default gen_random_uuid(),
  bakery_id uuid not null references bakeries(id) on delete cascade,
  name text,
  geometry jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists delivery_areas_bakery_id_idx on delivery_areas(bakery_id);

-- 3. depots
create table if not exists depots (
  id uuid primary key default gen_random_uuid(),
  bakery_id uuid not null references bakeries(id) on delete cascade,
  name text not null,
  address text not null,
  lat double precision not null,
  lon double precision not null,
  created_at timestamptz not null default now()
);
create index if not exists depots_bakery_id_idx on depots(bakery_id);

-- 4. customers
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_email text,
  access_token text unique not null,
  user_id uuid,
  created_at timestamptz not null default now()
);

-- 5. campaigns
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft','assigning','active','complete')),
  created_at timestamptz not null default now()
);
create index if not exists campaigns_customer_id_idx on campaigns(customer_id);

-- 6. recipients
create table if not exists recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  bakery_id uuid references bakeries(id) on delete set null,
  company text not null,
  contact_name text,
  phone text,
  email text,
  address text not null,
  city text,
  state text,
  zip text,
  lat double precision,
  lon double precision,
  assignment_status text not null default 'needs_review'
    check (assignment_status in ('assigned','flagged_out_of_area','geocode_failed','needs_review')),
  legacy_id text,
  customizations jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists recipients_campaign_idx on recipients(campaign_id);
create index if not exists recipients_bakery_idx on recipients(bakery_id);
create unique index if not exists recipients_legacy_idx
  on recipients(campaign_id, legacy_id) where legacy_id is not null;

-- 7. geocode_cache
create table if not exists geocode_cache (
  normalized_address text primary key,
  lat double precision not null,
  lon double precision not null,
  display_name text,
  provider text not null,
  created_at timestamptz not null default now()
);

-- 8. routes (replaces route_overrides, keyed by campaign + bakery)
create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  bakery_id uuid not null references bakeries(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (campaign_id, bakery_id)
);

-- 9. delivery_statuses_v2 (FK to recipient; old delivery_statuses stays alive)
create table if not exists delivery_statuses_v2 (
  recipient_id uuid primary key references recipients(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','delivered','failed')),
  note text,
  photo_url text,
  delivered_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 10. app_settings — singleton, service-role only (RLS in 002)
create table if not exists app_settings (
  id int primary key default 1 check (id = 1),
  openai_api_key text,
  mapbox_api_key text,
  updated_at timestamptz not null default now()
);
insert into app_settings (id) values (1) on conflict do nothing;

-- Enable realtime for tables the browser subscribes to
alter publication supabase_realtime add table delivery_statuses_v2;
alter publication supabase_realtime add table routes;
alter publication supabase_realtime add table depots;
