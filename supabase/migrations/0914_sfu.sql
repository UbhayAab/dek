-- 0914: group calls through the Cloudflare Realtime SFU. Owner: lead.
-- docs/CONTRACT.md section 1 (Call), 2.8, 2.9, 3 (call.upd) and 5 (the sfu Edge Function);
-- docs/ARCHITECTURE.md section 9 (D18).
--
-- In a mesh every phone uploads its microphone (and camera, and screen) once per other
-- person: N - 1 copies. Through an SFU each person uploads once and Cloudflare forwards.
-- The sfu Edge Function holds the Cloudflare credentials and talks to Cloudflare; this
-- file is the database side of it:
--
--   1. dek.calls.sfu, stamped when a call opens: dek.settings sfu_enabled = 'true', or
--      the organization's slug listed in sfu_orgs (comma separated, for trying it on
--      one organization first). A call goes through the SFU while it is stamped, the
--      switch is still on for its organization, and it is a group call: a room, or a
--      direct call with 3 or more participants. A 1:1 call never does. Call.sfu in the
--      JSON is that answer, so every participant follows the same rule, and turning the
--      switch off moves a live SFU call back to the mesh at its next call.upd. Turning it
--      on only affects calls that open afterwards.
--   2. dek.call_participants.sfu_session and sfu_tracks: each joined person's SFU session
--      and the tracks it publishes (mic-N, cam-N, screen-N). Only the sfu function writes
--      them, from Cloudflare's own answers, so nobody can point the others at a session
--      that is not theirs. Cleared when the person stops being joined or moves to a new
--      session (dek.sfu_reset_participant).
--   3. dek.calls.rev, bumped by every call.upd (dek.media_emit_call, and dek.sfu_emit_call
--      for SFU-only changes, which go to the call's joined people only) and exposed as
--      Call.version: call.upd reaches a client on more than one topic (u: and, for rooms,
--      the channel's audience), and the SFU path acts on track lists, so the client must
--      be able to keep the newest copy (sync/reducers.ts isOlderCall reads `version`).
--   4. api.svc_sfu_gate and api.svc_sfu_publish, the sfu function's only way in, and
--      dek.sfu_revoke, the database's way back to it: Cloudflare keeps forwarding to a
--      session until it is told otherwise, so a session whose person left (or that was
--      replaced) has its tracks stopped there.

-- =====================================================================
-- 1. Columns and settings
-- =====================================================================

alter table dek.calls add column if not exists sfu boolean not null default false;
alter table dek.calls add column if not exists rev bigint not null default 0;
alter table dek.call_participants add column if not exists sfu_session text
  check (sfu_session is null or sfu_session ~ '^[A-Za-z0-9_-]{8,64}$');
alter table dek.call_participants add column if not exists sfu_tracks text[] not null default '{}'
  check (cardinality(sfu_tracks) <= 6);
-- The client's number for the connection that recorded sfu_session (it only grows in one
-- page): a setup still on its way from a replaced connection cannot overwrite a newer one.
alter table dek.call_participants add column if not exists sfu_epoch bigint not null default 0;

-- Off until the lead turns it on; the synthetic QA organization (tools/seed-qa.mjs) is
-- listed so the end-to-end test can prove the path on production before anyone else
-- uses it. Existing values are never overwritten.
insert into dek.settings (key, value) values ('sfu_enabled', 'false'), ('sfu_orgs', 'dek-qa')
on conflict (key) do nothing;

-- =====================================================================
-- 2. Private helpers
-- =====================================================================

-- Whether calls of this organization may use the SFU right now.
create or replace function dek.sfu_allowed(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value = 'true' from dek.settings s where s.key = 'sfu_enabled'), false)
      or exists (select 1
                   from dek.settings s
                   join dek.orgs o on o.id = p_org
                  where s.key = 'sfu_orgs'
                    and o.slug = any (string_to_array(regexp_replace(s.value, '\s+', '', 'g'), ',')))
$$;

-- The one rule: does this call go through the SFU now. p_count is its number of
-- participant rows (a direct call's are all created with it, so the count is fixed).
create or replace function dek.sfu_live(c dek.calls, p_count int)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when c.sfu and c.ended_at is null and (c.kind = 'room' or p_count >= 3)
              then dek.sfu_allowed(c.org_id) else false end
$$;

create or replace function dek.sfu_stamp_call()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.sfu := dek.sfu_allowed(new.org_id);
  return new;
end $$;

drop trigger if exists dek_sfu_stamp on dek.calls;
create trigger dek_sfu_stamp before insert on dek.calls
  for each row execute function dek.sfu_stamp_call();

-- Cloudflare forwards what a session pulled for as long as that session stays connected;
-- it knows nothing about who is still in Dek's call. So when someone stops being in the
-- call (left, reaped, moved to a new session) or replaces their SFU session, the sfu
-- function is asked to stop every track of the old one (action 'revoke', header
-- x-dek-internal, queued like push-dispatch and sent only after this transaction
-- commits): a client that leaves but keeps its connection open hears nothing more.
-- Someone removed from the organization stops heartbeating (call_heartbeat checks
-- access), so the reaper marks them left within about two minutes, which revokes too.
create or replace function dek.sfu_revoke(p_sfu_session text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  if p_sfu_session is null then
    return;
  end if;
  select s.value into v_url from dek.settings s where s.key = 'functions_url';
  select d.decrypted_secret into v_secret from vault.decrypted_secrets d where d.name = 'dek_internal_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/sfu',
    body := jsonb_build_object('action', 'revoke', 'sfu_session', p_sfu_session),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dek-internal', v_secret),
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'dek.sfu_revoke failed: %', sqlerrm;
end $$;

-- Someone who is no longer joined, or joined again with a new session (a reload, another
-- device), publishes nothing until the sfu function records a new SFU session for them,
-- and the old session's tracks are stopped at Cloudflare.
create or replace function dek.sfu_reset_participant()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.state is distinct from 'joined' or new.session_id is distinct from old.session_id)
     and (new.sfu_session is not null or cardinality(new.sfu_tracks) > 0 or new.sfu_epoch <> 0) then
    perform dek.sfu_revoke(old.sfu_session);
    new.sfu_session := null;
    new.sfu_tracks := '{}';
    new.sfu_epoch := 0;
  end if;
  return new;
end $$;

drop trigger if exists dek_sfu_reset on dek.call_participants;
create trigger dek_sfu_reset before update of state, session_id on dek.call_participants
  for each row execute function dek.sfu_reset_participant();

-- The Call shape (CONTRACT 1) gains version, sfu, and each participant's sfu_session and
-- sfu_tracks. Replaces the 0001 definition; everything else is unchanged.
create or replace function dek.call_json(c dek.calls)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'org_id', c.org_id, 'channel_id', c.channel_id, 'kind', c.kind, 'media', c.media,
    'started_by', c.started_by, 'created_at', c.created_at, 'ended_at', c.ended_at, 'end_reason', c.end_reason,
    'version', c.rev,
    'sfu', dek.sfu_live(c, x.n),
    'participants', coalesce(x.parts, '[]'::jsonb))
    from (select count(*)::int as n,
                 jsonb_agg(jsonb_build_object(
                   'user_id', p.user_id, 'state', p.state, 'session_id', p.session_id, 'joined_at', p.joined_at,
                   'sfu_session', p.sfu_session, 'sfu_tracks', to_jsonb(p.sfu_tracks))
                   order by p.joined_at nulls last, p.user_id) as parts
            from dek.call_participants p
           where p.call_id = c.id) x
$$;

-- Replaces the 0410 definition: the same events, now each with a new version. Every
-- caller holds the call's row lock (FOR UPDATE), so versions follow commit order.
create or replace function dek.media_emit_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v      dek.calls;
  v_json jsonb;
begin
  update dek.calls set rev = rev + 1 where id = p_call returning * into v;
  if not found then
    return null;
  end if;
  v_json := dek.call_json(v);
  perform dek.emit_many(
    array['call:' || v.id::text]
      || array(select 'u:' || p.user_id::text from dek.call_participants p where p.call_id = v.id),
    'call.upd', jsonb_build_object('call', v_json));
  if v.kind = 'room' then
    perform dek.emit_channel(v.channel_id, 'call.upd', jsonb_build_object('call', v_json));
  end if;
  return v_json;
end $$;

-- What someone publishes through the SFU matters only to the people in the call: a new
-- version to the call's joined people, not to a room's whole server audience (which
-- dek.media_emit_call informs about joins and leaves). The caller holds the row lock.
create or replace function dek.sfu_emit_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v      dek.calls;
  v_json jsonb;
begin
  update dek.calls set rev = rev + 1 where id = p_call returning * into v;
  if not found then
    return null;
  end if;
  v_json := dek.call_json(v);
  perform dek.emit_many(
    array['call:' || v.id::text]
      || array(select 'u:' || p.user_id::text from dek.call_participants p
                where p.call_id = v.id and p.state = 'joined'),
    'call.upd', jsonb_build_object('call', v_json));
  return v_json;
end $$;

-- =====================================================================
-- 3. Service functions (service_role only, called by the sfu Edge Function)
-- =====================================================================

-- Every sfu action passes here first. The caller must be a joined participant of an
-- active call that goes through the SFU, with this Dek session id, and still able to
-- read the call's channel. Strangers and other tenants get not_found; someone who left,
-- was replaced by another session, or whose call is over or not an SFU call gets
-- conflict. Rate limits: 120 actions a minute, 20 new SFU sessions per 10 minutes.
-- For 'pull', p_wanted is [{ session, name }] (at most 64) and `allowed` is the part of
-- it that another joined person of this call publishes now.
drop function if exists api.svc_sfu_gate(uuid, uuid, uuid, text, jsonb);
create or replace function api.svc_sfu_gate(p_user uuid, p_call uuid, p_session uuid, p_action text,
                                            p_wanted jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v       dek.calls;
  p       dek.call_participants;
  v_n     int;
  v_ok    jsonb := '[]'::jsonb;
begin
  if p_user is null or p_call is null or p_session is null then
    perform dek.err('invalid_input', 'call_id and session_id are required.');
  end if;
  if p_action is null or p_action not in ('session', 'push', 'pull', 'renegotiate', 'close') then
    perform dek.err('invalid_input', 'action: session, push, pull, renegotiate or close.');
  end if;
  if p_wanted is not null
     and (jsonb_typeof(p_wanted) <> 'array' or jsonb_array_length(p_wanted) > 64) then
    perform dek.err('invalid_input', 'tracks: at most 64.');
  end if;
  select * into v from dek.calls where id = p_call;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  select * into p from dek.call_participants where call_id = v.id and user_id = p_user;
  if not found
     or exists (select 1 from dek.profiles x where x.id = p_user and x.deleted_at is not null)
     or not dek.can_read_channel(p_user, v.channel_id) then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  if v.ended_at is not null then
    perform dek.err('conflict', 'This call has ended.');
  end if;
  if p.state <> 'joined' or p.session_id is distinct from p_session then
    perform dek.err('conflict', 'You are no longer in this call.');
  end if;
  select count(*) into v_n from dek.call_participants x where x.call_id = v.id;
  if not dek.sfu_live(v, v_n) then
    perform dek.err('conflict', 'This call does not go through the media server.');
  end if;
  perform dek.rate_hit(p_user, 'sfu', 120, 60);
  if p_action = 'session' then
    perform dek.rate_hit(p_user, 'sfu_session', 20, 600);
  end if;
  if p_action = 'pull' and p_wanted is not null then
    select coalesce(jsonb_agg(jsonb_build_object('session', w.session, 'name', w.name) order by w.session, w.name), '[]'::jsonb)
      into v_ok
      from (select distinct e ->> 'session' as session, e ->> 'name' as name
              from jsonb_array_elements(p_wanted) e
             where jsonb_typeof(e) = 'object') w
     where w.session is not null and w.name is not null
       and exists (select 1 from dek.call_participants o
                    where o.call_id = v.id and o.user_id <> p_user and o.state = 'joined'
                      and o.sfu_session = w.session and w.name = any (o.sfu_tracks));
  end if;
  return jsonb_build_object('sfu_session', p.sfu_session, 'sfu_tracks', to_jsonb(p.sfu_tracks), 'allowed', v_ok);
end $$;

-- After the function created an SFU session, or pushed or closed tracks on it, at
-- Cloudflare: record the caller's session and published tracks and tell the people in
-- the call (call.upd, dek.sfu_emit_call). p_new_session replaces the session and its
-- tracks, if p_epoch (the client connection's number) is newer than the recorded one;
-- otherwise p_sfu_session must be the recorded one, and p_add / p_remove change its
-- tracks. Names are mic-N, cam-N or screen-N, at most 6 at a time. Nothing changed, no
-- event.
drop function if exists api.svc_sfu_publish(uuid, uuid, uuid, text, text[], text[], boolean);
drop function if exists api.svc_sfu_publish(uuid, uuid, uuid, text, text[], text[], boolean, bigint);
create or replace function api.svc_sfu_publish(p_user uuid, p_call uuid, p_session uuid, p_sfu_session text,
                                               p_add text[] default '{}', p_remove text[] default '{}',
                                               p_new_session boolean default false, p_epoch bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v      dek.calls;
  p      dek.call_participants;
  v_name text;
  v_next text[];
begin
  if p_user is null or p_call is null or p_session is null then
    perform dek.err('invalid_input', 'call_id and session_id are required.');
  end if;
  if p_sfu_session is null or p_sfu_session !~ '^[A-Za-z0-9_-]{8,64}$' then
    perform dek.err('invalid_input', 'sfu_session: required.');
  end if;
  if cardinality(coalesce(p_add, '{}')) + cardinality(coalesce(p_remove, '{}')) > 12 then
    perform dek.err('invalid_input', 'tracks: too many.');
  end if;
  foreach v_name in array coalesce(p_add, '{}') || coalesce(p_remove, '{}') loop
    if v_name is null or v_name !~ '^(mic|cam|screen)-[a-z0-9]{1,16}$' then
      perform dek.err('invalid_input', 'tracks: names are mic-N, cam-N or screen-N.');
    end if;
  end loop;
  select * into v from dek.calls where id = p_call for update;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  select * into p from dek.call_participants where call_id = v.id and user_id = p_user for update;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  if v.ended_at is not null or p.state <> 'joined' or p.session_id is distinct from p_session then
    perform dek.err('conflict', 'You are no longer in this call.');
  end if;
  if not coalesce(p_new_session, false) and p.sfu_session is distinct from p_sfu_session then
    perform dek.err('conflict', 'That media session was replaced.');
  end if;
  if coalesce(p_new_session, false) and p_epoch is not null and p_epoch <= p.sfu_epoch then
    perform dek.err('conflict', 'A newer media session is already recorded.');
  end if;
  v_next := array(
    select distinct t
      from unnest(case when coalesce(p_new_session, false) then '{}'::text[] else p.sfu_tracks end
                  || coalesce(p_add, '{}')) t
     where t <> all (coalesce(p_remove, '{}'))
     order by t);
  if cardinality(v_next) > 6 then
    perform dek.err('invalid_input', 'tracks: at most 6 at a time.');
  end if;
  if p.sfu_session is not distinct from p_sfu_session and p.sfu_tracks = v_next then
    return dek.call_json(v);
  end if;
  if p.sfu_session is not null and p.sfu_session <> p_sfu_session then
    perform dek.sfu_revoke(p.sfu_session);   -- the session it replaces hears nothing more
  end if;
  update dek.call_participants
     set sfu_session = p_sfu_session, sfu_tracks = v_next, updated_at = now(),
         sfu_epoch = case when coalesce(p_new_session, false) and p_epoch is not null then p_epoch else sfu_epoch end
   where call_id = v.id and user_id = p_user;
  return dek.sfu_emit_call(v.id);
end $$;
