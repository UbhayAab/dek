-- 0136: 49% of this database's work was for nobody
--
-- Measured on the live project over a 61-day pg_stat_statements window, total
-- 39,601 s of execution time:
--
--   app.run_fanout_tick()       999,998 calls   7.0 ms   7,009 s   17.7%
--   app.drain_notifications()   345,482 calls  10.0 ms   3,450 s    8.7%
--   enforce_password_latch()    789,763 calls   2.6 ms   2,021 s    5.1%
--   pg_timezone_names             2,287 calls   692 ms   1,583 s    4.0%
--   app.escalate_acks()          83,961 calls  12.7 ms   1,069 s    2.7%
--
-- Cron is 40% of all database time on a box that is otherwise ~99% idle. And
-- it is not idle-cheap: cron.use_background_workers is OFF, so each of the
-- 38,607 executions per day opens a real libpq connection against 57 usable
-- slots, which is why cron.job_run_details carries 37 'job startup timeout'
-- failures a day. This database is not short of CPU. It is short of
-- connections, and its own maintenance is eating them.
--
-- The single worst offender is a five-second tick doing hourly work.

-- ===========================================================================
-- 1. The 17.7%
-- ===========================================================================
--
-- app.run_digest_monitor, every 5 seconds, unconditionally:
--
--   a) delete from channel_viewers where last_seen_at < now() - interval '1 hour'
--      A one-hour retention horizon, executed 17,280 times a day. Running it
--      once an hour does exactly the same thing.
--
--   b) a full scan of channels LEFT JOIN an aggregate over channel_viewers,
--      recomputing viewer_count for every channel whether or not anybody moved.
--      The `is distinct from` guard suppresses the WRITE but not the WORK.
--      This is where 4,888,720 sequential scans of a 220-row `channels` and
--      2,052,042 of a 2-row `channel_viewers` come from.
--
-- What the monitor is FOR is flipping a channel into digest mode once it has
-- 50 concurrent viewers. All 218 channels on this database are broadcast_mode
-- 'full'. It has never flipped anything, and it will not until a room has 50
-- people in it at once - at which point one probe per 15 seconds finds it just
-- as well as a full recompute per 5 seconds.
create or replace function app.run_digest_monitor(
  p_enter integer default 50, p_exit integer default 35,
  p_ttl interval default '00:02:00'::interval)
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_flipped int; r record;
begin
  -- THE GUARD. If nobody is looking at anything, no channel carries a stale
  -- non-zero count, and nothing is currently in digest mode, there is nothing
  -- this function can change. Three indexed probes, then return. The retention
  -- DELETE has moved to its own hourly job below, so it is no longer a reason
  -- to run the body.
  if not exists (select 1 from public.channel_viewers
                  where last_seen_at > now() - p_ttl limit 1)
     and not exists (select 1 from public.channels
                      where viewer_count <> 0 limit 1)
     and not exists (select 1 from public.channels
                      where broadcast_mode <> 'full' limit 1)
  then
    return 0;
  end if;

  update public.channels c
  set viewer_count = v.n
  from (
    select c2.id, coalesce(l.n, 0) as n
    from public.channels c2
    left join (
      select cv.channel_id, count(*)::int as n
      from public.channel_viewers cv
      where cv.last_seen_at > now() - p_ttl
      group by cv.channel_id) l on l.channel_id = c2.id
    where coalesce(l.n, 0) is distinct from c2.viewer_count) v
  where c.id = v.id;

  v_flipped := 0;
  for r in
    with t as (
      select c.id,
             coalesce(c.digest_threshold, p_enter) as v_enter,
             case when c.digest_threshold is null then p_exit
                  else greatest(1, (c.digest_threshold * 7) / 10) end as v_exit,
             c.broadcast_mode, c.viewer_count
      from public.channels c),
    upd as (
      update public.channels c
      set broadcast_mode = case when t.broadcast_mode = 'full' then 'digest' else 'full' end
      from t
      where c.id = t.id
        and ((t.broadcast_mode = 'full'   and t.viewer_count >= t.v_enter)
          or (t.broadcast_mode = 'digest' and t.viewer_count <  t.v_exit))
      returning c.id, c.broadcast_mode, c.last_seq, c.last_nudge_seq)
    select * from upd
  loop
    v_flipped := v_flipped + 1;
    -- A channel LEAVING digest may still owe people a nudge: anything
    -- published inside the last 2-second coalescing window was never
    -- announced, and once the mode is 'full' the flush will not look at it
    -- again.
    if r.broadcast_mode = 'full' and r.last_seq > r.last_nudge_seq then
      perform app.emit('ch:'||r.id::text, 'nudge', jsonb_build_object('last_seq', r.last_seq));
      update public.channels set last_nudge_seq = r.last_seq where id = r.id;
    end if;
  end loop;

  return v_flipped;
end;
$fn$;

-- What the guard probes, so it is an index scan and not the seq scan it is
-- meant to replace.
create index if not exists channel_viewers_last_seen_idx
  on public.channel_viewers (last_seen_at);

-- The hourly work, on an hourly schedule.
select cron.unschedule('reap-channel-viewers')
 where exists (select 1 from cron.job where jobname = 'reap-channel-viewers');
select cron.schedule('reap-channel-viewers', '7 * * * *',
  $$delete from public.channel_viewers where last_seen_at < now() - interval '1 hour'$$);

-- 12 runs a minute becomes 4. The digest valve's own coalescing window is 2
-- seconds and its enter threshold is 50 concurrent viewers; neither needs
-- five-second resolution to work.
select cron.unschedule('fanout-tick')
 where exists (select 1 from cron.job where jobname = 'fanout-tick');
select cron.schedule('fanout-tick', '15 seconds', 'select app.run_fanout_tick();');

-- ===========================================================================
-- 2. Four connections every thirty seconds, for four jobs that never overlap
-- ===========================================================================
--
-- With background workers off, four separate 30-second jobs are four libpq
-- connection opens every 30 seconds - 11,520 a day - each able to fail with
-- 'job startup timeout' independently. They do unrelated work and none takes
-- long, so one job doing all four costs one connection instead of four.
--
-- Each call is wrapped so one failing does not abandon the other three. The
-- old arrangement had that isolation for free by being separate jobs, and
-- losing it silently would be a worse trade than the connections are worth.
create or replace function app.tick_30s()
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  begin perform app.reap_presence();      exception when others then
    raise warning 'tick_30s: reap_presence: %', sqlerrm; end;
  begin perform app.dispatch_scheduled(); exception when others then
    raise warning 'tick_30s: dispatch_scheduled: %', sqlerrm; end;
  begin perform app.fire_reminders();     exception when others then
    raise warning 'tick_30s: fire_reminders: %', sqlerrm; end;
  begin perform app.reap_voice();         exception when others then
    raise warning 'tick_30s: reap_voice: %', sqlerrm; end;
end;
$fn$;

select cron.unschedule(jobname) from cron.job
 where jobname in ('presence-reaper', 'dispatch-scheduled', 'fire-reminders', 'reap-voice');
select cron.unschedule('tick-30s') where exists (select 1 from cron.job where jobname = 'tick-30s');
select cron.schedule('tick-30s', '30 seconds', 'select app.tick_30s();');

-- cron.job_run_details grows without bound and already holds 38,607 rows for a
-- single day. Nothing has ever deleted from it.
select cron.unschedule('prune-cron-history')
 where exists (select 1 from cron.job where jobname = 'prune-cron-history');
select cron.schedule('prune-cron-history', '11 2 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);

-- ===========================================================================
-- 3. One word in send_message
-- ===========================================================================
--
-- `for update` is the strongest row lock there is, and it conflicts with the
-- `FOR KEY SHARE` that every INSERT into public.messages takes on its parent
-- channels row to validate the foreign key. When several transactions hold
-- compatible locks on one row Postgres allocates a MultiXactId, and multixacts
-- are immutable - adding a locker copies the whole previous member list into a
-- new one, so n concurrent lockers cost n(n+1)/2 - 1 members. A low-cardinality
-- parent row that many concurrent transactions must lock is precisely the shape
-- of `channels` in a busy room.
--
-- `for no key update` is what a plain UPDATE of a non-key column takes anyway.
-- It still serialises writers against each other, so last_seq stays GAPLESS -
-- that property is unchanged, and is the whole reason the lock is here. It
-- simply stops blocking, and being blocked by, the FK checks.
create or replace function public.send_message(
  p_channel uuid, p_client_msg_id uuid, p_body jsonb, p_body_text text,
  p_attachments jsonb default '[]'::jsonb, p_mentions uuid[] default '{}'::uuid[],
  p_mention_scope text default 'none', p_reply_to uuid default null,
  p_thread uuid default null, p_also_send boolean default false)
returns public.messages language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid; v_bmode text; v_row public.messages;
  v_mentions uuid[]; v_visible uuid[];
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

  -- 0132: above the lock on purpose. Four tables per mentioned user, and it
  -- does not depend on the row about to be written.
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

  if v_bmode = 'full' then
    perform app.emit('ch:'||p_channel::text, 'msg', to_jsonb(v_row));
  else
    perform app.emit('ch:'||p_channel::text, 'nudge', jsonb_build_object('last_seq', v_row.seq));
  end if;

  perform app.emit('user:'||u::text, 'mention',
            jsonb_build_object('channel_id', p_channel, 'message_id', v_row.id, 'workspace_id', v_ws))
     from unnest(v_visible) u;

  return v_row;
end;
$fn$;
