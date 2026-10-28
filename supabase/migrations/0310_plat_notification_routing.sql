-- 0310: notification routing for push-dispatch. Owner: plat.
--
-- send_message (and start_call, send_test_notification) write one
-- dek.notification_intents row; its trigger posts the id to the push-dispatch Edge
-- Function after commit. push-dispatch calls api.svc_claim_intent, sends what it
-- returns, and reports back through api.svc_record_deliveries. Every routing rule is
-- here, in SQL, so the whole matrix is testable inside a rolled-back transaction
-- (PRD DEK14, DEK17, DEK18):
--
--   message  candidates = channel members (plus followers of the thread for a reply)
--            minus the author, minus anyone who can no longer read the channel
--            (revocation rechecked at send time: removed, suspended, left), anyone
--            who blocked the author, deleted profiles. Level = channel_members.notify,
--            'default' meaning prefs.default_level (channels) or prefs.dm_level (DMs).
--            'all' = timeline messages (every message in a DM), 'mentions' = direct
--            or <!channel>/<!here> mentions, 'none' = never. Thread replies notify
--            followers whose thread_replies pref is on, plus mentioned people. A mute
--            (muted_until in the future) lets only a direct <@me> mention through.
--            Somebody who already read the message is not pushed. Quiet hours turn
--            the push into a 'skipped' delivery row (reason quiet_hours).
--   call     participants still ringing (quiet hours apply; mute and levels do not).
--   test     the target user's devices, or the one target device.
--
-- A device that already has a final delivery row for the intent is never sent the
-- same intent again (retries never double-notify). A delivery that failed with a
-- retryable error (network, timeout, 429, 5xx) is retried by the next claim.

-- =====================================================================
-- Helpers (plat only)
-- =====================================================================

-- A failed delivery that the next attempt should retry.
create or replace function dek.plat_retryable(p_status text, p_http int)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_status = 'failed' and (p_http is null or p_http = 429 or p_http >= 500), false)
$$;

-- Quiet hours: [start, end) in the person's zone, wrapping midnight when start > end.
-- Called only for people who set quiet hours, so the exception block (a
-- subtransaction) never runs once per recipient of a large channel.
create or replace function dek.plat_in_quiet_hours(p_start time, p_end time, p_tz text,
                                                    p_at timestamptz default now())
returns boolean language plpgsql stable set search_path = '' as $$
declare v_local time;
begin
  if p_start is null or p_end is null or p_start = p_end then
    return false;
  end if;
  v_local := (p_at at time zone coalesce(p_tz, 'Asia/Kolkata'))::time;
  if p_start < p_end then
    return v_local >= p_start and v_local < p_end;
  end if;
  return v_local >= p_start or v_local < p_end;
exception when others then
  return false;   -- an unreadable zone never blocks a notification
end $$;

-- Notification text for a message body: <@uuid> as @Name, <#uuid> as #name only
-- when p_viewer can read that channel (anything else, and every link when p_viewer
-- is null, is a plain "#channel", so no channel name reaches a lock screen that
-- could not open it), <!channel> and <!here> as @channel and @here, whitespace
-- collapsed, at most 140 characters.
drop function if exists dek.plat_render_body(text, uuid);
create or replace function dek.plat_render_body(p_body text, p_org uuid, p_viewer uuid default null)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v       text := coalesce(p_body, '');
  r       record;
  uuid_re constant text := '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
begin
  for r in
    select distinct x.m[1] as id from regexp_matches(v, '<@(' || uuid_re || ')>', 'g') as x(m) limit 50
  loop
    v := replace(v, '<@' || r.id || '>', '@' || coalesce((
      select case when p.deleted_at is null then p.display_name else 'Deleted user' end
        from dek.profiles p
       where p.id = r.id::uuid
         and (p.deleted_at is not null
              or exists (select 1 from dek.org_members om where om.org_id = p_org and om.user_id = p.id))),
      'unknown'));
  end loop;
  for r in
    select distinct x.m[1] as id from regexp_matches(v, '<#(' || uuid_re || ')>', 'g') as x(m) limit 50
  loop
    v := replace(v, '<#' || r.id || '>', '#' || coalesce((
      select c.name from dek.channels c
       where c.id = r.id::uuid and c.org_id = p_org and c.name is not null
         and p_viewer is not null and dek.can_read_channel(p_viewer, c.id)),
      'channel'));
  end loop;
  v := replace(replace(v, '<!channel>', '@channel'), '<!here>', '@here');
  v := btrim(regexp_replace(v, '\s+', ' ', 'g'));
  if char_length(v) > 140 then
    v := rtrim(left(v, 137)) || '...';
  end if;
  return v;
end $$;

-- =====================================================================
-- Routes. Each returns one row per (recipient, device) with the payload already
-- decided by the recipient's preview preference.
-- =====================================================================

create or replace function dek.plat_route_message(i dek.notification_intents)
returns table (r_user uuid, r_device uuid, r_quiet boolean, r_title text, r_body text, r_url text,
               r_tag text, r_org uuid, r_org_short text, r_preview text, r_urgency text)
language plpgsql stable security definer set search_path = '' as $$
declare
  m       dek.messages;
  c       dek.channels;
  v_dm    boolean;
  v_org   text;
  v_title text;
  v_text  text;
  v_empty text;
  v_links boolean;
begin
  select * into m from dek.messages x where x.id = i.message_id;
  if not found or m.deleted_at is not null or m.kind <> 'user' or m.author_id is null then
    return;   -- deleted before dispatch, or a system line: nothing to say
  end if;
  select * into c from dek.channels x where x.id = m.channel_id;
  v_dm := c.kind in ('dm', 'group_dm');
  select coalesce(o.short_name, o.name) into v_org from dek.orgs o where o.id = m.org_id;
  select case c.kind when 'dm' then a.name when 'group_dm' then a.name || ' in a group message'
                     else a.name || ' in #' || c.name end
    into v_title
    from (select coalesce((select case when p.deleted_at is null then p.display_name else 'Deleted user' end
                             from dek.profiles p where p.id = m.author_id), 'Someone') as name) a;
  v_empty := case when m.attachment_count > 0 then 'Sent an attachment' else 'New message' end;
  -- Rendered once; a body with channel links is rendered per recipient instead, so a
  -- channel name shows only to people who can read that channel.
  v_links := m.body ~ '<#[0-9a-fA-F-]{36}>';
  v_text := coalesce(nullif(dek.plat_render_body(m.body, m.org_id), ''), v_empty);
  return query
  with cand as (
    select cm.user_id as uid from dek.channel_members cm where cm.channel_id = m.channel_id
    union
    select tf.user_id from dek.thread_follows tf
     where m.thread_root_id is not null and tf.root_id = m.thread_root_id and tf.following
  ), who as (
    select x.uid,
           coalesce(n.preview, 'full') as preview,
           coalesce(n.thread_replies, true) as thread_replies,
           n.quiet_start, n.quiet_end, n.quiet_tz,
           case when coalesce(cm.notify, 'default') <> 'default' then cm.notify
                when v_dm then coalesce(n.dm_level, 'all')
                else coalesce(n.default_level, 'mentions') end as level,
           cm.muted_until,
           coalesce(cm.last_read_seq, 0) as read_seq,
           coalesce(tf.following, false) as follows,
           coalesce(tf.last_read_reply_seq, 0) as read_reply_seq,
           x.uid = any (m.mentions) as direct
      from cand x
      join dek.profiles p on p.id = x.uid and p.deleted_at is null
      left join dek.notification_prefs n on n.user_id = x.uid
      left join dek.channel_members cm on cm.channel_id = m.channel_id and cm.user_id = x.uid
      left join dek.thread_follows tf on tf.root_id = m.thread_root_id and tf.user_id = x.uid
     where x.uid <> m.author_id
       and (i.target_user_id is null or x.uid = i.target_user_id)
       and not exists (select 1 from dek.user_blocks b where b.blocker_id = x.uid and b.blocked_id = m.author_id)
       and dek.can_read_channel(x.uid, m.channel_id)
  ), wanted as materialized (
    select w.*,
           case when w.preview <> 'full' then 'New message'
                when v_links then coalesce(nullif(dek.plat_render_body(m.body, m.org_id, w.uid), ''), v_empty)
                else v_text end as body_text
      from who w
     where w.level <> 'none'
       and ((w.level = 'all' and (v_dm or m.in_timeline))
            or w.direct or m.mention_all
            or (m.thread_root_id is not null and w.follows and w.thread_replies))
       and (w.muted_until is null or w.muted_until <= now() or w.direct)
       -- an intent aimed at one person (a mention added by an edit) skips the read check
       and (i.target_user_id is not null
            or not ((m.in_timeline and w.read_seq >= m.seq)
                    or (m.thread_root_id is not null and w.read_reply_seq >= m.seq)))
  )
  select w.uid, d.id,
         case when w.quiet_start is not null and w.quiet_end is not null
              then dek.plat_in_quiet_hours(w.quiet_start, w.quiet_end, w.quiet_tz) else false end,
         case when w.preview = 'none' then 'Dek' else v_title end,
         w.body_text,
         '/o/' || m.org_id || '/c/' || m.channel_id || coalesce('/t/' || m.thread_root_id, '') || '/m/' || m.id,
         coalesce('t:' || m.thread_root_id, 'c:' || m.channel_id),
         m.org_id, v_org, w.preview,
         case when w.direct or m.mention_all then 'high' else 'normal' end
    from wanted w
    join dek.push_devices d on d.user_id = w.uid and d.enabled and d.revoked_at is null
   where not exists (select 1 from dek.notification_deliveries nd
                      where nd.intent_id = i.id and nd.device_id = d.id
                        and not dek.plat_retryable(nd.status, nd.http_status))
   order by w.uid, d.id
   limit 5000;
end $$;

create or replace function dek.plat_route_call(i dek.notification_intents)
returns table (r_user uuid, r_device uuid, r_quiet boolean, r_title text, r_body text, r_url text,
               r_tag text, r_org uuid, r_org_short text, r_preview text, r_urgency text)
language plpgsql stable security definer set search_path = '' as $$
declare
  k        dek.calls;
  v_org    text;
  v_caller text;
begin
  select * into k from dek.calls x where x.id = i.call_id;
  if not found or k.ended_at is not null then
    return;   -- answered, declined or ended before dispatch
  end if;
  select coalesce(o.short_name, o.name) into v_org from dek.orgs o where o.id = k.org_id;
  select case when p.deleted_at is null then p.display_name else 'Deleted user' end into v_caller
    from dek.profiles p where p.id = coalesce(k.started_by, i.actor_id);
  v_caller := coalesce(v_caller, 'Someone');
  return query
  select cp.user_id, d.id,
         case when n.quiet_start is not null and n.quiet_end is not null
              then dek.plat_in_quiet_hours(n.quiet_start, n.quiet_end, n.quiet_tz) else false end,
         case when coalesce(n.preview, 'full') = 'none' then 'Dek' else 'Incoming call' end,
         case when coalesce(n.preview, 'full') = 'none' then 'Incoming call' else v_caller || ' is calling' end,
         '/o/' || k.org_id || '/call/' || k.id,
         'call:' || k.id,
         k.org_id, v_org, coalesce(n.preview, 'full'), 'high'
    from dek.call_participants cp
    join dek.profiles p on p.id = cp.user_id and p.deleted_at is null
    left join dek.notification_prefs n on n.user_id = cp.user_id
    join dek.push_devices d on d.user_id = cp.user_id and d.enabled and d.revoked_at is null
   where cp.call_id = k.id and cp.state = 'ringing'
     and cp.user_id is distinct from k.started_by
     and (i.target_user_id is null or cp.user_id = i.target_user_id)
     and not exists (select 1 from dek.user_blocks b where b.blocker_id = cp.user_id and b.blocked_id = k.started_by)
     and dek.can_read_channel(cp.user_id, k.channel_id)
     and not exists (select 1 from dek.notification_deliveries nd
                      where nd.intent_id = i.id and nd.device_id = d.id
                        and not dek.plat_retryable(nd.status, nd.http_status))
   order by cp.user_id, d.id
   limit 5000;
end $$;

create or replace function dek.plat_route_test(i dek.notification_intents)
returns table (r_user uuid, r_device uuid, r_quiet boolean, r_title text, r_body text, r_url text,
               r_tag text, r_org uuid, r_org_short text, r_preview text, r_urgency text)
language sql stable security definer set search_path = '' as $$
  select d.user_id, d.id, false,
         'Dek test notification', 'If you can see this, notifications work on this device.',
         '/settings/notifications', 'test', null::uuid, null::text,
         coalesce(n.preview, 'full'), 'normal'
    from dek.push_devices d
    join dek.profiles p on p.id = d.user_id and p.deleted_at is null
    left join dek.notification_prefs n on n.user_id = d.user_id
   where d.user_id = i.target_user_id and d.enabled and d.revoked_at is null
     and (i.target_device_id is null or d.id = i.target_device_id)
     and not exists (select 1 from dek.notification_deliveries nd
                      where nd.intent_id = i.id and nd.device_id = d.id
                        and not dek.plat_retryable(nd.status, nd.http_status))
   order by d.id
   limit 50
$$;

create or replace function dek.plat_route(i dek.notification_intents)
returns table (r_user uuid, r_device uuid, r_quiet boolean, r_title text, r_body text, r_url text,
               r_tag text, r_org uuid, r_org_short text, r_preview text, r_urgency text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if i.kind = 'message' then
    return query select * from dek.plat_route_message(i);
  elsif i.kind = 'call' then
    return query select * from dek.plat_route_call(i);
  elsif i.kind = 'test' then
    return query select * from dek.plat_route_test(i);
  end if;
end $$;

-- One dispatcher run owns an intent: row lock (skip locked), then 'processing' for
-- 2 minutes and one more attempt. Null when there is nothing to do: unknown, done,
-- failed, expired, or held by another run. An hour-old intent expires instead (a
-- notification an hour late is noise); a fifth failed attempt is the last.
create or replace function dek.plat_lock_intent(p_intent bigint)
returns dek.notification_intents language plpgsql security definer set search_path = '' as $$
declare i dek.notification_intents;
begin
  select * into i from dek.notification_intents x where x.id = p_intent for update skip locked;
  if not found or i.status in ('done', 'failed', 'expired')
     or (i.status = 'processing' and i.locked_until > now()) then
    return null;
  end if;
  if i.created_at < now() - interval '1 hour' or i.attempts >= 5 then
    update dek.notification_intents
       set status = case when i.attempts >= 5 then 'failed' else 'expired' end,
           processed_at = now(), locked_until = null,
           last_error = coalesce(last_error,
             case when i.attempts >= 5 then 'gave up after 5 attempts' else 'expired after 1 hour' end)
     where id = i.id;
    return null;
  end if;
  update dek.notification_intents
     set status = 'processing', locked_until = now() + interval '2 minutes', attempts = attempts + 1
   where id = i.id
  returning * into i;
  return i;
end $$;

-- =====================================================================
-- Service API (CONTRACT section 2.9; service_role only)
-- =====================================================================

-- Returns { intent, deliveries: [{ user_id, device: Device & { endpoint, p256dh,
-- auth }, title, body, url, tag, org_id, org_short_name, preview, urgency }],
-- skipped: [{ user_id, device_id, reason }] }. Quiet-hours skips are recorded here.
-- p_dry_run computes the same answer without locking or writing anything (tests,
-- push-dispatch {"dry_run": true}). An intent with nothing to send is marked done.
create or replace function api.svc_claim_intent(p_intent bigint, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dry     boolean := coalesce(p_dry_run, false);
  i         dek.notification_intents;
  v_out     jsonb;
  v_skipped jsonb;
begin
  if p_intent is null then
    perform dek.err('invalid_input', 'intent: required.');
  end if;
  if v_dry then
    select * into i from dek.notification_intents x where x.id = p_intent;
  else
    i := dek.plat_lock_intent(p_intent);
  end if;
  if i.id is null then
    return jsonb_build_object('intent', null, 'deliveries', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  with r as materialized (
    select * from dek.plat_route(i)
  ), quiet as (
    insert into dek.notification_deliveries (intent_id, user_id, device_id, kind, status, reason)
    select i.id, r.r_user, r.r_device, d.kind, 'skipped', 'quiet_hours'
      from r join dek.push_devices d on d.id = r.r_device
     where r.r_quiet and not v_dry
    on conflict (intent_id, device_id) where device_id is not null do nothing
    returning 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', r.r_user,
           'device', dek.plat_device_json(d)
                     || jsonb_build_object('endpoint', d.endpoint, 'p256dh', d.p256dh, 'auth', d.auth),
           'title', r.r_title, 'body', r.r_body, 'url', r.r_url, 'tag', r.r_tag,
           'org_id', r.r_org, 'org_short_name', r.r_org_short,
           'preview', r.r_preview, 'urgency', r.r_urgency)
           order by r.r_user, r.r_device) filter (where not r.r_quiet), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('user_id', r.r_user, 'device_id', r.r_device, 'reason', 'quiet_hours')
           order by r.r_user, r.r_device) filter (where r.r_quiet), '[]'::jsonb)
    into v_out, v_skipped
    from r join dek.push_devices d on d.id = r.r_device;
  if not v_dry and jsonb_array_length(v_out) = 0 then
    update dek.notification_intents
       set status = 'done', processed_at = now(), locked_until = null
     where id = i.id
    returning * into i;
  end if;
  return jsonb_build_object('intent', to_jsonb(i), 'deliveries', v_out, 'skipped', v_skipped);
end $$;

-- One row per result: [{ user_id, device_id, status, reason, http_status }].
-- A web push 404 or 410 or a VapidPkHashMismatch body, or an adapter's own
-- 'expired' verdict (FCM UNREGISTERED, APNs 410), revokes the device: the
-- subscription is gone and can never be signed for again. Other FCM and APNs
-- errors never revoke, because a wrong project, topic or environment answers for
-- every device at once and would take a whole platform down. Device counters move
-- (last_attempt_at, last_success_at, failure_count reset on success, last_status).
-- The intent is done, or back to pending when a retryable error happened and fewer
-- than 5 attempts were made (then failed).
create or replace function api.svc_record_deliveries(p_intent bigint, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  i       dek.notification_intents;
  v_n     int;
  v_dead  int;
  v_retry text;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    perform dek.err('invalid_input', 'results: must be a JSON array.');
  end if;
  select * into i from dek.notification_intents x where x.id = p_intent for update;
  if not found then
    perform dek.err('not_found', 'That notification intent does not exist.');
  end if;
  with raw as (
    select e.v, e.ord from jsonb_array_elements(p_results) with ordinality as e(v, ord) limit 10000
  ), res as (
    select distinct on (coalesce(d.id::text, 'row' || r.ord))
           coalesce(p.id, d.user_id) as user_id, d.id as device_id, d.kind,
           case when r.v ->> 'status' in ('sent', 'failed', 'skipped', 'expired', 'not_configured')
                then r.v ->> 'status' else 'failed' end as status,
           left(r.v ->> 'reason', 300) as reason,
           case when r.v ->> 'http_status' ~ '^[0-9]{1,3}$' then (r.v ->> 'http_status')::int end as http_status
      from raw r
      left join dek.push_devices d
        on d.id = case when r.v ->> 'device_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       then (r.v ->> 'device_id')::uuid end
      left join dek.profiles p
        on p.id = case when r.v ->> 'user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       then (r.v ->> 'user_id')::uuid end
     order by coalesce(d.id::text, 'row' || r.ord), r.ord desc
  ), judged as (
    select x.*, (x.status = 'expired'
                 or (x.kind = 'webpush' and (coalesce(x.http_status in (404, 410), false)
                                             or coalesce(x.reason, '') ilike '%VapidPkHashMismatch%'))) as dead
      from res x where x.user_id is not null
  ), ins as (
    insert into dek.notification_deliveries as nd (intent_id, user_id, device_id, kind, status, reason, http_status)
    select i.id, j.user_id, j.device_id, j.kind, case when j.dead then 'expired' else j.status end,
           j.reason, j.http_status
      from judged j
    on conflict (intent_id, device_id) where device_id is not null do update
      set status = excluded.status, reason = excluded.reason, http_status = excluded.http_status,
          created_at = now()
    returning 1
  ), upd as (
    update dek.push_devices d
       set last_attempt_at = now(),
           last_success_at = case when j.status = 'sent' then now() else d.last_success_at end,
           failure_count   = case when j.status = 'sent' then 0
                                  when j.dead or j.status = 'failed' then d.failure_count + 1
                                  else d.failure_count end,
           last_status     = left(case when j.dead then 'expired' else j.status end
                                  || coalesce(' ' || j.http_status, '') || coalesce(': ' || j.reason, ''), 200),
           enabled         = d.enabled and not j.dead,
           revoked_at      = case when j.dead then coalesce(d.revoked_at, now()) else d.revoked_at end
      from judged j
     where d.id = j.device_id and j.status <> 'skipped'
    returning j.dead
  )
  select (select count(*) from ins), (select count(*) from upd u where u.dead),
         (select string_agg(distinct coalesce(j.http_status::text, 'network') || coalesce(' ' || left(j.reason, 80), ''), '; ')
            from judged j where not j.dead and dek.plat_retryable(j.status, j.http_status))
    into v_n, v_dead, v_retry;
  update dek.notification_intents
     set status       = case when v_retry is null then 'done' when i.attempts < 5 then 'pending' else 'failed' end,
         locked_until = null,
         processed_at = case when v_retry is null or i.attempts >= 5 then now() end,
         last_error   = case when v_retry is null then null
                             else left(case when i.attempts < 5 then 'retrying: ' else 'gave up: ' end || v_retry, 500) end
   where id = i.id
  returning * into i;
  return jsonb_build_object('intent_id', i.id, 'status', i.status, 'attempts', i.attempts,
                            'recorded', v_n, 'revoked', v_dead);
end $$;
