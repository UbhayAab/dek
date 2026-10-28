-- 0102: channels, channel membership and DMs (CONTRACT 2.3). Owner: [org].
-- Helpers (dek.org_*) live in 0100. Same rules and re-run pattern as 0100.
--
-- The read rule is dek.can_read_channel and nothing else: a cross-team contributor
-- added to one private channel (Grants) reads that channel and nothing more in the
-- host server (DEK02, DEKA04).

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api' and p.proname = any (array[
              'list_channels', 'create_channel', 'update_channel', 'archive_channel', 'join_channel',
              'leave_channel', 'add_channel_members', 'remove_channel_member', 'list_channel_members',
              'set_channel_notify', 'open_dm', 'hide_dm']))
        or (n.nspname = 'dek' and p.proname = any (array[
              'org_channel_for_manage', 'org_channel_add_right', 'org_assert_channel_writable']))
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

-- =====================================================================
-- Helpers
-- =====================================================================

-- A team channel the caller manages: its owner, or an admin of its server or org.
-- People who cannot see it get not_found, people who can see it get forbidden.
create or replace function dek.org_channel_for_manage(p_uid uuid, p_channel uuid)
returns dek.channels language plpgsql set search_path = '' as $$
declare c dek.channels;
begin
  c := dek.org_find_channel(p_uid, p_channel);
  if c.kind in ('text', 'audio')
     and (dek.is_server_admin(p_uid, c.server_id)
          or exists (select 1 from dek.channel_members cm
                      where cm.channel_id = c.id and cm.user_id = p_uid and cm.role = 'owner')) then
    return c;
  end if;
  if dek.can_read_channel(p_uid, c.id) then
    perform dek.err('forbidden', case when c.kind in ('dm', 'group_dm')
      then 'Direct messages have no settings or members to manage.'
      else 'Only the channel owner or a server admin can do that.' end);
  end if;
  perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
end $$;

-- Who may add people to a team channel: 'manage' (owner, server or org admin: any
-- active org member, guests and other teams included), 'public' (a member of a public
-- channel: people already in its server), 'none' (sees it, may not add), null (cannot
-- see it).
create or replace function dek.org_channel_add_right(p_uid uuid, c dek.channels)
returns text language sql stable set search_path = '' as $$
  select case
    when dek.is_server_admin(p_uid, c.server_id) then 'manage'
    when exists (select 1 from dek.channel_members cm
                  where cm.channel_id = c.id and cm.user_id = p_uid and cm.role = 'owner') then 'manage'
    when not dek.can_read_channel(p_uid, c.id) then null
    when c.visibility = 'public' and exists (select 1 from dek.channel_members cm
                                              where cm.channel_id = c.id and cm.user_id = p_uid) then 'public'
    else 'none'
  end
$$;

-- Membership changes need a live channel in a live server.
create or replace function dek.org_assert_channel_writable(c dek.channels)
returns void language plpgsql set search_path = '' as $$
begin
  if c.archived_at is not null
     or exists (select 1 from dek.servers s where s.id = c.server_id and s.archived_at is not null) then
    perform dek.err('archived', 'This channel is archived. Unarchive it first.');
  end if;
end $$;

-- =====================================================================
-- Channels
-- =====================================================================

-- Server members: the server's public channels (joined or not) plus private channels
-- they are in. Partial access (cross-team, guests) and browsers: only channels they
-- are in. Each item is the per-caller Channel shape.
create or replace function api.list_channels(p_server uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_access text;
  v_out    jsonb;
  s        dek.servers;
begin
  v_uid := dek.require_uid();
  s := dek.org_find_server(v_uid, p_server);
  v_access := dek.org_server_access(v_uid, s.id);
  if v_access is null then
    perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
  end if;
  select coalesce(jsonb_agg(dek.channel_json(c, v_uid) order by c.position, lower(c.name), c.id), '[]'::jsonb)
    into v_out
    from (select x.id from dek.channels x
           where x.server_id = s.id
             and ((v_access = 'member' and x.visibility = 'public')
                  or exists (select 1 from dek.channel_members cm where cm.channel_id = x.id and cm.user_id = v_uid))
           order by x.position, x.id
           limit 500) ids
    join dek.channels c on c.id = ids.id;
  return v_out;
end $$;

-- Server members who are not guests (only server admins when the org turns
-- member_can_create_channels off). The creator owns the channel. p_member_ids may name
-- org members outside the server (cross-team, DEK02): they get this channel and
-- nothing else. Only server admins set auto_join.
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
  if not v_admin then
    if v_role = 'guest' or dek.server_role(v_uid, s.id) is null then
      if dek.org_server_access(v_uid, s.id) is null then
        perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
      end if;
      perform dek.err('forbidden', 'Only members of this team server can create channels in it.');
    end if;
    if not dek.org_setting_on(s.org_id, 'member_can_create_channels') then
      perform dek.err('forbidden', 'Only server admins can create channels in this organization.');
    end if;
  end if;
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
  if coalesce(p_auto_join, false) and not v_admin then
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

-- Channel owner or server admins. Visibility only goes public to private; posting_policy
-- 'admins' makes an announcement channel (DEK03).
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
  c := dek.org_channel_for_manage(v_uid, p_channel);
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
    if not dek.is_server_admin(v_uid, c.server_id) then
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

-- Archived channels are read only (dek.assert_post).
create or replace function api.archive_channel(p_channel uuid, p_archived boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_channel_for_manage(v_uid, p_channel);
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

-- Public channels of the caller's servers (idempotent for members).
create or replace function api.join_channel(p_channel uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_find_channel(v_uid, p_channel);
  if not exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = v_uid) then
    if c.kind not in ('text', 'audio') or c.visibility <> 'public' or not dek.can_read_channel(v_uid, c.id) then
      perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
    end if;
    perform dek.org_grant_channel_membership(c.id, v_uid, 'member', v_uid);
  end if;
  return dek.channel_json(c, v_uid);
end $$;

-- dek.revoke_channel_membership. DMs are hidden (hide_dm), never left. Idempotent.
create or replace function api.leave_channel(p_channel uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_find_channel(v_uid, p_channel);
  if not dek.can_read_channel(v_uid, c.id) then
    perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
  end if;
  if c.kind in ('dm', 'group_dm') then
    perform dek.err('invalid_input', 'A direct message cannot be left. Hide the conversation instead.');
  end if;
  if exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = v_uid) then
    perform dek.revoke_channel_membership(c.id, v_uid);
  end if;
  return jsonb_build_object('channel_id', c.id, 'left', true);
end $$;

-- Private channels: owner or server admins. Public channels: any channel member may add
-- people who are already in the server; guests and people from other teams need the
-- owner or a server admin. Everyone added must be an active org member.
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

-- Channel owner or server admins. dek.revoke_channel_membership does the work.
create or replace function api.remove_channel_member(p_channel uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_channel_for_manage(v_uid, p_channel);
  if not exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = p_user) then
    perform dek.err('not_found', 'That person is not in this channel.');
  end if;
  perform dek.revoke_channel_membership(c.id, p_user);
  perform dek.audit(c.org_id, 'channel.member_removed', 'channel', c.id, jsonb_build_object('user_id', p_user));
  return jsonb_build_object('channel_id', c.id, 'user_id', p_user, 'removed', true);
end $$;

-- Readers of the channel; server admins and moderators may also list the members of a
-- private team channel they are not in (to manage it). Never DM membership for admins.
create or replace function api.list_channel_members(p_channel uuid, p_query text default null,
                                                    p_limit int default 100, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_like  text := dek.org_like_pattern(p_query);
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_off   int := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_total int;
  v_items jsonb;
  c       dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_find_channel(v_uid, p_channel);
  if not dek.can_read_channel(v_uid, c.id)
     and not (c.server_id is not null and dek.can_moderate_channel(v_uid, c.id)) then
    perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
  end if;
  -- one pass over the channel's members; items are built from the joined rows
  with matched as (
    select cm.user_id, cm.role, cm.joined_at, p as prof, lower(p.display_name) as sort_name,
           case cm.role when 'owner' then 0 else 1 end as rank
      from dek.channel_members cm
      join dek.org_members om on om.org_id = cm.org_id and om.user_id = cm.user_id and om.status = 'active'
      join dek.profiles p on p.id = cm.user_id
     where cm.channel_id = c.id
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

-- Per-member notification level for one channel. A muted_until in the past clears it.
create or replace function api.set_channel_notify(p_channel uuid, p_level text,
                                                  p_muted_until timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_notify text;
  v_muted  timestamptz;
  c        dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_find_channel(v_uid, p_channel);
  if not dek.can_read_channel(v_uid, c.id) then
    perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
  end if;
  if p_level is null or p_level not in ('default', 'all', 'mentions', 'none') then
    perform dek.err('invalid_input', 'level must be one of: default, all, mentions, none.');
  end if;
  update dek.channel_members x
     set notify = p_level, muted_until = case when p_muted_until > now() then p_muted_until end
   where x.channel_id = c.id and x.user_id = v_uid
  returning x.notify, x.muted_until into v_notify, v_muted;
  if not found then
    perform dek.err('forbidden', 'Join the channel to change its notifications.');
  end if;
  return jsonb_build_object('channel_id', c.id, 'notify', v_notify, 'muted_until', v_muted);
end $$;

-- =====================================================================
-- Direct messages
-- =====================================================================

-- One other person = dm, two to eight = group_dm (at most 9 people). dm_key is
-- '<org>:<sorted participant ids>' for both kinds, so the same set always reopens the
-- same conversation. Everyone must be an active member of the org; a 1:1 with a block
-- either way is refused. Reopening unhides it for the caller.
create or replace function api.open_dm(p_org uuid, p_user_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_others uuid[];
  v_all    uuid[];
  v_key    text;
  v_new    boolean := false;
  u        uuid;
  c        dek.channels;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_others
    from unnest(coalesce(p_user_ids, '{}'::uuid[])) x where x is not null and x <> v_uid;
  if cardinality(v_others) = 0 then
    perform dek.err('invalid_input', 'Choose at least one person to message.');
  end if;
  if cardinality(v_others) > 8 then
    perform dek.err('invalid_input', 'A group conversation can have at most 9 people.');
  end if;
  perform dek.org_require_members(p_org, v_others, true, 8);
  -- a block either way between the caller and anyone in the set refuses it, group DMs
  -- included (otherwise a blocked person reaches the blocker by adding one more
  -- person). Blocks between two other participants are not checked: refusing those
  -- would tell the caller that those two people blocked each other.
  if exists (select 1 from dek.user_blocks b
              where (b.blocker_id = v_uid and b.blocked_id = any (v_others))
                 or (b.blocked_id = v_uid and b.blocker_id = any (v_others))) then
    perform dek.err('blocked', case when cardinality(v_others) = 1 then 'You cannot message this person.'
      else 'A block between you and someone in this group prevents this conversation.' end);
  end if;
  -- uuid order is byte order, the same order as the lowercase text form
  select array_agg(x order by x) into v_all from unnest(v_others || v_uid) x;
  v_key := p_org::text || ':' || array_to_string(v_all, ':');
  select * into c from dek.channels x where x.dm_key = v_key;
  if not found then
    insert into dek.channels (org_id, kind, visibility, dm_key, created_by)
    values (p_org, case when cardinality(v_others) = 1 then 'dm' else 'group_dm' end, 'private', v_key, v_uid)
    on conflict (dm_key) where dm_key is not null do nothing
    returning * into c;
    if c.id is null then
      select * into c from dek.channels x where x.dm_key = v_key;   -- opened by someone else just now
    else
      v_new := true;
    end if;
  end if;
  insert into dek.channel_members (channel_id, user_id, org_id, role, added_by)
  select c.id, x, c.org_id, 'member', v_uid from unnest(v_all) x
  on conflict (channel_id, user_id) do nothing;
  update dek.channel_members x set hidden = false
   where x.channel_id = c.id and x.user_id = v_uid and x.hidden;
  if v_new then
    perform dek.emit_channel(c.id, 'chan.upd', jsonb_build_object('channel', dek.channel_public_json(c)));
    foreach u in array v_others loop
      perform dek.emit_user(u, 'member.upd',
        jsonb_build_object('scope', 'channel', 'id', c.id, 'user_id', u, 'change', 'added'));
    end loop;
  end if;
  return dek.channel_json(c, v_uid);
end $$;

-- Hides a DM from the caller's sidebar only (the next message brings it back).
create or replace function api.hide_dm(p_channel uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  select * into c from dek.channels x where x.id = p_channel and x.kind in ('dm', 'group_dm');
  perform dek.org_require_member(v_uid, c.org_id, 'That conversation does not exist or you do not have access to it.');
  update dek.channel_members x set hidden = true where x.channel_id = c.id and x.user_id = v_uid;
  if not found then
    perform dek.err('not_found', 'That conversation does not exist or you do not have access to it.');
  end if;
  return jsonb_build_object('channel_id', c.id, 'hidden', true);
end $$;
