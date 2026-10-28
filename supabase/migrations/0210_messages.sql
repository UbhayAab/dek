-- 0210: messages [msg] (CONTRACT 2.2): send, edit, delete, react, history, threads
-- and reconnect sync. Owner: msg builder. Re-runnable (create or replace).
--
-- Durability (ARCHITECTURE section 5, DEK06, DEKA03): a message is accepted only
-- when send_message commits; a retry with the same client_id returns the original
-- row and seq; the per-channel seq comes from dek.allocate_seq, whose row lock is
-- held to commit, so every cheap validation runs before it.

-- =====================================================================
-- api.send_message
-- =====================================================================

create or replace function api.send_message(
  p_channel uuid, p_client_id uuid, p_body text, p_thread_root uuid default null,
  p_attachment_ids uuid[] default '{}', p_also_in_channel boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid;
  v_body     text;
  v_att      uuid[];
  v_ok       uuid[];
  v_reply    boolean := p_thread_root is not null;
  v_also     boolean;
  v_in_tl    boolean;
  v_mentions uuid[];
  v_notify   uuid[];
  v_all      boolean := false;
  v_ch       dek.channels;
  v_root     dek.messages;
  v_msg      dek.messages;
  v_json     jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.rate_hit(v_uid, 'send', 30, 10);

  if p_client_id is null then
    perform dek.err('invalid_input', 'client_id is required, so a retry can never post twice.');
  end if;
  v_body := dek.msg_trim(p_body);
  v_att := array(select distinct a from unnest(coalesce(p_attachment_ids, '{}'::uuid[])) a where a is not null);
  if cardinality(v_att) > 10 then
    perform dek.err('invalid_input', 'A message can carry at most 10 attachments.');
  end if;
  if char_length(v_body) > 8000 then
    perform dek.err('invalid_input', 'A message can be at most 8000 characters.');
  end if;
  if v_body = '' and cardinality(v_att) = 0 then
    perform dek.err('invalid_input', 'Write a message or attach a file.');
  end if;

  -- Idempotency first. The transaction lock on the client_id makes two copies of
  -- one send that arrive together queue here: the second finds the first and
  -- returns it, without an error and without burning a seq.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_client_id::text, 7314200));
  select * into v_msg from dek.messages where author_id = v_uid and client_id = p_client_id;
  if found then
    if v_msg.channel_id is distinct from p_channel then
      perform dek.err('conflict', 'That client_id was already used for a message in another conversation.');
    end if;
    perform dek.assert_read(v_uid, v_msg.channel_id);
    return dek.message_json(v_msg);
  end if;

  v_ch := dek.assert_post(v_uid, p_channel, v_reply);
  v_also := v_reply and coalesce(p_also_in_channel, false);
  if v_also and v_ch.posting_policy = 'admins' and not dek.can_moderate_channel(v_uid, v_ch.id) then
    perform dek.err('forbidden', 'Only admins can post in this channel, so a reply cannot also go to the channel.');
  end if;

  if v_reply then
    select * into v_root from dek.messages where id = p_thread_root;
    if v_root.id is null or v_root.channel_id <> v_ch.id then
      perform dek.err('not_found', 'That thread does not exist in this conversation.');
    end if;
    if v_root.thread_root_id is not null then
      perform dek.err('invalid_input', 'Reply to the first message of the thread.');
    end if;
    -- Lock the root now, before the sequence lock: if a reaction, edit or pin holds
    -- it, this send waits here without stalling every other send in the channel.
    -- NO KEY UPDATE leaves the KEY SHARE locks of foreign key checks unblocked.
    select * into v_root from dek.messages where id = v_root.id for no key update;
    if v_root.deleted_at is not null then
      perform dek.err('conflict', 'That message was deleted.');
    end if;
  end if;

  if cardinality(v_att) > 0 then
    -- locked (in id order) so a concurrent send cannot claim the same file
    v_ok := array(
      select a.id from dek.attachments a
       where a.id = any(v_att) and a.status = 'ready' and a.uploader_id = v_uid
         and a.channel_id = v_ch.id and a.message_id is null
       order by a.id
       for update);
    if cardinality(v_ok) <> cardinality(v_att) then
      perform dek.err('invalid_input',
        'An attachment is still uploading, was not uploaded by you to this conversation, or is already in a message.');
    end if;
  end if;

  v_mentions := dek.msg_parse_mentions(v_body, v_ch.id);
  if dek.msg_wants_all(v_body) then
    v_all := dek.msg_may_mention_all(v_uid, v_ch.id);
  end if;
  -- mention rows (inbox, badges, push): not the author, and not people who blocked
  -- the author (a blocked person's mentions do not notify, CONTRACT 2.5)
  v_notify := array(
    select u from unnest(v_mentions) u
     where u <> v_uid
       and not exists (select 1 from dek.user_blocks b where b.blocker_id = u and b.blocked_id = v_uid));
  v_in_tl := not v_reply or v_also;

  -- From here this channel's channel_state row is locked until commit. Everything
  -- below is bounded: one insert, at most 100 mentions, 10 files, the root update
  -- (its row is already ours), at most 100 follows, one intent, and two broadcasts.
  -- A broadcast is one realtime row per member for private channels and DMs
  -- (dek.emit_channel), so its size follows the channel's membership.
  insert into dek.messages (org_id, channel_id, seq, thread_root_id, in_timeline, also_in_channel,
                            author_id, kind, body, mentions, mention_all, client_id, attachment_count)
  values (v_ch.org_id, v_ch.id, dek.allocate_seq(v_ch.id, v_in_tl), p_thread_root, v_in_tl, v_also,
          v_uid, 'user', v_body, v_mentions, v_all, p_client_id, cardinality(v_att))
  returning * into v_msg;

  if cardinality(v_notify) > 0 then
    insert into dek.mentions (message_id, user_id, channel_id, org_id, seq, created_at)
    select v_msg.id, u, v_ch.id, v_ch.org_id, v_msg.seq, v_msg.created_at from unnest(v_notify) u;
  end if;

  if cardinality(v_att) > 0 then
    update dek.attachments set message_id = v_msg.id where id = any(v_att);
  end if;

  if v_reply then
    update dek.messages x
       set reply_count = x.reply_count + 1,
           last_reply_at = v_msg.created_at,
           reply_user_ids = (array[v_uid] || array(select u from unnest(x.reply_user_ids) u where u <> v_uid))[1:5],
           updated_at = now()
     where x.id = v_root.id
    returning * into v_root;
    -- the author follows and has read up to their own reply
    insert into dek.thread_follows as tf (root_id, user_id, channel_id, org_id, following, last_read_reply_seq)
    values (v_root.id, v_uid, v_ch.id, v_ch.org_id, true, v_msg.seq)
    on conflict (root_id, user_id) do update
      set last_read_reply_seq = greatest(tf.last_read_reply_seq, excluded.last_read_reply_seq),
          updated_at = now();
    -- the root author and the people mentioned follow, unless they unfollowed
    insert into dek.thread_follows (root_id, user_id, channel_id, org_id)
    select v_root.id, f.u, v_ch.id, v_ch.org_id
      from (select v_root.author_id as u
             where v_root.author_id is not null and v_root.author_id <> v_uid
               and dek.can_read_channel(v_root.author_id, v_ch.id)
            union
            select u from unnest(v_notify) u) f
    on conflict (root_id, user_id) do nothing;
  end if;

  -- own messages are never unread (a reply outside the timeline leaves the
  -- channel's read position alone: posting in a thread is not reading the channel)
  if v_in_tl then
    update dek.channel_members
       set last_read_seq = v_msg.seq, last_read_at = now()
     where channel_id = v_ch.id and user_id = v_uid and last_read_seq < v_msg.seq;
  end if;

  if v_ch.kind in ('dm', 'group_dm') then
    update dek.channel_members set hidden = false where channel_id = v_ch.id and hidden;
  end if;

  perform dek.enqueue_intent('message', v_ch.org_id, v_msg.id, v_ch.id, null, v_uid);
  v_json := dek.message_json(v_msg);
  perform dek.emit_channel(v_ch.id, 'msg.new', jsonb_build_object('message', v_json));
  if v_reply then
    perform dek.emit_channel(v_ch.id, 'msg.upd', jsonb_build_object('message', dek.message_json(v_root)));
  end if;
  perform dek.touch_active(v_uid);
  return v_json;
end $$;

-- =====================================================================
-- api.edit_message
-- =====================================================================

create or replace function api.edit_message(p_message uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid;
  v_msg      dek.messages;
  v_ch       dek.channels;
  v_org      dek.orgs;
  v_body     text;
  v_window   int;
  v_mentions uuid[];
  v_new      uuid[];
  v_all      boolean := false;
  v_new_all  boolean;
  v_json     jsonb;
begin
  v_uid := dek.require_uid();
  -- edits can add mentions, and mentions notify: bounded like sending
  perform dek.rate_hit(v_uid, 'edit', 30, 60);
  v_msg := dek.msg_get(v_uid, p_message);
  if v_msg.author_id is distinct from v_uid then
    perform dek.err('forbidden', 'You can only edit your own messages.');
  end if;
  if v_msg.deleted_at is not null then
    perform dek.err('conflict', 'That message was deleted.');
  end if;
  v_body := dek.msg_trim(p_body);
  if char_length(v_body) > 8000 then
    perform dek.err('invalid_input', 'A message can be at most 8000 characters.');
  end if;
  if v_body = '' and v_msg.attachment_count = 0 then
    perform dek.err('invalid_input', 'A message without files cannot be empty. Delete it instead.');
  end if;
  if v_body = v_msg.body then
    return dek.message_json(v_msg);   -- a retried edit, or nothing changed
  end if;
  v_ch := dek.assert_post(v_uid, v_msg.channel_id, v_msg.thread_root_id is not null);
  select * into v_org from dek.orgs where id = v_msg.org_id;
  v_window := (dek.org_settings(v_org) ->> 'edit_window_minutes')::int;
  if v_window is not null and v_msg.created_at < now() - make_interval(mins => v_window) then
    perform dek.err('forbidden', format('Messages can only be edited for %s minutes after sending.', v_window));
  end if;

  -- NO KEY UPDATE: a reply being inserted under this root only needs KEY SHARE
  select * into v_msg from dek.messages where id = v_msg.id for no key update;
  if v_msg.deleted_at is not null then
    perform dek.err('conflict', 'That message was deleted.');
  end if;

  v_mentions := dek.msg_parse_mentions(v_body, v_ch.id);
  if dek.msg_wants_all(v_body) then
    v_all := dek.msg_may_mention_all(v_uid, v_ch.id);
  end if;
  -- Mention rows are append-only per message: a person mentioned once keeps the
  -- mention (inbox, badge) even if a later edit drops the token, and is never
  -- notified twice for the same message, however often an edit removes and re-adds
  -- them. "New" therefore means "has no mention row for this message yet".
  v_new := array(
    select u from unnest(v_mentions) u
     where u <> v_uid
       and not exists (select 1 from dek.mentions mn where mn.message_id = v_msg.id and mn.user_id = u)
       and not exists (select 1 from dek.user_blocks b where b.blocker_id = u and b.blocked_id = v_uid));
  v_new_all := v_all and not v_msg.mention_all;

  -- new rows are dated like the message, so the mentions list stays in message order
  if cardinality(v_new) > 0 then
    insert into dek.mentions (message_id, user_id, channel_id, org_id, seq, created_at)
    select v_msg.id, u, v_msg.channel_id, v_msg.org_id, v_msg.seq, v_msg.created_at from unnest(v_new) u
    on conflict (message_id, user_id) do nothing;
    if v_msg.thread_root_id is not null then
      insert into dek.thread_follows (root_id, user_id, channel_id, org_id)
      select v_msg.thread_root_id, u, v_msg.channel_id, v_msg.org_id from unnest(v_new) u
      on conflict (root_id, user_id) do nothing;
    end if;
  end if;

  update dek.messages
     set body = v_body, mentions = v_mentions, mention_all = v_all, edited_at = now(), updated_at = now()
   where id = v_msg.id
  returning * into v_msg;

  -- Only new mentions notify: one intent aimed at each newly mentioned person (the
  -- dispatcher sends a targeted intent to that person alone, read or not), for the
  -- first 20 of them, and one untargeted intent when <!channel> / <!here> was newly
  -- added. Each intent's dispatch trigger is a subtransaction, so 21 keeps a single
  -- edit well under the 64 a transaction caches; later ones still get the mention.
  if v_new_all then
    perform dek.enqueue_intent('message', v_msg.org_id, v_msg.id, v_msg.channel_id, null, v_uid);
  end if;
  perform dek.enqueue_intent('message', v_msg.org_id, v_msg.id, v_msg.channel_id, null, v_uid, u)
     from unnest(v_new[1:20]) u;
  v_json := dek.message_json(v_msg);
  perform dek.emit_channel(v_msg.channel_id, 'msg.upd', jsonb_build_object('message', v_json));
  return v_json;
end $$;

-- =====================================================================
-- api.delete_message: the author deletes their own; a moderator of the channel
-- deletes anyone's (kept in audit_log by dek.soft_delete_message).
-- =====================================================================

create or replace function api.delete_message(p_message uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_msg dek.messages;
  v_ch  dek.channels;
  v_mod boolean;
begin
  v_uid := dek.require_uid();
  v_msg := dek.msg_get(v_uid, p_message);
  if v_msg.deleted_at is not null then
    return dek.message_json(v_msg);
  end if;
  v_mod := dek.can_moderate_channel(v_uid, v_msg.channel_id);
  if v_msg.author_id = v_uid then
    if not v_mod then
      select * into v_ch from dek.channels where id = v_msg.channel_id;
      if dek.msg_archived(v_ch) then
        perform dek.err('archived', 'This conversation is archived and read only.');
      end if;
    end if;
    v_msg := dek.soft_delete_message(v_msg.id, v_uid, null, false);
  elsif v_mod then
    v_msg := dek.soft_delete_message(v_msg.id, v_uid,
      left(nullif(btrim(coalesce(p_reason, '')), ''), 500), true);
  else
    perform dek.err('forbidden', 'You can only delete your own messages.');
  end if;
  return dek.message_json(v_msg);
end $$;

-- =====================================================================
-- api.toggle_reaction
-- =====================================================================

create or replace function api.toggle_reaction(p_message uuid, p_emoji text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid;
  v_msg     dek.messages;
  v_ch      dek.channels;
  v_emoji   text;
  v_changed int := 0;
begin
  v_uid := dek.require_uid();
  perform dek.rate_hit(v_uid, 'react', 60, 60);
  v_emoji := btrim(coalesce(p_emoji, ''));
  if char_length(v_emoji) not between 1 and 64 or v_emoji ~ '[\x01-\x1F\x7F]' then
    perform dek.err('invalid_input', 'A reaction is 1 to 64 characters of emoji text.');
  end if;
  if p_on is null then
    perform dek.err('invalid_input', 'p_on must be true or false.');
  end if;
  v_msg := dek.msg_get(v_uid, p_message);
  select * into v_ch from dek.channels where id = v_msg.channel_id;
  if not v_ch.allow_reactions then
    perform dek.err('forbidden', 'Reactions are turned off in this channel.');
  end if;
  perform dek.msg_assert_open(v_uid, v_ch);

  -- reactions on one message are serialized on its row, so the rebuilt map below
  -- always sees every committed reaction (no lost update between two people)
  select * into v_msg from dek.messages where id = v_msg.id for no key update;
  if v_msg.deleted_at is not null then
    perform dek.err('conflict', 'That message was deleted.');
  end if;

  if p_on then
    if not exists (select 1 from dek.reactions r where r.message_id = v_msg.id and r.emoji = v_emoji)
       and (select count(distinct r.emoji) from dek.reactions r where r.message_id = v_msg.id) >= 20 then
      perform dek.err('invalid_input', 'A message can have at most 20 different reactions.');
    end if;
    insert into dek.reactions (message_id, emoji, user_id, channel_id, org_id)
    values (v_msg.id, v_emoji, v_uid, v_msg.channel_id, v_msg.org_id)
    on conflict (message_id, emoji, user_id) do nothing;
    get diagnostics v_changed = row_count;
  else
    delete from dek.reactions r where r.message_id = v_msg.id and r.emoji = v_emoji and r.user_id = v_uid;
    get diagnostics v_changed = row_count;
  end if;

  if v_changed > 0 then
    update dek.messages x
       set reactions = coalesce((
             select jsonb_object_agg(g.emoji, g.users)
               from (select r.emoji, jsonb_agg(r.user_id order by r.created_at, r.user_id) as users
                       from dek.reactions r where r.message_id = x.id
                      group by r.emoji) g), '{}'::jsonb),
           updated_at = now()
     where x.id = v_msg.id
    returning * into v_msg;
    perform dek.emit_channel(v_msg.channel_id, 'msg.upd', jsonb_build_object('message', dek.message_json(v_msg)));
  end if;
  return jsonb_build_object('message_id', v_msg.id, 'reactions', v_msg.reactions);
end $$;

-- =====================================================================
-- History. Deleted messages stay hidden unless they still anchor a thread
-- (reply_count > 0), where they show as tombstones.
-- =====================================================================

create or replace function api.list_messages(p_channel uuid, p_before_seq bigint default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_limit int;
  v_last  bigint;
  v_rows  dek.messages[];
begin
  v_uid := dek.require_uid();
  perform dek.assert_read(v_uid, p_channel);
  v_limit := dek.msg_limit(p_limit, 50, 100);
  select st.last_seq into v_last from dek.channel_state st where st.channel_id = p_channel;
  v_rows := array(
    select x from dek.messages x
     where x.channel_id = p_channel and x.in_timeline
       and x.seq < coalesce(p_before_seq, 9223372036854775807)
       and (x.deleted_at is null or x.reply_count > 0)
     order by x.seq desc
     limit v_limit + 1);
  return jsonb_build_object(
    'messages', dek.msg_json_list(v_rows[1:v_limit]),
    'has_more', cardinality(v_rows) > v_limit,
    'last_seq', coalesce(v_last, 0));
end $$;

create or replace function api.list_messages_around(p_channel uuid, p_seq bigint, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_limit  int;
  v_nb     int;
  v_na     int;
  v_last   bigint;
  v_before dek.messages[];
  v_after  dek.messages[];
begin
  v_uid := dek.require_uid();
  perform dek.assert_read(v_uid, p_channel);
  if p_seq is null then
    perform dek.err('invalid_input', 'p_seq is required.');
  end if;
  v_limit := dek.msg_limit(p_limit, 50, 100);
  v_nb := v_limit / 2;
  v_na := v_limit - v_nb;
  select st.last_seq into v_last from dek.channel_state st where st.channel_id = p_channel;
  v_before := array(
    select x from dek.messages x
     where x.channel_id = p_channel and x.in_timeline and x.seq < p_seq
       and (x.deleted_at is null or x.reply_count > 0)
     order by x.seq desc
     limit v_nb + 1);
  v_after := array(
    select x from dek.messages x
     where x.channel_id = p_channel and x.in_timeline and x.seq >= p_seq
       and (x.deleted_at is null or x.reply_count > 0)
     order by x.seq
     limit v_na + 1);
  return jsonb_build_object(
    'messages', dek.msg_json_list(coalesce(v_before[1:v_nb], '{}') || coalesce(v_after[1:v_na], '{}')),
    'has_more_before', cardinality(v_before) > v_nb,
    'has_more_after', cardinality(v_after) > v_na,
    'last_seq', coalesce(v_last, 0));
end $$;

-- Deep links and search jumps. not_found for anything the caller cannot read.
create or replace function api.get_message_context(p_message uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_msg  dek.messages;
  v_ch   dek.channels;
  v_root dek.messages;
begin
  v_uid := dek.require_uid();
  v_msg := dek.msg_get(v_uid, p_message);
  select * into v_ch from dek.channels where id = v_msg.channel_id;
  if v_msg.thread_root_id is not null then
    select * into v_root from dek.messages where id = v_msg.thread_root_id;
  end if;
  return jsonb_build_object(
    'channel', dek.channel_json(v_ch, v_uid),
    'message', dek.message_json(v_msg),
    'thread_root', case when v_root.id is null then null else dek.message_json(v_root) end);
end $$;

create or replace function api.list_thread(p_root uuid, p_after_seq bigint default 0, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_root   dek.messages;
  v_limit  int;
  v_rows   dek.messages[];
  v_follow dek.thread_follows;
begin
  v_uid := dek.require_uid();
  v_root := dek.msg_get(v_uid, p_root);
  if v_root.thread_root_id is not null then
    perform dek.err('invalid_input', 'That message is a reply. Open the thread of its first message.');
  end if;
  v_limit := dek.msg_limit(p_limit, 100, 100);
  v_rows := array(
    select x from dek.messages x
     where x.thread_root_id = v_root.id and x.seq > coalesce(p_after_seq, 0) and x.deleted_at is null
     order by x.seq
     limit v_limit + 1);
  select * into v_follow from dek.thread_follows tf where tf.root_id = v_root.id and tf.user_id = v_uid;
  return jsonb_build_object(
    'root', dek.message_json(v_root),
    'replies', dek.msg_json_list(v_rows[1:v_limit]),
    'has_more', cardinality(v_rows) > v_limit,
    'following', coalesce(v_follow.following, false),
    'last_read_reply_seq', coalesce(v_follow.last_read_reply_seq, 0));
end $$;

-- =====================================================================
-- api.sync_channel (DEK07): what happened while the client was away, by cursor.
-- new: seq > after_seq (timeline and thread replies, tombstones included so the
-- client can drop what it held). changed: updated_at > changed_since within the
-- window the client holds (min_seq..after_seq). Both stop at 200; truncated tells
-- the client to drop its cache for the channel and reload the newest page.
-- The client should pass changed_since a little before the server_time it last
-- saw (30 s covers any transaction still in flight then).
-- =====================================================================

create or replace function api.sync_channel(p_channel uuid, p_after_seq bigint, p_changed_since timestamptz,
                                            p_min_seq bigint default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_after bigint := greatest(coalesce(p_after_seq, 0), 0);
  v_min   bigint := greatest(coalesce(p_min_seq, 0), 0);
  v_since timestamptz := coalesce(p_changed_since, '-infinity'::timestamptz);
  v_last  bigint;
  v_new   dek.messages[];
  v_chg   dek.messages[];
begin
  v_uid := dek.require_uid();
  perform dek.assert_read(v_uid, p_channel);
  select st.last_seq into v_last from dek.channel_state st where st.channel_id = p_channel;
  v_new := array(
    select x from dek.messages x
     where x.channel_id = p_channel and x.seq > v_after
     order by x.seq
     limit 201);
  if v_after - v_min <= 1000 then
    -- a small held window: walk it by seq
    v_chg := array(
      select x from dek.messages x
       where x.channel_id = p_channel and x.seq between v_min and v_after and x.updated_at > v_since
       order by x.seq
       limit 201);
  else
    -- a large window: walk the changes since the watermark instead
    v_chg := array(
      select x from dek.messages x
       where x.channel_id = p_channel and x.updated_at > v_since and x.seq between v_min and v_after
       order by x.updated_at, x.seq
       limit 201);
  end if;
  return jsonb_build_object(
    'new', dek.msg_json_list(v_new[1:200]),
    'changed', dek.msg_json_list(v_chg[1:200]),
    'last_seq', coalesce(v_last, 0),
    'truncated', cardinality(v_new) > 200 or cardinality(v_chg) > 200);
end $$;
