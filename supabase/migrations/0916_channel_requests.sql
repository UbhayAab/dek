-- 0916: every channel in Browse, locked ones too, and asking to join a locked one
-- (Fixboard #19). Owner: lead. docs/CONTRACT.md sections 2.10 and 3.
--
-- Ubhay: everyone should see every channel of their team servers, even locked ones.
-- Locked (private) stays invite only: a tap on Ask to join files a request, and the
-- people who may let someone in are told at once, like a WhatsApp group.
--
--   1. dek.channel_join_requests: one pending request per person and channel.
--   2. api.browse_channels(p_org): one call for the whole Browse screen. For servers the
--      caller is a member of (not as a guest): every live text and audio channel, public
--      and private. A private channel the caller is not in comes back locked: name, kind,
--      member count, whether the caller already asked; never its topic or description.
--      Channels the caller was added to in other servers (cross-team) are listed too.
--   3. api.request_channel_join / api.withdraw_channel_request: ask, or take it back. A
--      public channel simply joins.
--   4. dek.channel_approvers(channel): who may decide. The channel's owners and the
--      server's admins; when there are none, the organization's owners and admins.
--      Each gets join.req on u:<user> and a push (notification_intents kind 'request').
--   5. api.list_channel_requests(p_org) and api.decide_channel_request: the approver's
--      side (Activity, Requests). Approving adds the person and pushes them the news.

create table if not exists dek.channel_join_requests (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references dek.orgs(id) on delete cascade,
  channel_id uuid not null references dek.channels(id) on delete cascade,
  user_id    uuid not null references dek.profiles(id) on delete cascade,
  note       text check (char_length(note) <= 300),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by uuid references dek.profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists channel_join_requests_pending_uidx
  on dek.channel_join_requests (channel_id, user_id) where status = 'pending';
create index if not exists channel_join_requests_org_idx
  on dek.channel_join_requests (org_id, created_at desc) where status = 'pending';
create index if not exists channel_join_requests_user_idx
  on dek.channel_join_requests (user_id) where status = 'pending';
alter table dek.channel_join_requests enable row level security;

alter table dek.notification_intents drop constraint if exists notification_intents_kind_check;
alter table dek.notification_intents add constraint notification_intents_kind_check
  check (kind in ('message', 'call', 'test', 'request'));
alter table dek.notification_intents
  add column if not exists channel_request_id uuid references dek.channel_join_requests(id) on delete cascade;

-- ------------------------------------------------------------------ who decides

create or replace function dek.channel_approvers(p_channel uuid)
returns uuid[] language plpgsql stable security definer set search_path = '' as $$
declare
  c     dek.channels;
  v_ids uuid[];
begin
  select * into c from dek.channels x where x.id = p_channel;
  if c.id is null then
    return '{}';
  end if;
  select coalesce(array_agg(distinct d.user_id), '{}') into v_ids
    from (select cm.user_id from dek.channel_members cm where cm.channel_id = c.id and cm.role = 'owner'
          union
          select sm.user_id from dek.server_members sm where sm.server_id = c.server_id and sm.role = 'admin'
          limit 50) d
    join dek.org_members om on om.org_id = c.org_id and om.user_id = d.user_id and om.status = 'active';
  if cardinality(v_ids) = 0 then
    select coalesce(array_agg(om.user_id), '{}') into v_ids
      from (select x.user_id from dek.org_members x
             where x.org_id = c.org_id and x.role in ('owner', 'admin') and x.status = 'active' limit 20) om;
  end if;
  return v_ids;
end $$;

create or replace function dek.may_decide_channel_request(p_uid uuid, c dek.channels)
returns boolean language sql stable security definer set search_path = '' as $$
  select dek.is_server_admin(p_uid, c.server_id)
      or exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = p_uid and cm.role = 'owner')
      or p_uid = any (dek.channel_approvers(c.id))
$$;

-- ------------------------------------------------------------------ Browse

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
     where c.org_id = p_org and c.kind in ('text', 'audio') and c.archived_at is null
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

-- ------------------------------------------------------------------ asking

create or replace function api.request_channel_join(p_channel uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid;
  v_role text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_req  dek.channel_join_requests;
  v_to   uuid[];
  c      dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_find_channel(v_uid, p_channel);
  v_role := dek.require_org(v_uid, c.org_id);
  if c.kind not in ('text', 'audio')
     or not exists (select 1 from dek.server_members sm where sm.server_id = c.server_id and sm.user_id = v_uid) then
    perform dek.err('not_found', 'That channel does not exist or you do not have access to it.');
  end if;
  if v_role = 'guest' then
    perform dek.err('forbidden', 'Guests can only use the channels they are added to.');
  end if;
  if c.archived_at is not null then
    perform dek.err('archived', 'This channel is archived.');
  end if;
  if exists (select 1 from dek.channel_members cm where cm.channel_id = c.id and cm.user_id = v_uid) then
    return jsonb_build_object('status', 'joined', 'channel_id', c.id);
  end if;
  if c.visibility = 'public' then
    perform dek.org_grant_channel_membership(c.id, v_uid, 'member', v_uid);
    return jsonb_build_object('status', 'joined', 'channel_id', c.id);
  end if;
  if char_length(coalesce(v_note, '')) > 300 then
    perform dek.err('invalid_input', 'Keep the note under 300 characters.');
  end if;
  select * into v_req from dek.channel_join_requests r
   where r.channel_id = c.id and r.user_id = v_uid and r.status = 'pending';
  if v_req.id is not null then
    return jsonb_build_object('status', 'pending', 'channel_id', c.id, 'request_id', v_req.id);
  end if;
  perform dek.rate_hit(v_uid, 'channel_request', 20, 3600);
  insert into dek.channel_join_requests (org_id, channel_id, user_id, note)
  values (c.org_id, c.id, v_uid, v_note)
  returning * into v_req;
  v_to := array(select u from unnest(dek.channel_approvers(c.id)) u where u <> v_uid);
  perform dek.emit_users(v_to, 'join.req', jsonb_build_object(
    'org_id', c.org_id, 'channel_id', c.id, 'request_id', v_req.id, 'user_id', v_uid, 'change', 'new'));
  insert into dek.notification_intents (org_id, kind, channel_id, actor_id, channel_request_id)
  values (c.org_id, 'request', c.id, v_uid, v_req.id);
  perform dek.audit(c.org_id, 'channel.join_requested', 'channel', c.id, jsonb_build_object('request_id', v_req.id));
  return jsonb_build_object('status', 'pending', 'channel_id', c.id, 'request_id', v_req.id);
end $$;

create or replace function api.withdraw_channel_request(p_channel uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_ids uuid[];
  c     dek.channels;
begin
  v_uid := dek.require_uid();
  c := dek.org_find_channel(v_uid, p_channel);
  with w as (
    update dek.channel_join_requests r set status = 'withdrawn', decided_at = now(), decided_by = v_uid
     where r.channel_id = c.id and r.user_id = v_uid and r.status = 'pending'
    returning r.id
  ) select coalesce(array_agg(w.id), '{}') into v_ids from w;
  if cardinality(v_ids) > 0 then
    perform dek.emit_users(dek.channel_approvers(c.id), 'join.req', jsonb_build_object(
      'org_id', c.org_id, 'channel_id', c.id, 'request_id', v_ids[1], 'user_id', v_uid, 'change', 'withdrawn'));
  end if;
  return jsonb_build_object('status', 'none', 'channel_id', c.id);
end $$;

-- ------------------------------------------------------------------ deciding

create or replace function api.list_channel_requests(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_items jsonb;
begin
  v_uid := dek.require_uid();
  v_admin := dek.require_org(v_uid, p_org) in ('owner', 'admin');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'note', r.note, 'created_at', r.created_at, 'user', dek.profile_json(p),
           'channel', jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind, 'server_id', c.server_id,
                                         'member_count', (select count(*) from dek.channel_members x where x.channel_id = c.id)))
           order by r.created_at desc), '[]'::jsonb)
    into v_items
    from (select x.* from dek.channel_join_requests x
           where x.org_id = p_org and x.status = 'pending'
           order by x.created_at desc limit 300) r
    join dek.channels c on c.id = r.channel_id
    join dek.profiles p on p.id = r.user_id
   where v_admin or dek.may_decide_channel_request(v_uid, c);
  return jsonb_build_object('items', v_items);
end $$;

create or replace function api.decide_channel_request(p_request uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  r     dek.channel_join_requests;
  c     dek.channels;
  m     dek.org_members;
begin
  v_uid := dek.require_uid();
  select * into r from dek.channel_join_requests x where x.id = p_request for update;
  perform dek.org_require_member(v_uid, r.org_id, 'That join request does not exist.');
  select * into c from dek.channels x where x.id = r.channel_id;
  if not dek.may_decide_channel_request(v_uid, c) then
    perform dek.err('forbidden', 'Only the channel owner or an admin of its team server can decide this.');
  end if;
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

-- ------------------------------------------------------------------ push

-- A new request goes to the approvers; an approval (target_user_id set) goes to the
-- person who asked. Preview "none" hides names, quiet hours are honoured, every
-- device is tried once per intent (the same rules as dek.plat_route_call).
create or replace function dek.plat_route_request(i dek.notification_intents)
returns table (r_user uuid, r_device uuid, r_quiet boolean, r_title text, r_body text, r_url text,
               r_tag text, r_org uuid, r_org_short text, r_preview text, r_urgency text)
language plpgsql stable security definer set search_path = '' as $$
declare
  r      dek.channel_join_requests;
  c      dek.channels;
  v_org  text;
  v_who  text;
  v_to   uuid[];
  v_chan text;
begin
  select * into r from dek.channel_join_requests x where x.id = i.channel_request_id;
  if r.id is null then
    return;
  end if;
  select * into c from dek.channels x where x.id = r.channel_id;
  select coalesce(o.short_name, o.name) into v_org from dek.orgs o where o.id = c.org_id;
  v_chan := case when c.kind = 'audio' then coalesce(c.name, 'a channel') else '#' || coalesce(c.name, 'channel') end;
  if i.target_user_id is null then
    if r.status <> 'pending' then
      return;   -- decided or withdrawn before dispatch
    end if;
    select case when p.deleted_at is null then p.display_name else 'Someone' end into v_who
      from dek.profiles p where p.id = r.user_id;
    v_to := array(select u from unnest(dek.channel_approvers(c.id)) u where u <> r.user_id);
  else
    if r.status <> 'approved' then
      return;
    end if;
    v_to := array[i.target_user_id];
  end if;
  return query
  select d.user_id, d.id,
         case when n.quiet_start is not null and n.quiet_end is not null
              then dek.plat_in_quiet_hours(n.quiet_start, n.quiet_end, n.quiet_tz) else false end,
         case when coalesce(n.preview, 'full') = 'none' then 'Dek'
              when i.target_user_id is null then 'Request to join ' || v_chan
              else 'You are in ' || v_chan end,
         case when coalesce(n.preview, 'full') = 'none'
              then case when i.target_user_id is null then 'Someone asked to join a channel' else 'A request was approved' end
              when i.target_user_id is null then coalesce(v_who, 'Someone') || ' asked to join. Tap to approve or decline.'
              else 'Your request was approved. Tap to open it.' end,
         case when i.target_user_id is null then '/o/' || c.org_id || '/activity?tab=requests'
              else '/o/' || c.org_id || '/c/' || c.id end,
         'req:' || r.id,
         c.org_id, v_org, coalesce(n.preview, 'full'), 'normal'
    from dek.push_devices d
    join dek.profiles p on p.id = d.user_id and p.deleted_at is null
    left join dek.notification_prefs n on n.user_id = d.user_id
   where d.user_id = any (v_to) and d.enabled and d.revoked_at is null
     and not exists (select 1 from dek.notification_deliveries nd
                      where nd.intent_id = i.id and nd.device_id = d.id
                        and not dek.plat_retryable(nd.status, nd.http_status))
   order by d.user_id, d.id
   limit 500;
end $$;

create or replace function dek.plat_route(i dek.notification_intents)
returns table (r_user uuid, r_device uuid, r_quiet boolean, r_title text, r_body text, r_url text,
               r_tag text, r_org uuid, r_org_short text, r_preview text, r_urgency text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if i.kind = 'message' then
    return query select * from dek.plat_route_message(i);
  elsif i.kind = 'call' then
    return query select * from dek.plat_route_call(i);
  elsif i.kind = 'test' then
    return query select * from dek.plat_route_test(i);
  elsif i.kind = 'request' then
    return query select * from dek.plat_route_request(i);
  end if;
end $$;
