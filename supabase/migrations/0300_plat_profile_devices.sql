-- 0300: profile, status, notification preferences, push devices. Owner: plat.
--
-- docs/CONTRACT.md section 2.6 (request_account_deletion lives in 0320). Every
-- function here acts on the caller's own rows, so the access rule is
-- dek.require_uid() plus "user_id = caller": somebody else's device is never
-- visible (not_found, or removed: 0).

-- "All my devices, newest first" for the health screen and the per-person caps. It
-- covers revoked devices too, which the foundation's partial index (active devices
-- only) cannot serve. NULLS LAST matches every query's order by.
drop index if exists dek.plat_push_devices_owner_idx;
create index if not exists plat_push_devices_owner_seen_idx on dek.push_devices (user_id, last_seen_at desc nulls last);

-- =====================================================================
-- Helpers (plat only)
-- =====================================================================

-- A time zone name the database understands. AT TIME ZONE inside an exception
-- block costs microseconds; pg_timezone_names parses the whole tz database on every
-- read (that view was 4% of all legacy database time).
create or replace function dek.plat_valid_tz(p_tz text)
returns boolean language plpgsql stable set search_path = '' as $$
begin
  if p_tz is null or p_tz !~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$' then
    return false;
  end if;
  perform now() at time zone p_tz;
  return true;
exception when others then
  return false;
end $$;

-- Refuses keys a patch may not carry, so a client typo fails loudly instead of
-- being ignored.
create or replace function dek.plat_patch_keys(p_patch jsonb, p_allowed text[], p_what text)
returns void language plpgsql stable set search_path = '' as $$
declare v_bad text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform dek.err('invalid_input', format('Send the %s fields to change as a JSON object.', p_what));
  end if;
  select k into v_bad from jsonb_object_keys(p_patch) k where k <> all (p_allowed) limit 1;
  if v_bad is not null then
    perform dek.err('invalid_input', format('%s: not a %s field that can be changed.', v_bad, p_what));
  end if;
end $$;

-- A patch value that must be a JSON string or null. Returns the trimmed text, null
-- for JSON null or blank text.
create or replace function dek.plat_patch_text(p_patch jsonb, p_key text)
returns text language plpgsql stable set search_path = '' as $$
declare v jsonb := p_patch -> p_key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform dek.err('invalid_input', format('%s: must be text.', p_key));
  end if;
  return nullif(btrim(v #>> '{}'), '');
end $$;

-- 'HH:MM' (24 hour) to a time; JSON null to null.
create or replace function dek.plat_patch_hhmm(p_patch jsonb, p_key text)
returns time language plpgsql stable set search_path = '' as $$
declare v text := dek.plat_patch_text(p_patch, p_key);
begin
  if v is null then
    return null;
  end if;
  if v !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    perform dek.err('invalid_input', format('%s: use 24 hour HH:MM, for example 22:30.', p_key));
  end if;
  return v::time;
end $$;

-- One of a fixed set of words.
create or replace function dek.plat_patch_enum(p_patch jsonb, p_key text, p_allowed text[])
returns text language plpgsql stable set search_path = '' as $$
declare v text := dek.plat_patch_text(p_patch, p_key);
begin
  if v is null or v <> all (p_allowed) then
    perform dek.err('invalid_input', format('%s: use one of %s.', p_key, array_to_string(p_allowed, ', ')));
  end if;
  return v;
end $$;

-- NotificationPrefs (CONTRACT section 1). Defaults when the row is missing (an
-- imported account, or one whose prefs were reset).
create or replace function dek.plat_prefs_json(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'default_level', coalesce(n.default_level, 'mentions'),
    'dm_level', coalesce(n.dm_level, 'all'),
    'thread_replies', coalesce(n.thread_replies, true),
    'quiet_start', to_char(n.quiet_start, 'HH24:MI'),
    'quiet_end', to_char(n.quiet_end, 'HH24:MI'),
    'quiet_tz', coalesce(n.quiet_tz, 'Asia/Kolkata'),
    'preview', coalesce(n.preview, 'full'))
    from (select p_uid as uid) u
    left join dek.notification_prefs n on n.user_id = u.uid
$$;

-- Device (CONTRACT section 1). Never the endpoint or keys: those are capability
-- secrets and only push-dispatch receives them.
create or replace function dek.plat_device_json(d dek.push_devices)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'label', d.label, 'platform', d.platform,
    'created_at', d.created_at, 'last_seen_at', d.last_seen_at,
    'last_attempt_at', d.last_attempt_at, 'last_success_at', d.last_success_at,
    'last_status', d.last_status, 'failure_count', d.failure_count,
    'enabled', d.enabled and d.revoked_at is null)
$$;

-- The caller's devices: active ones first, then by last seen; at most 50.
create or replace function dek.plat_devices_json(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(dek.plat_device_json(d)
           order by (d.enabled and d.revoked_at is null) desc, d.last_seen_at desc nulls last, d.created_at desc),
         '[]'::jsonb)
    from dek.push_devices d
   where d.id in (select x.id from dek.push_devices x where x.user_id = p_uid
                   order by x.last_seen_at desc nulls last limit 50)
$$;

-- Web Push endpoints push-dispatch may POST to: https on a known push service. The
-- list is what real Dek subscriptions use (legacy, 135 rows: FCM 111, Apple 14,
-- WNS 8, Mozilla 2) plus the old GCM host, so the dispatcher never sends to an
-- address somebody typed.
create or replace function dek.plat_push_endpoint_ok(p_endpoint text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_endpoint ~* ('^https://(fcm\.googleapis\.com|android\.googleapis\.com|web\.push\.apple\.com'
                                 '|[a-z0-9-]+\.notify\.windows\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com)/\S*$'),
                  false)
$$;

-- At most this many active devices per person: bounds the fanout of one message.
create or replace function dek.plat_max_devices()
returns int language sql immutable set search_path = '' as $$ select 10 $$;

-- At most this many retired (disabled or revoked) rows are kept per person, so
-- registering random endpoints in a loop cannot grow the table without bound.
create or replace function dek.plat_max_retired_devices()
returns int language sql immutable set search_path = '' as $$ select 20 $$;

-- Applies a profile patch to a row in memory (validation only; the caller writes).
create or replace function dek.plat_apply_profile_patch(p dek.profiles, p_patch jsonb)
returns dek.profiles language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if p_patch ? 'display_name' then
    v := dek.plat_patch_text(p_patch, 'display_name');
    if v is null or char_length(v) > 80 or v ~ '[[:cntrl:]]' then
      perform dek.err('invalid_input', 'display_name: use 1 to 80 characters on one line.');
    end if;
    p.display_name := v;
  end if;
  if p_patch ? 'handle' then
    v := nullif(lower(ltrim(dek.plat_patch_text(p_patch, 'handle'), '@')), '');
    if v is not null and v !~ '^[a-z0-9][a-z0-9._-]{1,30}$' then
      perform dek.err('invalid_input',
        'handle: 2 to 31 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.');
    end if;
    if v is not null and exists (select 1 from dek.profiles x where lower(x.handle) = v and x.id <> p.id) then
      perform dek.err('conflict', 'handle: that handle is already taken.');
    end if;
    p.handle := v;
  end if;
  if p_patch ? 'title' then
    v := dek.plat_patch_text(p_patch, 'title');
    if char_length(v) > 80 or v ~ '[[:cntrl:]]' then
      perform dek.err('invalid_input', 'title: at most 80 characters on one line.');
    end if;
    p.title := v;
  end if;
  if p_patch ? 'timezone' then
    v := dek.plat_patch_text(p_patch, 'timezone');
    if not dek.plat_valid_tz(v) then
      perform dek.err('invalid_input', 'timezone: use a time zone name such as Asia/Kolkata.');
    end if;
    p.timezone := v;
  end if;
  if p_patch ? 'avatar_path' then
    v := dek.plat_patch_text(p_patch, 'avatar_path');
    if v is not null and (v !~ ('^' || p.id::text || '/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$') or v like '%..%') then
      perform dek.err('invalid_input', 'avatar_path: upload the picture to your own folder of the avatars bucket.');
    end if;
    if v is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'avatars' and o.name = v) then
      perform dek.err('invalid_input', 'avatar_path: that picture has not been uploaded yet.');
    end if;
    p.avatar_path := v;
  end if;
  return p;
end $$;

-- =====================================================================
-- Profile and status
-- =====================================================================

create or replace function api.update_profile(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := dek.require_uid();
  p     dek.profiles;
begin
  perform dek.plat_patch_keys(p_patch, array['display_name', 'handle', 'title', 'timezone', 'avatar_path'], 'profile');
  select * into p from dek.profiles where id = v_uid for update;
  if not found then
    perform dek.err('not_found', 'Your profile does not exist yet. Sign out and sign in again.');
  end if;
  p := dek.plat_apply_profile_patch(p, p_patch);
  begin
    update dek.profiles
       set display_name = p.display_name, handle = p.handle, title = p.title,
           timezone = p.timezone, avatar_path = p.avatar_path, updated_at = now()
     where id = v_uid
    returning * into p;
  exception when unique_violation then
    perform dek.err('conflict', 'handle: that handle is already taken.');
  end;
  return dek.profile_json(p);
end $$;

create or replace function api.set_status(p_text text default null, p_emoji text default null,
                                          p_until timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := dek.require_uid();
  v_text  text := nullif(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), '');
  v_emoji text := nullif(btrim(coalesce(p_emoji, '')), '');
  p       dek.profiles;
begin
  if char_length(v_text) > 100 then
    perform dek.err('invalid_input', 'text: at most 100 characters.');
  end if;
  if char_length(v_emoji) > 64 then
    perform dek.err('invalid_input', 'emoji: one emoji or shortcode, at most 64 characters.');
  end if;
  if p_until is not null and p_until <= now() then
    perform dek.err('invalid_input', 'until: pick a time in the future.');
  end if;
  update dek.profiles
     set status_text = v_text, status_emoji = v_emoji,
         status_until = case when v_text is null and v_emoji is null then null else p_until end,
         updated_at = now()
   where id = v_uid
  returning * into p;
  if not found then
    perform dek.err('not_found', 'Your profile does not exist yet. Sign out and sign in again.');
  end if;
  return dek.profile_json(p);
end $$;

-- =====================================================================
-- Notification preferences
-- =====================================================================

create or replace function api.get_notification_prefs()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := dek.require_uid();
begin
  return dek.plat_prefs_json(v_uid);
end $$;

create or replace function api.set_notification_prefs(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := dek.require_uid();
  n     dek.notification_prefs;
begin
  perform dek.plat_patch_keys(p_patch, array['default_level', 'dm_level', 'thread_replies',
    'quiet_start', 'quiet_end', 'quiet_tz', 'preview'], 'notification preference');
  insert into dek.notification_prefs (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into n from dek.notification_prefs where user_id = v_uid for update;
  if p_patch ? 'default_level' then
    n.default_level := dek.plat_patch_enum(p_patch, 'default_level', array['all', 'mentions', 'none']);
  end if;
  if p_patch ? 'dm_level' then
    n.dm_level := dek.plat_patch_enum(p_patch, 'dm_level', array['all', 'none']);
  end if;
  if p_patch ? 'thread_replies' then
    if jsonb_typeof(p_patch -> 'thread_replies') <> 'boolean' then
      perform dek.err('invalid_input', 'thread_replies: must be true or false.');
    end if;
    n.thread_replies := (p_patch ->> 'thread_replies')::boolean;
  end if;
  if p_patch ? 'quiet_start' then n.quiet_start := dek.plat_patch_hhmm(p_patch, 'quiet_start'); end if;
  if p_patch ? 'quiet_end' then n.quiet_end := dek.plat_patch_hhmm(p_patch, 'quiet_end'); end if;
  if p_patch ? 'quiet_tz' then
    n.quiet_tz := dek.plat_patch_text(p_patch, 'quiet_tz');
    if not dek.plat_valid_tz(n.quiet_tz) then
      perform dek.err('invalid_input', 'quiet_tz: use a time zone name such as Asia/Kolkata.');
    end if;
  end if;
  if p_patch ? 'preview' then
    n.preview := dek.plat_patch_enum(p_patch, 'preview', array['full', 'name_only', 'none']);
  end if;
  if (n.quiet_start is null) <> (n.quiet_end is null) then
    perform dek.err('invalid_input', 'quiet hours: set both a start and an end, or neither.');
  end if;
  if n.quiet_start = n.quiet_end then
    perform dek.err('invalid_input', 'quiet hours: the start and the end must be different times.');
  end if;
  update dek.notification_prefs
     set default_level = n.default_level, dm_level = n.dm_level, thread_replies = n.thread_replies,
         quiet_start = n.quiet_start, quiet_end = n.quiet_end, quiet_tz = n.quiet_tz,
         preview = n.preview, updated_at = now()
   where user_id = v_uid;
  return dek.plat_prefs_json(v_uid);
end $$;

-- =====================================================================
-- Push devices (DEK15, DEK19)
-- =====================================================================

-- Validates a registration and returns the normalized endpoint.
create or replace function dek.plat_check_device(p_kind text, p_endpoint text, p_p256dh text, p_auth text)
returns text language plpgsql stable set search_path = '' as $$
declare v text := btrim(coalesce(p_endpoint, ''));
begin
  if p_kind is null or p_kind not in ('webpush', 'fcm', 'apns') then
    perform dek.err('invalid_input', 'kind: use webpush, fcm or apns.');
  end if;
  if char_length(v) not between 1 and 2000 then
    perform dek.err('invalid_input', 'endpoint: required, at most 2000 characters.');
  end if;
  if p_kind = 'webpush' then
    if not dek.plat_push_endpoint_ok(v) then
      perform dek.err('invalid_input', 'endpoint: not the address of a known push service.');
    end if;
    if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_+/-]{80,100}={0,2}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_+/-]{16,40}={0,2}$' then
      perform dek.err('invalid_input', 'keys: a web push subscription needs its p256dh and auth keys.');
    end if;
  elsif p_kind = 'fcm' and (char_length(v) < 20 or v !~ '^[A-Za-z0-9:_.-]+$') then
    perform dek.err('invalid_input', 'endpoint: not an FCM registration token.');
  elsif p_kind = 'apns' then
    if v !~ '^[0-9A-Fa-f]{64,200}$' then
      perform dek.err('invalid_input', 'endpoint: not an APNs device token.');
    end if;
    v := lower(v);
  end if;
  return v;
end $$;

-- Upsert by (kind, endpoint). The same subscription arriving from another account
-- (sign out, then sign in as somebody else on a shared phone) is re-owned, with its
-- delivery status reset, so the previous person's notifications stop at once.
create or replace function api.register_push_device(p_kind text, p_endpoint text, p_p256dh text default null,
                                                     p_auth text default null, p_label text default null,
                                                     p_platform text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := dek.require_uid();
  v_endpoint text := dek.plat_check_device(p_kind, p_endpoint, p_p256dh, p_auth);
  d          dek.push_devices;
begin
  insert into dek.push_devices as x (user_id, kind, endpoint, p256dh, auth, label, platform, last_seen_at)
  values (v_uid, p_kind, v_endpoint,
          case when p_kind = 'webpush' then btrim(p_p256dh) end,
          case when p_kind = 'webpush' then btrim(p_auth) end,
          nullif(left(btrim(coalesce(p_label, '')), 80), ''),
          nullif(left(btrim(coalesce(p_platform, '')), 40), ''),
          now())
  on conflict (kind, endpoint) do update set
    user_id         = excluded.user_id,
    p256dh          = excluded.p256dh,
    auth            = excluded.auth,
    label           = coalesce(excluded.label, case when x.user_id = excluded.user_id then x.label end),
    platform        = coalesce(excluded.platform, case when x.user_id = excluded.user_id then x.platform end),
    last_seen_at    = now(),
    created_at      = case when x.user_id = excluded.user_id then x.created_at else now() end,
    last_attempt_at = case when x.user_id = excluded.user_id then x.last_attempt_at end,
    last_success_at = case when x.user_id = excluded.user_id then x.last_success_at end,
    last_status     = case when x.user_id = excluded.user_id and x.revoked_at is null then x.last_status end,
    failure_count   = case when x.user_id = excluded.user_id and x.revoked_at is null then x.failure_count else 0 end,
    enabled         = true,
    revoked_at      = null
  returning * into d;
  -- Bound the fanout: beyond the cap, the least recently seen devices are retired.
  update dek.push_devices
     set enabled = false, revoked_at = now(), last_status = 'replaced by a newer device'
   where id in (select y.id from dek.push_devices y
                 where y.user_id = v_uid and y.enabled and y.revoked_at is null
                 order by y.last_seen_at desc nulls last, y.created_at desc
                 offset dek.plat_max_devices());
  -- Bound the table: beyond the cap, the oldest retired rows go.
  delete from dek.push_devices
   where id in (select y.id from dek.push_devices y
                 where y.user_id = v_uid and (not y.enabled or y.revoked_at is not null)
                 order by y.last_seen_at desc nulls last, y.created_at desc
                 offset dek.plat_max_retired_devices());
  return dek.plat_device_json(d);
end $$;

-- Called at sign-out (DEK15): by id, or by endpoint when the client only knows its
-- subscription. Only the caller's own devices; anything else counts as 0.
create or replace function api.unregister_push_device(p_device uuid default null, p_endpoint text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := dek.require_uid();
  v_endpoint text := nullif(btrim(coalesce(p_endpoint, '')), '');
  v_n        int;
begin
  if p_device is null and v_endpoint is null then
    perform dek.err('invalid_input', 'Pass the device id or its endpoint.');
  end if;
  delete from dek.push_devices d
   where d.user_id = v_uid
     and ((p_device is not null and d.id = p_device)
          or (v_endpoint is not null and d.kind in ('webpush', 'fcm', 'apns')
              and d.endpoint in (v_endpoint, lower(v_endpoint))));
  get diagnostics v_n = row_count;
  return jsonb_build_object('removed', v_n);
end $$;

create or replace function api.list_my_devices()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := dek.require_uid();
begin
  return dek.plat_devices_json(v_uid);
end $$;

-- DEK19: a user initiated test. Rate limit 5 per 10 minutes.
create or replace function api.send_test_notification(p_device uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := dek.require_uid();
  d     dek.push_devices;
begin
  perform dek.rate_hit(v_uid, 'push_test', 5, 600);
  if p_device is not null then
    select * into d from dek.push_devices x where x.id = p_device and x.user_id = v_uid;
    if not found then
      perform dek.err('not_found', 'That device does not exist.');
    end if;
    if not d.enabled or d.revoked_at is not null then
      perform dek.err('conflict', 'Notifications are off on that device. Turn them on there again first.');
    end if;
  elsif not exists (select 1 from dek.push_devices x where x.user_id = v_uid and x.enabled and x.revoked_at is null) then
    perform dek.err('conflict', 'None of your devices has notifications turned on yet.');
  end if;
  return jsonb_build_object('intent_id',
    dek.enqueue_intent('test', null, p_actor => v_uid, p_target_user => v_uid, p_target_device => p_device));
end $$;

-- DEK19: devices and the caller's last 20 delivery attempts.
create or replace function api.notification_health()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := dek.require_uid();
begin
  return jsonb_build_object(
    'devices', dek.plat_devices_json(v_uid),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('created_at', x.created_at, 'status', x.status, 'reason', x.reason,
                                          'device_id', x.device_id, 'kind', x.kind)
                       order by x.created_at desc, x.id desc)
        from (select * from dek.notification_deliveries nd where nd.user_id = v_uid
               order by nd.created_at desc, nd.id desc limit 20) x), '[]'::jsonb));
end $$;
