-- Archy × Daymaker Delivery Ops — Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Delivery statuses (delivered, failed, pending)
CREATE TABLE delivery_statuses (
  id TEXT PRIMARY KEY,           -- stop ID e.g. "SF_Blende_Dental_Group_46"
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  note TEXT,                      -- failure reason
  photo_url TEXT,                 -- Supabase Storage URL for proof photo
  delivered_at TIMESTAMPTZ,       -- when marked delivered
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Route overrides (rebalanced/modified routes per region)
CREATE TABLE route_overrides (
  region TEXT PRIMARY KEY,        -- e.g. "SF", "Orlando"
  data JSONB NOT NULL,            -- full route data object for the region
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Depot overrides (edited bakery locations per region)
CREATE TABLE depot_overrides (
  region TEXT PRIMARY KEY,
  depots JSONB NOT NULL,          -- array of {name, addr, lat, lon}
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable realtime for all tables so multiple browsers stay in sync
ALTER PUBLICATION supabase_realtime ADD TABLE delivery_statuses;
ALTER PUBLICATION supabase_realtime ADD TABLE route_overrides;
ALTER PUBLICATION supabase_realtime ADD TABLE depot_overrides;

-- Row Level Security: allow all operations (no auth — link-based access)
ALTER TABLE delivery_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE depot_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on delivery_statuses" ON delivery_statuses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on route_overrides" ON route_overrides FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on depot_overrides" ON depot_overrides FOR ALL USING (true) WITH CHECK (true);

-- Create storage bucket for delivery photos
INSERT INTO storage.buckets (id, name, public) VALUES ('delivery-photos', 'delivery-photos', true);

-- Allow public uploads/reads on the photos bucket
CREATE POLICY "Allow public upload" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'delivery-photos');
CREATE POLICY "Allow public read" ON storage.objects FOR SELECT USING (bucket_id = 'delivery-photos');
