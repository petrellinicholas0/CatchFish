-- Run this in the Supabase SQL editor (or via `supabase db push`) for
-- whichever project APP_SUPABASE_URL points at, before deploying the
-- updated /api/analyze route.
--
-- Prior to this migration, the free-analysis usage limit was tracked only
-- in the browser's localStorage (cf_usage / cf_pro), which meant any user
-- could bypass it entirely by editing localStorage directly or calling
-- /api/analyze without going through the app at all. This adds a
-- server-side counter, keyed by the same client-generated device id
-- (cf_uid) already used for checkout, plus an atomic function that checks
-- and increments it in one statement so concurrent/rapid requests can't
-- race past the limit.

alter table public.users
  add column if not exists usage_count integer not null default 0,
  add column if not exists usage_reset_at timestamptz not null default now();

-- Ensures a device gets its own row on first use (not just at checkout),
-- resets the counter once RESET_HOURS has elapsed for non-pro users, then
-- atomically increments and reports whether this call is allowed. All of
-- this happens in a single round trip so a burst of parallel requests from
-- the same device can't all read "2 of 3 used" before any of them writes.
drop function if exists public.check_and_increment_usage(uuid, integer, integer);

create or replace function public.check_and_increment_usage(
  p_user_id uuid,
  p_free_limit integer,
  p_reset_hours integer
) returns table (o_allowed boolean, o_is_pro boolean, o_usage_count integer) as $$
declare
  v_row public.users;
begin
  insert into public.users (id, plan_status, usage_count, usage_reset_at)
  values (p_user_id, 'free', 0, now())
  on conflict (id) do nothing;

  update public.users u
  set usage_count = 0, usage_reset_at = now()
  where u.id = p_user_id
    and u.plan_status <> 'active'
    and u.usage_reset_at < now() - (p_reset_hours::text || ' hours')::interval;

  update public.users u
  set usage_count = u.usage_count + 1
  where u.id = p_user_id
    and (u.plan_status = 'active' or u.usage_count < p_free_limit)
  returning u.* into v_row;

  if v_row.id is not null then
    return query select true, (v_row.plan_status = 'active'), v_row.usage_count;
  else
    select * into v_row from public.users u where u.id = p_user_id;
    return query select false, coalesce(v_row.plan_status = 'active', false), coalesce(v_row.usage_count, 0);
  end if;
end;
$$ language plpgsql set search_path = public;

-- Service role already bypasses RLS and owns full table access; this grant
-- just makes the intent explicit (only the server, via the secret key,
-- ever calls this function — never the browser). Guarded because
-- service_role only exists on an actual Supabase project, not a generic
-- Postgres instance this migration might be tested against.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.check_and_increment_usage(uuid, integer, integer) to service_role;
  end if;
end
$$;
