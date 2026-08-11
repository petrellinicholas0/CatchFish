-- Run this in the Supabase SQL editor (or via `supabase db push`) for
-- whichever project APP_SUPABASE_URL points at, before deploying the
-- updated /api/webhook and /api/analyze routes.
--
-- Fixes a revenue leak: api/webhook.js used to set plan_status: 'active'
-- for ANY completed checkout.session.completed event, including the
-- $0.99 'single' plan (Stripe mode: 'payment', one-time). A 'payment'-mode
-- session never has a subscription object, so customer.subscription.deleted
-- never fires to revoke it — a single-purchase buyer became a permanent,
-- unlimited Pro subscriber for $0.99. The fix (in api/webhook.js) grants
-- exactly one analysis credit instead and leaves plan_status untouched.
-- This migration adds the `credits` column that backs it, plus the two
-- Postgres functions that spend/grant credits atomically.

alter table public.users
  add column if not exists credits integer not null default 0;

-- Called from api/webhook.js's checkout.session.completed handler for the
-- 'single' plan only. A single INSERT ... ON CONFLICT DO UPDATE statement
-- is atomic on its own (Postgres serializes concurrent writers to the same
-- row), so this is safe even if Stripe redelivers the webhook or two
-- single-purchase webhooks for the same user land at once — each call
-- still adds exactly 1, never loses an increment to a race. Never touches
-- plan_status.
create or replace function public.grant_single_purchase_credit(
  p_user_id uuid,
  p_stripe_customer_id text
) returns void as $$
begin
  insert into public.users (id, stripe_customer_id, credits)
  values (p_user_id, p_stripe_customer_id, 1)
  on conflict (id) do update
    set credits = public.users.credits + 1,
        -- Preserve an existing stripe_customer_id if this event's session
        -- didn't have one, rather than clobbering it with null.
        stripe_customer_id = coalesce(excluded.stripe_customer_id, public.users.stripe_customer_id);
end;
$$ language plpgsql set search_path = public;

-- Extends check_and_increment_usage (from 0002_usage_tracking.sql) with a
-- third tier between "free daily limit" and "deny": a purchased credit.
-- Same signature as before, so api/analyze.js's rpc() call site doesn't
-- change. Order of precedence, matching the fix's spec exactly:
--   1. plan_status = 'active'         -> allow (unchanged)
--   2. usage_count < p_free_limit     -> allow, increment daily count (unchanged)
--   3. credits > 0                    -> allow, decrement credits by 1, daily count untouched
--   4. none of the above              -> deny (unchanged)
drop function if exists public.check_and_increment_usage(uuid, integer, integer);

create or replace function public.check_and_increment_usage(
  p_user_id uuid,
  p_free_limit integer,
  p_reset_hours integer
) returns table (o_allowed boolean, o_is_pro boolean, o_usage_count integer) as $$
declare
  v_row public.users;
  v_credit_row public.users;
begin
  insert into public.users (id, plan_status, usage_count, usage_reset_at)
  values (p_user_id, 'free', 0, now())
  on conflict (id) do nothing;

  update public.users u
  set usage_count = 0, usage_reset_at = now()
  where u.id = p_user_id
    and u.plan_status <> 'active'
    and u.usage_reset_at < now() - (p_reset_hours::text || ' hours')::interval;

  -- Tier 1 & 2: pro, or still within the free daily limit. Unchanged from
  -- the original function.
  update public.users u
  set usage_count = u.usage_count + 1
  where u.id = p_user_id
    and (u.plan_status = 'active' or u.usage_count < p_free_limit)
  returning u.* into v_row;

  if v_row.id is not null then
    return query select true, (v_row.plan_status = 'active'), v_row.usage_count;
  else
    -- Tier 3: not pro, daily limit used up — spend one purchased credit
    -- instead, if any. The `where credits > 0` guard inside this single
    -- UPDATE is what makes it race-safe: a second concurrent request for
    -- the same user blocks on the row lock, then re-evaluates this WHERE
    -- clause against the first request's already-committed (decremented)
    -- value once it proceeds — so two simultaneous requests can never both
    -- decrement a single remaining credit below zero. usage_count/
    -- usage_reset_at are deliberately not touched here.
    update public.users u
    set credits = u.credits - 1
    where u.id = p_user_id
      and u.credits > 0
    returning u.* into v_credit_row;

    if v_credit_row.id is not null then
      return query select true, false, v_credit_row.usage_count;
    else
      -- Tier 4: deny. Unchanged from the original function.
      select * into v_row from public.users u where u.id = p_user_id;
      return query select false, coalesce(v_row.plan_status = 'active', false), coalesce(v_row.usage_count, 0);
    end if;
  end if;
end;
$$ language plpgsql set search_path = public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.check_and_increment_usage(uuid, integer, integer) to service_role;
    grant execute on function public.grant_single_purchase_credit(uuid, text) to service_role;
  end if;
end
$$;
