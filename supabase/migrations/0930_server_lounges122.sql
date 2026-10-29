-- Each active server starts with an available voice lounge. Membership does
-- not join a call or activate a microphone. Applied predecessors stay immutable.
-- Internal invoker helper: only the owning server API or migration can write.
create function dek.ensure_server_lounge122(p_server uuid, p_actor uuid default null)
returns uuid language plpgsql set search_path = '' as $$
declare
  s dek.servers;
  c dek.channels;
  person record;
  room_name text := 'lounge';
  suffix integer := 1;
  created boolean := false;
  added integer := 0;
begin
  select * into s from dek.servers where id=p_server for no key update;
  if not found or s.archived_at is not null then return null; end if;
  select * into c from dek.channels
   where server_id=s.id and kind='audio' and visibility='public'
     and auto_join and archived_at is null
   order by (lower(name)='lounge') desc, position, id limit 1;
  if not found then
    while exists(select 1 from dek.channels where server_id=s.id and lower(name)=room_name and archived_at is null) loop
      suffix:=suffix+1;
      if suffix>10000 then raise exception 'No available default lounge name'; end if;
      room_name:='lounge-'||suffix::text;
    end loop;
    insert into dek.channels(org_id,server_id,kind,name,topic,description,visibility,auto_join,position,created_by)
    values(s.org_id,s.id,'audio',room_name,'Drop in when you are ready to talk.',
      'Your team voice lounge. Open the room, then choose Join room to connect.','public',true,
      coalesce((select max(position)+1 from dek.channels where server_id=s.id),0),p_actor)
    returning * into c;
    created:=true;
  end if;
  for person in
    select sm.user_id from dek.server_members sm
     where sm.server_id=s.id and dek.org_role(sm.user_id,s.org_id) in('owner','admin','member')
       and dek.server_content_allowed105(sm.user_id,s.id)
     order by sm.user_id
  loop
    if dek.org_grant_channel_membership(c.id,person.user_id,
        case when person.user_id=p_actor then 'owner' else 'member' end,p_actor) then added:=added+1; end if;
  end loop;
  if created or added>0 then
    perform dek.emit_channel(c.id,'chan.upd',jsonb_build_object('channel',dek.channel_public_json(c)));
    perform dek.audit(s.org_id,'server.lounge_ready','channel',c.id,
      jsonb_build_object('server_id',s.id,'created',created,'members_added',added,'source','default_lounge122'));
  end if;
  return c.id;
end $$;

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
  perform dek.ensure_server_lounge122(s.id, v_uid);
  perform dek.audit(p_org, 'server.created', 'server', s.id,
    jsonb_build_object('name', s.name, 'join_policy', s.join_policy));
  return dek.server_json(s, v_uid);
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
  -- The ordinary50-channel bound must not hide the default voice room.
  select c.id into r from dek.channels c where c.server_id=s.id and c.kind='audio' and c.visibility='public' and c.auto_join and c.archived_at is null order by c.position,c.id limit 1;
  if found then perform dek.org_grant_channel_membership(r.id,p_user,'member',p_actor); end if;
  return true;
end $$;

-- One-time backfill. No private channel or existing membership preference is rewritten.
do $$
declare server_id uuid;
begin
  for server_id in select id from dek.servers where archived_at is null order by org_id,id loop
    perform dek.ensure_server_lounge122(server_id,null);
  end loop;
end $$;
