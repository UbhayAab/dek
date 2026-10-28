-- 0100: organizations and the private helpers every [org] file uses. Owner: [org].
--
-- Rules (docs/BUILDER-RULES.md): every api function is security definer with an empty
-- search_path, starts with dek.require_uid(), checks access through the foundation
-- helpers, raises only through dek.err, builds shapes with the foundation builders,
-- emits its CONTRACT section 3 event in the same transaction and audits admin actions.
-- Private helpers live in schema dek with the prefix org_.
--
-- Re-runnable: the block below drops every function this file defines (whatever its
-- signature) before re-creating it, so a signature change never leaves an overload
-- behind for PostgREST to trip over.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api' and p.proname = any (array[
              'create_org', 'update_org', 'list_org_members', 'set_org_role', 'suspend_org_member',
              'remove_org_member', 'leave_org']))
        or (n.nspname = 'dek' and p.proname = any (array[
              'org_clean_text', 'org_patch_text', 'org_patch_bool', 'org_patch_int', 'org_patch_enum',
              'org_like_pattern', 'org_validate_settings', 'org_setting_on', 'org_member_item',
              'org_lock_owners', 'org_target', 'org_assert_not_last_owner', 'org_assert_can_manage',
              'org_withdraw_requests', 'org_set_suspended', 'org_remove_member', 'org_server_access',
              'org_server_for_admin', 'org_require_members', 'org_grant_channel_membership',
              'org_grant_server_membership', 'org_require_member', 'org_find_server', 'org_find_channel']))
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

-- =====================================================================
-- 1. Input helpers
-- =====================================================================

-- Trim, turn blank into null, enforce a maximum length (and a value when required).
-- Single-line fields refuse control characters: a name with a newline breaks lists.
create or replace function dek.org_clean_text(p_value text, p_field text, p_max int,
                                              p_required boolean default false,
                                              p_single_line boolean default true)
returns text language plpgsql set search_path = '' as $$
declare v text := nullif(btrim(p_value, E' \t\r\n'), '');
begin
  if v is null then
    if p_required then
      perform dek.err('invalid_input', format('%s is required.', p_field));
    end if;
    return null;
  end if;
  if char_length(v) > p_max then
    perform dek.err('invalid_input', format('%s must be at most %s characters.', p_field, p_max));
  end if;
  if p_single_line and v ~ '[[:cntrl:]]' then
    perform dek.err('invalid_input', format('%s must be a single line of text.', p_field));
  end if;
  return v;
end $$;

-- Values from a jsonb patch, type-checked (a number where text belongs is refused,
-- not silently converted).
create or replace function dek.org_patch_text(p_patch jsonb, p_key text, p_max int,
                                              p_required boolean default false,
                                              p_single_line boolean default true)
returns text language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(p_patch -> p_key) not in ('string', 'null') then
    perform dek.err('invalid_input', format('%s must be text.', p_key));
  end if;
  return dek.org_clean_text(p_patch ->> p_key, p_key, p_max, p_required, p_single_line);
end $$;

create or replace function dek.org_patch_bool(p_patch jsonb, p_key text)
returns boolean language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(p_patch -> p_key) is distinct from 'boolean' then
    perform dek.err('invalid_input', format('%s must be true or false.', p_key));
  end if;
  return (p_patch ->> p_key)::boolean;
end $$;

create or replace function dek.org_patch_int(p_patch jsonb, p_key text, p_min int, p_max int)
returns int language plpgsql set search_path = '' as $$
declare
  v_text text := p_patch ->> p_key;
  v_ok   boolean := false;
begin
  if jsonb_typeof(p_patch -> p_key) = 'number' and v_text ~ '^-?[0-9]{1,9}$' then
    v_ok := v_text::int between p_min and p_max;
  end if;
  if not v_ok then
    perform dek.err('invalid_input', format('%s must be a whole number from %s to %s.', p_key, p_min, p_max));
  end if;
  return v_text::int;
end $$;

create or replace function dek.org_patch_enum(p_patch jsonb, p_key text, p_allowed text[])
returns text language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(p_patch -> p_key) is distinct from 'string'
     or not coalesce((p_patch ->> p_key) = any (p_allowed), false) then
    perform dek.err('invalid_input', format('%s must be one of: %s.', p_key, array_to_string(p_allowed, ', ')));
  end if;
  return p_patch ->> p_key;
end $$;

-- A search box value as an ILIKE pattern with its wildcards escaped (null when blank).
create or replace function dek.org_like_pattern(p_query text)
returns text language sql immutable set search_path = '' as $$
  select case when nullif(btrim(p_query), '') is null then null
              else '%' || replace(replace(replace(left(btrim(p_query), 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'
         end
$$;

-- OrgSettings patch: known keys only, typed, normalised. Returns the keys to merge.
create or replace function dek.org_validate_settings(p_settings jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb := '{}'::jsonb;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    perform dek.err('invalid_input', 'settings must be an object.');
  end if;
  for v_key, v_val in select e.key, e.value from jsonb_each(p_settings) e loop
    if v_key in ('allow_guests', 'member_can_create_channels', 'member_can_invite') then
      v_out := v_out || jsonb_build_object(v_key, dek.org_patch_bool(p_settings, v_key));
    elsif v_key = 'edit_window_minutes' then
      v_out := v_out || jsonb_build_object(v_key, case when jsonb_typeof(v_val) = 'null' then null
                                                       else dek.org_patch_int(p_settings, v_key, 0, 43200) end);
    elsif v_key = 'default_invite_hours' then
      v_out := v_out || jsonb_build_object(v_key, dek.org_patch_int(p_settings, v_key, 1, 720));
    else
      perform dek.err('invalid_input', format('settings.%s is not a setting.', v_key));
    end if;
  end loop;
  return v_out;
end $$;

-- One boolean org setting with the foundation defaults applied.
create or replace function dek.org_setting_on(p_org uuid, p_key text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((dek.org_settings(o) ->> p_key)::boolean, false) from dek.orgs o where o.id = p_org
$$;

-- =====================================================================
-- 2. Membership helpers
-- =====================================================================

-- dek.require_org for something found by id. A caller outside the thing's org gets
-- exactly the not_found (code AND hint) of an id that does not exist, so another
-- tenant cannot tell a real id from a guessed one (DEKA05). Members of the org get
-- the usual answers (suspended, or their role).
create or replace function dek.org_require_member(p_uid uuid, p_org uuid, p_hint text)
returns text language plpgsql stable set search_path = '' as $$
begin
  if p_org is null or not exists (select 1 from dek.org_members m where m.org_id = p_org and m.user_id = p_uid) then
    perform dek.err('not_found', p_hint);
  end if;
  return dek.require_org(p_uid, p_org);
end $$;

create or replace function dek.org_find_server(p_uid uuid, p_server uuid)
returns dek.servers language plpgsql stable set search_path = '' as $$
declare s dek.servers;
begin
  select * into s from dek.servers x where x.id = p_server;
  perform dek.org_require_member(p_uid, s.org_id, 'That team server does not exist or you do not have access to it.');
  return s;
end $$;

create or replace function dek.org_find_channel(p_uid uuid, p_channel uuid)
returns dek.channels language plpgsql stable set search_path = '' as $$
declare c dek.channels;
begin
  select * into c from dek.channels x where x.id = p_channel;
  perform dek.org_require_member(p_uid, c.org_id, 'That channel does not exist or you do not have access to it.');
  return c;
end $$;

-- list_org_members item: { profile, role, status, joined_at }.
create or replace function dek.org_member_item(p_org uuid, p_user uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('profile', dek.profile_json(p), 'role', m.role, 'status', m.status,
                            'joined_at', m.joined_at)
    from dek.org_members m
    join dek.profiles p on p.id = m.user_id
   where m.org_id = p_org and m.user_id = p_user
$$;

-- Every function that can change who owns an org locks the owner rows first, in one
-- fixed order: two owners demoting or removing each other at the same moment queue
-- instead of both passing the last-owner check (or deadlocking).
create or replace function dek.org_lock_owners(p_org uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform 1 from dek.org_members m where m.org_id = p_org and m.role = 'owner' order by m.user_id for update;
end $$;

-- The target's membership row (any status), locked. not_found when absent.
create or replace function dek.org_target(p_org uuid, p_user uuid)
returns dek.org_members language plpgsql set search_path = '' as $$
declare m dek.org_members;
begin
  select * into m from dek.org_members x where x.org_id = p_org and x.user_id = p_user for update;
  if not found then
    perform dek.err('not_found', 'That person is not a member of this organization.');
  end if;
  return m;
end $$;

-- Call after dek.org_lock_owners. An org always keeps one active owner.
create or replace function dek.org_assert_not_last_owner(p_org uuid, p_user uuid, p_hint text default null)
returns void language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from dek.org_members m
                  where m.org_id = p_org and m.role = 'owner' and m.status = 'active' and m.user_id <> p_user) then
    perform dek.err('conflict', coalesce(p_hint,
      'An organization needs at least one active owner. Make someone else an owner first.'));
  end if;
end $$;

-- Owners act on anyone, admins only on members and guests, nobody on themselves.
create or replace function dek.org_assert_can_manage(p_actor uuid, p_actor_role text, p_target dek.org_members)
returns void language plpgsql set search_path = '' as $$
begin
  if p_target.user_id = p_actor then
    perform dek.err('forbidden', 'You cannot do that to your own membership.');
  end if;
  if p_actor_role = 'owner' or (p_actor_role = 'admin' and p_target.role in ('member', 'guest')) then
    return;
  end if;
  perform dek.err('forbidden', 'Only an owner can do that to an admin or another owner.');
end $$;

-- Pending join requests of someone who left or was removed must not let them back in.
create or replace function dek.org_withdraw_requests(p_org uuid, p_user uuid, p_server uuid default null)
returns void language sql set search_path = '' as $$
  update dek.join_requests r
     set status = 'withdrawn', decided_by = auth.uid(), decided_at = now()
   where r.org_id = p_org and r.user_id = p_user and r.status = 'pending'
     and (p_server is null or r.server_id = p_server)
$$;

-- Suspend or restore one member (api.suspend_org_member and api.resolve_report).
create or replace function dek.org_set_suspended(p_org uuid, p_user uuid, p_actor uuid, p_actor_role text,
                                                 p_suspended boolean, p_reason text)
returns void language plpgsql set search_path = '' as $$
declare
  t        dek.org_members;
  v_reason text := dek.org_clean_text(p_reason, 'reason', 500, false, false);
begin
  if p_suspended is null then
    perform dek.err('invalid_input', 'suspended must be true or false.');
  end if;
  perform dek.org_lock_owners(p_org);
  t := dek.org_target(p_org, p_user);
  perform dek.org_assert_can_manage(p_actor, p_actor_role, t);
  if p_suspended then
    if t.status = 'suspended' and t.suspended_reason is not distinct from v_reason then
      return;
    end if;
    if t.role = 'owner' then
      perform dek.org_assert_not_last_owner(p_org, p_user);
    end if;
    update dek.org_members
       set status = 'suspended', suspended_at = coalesce(suspended_at, now()), suspended_reason = v_reason
     where org_id = p_org and user_id = p_user;
    if t.status <> 'suspended' then
      perform dek.emit_user(p_user, 'access.revoked', jsonb_build_object('scope', 'org', 'id', p_org));
    end if;
    perform dek.audit(p_org, 'org.member_suspended', 'user', p_user, jsonb_build_object('reason', v_reason));
  else
    if t.status = 'active' then
      return;
    end if;
    update dek.org_members set status = 'active', suspended_at = null, suspended_reason = null
     where org_id = p_org and user_id = p_user;
    perform dek.emit_user(p_user, 'member.upd',
      jsonb_build_object('scope', 'org', 'id', p_org, 'user_id', p_user, 'change', 'added'));
    perform dek.audit(p_org, 'org.member_unsuspended', 'user', p_user, '{}'::jsonb);
  end if;
end $$;

-- Remove (and optionally ban) one member (api.remove_org_member and api.resolve_report).
-- The cleanup itself is dek.revoke_org_membership, never re-implemented here.
create or replace function dek.org_remove_member(p_org uuid, p_user uuid, p_actor uuid, p_actor_role text,
                                                 p_ban boolean, p_reason text)
returns void language plpgsql set search_path = '' as $$
declare
  t        dek.org_members;
  v_reason text := dek.org_clean_text(p_reason, 'reason', 500, false, false);
begin
  perform dek.org_lock_owners(p_org);
  t := dek.org_target(p_org, p_user);
  perform dek.org_assert_can_manage(p_actor, p_actor_role, t);
  if t.role = 'owner' then
    perform dek.org_assert_not_last_owner(p_org, p_user);
  end if;
  perform dek.revoke_org_membership(p_org, p_user, coalesce(p_ban, false), v_reason);
  perform dek.org_withdraw_requests(p_org, p_user);
  perform dek.audit(p_org, case when p_ban then 'org.member_banned' else 'org.member_removed' end, 'user', p_user,
                    jsonb_build_object('role', t.role, 'reason', v_reason));
end $$;

-- How the caller sees a team server: 'member' (server member), 'partial' (only through
-- channel memberships: the cross-team case, DEK02), 'browse' (may look at it in order
-- to join: open and approval servers for members, every server for org admins), or
-- null (invisible: other tenants, strangers, suspended members, invite-only servers).
create or replace function dek.org_server_access(p_uid uuid, p_server uuid)
returns text language sql stable set search_path = '' as $$
  select case
           when sm.user_id is not null and om.role <> 'guest' then 'member'
           when exists (select 1 from dek.channel_members cm
                          join dek.channels c on c.id = cm.channel_id
                         where cm.user_id = p_uid and cm.org_id = s.org_id and c.server_id = s.id) then 'partial'
           when om.role in ('owner', 'admin') then 'browse'
           when om.role = 'member' and s.join_policy in ('open', 'approval') and s.archived_at is null then 'browse'
         end
    from dek.servers s
    join dek.org_members om on om.org_id = s.org_id and om.user_id = p_uid and om.status = 'active'
    left join dek.server_members sm on sm.server_id = s.id and sm.user_id = p_uid
   where s.id = p_server
$$;

-- A server the caller administers (server admin or org admin). People who cannot see
-- it get not_found; people who can see it but are not admins get forbidden.
create or replace function dek.org_server_for_admin(p_uid uuid, p_server uuid)
returns dek.servers language plpgsql set search_path = '' as $$
declare s dek.servers;
begin
  s := dek.org_find_server(p_uid, p_server);
  if not dek.is_server_admin(p_uid, s.id) then
    if dek.org_server_access(p_uid, s.id) is null then
      perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
    end if;
    perform dek.err('forbidden', 'Only admins of this team server can do that.');
  end if;
  return s;
end $$;

-- De-duplicated ids; every one an active member of the org (guests only when allowed).
create or replace function dek.org_require_members(p_org uuid, p_ids uuid[], p_allow_guests boolean, p_max int)
returns uuid[] language plpgsql stable set search_path = '' as $$
declare
  v_ids uuid[];
  v_ok  int;
begin
  select coalesce(array_agg(distinct u), '{}'::uuid[]) into v_ids
    from unnest(coalesce(p_ids, '{}'::uuid[])) u where u is not null;
  if cardinality(v_ids) > p_max then
    perform dek.err('invalid_input', format('Choose at most %s people at a time.', p_max));
  end if;
  select count(*) into v_ok from dek.org_members m
   where m.org_id = p_org and m.user_id = any (v_ids) and m.status = 'active'
     and (p_allow_guests or m.role <> 'guest');
  if v_ok <> cardinality(v_ids) then
    perform dek.err('invalid_input', case when p_allow_guests
      then 'Everyone you add must be an active member of this organization.'
      else 'Everyone you add must be an active member of this organization, and guests cannot join team servers.' end);
  end if;
  return v_ids;
end $$;

-- Add one person to a channel (false when already in). New members start read up to
-- now, so joining a channel with a long history does not make all of it unread.
create or replace function dek.org_grant_channel_membership(p_channel uuid, p_user uuid, p_role text, p_actor uuid)
returns boolean language plpgsql set search_path = '' as $$
begin
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

-- Add one person to a team server (false when already in), whatever the path: open
-- join, admin add, invite, approved request. Guests and non-members never become
-- server members. Every public auto_join channel of the server is joined as well.
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

-- =====================================================================
-- 3. Organizations (CONTRACT 2.3)
-- =====================================================================

create or replace function api.create_org(p_name text, p_slug text, p_short_name text default null,
                                          p_brand_color text default '#4F46E5')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_name  text;
  v_slug  text;
  v_short text;
  v_color text;
  o       dek.orgs;
begin
  v_uid := dek.require_uid();
  if not dek.is_platform_admin(v_uid) then
    perform dek.err('forbidden', 'Only platform admins can create organizations.');
  end if;
  v_name := dek.org_clean_text(p_name, 'name', 80, true);
  v_short := dek.org_clean_text(p_short_name, 'short_name', 24);
  v_slug := lower(btrim(coalesce(p_slug, '')));
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,40}$' then
    perform dek.err('invalid_input',
      'slug must be 2 to 41 lowercase letters, digits or hyphens, starting with a letter or digit.');
  end if;
  v_color := coalesce(nullif(btrim(p_brand_color), ''), '#4F46E5');
  if v_color !~ '^#[0-9A-Fa-f]{6}$' then
    perform dek.err('invalid_input', 'brand_color must be a hex color such as #4F46E5.');
  end if;
  if exists (select 1 from dek.orgs x where lower(x.slug) = v_slug) then
    perform dek.err('conflict', 'That slug is already taken.');
  end if;
  begin
    insert into dek.orgs (slug, name, short_name, brand_color, created_by)
    values (v_slug, v_name, v_short, v_color, v_uid)
    returning * into o;
  exception when unique_violation then
    perform dek.err('conflict', 'That slug is already taken.');
  end;
  insert into dek.org_members (org_id, user_id, role, status) values (o.id, v_uid, 'owner', 'active');
  perform dek.audit(o.id, 'org.created', 'org', o.id, jsonb_build_object('name', o.name, 'slug', o.slug));
  perform dek.emit_user(v_uid, 'member.upd',
    jsonb_build_object('scope', 'org', 'id', o.id, 'user_id', v_uid, 'change', 'added'));
  return dek.org_summary_json(o, v_uid);
end $$;

create or replace function api.update_org(p_org uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_key text;
  o     dek.orgs;
begin
  v_uid := dek.require_uid();
  perform dek.require_org_admin(v_uid, p_org);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform dek.err('invalid_input', 'patch must be an object.');
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('name', 'short_name', 'brand_color', 'logo_path', 'settings') then
      perform dek.err('invalid_input', format('%s cannot be changed here.', v_key));
    end if;
  end loop;
  -- NO KEY UPDATE: does not block the foreign key checks of concurrent sends in this org
  select * into o from dek.orgs x where x.id = p_org for no key update;
  if p_patch ? 'name' then
    o.name := dek.org_patch_text(p_patch, 'name', 80, true);
  end if;
  if p_patch ? 'short_name' then
    o.short_name := dek.org_patch_text(p_patch, 'short_name', 24);
  end if;
  if p_patch ? 'brand_color' then
    o.brand_color := dek.org_patch_text(p_patch, 'brand_color', 7, true);
    if o.brand_color !~ '^#[0-9A-Fa-f]{6}$' then
      perform dek.err('invalid_input', 'brand_color must be a hex color such as #4F46E5.');
    end if;
  end if;
  if p_patch ? 'logo_path' then
    o.logo_path := dek.org_patch_text(p_patch, 'logo_path', 300);
    if o.logo_path is not null
       and (o.logo_path !~ '^[A-Za-z0-9_-][A-Za-z0-9/_.-]*$' or strpos(o.logo_path, '..') > 0) then
      perform dek.err('invalid_input', 'logo_path must be a storage path such as <user>/<file>.webp.');
    end if;
  end if;
  if p_patch ? 'settings' then
    o.settings := coalesce(o.settings, '{}'::jsonb) || dek.org_validate_settings(p_patch -> 'settings');
  end if;
  update dek.orgs x
     set name = o.name, short_name = o.short_name, brand_color = o.brand_color,
         logo_path = o.logo_path, settings = o.settings
   where x.id = o.id
  returning * into o;
  perform dek.audit(o.id, 'org.updated', 'org', o.id, jsonb_build_object('patch', p_patch));
  return dek.org_summary_json(o, v_uid) || jsonb_build_object('settings', dek.org_settings(o));
end $$;

-- Members see active members; admins also see suspended ones (to restore them).
create or replace function api.list_org_members(p_org uuid, p_query text default null, p_role text default null,
                                                p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_like  text := dek.org_like_pattern(p_query);
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_off   int := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_total int;
  v_items jsonb;
begin
  v_uid := dek.require_uid();
  v_admin := dek.require_org(v_uid, p_org) in ('owner', 'admin');
  if p_role is not null and p_role not in ('owner', 'admin', 'member', 'guest') then
    perform dek.err('invalid_input', 'role must be owner, admin, member or guest.');
  end if;
  -- one pass over the org's members; items are built from the joined rows (no per-row lookups)
  with matched as (
    select m.user_id, m.role, m.status, m.joined_at, p as prof, lower(p.display_name) as sort_name
      from dek.org_members m
      join dek.profiles p on p.id = m.user_id
     where m.org_id = p_org
       and (v_admin or m.status = 'active')
       and (p_role is null or m.role = p_role)
       and (v_like is null or p.display_name ilike v_like or p.handle ilike v_like)
  )
  select (select count(*) from (select 1 from matched limit 10000) x),
         (select coalesce(jsonb_agg(jsonb_build_object('profile', dek.profile_json(pg.prof), 'role', pg.role,
                                                       'status', pg.status, 'joined_at', pg.joined_at)
                                    order by pg.sort_name, pg.user_id), '[]'::jsonb)
            from (select * from matched order by sort_name, user_id limit v_limit offset v_off) pg)
    into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- Owners set any role (their own too, while another active owner remains); admins only
-- move people between member and guest. Becoming a guest drops every server
-- membership (and the channel memberships inside those servers): guests only ever
-- hold the channel memberships an admin gives them afterwards.
create or replace function api.set_org_role(p_org uuid, p_user uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_me  text;
  t     dek.org_members;
  r     record;
begin
  v_uid := dek.require_uid();
  v_me := dek.require_org_admin(v_uid, p_org);
  if p_role is null or p_role not in ('owner', 'admin', 'member', 'guest') then
    perform dek.err('invalid_input', 'role must be owner, admin, member or guest.');
  end if;
  perform dek.org_lock_owners(p_org);
  t := dek.org_target(p_org, p_user);
  if v_me <> 'owner' and (t.role not in ('member', 'guest') or p_role not in ('member', 'guest')) then
    perform dek.err('forbidden', 'Admins can only move people between member and guest. Ask an owner.');
  end if;
  if t.role = p_role then
    return dek.org_member_item(p_org, p_user);
  end if;
  if t.role = 'owner' then
    perform dek.org_assert_not_last_owner(p_org, p_user);
  end if;
  if p_role = 'guest' and not dek.org_setting_on(p_org, 'allow_guests') then
    perform dek.err('forbidden', 'Guests are turned off for this organization.');
  end if;
  update dek.org_members set role = p_role where org_id = p_org and user_id = p_user;
  if p_role = 'guest' then
    for r in select sm.server_id from dek.server_members sm where sm.user_id = p_user and sm.org_id = p_org loop
      perform dek.revoke_server_membership(r.server_id, p_user);
    end loop;
  end if;
  perform dek.emit_user(p_user, 'member.upd',
    jsonb_build_object('scope', 'org', 'id', p_org, 'user_id', p_user, 'change', 'role'));
  perform dek.audit(p_org, 'org.role_changed', 'user', p_user, jsonb_build_object('from', t.role, 'to', p_role));
  return dek.org_member_item(p_org, p_user);
end $$;

create or replace function api.suspend_org_member(p_org uuid, p_user uuid, p_suspended boolean,
                                                  p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_me  text;
begin
  v_uid := dek.require_uid();
  v_me := dek.require_org_admin(v_uid, p_org);
  perform dek.org_set_suspended(p_org, p_user, v_uid, v_me, p_suspended, p_reason);
  return dek.org_member_item(p_org, p_user);
end $$;

create or replace function api.remove_org_member(p_org uuid, p_user uuid, p_ban boolean default false,
                                                 p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_me  text;
begin
  v_uid := dek.require_uid();
  v_me := dek.require_org_admin(v_uid, p_org);
  perform dek.org_remove_member(p_org, p_user, v_uid, v_me, coalesce(p_ban, false), p_reason);
  return jsonb_build_object('org_id', p_org, 'user_id', p_user, 'removed', true, 'banned', coalesce(p_ban, false));
end $$;

-- A suspended member cannot leave: leaving and accepting a fresh invite would lift
-- the suspension.
create or replace function api.leave_org(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_role text;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  perform dek.org_lock_owners(p_org);
  select m.role into v_role from dek.org_members m where m.org_id = p_org and m.user_id = v_uid for update;
  if v_role = 'owner' then
    perform dek.org_assert_not_last_owner(p_org, v_uid,
      'You are the last owner. Make someone else an owner before you leave.');
  end if;
  perform dek.revoke_org_membership(p_org, v_uid, false, null);
  perform dek.org_withdraw_requests(p_org, v_uid);
  perform dek.audit(p_org, 'org.member_left', 'user', v_uid, jsonb_build_object('role', v_role));
  return jsonb_build_object('org_id', p_org, 'left', true);
end $$;
