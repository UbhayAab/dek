--105: server-only moderation and safe server activity. No real rows backfilled.
create table dek.server_member_controls105(
 server_id uuid not null references dek.servers(id)on delete cascade,
 user_id uuid not null references dek.profiles(id)on delete cascade,
 org_id uuid not null references dek.orgs(id)on delete cascade,
 prior_role text check(prior_role in('admin','moderator','member')),
 muted_until timestamptz,suspended boolean not null default false,banned boolean not null default false,
 reason text check(char_length(reason)<=500),updated_by uuid references dek.profiles(id),updated_at timestamptz not null default now(),
 primary key(server_id,user_id)
);
create index server_member_controls105_org_idx on dek.server_member_controls105(org_id,server_id);
alter table dek.server_member_controls105 enable row level security;

create function dek.server_content_allowed105(p_uid uuid,p_server uuid)returns boolean
language sql stable security definer set search_path=''as $fn$
 select p_server is null or not exists(select 1 from dek.server_member_controls105 m
  where m.server_id=p_server and m.user_id=p_uid and(m.suspended or m.banned))
$fn$;
create function dek.assert_server_unmuted105(p_uid uuid,p_server uuid)returns void
language plpgsql stable security definer set search_path=''as $fn$
begin
 if p_server is not null and exists(select 1 from dek.server_member_controls105 m where m.server_id=p_server and m.user_id=p_uid and m.muted_until>clock_timestamp())then
  perform dek.err('forbidden','You are muted in this server. You can read until the mute ends.');
 end if;
end $fn$;
create function dek.server_member_state105(p_server uuid,p_user uuid)returns jsonb
language sql stable security definer set search_path=''as $fn$
 select jsonb_build_object('muted_until',m.muted_until,'muted',coalesce(m.muted_until>clock_timestamp(),false),
  'suspended',coalesce(m.suspended,false),'banned',coalesce(m.banned,false))
 from(select 1)q left join dek.server_member_controls105 m on m.server_id=p_server and m.user_id=p_user
$fn$;

create function api.set_server_member_control105(p_server uuid,p_user uuid,p_action text,p_until timestamptz default null,p_reason text default null)returns jsonb
language plpgsql security definer set search_path=''as $fn$
declare uid uuid;s dek.servers;cap text;prior dek.server_member_controls105;nextrow dek.server_member_controls105;target_role text;why text;callrow record;
begin
 uid:=dek.require_uid();
 cap:=case p_action when'mute'then'mute_members'when'unmute'then'mute_members'when'suspend'then'suspend_members'when'restore'then'suspend_members'when'ban'then'ban_members'when'unban'then'ban_members'end;
 if cap is null then perform dek.err('invalid_input','Choose mute, unmute, suspend, restore, ban or unban.');end if;
 s:=dek.lock_server_action105(uid,p_server,cap);
 if s.archived_at is not null then perform dek.err('archived','Unarchive this server before changing member controls.');end if;
 if p_user=uid then perform dek.err('forbidden','You cannot moderate yourself.');end if;
 if not exists(select 1 from dek.org_members om where om.org_id=s.org_id and om.user_id=p_user)
  or not exists(select 1 from dek.profiles p where p.id=p_user and p.deleted_at is null)then perform dek.err('not_found','That person is not in this server.');end if;
 select * into prior from dek.server_member_controls105 m where m.server_id=s.id and m.user_id=p_user for update;
 select sm.role into target_role from dek.server_members sm where sm.server_id=s.id and sm.user_id=p_user for update;
 target_role:=coalesce(target_role,prior.prior_role);
 if prior.user_id is null and target_role is null and not exists(select 1 from dek.channel_members cm join dek.channels c on c.id=cm.channel_id where c.server_id=s.id and cm.user_id=p_user)then
  perform dek.err('not_found','That person is not in this server.');end if;
 if target_role='admin'or exists(select 1 from dek.org_members om where om.org_id=s.org_id and om.user_id=p_user and om.role in('owner','admin'))then
  perform dek.err('forbidden','Server moderation cannot target a server or organization Admin.');end if;
 if not dek.is_server_admin(uid,s.id)and target_role='moderator'then perform dek.err('forbidden','A delegated Moderator cannot moderate a peer.');end if;
 if p_until is not null and p_action<>'mute'then perform dek.err('invalid_input','An end time is used only when muting.');end if;
 why:=dek.org_clean_text(p_reason,'reason',500,false,false);
 nextrow:=prior;nextrow.server_id:=s.id;nextrow.user_id:=p_user;nextrow.org_id:=s.org_id;nextrow.prior_role:=target_role;
 nextrow.suspended:=coalesce(prior.suspended,false);nextrow.banned:=coalesce(prior.banned,false);
 if nextrow.banned and p_action not in('unban','ban')then perform dek.err('conflict','Unban this person before changing another control.');end if;
 if p_action='mute'then
  nextrow.muted_until:=coalesce(p_until,clock_timestamp()+interval'1 hour');
  if nextrow.muted_until<=clock_timestamp()or nextrow.muted_until>clock_timestamp()+interval'28 days'then perform dek.err('invalid_input','Mute must end in the future within 28 days.');end if;
 elsif p_action='unmute'then nextrow.muted_until:=null;
 elsif p_action='suspend'then nextrow.suspended:=true;
 elsif p_action='restore'then nextrow.suspended:=false;
 elsif p_action='ban'then nextrow.banned:=true;nextrow.suspended:=false;nextrow.muted_until:=null;
 elsif p_action='unban'then nextrow.banned:=false;
 end if;
 if prior.user_id is null and nextrow.muted_until is null and not nextrow.suspended and not nextrow.banned and why is null then return jsonb_build_object('server_id',s.id,'user_id',p_user,'control',dek.server_member_state105(s.id,p_user),'changed',false);end if;
 if prior.user_id is not null and row(prior.muted_until,prior.suspended,prior.banned,prior.reason)is not distinct from row(nextrow.muted_until,nextrow.suspended,nextrow.banned,why)then
  return jsonb_build_object('server_id',s.id,'user_id',p_user,'control',dek.server_member_state105(s.id,p_user),'changed',false);
 end if;
 insert into dek.server_member_controls105(server_id,user_id,org_id,prior_role,muted_until,suspended,banned,reason,updated_by)
 values(s.id,p_user,s.org_id,target_role,nextrow.muted_until,nextrow.suspended,nextrow.banned,why,uid)
 on conflict(server_id,user_id)do update set prior_role=excluded.prior_role,muted_until=excluded.muted_until,suspended=excluded.suspended,banned=excluded.banned,reason=excluded.reason,updated_by=uid,updated_at=clock_timestamp();
 if p_action in('mute','suspend','ban')then
  update dek.attachments a set status='deleted',deleted_at=clock_timestamp()from dek.channels ch where ch.id=a.channel_id and ch.server_id=s.id and a.uploader_id=p_user and a.status='pending';
  for callrow in select cp.call_id from dek.call_participants cp join dek.calls k on k.id=cp.call_id join dek.channels c on c.id=k.channel_id
   where cp.user_id=p_user and cp.state in('joined','ringing')and c.server_id=s.id and k.ended_at is null order by cp.call_id
  loop
   update dek.call_participants cp set state='left',left_at=clock_timestamp()where cp.call_id=callrow.call_id and cp.user_id=p_user;
   perform dek.media_settle_call(callrow.call_id);perform dek.media_emit_call(callrow.call_id);
  end loop;
 end if;
 if p_action='ban'then
  perform dek.revoke_server_membership(s.id,p_user);perform dek.org_withdraw_requests(s.org_id,p_user,s.id);
  update dek.channel_join_requests q set status='withdrawn',decided_by=uid,decided_at=clock_timestamp()from dek.channels c where c.id=q.channel_id and c.server_id=s.id and q.user_id=p_user and q.status='pending';
 elsif p_action='suspend'then
  perform dek.emit_user(p_user,'access.revoked',jsonb_build_object('scope','server','id',s.id));
 end if;
 perform dek.audit(s.org_id,'server.member_'||p_action,'user',p_user,jsonb_build_object('server_id',s.id,'user_id',p_user,'change',p_action,'muted_until',nextrow.muted_until,'suspended',nextrow.suspended,'banned',nextrow.banned,'reason',why));
 perform dek.emit_many(array['s:'||s.id::text,'u:'||p_user::text],'member.upd',jsonb_build_object('scope','server','id',s.id,'user_id',p_user,'change','moderation'));
 return jsonb_build_object('server_id',s.id,'user_id',p_user,'control',dek.server_member_state105(s.id,p_user),'changed',true);
end $fn$;

create function api.list_server_member_controls105(p_server uuid)returns jsonb
language plpgsql stable security definer set search_path=''as $fn$
declare uid uuid;s dek.servers;items jsonb;
begin
 uid:=dek.require_uid();s:=dek.org_find_server(uid,p_server);
 if not(dek.has_server_permission105(uid,s.id,'mute_members')or dek.has_server_permission105(uid,s.id,'suspend_members')or dek.has_server_permission105(uid,s.id,'ban_members'))then
  perform dek.err('forbidden','Your server role does not allow member moderation.');end if;
 select coalesce(jsonb_agg(jsonb_build_object('profile',dek.profile_json(p),'role',x.prior_role,'control',dek.server_member_state105(s.id,x.user_id),'reason',x.reason,'updated_at',x.updated_at)order by x.updated_at desc,x.user_id),'[]'::jsonb)into items
 from(select m.* from dek.server_member_controls105 m where m.server_id=s.id order by m.updated_at desc,m.user_id limit 200)x join dek.profiles p on p.id=x.user_id;
 return jsonb_build_object('items',items);
end $fn$;

-- An indexed safe projection begins at installation. No historical audit backfill.
create table dek.server_activity105(
 id bigint primary key references dek.audit_log(id)on delete cascade,
 server_id uuid not null references dek.servers(id)on delete cascade,
 org_id uuid not null references dek.orgs(id)on delete cascade,
 actor_id uuid references dek.profiles(id),action text not null,target_type text,target_user uuid references dek.profiles(id),
 details jsonb not null default'{}'::jsonb,created_at timestamptz not null
);
create index server_activity105_page_idx on dek.server_activity105(server_id,id desc);
alter table dek.server_activity105 enable row level security;
create function dek.project_server_activity105()returns trigger
language plpgsql security definer set search_path=''as $fn$
declare sid uuid;tid uuid;safe jsonb;
begin
 if new.target_type='server'then sid:=new.target_id;
 elsif new.target_type='channel'then select c.server_id into sid from dek.channels c where c.id=new.target_id;
 elsif new.target_type='message'then select c.server_id into sid from dek.messages m join dek.channels c on c.id=m.channel_id where m.id=new.target_id;
 elsif new.target_type='invite'then select i.server_id into sid from dek.invites i where i.id=new.target_id;end if;
 if sid is null and coalesce(new.details->>'server_id','')~'^[0-9a-fA-F-]{36}$'then
  begin sid:=(new.details->>'server_id')::uuid;exception when invalid_text_representation then sid:=null;end;
 end if;
 if sid is null or not exists(select 1 from dek.servers s where s.id=sid and s.org_id=new.org_id)then return new;end if;
 if new.target_type='user'and exists(select 1 from dek.profiles p where p.id=new.target_id)then tid:=new.target_id;end if;
 select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb)into safe from jsonb_each(new.details)e
 where e.key in('role','from','to','reset','version','change','muted_until','suspended','banned');
 insert into dek.server_activity105(id,server_id,org_id,actor_id,action,target_type,target_user,details,created_at)
 values(new.id,sid,new.org_id,new.actor_id,new.action,new.target_type,tid,safe,new.created_at);
 return new;
end $fn$;
create trigger dek_server_activity105 after insert on dek.audit_log for each row execute function dek.project_server_activity105();
create function api.list_server_activity105(p_server uuid,p_before bigint default null,p_limit int default 50)returns jsonb
language plpgsql stable security definer set search_path=''as $fn$
declare uid uuid;s dek.servers;items jsonb;lim int:=least(greatest(coalesce(p_limit,50),1),100);lastid bigint;more boolean;
begin
 uid:=dek.require_uid();s:=dek.server_for_action105(uid,p_server,'view_audit');
 if p_before is not null and p_before<1 then perform dek.err('invalid_input','Use a positive activity cursor.');end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'actor',dek.profile_json(p),'action',x.action,'target_type',x.target_type,'person',dek.profile_json(t),'details',x.details,'created_at',x.created_at)order by x.id desc),'[]'::jsonb),min(x.id)into items,lastid
 from(select a.* from dek.server_activity105 a where a.server_id=s.id and(p_before is null or a.id<p_before)order by a.id desc limit lim)x
 left join dek.profiles p on p.id=x.actor_id left join dek.profiles t on t.id=x.target_user;
 more:=lastid is not null and exists(select 1 from dek.server_activity105 a where a.server_id=s.id and a.id<lastid);
 return jsonb_build_object('items',items,'has_more',more,'next_before',case when more then lastid end);
end $fn$;

create function dek.server_voice_allowed105(p_uid uuid,p_server uuid)returns boolean
language sql stable security definer set search_path=''as $fn$
 select dek.server_content_allowed105(p_uid,p_server)and not exists(select 1 from dek.server_member_controls105 m where m.server_id=p_server and m.user_id=p_uid and m.muted_until>clock_timestamp())
$fn$;

create or replace function dek.server_role(p_uid uuid, p_server uuid)
returns text language sql stable security definer set search_path = '' as $$
  select sm.role
    from dek.server_members sm
    join dek.org_members om on om.org_id = sm.org_id and om.user_id = sm.user_id and om.status = 'active'
   where sm.server_id = p_server and sm.user_id = p_uid and dek.server_content_allowed105(p_uid,p_server)
$$;

create or replace function dek.can_read_channel(p_uid uuid, p_channel uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from dek.channels c
      join dek.org_members om on om.org_id = c.org_id and om.user_id = p_uid and om.status = 'active'
     where c.id = p_channel and dek.server_content_allowed105(p_uid,c.server_id)
       and (
         exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = p_uid)
         or (c.visibility = 'public' and c.server_id is not null and om.role <> 'guest'
             and exists (select 1 from dek.server_members sm
                          where sm.server_id = c.server_id and sm.user_id = p_uid))
       )
  )
$$;

create or replace function dek.org_find_server(p_uid uuid, p_server uuid)
returns dek.servers language plpgsql stable set search_path = '' as $$
declare s dek.servers;
begin
  select * into s from dek.servers x where x.id = p_server;
  perform dek.org_require_member(p_uid, s.org_id, 'That team server does not exist or you do not have access to it.');
  if not dek.server_content_allowed105(p_uid,s.id)then perform dek.err('not_found','That team server does not exist or you do not have access to it.');end if;
  return s;
end $$;

create or replace function dek.org_find_channel(p_uid uuid, p_channel uuid)
returns dek.channels language plpgsql stable set search_path = '' as $$
declare c dek.channels;
begin
  select * into c from dek.channels x where x.id = p_channel;
  perform dek.org_require_member(p_uid, c.org_id, 'That channel does not exist or you do not have access to it.');
  if not dek.server_content_allowed105(p_uid,c.server_id)then perform dek.err('not_found','That channel does not exist or you do not have access to it.');end if;
  return c;
end $$;

create or replace function dek.org_grant_server_membership(p_server uuid, p_user uuid, p_role text, p_actor uuid)
returns boolean language plpgsql set search_path = '' as $$
declare
  s dek.servers;
  r record;
begin
  select * into s from dek.servers x where x.id = p_server;
  if not found then
    perform dek.err('not_found', 'That team server does not exist.');
  end if;
  if coalesce(dek.org_role(p_user, s.org_id), 'guest') = 'guest' then
    perform dek.err('invalid_input', 'Only active members of the organization who are not guests can join a team server.');
  end if;
  if not dek.server_content_allowed105(p_user,s.id)then perform dek.err('forbidden','Restore or unban this person before adding them to the server.');end if;
  insert into dek.server_members (server_id, user_id, org_id, role, added_by)
  values (s.id, p_user, s.org_id, coalesce(p_role, 'member'), p_actor)
  on conflict (server_id, user_id) do nothing;
  if not found then
    return false;
  end if;
  -- a pending request to join this server is settled by the join itself
  update dek.join_requests jr
     set status = 'approved', decided_by = p_actor, decided_at = now()
   where jr.org_id = s.org_id and jr.user_id = p_user and jr.status = 'pending'
     and coalesce(jr.server_id, '00000000-0000-0000-0000-000000000000'::uuid) = s.id;
  perform dek.emit_many(array['u:' || p_user::text, 's:' || s.id::text], 'member.upd',
    jsonb_build_object('scope', 'server', 'id', s.id, 'user_id', p_user, 'change', 'added'));
  -- public only: a private channel must never absorb whoever joins the server next
  for r in
    select c.id from dek.channels c
     where c.server_id = s.id and c.auto_join and c.visibility = 'public' and c.archived_at is null
       and c.kind in ('text', 'audio')
     order by c.position, c.id
     limit 50
  loop
    perform dek.org_grant_channel_membership(r.id, p_user, 'member', p_actor);
  end loop;
  return true;
end $$;

create or replace function dek.org_grant_channel_membership(p_channel uuid, p_user uuid, p_role text, p_actor uuid)
returns boolean language plpgsql set search_path = '' as $$
begin
  if exists(select 1 from dek.channels c where c.id=p_channel and not dek.server_content_allowed105(p_user,c.server_id))then perform dek.err('forbidden','Restore or unban this person before adding them to a channel.');end if;
  insert into dek.channel_members (channel_id, user_id, org_id, role, added_by, last_read_seq)
  select c.id, p_user, c.org_id, coalesce(p_role, 'member'), p_actor, coalesce(st.last_seq, 0)
    from dek.channels c
    left join dek.channel_state st on st.channel_id = c.id
   where c.id = p_channel
  on conflict (channel_id, user_id) do nothing;
  if not found then
    return false;
  end if;
  perform dek.emit_user(p_user, 'member.upd',
    jsonb_build_object('scope', 'channel', 'id', p_channel, 'user_id', p_user, 'change', 'added'));
  return true;
end $$;

create or replace function dek.assert_post(p_uid uuid, p_channel uuid, p_is_reply boolean default false)
returns dek.channels language plpgsql stable security definer set search_path = '' as $$
declare c dek.channels;
begin
  c := dek.assert_read(p_uid, p_channel);
  perform dek.assert_server_unmuted105(p_uid,c.server_id);
  if c.archived_at is not null
     or exists (select 1 from dek.servers s where s.id = c.server_id and s.archived_at is not null) then
    perform dek.err('archived', 'This conversation is archived and read only.');
  end if;
  if p_is_reply and not c.allow_replies then
    perform dek.err('forbidden', 'Replies are turned off in this channel.');
  end if;
  if c.posting_policy = 'admins' and not (p_is_reply and c.allow_replies)
     and not dek.can_moderate_channel(p_uid, p_channel) then
    perform dek.err('forbidden', 'Only admins can post in this channel.');
  end if;
  if c.kind = 'dm' then
    if exists (
      select 1 from dek.channel_members cm
        join dek.user_blocks b
          on (b.blocker_id = cm.user_id and b.blocked_id = p_uid)
          or (b.blocker_id = p_uid and b.blocked_id = cm.user_id)
       where cm.channel_id = c.id and cm.user_id <> p_uid) then
      perform dek.err('blocked', 'You cannot message this person.');
    end if;
    if exists (
      select 1 from dek.channel_members cm
       where cm.channel_id = c.id and cm.user_id <> p_uid
         and dek.org_role(cm.user_id, c.org_id) is null) then
      perform dek.err('forbidden', 'This person is no longer in the organization.');
    end if;
  end if;
  return c;
end $$;

create or replace function dek.msg_assert_open(p_uid uuid, c dek.channels)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  perform dek.assert_server_unmuted105(p_uid,c.server_id);
  if c.kind = 'dm' then
    perform dek.assert_post(p_uid, c.id, false);
  elsif dek.msg_archived(c) then
    perform dek.err('archived', 'This conversation is archived and read only.');
  end if;
end $$;

create or replace function dek.msg_readable_channel_ids(p_uid uuid, p_org uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x.id), '{}'::uuid[])
    from dek.org_members om
    cross join lateral (
      select c.id,c.server_id
        from dek.channel_members cm
        join dek.channels c on c.id = cm.channel_id and c.org_id = om.org_id
       where cm.user_id = om.user_id and cm.org_id = om.org_id
      union all
      select c.id,c.server_id
        from dek.server_members sm
        join dek.channels c on c.server_id = sm.server_id and c.visibility = 'public'
                           and c.org_id = om.org_id
       where sm.user_id = om.user_id and sm.org_id = om.org_id and om.role <> 'guest'
    ) x
   where om.org_id = p_org and om.user_id = p_uid and om.status = 'active' and dek.server_content_allowed105(p_uid,x.server_id)
$$;

create or replace function dek.server_json(s dek.servers,p_uid uuid)returns jsonb
language sql stable security definer set search_path=''as $fn$
 select jsonb_build_object('id',s.id,'org_id',s.org_id,'name',s.name,'description',s.description,
  'icon_emoji',s.icon_emoji,'position',s.position,'join_policy',s.join_policy,'archived',s.archived_at is not null,
  'my_role',dek.server_role(p_uid,s.id),'access',dek.org_server_access(p_uid,s.id),
  'requested',exists(select 1 from dek.join_requests r where r.server_id=s.id and r.user_id=p_uid and r.status='pending'),
  'member_count',(select count(*)from dek.server_members sm where sm.server_id=s.id),
  'permissions',dek.server_effective_permissions105(p_uid,s.id),'permission_version',s.permission_version105,
  'moderation',dek.server_member_state105(s.id,p_uid),
  'can_manage_permissions',dek.org_role(p_uid,s.org_id)<>'guest'and dek.is_server_admin(p_uid,s.id))
$fn$;

create or replace function dek.assert_server_target105(p_uid uuid,p_server uuid,p_user uuid,p_new_role text default null)returns void
language plpgsql security definer set search_path=''as $fn$
declare actor text;target text;orgid uuid;
begin
 select org_id into orgid from dek.servers where id=p_server;
 actor:=dek.server_role(p_uid,p_server);select sm.role into target from dek.server_members sm where sm.server_id=p_server and sm.user_id=p_user;
 if p_user=p_uid then perform dek.err('forbidden','Use Leave server for yourself. You cannot change your own role here.');end if;
 if exists(select 1 from dek.org_members om where om.org_id=orgid and om.user_id=p_user and om.role in('owner','admin'))then perform dek.err('forbidden','Server controls cannot change an organization admin.');end if;
 if not dek.is_server_admin(p_uid,p_server)and(target='admin'or target='moderator'or(p_new_role in('admin','moderator')and actor<>'moderator'))then
  perform dek.err('forbidden','You cannot change a peer, higher role, or grant a role above your own.');end if;
 if not dek.is_server_admin(p_uid,p_server)and p_new_role='admin'then perform dek.err('forbidden','Only an Admin may appoint another Admin.');end if;
 if target='admin'and p_new_role is distinct from'admin'and not exists(
  select 1 from dek.server_members sm join dek.org_members om on om.user_id=sm.user_id and om.org_id=sm.org_id
  where sm.server_id=p_server and sm.user_id<>p_user and sm.role='admin'and om.status='active'and om.role<>'guest'
 )then perform dek.err('conflict','Keep at least one active server Admin. Appoint another Admin first.');end if;
end $fn$;

create or replace function api.create_channel(p_server uuid, p_name text, p_kind text default 'text',
                                              p_visibility text default 'public', p_topic text default null,
                                              p_description text default null,
                                              p_posting_policy text default 'everyone',
                                              p_member_ids uuid[] default '{}', p_auto_join boolean default false,
                                              p_category text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid;
  v_role     text;
  v_admin    boolean;
  v_name     text;
  v_topic    text;
  v_desc     text;
  v_category text;
  v_ids      uuid[];
  u          uuid;
  s          dek.servers;
  c          dek.channels;
begin
  v_uid := dek.require_uid();
  s := dek.org_find_server(v_uid, p_server);
  v_role := dek.org_role(v_uid, s.org_id);
  v_admin := dek.is_server_admin(v_uid, s.id);
  s:=dek.lock_server_action105(v_uid,s.id,'create_channels');
  if s.archived_at is not null then
    perform dek.err('archived', 'This team server is archived.');
  end if;
  if coalesce(p_kind, '') not in ('text', 'audio') then
    perform dek.err('invalid_input', 'kind must be one of: text, audio.');
  end if;
  if coalesce(p_visibility, '') not in ('public', 'private') then
    perform dek.err('invalid_input', 'visibility must be one of: public, private.');
  end if;
  if coalesce(p_posting_policy, '') not in ('everyone', 'admins') then
    perform dek.err('invalid_input', 'posting_policy must be one of: everyone, admins.');
  end if;
  if coalesce(p_auto_join, false) and not dek.has_server_permission105(v_uid,s.id,'edit_channels')then
    perform dek.err('forbidden', 'Only server admins can make new members join a channel automatically.');
  end if;
  if coalesce(p_auto_join, false) and p_visibility = 'private' then
    perform dek.err('invalid_input', 'Only public channels can join new members automatically.');
  end if;
  v_name := dek.org_clean_text(p_name, 'name', 80, true);
  v_topic := dek.org_clean_text(p_topic, 'topic', 250);
  v_desc := dek.org_clean_text(p_description, 'description', 1000, false, false);
  v_category := dek.org_clean_text(p_category, 'category', 40);
  if exists (select 1 from dek.channels x where x.server_id = s.id and lower(x.name) = lower(v_name)
                                            and x.archived_at is null) then
    perform dek.err('conflict', 'A channel with that name already exists in this team server.');
  end if;
  if cardinality(coalesce(p_member_ids,'{}'::uuid[]))>0 and not dek.has_server_permission105(v_uid,s.id,'add_people')then perform dek.err('forbidden','Add people permission is required to add initial channel members.');end if;
  if exists(select 1 from unnest(coalesce(p_member_ids,'{}'::uuid[]))as candidate(user_id)where not dek.server_content_allowed105(candidate.user_id,s.id))then perform dek.err('forbidden','Restore or unban initial members before adding them to this channel.');end if;
  v_ids := array_remove(dek.org_require_members(s.org_id, p_member_ids, true, 200), v_uid);
  begin
    insert into dek.channels (org_id, server_id, kind, name, topic, description, visibility, posting_policy,
                              auto_join, category, position, created_by)
    values (s.org_id, s.id, p_kind, v_name, v_topic, v_desc, p_visibility, p_posting_policy,
            coalesce(p_auto_join, false), v_category,
            coalesce((select max(x.position) + 1 from dek.channels x where x.server_id = s.id), 0), v_uid)
    returning * into c;
  exception when unique_violation then
    perform dek.err('conflict', 'A channel with that name already exists in this team server.');
  end;
  insert into dek.channel_members (channel_id, user_id, org_id, role, added_by)
  values (c.id, v_uid, c.org_id, 'owner', v_uid);
  insert into dek.channel_members (channel_id, user_id, org_id, role, added_by)
  select c.id, x, c.org_id, 'member', v_uid from unnest(v_ids) x
  on conflict (channel_id, user_id) do nothing;
  perform dek.emit_channel(c.id, 'chan.upd', jsonb_build_object('channel', dek.channel_public_json(c)));
  foreach u in array v_ids loop
    perform dek.emit_user(u, 'member.upd',
      jsonb_build_object('scope', 'channel', 'id', c.id, 'user_id', u, 'change', 'added'));
  end loop;
  perform dek.audit(c.org_id, 'channel.created', 'channel', c.id,
    jsonb_build_object('name', c.name, 'visibility', c.visibility, 'member_ids', to_jsonb(v_ids)));
  return dek.channel_json(c, v_uid);
end $$;

create or replace function api.pin_message(p_message uuid, p_pinned boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_msg dek.messages;
  v_ch  dek.channels;
begin
  v_uid := dek.require_uid();
  if p_pinned is null then
    perform dek.err('invalid_input', 'p_pinned must be true or false.');
  end if;
  v_msg := dek.msg_get(v_uid, p_message);
  select * into v_ch from dek.channels where id = v_msg.channel_id;
  if v_ch.server_id is not null then
    perform dek.lock_server_action105(v_uid,v_ch.server_id,'pin_messages');
  end if;
  if not dek.can_moderate_channel(v_uid, v_ch.id) then
    if v_ch.posting_policy = 'admins' then
      perform dek.err('forbidden', 'Only admins can pin messages in this channel.');
    end if;
    if not exists (select 1 from dek.channel_members cm where cm.channel_id = v_ch.id and cm.user_id = v_uid) then
      perform dek.err('forbidden', 'Join the channel to pin messages.');
    end if;
  end if;
  perform dek.msg_assert_open(v_uid, v_ch);
  if p_pinned then
    -- pins in one channel queue here, so two at 99 cannot both pass the cap
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pins:' || v_ch.id::text, 7314201));
  end if;

  select * into v_msg from dek.messages where id = v_msg.id for no key update;
  if v_msg.deleted_at is not null then
    perform dek.err('conflict', 'That message was deleted.');
  end if;
  if p_pinned = (v_msg.pinned_at is not null) then
    return jsonb_build_object('message_id', v_msg.id, 'pinned', p_pinned);
  end if;
  if p_pinned then
    if (select count(*) from (select 1 from dek.messages x
                               where x.channel_id = v_ch.id and x.pinned_at is not null limit 100) n) >= 100 then
      perform dek.err('invalid_input', 'A channel can have at most 100 pinned messages. Unpin one first.');
    end if;
    update dek.messages set pinned_at = now(), pinned_by = v_uid, updated_at = now()
     where id = v_msg.id returning * into v_msg;
  else
    update dek.messages set pinned_at = null, pinned_by = null, updated_at = now()
     where id = v_msg.id returning * into v_msg;
  end if;
  perform dek.emit_channel(v_msg.channel_id, 'msg.upd', jsonb_build_object('message', dek.message_json(v_msg)));
  return jsonb_build_object('message_id', v_msg.id, 'pinned', p_pinned);
end $$;

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
  select * into v_ch from dek.channels where id=v_msg.channel_id;
  v_mod:=case when v_ch.server_id is not null then dek.has_server_permission105(v_uid,v_ch.server_id,'delete_messages')else dek.can_moderate_channel(v_uid,v_ch.id)end;
  if v_mod and v_msg.author_id is distinct from v_uid and v_ch.server_id is not null then perform dek.lock_server_action105(v_uid,v_ch.server_id,'delete_messages');end if;
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

create or replace function api.svc_finalize_upload(p_attachment uuid, p_ok boolean, p_mime text, p_size bigint,
                                                   p_width int, p_height int, p_duration_ms int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a        dek.attachments;
  v_mime   text;
  v_family text;
  v_obj    jsonb;
  v_thumb  boolean;
begin
  select * into a from dek.attachments where id = p_attachment for update;
  if not found then
    perform dek.err('not_found', 'That upload does not exist.');
  end if;
  if a.status <> 'pending' then
    -- A retried finalize that reaches the same outcome is not an error. On a ready
    -- file it also reconciles the thumbnail: media-finalize checks the thumbnail's
    -- bytes once the file is ready (nothing can be uploaded after that) and removes
    -- a bad one, then calls again so thumb_path stops pointing at nothing.
    if a.status = 'ready' and coalesce(p_ok, false) then
      if a.thumb_path is not null and dek.media_object_meta(a.bucket, a.thumb_path) is null then
        update dek.attachments set thumb_path = null where id = a.id returning * into a;
      end if;
      return dek.attachment_json(a) || jsonb_build_object('reject_reason', a.reject_reason);
    end if;
    if a.status = 'rejected' and not coalesce(p_ok, false) then
      return dek.attachment_json(a) || jsonb_build_object('reject_reason', a.reject_reason);
    end if;
    perform dek.err('conflict', 'This upload has already been finalized.');
  end if;

  if coalesce(p_ok,false)then perform dek.assert_post(a.uploader_id,a.channel_id);end if;
  if coalesce(p_ok, false) then
    v_mime := dek.media_canonical_mime(p_mime);
    v_family := dek.media_family(v_mime);
    if v_family is null then
      perform dek.err('invalid_input', 'p_mime: not on the allow-list.');
    end if;
    if p_size is null or p_size < 1 or p_size > dek.media_max_bytes(v_family) then
      perform dek.err('invalid_input', 'p_size: outside the limit for this type.');
    end if;
    v_obj := dek.media_object_meta(a.bucket, a.object_path);
    if v_obj is null then
      perform dek.err('conflict', 'The file has not been uploaded yet.');
    end if;
    if (v_obj ->> 'size') is not null and (v_obj ->> 'size')::bigint <> p_size then
      perform dek.err('invalid_input', 'p_size: does not match the stored object.');
    end if;
    -- Storage serves the bytes with the type the upload declared: allow-listed only.
    if dek.media_family(v_obj ->> 'mimetype') is null then
      perform dek.err('invalid_input', 'p_mime: the stored object is served with a type off the allow-list.');
    end if;
    -- A thumbnail stays only if Storage holds it as an allowed image of at most 2 MB,
    -- even if it arrived after media-finalize looked.
    v_thumb := false;
    if a.thumb_path is not null then
      v_obj := dek.media_object_meta(a.bucket, a.thumb_path);
      v_thumb := v_obj is not null
             and dek.media_family(v_obj ->> 'mimetype') = 'image'
             and coalesce((v_obj ->> 'size')::bigint, 0) between 1 and 2097152;
    end if;
    update dek.attachments
       set status = 'ready', mime_type = v_mime, size_bytes = p_size,
           width = case when p_width between 1 and 100000 then p_width end,
           height = case when p_height between 1 and 100000 then p_height end,
           duration_ms = case when p_duration_ms between 0 and 86400000 then p_duration_ms end,
           thumb_path = case when v_thumb then thumb_path end,
           reject_reason = null, ready_at = now()
     where id = a.id
    returning * into a;
  else
    -- When media-finalize already removed the bytes, nothing is left for the purge.
    update dek.attachments
       set status = 'rejected',
           reject_reason = left(coalesce(nullif(btrim(p_reason), ''), 'rejected'), 300),
           purged_at = case
             when dek.media_object_meta(bucket, object_path) is null
              and (thumb_path is null or dek.media_object_meta(bucket, thumb_path) is null) then now() end
     where id = a.id
    returning * into a;
  end if;
  return dek.attachment_json(a) || jsonb_build_object('reject_reason', a.reject_reason);
end $$;

create or replace function api.svc_sfu_gate(p_user uuid, p_call uuid, p_session uuid, p_action text,
                                            p_wanted jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v       dek.calls;
  p       dek.call_participants;
  v_n     int;
  v_ok    jsonb := '[]'::jsonb;
begin
  if p_user is null or p_call is null or p_session is null then
    perform dek.err('invalid_input', 'call_id and session_id are required.');
  end if;
  if p_action is null or p_action not in ('session', 'push', 'pull', 'renegotiate', 'close') then
    perform dek.err('invalid_input', 'action: session, push, pull, renegotiate or close.');
  end if;
  if p_wanted is not null
     and (jsonb_typeof(p_wanted) <> 'array' or jsonb_array_length(p_wanted) > 64) then
    perform dek.err('invalid_input', 'tracks: at most 64.');
  end if;
  select * into v from dek.calls where id = p_call;
  if not found then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  select * into p from dek.call_participants where call_id = v.id and user_id = p_user;
  if not found
     or exists (select 1 from dek.profiles x where x.id = p_user and x.deleted_at is not null)
     or not dek.can_read_channel(p_user, v.channel_id) then
    perform dek.err('not_found', 'That call does not exist.');
  end if;
  if v.ended_at is not null then
    perform dek.err('conflict', 'This call has ended.');
  end if;
  if p.state <> 'joined' or p.session_id is distinct from p_session then
    perform dek.err('conflict', 'You are no longer in this call.');
  end if;
  select count(*) into v_n from dek.call_participants x where x.call_id = v.id;
  if not dek.sfu_live(v, v_n) then
    perform dek.err('conflict', 'This call does not go through the media server.');
  end if;
  if p_action<>'close'and not exists(select 1 from dek.channels c where c.id=v.channel_id and dek.server_voice_allowed105(p_user,c.server_id))then perform dek.err('forbidden','Server moderation prevents room participation.');end if;
  perform dek.rate_hit(p_user, 'sfu', 120, 60);
  if p_action = 'session' then
    perform dek.rate_hit(p_user, 'sfu_session', 20, 600);
  end if;
  if p_action = 'pull' and p_wanted is not null then
    select coalesce(jsonb_agg(jsonb_build_object('session', w.session, 'name', w.name) order by w.session, w.name), '[]'::jsonb)
      into v_ok
      from (select distinct e ->> 'session' as session, e ->> 'name' as name
              from jsonb_array_elements(p_wanted) e
             where jsonb_typeof(e) = 'object') w
     where w.session is not null and w.name is not null
       and exists (select 1 from dek.call_participants o
                    where o.call_id = v.id and o.user_id <> p_user and o.state = 'joined'
                      and o.sfu_session = w.session and w.name = any (o.sfu_tracks));
  end if;
  return jsonb_build_object('sfu_session', p.sfu_session, 'sfu_tracks', to_jsonb(p.sfu_tracks), 'allowed', v_ok);
end $$;

create or replace function dek.can_use_topic(p_topic text, p_mode text, p_extension text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_prefix text;
  v_rest   text;
  v_id     uuid;
begin
  if v_uid is null or p_topic is null or p_mode not in ('read', 'write') then
    return false;
  end if;
  v_prefix := split_part(p_topic, ':', 1);
  v_rest := substr(p_topic, char_length(v_prefix) + 2);
  if v_rest !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_id := v_rest::uuid;

  if v_prefix = 'u' then
    return p_mode = 'read' and v_id = v_uid and p_extension = 'broadcast';
  elsif v_prefix = 's' then
    return p_mode = 'read' and p_extension = 'broadcast'
       and exists (select 1 from dek.servers s
                     join dek.org_members om on om.org_id = s.org_id and om.user_id = v_uid
                                            and om.status = 'active' and om.role <> 'guest'
                     join dek.server_members sm on sm.server_id = s.id and sm.user_id = v_uid
                    where s.id = v_id and dek.server_content_allowed105(v_uid,s.id));
  elsif v_prefix = 't' then
    return p_extension = 'broadcast' and dek.can_read_channel(v_uid,v_id)and(p_mode='read'or exists(select 1 from dek.channels ch where ch.id=v_id and dek.server_voice_allowed105(v_uid,ch.server_id)));
  elsif v_prefix = 'call' then
    -- Realtime checks these at join and caches them: a callee joins call:<id> after
    -- answer_call, when it is a joined participant.
    return p_extension in ('broadcast', 'presence')
       and exists (
         select 1 from dek.calls c
          where c.id = v_id and c.ended_at is null
            and dek.org_role(v_uid,c.org_id)is not null and dek.can_read_channel(v_uid,c.channel_id)and exists(select 1 from dek.channels ch where ch.id=c.channel_id and dek.server_voice_allowed105(v_uid,ch.server_id))
            and (exists (select 1 from dek.call_participants p
                          where p.call_id = c.id and p.user_id = v_uid
                            and (p.state = 'joined' or (p_mode = 'read' and p.state = 'ringing')))
                 or (p_mode = 'read' and c.kind = 'room' and dek.can_read_channel(v_uid, c.channel_id))));
  end if;
  return false;
end $$;

create or replace function api.bootstrap(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid;
  v_role      text;
  v_org       dek.orgs;
  v_mine      uuid[];
  v_chan      uuid[];
  v_dms       uuid[];
  v_servers   uuid[];
  v_jservers  jsonb;
  v_jchannels jsonb;
  v_jprofiles jsonb;
  v_topics    text[];
begin
  v_uid := dek.require_uid();
  v_role := dek.require_org(v_uid, p_org);
  select * into v_org from dek.orgs where id = p_org;

  -- servers the caller belongs to
  v_mine := array(
    select sm.server_id from dek.server_members sm
     where sm.user_id = v_uid and sm.org_id = p_org);

  -- joined text and audio channels, in sidebar order
  v_chan := array(
    select cm.channel_id
      from dek.channel_members cm
      join dek.channels c on c.id = cm.channel_id
      left join dek.servers s on s.id = c.server_id
     where cm.user_id = v_uid and cm.org_id = p_org and c.kind in ('text', 'audio')and dek.server_content_allowed105(v_uid,c.server_id)
     order by s.position, s.name, c.position, lower(c.name), c.id
     limit 300);

  -- unhidden DMs and group DMs, most recent first
  v_dms := array(
    select cm.channel_id
      from dek.channel_members cm
      join dek.channels c on c.id = cm.channel_id
      left join dek.channel_state st on st.channel_id = c.id
     where cm.user_id = v_uid and cm.org_id = p_org and c.kind in ('dm', 'group_dm') and not cm.hidden
     order by st.last_message_at desc nulls last, c.created_at desc, c.id
     limit 200);

  -- member servers plus partial ones (reached only through a channel membership)
  v_servers := array(
    select distinct x from unnest(v_mine || array(
      select c.server_id from dek.channels c where c.id = any(v_chan) and c.server_id is not null)) x);

  select coalesce(jsonb_agg(dek.server_json(s, v_uid) order by s.position, s.name, s.id), '[]'::jsonb)
    into v_jservers
    from dek.servers s where s.id = any(v_servers);

  select coalesce(jsonb_agg(dek.channel_json(c, v_uid) order by u.ord), '[]'::jsonb)
    into v_jchannels
    from unnest(v_chan || v_dms) with ordinality as u(id, ord)
    join dek.channels c on c.id = u.id;

  -- DM partners and server admins, fetched by primary key
  select coalesce(jsonb_agg(dek.profile_json(p) order by p.id), '[]'::jsonb)
    into v_jprofiles
    from dek.profiles p
   where p.id = any(array(
     select cm.user_id from dek.channel_members cm
      where cm.channel_id = any(v_dms) and cm.user_id <> v_uid
     union
     select sm.user_id from dek.server_members sm
      where sm.server_id = any(v_servers) and sm.role = 'admin'));

  v_topics := array['u:' || v_uid::text];
  if v_role <> 'guest' then
    v_topics := v_topics || array(select 's:' || x::text from unnest(v_mine) x where dek.server_content_allowed105(v_uid,x)order by x);
  end if;

  perform dek.touch_active(v_uid);
  return jsonb_build_object(
    'org', dek.org_summary_json(v_org, v_uid) || jsonb_build_object('settings', dek.org_settings(v_org)),
    'servers', v_jservers,
    'channels', v_jchannels,
    'profiles', v_jprofiles,
    'topics', to_jsonb(v_topics),
    'server_time', now());
end $$;

create or replace function api.browse_channels(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_role text;
  v_out  jsonb;
begin
  v_uid := dek.require_uid();
  v_role := dek.require_org(v_uid, p_org);
  with my_servers as (
    select sm.server_id from dek.server_members sm
     where sm.org_id = p_org and sm.user_id = v_uid and v_role <> 'guest'
  ), listed as (
    select c.*, (cm.user_id is not null) as is_member
      from dek.channels c
      left join dek.channel_members cm on cm.channel_id = c.id and cm.user_id = v_uid
     where c.org_id = p_org and c.kind in ('text', 'audio')and dek.server_content_allowed105(v_uid,c.server_id) and c.archived_at is null
       and (c.server_id in (select server_id from my_servers) or cm.user_id is not null)
       and not exists (select 1 from dek.servers s where s.id = c.server_id and s.archived_at is not null)
     order by c.server_id, c.position, lower(c.name)
     limit 1000
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'server_id', l.server_id, 'name', l.name, 'kind', l.kind, 'visibility', l.visibility,
           'category', l.category, 'position', l.position, 'posting_policy', l.posting_policy,
           'member', l.is_member,
           'locked', l.visibility = 'private' and not l.is_member,
           'topic', case when l.visibility = 'public' or l.is_member then l.topic end,
           'member_count', (select count(*) from dek.channel_members x where x.channel_id = l.id),
           'requested', exists (select 1 from dek.channel_join_requests r
                                 where r.channel_id = l.id and r.user_id = v_uid and r.status = 'pending'))
           order by l.server_id, l.position, lower(l.name)), '[]'::jsonb)
    into v_out
    from listed l;
  return jsonb_build_object('channels', v_out);
end $$;

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
       where cm.user_id = v_uid and cm.org_id = p_org and not cm.hidden and cm.notify <> 'none' and dek.server_content_allowed105(v_uid,c.server_id)
         and st.last_top_seq > cm.last_read_seq
       order by st.last_message_at desc nulls last, c.id
       limit v_channels) u
   where jsonb_array_length(u.msgs) > 0;
  return jsonb_build_object('channels', v_out);
end $$;

create or replace function dek.can_write_object(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[];
  a       dek.attachments;
begin
  if v_uid is null or p_name is null then return false; end if;
  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) <> 4
     or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  select * into a from dek.attachments where id = v_parts[3]::uuid;
  if not found then return false; end if;
  return coalesce(a.status = 'pending'
     and a.uploader_id = v_uid
     and dek.can_read_channel(v_uid,a.channel_id)
     and exists(select 1 from dek.channels c where c.id=a.channel_id and dek.server_voice_allowed105(v_uid,c.server_id))
     and a.created_at > now() - interval '2 hours'
     and (p_name = a.object_path or p_name = a.thumb_path), false);
end $$;
