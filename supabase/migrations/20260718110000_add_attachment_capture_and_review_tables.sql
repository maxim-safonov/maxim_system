alter table inbox_attachments
  add column if not exists downloaded_at timestamptz,
  add column if not exists last_download_error text;

create table if not exists daily_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  status text not null default 'pending',
  prompt_text text,
  summary_text text,
  chat_id text,
  sent_at timestamptz,
  reminder_sent_at timestamptz,
  responded_at timestamptz,
  source_inbox_item_id uuid references inbox_items(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (session_date)
);

create index if not exists idx_daily_sessions_status
  on daily_sessions (status, session_date desc);

create table if not exists weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  week_start_date date not null,
  status text not null default 'pending',
  title text,
  summary_text text,
  chat_id text,
  sent_at timestamptz,
  source_scheduler_run_id uuid references scheduler_runs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (week_start_date)
);

create index if not exists idx_weekly_reviews_status
  on weekly_reviews (status, week_start_date desc);

create trigger trg_daily_sessions_set_updated_at
before update on daily_sessions
for each row
execute function set_updated_at();

create trigger trg_weekly_reviews_set_updated_at
before update on weekly_reviews
for each row
execute function set_updated_at();
