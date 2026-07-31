-- Run this in the Supabase SQL editor (or via `supabase db push`) for
-- project https://vojkxzrqguyhosmzwwjh.supabase.co before deploying the
-- /api/checkout and /api/webhook routes.

create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  plan_status text not null default 'free',
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

create index if not exists users_stripe_customer_id_idx
  on public.users (stripe_customer_id);

-- Locks the table down to the service role only (used server-side via
-- SUPABASE_SECRET_KEY). No policies are added since the app never reads
-- or writes this table from the browser.
alter table public.users enable row level security;
