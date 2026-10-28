-- 0410: calls. Owner: [media]. docs/CONTRACT.md section 2.8 (functions) and section 3
-- (call.ring, call.upd), docs/ARCHITECTURE.md section 9, PRD DEK21 to DEK24, DEKA12, DEKA13.
--
-- The database is the single writer of call state. Media never touches Supabase and
-- neither does signaling: clients broadcast `signal` on call:<id>, which
-- dek.can_use_topic authorizes for participants and room channel readers.
--
--   direct call (dm, group_dm): the caller is joined at once with a server-made
--     session id, everyone else rings (call.ring on their u: topic plus one 'call'
--     notification intent). It ends when nobody can talk to anybody any more: no one
--     ringing and at most one person joined. The DM gets one system line: "Missed
--     call", "Call declined", or "Voice call, N min" / "Video call, N min".
--   room (audio channel): people join and leave, at most 8 joined (a WebRTC mesh); a
--     reconnect with a new session id updates the same participant row (DEKA13). It
--     ends when the last person leaves.
--
-- Every change takes the calls row lock first, so concurrent answers, declines, leaves
-- and the reaper see one order, and emits call.upd in the same transaction.

create index if not exists media_calls_active_org_idx on dek.calls (org_id) where ended_at is null;

-- =====================================================================
-- 1. Private helpers
-- =====================================================================

-- call.upd to call:<id> and every participant's u: topic; rooms also go to the
-- channel's audience (s:<server> for a public audio channel) so a sidebar can show
-- who is in a room without polling active_calls. Returns the Call shape.
create or replace function dek.media_emit_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v      dek.calls;
  v_json jsonb;
begin
  select * into v from dek.calls where id = p_call;
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

-- The end rule, applied after every participant change. The caller holds the calls
-- row lock. Rooms end when nobody is joined. Direct calls: when nobody is joined the
-- phones stop ringing (missed); the call ends once nobody rings and at most one
-- person is still joined.
create or replace function dek.media_settle_call(p_call uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v          dek.calls;
  v_joined   int;
  v_ringing  int;
  v_answered boolean;
  v_missed   boolean;
  v_declined boolean;
  v_reason   text;
  v_secs     int;
  v_body     text;
begin
  select * into v from dek.calls where id = p_call;
  if not found or v.ended_at is not null then
    return;
  end if;
  select count(*) filter (where p.state = 'joined'),
         count(*) filter (where p.state = 'ringing'),
         coalesce(bool_or(p.joined_at is not null and p.user_id is distinct from v.started_by), false),
         coalesce(bool_or(p.state = 'missed'), false),
         coalesce(bool_or(p.state = 'declined'), false)
    into v_joined, v_ringing, v_answered, v_missed, v_declined
    from dek.call_participants p
   where p.call_id = v.id;

  if v.kind = 'room' then
    if v_joined > 0 then
      return;
    end if;
    v_reason := 'completed';
  else
    if v_joined = 0 and v_ringing > 0 then
      update dek.call_participants set state = 'missed', updated_at = now()
       where call_id = v.id and state = 'ringing';
      v_ringing := 0;
      v_missed := true;
    end if;
    if v_ringing > 0 or v_joined > 1 then
      return;
    end if;
    v_reason := case when v_answered then 'completed'
                     when v_missed then 'missed'
                     when v_declined then 'declined'
                     else 'missed' end;
  end if;

  update dek.call_participants set state = 'left', left_at = now(), updated_at = now()
   where call_id = v.id and state = 'joined';
  update dek.calls set ended_at = now(), end_reason = v_reason where id = v.id
  returning * into v;

  if v.kind = 'direct' then
    if v_reason = 'completed' then
      -- Talk time: from the first answer to the end.
      select greatest(0, extract(epoch from (v.ended_at - min(p.joined_at))))::int into v_secs
        from dek.call_participants p
       where p.call_id = v.id and p.user_id is distinct from v.started_by and p.joined_at is not null;
      v_body := format('%s call, %s min', case when v.media = 'video' then 'Video' else 'Voice' end,
                       greatest(1, round(coalesce(v_secs, 0) / 60.0)::int));
    elsif v_reason = 'declined' then
      v_body := 'Call declined';
    else
      v_body := 'Missed call';
    end if;
    perform dek.post_system(v.channel_id, v_body, jsonb_build_object(
      'event', 'call', 'call_id', v.id, 'media', v.media, 'end_reason', v_reason, 'duration_s', v_secs));
  end if;
end $$;

-- Join (or rejoin) the active room of an audio channel, opening it when there is
-- none. The calls row lock serializes joins, so the cap of 8 cannot be overrun by two
-- people arriving at once.
create or replace function dek.media_join_room(p_uid uuid, c dek.channels, p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v       dek.calls;
  p       dek.call_participants;
  v_count int;
begin
  if c.kind <> 'audio' then
    perform dek.err('invalid_input', 'p_channel: rooms are only in audio channels.');
  end if;
  if p_session is null then
    perform dek.err('invalid_input', 'p_session_id: required.');
  end if;
  select * into v from dek.calls where channel_id = c.id and ended_at is null for update;
  if not found then
    insert into dek.calls (org_id, channel_id, kind, media, started_by)
    values (c.org_id, c.id, 'room', 'audio', p_uid)
    on conflict (channel_id) where ended_at is null do nothing
    returning * into v;
    if v.id is null then
      -- Someone opened it a moment earlier; the insert waited for them.
      select * into v from dek.calls where channel_id = c.id and ended_at is null for update;
    end if;
  end if;

  select * into p from dek.call_participants where call_id = v.id and user_id = p_uid for update;
  if found and p.state = 'joined' then
    if p.session_id is not distinct from p_session then
      update dek.call_participants set last_heartbeat_at = now() where call_id = v.id and user_id = p_uid;
      return dek.call_json(v);
    end if;
    -- A reconnect from a new tab or after a reload: same row, new session (DEKA13).
    update dek.call_participants
       set session_id = p_session, last_heartbeat_at = now(), updated_at = now()
     where call_id = v.id and user_id = p_uid;
    return dek.media_emit_call(v.id);
  end if;

  select count(*) into v_count
    from (select 1 from dek.call_participants x where x.call_id = v.id and x.state = 'joined' limit 8) j;
  if v_count >= 8 then
    perform dek.err('conflict', 'This room is full (8 people). Try again when someone leaves.');
  end if;
  insert into dek.call_participants as cp (call_id, user_id, session_id, state, joined_at, last_heartbeat_at)
  values (v.id, p_uid, p_session, 'joined', now(), now())
  on conflict (call_id, user_id) do update
     set state = 'joined', session_id = excluded.session_id, joined_at = excluded.joined_at,
         left_at = null, last_heartbeat_at = excluded.last_heartbeat_at, updated_at = now();
  return dek.media_emit_call(v.id);
end $$;

-- =====================================================================
-- 2. api functions (CONTRACT 2.8)
-- =====================================================================

drop function if exists api.start_call(uuid, text);
create or replace function api.start_call(p_channel uuid, p_media text default 'audio')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid;
  c         dek.channels;
  v         dek.calls;
  v_media   text := lower(btrim(coalesce(p_media, 'audio')));
  v_callees uuid[];
begin
  v_uid := dek.require_uid();
  if v_media not in ('audio', 'video') then
    perform dek.err('invalid_input', 'p_media: audio or video.');
  end if;
  c := dek.assert_post(v_uid, p_channel);
  if c.kind = 'text' then
    perform dek.err('invalid_input', 'p_channel: calls happen in audio channels and direct messages.');
  end if;
  perform dek.rate_hit(v_uid, 'start_call', 30, 600);
  if c.kind = 'audio' then
    return dek.media_join_room(v_uid, c, gen_random_uuid());
  end if;

  -- One active call per conversation: pressing call again (or both people pressing
  -- it) returns the call that is already there.
  select * into v from dek.calls where channel_id = c.id and ended_at is null for update;
  if found then
    return dek.call_json(v);
  end if;

  v_callees := array(
    select cm.user_id
      from dek.channel_members cm
     where cm.channel_id = c.id and cm.user_id <> v_uid
       and dek.org_role(cm.user_id, c.org_id) is not null
       and not exists (select 1 from dek.user_blocks b
                        where (b.blocker_id = cm.user_id and b.blocked_id = v_uid)
                           or (b.blocker_id = v_uid and b.blocked_id = cm.user_id))
     order by cm.joined_at, cm.user_id);
  if cardinality(v_callees) = 0 then
    perform dek.err('forbidden', 'Nobody in this conversation can take a call right now.');
  end if;

  insert into dek.calls (org_id, channel_id, kind, media, started_by)
  values (c.org_id, c.id, 'direct', v_media, v_uid)
  on conflict (channel_id) where ended_at is null do nothing
  returning * into v;
  if v.id is null then
    select * into v from dek.calls where channel_id = c.id and ended_at is null;
    return dek.call_json(v);
  end if;

  insert into dek.call_participants (call_id, user_id, session_id, state, joined_at, last_heartbeat_at)
  values (v.id, v_uid, gen_random_uuid(), 'joined', now(), now());
  insert into dek.call_participants (call_id, user_id, state)
  select v.id, u, 'ringing' from unnest(v_callees) u;
  -- A call brings a hidden conversation back to the sidebar, like a message does.
  update dek.channel_members set hidden = false where channel_id = c.id and hidden;

  perform dek.emit_users(v_callees, 'call.ring', jsonb_build_object('call', dek.call_json(v), 'from', v_uid));
  perform dek.enqueue_intent('call', c.org_id, p_channel => c.id, p_call => v.id, p_actor => v_uid);
  return dek.media_emit_call(v.id);
end $$;

-- Answer a ringing call. Also re-attaches someone who is already joined (a new
-- session after a reload or from another device), and lets someone who left or
-- declined come back while the call is still going. Rooms go through join_room.
drop function if exists api.answer_call(uuid, uuid);
create or replace function api.answer_call(p_call uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v     dek.calls;
  p     dek.call_participants;
begin
  v_uid := dek.require_uid();
  if p_session_id is null then
    perform dek.err('invalid_input', 'p_session_id: required.');
  end if;
  -- Every new session is a call.upd to everyone in the call (and a room's server).
  perform dek.rate_hit(v_uid, 'answer_call', 60, 60);
  select * into v from dek.calls where id = p_call for update;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  select * into p from dek.call_participants where call_id = v.id and user_id = v_uid for update;
  if not found and v.kind = 'direct' then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  perform dek.assert_read(v_uid, v.channel_id);
  if v.ended_at is not null then
    perform dek.err('conflict', 'This call has ended.');
  end if;
  if v.kind = 'room' then
    return dek.media_join_room(v_uid, dek.assert_post(v_uid, v.channel_id), p_session_id);
  end if;
  if p.state = 'joined' and p.session_id is not distinct from p_session_id then
    return dek.call_json(v);
  end if;
  update dek.call_participants
     set state = 'joined', session_id = p_session_id, joined_at = coalesce(joined_at, now()),
         left_at = null, last_heartbeat_at = now(), updated_at = now()
   where call_id = v.id and user_id = v_uid;
  return dek.media_emit_call(v.id);
end $$;

drop function if exists api.decline_call(uuid);
create or replace function api.decline_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v     dek.calls;
  p     dek.call_participants;
begin
  v_uid := dek.require_uid();
  select * into v from dek.calls where id = p_call for update;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  select * into p from dek.call_participants where call_id = v.id and user_id = v_uid for update;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  perform dek.assert_read(v_uid, v.channel_id);
  if v.ended_at is null and p.state = 'joined' then
    perform dek.err('conflict', 'You are in this call. Leave it instead.');
  end if;
  if v.ended_at is not null or p.state <> 'ringing' then
    return dek.call_json(v);   -- already over for this person
  end if;
  update dek.call_participants set state = 'declined', updated_at = now()
   where call_id = v.id and user_id = v_uid;
  perform dek.media_settle_call(v.id);
  return dek.media_emit_call(v.id);
end $$;

drop function if exists api.join_room(uuid, uuid);
create or replace function api.join_room(p_channel uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  if p_session_id is null then
    perform dek.err('invalid_input', 'p_session_id: required.');
  end if;
  c := dek.assert_post(v_uid, p_channel);
  if c.kind <> 'audio' then
    perform dek.err('invalid_input', 'p_channel: rooms are only in audio channels.');
  end if;
  perform dek.rate_hit(v_uid, 'join_room', 60, 60);
  return dek.media_join_room(v_uid, c, p_session_id);
end $$;

drop function if exists api.leave_call(uuid);
create or replace function api.leave_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v     dek.calls;
  p     dek.call_participants;
begin
  v_uid := dek.require_uid();
  select * into v from dek.calls where id = p_call for update;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  select * into p from dek.call_participants where call_id = v.id and user_id = v_uid for update;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  -- Leaving only reduces access, so it needs no channel check; it does need an active
  -- membership. A member suspended mid-call is reaped by the heartbeat rule instead.
  perform dek.require_org(v_uid, v.org_id);
  if v.ended_at is not null or p.state not in ('joined', 'ringing') then
    return dek.call_json(v);   -- ending is idempotent
  end if;
  if p.state = 'ringing' then
    update dek.call_participants set state = 'declined', updated_at = now()
     where call_id = v.id and user_id = v_uid;
  else
    update dek.call_participants set state = 'left', left_at = now(), updated_at = now()
     where call_id = v.id and user_id = v_uid;
  end if;
  perform dek.media_settle_call(v.id);
  return dek.media_emit_call(v.id);
end $$;

-- Every 30 s while joined. No call row lock and no event: it only proves the session
-- is alive. A session that was replaced, reaped or ended gets `conflict`.
drop function if exists api.call_heartbeat(uuid, uuid);
create or replace function api.call_heartbeat(p_call uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v     dek.calls;
begin
  v_uid := dek.require_uid();
  select * into v from dek.calls where id = p_call;
  if not found
     or not exists (select 1 from dek.call_participants p where p.call_id = v.id and p.user_id = v_uid) then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  perform dek.assert_read(v_uid, v.channel_id);
  update dek.call_participants p
     set last_heartbeat_at = now()
   where p.call_id = v.id and p.user_id = v_uid and p.state = 'joined'
     and p.session_id = p_session_id
     and exists (select 1 from dek.calls x where x.id = p.call_id and x.ended_at is null);
  if not found then
    perform dek.err('conflict', 'You are no longer in this call.');
  end if;
  return jsonb_build_object('ok', true);
end $$;

drop function if exists api.get_call(uuid);
create or replace function api.get_call(p_call uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v     dek.calls;
begin
  v_uid := dek.require_uid();
  select * into v from dek.calls where id = p_call;
  if not found
     or not dek.can_read_channel(v_uid, v.channel_id)
     or (v.kind = 'direct'
         and not exists (select 1 from dek.call_participants p where p.call_id = v.id and p.user_id = v_uid)) then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  return dek.call_json(v);
end $$;

-- Rooms with people in them in channels the caller can read, plus direct calls that
-- are ringing the caller (or that the caller is still joined to, so a reloaded tab can
-- re-attach). Oldest first, at most 100.
drop function if exists api.active_calls(uuid);
create or replace function api.active_calls(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_out jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  select coalesce(jsonb_agg(dek.call_json(c) order by c.created_at, c.id), '[]'::jsonb)
    into v_out
    from dek.calls c
   where c.id in (
           (select r.id from dek.calls r
             where r.org_id = p_org and r.ended_at is null and r.kind = 'room'
               and exists (select 1 from dek.call_participants x where x.call_id = r.id and x.state = 'joined')
               and dek.can_read_channel(v_uid, r.channel_id)
             order by r.created_at desc
             limit 50)
           union
           (select d.id from dek.call_participants p
              join dek.calls d on d.id = p.call_id
             where p.user_id = v_uid and p.state in ('ringing', 'joined')
               and d.org_id = p_org and d.ended_at is null and d.kind = 'direct'
               and dek.can_read_channel(v_uid, d.channel_id)
             order by d.created_at desc
             limit 50));
  return v_out;
end $$;

-- =====================================================================
-- 3. Reaper (cron, every minute)
-- =====================================================================

-- Ringing for 45 s becomes missed; a joined session silent for 90 s becomes left;
-- calls nobody is in any more end (with their DM line). The first statement is an
-- indexed existence probe on the partial index of active calls, so an idle minute
-- costs one index lookup. Only calls with something due are picked, so any number of
-- healthy calls cannot crowd out the ones that need ending; rows a user transaction
-- holds are skipped until the next minute.
create or replace function dek.media_reap_calls()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r         record;
  v_changed int;
  v_n       int;
begin
  if not exists (select 1 from dek.calls c where c.ended_at is null) then
    return;
  end if;
  for r in
    select c.id from dek.calls c
     where c.ended_at is null
       and (exists (select 1 from dek.call_participants p
                     where p.call_id = c.id
                       and ((p.state = 'ringing' and p.updated_at < now() - interval '45 seconds')
                         or (p.state = 'joined'
                             and coalesce(p.last_heartbeat_at, p.joined_at, p.updated_at) < now() - interval '90 seconds')))
            or not exists (select 1 from dek.call_participants p
                            where p.call_id = c.id and p.state in ('ringing', 'joined')))
     order by c.created_at
     limit 1000
       for update skip locked
  loop
    update dek.call_participants p set state = 'missed', updated_at = now()
     where p.call_id = r.id and p.state = 'ringing' and p.updated_at < now() - interval '45 seconds';
    get diagnostics v_changed = row_count;
    update dek.call_participants p set state = 'left', left_at = now(), updated_at = now()
     where p.call_id = r.id and p.state = 'joined'
       and coalesce(p.last_heartbeat_at, p.joined_at, p.updated_at) < now() - interval '90 seconds';
    get diagnostics v_n = row_count;
    v_changed := v_changed + v_n;
    if v_changed > 0
       or not exists (select 1 from dek.call_participants p
                       where p.call_id = r.id and p.state in ('ringing', 'joined')) then
      perform dek.media_settle_call(r.id);
      perform dek.media_emit_call(r.id);
    end if;
  end loop;
end $$;
-- The bound lives in the command: a function-level SET statement_timeout does not
-- bound the statement that calls the function; a SET earlier in the command does.
select cron.schedule('dek-call-reaper', '* * * * *',
  $cmd$set statement_timeout = '20s'; select dek.media_reap_calls()$cmd$);

-- =====================================================================
-- 4. TURN gate (service_role only, called by the turn Edge Function)
-- =====================================================================

-- Relay credentials cost money per byte, and sign-up is open: only active members of
-- an organization get them, at most 30 times in 10 minutes.
drop function if exists api.svc_turn_grant(uuid);
create or replace function api.svc_turn_grant(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null
     or not exists (select 1 from dek.org_members m where m.user_id = p_user and m.status = 'active')
     or exists (select 1 from dek.profiles p where p.id = p_user and p.deleted_at is not null) then
    perform dek.err('forbidden', 'Calls are for members of an organization.');
  end if;
  perform dek.rate_hit(p_user, 'turn', 30, 600);
  return jsonb_build_object('ok', true);
end $$;
