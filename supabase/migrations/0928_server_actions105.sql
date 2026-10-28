--105: enforce current server-role actions at native endpoints. No data backfill.
create function dek.server_for_action105(p_uid uuid,p_server uuid,p_action text)returns dek.servers
language plpgsql stable security definer set search_path=''as $fn$
declare s dek.servers;
begin
 s:=dek.org_find_server(p_uid,p_server);
 if not dek.has_server_permission105(p_uid,s.id,p_action)then
  if dek.org_server_access(p_uid,s.id)is null then perform dek.err('not_found','That team server does not exist or you do not have access to it.');end if;
  perform dek.err('forbidden','Your server role does not allow this action.');
 end if;return s;
end $fn$;

create function dek.lock_server_action105(p_uid uuid,p_server uuid,p_action text)returns dek.servers
language plpgsql security definer set search_path=''as $fn$
declare s dek.servers;
begin
 s:=dek.server_for_action105(p_uid,p_server,p_action);
 perform 1 from dek.servers x where x.id=s.id for update;
 return dek.server_for_action105(p_uid,s.id,p_action);
end $fn$;

create function dek.channel_for_action105(p_uid uuid,p_channel uuid,p_action text)returns dek.channels
language plpgsql security definer set search_path=''as $fn$
declare c dek.channels;
begin
 c:=dek.org_find_channel(p_uid,p_channel);
 if c.kind not in('text','audio')or c.server_id is null then
  if dek.can_read_channel(p_uid,c.id)then perform dek.err('forbidden','Direct messages have no server management actions.');end if;
  perform dek.err('not_found','That channel does not exist or you do not have access to it.');
 end if;
 if not dek.can_read_channel(p_uid,c.id)and not dek.is_server_admin(p_uid,c.server_id)then perform dek.err('not_found','That channel does not exist or you do not have access to it.');end if;
 perform dek.lock_server_action105(p_uid,c.server_id,p_action);
 return c;
end $fn$;

-- The caller holds the server row lock before this rank/last-admin check.
create function dek.assert_server_target105(p_uid uuid,p_server uuid,p_user uuid,p_new_role text default null)returns void
language plpgsql security definer set search_path=''as $fn$
declare actor text;target text;orgid uuid;
begin
 select org_id into orgid from dek.servers where id=p_server;
 actor:=dek.server_role(p_uid,p_server);target:=dek.server_role(p_user,p_server);
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

create or replace function dek.org_channel_add_right(p_uid uuid,c dek.channels)returns text
language sql stable set search_path=''as $fn$
 select case when c.kind not in('text','audio')or c.server_id is null then null
 when not dek.can_read_channel(p_uid,c.id)and not dek.is_server_admin(p_uid,c.server_id)then null
 when dek.has_server_permission105(p_uid,c.server_id,'add_people')then'manage'else'none'end
$fn$;

create or replace function api.update_server(p_server uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_key text;
  s     dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.lock_server_action105(v_uid, p_server, 'edit_server');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform dek.err('invalid_input', 'patch must be an object.');
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('name', 'description', 'icon_emoji', 'join_policy', 'position') then
      perform dek.err('invalid_input', format('%s cannot be changed here.', v_key));
    end if;
  end loop;
  if s.archived_at is not null then
    perform dek.err('archived', 'This team server is archived. Unarchive it first.');
  end if;
  if p_patch ? 'name' then
    s.name := dek.org_patch_text(p_patch, 'name', 80, true);
    if exists (select 1 from dek.servers x where x.org_id = s.org_id and lower(x.name) = lower(s.name)
                                             and x.archived_at is null and x.id <> s.id) then
      perform dek.err('conflict', 'A team server with that name already exists.');
    end if;
  end if;
  if p_patch ? 'description' then
    s.description := dek.org_patch_text(p_patch, 'description', 1000, false, false);
  end if;
  if p_patch ? 'icon_emoji' then
    s.icon_emoji := dek.org_patch_text(p_patch, 'icon_emoji', 64);
  end if;
  if p_patch ? 'join_policy' then
    s.join_policy := dek.org_patch_enum(p_patch, 'join_policy', array['open', 'approval', 'invite']);
  end if;
  if p_patch ? 'position' then
    s.position := dek.org_patch_int(p_patch, 'position', -100000, 100000);
  end if;
  begin
    update dek.servers x
       set name = s.name, description = s.description, icon_emoji = s.icon_emoji,
           join_policy = s.join_policy, position = s.position
     where x.id = s.id
    returning * into s;
  exception when unique_violation then
    perform dek.err('conflict', 'A team server with that name already exists.');
  end;
  perform dek.audit(s.org_id, 'server.updated', 'server', s.id, jsonb_build_object('patch', p_patch));
  return dek.server_json(s, v_uid);
end $$;

create or replace function api.archive_server(p_server uuid, p_archived boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  s     dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.lock_server_action105(v_uid, p_server, 'edit_server');
  if p_archived is null then
    perform dek.err('invalid_input', 'archived must be true or false.');
  end if;
  if p_archived and s.archived_at is null then
    update dek.servers x set archived_at = now(), archived_by = v_uid where x.id = s.id returning * into s;
    perform dek.audit(s.org_id, 'server.archived', 'server', s.id, jsonb_build_object('name', s.name));
  elsif not p_archived and s.archived_at is not null then
    if exists (select 1 from dek.servers x where x.org_id = s.org_id and lower(x.name) = lower(s.name)
                                             and x.archived_at is null and x.id <> s.id) then
      perform dek.err('conflict', 'Another team server now has this name. Rename it first.');
    end if;
    update dek.servers x set archived_at = null, archived_by = null where x.id = s.id returning * into s;
    perform dek.audit(s.org_id, 'server.unarchived', 'server', s.id, jsonb_build_object('name', s.name));
  end if;
  return dek.server_json(s, v_uid);
end $$;

create or replace function api.add_server_members(p_server uuid, p_user_ids uuid[], p_role text default 'member')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid;
  v_role    text := coalesce(p_role, 'member');
  v_ids     uuid[];
  v_added   uuid[] := '{}';
  v_already uuid[] := '{}';
  u         uuid;
  s         dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.lock_server_action105(v_uid, p_server, 'add_people');
  if s.archived_at is not null then
    perform dek.err('archived', 'This team server is archived.');
  end if;
  if v_role not in ('admin', 'moderator', 'member') then
    perform dek.err('invalid_input', 'role must be one of: admin, moderator, member.');
  end if;
  if v_role<>'member'and not dek.has_server_permission105(v_uid,s.id,'assign_roles')then perform dek.err('forbidden','Assign roles permission is required.');end if;
  if v_role='admin'and not dek.is_server_admin(v_uid,s.id)then perform dek.err('forbidden','Only Admins may appoint Admins.');end if;
  if v_role='moderator'and not dek.is_server_admin(v_uid,s.id)and dek.server_role(v_uid,s.id)<>'moderator'then perform dek.err('forbidden','You cannot grant a role above your own.');end if;
  v_ids := dek.org_require_members(s.org_id, p_user_ids, false, 100);
  if cardinality(v_ids) = 0 then
    perform dek.err('invalid_input', 'Choose at least one person to add.');
  end if;
  foreach u in array v_ids loop
    if dek.org_grant_server_membership(s.id, u, v_role, v_uid) then
      v_added := v_added || u;
    else
      v_already := v_already || u;
    end if;
  end loop;
  if cardinality(v_added) > 0 then
    perform dek.audit(s.org_id, 'server.members_added', 'server', s.id,
      jsonb_build_object('user_ids', to_jsonb(v_added), 'role', v_role));
  end if;
  return jsonb_build_object('server_id', s.id, 'added', to_jsonb(v_added), 'already_members', to_jsonb(v_already));
end $$;

create or replace function api.set_server_role(p_server uuid, p_user uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_old text;
  s     dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.lock_server_action105(v_uid, p_server, 'assign_roles');
  if p_role is null or p_role not in ('admin', 'moderator', 'member') then
    perform dek.err('invalid_input', 'role must be one of: admin, moderator, member.');
  end if;
  select sm.role into v_old from dek.server_members sm
   where sm.server_id = s.id and sm.user_id = p_user for update;
  if v_old is null then
    perform dek.err('not_found', 'That person is not a member of this team server.');
  end if;
  if s.archived_at is not null then perform dek.err('archived','This team server is archived.');end if;
  perform dek.assert_server_target105(v_uid,s.id,p_user,p_role);
  if v_old <> p_role then
    update dek.server_members x set role = p_role where x.server_id = s.id and x.user_id = p_user;
    perform dek.emit_many(array['u:' || p_user::text, 's:' || s.id::text], 'member.upd',
      jsonb_build_object('scope', 'server', 'id', s.id, 'user_id', p_user, 'change', 'role'));
    perform dek.audit(s.org_id, 'server.role_changed', 'user', p_user,
      jsonb_build_object('server_id', s.id, 'from', v_old, 'to', p_role));
  end if;
  return dek.org_server_member_item(s.id, p_user);
end $$;

create or replace function api.remove_server_member(p_server uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_role text;
  s      dek.servers;
  r      record;
begin
  v_uid := dek.require_uid();
  s := dek.org_find_server(v_uid, p_server);
  s:=dek.lock_server_action105(v_uid,s.id,'remove_people');
  if s.archived_at is not null then perform dek.err('archived','This team server is archived.');end if;
  perform dek.assert_server_target105(v_uid,s.id,p_user);
  select sm.role into v_role from dek.server_members sm where sm.server_id = s.id and sm.user_id = p_user;
  if v_role is not null then
    if not dek.is_server_admin(v_uid, s.id) and (v_role = 'admin' or dek.is_org_admin(p_user, s.org_id)) then
      perform dek.err('forbidden', 'Moderators cannot remove admins.');
    end if;
    perform dek.revoke_server_membership(s.id, p_user);
  else
    if not exists (select 1 from dek.channel_members cm join dek.channels c on c.id = cm.channel_id
                    where cm.user_id = p_user and cm.org_id = s.org_id and c.server_id = s.id) then
      perform dek.err('not_found', 'That person is not in this team server.');
    end if;
    if not dek.is_server_admin(v_uid, s.id) and dek.is_org_admin(p_user, s.org_id) then
      perform dek.err('forbidden', 'Moderators cannot remove admins.');
    end if;
    for r in
      select cm.channel_id from dek.channel_members cm
        join dek.channels c on c.id = cm.channel_id
       where cm.user_id = p_user and cm.org_id = s.org_id and c.server_id = s.id
    loop
      perform dek.revoke_channel_membership(r.channel_id, p_user);
    end loop;
  end if;
  perform dek.audit(s.org_id, 'server.member_removed', 'server', s.id,
    jsonb_build_object('user_id', p_user, 'role', v_role));
  return jsonb_build_object('server_id', s.id, 'user_id', p_user, 'removed', true);
end $$;

create or replace function api.leave_server(p_server uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  s     dek.servers;
  r     record;
begin
  v_uid := dek.require_uid();
  s := dek.org_find_server(v_uid, p_server);
  perform 1 from dek.servers x where x.id=s.id for update;
  if dek.server_role(v_uid,s.id)='admin'and not exists(select 1 from dek.server_members sm join dek.org_members om on om.org_id=sm.org_id and om.user_id=sm.user_id where sm.server_id=s.id and sm.user_id<>v_uid and sm.role='admin'and om.status='active'and om.role<>'guest')then perform dek.err('conflict','Appoint another server Admin before leaving.');end if;
  if exists (select 1 from dek.server_members sm where sm.server_id = s.id and sm.user_id = v_uid) then
    perform dek.revoke_server_membership(s.id, v_uid);
  else
    for r in
      select cm.channel_id from dek.channel_members cm
        join dek.channels c on c.id = cm.channel_id
       where cm.user_id = v_uid and cm.org_id = s.org_id and c.server_id = s.id
    loop
      perform dek.revoke_channel_membership(r.channel_id, v_uid);
    end loop;
  end if;
  perform dek.org_withdraw_requests(s.org_id, v_uid, s.id);
  return jsonb_build_object('server_id', s.id, 'left', true);
end $$;

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

create or replace function api.update_channel(p_channel uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid        uuid;
  v_key        text;
  v_was_public boolean;
  c            dek.channels;
  v_before     dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.channel_for_action105(v_uid,p_channel,'edit_channels');
  v_before := c;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform dek.err('invalid_input', 'patch must be an object.');
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('name', 'topic', 'description', 'posting_policy', 'allow_replies', 'allow_reactions',
                     'auto_join', 'position', 'category', 'visibility') then
      perform dek.err('invalid_input', format('%s cannot be changed here.', v_key));
    end if;
  end loop;
  perform dek.org_assert_channel_writable(c);
  v_was_public := c.visibility = 'public';
  if p_patch ? 'name' then
    c.name := dek.org_patch_text(p_patch, 'name', 80, true);
    if exists (select 1 from dek.channels x where x.server_id = c.server_id and lower(x.name) = lower(c.name)
                                              and x.archived_at is null and x.id <> c.id) then
      perform dek.err('conflict', 'A channel with that name already exists in this team server.');
    end if;
  end if;
  if p_patch ? 'topic' then
    c.topic := dek.org_patch_text(p_patch, 'topic', 250);
  end if;
  if p_patch ? 'description' then
    c.description := dek.org_patch_text(p_patch, 'description', 1000, false, false);
  end if;
  if p_patch ? 'posting_policy' then
    c.posting_policy := dek.org_patch_enum(p_patch, 'posting_policy', array['everyone', 'admins']);
  end if;
  if p_patch ? 'allow_replies' then
    c.allow_replies := dek.org_patch_bool(p_patch, 'allow_replies');
  end if;
  if p_patch ? 'allow_reactions' then
    c.allow_reactions := dek.org_patch_bool(p_patch, 'allow_reactions');
  end if;
  if p_patch ? 'auto_join' then
    if not dek.has_server_permission105(v_uid,c.server_id,'edit_channels')then
      perform dek.err('forbidden', 'Only server admins can change auto join.');
    end if;
    c.auto_join := dek.org_patch_bool(p_patch, 'auto_join');
  end if;
  if p_patch ? 'position' then
    c.position := dek.org_patch_int(p_patch, 'position', -100000, 100000);
  end if;
  if p_patch ? 'category' then
    c.category := dek.org_patch_text(p_patch, 'category', 40);
  end if;
  if p_patch ? 'visibility' then
    c.visibility := dek.org_patch_enum(p_patch, 'visibility', array['public', 'private']);
    if c.visibility = 'public' and not v_was_public then
      perform dek.err('invalid_input', 'A private channel cannot be made public.');
    end if;
  end if;
  -- auto_join is for public channels only: otherwise everyone who joins the server later
  -- would be added to a private channel and read its history
  if c.visibility = 'private' and c.auto_join then
    if p_patch ? 'auto_join' then
      perform dek.err('invalid_input', 'Only public channels can join new members automatically.');
    end if;
    c.auto_join := false;
  end if;
  begin
    update dek.channels x
       set name = c.name, topic = c.topic, description = c.description, posting_policy = c.posting_policy,
           allow_replies = c.allow_replies, allow_reactions = c.allow_reactions, auto_join = c.auto_join,
           position = c.position, category = c.category, visibility = c.visibility
     where x.id = c.id
    returning * into c;
  exception when unique_violation then
    perform dek.err('conflict', 'A channel with that name already exists in this team server.');
  end;
  perform dek.emit_channel(c.id, 'chan.upd', jsonb_build_object('channel', dek.channel_public_json(c)));
  if v_was_public and c.visibility = 'private' then
    -- server members who read it as a public channel without joining lose it now. They
    -- are told only what they already knew (the fields before this patch) plus the new
    -- visibility, never a topic or description written in the same patch.
    perform dek.emit_many(array['s:' || c.server_id::text], 'chan.upd', jsonb_build_object('channel',
      dek.channel_public_json(v_before) || jsonb_build_object('visibility', 'private')));
  end if;
  perform dek.audit(c.org_id, 'channel.updated', 'channel', c.id, jsonb_build_object('patch', p_patch));
  return dek.channel_json(c, v_uid);
end $$;

create or replace function api.archive_channel(p_channel uuid, p_archived boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.channel_for_action105(v_uid,p_channel,'edit_channels');
  if p_archived is null then
    perform dek.err('invalid_input', 'archived must be true or false.');
  end if;
  if p_archived = (c.archived_at is not null) then
    return dek.channel_json(c, v_uid);
  end if;
  if p_archived then
    update dek.channels x set archived_at = now(), archived_by = v_uid where x.id = c.id returning * into c;
  else
    if exists (select 1 from dek.channels x where x.server_id = c.server_id and lower(x.name) = lower(c.name)
                                              and x.archived_at is null and x.id <> c.id) then
      perform dek.err('conflict', 'Another channel now has this name. Rename it first.');
    end if;
    update dek.channels x set archived_at = null, archived_by = null where x.id = c.id returning * into c;
  end if;
  perform dek.emit_channel(c.id, 'chan.upd', jsonb_build_object('channel', dek.channel_public_json(c)));
  perform dek.audit(c.org_id, case when p_archived then 'channel.archived' else 'channel.unarchived' end,
                    'channel', c.id, jsonb_build_object('name', c.name));
  return dek.channel_json(c, v_uid);
end $$;

create or replace function api.remove_channel_member(p_channel uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.channel_for_action105(v_uid,p_channel,'remove_people');
  if not exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = p_user) then
    perform dek.err('not_found', 'That person is not in this channel.');
  end if;
  perform dek.assert_server_target105(v_uid,c.server_id,p_user);
  perform dek.revoke_channel_membership(c.id, p_user);
  perform dek.audit(c.org_id, 'channel.member_removed', 'channel', c.id, jsonb_build_object('user_id', p_user));
  return jsonb_build_object('channel_id', c.id, 'user_id', p_user, 'removed', true);
end $$;

create or replace function api.delete_channel(p_channel uuid, p_confirm_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid;
  c         dek.channels;
  v_members uuid[];
  v_msgs    bigint;
begin
  v_uid := dek.require_uid();
  c := dek.channel_for_action105(v_uid,p_channel,'delete_channels');
  perform dek.rate_hit(v_uid, 'channel_delete', 20, 3600);
  if p_confirm_name is null or lower(btrim(p_confirm_name)) <> lower(btrim(coalesce(c.name, ''))) then
    perform dek.err('invalid_input', 'Type the channel name exactly to delete it.');
  end if;
  select coalesce(array_agg(cm.user_id), '{}') into v_members
    from (select user_id from dek.channel_members where channel_id = c.id limit 5000) cm;
  select count(*) into v_msgs from (select 1 from dek.messages m where m.channel_id = c.id limit 100000) x;
  perform dek.emit_users(v_members, 'access.revoked', jsonb_build_object('scope', 'channel', 'id', c.id));
  perform dek.audit(c.org_id, 'channel.deleted', 'channel', c.id,
                    jsonb_build_object('name', c.name, 'server_id', c.server_id, 'members', cardinality(v_members), 'messages', v_msgs));
  delete from dek.channels x where x.id = c.id;
  return jsonb_build_object('channel_id', c.id, 'deleted', true);
end $$;

create or replace function api.add_channel_members(p_channel uuid, p_user_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid;
  v_right   text;
  v_ids     uuid[];
  v_added   uuid[] := '{}';
  v_already uuid[] := '{}';
  u         uuid;
  c         dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_find_channel(v_uid, p_channel);
  if c.kind in ('dm', 'group_dm') then
    if dek.can_read_channel(v_uid, c.id) then
      perform dek.err('invalid_input', 'People cannot be added to a direct message. Start a new conversation instead.');
    end if;
    perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
  end if;
  c:=dek.channel_for_action105(v_uid,p_channel,'add_people');
  v_right := dek.org_channel_add_right(v_uid, c);
  if v_right is null then
    perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
  elsif v_right = 'none' then
    perform dek.err('forbidden', case when c.visibility = 'private'
      then 'Only the channel owner or a server admin can add people to a private channel.'
      else 'Join the channel before adding people to it.' end);
  end if;
  perform dek.org_assert_channel_writable(c);
  v_ids := dek.org_require_members(c.org_id, p_user_ids, true, 100);
  if cardinality(v_ids) = 0 then
    perform dek.err('invalid_input', 'Choose at least one person to add.');
  end if;
  if v_right = 'public' and exists (
       select 1 from unnest(v_ids) x
        where not exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = x)
          and (dek.org_role(x, c.org_id) = 'guest'
               or not exists (select 1 from dek.server_members sm
                               where sm.server_id = c.server_id and sm.user_id = x))) then
    perform dek.err('forbidden', 'Only the channel owner or a server admin can add guests or people from other teams.');
  end if;
  foreach u in array v_ids loop
    if dek.org_grant_channel_membership(c.id, u, 'member', v_uid) then
      v_added := v_added || u;
    else
      v_already := v_already || u;
    end if;
  end loop;
  if cardinality(v_added) > 0 then
    perform dek.audit(c.org_id, 'channel.members_added', 'channel', c.id,
      jsonb_build_object('user_ids', to_jsonb(v_added)));
  end if;
  return jsonb_build_object('channel_id', c.id, 'added', to_jsonb(v_added), 'already_members', to_jsonb(v_already));
end $$;

create or replace function api.create_invite(p_org uuid, p_server uuid default null,
                                             p_channel_ids uuid[] default '{}', p_role text default 'member',
                                             p_email text default null, p_expires_hours int default null,
                                             p_max_uses int default null, p_requires_approval boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid;
  v_my_role   text;
  v_role      text := coalesce(p_role, 'member');
  v_settings  jsonb;
  v_channels  uuid[];
  v_found     int := 0;
  v_right     text;
  v_email     text;
  v_hours     int;
  v_code      text;
  v_attempt   int := 0;
  s           dek.servers;
  c           dek.channels;
  i           dek.invites;
begin
  v_uid := dek.require_uid();
  v_my_role := dek.require_org(v_uid, p_org);
  select dek.org_settings(o) into v_settings from dek.orgs o where o.id = p_org;
  if v_role not in ('member', 'guest') then
    perform dek.err('invalid_input', 'role must be one of: member, guest.');
  end if;
  if v_my_role = 'guest' then
    perform dek.err('forbidden', 'Guests cannot invite people.');
  end if;
  if p_server is not null then
    select * into s from dek.servers x where x.id = p_server and x.org_id = p_org;
    if not found or dek.org_server_access(v_uid, s.id) is null then
      perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
    end if;
    if s.archived_at is not null then
      perform dek.err('archived', 'This team server is archived.');
    end if;
    if v_role = 'guest' then
      perform dek.err('invalid_input', 'Guests cannot join team servers. Invite them to channels instead.');
    end if;
  end if;
  if s.id is not null then
    s:=dek.lock_server_action105(v_uid,s.id,'invite_people');
  elsif v_my_role not in('owner','admin')and not coalesce((v_settings->>'member_can_invite')::boolean,false)then
    perform dek.err('forbidden','Only admins can invite people to this organization.');
  end if;
  if v_role = 'guest' and not coalesce((v_settings ->> 'allow_guests')::boolean, true) then
    perform dek.err('forbidden', 'Guests are turned off for this organization.');
  end if;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_channels
    from unnest(coalesce(p_channel_ids, '{}'::uuid[])) x where x is not null;
  if cardinality(v_channels) > 20 then
    perform dek.err('invalid_input', 'An invite can name at most 20 channels.');
  end if;
  for c in select * from dek.channels x where x.id = any (v_channels) loop
    v_found := v_found + 1;
    v_right := case when c.org_id = p_org and c.kind in ('text', 'audio')
                    then dek.org_channel_add_right(v_uid, c) end;
    if v_right is null then
      perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
    end if;
    perform dek.org_assert_channel_writable(c);
    -- (s.id is not null) keeps this false, not null, for an org-level invite
    if not (v_right = 'manage'
            or (v_right = 'public' and v_role = 'member' and s.id is not null and c.server_id = s.id)) then
      perform dek.err('forbidden', 'You can only invite people to channels you could add them to yourself.');
    end if;
  end loop;
  if v_found <> cardinality(v_channels) then
    perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
  end if;
  v_email := lower(dek.org_clean_text(p_email, 'email', 254));
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    perform dek.err('invalid_input', 'email must be an email address.');
  end if;
  v_hours := coalesce(p_expires_hours, (v_settings ->> 'default_invite_hours')::int, 168);
  if v_hours < 1 or v_hours > 720 then
    perform dek.err('invalid_input', 'expires_hours must be from 1 to 720 (30 days).');
  end if;
  if p_max_uses is not null and (p_max_uses < 1 or p_max_uses > 10000) then
    perform dek.err('invalid_input', 'max_uses must be from 1 to 10000.');
  end if;
  loop
    v_code := dek.org_new_invite_code();
    begin
      insert into dek.invites (org_id, server_id, channel_ids, role, code, code_sha256, email, requires_approval,
                               created_by, expires_at, max_uses)
      values (p_org, s.id, v_channels, v_role, v_code, sha256(convert_to(v_code, 'UTF8')), v_email,
              coalesce(p_requires_approval, false), v_uid, now() + make_interval(hours => v_hours), p_max_uses)
      returning * into i;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;   -- a 131-bit collision: practically never, but never fatal
      if v_attempt >= 3 then
        raise;
      end if;
    end;
  end loop;
  perform dek.audit(p_org, 'invite.created', 'invite', i.id, jsonb_build_object(
    'server_id', i.server_id, 'channel_ids', to_jsonb(i.channel_ids), 'role', i.role, 'email', i.email,
    'expires_at', i.expires_at, 'max_uses', i.max_uses, 'requires_approval', i.requires_approval));
  return jsonb_build_object('id', i.id, 'code', i.code, 'expires_at', i.expires_at, 'url_path', '/invite/' || i.code);
end $$;

create or replace function dek.org_invite_creator_ok(i dek.invites)
returns boolean language sql stable set search_path = '' as $$
  select case when i.server_id is not null then
   (i.created_by is null or dek.has_server_permission105(i.created_by,i.server_id,'invite_people'))
   else i.created_by is null or exists(select 1 from dek.org_members m where m.org_id=i.org_id and m.user_id=i.created_by and m.status='active'
    and(m.role in('owner','admin')or(m.role='member'and(i.legacy_id is not null or dek.org_setting_on(i.org_id,'member_can_invite')))))end
$$;

create or replace function api.list_invites(p_org uuid, p_server uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_all   boolean;
  v_items jsonb;
  s       dek.servers;
begin
  v_uid := dek.require_uid();
  v_admin := dek.require_org(v_uid, p_org) in ('owner', 'admin');
  v_all := v_admin;
  if p_server is not null then
    s := dek.server_for_action105(v_uid,p_server,'invite_people');  -- not_found or forbidden for others
    if s.org_id <> p_org then
      perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
    end if;
    v_all := true;
  end if;
  select coalesce(jsonb_agg(dek.org_invite_json(i) order by i.created_at desc, i.id), '[]'::jsonb)
    into v_items
    from (select x.id from dek.invites x
           where x.org_id = p_org
             and (p_server is null or x.server_id = p_server)
             and (v_all or x.created_by = v_uid)
           order by x.created_at desc
           limit 200) ids
    join dek.invites i on i.id = ids.id;
  return jsonb_build_object('items', v_items);
end $$;

create or replace function api.revoke_invite(p_invite uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_role text;
  i      dek.invites;
begin
  v_uid := dek.require_uid();
  select * into i from dek.invites x where x.id = p_invite for update;
  v_role := dek.org_require_member(v_uid, i.org_id, 'That invite does not exist.');
  -- coalesce: a migrated invite can have no creator, and a NULL here would skip the check
  if not (v_role in ('owner', 'admin') or coalesce(i.created_by = v_uid, false)
          or (i.server_id is not null and dek.has_server_permission105(v_uid,i.server_id,'invite_people'))) then
    perform dek.err('not_found', 'That invite does not exist.');
  end if;
  if i.revoked_at is null then
    update dek.invites x set revoked_at = now(), revoked_by = v_uid where x.id = i.id returning * into i;
    perform dek.audit(i.org_id, 'invite.revoked', 'invite', i.id, jsonb_build_object('server_id', i.server_id));
  end if;
  return dek.org_invite_json(i);
end $$;

create or replace function api.list_join_requests(p_org uuid, p_status text default 'pending')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_servers uuid[];
  v_items   jsonb;
begin
  v_uid := dek.require_uid();
  v_admin := dek.require_org(v_uid, p_org) in ('owner', 'admin');
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'withdrawn') then
    perform dek.err('invalid_input', 'status must be one of: pending, approved, rejected, withdrawn.');
  end if;
  if not v_admin then
    select coalesce(array_agg(sm.server_id), '{}'::uuid[]) into v_servers
      from dek.server_members sm where sm.user_id = v_uid and sm.org_id = p_org and dek.has_server_permission105(v_uid,sm.server_id,'decide_join_requests');
    if cardinality(v_servers) = 0 then
      perform dek.err('forbidden', 'Only admins can review join requests.');
    end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'user', dek.profile_json(p), 'email', case when v_admin then u.email end,
           'server_id', r.server_id,
           'invite_id', r.invite_id, 'note', r.note, 'status', r.status, 'created_at', r.created_at)
           order by r.created_at desc, r.id), '[]'::jsonb)
    into v_items
    from (select x.id from dek.join_requests x
           where x.org_id = p_org and (p_status is null or x.status = p_status)
             and (v_admin or x.server_id = any (v_servers))
           order by x.created_at desc
           limit 200) ids
    join dek.join_requests r on r.id = ids.id
    join dek.profiles p on p.id = r.user_id
    left join auth.users u on u.id = r.user_id;
  return jsonb_build_object('items', v_items);
end $$;

create or replace function api.decide_join_request(p_request uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  r     dek.join_requests;
  i     dek.invites;
  m     dek.org_members;
begin
  v_uid := dek.require_uid();
  select * into r from dek.join_requests x where x.id = p_request;
  perform dek.org_require_member(v_uid, r.org_id, 'That join request does not exist.');
  if not (dek.is_org_admin(v_uid, r.org_id)
          or (r.server_id is not null and dek.has_server_permission105(v_uid,r.server_id,'decide_join_requests'))) then
    perform dek.err('forbidden', 'Only admins can decide join requests.');
  end if;
  if r.server_id is not null then perform dek.lock_server_action105(v_uid,r.server_id,'decide_join_requests');end if;
  select * into r from dek.join_requests x where x.id=p_request for update;
  if p_approve is null then
    perform dek.err('invalid_input', 'approve must be true or false.');
  end if;
  if r.status <> 'pending' then
    perform dek.err('conflict', 'This request has already been decided.');
  end if;
  if p_approve then
    if exists (select 1 from dek.org_bans b where b.org_id = r.org_id and b.user_id = r.user_id) then
      perform dek.err('forbidden', 'This person is banned from the organization.');
    end if;
    select * into m from dek.org_members x where x.org_id = r.org_id and x.user_id = r.user_id;
    if m.user_id is not null and m.status <> 'active' then
      perform dek.err('conflict', 'This person is suspended in this organization.');
    end if;
    if r.server_id is not null
       and exists (select 1 from dek.servers s where s.id = r.server_id and s.archived_at is not null) then
      perform dek.err('archived', 'That team server is archived.');
    end if;
    if r.invite_id is not null then
      select * into i from dek.invites x where x.id = r.invite_id;
      -- Acceptance already reserved this use; expiry/max_uses must not invalidate that pending request.
      if i.revoked_at is not null or not dek.org_invite_creator_ok(i)then perform dek.err('conflict','The invitation or its issuer authority was revoked.');end if;
    end if;
    -- the invite's channels only as far as its creator could still grant them
    perform dek.org_apply_grant(r.org_id, r.server_id,
                                case when i.id is null then '{}'::uuid[] else dek.org_invite_channels(i) end,
                                coalesce(i.role, 'member'), r.user_id, v_uid);
  end if;
  update dek.join_requests x
     set status = case when p_approve then 'approved' else 'rejected' end, decided_by = v_uid, decided_at = now()
   where x.id = r.id
  returning * into r;
  perform dek.audit(r.org_id, case when p_approve then 'join_request.approved' else 'join_request.rejected' end,
                    'user', r.user_id, jsonb_build_object('request_id', r.id, 'server_id', r.server_id));
  return jsonb_build_object('id', r.id, 'status', r.status, 'org_id', r.org_id, 'server_id', r.server_id,
                            'user_id', r.user_id);
end $$;

create or replace function dek.may_decide_channel_request(p_uid uuid,c dek.channels)returns boolean
language sql stable security definer set search_path=''as $fn$
 select dek.has_server_permission105(p_uid,c.server_id,'decide_join_requests')and(dek.can_read_channel(p_uid,c.id)or dek.is_server_admin(p_uid,c.server_id))
$fn$;
create or replace function dek.channel_approvers(p_channel uuid)returns uuid[]
language sql stable security definer set search_path=''as $fn$
 select coalesce(array_agg(t.user_id),'{}'::uuid[])from(
  select u.user_id from dek.channels c cross join lateral(select sm.user_id from dek.server_members sm where sm.server_id=c.server_id union select om.user_id from dek.org_members om where om.org_id=c.org_id and om.role in('owner','admin')and om.status='active')u
  where c.id=p_channel and dek.may_decide_channel_request(u.user_id,c)order by u.user_id limit 50)t
$fn$;


create or replace function api.decide_channel_request(p_request uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  r     dek.channel_join_requests;
  c     dek.channels;
  m     dek.org_members;
begin
  v_uid := dek.require_uid();
  select * into r from dek.channel_join_requests x where x.id = p_request;
  perform dek.org_require_member(v_uid, r.org_id, 'That join request does not exist.');
  select * into c from dek.channels x where x.id = r.channel_id;
  if not dek.may_decide_channel_request(v_uid, c) then
    perform dek.err('forbidden', 'Only the channel owner or an admin of its team server can decide this.');
  end if;
  perform dek.lock_server_action105(v_uid,c.server_id,'decide_join_requests');
  select * into r from dek.channel_join_requests x where x.id=p_request for update;
  if p_approve is null then
    perform dek.err('invalid_input', 'approve must be true or false.');
  end if;
  if r.status <> 'pending' then
    perform dek.err('conflict', case r.status when 'withdrawn' then 'They took this request back.'
                                              else 'This request has already been decided.' end);
  end if;
  if p_approve then
    if c.archived_at is not null then
      perform dek.err('archived', 'This channel is archived.');
    end if;
    select * into m from dek.org_members x where x.org_id = r.org_id and x.user_id = r.user_id;
    if m.user_id is null or m.status <> 'active' then
      perform dek.err('conflict', 'This person is no longer an active member of the organization.');
    end if;
    perform dek.org_grant_channel_membership(c.id, r.user_id, 'member', v_uid);
  end if;
  update dek.channel_join_requests x
     set status = case when p_approve then 'approved' else 'rejected' end, decided_by = v_uid, decided_at = now()
   where x.id = r.id
  returning * into r;
  perform dek.emit_users(dek.channel_approvers(c.id) || r.user_id, 'join.req', jsonb_build_object(
    'org_id', c.org_id, 'channel_id', c.id, 'request_id', r.id, 'user_id', r.user_id, 'change', r.status));
  if p_approve then
    insert into dek.notification_intents (org_id, kind, channel_id, actor_id, target_user_id, channel_request_id)
    values (c.org_id, 'request', c.id, v_uid, r.user_id, r.id);
  end if;
  perform dek.audit(c.org_id, case when p_approve then 'channel.join_approved' else 'channel.join_rejected' end,
                    'channel', c.id, jsonb_build_object('request_id', r.id, 'user_id', r.user_id));
  return jsonb_build_object('id', r.id, 'status', r.status, 'channel_id', c.id, 'user_id', r.user_id);
end $$;
