create extension if not exists pgcrypto;

create type inbox_processing_status as enum (
  'pending',
  'processing',
  'processed',
  'failed'
);

create type job_status as enum (
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled'
);

create type outbound_status as enum (
  'pending',
  'sent',
  'failed',
  'cancelled'
);

create type scheduler_status as enum (
  'started',
  'completed',
  'failed',
  'skipped'
);

create type actor_type as enum (
  'user',
  'system',
  'ai'
);

create type entity_status as enum (
  'draft',
  'proposed',
  'confirmed',
  'rejected',
  'archived'
);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists inbox_items (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'telegram',
  external_update_id text,
  external_message_id text,
  external_chat_id text,
  external_user_id text,
  content_type text not null,
  original_text text,
  original_payload jsonb not null,
  original_payload_hash text,
  message_timestamp timestamptz,
  received_at timestamptz not null default timezone('utc', now()),
  processing_status inbox_processing_status not null default 'pending',
  processing_started_at timestamptz,
  processed_at timestamptz,
  failed_at timestamptz,
  retry_count integer not null default 0,
  next_retry_at timestamptz,
  last_error_code text,
  last_error_message text,
  preliminary_type text,
  preliminary_summary text,
  ai_confidence numeric(5,4),
  locked_at timestamptz,
  locked_by text,
  correlation_id uuid not null default gen_random_uuid(),
  created_by actor_type not null default 'user',
  updated_by actor_type not null default 'system',
  revision integer not null default 1,
  is_archived boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (retry_count >= 0),
  check (
    processing_status <> 'processed'
    or processed_at is not null
  )
);

create unique index if not exists idx_inbox_items_source_update_unique
  on inbox_items (source, external_update_id)
  where external_update_id is not null;

create unique index if not exists idx_inbox_items_source_message_unique
  on inbox_items (source, external_chat_id, external_message_id)
  where external_chat_id is not null and external_message_id is not null;

create index if not exists idx_inbox_items_processing_status
  on inbox_items (processing_status, next_retry_at, received_at);

create index if not exists idx_inbox_items_locked_at
  on inbox_items (locked_at);

create index if not exists idx_inbox_items_correlation_id
  on inbox_items (correlation_id);

create table if not exists inbox_attachments (
  id uuid primary key default gen_random_uuid(),
  inbox_item_id uuid not null references inbox_items(id) on delete cascade,
  attachment_type text not null,
  telegram_file_id text,
  telegram_file_unique_id text,
  storage_bucket text not null,
  storage_path text not null,
  mime_type text,
  file_name text,
  file_size_bytes bigint,
  checksum_sha256 text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (storage_bucket, storage_path)
);

create index if not exists idx_inbox_attachments_inbox_item_id
  on inbox_attachments (inbox_item_id);

create table if not exists processing_jobs (
  id uuid primary key default gen_random_uuid(),
  inbox_item_id uuid not null references inbox_items(id) on delete cascade,
  job_type text not null default 'process-inbox',
  status job_status not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  scheduled_for timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  next_retry_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (attempt_count >= 0),
  check (max_attempts > 0)
);

create index if not exists idx_processing_jobs_status_schedule
  on processing_jobs (status, scheduled_for, next_retry_at);

create index if not exists idx_processing_jobs_inbox_item_id
  on processing_jobs (inbox_item_id);

create index if not exists idx_processing_jobs_locked_at
  on processing_jobs (locked_at);

create table if not exists item_analysis (
  id uuid primary key default gen_random_uuid(),
  inbox_item_id uuid not null references inbox_items(id) on delete cascade,
  analysis_type text not null,
  model_provider text not null default 'deepseek',
  model_name text not null,
  prompt_version text,
  input_snapshot jsonb,
  output_text text,
  output_json jsonb,
  confidence numeric(5,4),
  token_usage_input integer,
  token_usage_output integer,
  estimated_cost_usd numeric(12,6),
  created_by actor_type not null default 'ai',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_item_analysis_inbox_item_id
  on item_analysis (inbox_item_id, created_at desc);

create table if not exists proposed_entities (
  id uuid primary key default gen_random_uuid(),
  inbox_item_id uuid not null references inbox_items(id) on delete cascade,
  entity_type text not null,
  status entity_status not null default 'proposed',
  title text,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  confidence numeric(5,4),
  source_analysis_id uuid references item_analysis(id) on delete set null,
  confirmed_at timestamptz,
  rejected_at timestamptz,
  created_by actor_type not null default 'ai',
  updated_by actor_type not null default 'system',
  revision integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_proposed_entities_inbox_item_id
  on proposed_entities (inbox_item_id, status);

create table if not exists outbound_messages (
  id uuid primary key default gen_random_uuid(),
  inbox_item_id uuid references inbox_items(id) on delete set null,
  channel text not null default 'telegram',
  recipient_id text not null,
  message_type text not null,
  status outbound_status not null default 'pending',
  template_key text,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  last_error_message text,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_outbound_messages_status
  on outbound_messages (status, created_at);

create table if not exists scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  scheduled_for timestamptz not null,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  status scheduler_status not null default 'started',
  trigger_source text not null default 'pg_cron',
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error_message text,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_scheduler_runs_job_unique
  on scheduler_runs (job_name, scheduled_for);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor actor_type not null,
  actor_id text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  correlation_id uuid,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_audit_log_entity
  on audit_log (entity_type, entity_id, created_at desc);

create index if not exists idx_audit_log_correlation_id
  on audit_log (correlation_id);

create trigger trg_inbox_items_set_updated_at
before update on inbox_items
for each row
execute function set_updated_at();

create trigger trg_processing_jobs_set_updated_at
before update on processing_jobs
for each row
execute function set_updated_at();

create trigger trg_proposed_entities_set_updated_at
before update on proposed_entities
for each row
execute function set_updated_at();

create trigger trg_outbound_messages_set_updated_at
before update on outbound_messages
for each row
execute function set_updated_at();
