-- 002_fix_recipients_unique.sql
-- The partial predicate `where legacy_id is not null` on recipients_legacy_idx
-- breaks the migration runner: PostgREST's `.upsert(..., { onConflict: 'campaign_id,legacy_id' })`
-- cannot target a partial unique index (PG 42P10). Replace with a regular unique
-- index. Postgres already treats NULLs as distinct in unique indexes, so this is
-- semantically equivalent for our rows that carry a NULL legacy_id.

drop index if exists recipients_legacy_idx;

create unique index if not exists recipients_legacy_idx
  on recipients(campaign_id, legacy_id);
