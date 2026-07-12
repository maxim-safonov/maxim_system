alter table proposed_entities
  add column if not exists notion_page_id text,
  add column if not exists notion_synced_at timestamptz,
  add column if not exists notion_last_error text;

create index if not exists idx_proposed_entities_notion_sync
  on proposed_entities (status, entity_type, notion_synced_at, created_at);

