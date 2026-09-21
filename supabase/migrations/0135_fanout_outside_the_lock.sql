-- 0135: one queue row per message, not one per recipient
--
-- 0132 shortened what send_message does while holding the channel row lock.
-- It did not touch the biggest thing in there, because that work is not in
-- send_message at all - it is in two AFTER INSERT triggers on public.messages,
-- which run inside the same transaction, while the same lock is held.
--
-- app.notify_on_broadcast, on any @here or @channel:
--
--   perform app.enqueue_notification(recips.u, ...) from ( ... limit 500 ) recips
--
-- That is up to FIVE HUNDRED pgmq.send() calls - five hundred row inserts -
-- before the transaction can commit and the next person in the room can post.
-- One @channel in a large server is the worst single thing this database can
-- be asked to do, and it is done at the exact moment everybody is watching.
--
-- app.notify_on_message (made unconditional in 0133, so it now runs on EVERY
-- message) has the same shape, bounded at 200.
--
-- The fix is not to do the work faster. It is to not do it here. The trigger
-- now enqueues ONE row naming the message, and app.drain_notifications expands
-- it into recipients when it runs - every 15 seconds, on its own connection,
-- holding nothing. The drain already groups identical notifications into one
-- HTTP call, so the expansion costs nothing extra on the way out.
--
-- In-lock cost for an @channel in a 500-person server: 500 inserts -> 1.
--
-- Per-recipient rows are KEPT for small fan-outs. They cost one insert each,
-- they carry a per-person payload a fanout row cannot express, and every
-- existing producer (DMs, tasks, leave, join requests, channel adds) already
-- emits them. This adds a second shape; it does not replace the first.

-- ===========================================================================
-- 1. The one-row form
-- ===========================================================================
create or replace function app.enqueue_fanout(
  p_channel uuid, p_message uuid, p_workspace uuid,
  p_author uuid, p_kind text, p_scope text default null)
returns void language sql security definer set search_path = '' as $fn$
  select pgmq.send('notifications', jsonb_build_object(
    'fanout', true,
    'payload', jsonb_build_object(
      'kind',         p_kind,
      'channel_id',   p_channel,
      'message_id',   p_message,
      'workspace_id', p_workspace,
      'author_id',    p_author,
      'scope',        p_scope)));
$fn$;

-- Who a fanout row resolves to. Lifted from the two triggers so there is one
-- definition of "everybody who should hear about this message" rather than
-- three copies that drift. Runs at drain time, so should_notify() is evaluated
-- when the push is about to go out rather than when the message was written -
-- which is also more correct: somebody whose quiet hours started in between
-- should not be woken.
create or replace function app.fanout_recipients(p_msg jsonb)
returns table(user_id uuid)
language sql stable security definer set search_path = '' as $fn$
  with p as (select p_msg->'payload' as pl),
  ch as (
    select c.id, c.workspace_id, c.is_private
      from public.channels c, p
     where c.id = (p.pl->>'channel_id')::uuid
  ),
  candidates as (
    -- A public channel reaches the whole server; a private one reaches only
    -- its members. The same rule the triggers used.
    select m.user_id as u
      from ch join public.workspace_members m on m.workspace_id = ch.workspace_id
     where not ch.is_private
    union
    select cm.user_id as u
      from ch join public.channel_members cm on cm.channel_id = ch.id
  )
  select distinct c.u
    from candidates c, ch, p
   where c.u is distinct from (p.pl->>'author_id')::uuid
     and ( -- 'broadcast' is @here/@channel and goes to everyone who can hear it.
           -- 'message' is the notify_level='all' population from 0133.
           (p.pl->>'kind') = 'broadcast'
        or exists (select 1 from public.read_state rs
                    where rs.user_id = c.u and rs.scope_type = 'channel'
                      and rs.scope_id = ch.id and rs.notify_level = 'all') )
     and private.should_notify(c.u, ch.id)
     and not private.channel_view_denied(c.u, ch.id)
   limit 500;
$fn$;

-- ===========================================================================
-- 2. The triggers, which now do one insert each
-- ===========================================================================
create or replace function app.notify_on_broadcast()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  perform app.enqueue_fanout(new.channel_id, new.id, new.workspace_id,
                             new.author_id, 'broadcast', new.mention_scope);
  return null;
end;
$fn$;

-- Mentions stay per-recipient: there are at most 50 of them (send_message
-- raises too_many_mentions above that), each is a person named on purpose, and
-- a per-user row is what lets the drain say "X mentioned you". The
-- notify_level='all' population is the unbounded half, so that half moves to a
-- fanout row.
create or replace function app.notify_on_message()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare u uuid; v_has_all boolean;
begin
  foreach u in array coalesce(new.mention_user_ids, '{}'::uuid[]) loop
    if u is distinct from new.author_id
       and private.should_notify(u, new.channel_id)
       and not private.channel_view_denied(u, new.channel_id)
       and exists (
         select 1 from public.channels c
          where c.id = new.channel_id and (
            ( not c.is_private and exists (
                select 1 from public.workspace_members wm
                where wm.workspace_id = c.workspace_id and wm.user_id = u) )
            or exists (select 1 from public.channel_members cm
                        where cm.channel_id = new.channel_id and cm.user_id = u) ))
    then
      perform app.enqueue_notification(u, jsonb_build_object(
        'kind', 'message', 'channel_id', new.channel_id,
        'message_id', new.id, 'workspace_id', new.workspace_id));
    end if;
  end loop;

  -- The "tell me about everything here" population, as ONE row. This is the
  -- partial index 0133 added: on a channel nobody subscribed to it costs about
  -- 0.06 ms and enqueues nothing, which is the overwhelmingly common case.
  if new.thread_id is null then
    select exists (select 1 from public.read_state rs
                    where rs.scope_type = 'channel' and rs.scope_id = new.channel_id
                      and rs.notify_level = 'all'
                      and rs.user_id is distinct from new.author_id)
      into v_has_all;
    if v_has_all then
      perform app.enqueue_fanout(new.channel_id, new.id, new.workspace_id,
                                 new.author_id, 'message', null);
    end if;
  end if;
  return null;
end;
$fn$;

-- ===========================================================================
-- 3. The drain, which now expands fanout rows
-- ===========================================================================
create or replace function app.drain_notifications()
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  v_key text;
  v_batch int := 60;
  r     record;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('hearth_notif_drain')) then
    return;
  end if;

  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'push_drain_key';
  if v_key is null then
    raise warning 'drain_notifications: vault secret push_drain_key is missing; not draining';
    return;
  end if;

  -- One claim, held for the rest of the transaction. pgmq.read hides what it
  -- returns for vt seconds and bumps read_ct, so reading twice would claim two
  -- different batches and the second could neither see nor clean up the first.
  create temporary table if not exists _drain_raw (
    msg_id bigint primary key, message jsonb,
    enqueued_at timestamptz, read_ct int) on commit drop;
  delete from _drain_raw;
  insert into _drain_raw (msg_id, message, enqueued_at, read_ct)
  select q.msg_id, q.message, q.enqueued_at, q.read_ct
    from pgmq.read('notifications', 120, v_batch) q;

  -- No primary key here any more: one fanout row expands to many rows sharing
  -- a msg_id, which a pkey on msg_id would reject.
  create temporary table if not exists _drain_batch (
    msg_id bigint, user_id uuid, content jsonb, sendable boolean) on commit drop;
  delete from _drain_batch;

  -- (a) ordinary per-recipient rows, exactly as before
  insert into _drain_batch (msg_id, user_id, content, sendable)
  select d.msg_id,
         (d.message->>'user_id')::uuid,
         app.notification_content(d.message),
         app.notification_content(d.message) is not null
           and d.enqueued_at > now() - interval '1 hour'
           and d.read_ct <= 5
    from _drain_raw d
   where coalesce((d.message->>'fanout')::boolean, false) = false;

  -- (b) fanout rows, expanded HERE - on the drain's own connection, holding
  -- nothing, long after the channel lock was released.
  insert into _drain_batch (msg_id, user_id, content, sendable)
  select d.msg_id,
         f.user_id,
         app.notification_content(d.message),
         app.notification_content(d.message) is not null
           and d.enqueued_at > now() - interval '1 hour'
           and d.read_ct <= 5
    from _drain_raw d
    cross join lateral app.fanout_recipients(d.message) f
   where coalesce((d.message->>'fanout')::boolean, false) = true;

  -- Group identical notifications so five hundred people hearing about one
  -- @channel cost one call rather than five hundred.
  for r in
    select content->>'title' as title, content->>'body' as body,
           content->>'url' as url, content->>'tag' as tag,
           array_agg(distinct user_id) as user_ids
      from _drain_batch
     where sendable and user_id is not null
     group by 1, 2, 3, 4
  loop
    perform net.http_post(
      url     := 'https://ybddogqphinruyunnuwx.supabase.co/functions/v1/web-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD',
        'x-drain-key', v_key),
      body    := jsonb_build_object(
        'user_ids', to_jsonb(r.user_ids),
        'title',    r.title,
        'body',     r.body,
        'url',      r.url,
        'tag',      r.tag));
  end loop;

  -- Everything claimed leaves the queue, sent or discarded. This reads from
  -- _drain_raw, NOT _drain_batch: a fanout row that resolved to nobody has no
  -- _drain_batch rows at all, and would otherwise be claimed, skipped, and
  -- re-read until read_ct retired it.
  perform pgmq.delete('notifications', array_agg(msg_id)) from _drain_raw;
end;
$fn$;
