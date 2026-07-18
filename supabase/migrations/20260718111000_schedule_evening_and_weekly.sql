do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'evening-dialog-daily'
  ) then
    perform cron.unschedule('evening-dialog-daily');
  end if;
end
$$;

select
  cron.schedule(
    'evening-dialog-daily',
    '0 22 * * *',
    $$
    select
      net.http_post(
        url := 'https://oyccplxlugbsgyhlzglj.supabase.co/functions/v1/evening-dialog',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb
      ) as request_id;
    $$
  );

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'weekly-review-sunday'
  ) then
    perform cron.unschedule('weekly-review-sunday');
  end if;
end
$$;

select
  cron.schedule(
    'weekly-review-sunday',
    '0 18 * * 0',
    $$
    select
      net.http_post(
        url := 'https://oyccplxlugbsgyhlzglj.supabase.co/functions/v1/weekly-review',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb
      ) as request_id;
    $$
  );
