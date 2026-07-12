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
  select pj.id
    into claimed_job_id
  from processing_jobs as pj
  where (
      pj.status = 'pending'
      and (
        pj.next_retry_at is null
        or pj.next_retry_at <= timezone('utc', now())
      )
      and pj.scheduled_for <= timezone('utc', now())
    )
    or (
      pj.status = 'processing'
      and pj.locked_at is not null
      and pj.locked_at <= timezone('utc', now()) - interval '10 minutes'
      and pj.attempt_count < pj.max_attempts
    )
  order by pj.scheduled_for asc, pj.created_at asc
  for update skip locked
  limit 1;

  if claimed_job_id is null then
    return;
  end if;

  return query
  update processing_jobs as pj
  set status = 'processing',
      started_at = timezone('utc', now()),
      locked_at = timezone('utc', now()),
      locked_by = coalesce(worker_name, 'process-inbox'),
      attempt_count = pj.attempt_count + 1,
      updated_at = timezone('utc', now()),
      last_error_code = null,
      last_error_message = null
  where pj.id = claimed_job_id
  returning
    pj.id,
    pj.inbox_item_id,
    pj.job_type,
    pj.attempt_count,
    pj.payload,
    pj.correlation_id;
end;
$$;
