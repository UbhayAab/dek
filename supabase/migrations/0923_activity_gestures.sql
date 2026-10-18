-- Exact notification receipts and reversible inbox clearing. No message deletion,
-- channel read, follow, mute or delivery preference is changed by Clear.
create sequence dek.activity_revision_seq;
create table dek.activity_states (
 user_id uuid not null references dek.profiles(id) on delete cascade,
 kind text not null check(kind in ('mention','thread')),
 target_id uuid not null references dek.messages(id) on delete cascade,
 channel_id uuid not null references dek.channels(id) on delete cascade,
 org_id uuid not null references dek.orgs(id) on delete cascade,
 read_at timestamptz,
 cleared_at timestamptz,
 cleared_through_seq bigint not null default 0 check(cleared_through_seq>=0),
 revision bigint not null default 0,
 operation_id uuid,
 operation_action text,
 updated_at timestamptz not null default now(),
 primary key(user_id,kind,target_id)
);
alter table dek.activity_states enable row level security;
create index activity_states_user_channel_idx on dek.activity_states(user_id,channel_id);

create or replace function dek.activity_cleared(p_uid uuid,p_kind text,p_target uuid,p_last bigint)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from dek.activity_states s where s.user_id=p_uid and s.kind=p_kind
   and s.target_id=p_target and s.cleared_at is not null and (p_kind='mention' or p_last<=s.cleared_through_seq))
$$;
create or replace function dek.activity_view(p_uid uuid,p_kind text,p_target uuid,p_last bigint,p_view text)
returns boolean language sql stable security definer set search_path='' as $$
 select case when p_view='cleared' then dek.activity_cleared(p_uid,p_kind,p_target,p_last)
   else not dek.activity_cleared(p_uid,p_kind,p_target,p_last) end
$$;
create or replace function dek.mention_is_read(p_uid uuid,p_id uuid,p_channel uuid,p_root uuid,p_seq bigint)
returns boolean language sql stable security definer set search_path='' as $$
 select p_seq<=dek.message_read_seq(p_uid,p_channel,p_root) or exists(
   select 1 from dek.activity_states s where s.user_id=p_uid and s.kind='mention' and s.target_id=p_id and s.read_at is not null)
$$;
create or replace function dek.activity_meta(p_uid uuid,p_kind text,p_target uuid,p_last bigint)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('revision',coalesce((select revision from dek.activity_states where user_id=p_uid and kind=p_kind and target_id=p_target),0),
   'cleared',dek.activity_cleared(p_uid,p_kind,p_target,p_last),'through_seq',p_last)
$$;

create or replace function dek.forget_thread_reads()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='channel_members' then
   delete from dek.thread_reads where user_id=old.user_id and channel_id=old.channel_id;
   delete from dek.activity_states where user_id=old.user_id and channel_id=old.channel_id;
 elsif new.deleted_at is not null then
   delete from dek.thread_reads where user_id=new.id;
   delete from dek.activity_states where user_id=new.id;
 end if;
 return null;
end $$;

create or replace function api.set_activity_state(p_kind text,p_target uuid,p_action text,p_expected_revision bigint,p_operation uuid,p_through_seq bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; m dek.messages; s dek.activity_states; last_seq bigint; result jsonb;
begin
 u:=dek.require_uid();m:=dek.msg_get(u,p_target);
 if p_kind is null or p_kind not in ('mention','thread') or p_action is null or p_action not in ('read','clear','restore')
   or p_operation is null or p_expected_revision is null or p_expected_revision<0 then
   perform dek.err('invalid_input','Choose an activity action and its current revision.');end if;
 if not exists(select 1 from dek.channel_members where user_id=u and channel_id=m.channel_id) then
   perform dek.err('not_found','This activity is no longer available.');end if;
 if p_kind='mention' then
   if m.deleted_at is not null or not (exists(select 1 from dek.mentions where user_id=u and message_id=m.id)
       or (m.mention_all and m.author_id is distinct from u)) then
     perform dek.err('not_found','This mention is no longer available.');end if;
   last_seq:=m.seq;
 else
   if m.thread_root_id is not null or not exists(select 1 from dek.thread_follows where root_id=m.id and user_id=u and following)
     or (m.deleted_at is not null and m.reply_count=0) then
     perform dek.err('not_found','This followed thread is no longer available.');end if;
   select coalesce(max(seq),0) into last_seq from dek.messages where thread_root_id=m.id and deleted_at is null;
 end if;
 insert into dek.activity_states(user_id,kind,target_id,channel_id,org_id)
   values(u,p_kind,m.id,m.channel_id,m.org_id) on conflict do nothing;
 select * into s from dek.activity_states where user_id=u and kind=p_kind and target_id=m.id for update;
 if s.operation_id=p_operation then
   if s.operation_action<>p_action then perform dek.err('invalid_input','This operation belongs to another action.');end if;
 elsif s.revision<>p_expected_revision then
   perform dek.err('conflict','This activity changed on another device. Refresh before trying again.');
 else
   if p_kind='thread' and p_action<>'restore' and (p_through_seq is null or p_through_seq<0 or
       (p_through_seq<>0 and not exists(select 1 from dek.messages where thread_root_id=m.id and seq=p_through_seq))) then
     perform dek.err('invalid_input','Use the reply snapshot shown in this inbox.');end if;
   if p_action='read' then
     if p_kind='thread' then perform api.mark_thread_read(m.id,p_through_seq);
     else s.read_at:=coalesce(s.read_at,now());end if;
   elsif p_action='clear' then
     s.cleared_at:=now();s.cleared_through_seq:=case when p_kind='thread' then greatest(s.cleared_through_seq,p_through_seq) else m.seq end;
   else s.cleared_at:=null;s.cleared_through_seq:=0;end if;
   update dek.activity_states set read_at=s.read_at,cleared_at=s.cleared_at,cleared_through_seq=s.cleared_through_seq,
     revision=nextval('dek.activity_revision_seq'),operation_id=p_operation,operation_action=p_action,updated_at=now()
     where user_id=u and kind=p_kind and target_id=m.id returning * into s;
   perform dek.emit_user(u,'activity.upd',jsonb_build_object('org_id',m.org_id,'kind',p_kind,'target_id',m.id,'revision',s.revision));
 end if;
 result:=dek.activity_meta(u,p_kind,m.id,last_seq)||jsonb_build_object('operation_id',s.operation_id,'read',
   case when p_kind='mention' then dek.mention_is_read(u,m.id,m.channel_id,m.thread_root_id,m.seq)
   else last_seq<=dek.thread_read_seq(u,m.id) end);
 return result;
end $$;

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
  v_rows := array(
    select x from dek.messages x where x.id in (
      select ids.id from (
        (select m.id from dek.mentions mn join dek.messages m on m.id = mn.message_id
          left join dek.channel_members cm on cm.channel_id = m.channel_id and cm.user_id = v_uid
         where mn.user_id = v_uid and mn.org_id = p_org and mn.channel_id = any(v_readable)
           and m.deleted_at is null
           and (p_before is null or (mn.created_at, mn.message_id) < (p_before, p_before_id))
           and (p_view<>'unread' or not dek.mention_is_read(v_uid,m.id,m.channel_id,m.thread_root_id,m.seq))
           and dek.activity_view(v_uid,'mention',m.id,m.seq,p_view)
         order by mn.created_at desc, mn.message_id desc limit v_limit + 1)
        union
        (select a.id from dek.channel_members cm cross join lateral (
           select m.id from dek.messages m
            where m.channel_id = cm.channel_id and m.mention_all and m.deleted_at is null
              and m.author_id is distinct from v_uid
              and (p_before is null or (m.created_at, m.id) < (p_before, p_before_id))
              and (p_view<>'unread' or not dek.mention_is_read(v_uid,m.id,m.channel_id,m.thread_root_id,m.seq))
           and dek.activity_view(v_uid,'mention',m.id,m.seq,p_view)
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
     where tf.user_id = v_uid and tf.org_id = p_org and tf.following
       and tf.channel_id = any(v_readable)
       and (r.deleted_at is null or r.reply_count > 0)
       and dek.activity_view(v_uid,'thread',r.id,coalesce((select max(seq) from dek.messages where thread_root_id=r.id and deleted_at is null),0),p_view)
       and (p_before is null or (coalesce(r.last_reply_at, r.created_at), r.id) < (p_before, p_before_id))
       and (p_view<>'unread' or exists (
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
create or replace function dek.list_mention_inbox(p_org uuid,p_before timestamptz default null,p_before_id uuid default null,p_unread_only boolean default false,p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_unread_only is null then perform dek.err('invalid_input','Choose an unread filter.');end if;
 return dek.activity_mentions(p_org,p_before,p_before_id,case when p_unread_only then 'unread' else 'all' end,p_limit);
end $$;
create or replace function dek.list_thread_inbox(p_org uuid,p_before timestamptz default null,p_before_id uuid default null,p_unread_only boolean default false,p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_unread_only is null then perform dek.err('invalid_input','Choose an unread filter.');end if;
 return dek.activity_threads(p_org,p_before,p_before_id,case when p_unread_only then 'unread' else 'all' end,p_limit);
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
               select dek.mention_is_read(v_uid,(items.msg).id,(items.msg).channel_id,(items.msg).thread_root_id,(items.msg).seq) from dek.channel_members cm
                where cm.channel_id = (items.msg).channel_id and cm.user_id = v_uid), true))
         order by items.ord), '[]'::jsonb)
    into v_out
    from items join chans on chans.id = (items.msg).channel_id;
  return jsonb_build_object('items', v_out, 'has_more', cardinality(v_rows) > v_limit);
end $$;
-- Drive counts from caller memberships and indexed unread sequence ranges.
-- Authorization is checked once per eligible channel, before per-message probes.
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
          select x.id from dek.messages x where x.id=mn.message_id
            and not exists(select 1 from dek.activity_states a where a.user_id=p_uid and a.kind='mention' and a.target_id=x.id and a.read_at is not null)
            and x.deleted_at is null and x.author_id is distinct from p_uid
            and (x.thread_root_id is null or x.seq>dek.thread_read_seq(p_uid,x.thread_root_id))
          offset 0
        ) m
        where mn.user_id=p_uid and mn.channel_id=cm.channel_id and mn.seq>cm.last_read_seq
        order by mn.seq limit 100
      ) direct limit 100)
      union
      (select broadcast.id from eligible cm cross join lateral (
        select m.id from dek.messages m where m.channel_id=cm.channel_id and m.seq>cm.last_read_seq
          and not exists(select 1 from dek.activity_states a where a.user_id=p_uid and a.kind='mention' and a.target_id=m.id and a.read_at is not null)
          and m.mention_all and m.deleted_at is null and m.author_id is distinct from p_uid
          and (m.thread_root_id is null or m.seq>dek.thread_read_seq(p_uid,m.thread_root_id))
        order by m.seq limit 100
      ) broadcast limit 100)
    ) candidates limit 100
  ) unread
$$;

create or replace function api.list_activity_inbox(p_org uuid,p_kind text,p_view text default 'unread',p_cursor jsonb default null,p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid; before_at timestamptz; before_id uuid; result jsonb; last_item jsonb; next_cursor jsonb;
begin
 u:=dek.require_uid();perform dek.require_org(u,p_org);
 if p_kind is null or p_kind not in ('mention','thread') or p_view is null or p_view not in ('unread','all','cleared') then
   perform dek.err('invalid_input','Choose an inbox and filter.');end if;
 if p_cursor is not null then
   if jsonb_typeof(p_cursor)<>'object' or p_cursor->>'v' is distinct from '2' or p_cursor->>'user' is distinct from u::text
     or p_cursor->>'org' is distinct from p_org::text or p_cursor->>'kind' is distinct from p_kind or p_cursor->>'view' is distinct from p_view
     or p_cursor->>'order' is distinct from 'activity-desc-id-desc' or p_cursor->>'at' is null or p_cursor->>'id' is null then
     perform dek.err('invalid_input','This page belongs to another view. Refresh the inbox.');end if;
   begin before_at:=(p_cursor->>'at')::timestamptz;before_id:=(p_cursor->>'id')::uuid;
   exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
     perform dek.err('invalid_input','This page cursor is invalid. Refresh the inbox.');end;
   if not isfinite(before_at) then perform dek.err('invalid_input','This page cursor is invalid. Refresh the inbox.');end if;
 end if;
 if p_kind='mention' then result:=dek.activity_mentions(p_org,before_at,before_id,p_view,p_limit);
 else result:=dek.activity_threads(p_org,before_at,before_id,p_view,p_limit);end if;
 if (result->>'has_more')::boolean then
   last_item:=result->'items'->(jsonb_array_length(result->'items')-1);
   next_cursor:=jsonb_build_object('v',2,'user',u,'org',p_org,'kind',p_kind,'view',p_view,'order','activity-desc-id-desc',
     'at',case when p_kind='thread' then last_item->>'activity_at' else last_item->'message'->>'created_at' end,
     'id',case when p_kind='thread' then last_item->'root'->>'id' else last_item->'message'->>'id' end);
 end if;
 return result||jsonb_build_object('next_cursor',next_cursor);
end $$;
