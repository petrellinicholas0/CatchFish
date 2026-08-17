-- Run this in the Supabase SQL Editor for whichever project APP_SUPABASE_URL
-- points at, before deploying the updated api/screenshot-import.js.
--
-- Fixes a gap found in security review: the "Import from Screenshot"
-- feature's daily cap (IMPORT_DAILY_CAP = 8) was enforced entirely
-- client-side (cf_import_usage/cf_import_reset in index.html), so a
-- direct call to api/screenshot-import.js -- which calls the Anthropic API
-- per request -- had no server-side limit at all.
--
-- Deliberately a SEPARATE counter/function from check_and_increment_usage
-- (0002_usage_tracking.sql, extended by 0006/0007), not a reuse of it:
-- check_and_increment_usage's whole point is that plan_status = 'active'
-- (Pro) bypasses the daily limit entirely. The import cap must NOT do
-- that -- per the feature's original spec, it's an API-abuse guard, not a
-- paywall, and applies to every plan including Pro. Same atomic
-- insert-if-missing / reset-if-elapsed / guarded-increment pattern as
-- check_and_increment_usage otherwise, so a burst of parallel requests
-- from the same device can't race past the limit.

alter table public.users
  add column if not exists import_usage_count integer not null default 0,
  add column if not exists import_usage_reset_at timestamptz not null default now();

create or replace function public.check_and_increment_import_usage(
  p_user_id uuid,
  p_daily_limit integer,
  p_reset_hours integer
) returns table (o_allowed boolean, o_usage_count integer) as $$
declare
  v_row public.users;
begin
  insert into public.users (id, import_usage_count, import_usage_reset_at)
  values (p_user_id, 0, now())
  on conflict (id) do nothing;

  -- Rolling-window reset -- unconditional, unlike check_and_increment_
  -- usage's reset (which only resets for non-Pro rows). This cap applies
  -- uniformly to every plan, so there is no plan_status guard here at all.
  update public.users u
  set import_usage_count = 0, import_usage_reset_at = now()
  where u.id = p_user_id
    and u.import_usage_reset_at < now() - (p_reset_hours::text || ' hours')::interval;

  -- The guard (`import_usage_count < p_daily_limit`) and the increment
  -- happen in this single UPDATE...RETURNING, so two concurrent requests
  -- for the same user can't both slip through past the limit -- the
  -- second blocks on the row lock, then re-evaluates the guard against
  -- the first's already-committed value.
  update public.users u
  set import_usage_count = u.import_usage_count + 1
  where u.id = p_user_id
    and u.import_usage_count < p_daily_limit
  returning u.* into v_row;

  if v_row.id is not null then
    return query select true, v_row.import_usage_count;
  else
    select * into v_row from public.users u where u.id = p_user_id;
    return query select false, coalesce(v_row.import_usage_count, 0);
  end if;
end;
$$ language plpgsql set search_path = public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.check_and_increment_import_usage(uuid, integer, integer) to service_role;
  end if;
end
$$;
