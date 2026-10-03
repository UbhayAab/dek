-- 0200: session, bootstrap and profiles [msg] (CONTRACT 2.1), plus the private
-- dek.msg_* helpers that 0210 (messages), 0220 (read state) and 0230 (pins, saved,
-- search) call. Owner: msg builder. Every object is create-or-replace, so the file
-- can be re-applied with `node tools/db.mjs dev`.
--
-- Rules followed throughout: security definer, search_path = '', every name
-- schema-qualified, access only through the 0001 helpers, errors only through
-- dek.err(). Read-only api functions are STABLE, so all their statements share one
-- snapshot (a page and its last_seq can never disagree).

-- =====================================================================
-- Private helpers. dek_meta.lockdown() revokes EXECUTE on these from every API
-- role, so only api functions (running as the owner) can reach them.
-- =====================================================================

-- Page size: the default when null, at least 1, at most p_max (CONTRACT section 0).
create or replace function dek.msg_limit(p_limit int, p_default int, p_max int)
returns int language sql immutable set search_path = '' as $$
  select least(greatest(coalesce(p_limit, p_default), 1), p_max)
$$;

-- Message text after trim. [[:space:]] follows the database's Unicode rules, so a
-- body of only no-break or em spaces counts as empty.
create or replace function dek.msg_trim(p_body text)
returns text language sql stable set search_path = '' as $$
  select regexp_replace(coalesce(p_body, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g')
$$;

-- <@uuid> tokens naming people who can read the channel: distinct, in order of
-- first appearance, at most 100. Readability is checked before the cap, so junk
-- tokens cannot push a real mention out; an 8000 character body holds at most
-- about 200 tokens, which bounds the checks.
create or replace function dek.msg_parse_mentions(p_body text, p_channel uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(k.id order by k.first_at), '{}'::uuid[])
    from (select t.id, t.first_at
            from (select x.id, min(x.ord) as first_at
                    from (select lower(r.m[1])::uuid as id, r.ord
                            from regexp_matches(coalesce(p_body, ''),
                                   '<@([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})>', 'g')
                                 with ordinality as r(m, ord)) x
                   group by x.id) t
           where dek.can_read_channel(t.id, p_channel)
           order by t.first_at
           limit 100) k
$$;

create or replace function dek.msg_wants_all(p_body text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_body, '') ~ '<!(channel|here)>'
$$;

-- <!channel> and <!here> count only for moderators of the channel, or anyone in a
-- channel of 50 or fewer members (CONTRACT section 0). The count stops at 51.
create or replace function dek.msg_may_mention_all(p_uid uuid, p_channel uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select dek.can_moderate_channel(p_uid, p_channel)
      or (select count(*) from (select 1 from dek.channel_members cm
                                 where cm.channel_id = p_channel limit 51) n) <= 50
$$;

-- One message by id when the caller can read its channel. Everything else is
-- not_found, including another tenant guessing ids (DEKA05).
create or replace function dek.msg_get(p_uid uuid, p_message uuid)
returns dek.messages language plpgsql stable security definer set search_path = '' as $$
declare
  v_msg dek.messages;
begin
  if p_message is not null then
    select * into v_msg from dek.messages where id = p_message;
  end if;
  if v_msg.id is null or not dek.can_read_channel(p_uid, v_msg.channel_id) then
    perform dek.err('not_found', 'That message does not exist or you do not have access to it.');
  end if;
  return v_msg;
end $$;

create or replace function dek.msg_archived(c dek.channels)
returns boolean language sql stable security definer set search_path = '' as $$
  select c.archived_at is not null
      or exists (select 1 from dek.servers s where s.id = c.server_id and s.archived_at is not null)
$$;

-- Changes that are not posts (reactions, pins): the conversation must not be
-- archived, and a 1:1 DM must still be open between the two people (dek.assert_post
-- is the block rule; a DM has no posting policy to trip over).
create or replace function dek.msg_assert_open(p_uid uuid, c dek.channels)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if c.kind = 'dm' then
    perform dek.assert_post(p_uid, c.id, false);
  elsif dek.msg_archived(c) then
    perform dek.err('archived', 'This conversation is archived and read only.');
  end if;
end $$;

-- The set form of dek.can_read_channel for one person in one organization, built
-- once per call by search, saved, mentions and threads: explicit channel
-- memberships, plus the public channels of servers the person belongs to (never for
-- guests). Empty unless the person is an active member of the organization.
create or replace function dek.msg_readable_channel_ids(p_uid uuid, p_org uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x.id), '{}'::uuid[])
    from dek.org_members om
    cross join lateral (
      select c.id
        from dek.channel_members cm
        join dek.channels c on c.id = cm.channel_id and c.org_id = om.org_id
       where cm.user_id = om.user_id and cm.org_id = om.org_id
      union all
      select c.id
        from dek.server_members sm
        join dek.channels c on c.server_id = sm.server_id and c.visibility = 'public'
                           and c.org_id = om.org_id
       where sm.user_id = om.user_id and sm.org_id = om.org_id and om.role <> 'guest'
    ) x
   where om.org_id = p_org and om.user_id = p_uid and om.status = 'active'
$$;

-- Messages as Message JSON, ascending by seq.
create or replace function dek.msg_json_list(p_rows dek.messages[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(dek.message_json(r) order by r.seq), '[]'::jsonb)
    from unnest(coalesce(p_rows, '{}'::dek.messages[])) r
$$;

-- [{ message, channel }] in the order of p_rows; each distinct channel is built once
-- (looked up by primary key: = any(array) keeps the planner off a channels scan).
create or replace function dek.msg_items_json(p_uid uuid, p_rows dek.messages[])
returns jsonb language sql stable security definer set search_path = '' as $$
  with items as (
    select i as ord, p_rows[i] as msg from generate_subscripts(p_rows, 1) i
  ), chans as (
    select c.id, dek.channel_json(c, p_uid) as j
      from dek.channels c
     where c.id = any(array(select distinct (items.msg).channel_id from items))
  )
  select coalesce(jsonb_agg(jsonb_build_object('message', dek.message_json(items.msg), 'channel', chans.j)
                            order by items.ord), '[]'::jsonb)
    from items join chans on chans.id = (items.msg).channel_id
$$;

-- NotificationPrefs (CONTRACT section 1). Defaults stand in for a missing row.
create or replace function dek.msg_prefs_json(n dek.notification_prefs)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'default_level', coalesce(n.default_level, 'mentions'),
    'dm_level', coalesce(n.dm_level, 'all'),
    'thread_replies', coalesce(n.thread_replies, true),
    'quiet_start', to_char(n.quiet_start, 'HH24:MI'),
    'quiet_end', to_char(n.quiet_end, 'HH24:MI'),
    'quiet_tz', coalesce(n.quiet_tz, 'Asia/Kolkata'),
    'preview', coalesce(n.preview, 'full'))
$$;

-- =====================================================================
-- api.me
-- =====================================================================

-- Organizations listed are the active, unarchived memberships: a suspended member
-- gets `suspended` from bootstrap for an org id they remember, nothing more.
create or replace function api.me()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_prof  dek.profiles;
  v_prefs dek.notification_prefs;
  v_email text;
  v_orgs  jsonb;
begin
  v_uid := dek.require_uid();
  select * into v_prof from dek.profiles where id = v_uid;
  select u.email into v_email from auth.users u where u.id = v_uid;
  select * into v_prefs from dek.notification_prefs where user_id = v_uid;
  if v_prefs.user_id is null and v_prof.id is not null then
    insert into dek.notification_prefs (user_id) values (v_uid)
    on conflict (user_id) do nothing;
    select * into v_prefs from dek.notification_prefs where user_id = v_uid;
  end if;
  select coalesce(jsonb_agg(dek.org_summary_json(o, v_uid) order by om.joined_at, o.id), '[]'::jsonb)
    into v_orgs
    from dek.org_members om
    join dek.orgs o on o.id = om.org_id
   where om.user_id = v_uid and om.status = 'active' and o.archived_at is null;
  return jsonb_build_object(
    'user_id', v_uid,
    'email', v_email,
    'profile', dek.profile_json(v_prof),
    'orgs', v_orgs,
    'prefs', dek.msg_prefs_json(v_prefs),
    'is_platform_admin', dek.is_platform_admin(v_uid));
end $$;

-- =====================================================================
-- api.bootstrap: everything the sidebar needs for one organization in one call.
-- Bounded: at most 300 joined channels and the 200 most recent unhidden DMs, each
-- built by dek.channel_json (whose counters stop at 100).
-- =====================================================================

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
     where cm.user_id = v_uid and cm.org_id = p_org and c.kind in ('text', 'audio')
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
    v_topics := v_topics || array(select 's:' || x::text from unnest(v_mine) x order by x);
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

-- =====================================================================
-- api.get_profiles: only people who share an organization with the caller.
-- =====================================================================

create or replace function api.get_profiles(p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_out jsonb;
begin
  v_uid := dek.require_uid();
  if coalesce(cardinality(p_ids), 0) = 0 then
    return '[]'::jsonb;
  end if;
  if cardinality(p_ids) > 200 then
    perform dek.err('invalid_input', 'Ask for at most 200 profiles at a time.');
  end if;
  select coalesce(jsonb_agg(dek.profile_json(p) order by x.ord), '[]'::jsonb)
    into v_out
    from (select u.id, min(u.ord) as ord
            from unnest(p_ids) with ordinality as u(id, ord)
           where u.id is not null
           group by u.id) x
    join dek.profiles p on p.id = x.id
   where dek.shares_org(v_uid, p.id);
  return v_out;
end $$;
