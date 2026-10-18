-- Thread-specific reads are not a follow preference or a channel read.
create table dek.thread_reads (
  root_id uuid not null references dek.messages(id) on delete cascade,
  user_id uuid not null references dek.profiles(id) on delete cascade,
  channel_id uuid not null references dek.channels(id) on delete cascade,
  org_id uuid not null references dek.orgs(id) on delete cascade,
  last_read_reply_seq bigint not null default 0 check (last_read_reply_seq >= 0),
  updated_at timestamptz not null default now(),
  primary key (root_id, user_id)
);
alter table dek.thread_reads enable row level security;
create index thread_reads_user_channel_idx on dek.thread_reads(user_id, channel_id);

create or replace function dek.thread_read_seq(p_uid uuid, p_root uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select greatest(
    coalesce((select r.last_read_reply_seq from dek.thread_reads r where r.root_id = p_root and r.user_id = p_uid), 0),
    coalesce((select f.last_read_reply_seq from dek.thread_follows f where f.root_id = p_root and f.user_id = p_uid), 0))
$$;

-- Unjoined public channels have no mention read position, as before.
create or replace function dek.message_read_seq(p_uid uuid, p_channel uuid, p_root uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select greatest(cm.last_read_seq,
    case when p_root is null then 0 else dek.thread_read_seq(p_uid, p_root) end)
    from dek.channel_members cm where cm.user_id = p_uid and cm.channel_id = p_channel), 9223372036854775807)
$$;

create or replace function dek.mention_unread_count(p_uid uuid, p_org uuid default null, p_channel uuid default null)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from (
    select q.id from (
      (select m.id
      from dek.mentions mn join dek.messages m on m.id = mn.message_id
      join dek.channel_members cm on cm.user_id = p_uid and cm.channel_id = m.channel_id
      where mn.user_id = p_uid and (p_org is null or mn.org_id = p_org)
        and (p_channel is null or mn.channel_id = p_channel)
        and mn.seq > cm.last_read_seq
        and m.deleted_at is null and m.author_id is distinct from p_uid
        and (m.thread_root_id is null or m.seq > dek.thread_read_seq(p_uid,m.thread_root_id))
        and dek.can_read_channel(p_uid,m.channel_id)
      limit 100)
      union
      (select m.id
      from dek.channel_members cm join dek.messages m on m.channel_id = cm.channel_id
      where cm.user_id = p_uid and (p_org is null or cm.org_id = p_org)
        and (p_channel is null or cm.channel_id = p_channel)
        and m.seq > cm.last_read_seq
        and m.mention_all and m.deleted_at is null and m.author_id is distinct from p_uid
        and (m.thread_root_id is null or m.seq > dek.thread_read_seq(p_uid,m.thread_root_id))
        and dek.can_read_channel(p_uid,m.channel_id)
      limit 100)
    ) q
    limit 100
  ) unread
$$;

create or replace function dek.forget_thread_reads()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'channel_members' then
    delete from dek.thread_reads where user_id = old.user_id and channel_id = old.channel_id;
  elsif new.deleted_at is not null then
    delete from dek.thread_reads where user_id = new.id;
  end if;
  return null;
end $$;
create trigger dek_forget_channel_thread_reads after delete on dek.channel_members
  for each row execute function dek.forget_thread_reads();
create trigger dek_forget_deleted_thread_reads after update of deleted_at on dek.profiles
  for each row execute function dek.forget_thread_reads();

create or replace function api.mark_thread_read(p_root uuid, p_seq bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid; v_root dek.messages; v_seq bigint; v_prev bigint; v_now bigint;
begin
  v_uid := dek.require_uid(); v_root := dek.msg_get(v_uid, p_root);
  if v_root.thread_root_id is not null then perform dek.err('invalid_input', 'Read the thread of its first message.'); end if;
  if p_seq is null or p_seq < 0 then perform dek.err('invalid_input', 'Use a message sequence number.'); end if;
  v_prev := dek.thread_read_seq(v_uid, p_root);
  select coalesce(max(m.seq), 0) into v_seq from dek.messages m where m.thread_root_id = p_root and m.seq <= p_seq;
  insert into dek.thread_reads as r (root_id,user_id,channel_id,org_id,last_read_reply_seq)
  values (p_root,v_uid,v_root.channel_id,v_root.org_id,greatest(v_prev,v_seq))
  on conflict(root_id,user_id) do update set last_read_reply_seq = greatest(r.last_read_reply_seq,excluded.last_read_reply_seq),updated_at=now()
  returning last_read_reply_seq into v_now;
  update dek.thread_follows f set last_read_reply_seq=greatest(f.last_read_reply_seq,v_now),updated_at=now()
    where f.root_id=p_root and f.user_id=v_uid and f.last_read_reply_seq<v_now;
  if v_now>v_prev then perform dek.emit_user(v_uid,'read',jsonb_build_object('root_id',p_root,'last_read_reply_seq',v_now)); end if;
  return jsonb_build_object('root_id',p_root,'last_read_reply_seq',v_now);
end $$;

-- Default latest window; one exact target or one numeric direction. No full-history load.
create or replace function api.thread_window(p_root uuid, p_target uuid default null,
  p_before_seq bigint default null, p_after_seq bigint default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid; v_root dek.messages; v_target dek.messages; v_rows dek.messages[];
  v_left dek.messages[]; v_right dek.messages[]; v_limit int; v_first bigint; v_last bigint;
  v_before boolean; v_after boolean; v_follow boolean;
begin
  v_uid:=dek.require_uid(); v_root:=dek.msg_get(v_uid,p_root);
  if v_root.thread_root_id is not null then perform dek.err('invalid_input','Open the thread of its first message.'); end if;
  if num_nonnulls(p_target,p_before_seq,p_after_seq)>1 or p_before_seq<0 or p_after_seq<0 then
    perform dek.err('invalid_input','Choose one target or page direction.'); end if;
  v_limit:=dek.msg_limit(p_limit,50,100);
  if p_target is not null then
    v_target:=dek.msg_get(v_uid,p_target);
    if v_target.channel_id<>v_root.channel_id or (v_target.id<>v_root.id and v_target.thread_root_id is distinct from v_root.id) then
      perform dek.err('not_found','That reply is not available in this thread.'); end if;
  end if;
  if p_target=v_root.id then
    v_rows:=array(select m from dek.messages m where m.thread_root_id=p_root order by m.seq limit v_limit);
  elsif p_target is not null then
    v_left:=array(select m from dek.messages m where m.thread_root_id=p_root and m.seq<v_target.seq order by m.seq desc limit v_limit/2);
    v_right:=array(select m from dek.messages m where m.thread_root_id=p_root and m.seq>=v_target.seq order by m.seq limit v_limit-cardinality(v_left));
    v_rows:=array(select m from unnest(v_left||v_right) m order by m.seq);
  elsif p_after_seq is not null then
    v_rows:=array(select m from dek.messages m where m.thread_root_id=p_root and m.seq>p_after_seq order by m.seq limit v_limit);
  else
    v_rows:=array(select q.x from (select x from dek.messages x where x.thread_root_id=p_root
      and (p_before_seq is null or x.seq<p_before_seq) order by x.seq desc limit v_limit) q order by (q.x).seq);
  end if;
  v_first:=coalesce((v_rows[1]).seq,0); v_last:=coalesce((v_rows[cardinality(v_rows)]).seq,0);
  v_before:=v_first>0 and exists(select 1 from dek.messages m where m.thread_root_id=p_root and m.seq<v_first);
  v_after:=v_last>0 and exists(select 1 from dek.messages m where m.thread_root_id=p_root and m.seq>v_last);
  select coalesce(f.following,false) into v_follow from dek.thread_follows f where f.root_id=p_root and f.user_id=v_uid;
  return jsonb_build_object('root',dek.message_json(v_root),'replies',dek.msg_json_list(v_rows),
    'has_before',v_before,'has_after',v_after,'has_more',v_after,'first_seq',v_first,'last_seq',v_last,
    'target_id',p_target,'following',coalesce(v_follow,false),'last_read_reply_seq',dek.thread_read_seq(v_uid,p_root));
end $$;


-- Compatible read projections; keep legacy signatures and opaque inbox wrappers.
create or replace function dek.channel_json(c dek.channels, p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  cm     dek.channel_members;
  st     dek.channel_state;
  v_unr  int := 0;
  v_men  int := 0;
  v_cnt  int;
  v_dm   jsonb := null;
begin
  select * into cm from dek.channel_members x where x.channel_id = c.id and x.user_id = p_uid;
  select * into st from dek.channel_state s where s.channel_id = c.id;
  if cm.user_id is not null then
    select count(*) into v_unr from (
      select 1 from dek.messages m
       where m.channel_id = c.id and m.in_timeline and m.deleted_at is null
         and m.seq > cm.last_read_seq and m.author_id is distinct from p_uid
       limit 100) u;
    v_men := dek.mention_unread_count(p_uid, null, c.id);
  end if;
  select count(*) into v_cnt from dek.channel_members x where x.channel_id = c.id;
  if c.kind in ('dm', 'group_dm') then
    select coalesce(jsonb_agg(x.user_id order by x.joined_at, x.user_id), '[]'::jsonb) into v_dm
      from dek.channel_members x where x.channel_id = c.id and x.user_id <> p_uid;
  end if;
  return dek.channel_public_json(c) || jsonb_build_object(
    'member', cm.user_id is not null,
    'my_role', cm.role,
    'notify', coalesce(cm.notify, 'default'),
    'muted_until', cm.muted_until,
    'hidden', coalesce(cm.hidden, false),
    'last_seq', coalesce(st.last_seq, 0),
    'last_read_seq', coalesce(cm.last_read_seq, 0),
    'unread', v_unr,
    'mentions', v_men,
    'last_message_at', st.last_message_at,
    'member_count', v_cnt,
    'dm_user_ids', v_dm);
end $$;

create or replace function dek.org_summary_json(o dek.orgs, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'slug', o.slug, 'name', o.name, 'short_name', o.short_name,
    'brand_color', o.brand_color, 'logo_path', o.logo_path,
    'my_role', dek.org_role(p_uid, o.id),
    'unread_channels', (
      select count(*) from dek.channel_members cm
        join dek.channel_state st on st.channel_id = cm.channel_id
       where cm.user_id = p_uid and cm.org_id = o.id and not cm.hidden
         and st.last_top_seq > cm.last_read_seq and cm.notify <> 'none'),
    'mention_count', dek.mention_unread_count(p_uid, o.id, null))
$$;

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
    'last_read_reply_seq', dek.thread_read_seq(v_uid, v_root.id));
end $$;

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
               select (items.msg).seq <= dek.message_read_seq(v_uid, (items.msg).channel_id, (items.msg).thread_root_id) from dek.channel_members cm
                where cm.channel_id = (items.msg).channel_id and cm.user_id = v_uid), true))
         order by items.ord), '[]'::jsonb)
    into v_out
    from items join chans on chans.id = (items.msg).channel_id;
  return jsonb_build_object('items', v_out, 'has_more', cardinality(v_rows) > v_limit);
end $$;

create or replace function dek.list_thread_inbox(
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
    select r as root, dek.thread_read_seq(v_uid, r.id) as lrs,
           coalesce(r.last_reply_at, r.created_at) as activity_at
      from dek.thread_follows tf join dek.messages r on r.id = tf.root_id
     where tf.user_id = v_uid and tf.org_id = p_org and tf.following
       and tf.channel_id = any(v_readable)
       and (r.deleted_at is null or r.reply_count > 0)
       and (p_before is null or (coalesce(r.last_reply_at, r.created_at), r.id) < (p_before, p_before_id))
       and (not p_unread_only or exists (
         select 1 from dek.messages x where x.thread_root_id = r.id
           and x.seq > dek.thread_read_seq(v_uid, r.id) and x.deleted_at is null
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

create or replace function dek.list_mention_inbox(
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
           and (not p_unread_only or m.seq > dek.message_read_seq(v_uid, m.channel_id, m.thread_root_id))
         order by mn.created_at desc, mn.message_id desc limit v_limit + 1)
        union
        (select a.id from dek.channel_members cm cross join lateral (
           select m.id from dek.messages m
            where m.channel_id = cm.channel_id and m.mention_all and m.deleted_at is null
              and m.author_id is distinct from v_uid
              and (p_before is null or (m.created_at, m.id) < (p_before, p_before_id))
              and (not p_unread_only or m.seq > dek.message_read_seq(v_uid, m.channel_id, m.thread_root_id))
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
      'read', coalesce((select (page.msg).seq <= dek.message_read_seq(v_uid, (page.msg).channel_id, (page.msg).thread_root_id) from dek.channel_members cm
        where cm.channel_id = (page.msg).channel_id and cm.user_id = v_uid), true))
      order by page.ord), '[]'::jsonb)
    into v_out from page join chans on chans.id = (page.msg).channel_id;
  return jsonb_build_object('items', v_out, 'has_more', cardinality(v_rows) > v_limit);
end $$;
