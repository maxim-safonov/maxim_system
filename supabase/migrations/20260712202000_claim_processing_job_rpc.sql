create or replace function claim_next_processing_job(worker_name text default null)
returns table (
  id uuid,
  inbox_item_id uuid,
  job_type text,
  attempt_count integer,
  payload jsonb,
  correlation_id uuid
)
language plpgsql
as $$
declare
  claimed_job_id uuid;
begin
  select processing_jobs.id
    into claimed_job_id
  from processing_jobs
  where processing_jobs.status = 'pending'
    and (
      processing_jobs.next_retry_at is null
      or processing_jobs.next_retry_at <= timezone('utc', now())
    )
    and processing_jobs.scheduled_for <= timezone('utc', now())
  order by processing_jobs.scheduled_for asc, processing_jobs.created_at asc
  for update skip locked
  limit 1;

  if claimed_job_id is null then
    return;
  end if;

  update processing_jobs
  set status = 'processing',
      started_at = timezone('utc', now()),
      locked_at = timezone('utc', now()),
      locked_by = coalesce(worker_name, 'process-inbox'),
      attempt_count = attempt_count + 1,
      updated_at = timezone('utc', now())
  where processing_jobs.id = claimed_job_id
  returning
    processing_jobs.id,
    processing_jobs.inbox_item_id,
    processing_jobs.job_type,
    processing_jobs.attempt_count,
    processing_jobs.payload,
    processing_jobs.correlation_id
  into id, inbox_item_id, job_type, attempt_count, payload, correlation_id;

  return next;
end;
$$;
