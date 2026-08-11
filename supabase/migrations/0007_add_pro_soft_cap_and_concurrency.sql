-- Run this in the Supabase SQL editor (or via `supabase db push`) for
-- whichever project APP_SUPABASE_URL points at, before deploying the
-- updated /api/analyze route.
--
-- Two independent gaps fixed here:
--
-- (a) Pro soft cap: plan_status = 'active' users bypass the daily-limit
--     check entirely (see check_and_increment_usage below) — there was no
--     cap at all, not even a logged one. Adds pro_usage_count/
--     pro_usage_day (a UTC-calendar-day counter, deliberately separate
--     from usage_count/usage_reset_at, which is a rolling 24h window used
--     to hard-enforce the FREE tier and has different reset semantics)
--     plus a pro_usage_overages log table. This is a SOFT cap only:
--     exceeding it is logged for visibility but o_allowed is still always
--     true for Pro — no Pro request is ever blocked by this.
--
-- (b) Concurrency cap: nothing tracked how many requests were
--     simultaneously in flight for a given userId — checkIpRateLimit
--     (api/analyze.js) is a rate limiter over a time window, not a
--     concurrency gate, and check_and_increment_usage checks a cumulative
--     count, not simultaneous calls. Adds in_flight_requests plus
--     acquire_request_slot/release_request_slot, called from
--     api/analyze.js around the Anthropic API call (independent of, and
--     in addition to, the daily-limit/soft-cap logic above — applies to
--     every plan, including Pro).

alter table public.users
  add column if not exists pro_usage_count integer not null default 0,
  add column if not exists pro_usage_day date,
  add column if not exists in_flight_requests integer not null default 0;

create table if not exists public.pro_usage_overages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  usage_count integer not null,
  occurred_on date not null,
  created_at timestamptz not null default now()
);
alter table public.pro_usage_overages enable row level security;

-- Signature changes (3 params -> 4, for the new p_pro_daily_limit), so the
-- old 3-arg overload must be dropped explicitly or it would linger
-- alongside the new one as a separate, orphaned overload.
drop function if exists public.check_and_increment_usage(uuid, integer, integer);

create or replace function public.check_and_increment_usage(
  p_user_id uuid,
  p_free_limit integer,
  p_reset_hours integer,
  p_pro_daily_limit integer
) returns table (o_allowed boolean, o_is_pro boolean, o_usage_count integer) as $$
declare
  v_row public.users;
  v_credit_row public.users;
  v_pro_row public.users;
  v_today date := (now() at time zone 'utc')::date;
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
    if v_row.plan_status = 'active' then
      -- Pro soft cap. Reset-to-1-or-increment happens inside this single
      -- UPDATE...RETURNING, same atomicity pattern as every other counter
      -- in this function — no read-then-write gap, so concurrent Pro
      -- requests on the same day can't undercount each other.
      update public.users u
      set pro_usage_count = case when u.pro_usage_day is distinct from v_today then 1 else u.pro_usage_count + 1 end,
          pro_usage_day = v_today
      where u.id = p_user_id
      returning u.* into v_pro_row;

      if v_pro_row.pro_usage_count > p_pro_daily_limit then
        insert into public.pro_usage_overages (user_id, usage_count, occurred_on)
        values (p_user_id, v_pro_row.pro_usage_count, v_today);
      end if;
    end if;

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

-- Concurrency cap: 3 simultaneous in-flight requests per userId, across
-- every plan. Atomic guard-and-increment in one UPDATE (same pattern as
-- the credit-spend tier above): the `where in_flight_requests < 3` guard
-- and the increment happen in the same statement, so two simultaneous
-- acquire calls for the same user can't both succeed past the limit.
create or replace function public.acquire_request_slot(p_user_id uuid) returns boolean as $$
declare
  v_row public.users;
  c_max_concurrent constant integer := 3;
begin
  insert into public.users (id) values (p_user_id) on conflict (id) do nothing;

  update public.users u
  set in_flight_requests = u.in_flight_requests + 1
  where u.id = p_user_id
    and u.in_flight_requests < c_max_concurrent
  returning u.* into v_row;

  return v_row.id is not null;
end;
$$ language plpgsql set search_path = public;

-- Companion to acquire_request_slot — must be called exactly once for
-- every successful acquire (see api/analyze.js's try/finally). Floors at
-- 0 so a mismatched or duplicate release call can never drive the count
-- negative and (incorrectly) grant an extra slot beyond the real cap.
create or replace function public.release_request_slot(p_user_id uuid) returns void as $$
begin
  update public.users u
  set in_flight_requests = greatest(u.in_flight_requests - 1, 0)
  where u.id = p_user_id;
end;
$$ language plpgsql set search_path = public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.check_and_increment_usage(uuid, integer, integer, integer) to service_role;
    grant execute on function public.acquire_request_slot(uuid) to service_role;
    grant execute on function public.release_request_slot(uuid) to service_role;
  end if;
end
$$;
