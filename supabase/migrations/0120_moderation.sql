-- 0120: reports, blocks and the audit log (CONTRACT 2.5, DEK13). Owner: [org].
-- Helpers (dek.org_*) live in 0100. Same rules and re-run pattern as 0100.
-- Message removal is dek.soft_delete_message (0002) and member removal is
-- dek.revoke_org_membership (0002): never re-implemented here.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'api' and p.proname = any (array[
              'report', 'list_reports', 'resolve_report', 'block_user', 'list_blocks', 'list_audit']))
        or (n.nspname = 'dek' and p.proname = any (array['org_reports_json']))
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

-- list_reports items for a set of report ids, newest first, built in one set-based
-- query (a per-report helper with sub-selects measured 30 ms for a page of 50; this
-- measures under 10). Org admins reviewing a report see the reported message even in
-- a channel or DM they cannot read: that review is what the report asks for. Each
-- channel's dek.channel_json is built once per page, however many reports share it.
create or replace function dek.org_reports_json(p_ids uuid[], p_uid uuid)
returns jsonb language sql stable set search_path = '' as $$
  with chans as materialized (
    select c.id, dek.channel_json(c, p_uid) as j
      from dek.channels c
     where c.id in (select x.channel_id from dek.reports x where x.id = any (p_ids))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'kind', r.kind, 'reason', r.reason, 'details', r.details, 'status', r.status,
           'reporter', dek.profile_json(rp), 'target_user', dek.profile_json(tp),
           'message', case when m.id is not null then dek.message_json(m) end,
           'channel', ch.j,
           'created_at', r.created_at, 'resolved_by', r.resolved_by, 'resolved_at', r.resolved_at,
           'resolution', r.resolution)
         order by r.created_at desc, r.id), '[]'::jsonb)
    from dek.reports r
    left join dek.profiles rp on rp.id = r.reporter_id
    left join dek.profiles tp on tp.id = r.target_user_id
    left join dek.messages m on m.id = r.message_id
    left join chans ch on ch.id = r.channel_id
   where r.id = any (p_ids)
$$;

-- Any active member (guests too) may report a message they can read or a member of
-- the org. 20 per hour. Reporting the same open thing twice returns the first report.
-- (p_reason comes before the optional arguments because PostgreSQL wants defaults
-- last; PostgREST calls by name, so the order is invisible to the client.)
create or replace function api.report(p_kind text, p_org uuid, p_reason text, p_message uuid default null,
                                      p_user uuid default null, p_details text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid;
  v_details text;
  v_target  uuid;
  v_channel uuid;
  v_id      uuid;
  m         dek.messages;
begin
  v_uid := dek.require_uid();
  perform dek.require_org(v_uid, p_org);
  perform dek.rate_hit(v_uid, 'report', 20, 3600);
  if p_kind is null or p_kind not in ('message', 'user') then
    perform dek.err('invalid_input', 'kind must be one of: message, user.');
  end if;
  if p_reason is null or p_reason not in ('spam', 'harassment', 'inappropriate', 'other') then
    perform dek.err('invalid_input', 'reason must be one of: spam, harassment, inappropriate, other.');
  end if;
  v_details := dek.org_clean_text(p_details, 'details', 2000, false, false);
  if p_kind = 'message' then
    if p_message is null then
      perform dek.err('invalid_input', 'message is required.');
    end if;
    select * into m from dek.messages x where x.id = p_message;
    if m.id is null or m.org_id <> p_org or not dek.can_read_channel(v_uid, m.channel_id) then
      perform dek.err('not_found', 'That message does not exist or you do not have access to it.');
    end if;
    if m.author_id is null then
      perform dek.err('invalid_input', 'System messages cannot be reported.');
    end if;
    if m.author_id = v_uid then
      perform dek.err('invalid_input', 'You cannot report your own message.');
    end if;
    v_target := m.author_id;
    v_channel := m.channel_id;
  else
    if p_user is null then
      perform dek.err('invalid_input', 'user is required.');
    end if;
    if p_user = v_uid then
      perform dek.err('invalid_input', 'You cannot report yourself.');
    end if;
    if not exists (select 1 from dek.org_members x where x.org_id = p_org and x.user_id = p_user) then
      perform dek.err('not_found', 'That person is not a member of this organization.');
    end if;
    v_target := p_user;
  end if;
  select r.id into v_id from dek.reports r
   where r.org_id = p_org and r.status = 'open' and r.reporter_id = v_uid and r.kind = p_kind
     and r.target_user_id = v_target and r.message_id is not distinct from m.id
   limit 1;
  if v_id is null then
    insert into dek.reports (org_id, reporter_id, kind, message_id, channel_id, target_user_id, reason, details)
    values (p_org, v_uid, p_kind, m.id, v_channel, v_target, p_reason, v_details)
    returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function api.list_reports(p_org uuid, p_status text default 'open', p_limit int default 50,
                                            p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_off   int := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_total int;
  v_items jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.require_org_admin(v_uid, p_org);
  if p_status is not null and p_status not in ('open', 'actioned', 'dismissed') then
    perform dek.err('invalid_input', 'status must be one of: open, actioned, dismissed.');
  end if;
  select count(*) into v_total from (
    select 1 from dek.reports x
     where x.org_id = p_org and (p_status is null or x.status = p_status)
     limit 10000) t;
  v_items := dek.org_reports_json(array(
    select x.id from dek.reports x
     where x.org_id = p_org and (p_status is null or x.status = p_status)
     order by x.created_at desc, x.id
     limit v_limit offset v_off), v_uid);
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- Org admins. dismiss | remove_message (dek.soft_delete_message as a moderation
-- removal: the original text stays in the audit log) | suspend_user | remove_user
-- (dek.revoke_org_membership). The same rank rules as the member tools apply: an
-- admin cannot suspend or remove an owner or another admin.
create or replace function api.resolve_report(p_report uuid, p_action text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_me     text;
  v_note   text;
  v_status text;
  r        dek.reports;
begin
  v_uid := dek.require_uid();
  select * into r from dek.reports x where x.id = p_report for update;
  perform dek.org_require_member(v_uid, r.org_id, 'That report does not exist.');
  v_me := dek.require_org_admin(v_uid, r.org_id);
  if p_action is null or p_action not in ('dismiss', 'remove_message', 'suspend_user', 'remove_user') then
    perform dek.err('invalid_input', 'action must be one of: dismiss, remove_message, suspend_user, remove_user.');
  end if;
  if r.status <> 'open' then
    perform dek.err('conflict', 'This report has already been resolved.');
  end if;
  v_note := dek.org_clean_text(p_note, 'note', 900, false, false);
  v_status := case when p_action = 'dismiss' then 'dismissed' else 'actioned' end;
  if p_action = 'remove_message' then
    if r.message_id is null then
      perform dek.err('invalid_input', 'This report is not about a message that still exists.');
    end if;
    perform dek.soft_delete_message(r.message_id, v_uid, coalesce(v_note, 'report: ' || r.reason), true);
  elsif p_action in ('suspend_user', 'remove_user') then
    if r.target_user_id is null
       or not exists (select 1 from dek.org_members x where x.org_id = r.org_id and x.user_id = r.target_user_id) then
      perform dek.err('conflict', 'That person is no longer a member of this organization.');
    end if;
    if p_action = 'suspend_user' then
      perform dek.org_set_suspended(r.org_id, r.target_user_id, v_uid, v_me, true,
                                    coalesce(v_note, 'report: ' || r.reason));
    else
      perform dek.org_remove_member(r.org_id, r.target_user_id, v_uid, v_me, false, v_note);
    end if;
  end if;
  update dek.reports x
     set status = v_status, resolved_by = v_uid, resolved_at = now(),
         resolution = p_action || coalesce(': ' || v_note, '')
   where x.id = r.id
  returning * into r;
  if p_action = 'remove_message' then
    -- everyone else who reported the same message is answered by the same removal
    update dek.reports x
       set status = 'actioned', resolved_by = v_uid, resolved_at = now(), resolution = r.resolution
     where x.org_id = r.org_id and x.status = 'open' and x.message_id = r.message_id;
  end if;
  perform dek.audit(r.org_id, 'report.resolved', 'report', r.id, jsonb_build_object(
    'action', p_action, 'note', v_note, 'kind', r.kind, 'reason', r.reason,
    'target_user_id', r.target_user_id, 'message_id', r.message_id));
  return dek.org_reports_json(array[r.id], v_uid) -> 0;
end $$;

-- Block someone you share an organization with (unblocking needs no shared org). A
-- blocked person cannot open or post in a 1:1 DM with the blocker (open_dm,
-- dek.assert_post); push routing drops their mentions of the blocker.
create or replace function api.block_user(p_user uuid, p_blocked boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := dek.require_uid();
  if p_user is null or p_blocked is null then
    perform dek.err('invalid_input', 'user and blocked are required.');
  end if;
  if p_user = v_uid then
    perform dek.err('invalid_input', 'You cannot block yourself.');
  end if;
  if p_blocked then
    if not dek.shares_org(v_uid, p_user) then
      perform dek.err('not_found', 'That person does not exist or does not share an organization with you.');
    end if;
    insert into dek.user_blocks (blocker_id, blocked_id) values (v_uid, p_user) on conflict do nothing;
  else
    delete from dek.user_blocks b where b.blocker_id = v_uid and b.blocked_id = p_user;
  end if;
  return jsonb_build_object('user_id', p_user, 'blocked', p_blocked);
end $$;

create or replace function api.list_blocks()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_items jsonb;
begin
  v_uid := dek.require_uid();
  select coalesce(jsonb_agg(dek.profile_json(p) order by b.created_at desc, p.id), '[]'::jsonb)
    into v_items
    from (select x.blocked_id, x.created_at from dek.user_blocks x
           where x.blocker_id = v_uid
           order by x.created_at desc
           limit 500) b
    join dek.profiles p on p.id = b.blocked_id;
  return jsonb_build_object('items', v_items);
end $$;

-- Org admins. Newest first, p_before is the created_at of the last item already shown.
-- One transaction can write several rows with the same created_at; those are never
-- split across pages (they all join the page that reaches them).
create or replace function api.list_audit(p_org uuid, p_before timestamptz default null, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_ids   bigint[];
  v_min   timestamptz;
  v_more  boolean := false;
  v_items jsonb;
begin
  v_uid := dek.require_uid();
  perform dek.require_org_admin(v_uid, p_org);
  select coalesce(array_agg(x.id), '{}'::bigint[]), min(x.created_at) into v_ids, v_min
    from (select a.id, a.created_at from dek.audit_log a
           where a.org_id = p_org and (p_before is null or a.created_at < p_before)
           order by a.created_at desc, a.id desc
           limit v_limit) x;
  if v_min is not null then
    select v_ids || coalesce(array_agg(t.id), '{}'::bigint[]) into v_ids
      from (select a.id from dek.audit_log a
             where a.org_id = p_org and a.created_at = v_min and a.id <> all (v_ids)
             limit 500) t;
    v_more := exists (select 1 from dek.audit_log a where a.org_id = p_org and a.created_at < v_min);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'actor', dek.profile_json(p), 'action', a.action, 'target_type', a.target_type,
           'target_id', a.target_id, 'details', a.details, 'created_at', a.created_at)
           order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_items
    from dek.audit_log a
    left join dek.profiles p on p.id = a.actor_id
   where a.id = any (v_ids);
  return jsonb_build_object('items', v_items, 'has_more', v_more);
end $$;
