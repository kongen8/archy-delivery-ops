-- 009_cake_design.sql
-- Plan 5 — adds the campaign-level "default_design" jsonb column and creates
-- the public `cake-prints` Storage bucket where the customer's cropped cake
-- and box-card images live. Permissive RLS policies match the Plan 2 pivot
-- (every profile is trusted; no per-row owner check).
--
-- Idempotent: safe to re-run.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS default_design jsonb DEFAULT '{}'::jsonb NOT NULL;

INSERT INTO storage.buckets (id, name, public)
VALUES ('cake-prints', 'cake-prints', true)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY "anyone can read cake-prints"
    ON storage.objects FOR SELECT TO public
    USING (bucket_id = 'cake-prints');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anyone can write cake-prints"
    ON storage.objects FOR INSERT TO public
    WITH CHECK (bucket_id = 'cake-prints');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anyone can update cake-prints"
    ON storage.objects FOR UPDATE TO public
    USING (bucket_id = 'cake-prints');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anyone can delete cake-prints"
    ON storage.objects FOR DELETE TO public
    USING (bucket_id = 'cake-prints');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
