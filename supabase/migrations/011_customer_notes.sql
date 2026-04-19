-- 011_customer_notes.sql
-- Adds a customer-authored "notes" field at two grains:
--   * campaigns.notes   — one note per campaign (e.g. "All deliveries before 3pm,
--                         no nuts in any cake — anniversary push for Q3").
--   * recipients.notes  — one note per recipient (e.g. "Front desk is closed
--                         after 2pm; deliver to back door").
--
-- Both are nullable TEXT. Surfaced verbatim to the bakery in the Production tab.
-- We keep these as dedicated columns (rather than stuffing into the existing
-- `customizations` jsonb on recipients) so they're easy to query, easy to
-- backfill from the upload pipeline's `notes` column mapping, and
-- explicitly typed.
--
-- Idempotent: safe to re-run.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE recipients
  ADD COLUMN IF NOT EXISTS notes text;
