-- Join caller-owned read floors before paging/counting reply-heavy mention history.
-- Preserve the exact channel/thread greatest-floor semantics and per-item receipts.
create or replace function dek.mention_unread_count(p_uid uuid,p_org uuid default null,p_channel uuid default null)
returns int language sql stable security definer set search_path='' as $$
  with eligible as materialized (
    select cm.channel_id,cm.last_read_seq from dek.channel_members cm
    where cm.user_id=p_uid and (p_org is null or cm.org_id=p_org)
      and (p_channel is null or cm.channel_id=p_channel) and dek.can_read_channel(p_uid,cm.channel_id)
  )
  select count(*)::int from (
    select id from (
      (select direct.id from eligible cm cross join lateral (
        select m.id from dek.mentions mn cross join lateral (
          select x.id from dek.messages x left join dek.activity_states ast on ast.user_id=p_uid and ast.kind='mention' and ast.target_id=x.id
          left join dek.thread_reads tr on tr.user_id=p_uid and tr.root_id=x.thread_root_id
          left join dek.thread_follows tf on tf.user_id=p_uid and tf.root_id=x.thread_root_id where x.id=mn.message_id
            and ast.read_at is null
            and x.deleted_at is null and x.author_id is distinct from p_uid
            and (x.thread_root_id is null or x.seq>greatest(coalesce(tr.last_read_reply_seq,0),coalesce(tf.last_read_reply_seq,0)))
          offset 0
        ) m
        where mn.user_id=p_uid and mn.channel_id=cm.channel_id and mn.seq>cm.last_read_seq
        order by mn.seq limit 100
      ) direct limit 100)
      union
      (select broadcast.id from eligible cm cross join lateral (
        select m.id from dek.messages m left join dek.activity_states ast on ast.user_id=p_uid and ast.kind='mention' and ast.target_id=m.id
          left join dek.thread_reads tr on tr.user_id=p_uid and tr.root_id=m.thread_root_id
          left join dek.thread_follows tf on tf.user_id=p_uid and tf.root_id=m.thread_root_id where m.channel_id=cm.channel_id and m.seq>cm.last_read_seq
          and ast.read_at is null
          and m.mention_all and m.deleted_at is null and m.author_id is distinct from p_uid
          and (m.thread_root_id is null or m.seq>greatest(coalesce(tr.last_read_reply_seq,0),coalesce(tf.last_read_reply_seq,0)))
        order by m.seq limit 100
      ) broadcast limit 100)
    ) candidates limit 100
  ) unread
$$;
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
          left join dek.thread_reads tr on tr.user_id=v_uid and tr.root_id=m.thread_root_id
          left join dek.thread_follows tf on tf.user_id=v_uid and tf.root_id=m.thread_root_id
         where mn.user_id = v_uid and mn.org_id = p_org and mn.channel_id = any(v_readable)
           and m.deleted_at is null
           and (p_before is null or (mn.created_at, mn.message_id) < (p_before, p_before_id))
           and (p_view<>'unread' or (m.seq>coalesce(cm.last_read_seq,9223372036854775807)
             and (m.thread_root_id is null or m.seq>greatest(coalesce(tr.last_read_reply_seq,0),coalesce(tf.last_read_reply_seq,0))) and ast.read_at is null))
           and ast.cleared_at is null
         order by mn.created_at desc, mn.message_id desc limit v_limit + 1)
        union
        (select a.id from dek.channel_members cm cross join lateral (
           select m.id from dek.messages m
            left join dek.activity_states ast on ast.user_id=v_uid and ast.kind='mention' and ast.target_id=m.id
          left join dek.thread_reads tr on tr.user_id=v_uid and tr.root_id=m.thread_root_id
          left join dek.thread_follows tf on tf.user_id=v_uid and tf.root_id=m.thread_root_id
            where m.channel_id = cm.channel_id and m.mention_all and m.deleted_at is null
              and m.author_id is distinct from v_uid
              and (p_before is null or (m.created_at, m.id) < (p_before, p_before_id))
              and (p_view<>'unread' or (m.seq>coalesce(cm.last_read_seq,9223372036854775807)
             and (m.thread_root_id is null or m.seq>greatest(coalesce(tr.last_read_reply_seq,0),coalesce(tf.last_read_reply_seq,0))) and ast.read_at is null))
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
