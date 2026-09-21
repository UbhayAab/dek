-- 0133: notifications that actually arrive
--
-- The push chain itself is healthy. net._http_response on this database is all
-- 200s reading {"sent":1,"found":1}, so DB trigger -> pgmq -> pg_cron drain ->
-- pg_net -> web-push -> the browser works end to end. The reason people say
-- "notifications do not work" is that almost nothing ever enqueues one.
--
-- app.notify_on_message iterates `unnest(new.mention_user_ids)` and nothing
-- else. So a channel message notifies ONLY people typed into it with an @. Per
-- 0125's note, across the entire history of this database only 126 messages
-- have ever contained a mention. Everything else - every ordinary message in
-- every channel - has always been silent.
--
-- Meanwhile private.should_notify is a full preference engine: per-channel
-- notify_level, muted_until, global do-not-disturb, and quiet hours with the
-- person's timezone. It supports a 'all' level. And 59 rows in read_state are
-- set to notify_level = 'all' right now. Fifty-nine people have explicitly
-- asked to be told about every message in a channel and have never once been
-- told about any of them, because the trigger never asks anyone but the
-- mentioned.
--
-- This makes 'all' mean what it says. It deliberately does NOT change the
-- default: 'inherit' (3,094 rows) and 'mentions' (31 rows) keep todays
-- behaviour exactly. Nobody starts getting more mail than they asked for.

-- ===========================================================================
-- 1. Who to tell about a message
-- ===========================================================================
--
-- Two populations, unioned and deduped:
--   a) anybody @mentioned, as before
--   b) anybody who set notify_level = 'all' on this channel
-- minus the author, minus anyone should_notify() says is muted, in do-not-
-- disturb or inside quiet hours, minus anyone who cannot see the channel.
--
-- FAN-OUT CAP. A channel where two hundred people chose 'all' would enqueue
-- two hundred rows per message, and the drain runs every 15 seconds against a
-- 60-connection database. NOTIFY_FANOUT_CAP bounds one message's fan-out. It
-- is a safety valve, not a policy: it is above any plausible real channel here
-- (the largest server on this database has single-digit tens of members), and
-- crossing it is worth a log line rather than a silent truncation.
create or replace function app.notify_on_message()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  v_targets uuid[];
  v_cap constant int := 200;
  u uuid;
begin
  -- Threads are their own inbox and already have thread_followers; a reply
  -- inside a thread should not ring every 'all' subscriber in the channel.
  -- Mentions inside a thread still notify, which is the b) branch only.
  select coalesce(array_agg(distinct t.uid), '{}') into v_targets
  from (
    select unnest(new.mention_user_ids) as uid
    union
    select rs.user_id
      from public.read_state rs
     where rs.scope_type = 'channel'
       and rs.scope_id = new.channel_id
       and rs.notify_level = 'all'
       and new.thread_id is null
  ) t
  where t.uid is distinct from new.author_id
    and private.should_notify(t.uid, new.channel_id)
    and not private.channel_view_denied(t.uid, new.channel_id)
    and exists (
      select 1 from public.channels c
      where c.id = new.channel_id and (
        ( not c.is_private and exists (
            select 1 from public.workspace_members wm
            where wm.workspace_id = c.workspace_id and wm.user_id = t.uid) )
        or exists (
            select 1 from public.channel_members cm
            where cm.channel_id = new.channel_id and cm.user_id = t.uid) ));

  if coalesce(array_length(v_targets, 1), 0) = 0 then return null; end if;

  if array_length(v_targets, 1) > v_cap then
    raise warning 'notify_on_message: fan-out % capped to % for channel %',
      array_length(v_targets, 1), v_cap, new.channel_id;
    v_targets := v_targets[1:v_cap];
  end if;

  foreach u in array v_targets loop
    perform app.enqueue_notification(u, jsonb_build_object(
      'kind',         'message',
      'channel_id',   new.channel_id,
      'message_id',   new.id,
      'workspace_id', new.workspace_id));
  end loop;
  return null;
end;
$fn$;

-- ===========================================================================
-- 2. Let somebody set the level without an admin
-- ===========================================================================
--
-- read_state is RLS'd to the owner, but the row may not exist yet - a person
-- who has never opened a channel has no read_state row to update, so a plain
-- UPDATE from the client silently affects zero rows and the setting appears
-- not to stick. Upsert it here instead.
create or replace function public.set_channel_notify_level(p_channel uuid, p_level text)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_uid uuid := (select auth.uid()); v_ws uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_level not in ('all', 'mentions', 'nothing', 'inherit') then
    raise exception 'bad_level' using errcode = '22023',
      hint = 'one of all, mentions, nothing, inherit';
  end if;
  select workspace_id into v_ws from public.channels where id = p_channel;
  if v_ws is null or not private.can_view_channel(p_channel) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.read_state(user_id, scope_type, scope_id, notify_level)
  values (v_uid, 'channel', p_channel, p_level)
  on conflict (user_id, scope_type, scope_id)
    do update set notify_level = excluded.notify_level;
end;
$fn$;

create or replace function public.get_channel_notify_level(p_channel uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  select coalesce((select rs.notify_level from public.read_state rs
                    where rs.user_id = (select auth.uid())
                      and rs.scope_type = 'channel' and rs.scope_id = p_channel),
                  'inherit');
$fn$;

-- ===========================================================================
-- 3. Mute, in one call, because the client had no way to set muted_until
-- ===========================================================================
create or replace function public.mute_channel(p_channel uuid, p_minutes int)
returns timestamptz language plpgsql security definer set search_path = '' as $fn$
declare v_uid uuid := (select auth.uid()); v_until timestamptz;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.can_view_channel(p_channel) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- null or <= 0 unmutes, which is what a toggle needs
  v_until := case when coalesce(p_minutes, 0) > 0
                  then now() + make_interval(mins => least(p_minutes, 60 * 24 * 365))
                  else null end;
  insert into public.read_state(user_id, scope_type, scope_id, muted_until)
  values (v_uid, 'channel', p_channel, v_until)
  on conflict (user_id, scope_type, scope_id)
    do update set muted_until = excluded.muted_until;
  return v_until;
end;
$fn$;

-- ===========================================================================
-- 4. A subscription that is known to be dead should not be counted as reach
-- ===========================================================================
--
-- The web-push function already reports `pruned`, but nothing records WHEN a
-- subscription was last known good, so "16 of 272 people can be reached" is
-- not answerable from this database. One column, written by the drain, makes
-- the reach question answerable without guessing.
alter table public.push_subscriptions
  add column if not exists last_ok_at timestamptz,
  add column if not exists fail_count int not null default 0;

create or replace function public.push_reach()
returns table(users_total bigint, users_subscribed bigint, subs_total bigint, subs_healthy bigint)
language sql stable security definer set search_path = '' as $fn$
  select (select count(*) from public.profiles),
         (select count(distinct user_id) from public.push_subscriptions),
         (select count(*) from public.push_subscriptions),
         (select count(*) from public.push_subscriptions where fail_count < 3);
$fn$;

grant execute on function public.set_channel_notify_level(uuid, text) to authenticated;
grant execute on function public.get_channel_notify_level(uuid) to authenticated;
grant execute on function public.mute_channel(uuid, int) to authenticated;
grant execute on function public.push_reach() to authenticated;

-- ===========================================================================
-- 5. THE WIRING, which is what actually kept everybody silent
-- ===========================================================================
--
-- Replacing the function above was necessary and on its own did nothing,
-- because the trigger never called it:
--
--   CREATE TRIGGER notify_on_message AFTER INSERT ON public.messages
--     FOR EACH ROW WHEN ((cardinality(new.mention_user_ids) > 0))
--     EXECUTE FUNCTION app.notify_on_message()
--
-- The WHEN clause is the bug. A message with no @ in it never reached the
-- function at all, so no amount of preference logic inside it could ever have
-- mattered. Verified by inserting a plain message into a channel with four
-- notify_level='all' subscribers, three of whom pass every predicate: zero
-- notifications enqueued.
--
-- A trigger WHEN clause may only reference NEW and OLD, so it cannot ask
-- whether this channel has any 'all' subscribers. The clause therefore goes,
-- and the cheap exit moves inside the function - which is why the partial
-- index below exists: for the overwhelmingly common case of a channel nobody
-- subscribed to, the added per-message cost is one index probe that finds
-- nothing. That matters because this trigger runs inside send_message's
-- transaction, while the channel row is locked (see 0132).
create index if not exists read_state_notify_all_idx
  on public.read_state (scope_id)
  where scope_type = 'channel' and notify_level = 'all';

drop trigger if exists notify_on_message on public.messages;
create trigger notify_on_message
  after insert on public.messages
  for each row
  execute function app.notify_on_message();
