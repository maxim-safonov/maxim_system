alter table daily_sessions
  add column if not exists notion_page_id text,
  add column if not exists notion_synced_at timestamptz,
  add column if not exists notion_last_error text;

create index if not exists idx_daily_sessions_notion_sync
  on daily_sessions (session_date desc, notion_synced_at);
