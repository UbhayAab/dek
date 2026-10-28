-- Do not execute per-message receipt/view security-definer functions across history.
-- Cleared is driven by private caller receipts; normal pages join the same state.
create index activity_states_cleared_idx on dek.activity_states(user_id,kind,org_id) where cleared_at is not null;
create or replace function dek.activity_mentions(
  p_org uuid, p_before timestamptz default null, p_before_id uuid default null,
  p_view text default 'all', p_limit int default 30)
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
  if (p_before is null) <> (p_before_id is null) or p_view is null or p_view not in ('all','unread','cleared') then
    perform dek.err('invalid_input', 'Use a complete page cursor and an unread choice.');
  end if;
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  if p_view='cleared' then
    v_rows:=array(select m from dek.activity_states a join dek.messages m on m.id=a.target_id
      where a.user_id=v_uid and a.kind='mention' and a.org_id=p_org and a.cleared_at is not null
        and m.channel_id=any(v_readable) and m.deleted_at is null
        and (exists(select 1 from dek.mentions where message_id=m.id and user_id=v_uid)
          or (m.mention_all and m.author_id is distinct from v_uid and exists(select 1 from dek.channel_members where channel_id=m.channel_id and user_id=v_uid)))
        and (p_before is null or (m.created_at,m.id)<(p_before,p_before_id))
      order by m.created_at desc,m.id desc limit v_limit+1);
  else
  v_rows := array(
    select x from dek.messages x where x.id in (
      select ids.id from (
        (select m.id from dek.mentions mn join dek.messages m on m.id = mn.message_id
          left join dek.channel_members cm on cm.channel_id = m.channel_id and cm.user_id = v_uid
          left join dek.activity_states ast on ast.user_id=v_uid and ast.kind='mention' and ast.target_id=m.id
         where mn.user_id = v_uid and mn.org_id = p_org and mn.channel_id = any(v_readable)
           and m.deleted_at is null
           and (p_before is null or (mn.created_at, mn.message_id) < (p_before, p_before_id))
           and (p_view<>'unread' or (m.seq>coalesce(cm.last_read_seq,9223372036854775807)
             and (m.thread_root_id is null or m.seq>dek.thread_read_seq(v_uid,m.thread_root_id)) and ast.read_at is null))
           and ast.cleared_at is null
         order by mn.created_at desc, mn.message_id desc limit v_limit + 1)
        union
        (select a.id from dek.channel_members cm cross join lateral (
           select m.id from dek.messages m
            left join dek.activity_states ast on ast.user_id=v_uid and ast.kind='mention' and ast.target_id=m.id
            where m.channel_id = cm.channel_id and m.mention_all and m.deleted_at is null
              and m.author_id is distinct from v_uid
              and (p_before is null or (m.created_at, m.id) < (p_before, p_before_id))
              and (p_view<>'unread' or (m.seq>coalesce(cm.last_read_seq,9223372036854775807)
             and (m.thread_root_id is null or m.seq>dek.thread_read_seq(v_uid,m.thread_root_id)) and ast.read_at is null))
           and ast.cleared_at is null
            order by m.created_at desc, m.id desc limit v_limit + 1) a
         where cm.user_id = v_uid and cm.org_id = p_org and cm.channel_id = any(v_readable))
      ) ids) order by x.created_at desc, x.id desc limit v_limit + 1);
  end if;
  with page as (
    select i as ord, v_rows[i] as msg from generate_subscripts(v_rows, 1) i where i <= v_limit
  ), chans as materialized (
    select c.id, dek.channel_json(c, v_uid) as j from dek.channels c
     where c.id = any(array(select distinct (page.msg).channel_id from page))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'message', dek.message_json(page.msg), 'channel', chans.j,
      'activity',dek.activity_meta(v_uid,'mention',(page.msg).id,(page.msg).seq),
      'read',dek.mention_is_read(v_uid,(page.msg).id,(page.msg).channel_id,(page.msg).thread_root_id,(page.msg).seq))
      order by page.ord), '[]'::jsonb)
    into v_out from page join chans on chans.id = (page.msg).channel_id;
  return jsonb_build_object('items', v_out, 'has_more', cardinality(v_rows) > v_limit);
end $$;
create or replace function dek.activity_threads(
  p_org uuid, p_before timestamptz default null, p_before_id uuid default null,
  p_view text default 'all', p_limit int default 30)
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
  if (p_before is null) <> (p_before_id is null) or p_view is null or p_view not in ('all','unread','cleared') then
    perform dek.err('invalid_input', 'Use a complete page cursor and an unread choice.');
  end if;
  v_readable := dek.msg_readable_channel_ids(v_uid, p_org);
  with candidates as materialized (
    select r as root, dek.thread_read_seq(v_uid, r.id) as lrs,
           coalesce(r.last_reply_at, r.created_at) as activity_at
      from dek.thread_follows tf join dek.messages r on r.id = tf.root_id
      left join dek.activity_states ast on ast.user_id=v_uid and ast.kind='thread' and ast.target_id=r.id
     where tf.user_id = v_uid and tf.org_id = p_org and tf.following
       and tf.channel_id = any(v_readable)
       and (r.deleted_at is null or r.reply_count > 0)
       and ((p_view='cleared')=(ast.cleared_at is not null and not exists(
         select 1 from dek.messages newer where newer.thread_root_id=r.id and newer.deleted_at is null and newer.seq>ast.cleared_through_seq)))
       and (p_before is null or (coalesce(r.last_reply_at, r.created_at), r.id) < (p_before, p_before_id))
       and (p_view<>'unread' or exists (
         select 1 from dek.messages x where x.thread_root_id = r.id
           and x.seq > dek.thread_read_seq(v_uid, r.id) and x.deleted_at is null
           and x.author_id is distinct from v_uid))
     order by coalesce(r.last_reply_at, r.created_at) desc, r.id desc
     limit v_limit + 1
  ), page as (
    select * from candidates order by activity_at desc, (root).id desc limit v_limit
  ), chans as materialized (
    select c.id, dek.channel_json(c, v_uid) as j from dek.channels c
     where c.id = any(array(select distinct (page.root).channel_id from page))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'root', dek.message_json(page.root), 'channel', chans.j,
      'activity',dek.activity_meta(v_uid,'thread',(page.root).id,coalesce((select max(seq) from dek.messages where thread_root_id=(page.root).id and deleted_at is null),0)),
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
