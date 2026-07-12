alter table inbox_items
  add column if not exists notion_page_id text,
  add column if not exists notion_synced_at timestamptz,
  add column if not exists notion_last_error text;

create index if not exists idx_inbox_items_notion_sync
  on inbox_items (processing_status, notion_synced_at, created_at);

