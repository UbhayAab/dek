--105 policy source. Endpoint enforcement and client controls are separate integration work.
-- No existing role, org setting, membership or channel is rewritten by this migration.
alter table dek.servers add column permission_version105 bigint not null default 0 check(permission_version105>=0);
create table dek.server_role_permissions105(
 server_id uuid not null references dek.servers(id)on delete cascade,
 org_id uuid not null references dek.orgs(id)on delete cascade,
 role text not null check(role in('moderator','member')),
 permissions jsonb not null default'{}'::jsonb check(jsonb_typeof(permissions)='object'),
 updated_by uuid references dek.profiles(id),updated_at timestamptz not null default now(),
 primary key(server_id,role)
);
create index server_role_permissions105_org_idx on dek.server_role_permissions105(org_id,server_id);
alter table dek.server_role_permissions105 enable row level security;

create function dek.server_permission_keys105()returns text[]
language sql immutable set search_path=''as $fn$
 select array['add_people','remove_people','invite_people','decide_join_requests','create_channels','edit_channels','delete_channels','assign_roles','delete_messages','pin_messages','mute_members','suspend_members','ban_members','edit_server','view_audit']::text[]
$fn$;

create function dek.server_role_defaults105(p_server uuid,p_role text)returns jsonb
language plpgsql stable security definer set search_path=''as $fn$
declare d jsonb;settings jsonb;
begin
 select jsonb_object_agg(k,coalesce(p_role='admin',false))into d from unnest(dek.server_permission_keys105())k;
 if p_role='admin'then return d;end if;
 if p_role is null or p_role not in('moderator','member')then return coalesce(d,'{}'::jsonb);end if;
 select dek.org_settings(o)into settings from dek.servers s join dek.orgs o on o.id=s.org_id where s.id=p_server;
 return d||jsonb_build_object('remove_people',p_role='moderator','delete_messages',p_role='moderator','pin_messages',true,
  'create_channels',coalesce((settings->>'member_can_create_channels')::boolean,false),
  'invite_people',coalesce((settings->>'member_can_invite')::boolean,false));
end $fn$;

create function dek.server_effective_permissions105(p_uid uuid,p_server uuid)returns jsonb
language plpgsql stable security definer set search_path=''as $fn$
declare orgrole text;rolekey text;overrides jsonb;d jsonb;
begin
 select jsonb_object_agg(k,false)into d from unnest(dek.server_permission_keys105())k;
 select dek.org_role(p_uid,s.org_id)into orgrole from dek.servers s where s.id=p_server;
 if orgrole is null or orgrole='guest'then return d;end if;
 if orgrole in('owner','admin')then return dek.server_role_defaults105(p_server,'admin');end if;
 rolekey:=dek.server_role(p_uid,p_server);
 if rolekey is null then return d;end if;
 if rolekey='admin'then return dek.server_role_defaults105(p_server,'admin');end if;
 select p.permissions into overrides from dek.server_role_permissions105 p where p.server_id=p_server and p.role=rolekey;
 return dek.server_role_defaults105(p_server,rolekey)||coalesce(overrides,'{}'::jsonb);
end $fn$;

create function dek.has_server_permission105(p_uid uuid,p_server uuid,p_action text)returns boolean
language sql stable security definer set search_path=''as $fn$
 select coalesce(p_action=any(dek.server_permission_keys105())and(dek.server_effective_permissions105(p_uid,p_server)->>p_action)::boolean,false)
$fn$;

create function api.get_server_role_permissions105(p_server uuid)returns jsonb
language plpgsql stable security definer set search_path=''as $fn$
declare uid uuid;s dek.servers;roles jsonb:='{}';r text;d jsonb;overrides jsonb;
begin
 uid:=dek.require_uid();s:=dek.org_server_for_admin(uid,p_server);
 if dek.org_role(uid,s.org_id)='guest'then perform dek.err('forbidden','Only server admins manage role permissions.');end if;
 foreach r in array array['admin','moderator','member']loop
  d:=dek.server_role_defaults105(s.id,r);overrides:='{}'::jsonb;
  if r<>'admin'then select coalesce((select p.permissions from dek.server_role_permissions105 p where p.server_id=s.id and p.role=r),'{}'::jsonb)into overrides;end if;
  roles:=roles||jsonb_build_object(r,jsonb_build_object('defaults',d,'overrides',overrides,'effective',d||overrides,'locked',r='admin'));
 end loop;
 return jsonb_build_object('server_id',s.id,'version',s.permission_version105,'actions',to_jsonb(dek.server_permission_keys105()),'roles',roles,'can_manage',true);
end $fn$;

create function api.set_server_role_permissions105(p_server uuid,p_role text,p_permissions jsonb,p_expected_version bigint default null,p_reset boolean default false)returns jsonb
language plpgsql security definer set search_path=''as $fn$
declare uid uuid;s dek.servers;oldmap jsonb;newmap jsonb;k text;v jsonb;targets text[];
begin
 uid:=dek.require_uid();s:=dek.org_server_for_admin(uid,p_server);
 if dek.org_role(uid,s.org_id)='guest'then perform dek.err('forbidden','Only server admins manage role permissions.');end if;
 select * into s from dek.servers x where x.id=p_server for update;
 if not dek.is_server_admin(uid,s.id)or dek.org_role(uid,s.org_id)='guest'then perform dek.err('forbidden','Your server admin access changed. Reload before saving.');end if;
 if s.archived_at is not null then perform dek.err('archived','Unarchive this server before changing role permissions.');end if;
 if p_role is null or p_role not in('moderator','member')then perform dek.err('invalid_input','Admin permissions are fixed. Choose Moderator or Member.');end if;
 if p_permissions is null or jsonb_typeof(p_permissions)<>'object'then perform dek.err('invalid_input','Permissions must be a map of known actions to true or false.');end if;
 if p_expected_version is not null and p_expected_version<0 then perform dek.err('invalid_input','The permission version cannot be negative.');end if;
 if p_expected_version is not null and p_expected_version<>s.permission_version105 then perform dek.err('conflict','Role permissions changed elsewhere. Reload them before saving.');end if;
 if coalesce(p_reset,false)and p_permissions<>'{}'::jsonb then perform dek.err('invalid_input','Reset uses an empty permission map.');end if;
 for k,v in select key,value from jsonb_each(p_permissions)loop
  if not k=any(dek.server_permission_keys105())or jsonb_typeof(v)<>'boolean'then perform dek.err('invalid_input','Use only known permission actions with true or false values.');end if;
 end loop;
 select coalesce((select p.permissions from dek.server_role_permissions105 p where p.server_id=s.id and p.role=p_role),'{}'::jsonb)into oldmap;
 newmap:=case when coalesce(p_reset,false)then'{}'::jsonb else oldmap||p_permissions end;
 if newmap=oldmap then return api.get_server_role_permissions105(s.id);end if;
 if newmap='{}'::jsonb then delete from dek.server_role_permissions105 p where p.server_id=s.id and p.role=p_role;
 else insert into dek.server_role_permissions105(server_id,org_id,role,permissions,updated_by)values(s.id,s.org_id,p_role,newmap,uid)
  on conflict(server_id,role)do update set permissions=excluded.permissions,updated_by=excluded.updated_by,updated_at=clock_timestamp();end if;
 update dek.servers x set permission_version105=x.permission_version105+1 where x.id=s.id returning * into s;
 perform dek.audit(s.org_id,'server.permissions_updated','server',s.id,jsonb_build_object('role',p_role,'from',oldmap,'to',newmap,'reset',coalesce(p_reset,false),'version',s.permission_version105));
 -- Broadcast only the changed version. Each client reloads its own effective map.
 -- Partial-channel members keep their narrow access and never receive another user's rights.
 targets:=array['s:'||s.id::text]||array(select distinct'u:'||cm.user_id::text from dek.channel_members cm join dek.channels c on c.id=cm.channel_id
  where c.server_id=s.id and not exists(select 1 from dek.server_members sm where sm.server_id=s.id and sm.user_id=cm.user_id));
 perform dek.emit_many(targets,'server.upd',jsonb_build_object('server',jsonb_build_object('id',s.id,'org_id',s.org_id,'permission_version',s.permission_version105)));
 return api.get_server_role_permissions105(s.id);
end $fn$;

-- Preserve all current0917 directory/request fields when adding caller-only capabilities.
create or replace function dek.server_json(s dek.servers,p_uid uuid)returns jsonb
language sql stable security definer set search_path=''as $fn$
 select jsonb_build_object('id',s.id,'org_id',s.org_id,'name',s.name,'description',s.description,
  'icon_emoji',s.icon_emoji,'position',s.position,'join_policy',s.join_policy,'archived',s.archived_at is not null,
  'my_role',dek.server_role(p_uid,s.id),'access',dek.org_server_access(p_uid,s.id),
  'requested',exists(select 1 from dek.join_requests r where r.server_id=s.id and r.user_id=p_uid and r.status='pending'),
  'member_count',(select count(*)from dek.server_members sm where sm.server_id=s.id),
  'permissions',dek.server_effective_permissions105(p_uid,s.id),'permission_version',s.permission_version105,
  'can_manage_permissions',dek.org_role(p_uid,s.org_id)<>'guest'and dek.is_server_admin(p_uid,s.id))
$fn$;
