do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'notion-sync-every-2-minutes'
  ) then
    perform cron.unschedule('notion-sync-every-2-minutes');
  end if;
end
$$;

select
  cron.schedule(
    'notion-sync-every-2-minutes',
    '*/2 * * * *',
    $$
    select
      net.http_post(
        url := 'https://oyccplxlugbsgyhlzglj.supabase.co/functions/v1/notion-sync',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb
      ) as request_id;
    $$
  );
