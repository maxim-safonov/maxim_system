create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'process-inbox-every-minute'
  ) then
    perform cron.unschedule('process-inbox-every-minute');
  end if;
end
$$;

select
  cron.schedule(
    'process-inbox-every-minute',
    '* * * * *',
    $$
    select
      net.http_post(
        url := 'https://oyccplxlugbsgyhlzglj.supabase.co/functions/v1/process-inbox',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb
      ) as request_id;
    $$
  );
