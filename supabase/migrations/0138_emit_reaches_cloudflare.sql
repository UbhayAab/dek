-- 0138: every realtime event reaches Cloudflare, not just messages
--
-- 0137 taught send_message to dual-publish, and the client now listens to
-- Cloudflare. That combination has a hole big enough to lose most of the app
-- in: send_message is ONE of about twenty places this database emits from.
-- Reactions, edits, deletes, thread creation, DM messages, DM reactions, read
-- receipts, voice join and leave, channel created/updated/deleted, member
-- joined/left, role changes, join requests, calls - all of them still went to
-- Supabase alone. On the new transport they would simply never arrive, and it
-- would look like "reactions do not work" rather than like a transport fault.
--
-- The fix is to stop patching call sites and teach app.emit itself. Every one
-- of those twenty goes through it.
--
-- THE REASON THIS WAS NOT DONE IN 0137 was that app.emit takes a topic string
-- and nothing else, while a Cloudflare room has to be named. That is solvable:
-- the topic prefix says which room, and the only case needing a lookup is
-- `ch:`, which is a primary-key read on a 220-row table.
--
--   ch:<channelId>    -> room ws:<workspace of that channel>, topic <channelId>
--   vc:<channelId>    -> same
--   ws:<workspaceId>  -> room ws:<workspaceId>,               topic <workspaceId>
--   user:<userId>     -> room u:<userId>,                     topic <userId>
--   dm:<conversation> -> one room per member, u:<each>,       topic <conversation>
--   typ:<channelId>   -> skipped: typing is client to client and never comes
--                        through here
--
-- send_message still calls app.cf_publish_batch directly and is NOT changed by
-- this. It has the workspace in scope already, so routing through here would
-- add a lookup inside the channel row lock for no gain - the exact cost 0132
-- and 0135 removed.

-- ===========================================================================
-- 1. Topic -> room
-- ===========================================================================
--
-- Returns the set of rooms a topic must be delivered to. A DM is the only
-- one-to-many case: a conversation lives in every member's personal inbox, so
-- one emit becomes one send per member.
create or replace function app.rooms_for_topic(p_topic text)
returns table(room text, topic text)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_kind text; v_id text; v_ws uuid;
begin
  v_kind := split_part(p_topic, ':', 1);
  v_id   := substring(p_topic from position(':' in p_topic) + 1);
  if v_id = '' then return; end if;

  if v_kind = 'ws' then
    room := 'ws:'||v_id; topic := v_id; return next; return;
  end if;

  if v_kind = 'user' then
    room := 'u:'||v_id; topic := v_id; return next; return;
  end if;

  if v_kind in ('ch', 'vc') then
    select c.workspace_id into v_ws from public.channels c where c.id = v_id::uuid;
    if v_ws is null then return; end if;
    room := 'ws:'||v_ws::text; topic := v_id; return next; return;
  end if;

  if v_kind = 'dm' then
    -- The conversation id is the topic inside every member's own inbox room,
    -- which is what lets a DM arrive while the recipient is looking at a
    -- different server. There is deliberately no shared room per conversation:
    -- that would be a third kind of Durable Object to authorize.
    return query
      select 'u:'||cm.user_id::text, v_id
        from public.conversation_members cm
       where cm.conversation_id = v_id::uuid;
    return;
  end if;

  -- typ: is client-originated and never reaches this function. Anything else
  -- is unknown and deliberately dropped rather than guessed at.
  return;
exception when others then
  -- A malformed uuid in a topic must not take the emit down. Supabase still
  -- receives it either way.
  return;
end;
$fn$;

-- ===========================================================================
-- 2. app.emit, now reaching both
-- ===========================================================================
--
-- The Supabase half is byte for byte what it was, including swallowing its own
-- failures. The Cloudflare half is added after it and swallows separately, so
-- neither transport can break the other or the statement that called them.
--
-- One net.http_post per emit, batched across the rooms a topic resolves to, so
-- a DM in a ten-person conversation is one queued request rather than ten.
create or replace function app.emit(p_topic text, p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_sends jsonb;
begin
  begin
    perform realtime.send(p_payload, p_event, p_topic, true);
  exception when others then null;
  end;

  begin
    select jsonb_agg(jsonb_build_object(
             'room', r.room, 'topic', r.topic,
             'event', p_event, 'payload', p_payload))
      into v_sends
      from app.rooms_for_topic(p_topic) r;
    if v_sends is not null then perform app.cf_publish_batch(v_sends); end if;
  exception when others then null;
  end;
end;
$fn$;

-- ===========================================================================
-- 3. Tell PostgREST the schema moved
-- ===========================================================================
--
-- Not optional. `create or replace function` gives the function a new OID and
-- PostgREST serves RPC from a cache built at boot; without this every call to
-- a replaced function 404s with "Could not find the function ... in the schema
-- cache". That broke sending on the live site for the length of 0137.
notify pgrst, 'reload schema';
