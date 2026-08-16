-- Run this in the Supabase SQL editor (or via `supabase db push`) for
-- whichever project APP_SUPABASE_URL points at, before deploying
-- api/reverse-search.js.
--
-- Backs reverse image search (detects stolen/reused photos via Google
-- Vision's WEB_DETECTION, alongside the existing AI-authenticity check).
-- This is gated entirely independently of check_and_increment_usage / the
-- free-analysis counter -- reverse search has its own separate allowance:
--   - Free tier: ONE lifetime free use (reverse_search_free_used), not the
--     daily-resetting free-analysis counter.
--   - An unused single-purchase credit: bundled in, allowed at no extra
--     cost -- doesn't decrement `credits`, since reverse search is
--     included in what that credit already paid for.
--   - Pro (plan_status = 'active'): a HARD daily cap
--     (reverse_search_pro_count/reverse_search_pro_day, same UTC-
--     calendar-day counter pattern as pro_usage_count/pro_usage_day from
--     0007) -- unlike the 150/day analysis soft cap, this one actually
--     blocks once hit, since a reverse-search call costs materially more
--     than a text-only usage-check.
--
-- Deliberate deviation from the task's suggested function signature
-- (check_and_increment_reverse_search(p_user_id, p_is_pro,
-- p_has_single_credit, p_pro_daily_limit)): that signature would require
-- the caller to look up plan_status/credits in a separate query BEFORE
-- calling this function, then pass them in as booleans -- reintroducing
-- exactly the read-then-write race window the existing atomic
-- UPDATE...RETURNING pattern (check_and_increment_usage,
-- acquire_request_slot, grant_single_purchase_credit) exists to avoid.
-- Since the task's overriding instruction is to "reuse these same atomic
-- patterns, not invent a new one," this function instead reads
-- plan_status/credits directly off the row itself, exactly like
-- check_and_increment_usage does for its own tiers -- so it only takes
-- (p_user_id, p_pro_daily_limit). There is still one narrow, low-stakes
-- race window from this design (documented on the function body below);
-- eliminating that too would need one shared UPDATE spanning all three
-- tiers, which reverse-search's per-tier logic doesn't decompose into as
-- cleanly as check_and_increment_usage's tiers do.

alter table public.users
  add column if not exists reverse_search_free_used boolean not null default false,
  add column if not exists reverse_search_pro_count integer not null default 0,
  add column if not exists reverse_search_pro_day date;

create or replace function public.check_and_increment_reverse_search(
  p_user_id uuid,
  p_pro_daily_limit integer
) returns table (o_allowed boolean, o_reason text) as $$
declare
  v_row public.users;
  v_pro_row public.users;
  v_today date := (now() at time zone 'utc')::date;
begin
  insert into public.users (id) values (p_user_id) on conflict (id) do nothing;

  -- Routes to the correct tier below. Narrow race window: if plan_status
  -- or credits changes between this read and the tier-specific atomic
  -- UPDATE a few lines down (e.g. a subscription downgrade webhook
  -- landing in that exact gap), this call could be processed under the
  -- tier it read here rather than the tier current at UPDATE time. Each
  -- tier's own UPDATE is still fully atomic and race-safe against
  -- concurrent calls to THIS function -- this window only affects
  -- which tier a single call is evaluated under, never allows a
  -- double-grant within a tier.
  select * into v_row from public.users u where u.id = p_user_id;

  if v_row.plan_status = 'active' then
    -- Pro: hard cap, not a soft cap -- the guard and the reset-or-
    -- increment CASE both happen inside this single UPDATE...RETURNING,
    -- same atomicity pattern as pro_usage_count in check_and_increment_
    -- usage, so concurrent Pro reverse-search calls on the same day
    -- can't both slip through past the limit.
    update public.users u
    set reverse_search_pro_count = case when u.reverse_search_pro_day is distinct from v_today then 1 else u.reverse_search_pro_count + 1 end,
        reverse_search_pro_day = v_today
    where u.id = p_user_id
      and (u.reverse_search_pro_day is distinct from v_today or u.reverse_search_pro_count < p_pro_daily_limit)
    returning u.* into v_pro_row;

    if v_pro_row.id is not null then
      return query select true, null::text;
    else
      return query select false, 'pro_daily_limit_reached'::text;
    end if;

  elsif v_row.credits > 0 then
    -- Bundled into an existing unused single-purchase credit. Never
    -- decrements credits -- reverse search is included in what that
    -- credit already paid for, not a second thing it must also cover.
    return query select true, null::text;

  else
    -- Free tier: one lifetime free use. The `= false` guard and the SET
    -- happen in the same UPDATE, so two concurrent free-tier calls for a
    -- brand-new user can't both succeed -- the second blocks on the row
    -- lock, then re-evaluates the guard against the first's
    -- already-committed `true` value.
    update public.users u
    set reverse_search_free_used = true
    where u.id = p_user_id
      and u.reverse_search_free_used = false
    returning u.* into v_row;

    if v_row.id is not null then
      return query select true, null::text;
    else
      return query select false, 'free_limit_reached'::text;
    end if;
  end if;
end;
$$ language plpgsql set search_path = public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.check_and_increment_reverse_search(uuid, integer) to service_role;
  end if;
end
$$;
