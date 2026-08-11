-- Backs api/report-content.js: in-app flagging for AI-generated results,
-- required by Google Play's AI-Generated Content policy (users must be able
-- to report AI content to the developer without leaving the app).

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tool text not null check (tool in ('profile_analyzer','email_check','paper_check')),
  user_id text,
  reason text not null,
  note text,
  result_summary text
);
alter table public.content_reports enable row level security;
