-- 0137: Postgres starts publishing to Cloudflare, alongside Supabase
--
-- Supabase Realtime caps a Free project at 200 concurrent connections. The
-- replacement transport is live at dek-realtime.ubhayvatsaanand.workers.dev -
-- two Durable Object rooms per person, `ws:<workspaceId>` for channels and
-- `u:<userId>` for DMs and mentions, with authorization still answered by RLS
-- in this database.
--
-- THIS MIGRATION DOES NOT CUT ANYTHING OVER. It publishes to BOTH. Supabase
-- keeps carrying every client that exists today, and Cloudflare starts
-- carrying the same traffic with nobody listening yet. That is the point: the
-- new path gets exercised by real production load, at real volume, with real
-- payloads, while its failure mode is "a message nobody was waiting for did
-- not arrive". The client flag flips only once this has been quiet for a while.
--
-- WHY A SEPARATE FUNCTION AND NOT A CHANGE TO app.emit.
--
-- app.emit takes a topic string and nothing else. Routing to a Cloudflare room
-- needs the WORKSPACE, and deriving that from a channel id means a lookup -
-- inside send_message, inside the channel row lock, which is the exact cost
-- 0132 and 0135 were written to remove. Every caller already knows its
-- workspace, so it passes it. app.emit is untouched.

-- ===========================================================================
-- 1. A switch that is not a deploy
-- ===========================================================================
--
-- If the Worker misbehaves at 2am the fix has to be one UPDATE, not a
-- migration. pg_net failures are already silent, but silent-and-still-trying
-- is not the same as off.
create table if not exists app.settings (
  key   text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
insert into app.settings(key, value) values ('cf_realtime', 'on')
  on conflict (key) do nothing;

create or replace function app.setting(p_key text, p_default text default null)
returns text language sql stable security definer set search_path = '' as $fn$
  select coalesce((select value from app.settings where key = p_key), p_default);
$fn$;

-- ===========================================================================
-- 2. The publish
-- ===========================================================================
--
-- net.http_post queues the request and returns immediately; it does not wait
-- for the Worker. That matters twice over: the channel lock is not held across
-- an internet round trip, and a slow or dead Worker cannot make sending a
-- message slow. The cost inside the transaction is one insert into
-- net.http_request_queue.
--
-- The honest consequence of pg_net rather than realtime.send(): this is NOT
-- transactional. realtime.send() writes inside the transaction, so it commits
-- or rolls back with the message. A queued HTTP request can still go out after
-- a rollback. For a realtime hint - "something changed, come look" - that is
-- acceptable; the client reconciles against Postgres anyway. It would not be
-- acceptable for anything the client treats as authoritative, which is why the
-- payload stays a notification and never a source of truth.
create or replace function app.cf_publish(
  p_room text, p_topic text, p_event text, p_payload jsonb, p_except uuid default null)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_key text;
begin
  if app.setting('cf_realtime', 'off') <> 'on' then return; end if;
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'dek_cf_publish_key';
  if v_key is null then return; end if;   -- half-deployed; stay quiet

  perform net.http_post(
    url     := app.setting('cf_realtime_url',
                 'https://dek-realtime.ubhayvatsaanand.workers.dev') || '/publish',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dek-key', v_key),
    body    := jsonb_build_object(
                 'room', p_room, 'topic', p_topic,
                 'event', p_event, 'payload', p_payload,
                 'except', p_except),
    timeout_milliseconds := 2000);
exception when others then
  -- Never let the transport take a message down with it. Same posture as
  -- app.emit, which swallows realtime.send failures for the same reason.
  null;
end;
$fn$;

-- Many fan-outs, one HTTP request. A mention hits the space room AND every
-- mentioned person's inbox; as N separate net.http_post calls that would be N
-- queue inserts inside the locked transaction.
create or replace function app.cf_publish_batch(p_sends jsonb)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_key text;
begin
  if app.setting('cf_realtime', 'off') <> 'on' then return; end if;
  if p_sends is null or jsonb_array_length(p_sends) = 0 then return; end if;
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'dek_cf_publish_key';
  if v_key is null then return; end if;

  perform net.http_post(
    url     := app.setting('cf_realtime_url',
                 'https://dek-realtime.ubhayvatsaanand.workers.dev') || '/publish/batch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dek-key', v_key),
    body    := jsonb_build_object('sends', p_sends),
    timeout_milliseconds := 2000);
exception when others then null;
end;
$fn$;

-- ===========================================================================
-- 3. send_message publishes to both
-- ===========================================================================
--
-- Identical to 0136 except for the block at the end. Everything 0132/0135/0136
-- established is preserved: the mention-visibility query stays above the lock,
-- the three channel updates stay folded into one, the lock stays
-- `for no key update`, and the Supabase fan-out still leaves in one statement.
create or replace function public.send_message(
  p_channel uuid, p_client_msg_id uuid, p_body jsonb, p_body_text text,
  p_attachments jsonb default '[]'::jsonb, p_mentions uuid[] default '{}'::uuid[],
  p_mention_scope text default 'none', p_reply_to uuid default null,
  p_thread uuid default null, p_also_send boolean default false)
returns public.messages language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid; v_bmode text; v_row public.messages;
  v_mentions uuid[]; v_visible uuid[]; v_sends jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select workspace_id, broadcast_mode into v_ws, v_bmode from public.channels where id = p_channel;
  if v_ws is null or not private.can_view_channel(p_channel) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (private.channel_perms(v_uid, p_channel) & 1) = 0 then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from public.workspace_members wm
              where wm.workspace_id = v_ws and wm.user_id = v_uid and wm.timeout_until > now()) then
    raise exception 'timed_out' using errcode = '42501';
  end if;
  if length(coalesce(p_body_text, '')) > 8000 then raise exception 'body_too_long' using errcode = '22023'; end if;
  if pg_column_size(coalesce(p_attachments, '[]'::jsonb)) > 65536 then raise exception 'attachments_too_large' using errcode = '22023'; end if;
  if p_thread is not null and not exists (select 1 from public.threads t where t.id = p_thread and t.channel_id = p_channel) then
    raise exception 'invalid_thread' using errcode = '22023';
  end if;
  if p_reply_to is not null and not exists (select 1 from public.messages r where r.id = p_reply_to and r.channel_id = p_channel) then
    raise exception 'invalid_reply' using errcode = '22023';
  end if;
  v_mentions := (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_mentions, '{}')) x);
  if coalesce(array_length(v_mentions, 1), 0) > 50 then raise exception 'too_many_mentions' using errcode = '22023'; end if;
  perform private.rate_limit('send', v_uid, p_channel, 30, interval '10 seconds');

  -- 0132: above the lock on purpose.
  v_visible := (select coalesce(array_agg(u), '{}') from unnest(v_mentions) u
    where u <> v_uid and exists (
      select 1 from public.channels c where c.id = p_channel and (
        (not c.is_private and exists (select 1 from public.workspace_members wm
           where wm.workspace_id = c.workspace_id and wm.user_id = u))
        or exists (select 1 from public.channel_members cm
           where cm.channel_id = p_channel and cm.user_id = u)))
      and not private.channel_view_denied(u, p_channel));

  -- ---- critical section ---------------------------------------------------
  insert into public.messages(channel_id, workspace_id, thread_id, author_id, seq, client_msg_id,
                              body, body_text, attachments, mention_user_ids, mention_scope, reply_to_id,
                              also_send_to_channel)
  select p_channel, v_ws, p_thread, v_uid, c.last_seq + 1, p_client_msg_id,
         coalesce(p_body,'{}'::jsonb), coalesce(p_body_text,''), coalesce(p_attachments,'[]'::jsonb),
         v_mentions, coalesce(p_mention_scope,'none'), p_reply_to,
         (p_thread is not null and coalesce(p_also_send, false))
  from public.channels c where c.id = p_channel for no key update
  on conflict (channel_id, author_id, client_msg_id) do nothing
  returning * into v_row;

  if not found then
    select * into v_row from public.messages
      where channel_id = p_channel and author_id = v_uid and client_msg_id = p_client_msg_id;
    return v_row;
  end if;

  update public.channels
     set last_seq = v_row.seq,
         last_message_at = now(),
         last_broadcast_seq = case
           when p_mention_scope in ('here','channel')
            and private.has_channel_perm(p_channel, (1::bigint << 8))
           then v_row.seq else last_broadcast_seq end,
         last_nudge_at = case
           when v_bmode <> 'full'
            and (last_nudge_at is null or last_nudge_at < now() - interval '2 seconds')
           then now() else last_nudge_at end
   where id = p_channel;

  insert into public.channel_events(channel_id, workspace_id, seq, kind, message_id, actor_id, data)
  values (p_channel, v_ws, v_row.seq, 'msg', v_row.id, v_uid, jsonb_build_object('thread_id', p_thread));

  if p_thread is not null then
    update public.threads set reply_count = reply_count + 1, last_message_at = now() where id = p_thread;
    insert into public.thread_followers(thread_id, user_id, workspace_id)
    values (p_thread, v_uid, v_ws) on conflict (thread_id, user_id) do nothing;
  end if;

  insert into public.read_state(user_id, scope_type, scope_id, mention_count)
  select u, 'channel', p_channel, 1 from unnest(v_visible) u
  on conflict (user_id, scope_type, scope_id)
    do update set mention_count = public.read_state.mention_count + 1;

  -- ---- Supabase, exactly as before ---------------------------------------
  if v_bmode = 'full' then
    perform app.emit('ch:'||p_channel::text, 'msg', to_jsonb(v_row));
  else
    perform app.emit('ch:'||p_channel::text, 'nudge', jsonb_build_object('last_seq', v_row.seq));
  end if;
  perform app.emit('user:'||u::text, 'mention',
            jsonb_build_object('channel_id', p_channel, 'message_id', v_row.id, 'workspace_id', v_ws))
     from unnest(v_visible) u;

  -- ---- Cloudflare, the same traffic, ONE queued request -------------------
  -- The channel frame plus one inbox frame per mentioned person, assembled as
  -- a single batch so this costs one net.http_post however many were named.
  v_sends := jsonb_build_array(jsonb_build_object(
    'room',  'ws:'||v_ws::text,
    'topic', p_channel::text,
    'event', case when v_bmode = 'full' then 'msg' else 'nudge' end,
    'payload', case when v_bmode = 'full' then to_jsonb(v_row)
                    else jsonb_build_object('last_seq', v_row.seq) end))
    || coalesce((
      select jsonb_agg(jsonb_build_object(
        'room',  'u:'||u::text,
        'topic', u::text,
        'event', 'mention',
        'payload', jsonb_build_object('channel_id', p_channel,
                                      'message_id', v_row.id, 'workspace_id', v_ws)))
      from unnest(v_visible) u), '[]'::jsonb);
  perform app.cf_publish_batch(v_sends);

  return v_row;
end;
$fn$;

grant execute on function app.setting(text, text) to authenticated;
