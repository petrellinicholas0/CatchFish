-- Run this in the Supabase SQL editor (or via `supabase db push`) for
-- whichever project APP_SUPABASE_URL points at, before deploying
-- api/play-verify.js.
--
-- Named 0004, not 0003 as originally requested: 0003 is already taken by
-- 0003_no_unique_constraint_on_email.sql (a documentation-only migration
-- from the account-takeover fix). Migration numbers are append-only, so
-- reusing 0003 here would collide with an already-applied migration.

alter table public.users
  add column if not exists play_purchase_token text;
