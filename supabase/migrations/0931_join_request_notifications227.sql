--227: notify the current approvers of approval-based server/org requests.
-- Existing requests are not replayed. Approval powers are unchanged.
alter table dek.notification_intents add column server_request_id uuid
  references dek.join_requests(id) on delete cascade;
create unique index notification_intents_server_request227_uidx
  on dek.notification_intents(server_request_id,target_user_id)
  where server_request_id is not null;
alter table dek.notification_intents add constraint notification_intents_server_request227_check
  check(server_request_id is null or (kind='request' and target_user_id is not null and channel_request_id is null));

-- Match the current decision endpoint, including its locked server access check.
-- A configured Moderator or Member receives exactly the same treatment as Admin.
create function dek.server_request_approvers227(p_org uuid,p_server uuid) returns uuid[]
language sql stable security definer set search_path='' as $fn$
 select coalesce(array_agg(m.user_id order by m.user_id),'{}'::uuid[])
 from dek.org_members m join dek.profiles p on p.id=m.user_id and p.deleted_at is null
 where m.org_id=p_org and m.status='active' and
  ((p_server is null and m.role in('owner','admin')) or
   (p_server is not null and exists(select 1 from dek.servers s where s.id=p_server and s.org_id=p_org)
    and dek.server_content_allowed105(m.user_id,p_server)
    and dek.has_server_permission105(m.user_id,p_server,'decide_join_requests')))
$fn$;

-- Preserve0916's channel path and current105 predicate. Deleted/blocked actors
-- cannot call the decision endpoint, and a fifty-person cutoff omits real approvers.
create or replace function dek.channel_approvers(p_channel uuid) returns uuid[]
language sql stable security definer set search_path='' as $fn$
 select coalesce(array_agg(u.user_id order by u.user_id),'{}'::uuid[])
 from dek.channels c cross join lateral(
  select sm.user_id from dek.server_members sm where sm.server_id=c.server_id
  union
  select om.user_id from dek.org_members om where om.org_id=c.org_id
   and om.role in('owner','admin') and om.status='active'
 )u join dek.profiles p on p.id=u.user_id and p.deleted_at is null
 where c.id=p_channel and dek.server_content_allowed105(u.user_id,c.server_id)
  and dek.may_decide_channel_request(u.user_id,c)
$fn$;

create function dek.on_join_request227() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare recipients uuid[];
begin
 if tg_op='INSERT' then
  if new.status<>'pending' then return new;end if;
  recipients:=array(select u from unnest(dek.server_request_approvers227(new.org_id,new.server_id))u
                    where u<>new.user_id);
  perform dek.emit_users(recipients,'server.join.req',jsonb_build_object(
   'org_id',new.org_id,'server_id',new.server_id,'request_id',new.id,'user_id',new.user_id,'change','new'));
  -- One intent per recipient avoids truncating a large server's fanout at the
  -- channel router's device limit. Unique(request,recipient) is the retry key.
  insert into dek.notification_intents(org_id,kind,actor_id,target_user_id,server_request_id)
   select new.org_id,'request',new.user_id,u,new.id from unnest(recipients)u
   on conflict do nothing;
 elsif new.status is distinct from old.status then
  recipients:=dek.server_request_approvers227(new.org_id,new.server_id)||new.user_id;
  perform dek.emit_users(recipients,'server.join.req',jsonb_build_object(
   'org_id',new.org_id,'server_id',new.server_id,'request_id',new.id,'user_id',new.user_id,'change',new.status));
 end if;
 return new;
end $fn$;
create trigger dek_join_request_notify227 after insert or update of status on dek.join_requests
 for each row execute function dek.on_join_request227();

create function dek.plat_route_server_request227(i dek.notification_intents)
returns table(r_user uuid,r_device uuid,r_quiet boolean,r_title text,r_body text,r_url text,
 r_tag text,r_org uuid,r_org_short text,r_preview text,r_urgency text)
language plpgsql stable security definer set search_path='' as $fn$
declare r dek.join_requests;v_org text;v_scope text;v_who text;
begin
 select * into r from dek.join_requests x where x.id=i.server_request_id;
 if r.id is null or r.status<>'pending' or i.org_id<>r.org_id or i.target_user_id=r.user_id then return;end if;
 -- Current permissions are checked again when queued/retried, never trusted
 -- from the creation-time snapshot. A revoked approver receives no push.
 if not(i.target_user_id=any(dek.server_request_approvers227(r.org_id,r.server_id)))then return;end if;
 if r.server_id is not null and exists(select 1 from dek.servers s where s.id=r.server_id and s.archived_at is not null)then return;end if;
 select coalesce(o.short_name,o.name),o.name into v_org,v_scope from dek.orgs o where o.id=r.org_id;
 if r.server_id is not null then select s.name into v_scope from dek.servers s where s.id=r.server_id and s.org_id=r.org_id;end if;
 select case when p.deleted_at is null then p.display_name else 'Someone' end into v_who
  from dek.profiles p where p.id=r.user_id;
 return query select d.user_id,d.id,
  case when n.quiet_start is not null and n.quiet_end is not null
   then dek.plat_in_quiet_hours(n.quiet_start,n.quiet_end,n.quiet_tz)else false end,
  case when coalesce(n.preview,'full')='none'then'Dek'else'Request to join '||coalesce(v_scope,'a team')end,
  case when coalesce(n.preview,'full')='none'then'Someone asked to join a team'
   else coalesce(v_who,'Someone')||' asked to join. Tap to approve or decline.'end,
  case when r.server_id is null or dek.is_org_admin(d.user_id,r.org_id)
   then'/o/'||r.org_id||'/admin/requests'
   else'/o/'||r.org_id||'/s/'||r.server_id||'/settings#requests'end,
  'sreq:'||r.id,r.org_id,v_org,coalesce(n.preview,'full'),'normal'
 from dek.push_devices d join dek.profiles p on p.id=d.user_id and p.deleted_at is null
 left join dek.notification_prefs n on n.user_id=d.user_id
 where d.user_id=i.target_user_id and d.enabled and d.revoked_at is null
 and not exists(select 1 from dek.notification_deliveries nd where nd.intent_id=i.id and nd.device_id=d.id
  and not dek.plat_retryable(nd.status,nd.http_status))
 order by d.id;
end $fn$;

create or replace function dek.plat_route(i dek.notification_intents)
returns table(r_user uuid,r_device uuid,r_quiet boolean,r_title text,r_body text,r_url text,
 r_tag text,r_org uuid,r_org_short text,r_preview text,r_urgency text)
language plpgsql stable security definer set search_path='' as $fn$
begin
 if i.kind='message'then return query select * from dek.plat_route_message(i);
 elsif i.kind='call'then return query select * from dek.plat_route_call(i);
 elsif i.kind='test'then return query select * from dek.plat_route_test(i);
 elsif i.kind='request'then
  if i.server_request_id is not null then return query select * from dek.plat_route_server_request227(i);
  else return query select * from dek.plat_route_request(i);end if;
 end if;
end $fn$;

-- Native227 regression:54eligible approvers with10devices each must not lose
-- the final40devices. Preserve0916 routing verbatim except its500device cutoff.
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
   order by d.user_id, d.id;
end $$;
