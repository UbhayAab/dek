-- 0913: one signed link per file at a time, shared by everyone allowed to open it.
-- Owner: lead.
--
-- media-sign minted a fresh link for every viewer, and the Storage CDN caches by the full
-- link, so the second, tenth and hundredth person opening the same photo all went to the
-- origin (measured 2026-10-05: the same link fetched again is a CDN HIT). Now media-sign
-- reuses a link while it has at least 10 minutes left (links live 20 minutes), after the
-- same per-person access check as before: sharing a link changes who can fetch nothing,
-- because every viewer was already allowed to open the file.
-- The table is reachable only through the two service functions below.

create table if not exists dek.media_links (
  path       text primary key check (char_length(path) <= 400),
  url        text not null check (char_length(url) <= 2000),
  expires_at timestamptz not null
);
alter table dek.media_links enable row level security;

-- links for these paths with at least p_min_seconds of life left: { path: { url, expires_at } }
create or replace function api.svc_media_links_get(p_paths text[], p_min_seconds int default 600)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(l.path, jsonb_build_object('url', l.url, 'expires_at', l.expires_at)), '{}'::jsonb)
    from dek.media_links l
   where l.path = any (coalesce(p_paths[1:100], '{}'::text[]))
     and l.expires_at > now() + make_interval(secs => greatest(coalesce(p_min_seconds, 600), 60))
$$;

-- p_links: [{ path, url, expires_at }]
create or replace function api.svc_media_links_put(p_links jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into dek.media_links (path, url, expires_at)
  select x.path, x.url, x.expires_at
    from jsonb_to_recordset(coalesce(p_links, '[]'::jsonb)) as x(path text, url text, expires_at timestamptz)
   where x.path is not null and x.url is not null and x.expires_at > now()
   limit 100
  on conflict (path) do update set url = excluded.url, expires_at = excluded.expires_at
   where dek.media_links.expires_at < excluded.expires_at
$$;

-- a deleted or purged file loses its shared link at once
create or replace function dek.media_links_forget()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('deleted', 'rejected') or new.purged_at is not null then
    delete from dek.media_links l where l.path in (new.object_path, new.thumb_path);
  end if;
  return null;
end $$;

drop trigger if exists dek_media_links_forget on dek.attachments;
create trigger dek_media_links_forget after update of status, purged_at on dek.attachments
  for each row execute function dek.media_links_forget();

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
  delete from dek.media_links where expires_at < now();
  begin
    delete from cron.job_run_details where end_time < now() - interval '2 days';
  exception when others then
    raise warning 'dek.prune: cron history not pruned: %', sqlerrm;
  end;
end $$;
