-- Additive inbox APIs: old clients keep list_threads/list_mentions unchanged.
-- Stable (activity time, id) cursors prevent equal-time messages being skipped.
create index if not exists messages_mention_inbox_idx
  on dek.messages (channel_id, created_at desc, id desc)
  where mention_all and deleted_at is null;
create index if not exists mentions_inbox_idx
  on dek.mentions (user_id, org_id, created_at desc, message_id desc);
create or replace function api.list_thread_inbox(
  p_org uuid, p_before timestamptz default null, p_before_id uuid default null,
  p_unread_only boolean default false, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_limit int;
  v_readable uuid[];
  v_out jsonb;
  v_more boolean;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  v_limit := dek.msg_limit(p_limit, 30, 100);
  if (p_before is null) <> (p_before_id is null) or p_unread_only is null then
    perform dek.err('invalid_input', 'Use a complete page cursor and an unread choice.');
  end if;
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  with candidates as materialized (
    select r as root, tf.last_read_reply_seq as lrs,
           coalesce(r.last_reply_at, r.created_at) as activity_at
      from dek.thread_follows tf join dek.messages r on r.id = tf.root_id
     where tf.user_id = v_uid and tf.org_id = p_org and tf.following
       and tf.channel_id = any(v_readable)
       and (r.deleted_at is null or r.reply_count > 0)
       and (p_before is null or (coalesce(r.last_reply_at, r.created_at), r.id) < (p_before, p_before_id))
       and (not p_unread_only or exists (
         select 1 from dek.messages x where x.thread_root_id = r.id
           and x.seq > tf.last_read_reply_seq and x.deleted_at is null
           and x.author_id is distinct from v_uid))
     order by coalesce(r.last_reply_at, r.created_at) desc, r.id desc
     limit v_limit + 1
  ), page as (
    select * from candidates order by activity_at desc, (root).id desc limit v_limit
  ), chans as (
    select c.id, dek.channel_json(c, v_uid) as j from dek.channels c
     where c.id = any(array(select distinct (page.root).channel_id from page))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'root', dek.message_json(page.root), 'channel', chans.j,
      'activity_at', page.activity_at, 'last_reply_at', (page.root).last_reply_at,
      'last_reply_seq', coalesce((select x.seq from dek.messages x
        where x.thread_root_id = (page.root).id and x.deleted_at is null order by x.seq desc limit 1), 0),
      'unread_replies', (select count(*) from (
        select 1 from dek.messages x where x.thread_root_id = (page.root).id
          and x.seq > page.lrs and x.deleted_at is null and x.author_id is distinct from v_uid limit 100) n))
      order by page.activity_at desc, (page.root).id desc), '[]'::jsonb),
      (select count(*) > v_limit from candidates)
    into v_out, v_more from page join chans on chans.id = (page.root).channel_id;
  return jsonb_build_object('items', v_out, 'has_more', v_more);
end $$;

create or replace function api.list_mention_inbox(
  p_org uuid, p_before timestamptz default null, p_before_id uuid default null,
  p_unread_only boolean default false, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_limit int;
  v_readable uuid[];
  v_rows dek.messages[];
  v_out jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  v_limit := dek.msg_limit(p_limit, 30, 100);
  if (p_before is null) <> (p_before_id is null) or p_unread_only is null then
    perform dek.err('invalid_input', 'Use a complete page cursor and an unread choice.');
  end if;
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  v_rows := array(
    select x from dek.messages x where x.id in (
      select ids.id from (
        (select m.id from dek.mentions mn join dek.messages m on m.id = mn.message_id
          left join dek.channel_members cm on cm.channel_id = m.channel_id and cm.user_id = v_uid
         where mn.user_id = v_uid and mn.org_id = p_org and mn.channel_id = any(v_readable)
           and m.deleted_at is null
           and (p_before is null or (mn.created_at, mn.message_id) < (p_before, p_before_id))
           and (not p_unread_only or m.seq > cm.last_read_seq)
         order by mn.created_at desc, mn.message_id desc limit v_limit + 1)
        union
        (select a.id from dek.channel_members cm cross join lateral (
           select m.id from dek.messages m
            where m.channel_id = cm.channel_id and m.mention_all and m.deleted_at is null
              and m.author_id is distinct from v_uid
              and (p_before is null or (m.created_at, m.id) < (p_before, p_before_id))
              and (not p_unread_only or m.seq > cm.last_read_seq)
            order by m.created_at desc, m.id desc limit v_limit + 1) a
         where cm.user_id = v_uid and cm.org_id = p_org and cm.channel_id = any(v_readable))
      ) ids) order by x.created_at desc, x.id desc limit v_limit + 1);
  with page as (
    select i as ord, v_rows[i] as msg from generate_subscripts(v_rows, 1) i where i <= v_limit
  ), chans as (
    select c.id, dek.channel_json(c, v_uid) as j from dek.channels c
     where c.id = any(array(select distinct (page.msg).channel_id from page))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'message', dek.message_json(page.msg), 'channel', chans.j,
      'read', coalesce((select (page.msg).seq <= cm.last_read_seq from dek.channel_members cm
        where cm.channel_id = (page.msg).channel_id and cm.user_id = v_uid), true))
      order by page.ord), '[]'::jsonb)
    into v_out from page join chans on chans.id = (page.msg).channel_id;
  return jsonb_build_object('items', v_out, 'has_more', cardinality(v_rows) > v_limit);
end $$;
