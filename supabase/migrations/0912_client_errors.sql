-- 0912: crash reports from the web and native apps (OPS18 monitoring). Owner: lead.
--
-- Real people moved to the rebuilt app on 2026-10-04 and nothing told us when a screen
-- crashed for them. The client now reports render crashes (ErrorBoundary) and uncaught
-- errors, at most 10 a session. Stored per fingerprint and day with a count, so a crash
-- loop is one row. Only technical facts are kept: build, route name, error name, a
-- redacted message (emails, links, long numbers and quoted text removed by the client
-- and again here), up to 8 stack lines, the browser family and the reporter's id.
-- Never message text, file names or tokens. Rows older than 30 days are pruned.

create table if not exists dek.client_errors (
  id          bigint generated always as identity primary key,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{16,64}$'),
  day         date not null default (now() at time zone 'utc')::date,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  count       int not null default 1,
  build       text check (char_length(build) <= 64),
  route       text check (char_length(route) <= 40),
  name        text check (char_length(name) <= 80),
  message     text check (char_length(message) <= 300),
  stack       text check (char_length(stack) <= 1500),
  agent       text check (char_length(agent) <= 80),
  user_id     uuid,
  unique (fingerprint, day)
);
create index if not exists client_errors_seen_idx on dek.client_errors (last_seen desc);
alter table dek.client_errors enable row level security;

create or replace function dek.redact_text(p text, p_max int)
returns text language sql immutable set search_path = '' as $$
  select left(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
           '[^\s@]+@[^\s@]+', '<email>', 'g'),
           'https?://\S+', '<link>', 'g'),
           '\d{6,}', '<number>', 'g'),
           '"[^"]{20,}"', '"<text>"', 'g'), p_max)
$$;

create or replace function api.report_client_error(p_report jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();   -- anonymous reports are allowed (the sign-in screen can crash too)
  v_fp   text := lower(coalesce(p_report->>'fingerprint', ''));
  v_day  date := (now() at time zone 'utc')::date;
begin
  if jsonb_typeof(p_report) is distinct from 'object' or v_fp !~ '^[0-9a-f]{16,64}$' then
    perform dek.err('invalid_input', 'A crash report needs a fingerprint.');
  end if;
  -- a signed-in person: 30 reports an hour; everyone together: 2,000 rows a day
  if v_uid is not null then
    perform dek.rate_hit(v_uid, 'client_error', 30, 3600);
  end if;
  if not exists (select 1 from dek.client_errors e where e.fingerprint = v_fp and e.day = v_day)
     and (select count(*) from dek.client_errors e where e.day = v_day) >= 2000 then
    return jsonb_build_object('stored', false);
  end if;
  insert into dek.client_errors as e (fingerprint, day, build, route, name, message, stack, agent, user_id)
  values (v_fp, v_day,
          left(p_report->>'build', 64), left(p_report->>'route', 40), left(p_report->>'name', 80),
          dek.redact_text(p_report->>'message', 300), dek.redact_text(p_report->>'stack', 1500),
          left(p_report->>'agent', 80), v_uid)
  on conflict (fingerprint, day) do update
     set count = e.count + 1, last_seen = now(), user_id = coalesce(excluded.user_id, e.user_id);
  return jsonb_build_object('stored', true);
end $$;

-- 30 days of crash reports are enough to see a pattern
create or replace function dek.prune()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from dek.notification_deliveries where created_at < now() - interval '14 days';
  delete from dek.notification_intents
   where status in ('done', 'failed', 'expired') and created_at < now() - interval '7 days';
  delete from dek.rate_buckets where window_start < now() - interval '1 day';
  delete from dek.push_devices where revoked_at is not null and revoked_at < now() - interval '30 days';
  delete from dek.auth_codes where created_at < now() - interval '1 day';
  delete from dek.client_errors where last_seen < now() - interval '30 days';
  begin
    delete from cron.job_run_details where end_time < now() - interval '2 days';
  exception when others then
    raise warning 'dek.prune: cron history not pruned: %', sqlerrm;
  end;
end $$;

-- The anonymous allow-list gains report_client_error (a crash on the sign-in screen has
-- no user yet). Same procedure as 0000 otherwise.
create or replace procedure dek_meta.lockdown()
language plpgsql
set search_path = ''
as $$
declare
  r record;
  policy_helpers constant text[] := array['can_use_topic', 'can_read_object', 'can_write_object'];
  anon_api constant text[] := array['preview_invite', 'report_client_error'];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname, n.nspname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('dek', 'dek_meta', 'api')
       and p.prokind in ('f', 'p')
  loop
    execute format('revoke all on routine %s from public, anon, authenticated, service_role', r.sig);
    if r.nspname = 'dek' and r.proname = any (policy_helpers) then
      execute format('grant execute on routine %s to authenticated', r.sig);
    elsif r.nspname = 'api' and r.proname like 'svc\_%' then
      execute format('grant execute on routine %s to service_role', r.sig);
    elsif r.nspname = 'api' then
      execute format('grant execute on routine %s to authenticated', r.sig);
      if r.proname = any (anon_api) then
        execute format('grant execute on routine %s to anon', r.sig);
      end if;
    end if;
  end loop;

  for r in
    select c.oid::regclass as rel
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('dek', 'dek_meta', 'api')
       and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  loop
    execute format('revoke all on %s from public, anon, authenticated, service_role', r.rel);
  end loop;
end;
$$;
