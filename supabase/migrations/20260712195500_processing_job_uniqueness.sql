create unique index if not exists idx_processing_jobs_inbox_item_job_type_unique
  on processing_jobs (inbox_item_id, job_type);
