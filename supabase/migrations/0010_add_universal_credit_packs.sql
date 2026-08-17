-- Run this in the Supabase SQL editor (or via `supabase db push`) for
-- whichever project APP_SUPABASE_URL points at, before deploying the
-- updated /api/checkout and /api/webhook routes. Per house rule: run this
-- SQL in the Supabase SQL Editor and confirm it applies cleanly against
-- the live project BEFORE this PR is merged.
--
-- ════════════════════ DELIBERATE DESIGN DEVIATION -- READ THIS ═══════════
-- The task that produced this migration sketched a NEW `credit_balance`
-- column plus a NEW `consume_credit()` function, called as a separate
-- step after check_and_increment_usage. Per that same task's own explicit
-- instruction to read the existing usage-enforcement system fully before
-- changing anything and integrate with it rather than duplicate it: this
-- repo ALREADY has exactly this mechanism, added in
-- 0006_add_single_purchase_credits.sql for the $0.99 'single' plan --
-- a `credits` integer column on public.users, consumed atomically as
-- "tier 3" INSIDE check_and_increment_usage's own single UPDATE statement
-- (see that migration, extended by 0007), in the same round trip as the
-- free-daily-limit check. That function is called once per
-- /api/analyze request for every tool (profile/email/paper) uniformly,
-- so `credits` is already a universal-across-tools balance today --
-- exactly what this task asked for.
--
-- Building a second, parallel credit_balance/consume_credit() system
-- alongside it would mean two credit balances doing nearly the same job,
-- checked in two different places, with the new one requiring a second,
-- separate RPC round trip after check_and_increment_usage's own (which
-- would also reopen a small window that the existing single-UPDATE
-- design specifically exists to avoid). Instead, this migration adds
-- exactly one new thing: add_credits(), a general-purpose companion to
-- the existing grant_single_purchase_credit() that can add an arbitrary
-- amount (5 or 15, for the two new packs) to the SAME `credits` column,
-- mirroring grant_single_purchase_credit()'s exact insert-or-update-add
-- pattern (including preserving stripe_customer_id) so a credit-pack
-- purchase leaves the same trail a single-purchase does. No changes to
-- check_and_increment_usage's logic, atomicity, or signature at all.

create or replace function public.add_credits(
  p_user_id uuid,
  p_amount integer,
  p_stripe_customer_id text default null
) returns void as $$
begin
  insert into public.users (id, credits, stripe_customer_id)
  values (p_user_id, p_amount, p_stripe_customer_id)
  on conflict (id) do update
    set credits = public.users.credits + p_amount,
        -- Preserve an existing stripe_customer_id if this call didn't
        -- pass one, rather than clobbering it with null -- same
        -- coalesce pattern as grant_single_purchase_credit.
        stripe_customer_id = coalesce(excluded.stripe_customer_id, public.users.stripe_customer_id);
end;
$$ language plpgsql set search_path = public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.add_credits(uuid, integer, text) to service_role;
  end if;
end
$$;
