-- Plan 3 — recipients dedup constraint.
-- Migration 002 left recipients_legacy_idx as a plain unique INDEX on
-- (campaign_id, legacy_id). Plan 3's customer-upload edge function uses
-- INSERT ... ON CONFLICT ON CONSTRAINT recipients_campaign_legacy_unique
-- DO NOTHING for idempotent re-uploads, which requires a named CONSTRAINT
-- (a bare unique index is not addressable by name). Replace the index with
-- an equivalent unique constraint. Postgres' default NULLS DISTINCT semantics
-- still allow unlimited rows where legacy_id IS NULL.

drop index if exists recipients_legacy_idx;

alter table recipients
  add constraint recipients_campaign_legacy_unique
    unique (campaign_id, legacy_id);
