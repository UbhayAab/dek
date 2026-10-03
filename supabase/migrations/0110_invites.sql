-- 0110: invites and join requests (CONTRACT 2.4). Owner: [org].
-- Helpers (dek.org_*) live in 0100 and 0102. Same rules and re-run pattern as 0100.
--
-- Invite codes: 22 base62 characters (about 131 bits) from gen_random_bytes. The
-- table keeps sha256(code) and every lookup is by that hash, so migrated legacy
-- invites (hash only) keep working with their old links.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api' and p.proname = any (array[
              'create_invite', 'preview_invite', 'accept_invite', 'list_invites', 'revoke_invite',
              'list_join_requests', 'decide_join_request']))
        or (n.nspname = 'dek' and p.proname = any (array[
              'org_new_invite_code', 'org_invite_problem', 'org_invite_json', 'org_apply_grant',
              'org_invite_creator_ok', 'org_invite_channels']))
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

-- list_join_requests reads one org's requests newest first.
create index if not exists org_join_requests_org_idx on dek.join_requests (org_id, status, created_at desc);

-- =====================================================================
-- Helpers
-- =====================================================================

-- 22 characters of base62. Bytes of 248 and above are skipped so every character is
-- equally likely (248 = 4 * 62).
create or replace function dek.org_new_invite_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_bytes bytea;
  v_byte  int;
  v_code  text := '';
  i       int;
begin
  while char_length(v_code) < 22 loop
    v_bytes := extensions.gen_random_bytes(32);
    for i in 0 .. 31 loop
      v_byte := get_byte(v_bytes, i);
      if v_byte < 248 then
        v_code := v_code || substr(v_alphabet, (v_byte % 62) + 1, 1);
        exit when char_length(v_code) = 22;
      end if;
    end loop;
  end loop;
  return v_code;
end $$;

-- An invite carries its creator's authority, checked when it is used, not only when
-- it was made: a creator who was removed, banned, suspended or demoted, or who left
-- the invite's server, or whose right came from member_can_invite after that was
-- turned off, can no longer bring anyone in. Migrated legacy invites keep working
-- while their creator is an active member (their old links must keep working);
-- creatorless migrated invites keep working.
create or replace function dek.org_invite_creator_ok(i dek.invites)
returns boolean language sql stable set search_path = '' as $$
  select i.created_by is null
      or exists (
           select 1 from dek.org_members m
            where m.org_id = i.org_id and m.user_id = i.created_by and m.status = 'active'
              and (m.role in ('owner', 'admin')
                   or (m.role = 'member' and i.legacy_id is not null)
                   or (i.server_id is not null and coalesce(dek.server_role(i.created_by, i.server_id) = 'admin', false))
                   or (m.role = 'member' and dek.org_setting_on(i.org_id, 'member_can_invite')
                       and (i.server_id is null or dek.server_role(i.created_by, i.server_id) is not null))))
$$;

-- Why an invite cannot be used right now (null when it can). An archived target
-- server, a guest invite while the org has guests turned off, or a creator who has
-- lost the right to invite all count as revoked.
create or replace function dek.org_invite_problem(i dek.invites)
returns text language sql stable set search_path = '' as $$
  select case
    when i.revoked_at is not null then 'revoked'
    when i.expires_at <= now() then 'expired'
    when i.max_uses is not null and i.use_count >= i.max_uses then 'used_up'
    when i.server_id is not null and exists (select 1 from dek.servers s
                                              where s.id = i.server_id and s.archived_at is not null) then 'revoked'
    when i.role = 'guest' and not dek.org_setting_on(i.org_id, 'allow_guests') then 'revoked'
    when not dek.org_invite_creator_ok(i) then 'revoked'
  end
$$;

-- The invite's channels its creator could still add the person to right now (the
-- same rule as api.add_channel_members): an invite never grants more than its creator
-- could grant today.
create or replace function dek.org_invite_channels(i dek.invites)
returns uuid[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(x.id order by x.position, x.id), '{}'::uuid[])
    from (select c.id, c.position, c.server_id, dek.org_channel_add_right(i.created_by, c) as add_right
            from dek.channels c
           where c.id = any (i.channel_ids) and c.org_id = i.org_id and c.kind in ('text', 'audio')
             and c.archived_at is null and i.created_by is not null) x
   where x.add_right = 'manage'
      or (x.add_right = 'public' and i.role = 'member' and i.server_id = x.server_id)
$$;

-- list_invites item.
create or replace function dek.org_invite_json(i dek.invites)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'code', i.code, 'server_id', i.server_id, 'role', i.role, 'email', i.email,
    'created_by', i.created_by, 'created_at', i.created_at, 'expires_at', i.expires_at,
    'max_uses', i.max_uses, 'use_count', i.use_count, 'revoked_at', i.revoked_at,
    'requires_approval', i.requires_approval)
$$;

-- Grant what an invite (or an approved request) targets: org membership (existing
-- members keep their role), the server (never for guests), and the channels that
-- belong to the same org. Returns true when anything changed.
create or replace function dek.org_apply_grant(p_org uuid, p_server uuid, p_channel_ids uuid[], p_role text,
                                               p_user uuid, p_actor uuid)
returns boolean language plpgsql set search_path = '' as $$
declare
  v_changed boolean := false;
  v_role    text;
  r         record;
begin
  insert into dek.org_members (org_id, user_id, role, status, invited_by)
  values (p_org, p_user, coalesce(p_role, 'member'), 'active', p_actor)
  on conflict (org_id, user_id) do nothing;
  if found then
    v_changed := true;
    perform dek.emit_user(p_user, 'member.upd',
      jsonb_build_object('scope', 'org', 'id', p_org, 'user_id', p_user, 'change', 'added'));
  end if;
  v_role := dek.org_role(p_user, p_org);
  if v_role is null then
    perform dek.err('suspended', 'That membership is suspended.');
  end if;
  if p_server is not null and v_role <> 'guest'
     and exists (select 1 from dek.servers s where s.id = p_server and s.org_id = p_org and s.archived_at is null) then
    if dek.org_grant_server_membership(p_server, p_user, 'member', p_actor) then
      v_changed := true;
    end if;
  end if;
  for r in
    select c.id from dek.channels c
     where c.id = any (coalesce(p_channel_ids, '{}'::uuid[])) and c.org_id = p_org
       and c.kind in ('text', 'audio') and c.archived_at is null
     order by c.position, c.id
     limit 20
  loop
    if dek.org_grant_channel_membership(r.id, p_user, 'member', p_actor) then
      v_changed := true;
    end if;
  end loop;
  return v_changed;
end $$;

-- =====================================================================
-- Invites
-- =====================================================================

-- Org admins; server admins for their server; members when member_can_invite (for
-- the org, or a server they are in). Channels must be ones the inviter could add the
-- person to directly. Guest invites need allow_guests and never name a server.
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
  if v_my_role not in ('owner', 'admin') and not (s.id is not null and dek.is_server_admin(v_uid, s.id)) then
    if not coalesce((v_settings ->> 'member_can_invite')::boolean, false) then
      perform dek.err('forbidden', 'Only admins can invite people to this organization.');
    end if;
    if s.id is not null and dek.server_role(v_uid, s.id) is null then
      perform dek.err('forbidden', 'You can only invite people to team servers you belong to.');
    end if;
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

-- The one function anon may call. Answers only what the invite page shows: never ids,
-- never member data, never the target email.
create or replace function api.preview_invite(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_code    text := btrim(coalesce(p_code, ''));
  v_reason  text;
  v_server  text;
  v_policy  text;
  v_inviter text;
  i         dek.invites;
  o         dek.orgs;
begin
  if char_length(v_code) between 1 and 200 then
    select * into i from dek.invites x where x.code_sha256 = sha256(convert_to(v_code, 'UTF8'));
    if i.id is not null then
      select * into o from dek.orgs x where x.id = i.org_id and x.archived_at is null;
    end if;
  end if;
  if o.id is null then
    return jsonb_build_object('valid', false, 'reason', 'not_found', 'org_name', null, 'org_brand_color', null,
                              'server_name', null, 'inviter_name', null, 'requires_approval', false);
  end if;
  v_reason := dek.org_invite_problem(i);
  select s.name, s.join_policy into v_server, v_policy from dek.servers s where s.id = i.server_id;
  select case when p.deleted_at is null then p.display_name end into v_inviter
    from dek.profiles p where p.id = i.created_by;
  return jsonb_build_object('valid', v_reason is null, 'reason', v_reason, 'org_name', o.name,
                            'org_brand_color', o.brand_color, 'server_name', v_server, 'inviter_name', v_inviter,
                            'requires_approval', i.requires_approval or coalesce(v_policy = 'approval', false));
end $$;

-- Refusals: not_found (unknown code), conflict with the hint 'expired' | 'revoked' |
-- 'used_up', suspended (a suspended member), forbidden (banned, or a targeted invite
-- for another verified email). The invite row is locked before use_count is checked
-- and incremented, so concurrent accepts can never exceed max_uses.
create or replace function api.accept_invite(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid;
  v_code      text := btrim(coalesce(p_code, ''));
  v_role      text;
  v_problem   text;
  v_email     text;
  v_confirmed timestamptz;
  v_wants     boolean;
  v_approval  boolean;
  v_channels  uuid[];
  v_request   uuid;
  i           dek.invites;
  m           dek.org_members;
  s           dek.servers;
begin
  v_uid := dek.require_uid();
  if char_length(v_code) between 1 and 200 then
    select * into i from dek.invites x where x.code_sha256 = sha256(convert_to(v_code, 'UTF8')) for update;
  end if;
  if i.id is null or not exists (select 1 from dek.orgs o where o.id = i.org_id and o.archived_at is null) then
    perform dek.err('not_found', 'This invite link is not valid.');
  end if;
  select * into m from dek.org_members x where x.org_id = i.org_id and x.user_id = v_uid;
  if m.user_id is not null and m.status <> 'active' then
    perform dek.err('suspended', 'Your membership in this organization is suspended.');
  end if;
  if i.server_id is not null then
    select * into s from dek.servers x where x.id = i.server_id;
  end if;
  v_role := coalesce(m.role, i.role);
  v_approval := i.requires_approval or coalesce(s.join_policy = 'approval', false);
  v_channels := dek.org_invite_channels(i);
  -- does the invite give the caller anything they do not already have?
  v_wants := m.user_id is null
    or (s.id is not null and v_role <> 'guest'
        and not exists (select 1 from dek.server_members sm where sm.server_id = s.id and sm.user_id = v_uid))
    or exists (select 1 from unnest(v_channels) x
                where not exists (select 1 from dek.channel_members cm where cm.channel_id = x and cm.user_id = v_uid));
  if not v_wants then
    return jsonb_build_object('status', 'already_member', 'org_id', i.org_id, 'server_id', i.server_id);
  end if;
  v_problem := dek.org_invite_problem(i);
  if v_problem is not null then
    perform dek.err('conflict', v_problem);
  end if;
  if exists (select 1 from dek.org_bans b where b.org_id = i.org_id and b.user_id = v_uid) then
    perform dek.err('forbidden', 'You cannot join this organization.');
  end if;
  if i.email is not null then
    select u.email, u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
    if v_confirmed is null or lower(coalesce(v_email, '')) <> lower(i.email) then
      perform dek.err('forbidden',
        'This invite was sent to a different email address. Sign in with that address to accept it.');
    end if;
  end if;
  if v_approval then
    -- the request first: if one is already pending for this target (from this or another
    -- invite, even one being accepted at this very moment), it stands and no use is counted
    insert into dek.join_requests (org_id, server_id, user_id, invite_id) values (i.org_id, i.server_id, v_uid, i.id)
    on conflict do nothing
    returning id into v_request;
    if v_request is null then
      return jsonb_build_object('status', 'pending', 'org_id', i.org_id, 'server_id', i.server_id);
    end if;
  end if;
  update dek.invites x set use_count = x.use_count + 1
   where x.id = i.id and (x.max_uses is null or x.use_count < x.max_uses);
  if not found then
    perform dek.err('conflict', 'used_up');
  end if;
  insert into dek.invite_uses (invite_id, user_id) values (i.id, v_uid) on conflict do nothing;
  if v_approval then
    perform dek.audit(i.org_id, 'invite.join_requested', 'invite', i.id, jsonb_build_object('user_id', v_uid));
    return jsonb_build_object('status', 'pending', 'org_id', i.org_id, 'server_id', i.server_id);
  end if;
  perform dek.org_apply_grant(i.org_id, i.server_id, v_channels, i.role, v_uid, coalesce(i.created_by, v_uid));
  perform dek.audit(i.org_id, 'invite.accepted', 'invite', i.id, jsonb_build_object('user_id', v_uid));
  return jsonb_build_object('status', 'joined', 'org_id', i.org_id, 'server_id', i.server_id);
end $$;

-- Org admins see every invite (newest 200), everyone else their own.
create or replace function api.list_invites(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_items jsonb;
begin
  v_uid := dek.require_uid();
  v_admin := dek.require_org(v_uid, p_org) in ('owner', 'admin');
  select coalesce(jsonb_agg(dek.org_invite_json(i) order by i.created_at desc, i.id), '[]'::jsonb)
    into v_items
    from (select x.id from dek.invites x
           where x.org_id = p_org and (v_admin or x.created_by = v_uid)
           order by x.created_at desc
           limit 200) ids
    join dek.invites i on i.id = ids.id;
  return jsonb_build_object('items', v_items);
end $$;

-- Org admins, the creator, or admins of the invite's server. Idempotent.
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
          or (i.server_id is not null and dek.is_server_admin(v_uid, i.server_id))) then
    perform dek.err('not_found', 'That invite does not exist.');
  end if;
  if i.revoked_at is null then
    update dek.invites x set revoked_at = now(), revoked_by = v_uid where x.id = i.id returning * into i;
    perform dek.audit(i.org_id, 'invite.revoked', 'invite', i.id, jsonb_build_object('server_id', i.server_id));
  end if;
  return dek.org_invite_json(i);
end $$;

-- =====================================================================
-- Join requests
-- =====================================================================

-- Org admins see all of the org's requests; server admins the requests for their
-- servers. The requester's email is shown to org admins only. p_status null = every
-- status. Newest 200.
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
      from dek.server_members sm where sm.user_id = v_uid and sm.org_id = p_org and sm.role = 'admin';
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

-- Approve grants what the request targeted (org, server, the invite's channels);
-- reject only records the decision. Deciding twice is a conflict.
create or replace function api.decide_join_request(p_request uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  r     dek.join_requests;
  i     dek.invites;
  m     dek.org_members;
begin
  v_uid := dek.require_uid();
  select * into r from dek.join_requests x where x.id = p_request for update;
  perform dek.org_require_member(v_uid, r.org_id, 'That join request does not exist.');
  if not (dek.is_org_admin(v_uid, r.org_id)
          or (r.server_id is not null and dek.is_server_admin(v_uid, r.server_id))) then
    perform dek.err('forbidden', 'Only admins can decide join requests.');
  end if;
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
