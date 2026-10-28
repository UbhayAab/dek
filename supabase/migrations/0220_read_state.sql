-- 0220: read state, threads, mentions and the unread feed [msg] (CONTRACT 2.2).
-- Owner: msg builder. Re-runnable (create or replace).
--
-- Read positions are per person and per channel (channel_members.last_read_seq)
-- or per thread (thread_follows.last_read_reply_seq). Every change is announced on
-- the person's own u: topic only, so two tabs and a phone reconcile (DEKA10)
-- without anyone else hearing about it.

-- =====================================================================
-- Channel read position
-- =====================================================================

-- Monotonic: never moves back, never past the channel's last seq. A public
-- channel the caller reads without having joined has no read position: a no-op
-- that returns 0.
create or replace function api.mark_read(p_channel uuid, p_seq bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_last bigint;
  v_seq  bigint;
  v_now  bigint;
begin
  v_uid := dek.require_uid();
  perform dek.assert_read(v_uid, p_channel);
  if p_seq is null or p_seq < 0 then
    perform dek.err('invalid_input', 'p_seq must be a message sequence number.');
  end if;
  select st.last_seq into v_last from dek.channel_state st where st.channel_id = p_channel;
  v_seq := least(p_seq, coalesce(v_last, 0));
  update dek.channel_members cm
     set last_read_seq = v_seq, last_read_at = now()
   where cm.channel_id = p_channel and cm.user_id = v_uid and cm.last_read_seq < v_seq
  returning cm.last_read_seq into v_now;
  if v_now is not null then
    perform dek.emit_user(v_uid, 'read', jsonb_build_object('channel_id', p_channel, 'last_read_seq', v_now));
  else
    select cm.last_read_seq into v_now from dek.channel_members cm
     where cm.channel_id = p_channel and cm.user_id = v_uid;
  end if;
  perform dek.touch_active(v_uid);
  return jsonb_build_object('channel_id', p_channel, 'last_read_seq', coalesce(v_now, 0));
end $$;

-- "Mark unread from here": last_read_seq = p_seq - 1, which may move back.
create or replace function api.mark_unread(p_channel uuid, p_seq bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_last bigint;
  v_seq  bigint;
  v_now  bigint;
begin
  v_uid := dek.require_uid();
  perform dek.assert_read(v_uid, p_channel);
  if p_seq is null or p_seq < 1 then
    perform dek.err('invalid_input', 'p_seq must be a message sequence number.');
  end if;
  select st.last_seq into v_last from dek.channel_state st where st.channel_id = p_channel;
  v_seq := least(p_seq - 1, coalesce(v_last, 0));
  update dek.channel_members cm
     set last_read_seq = v_seq, last_read_at = now()
   where cm.channel_id = p_channel and cm.user_id = v_uid and cm.last_read_seq <> v_seq
  returning cm.last_read_seq into v_now;
  if v_now is not null then
    perform dek.emit_user(v_uid, 'read', jsonb_build_object('channel_id', p_channel, 'last_read_seq', v_now));
  else
    select cm.last_read_seq into v_now from dek.channel_members cm
     where cm.channel_id = p_channel and cm.user_id = v_uid;
  end if;
  return jsonb_build_object('channel_id', p_channel, 'last_read_seq', coalesce(v_now, 0));
end $$;

-- Every membership of the caller in the org, read to its last seq. The read
-- events go out for the 50 most recently active of them (each broadcast is a
-- subtransaction; 50 stays under the 64 a transaction caches).
create or replace function api.mark_all_read(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_count int;
  v_ids   uuid[];
  v_seqs  bigint[];
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  with upd as (
    update dek.channel_members cm
       set last_read_seq = st.last_seq, last_read_at = now()
      from dek.channel_state st
     where st.channel_id = cm.channel_id
       and cm.user_id = v_uid and cm.org_id = p_org
       and cm.last_read_seq < st.last_seq
    returning cm.channel_id, cm.last_read_seq, st.last_message_at)
  select count(*)::int,
         coalesce(array_agg(upd.channel_id order by upd.last_message_at desc nulls last, upd.channel_id), '{}'),
         coalesce(array_agg(upd.last_read_seq order by upd.last_message_at desc nulls last, upd.channel_id), '{}')
    into v_count, v_ids, v_seqs
    from upd;
  for i in 1 .. least(v_count, 50) loop
    perform dek.emit_user(v_uid, 'read', jsonb_build_object('channel_id', v_ids[i], 'last_read_seq', v_seqs[i]));
  end loop;
  return jsonb_build_object('count', v_count);
end $$;

-- =====================================================================
-- Threads
-- =====================================================================

create or replace function api.follow_thread(p_root uuid, p_follow boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_root dek.messages;
begin
  v_uid := dek.require_uid();
  v_root := dek.msg_get(v_uid, p_root);
  if v_root.thread_root_id is not null then
    perform dek.err('invalid_input', 'That message is a reply. Follow the thread of its first message.');
  end if;
  if p_follow is null then
    perform dek.err('invalid_input', 'p_follow must be true or false.');
  end if;
  -- a new follow starts read up to the latest reply (following is not "mark all
  -- replies unread"); an existing row keeps its read position
  insert into dek.thread_follows as tf (root_id, user_id, channel_id, org_id, following, last_read_reply_seq)
  values (v_root.id, v_uid, v_root.channel_id, v_root.org_id, p_follow,
          coalesce((select max(x.seq) from dek.messages x where x.thread_root_id = v_root.id), 0))
  on conflict (root_id, user_id) do update
    set following = excluded.following, updated_at = now()
  where tf.following is distinct from excluded.following;
  return jsonb_build_object('root_id', v_root.id, 'following', p_follow);
end $$;

-- Monotonic, never past the channel's last seq. Read position lives on the follow
-- row; a thread the caller never followed has none (0), and reading it does not
-- create one (a follow row with following = false means "unfollowed on purpose").
create or replace function api.mark_thread_read(p_root uuid, p_seq bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_root dek.messages;
  v_last bigint;
  v_seq  bigint;
  v_now  bigint;
begin
  v_uid := dek.require_uid();
  v_root := dek.msg_get(v_uid, p_root);
  if v_root.thread_root_id is not null then
    perform dek.err('invalid_input', 'That message is a reply. Use the thread of its first message.');
  end if;
  if p_seq is null or p_seq < 0 then
    perform dek.err('invalid_input', 'p_seq must be a message sequence number.');
  end if;
  select st.last_seq into v_last from dek.channel_state st where st.channel_id = v_root.channel_id;
  v_seq := least(p_seq, coalesce(v_last, 0));
  update dek.thread_follows tf
     set last_read_reply_seq = v_seq, updated_at = now()
   where tf.root_id = v_root.id and tf.user_id = v_uid and tf.last_read_reply_seq < v_seq
  returning tf.last_read_reply_seq into v_now;
  if v_now is not null then
    perform dek.emit_user(v_uid, 'read', jsonb_build_object('root_id', v_root.id, 'last_read_reply_seq', v_now));
  else
    select tf.last_read_reply_seq into v_now from dek.thread_follows tf
     where tf.root_id = v_root.id and tf.user_id = v_uid;
  end if;
  return jsonb_build_object('root_id', v_root.id, 'last_read_reply_seq', coalesce(v_now, 0));
end $$;

-- Followed threads in channels the caller can still read, newest activity first.
create or replace function api.list_threads(p_org uuid, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid      uuid;
  v_limit    int;
  v_readable uuid[];
  v_out      jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  v_limit := dek.msg_limit(p_limit, 30, 100);
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  with top as (
    select r as root, tf.last_read_reply_seq as lrs
      from dek.thread_follows tf
      join dek.messages r on r.id = tf.root_id
     where tf.user_id = v_uid and tf.org_id = p_org and tf.following
       and tf.channel_id = any(v_readable)
       and (r.deleted_at is null or r.reply_count > 0)   -- not a deleted, emptied thread
     order by r.last_reply_at desc nulls last, r.id desc
     limit v_limit
  ), chans as (
    select c.id, dek.channel_json(c, v_uid) as j
      from dek.channels c where c.id = any(array(select distinct (top.root).channel_id from top))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'root', dek.message_json(top.root),
           'channel', chans.j,
           'unread_replies', (select count(*) from (
               select 1 from dek.messages x
                where x.thread_root_id = (top.root).id and x.seq > top.lrs
                  and x.deleted_at is null and x.author_id is distinct from v_uid
                limit 100) n),
           'last_reply_at', (top.root).last_reply_at)
         order by (top.root).last_reply_at desc nulls last, (top.root).id desc), '[]'::jsonb)
    into v_out
    from top join chans on chans.id = (top.root).channel_id;
  return jsonb_build_object('threads', v_out);
end $$;

-- =====================================================================
-- Mentions: direct mentions in channels the caller can read, plus <!channel> and
-- <!here> messages in channels the caller is a member of. Newest first, paged by
-- the message time (a mention added by an edit is dated like its message).
-- =====================================================================

create or replace function api.list_mentions(p_org uuid, p_before timestamptz default null, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid      uuid;
  v_limit    int;
  v_before   timestamptz := coalesce(p_before, 'infinity'::timestamptz);
  v_readable uuid[];
  v_rows     dek.messages[];
  v_out      jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  v_limit := dek.msg_limit(p_limit, 30, 100);
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  v_rows := array(
    select x from dek.messages x
     where x.id in (
             select y.id from (
               (select mn.message_id as id from dek.mentions mn
                 where mn.user_id = v_uid and mn.org_id = p_org and mn.created_at < v_before
                   and mn.channel_id = any(v_readable)
                 order by mn.created_at desc
                 limit v_limit + 1)
               union
               (select a.id
                  from dek.channel_members cm
                  cross join lateral (
                    select m.id from dek.messages m
                     where m.channel_id = cm.channel_id and m.mention_all and m.deleted_at is null
                       and m.author_id is distinct from v_uid and m.created_at < v_before
                     order by m.seq desc
                     limit v_limit + 1) a
                 where cm.user_id = v_uid and cm.org_id = p_org)) y)
       and x.deleted_at is null
     order by x.created_at desc, x.id desc
     limit v_limit + 1);
  with items as (
    select i as ord, v_rows[i] as msg from generate_subscripts(v_rows, 1) i where i <= v_limit
  ), chans as (
    select c.id, dek.channel_json(c, v_uid) as j
      from dek.channels c where c.id = any(array(select distinct (items.msg).channel_id from items))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'message', dek.message_json(items.msg),
           'channel', chans.j,
           -- a public channel never joined has no read position and cannot get one
           -- (mark_read is a no-op there), so its mentions count as read, as in
           -- Channel.mentions
           'read', coalesce((
               select (items.msg).seq <= cm.last_read_seq from dek.channel_members cm
                where cm.channel_id = (items.msg).channel_id and cm.user_id = v_uid), true))
         order by items.ord), '[]'::jsonb)
    into v_out
    from items join chans on chans.id = (items.msg).channel_id;
  return jsonb_build_object('items', v_out, 'has_more', cardinality(v_rows) > v_limit);
end $$;

-- =====================================================================
-- Unread feed: joined, unhidden, not muted-to-none channels with unread messages,
-- most recently active first, each with its newest unread top-level messages from
-- other people. Same filter as OrgSummary.unread_channels. Bounded to about 600
-- messages in all: 30 channels at the default 20 per channel, at most 50 channels.
-- =====================================================================

create or replace function api.unread_feed(p_org uuid, p_limit_per_channel int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid      uuid;
  v_limit    int;
  v_channels int;
  v_out      jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  v_limit := dek.msg_limit(p_limit_per_channel, 20, 50);
  v_channels := least(50, 600 / v_limit);
  select coalesce(jsonb_agg(jsonb_build_object('channel', dek.channel_json(u.ch, v_uid), 'messages', u.msgs)
                            order by u.last_message_at desc nulls last, (u.ch).id), '[]'::jsonb)
    into v_out
    from (
      select c as ch, st.last_message_at,
             dek.msg_json_list(array(
               select x from dek.messages x
                where x.channel_id = c.id and x.in_timeline and x.seq > cm.last_read_seq
                  and x.deleted_at is null and x.author_id is distinct from v_uid
                order by x.seq desc
                limit v_limit)) as msgs
        from dek.channel_members cm
        join dek.channel_state st on st.channel_id = cm.channel_id
        join dek.channels c on c.id = cm.channel_id
       where cm.user_id = v_uid and cm.org_id = p_org and not cm.hidden and cm.notify <> 'none'
         and st.last_top_seq > cm.last_read_seq
       order by st.last_message_at desc nulls last, c.id
       limit v_channels) u
   where jsonb_array_length(u.msgs) > 0;
  return jsonb_build_object('channels', v_out);
end $$;
