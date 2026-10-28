-- 0101: team servers and server membership (CONTRACT 2.3). Owner: [org].
-- Helpers (dek.org_*) live in 0100. Same rules and re-run pattern as 0100.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api' and p.proname = any (array[
              'list_servers', 'create_server', 'update_server', 'archive_server', 'join_server',
              'leave_server', 'list_server_members', 'add_server_members', 'remove_server_member',
              'set_server_role']))
        or (n.nspname = 'dek' and p.proname = any (array['org_server_member_item']))
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

-- list_server_members item: { profile, role, joined_at }.
create or replace function dek.org_server_member_item(p_server uuid, p_user uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('profile', dek.profile_json(p), 'role', sm.role, 'joined_at', sm.joined_at)
    from dek.server_members sm
    join dek.profiles p on p.id = sm.user_id
   where sm.server_id = p_server and sm.user_id = p_user
$$;

-- Servers I am in (my_role set), servers I only reach through channel memberships
-- (my_role null, partial), and the servers I may browse to join: open and approval
-- servers for members, every server for org admins (they administer all of them).
-- Guests never browse. Never another organization.
create or replace function api.list_servers(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_role text;
  v_out  jsonb;
begin
  v_uid := dek.require_uid();
  v_role := dek.require_org(v_uid, p_org);
  select coalesce(jsonb_agg(dek.server_json(s, v_uid) order by s.position, lower(s.name), s.id), '[]'::jsonb)
    into v_out
    from (select x.id
            from dek.servers x
           where x.org_id = p_org
             and (v_role in ('owner', 'admin')
                  or (v_role = 'member' and x.join_policy in ('open', 'approval') and x.archived_at is null)
                  or x.id in (select sm.server_id from dek.server_members sm
                               where sm.user_id = v_uid and sm.org_id = p_org)
                  or x.id in (select c.server_id from dek.channel_members cm
                                join dek.channels c on c.id = cm.channel_id
                               where cm.user_id = v_uid and cm.org_id = p_org and c.server_id is not null))
           order by x.position, x.id
           limit 200) ids
    join dek.servers s on s.id = ids.id;
  return v_out;
end $$;

-- Org admins, or members when member_can_create_channels. The creator becomes server
-- admin and owner of #general, which is public and auto_join.
create or replace function api.create_server(p_org uuid, p_name text, p_description text default null,
                                             p_join_policy text default 'invite', p_icon_emoji text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_role   text;
  v_name   text;
  v_desc   text;
  v_icon   text;
  v_policy text := coalesce(p_join_policy, 'invite');
  s        dek.servers;
  c        dek.channels;
begin
  v_uid := dek.require_uid();
  v_role := dek.require_org(v_uid, p_org);
  if v_role = 'guest' or (v_role = 'member' and not dek.org_setting_on(p_org, 'member_can_create_channels')) then
    perform dek.err('forbidden', 'Only organization admins can create team servers here.');
  end if;
  v_name := dek.org_clean_text(p_name, 'name', 80, true);
  v_desc := dek.org_clean_text(p_description, 'description', 1000, false, false);
  v_icon := dek.org_clean_text(p_icon_emoji, 'icon_emoji', 64);
  if v_policy not in ('open', 'approval', 'invite') then
    perform dek.err('invalid_input', 'join_policy must be one of: open, approval, invite.');
  end if;
  if exists (select 1 from dek.servers x
              where x.org_id = p_org and lower(x.name) = lower(v_name) and x.archived_at is null) then
    perform dek.err('conflict', 'A team server with that name already exists.');
  end if;
  begin
    insert into dek.servers (org_id, name, description, icon_emoji, position, join_policy, created_by)
    values (p_org, v_name, v_desc, v_icon,
            coalesce((select max(x.position) + 1 from dek.servers x where x.org_id = p_org), 0),
            v_policy, v_uid)
    returning * into s;
  exception when unique_violation then
    perform dek.err('conflict', 'A team server with that name already exists.');
  end;
  insert into dek.server_members (server_id, user_id, org_id, role, added_by)
  values (s.id, v_uid, p_org, 'admin', v_uid);
  insert into dek.channels (org_id, server_id, kind, name, visibility, auto_join, position, created_by)
  values (p_org, s.id, 'text', 'general', 'public', true, 0, v_uid)
  returning * into c;
  insert into dek.channel_members (channel_id, user_id, org_id, role, added_by)
  values (c.id, v_uid, p_org, 'owner', v_uid);
  perform dek.emit_many(array['u:' || v_uid::text, 's:' || s.id::text], 'member.upd',
    jsonb_build_object('scope', 'server', 'id', s.id, 'user_id', v_uid, 'change', 'added'));
  perform dek.emit_channel(c.id, 'chan.upd', jsonb_build_object('channel', dek.channel_public_json(c)));
  perform dek.audit(p_org, 'server.created', 'server', s.id,
    jsonb_build_object('name', s.name, 'join_policy', s.join_policy));
  return dek.server_json(s, v_uid);
end $$;

create or replace function api.update_server(p_server uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_key text;
  s     dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.org_server_for_admin(v_uid, p_server);
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

-- Archived = read only (dek.assert_post checks the server's archived_at).
create or replace function api.archive_server(p_server uuid, p_archived boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  s     dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.org_server_for_admin(v_uid, p_server);
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

-- Open servers join at once, approval servers file a pending request, invite servers
-- refuse (org admins may always join). Guests never join servers.
create or replace function api.join_server(p_server uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_role text;
  s      dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.org_find_server(v_uid, p_server);
  v_role := dek.org_role(v_uid, s.org_id);
  if exists (select 1 from dek.server_members sm where sm.server_id = s.id and sm.user_id = v_uid) then
    return jsonb_build_object('status', 'joined');
  end if;
  if dek.org_server_access(v_uid, s.id) is null then
    -- an invite-only server the caller cannot see answers like one that does not exist
    perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
  end if;
  if v_role = 'guest' then
    perform dek.err('forbidden', 'Guests can only use the channels they are added to.');
  end if;
  if s.archived_at is not null then
    perform dek.err('archived', 'This team server is archived.');
  end if;
  if s.join_policy = 'open' or v_role in ('owner', 'admin') then
    perform dek.org_grant_server_membership(s.id, v_uid, 'member', v_uid);
    if s.join_policy <> 'open' then
      -- an org admin used admin rights to walk into a closed server: that is recorded
      perform dek.audit(s.org_id, 'server.admin_joined', 'server', s.id,
        jsonb_build_object('join_policy', s.join_policy));
    end if;
    return jsonb_build_object('status', 'joined');
  end if;
  if s.join_policy = 'approval' then
    insert into dek.join_requests (org_id, server_id, user_id) values (s.org_id, s.id, v_uid)
    on conflict do nothing;
    return jsonb_build_object('status', 'pending');
  end if;
  perform dek.err('forbidden', 'This team server is invite only. Ask one of its admins to add you.');
end $$;

-- Server members: dek.revoke_server_membership (the server and every channel in it,
-- DEKA06). Cross-team people who only hold channel memberships here leave each of
-- those channels. Idempotent within the caller's organization.
create or replace function api.leave_server(p_server uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  s     dek.servers;
  r     record;
begin
  v_uid := dek.require_uid();
  s := dek.org_find_server(v_uid, p_server);
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

-- Server members and org admins. People who only reach the server through a channel
-- (cross-team, guests) or only browse it see nothing more of it than their channels
-- (DEK02). Suspended members are left out of the list.
create or replace function api.list_server_members(p_server uuid, p_query text default null,
                                                   p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_access text;
  v_like   text := dek.org_like_pattern(p_query);
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_off   int := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_total int;
  v_items jsonb;
  s       dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.org_find_server(v_uid, p_server);
  v_access := dek.org_server_access(v_uid, s.id);
  if v_access is null then
    perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
  end if;
  if v_access <> 'member' and not dek.is_org_admin(v_uid, s.org_id) then
    perform dek.err('forbidden', 'Only members of this team server can see who is in it.');
  end if;
  -- one pass over the server's members; items are built from the joined rows
  with matched as (
    select sm.user_id, sm.role, sm.joined_at, p as prof, lower(p.display_name) as sort_name,
           case sm.role when 'admin' then 0 when 'moderator' then 1 else 2 end as rank
      from dek.server_members sm
      join dek.org_members om on om.org_id = sm.org_id and om.user_id = sm.user_id and om.status = 'active'
      join dek.profiles p on p.id = sm.user_id
     where sm.server_id = s.id
       and (v_like is null or p.display_name ilike v_like or p.handle ilike v_like)
  )
  select (select count(*) from (select 1 from matched limit 10000) x),
         (select coalesce(jsonb_agg(jsonb_build_object('profile', dek.profile_json(pg.prof), 'role', pg.role,
                                                       'joined_at', pg.joined_at)
                                    order by pg.rank, pg.sort_name, pg.user_id), '[]'::jsonb)
            from (select * from matched order by rank, sort_name, user_id limit v_limit offset v_off) pg)
    into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- Server admins (and org admins). Everyone added must be an active, non-guest org
-- member; each one auto-joins the server's auto_join channels.
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
  s := dek.org_server_for_admin(v_uid, p_server);
  if s.archived_at is not null then
    perform dek.err('archived', 'This team server is archived.');
  end if;
  if v_role not in ('admin', 'moderator', 'member') then
    perform dek.err('invalid_input', 'role must be one of: admin, moderator, member.');
  end if;
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

-- Server admins and moderators; moderators cannot remove admins (server admins or org
-- admins). A cross-team person who only holds channel memberships here is removed
-- from each of those channels.
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
  if not dek.is_server_mod(v_uid, s.id) then
    if dek.org_server_access(v_uid, s.id) is null then
      perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
    end if;
    perform dek.err('forbidden', 'Only admins and moderators of this team server can remove people.');
  end if;
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

create or replace function api.set_server_role(p_server uuid, p_user uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_old text;
  s     dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.org_server_for_admin(v_uid, p_server);
  if p_role is null or p_role not in ('admin', 'moderator', 'member') then
    perform dek.err('invalid_input', 'role must be one of: admin, moderator, member.');
  end if;
  select sm.role into v_old from dek.server_members sm
   where sm.server_id = s.id and sm.user_id = p_user for update;
  if v_old is null then
    perform dek.err('not_found', 'That person is not a member of this team server.');
  end if;
  if v_old <> p_role then
    update dek.server_members x set role = p_role where x.server_id = s.id and x.user_id = p_user;
    perform dek.emit_many(array['u:' || p_user::text, 's:' || s.id::text], 'member.upd',
      jsonb_build_object('scope', 'server', 'id', s.id, 'user_id', p_user, 'change', 'role'));
    perform dek.audit(s.org_id, 'server.role_changed', 'user', p_user,
      jsonb_build_object('server_id', s.id, 'from', v_old, 'to', p_role));
  end if;
  return dek.org_server_member_item(s.id, p_user);
end $$;
