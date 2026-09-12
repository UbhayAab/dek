-- 0131_leave_reaches_people.sql
--
-- 0130 made leave a system. This is the half that makes anybody find out about
-- it, and the half the request called "two way":
--
--   "Since the leave form had my leave, my status will auto update because of
--    that. Even if I just put my status as leave, it's as if I auto applied."
--
-- Four things, none of which 0130 does:
--
--   1. AN APPROVER IS TOLD. A request that sits in a table until somebody
--      happens to open a panel is a request that waits a week. Org admins get
--      the same push every other actionable thing in this app raises.
--   2. THE APPLICANT IS TOLD. A decision nobody sees is not a decision.
--   3. THE STATUS FOLLOWS THE LEAVE. An approved leave that covers today sets
--      the person's status, and sets it to expire the day they are back, so
--      nothing has to remember to clear it. Leave booked for next month is
--      picked up by a nightly job on the morning it starts.
--   4. IT LANDS IN ACTIVITY. The Activity tab is where this app already teaches
--      people to look for "something needs me", and a leave request is exactly
--      that. get_activity gains two arms and one column.

-- ============================================================================
-- 1. Status follows the leave
-- ============================================================================
--
-- The status text is generated from the kind, and the expiry is the morning
-- they are back - so the status clears itself and no second job has to know
-- anything about leave. Asia/Kolkata, for the same reason every other date in
-- 0130 is: a status that ends at UTC midnight ends at 05:30 in the morning here.
create or replace function private.leave_status_of(p_kind text)
returns text[] language sql immutable set search_path = '' as $fn$
  select case p_kind
    when 'leave'     then array['🌴', 'On leave']
    when 'sick'      then array['🤒', 'Out sick']
    when 'holiday'   then array['🎉', 'On holiday']
    when 'exam'      then array['📚', 'Exams']
    when 'travel'    then array['✈️', 'Travelling']
    when 'wfh'       then array['🏠', 'Working from home']
    when 'emergency' then array['⚠️', 'Away today']
    else array['🌴', 'On leave'] end;
$fn$;

-- Writes the status for one person from whatever approved leave covers the day.
-- Returns true when it wrote something.
--
-- IT WILL NOT OVERWRITE A STATUS SOMEBODY SET THEMSELVES unless that status is
-- one of ours. "In a meeting" chosen ten minutes ago must survive a nightly
-- job, and a status this function wrote yesterday must not survive the leave
-- being cancelled.
create or replace function private.apply_leave_status(p_user uuid, p_org uuid, p_day date default null)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare
  v_day  date := coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date);
  v_row  public.away_days;
  v_st   text[];
  v_cur  text;
  v_ours boolean;
begin
  select * into v_row from public.away_days a
   where a.org_id = p_org and a.user_id = p_user and a.status = 'approved'
     and v_day between a.starts_on and a.ends_on
   order by a.ends_on desc limit 1;

  select p.status_text into v_cur from public.profiles p where p.id = p_user;
  v_ours := v_cur is not null and exists (
    select 1 from unnest(array['leave','sick','holiday','exam','travel','wfh','emergency']) k
     where (private.leave_status_of(k))[2] = v_cur);

  if not found or v_row.id is null then
    -- Nothing covers today. Clear only what we wrote.
    if v_ours then
      update public.profiles
         set status_text = null, status_emoji = null, status_expires_at = null
       where id = p_user;
      perform app.emit('user:' || p_user::text, 'status',
        jsonb_build_object('status_text', null, 'status_emoji', null, 'status_expires_at', null));
      return true;
    end if;
    return false;
  end if;

  if v_cur is not null and not v_ours then return false; end if;   -- theirs, leave it

  v_st := private.leave_status_of(v_row.kind);
  update public.profiles
     set status_emoji = v_st[1],
         status_text  = v_st[2],
         -- Midnight Asia/Kolkata on the morning they are back.
         status_expires_at = ((v_row.ends_on + 1)::timestamp at time zone 'Asia/Kolkata')
   where id = p_user;
  perform app.emit('user:' || p_user::text, 'status',
    jsonb_build_object('status_emoji', v_st[1], 'status_text', v_st[2],
      'status_expires_at', ((v_row.ends_on + 1)::timestamp at time zone 'Asia/Kolkata')));
  return true;
end;
$fn$;

-- The nightly pass, for leave booked in advance. Only touches people whose
-- leave starts or ended today, so it is a handful of rows rather than a scan of
-- every profile in the deployment.
create or replace function app.sync_leave_statuses()
returns int language plpgsql security definer set search_path = '' as $fn$
declare
  v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_n   int := 0;
  r     record;
begin
  for r in
    select distinct a.user_id, a.org_id
      from public.away_days a
     where a.status = 'approved'
       and (a.starts_on = v_day or a.ends_on = v_day - 1)
  loop
    if private.apply_leave_status(r.user_id, r.org_id, v_day) then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end;
$fn$;

-- 00:10 Asia/Kolkata is 18:40 UTC the day before. pg_cron runs in UTC here, so
-- the schedule is written in UTC and the comment says what it means.
select cron.unschedule('sync-leave-statuses')
 where exists (select 1 from cron.job where jobname = 'sync-leave-statuses');
select cron.schedule('sync-leave-statuses', '40 18 * * *', 'select app.sync_leave_statuses();');

-- ============================================================================
-- 2. Telling people
-- ============================================================================
--
-- app.enqueue_notification is the same queue every other actionable thing in
-- this app rides; app.emit is the realtime companion that makes an open panel
-- update without a reload. Both are fire-and-forget by design: a push that
-- fails must never fail the application it was about.
create or replace function private.notify_leave_filed(p_row public.away_days)
returns void language plpgsql security definer set search_path = '' as $fn$
declare r record;
begin
  if p_row.status <> 'pending' then return; end if;
  for r in select om.user_id from public.org_members om
            where om.org_id = p_row.org_id and om.org_role = 'admin'
              and om.user_id <> p_row.user_id
  loop
    perform app.enqueue_notification(r.user_id, jsonb_build_object(
      'kind', 'leave_request', 'leave_id', p_row.id, 'org_id', p_row.org_id,
      'user_id', p_row.user_id, 'leave_kind', p_row.kind,
      'starts_on', p_row.starts_on, 'ends_on', p_row.ends_on, 'flagged', p_row.flagged));
    perform app.emit('user:' || r.user_id::text, 'leave',
      jsonb_build_object('what', 'filed', 'leave_id', p_row.id, 'org_id', p_row.org_id));
  end loop;
end;
$fn$;

create or replace function private.notify_leave_decided(p_row public.away_days)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  if p_row.decided_by is null or p_row.decided_by = p_row.user_id then return; end if;
  perform app.enqueue_notification(p_row.user_id, jsonb_build_object(
    'kind', 'leave_decision', 'leave_id', p_row.id, 'org_id', p_row.org_id,
    'status', p_row.status, 'leave_kind', p_row.kind,
    'starts_on', p_row.starts_on, 'ends_on', p_row.ends_on));
  perform app.emit('user:' || p_row.user_id::text, 'leave',
    jsonb_build_object('what', 'decided', 'leave_id', p_row.id,
                       'status', p_row.status, 'org_id', p_row.org_id));
end;
$fn$;

-- ============================================================================
-- 3. The three writers, re-stated with the side effects attached
-- ============================================================================
--
-- Only the tails change. Everything above the insert is 0130 verbatim, because
-- the policy is correct and re-deriving it here would be two copies of one set
-- of rules waiting to disagree.
create or replace function public.apply_leave(
  p_org   uuid,
  p_from  date,
  p_to    date,
  p_kind  text default 'leave',
  p_note  text default null,
  p_user  uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_for    uuid := coalesce(p_user, (select auth.uid()));
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_pol    public.leave_policies;
  v_days   int;
  v_status text;
  v_auto   boolean := false;
  v_flag   boolean := false;
  v_reason text;
  v_row    public.away_days;
  v_over   boolean := false;
  m        date;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_for <> v_uid and not private.is_org_admin(p_org) then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only an organisation admin can file leave for somebody else.';
  end if;
  if not exists (select 1 from public.org_members om
                  where om.org_id = p_org and om.user_id = v_for) then
    raise exception 'not_a_member' using errcode = '22023';
  end if;
  if p_from is null or p_to is null then raise exception 'dates_required' using errcode = '22023'; end if;
  if p_to < p_from then raise exception 'ends_before_it_starts' using errcode = '22023'; end if;

  v_pol  := private.leave_policy_eff(p_org);
  v_days := (p_to - p_from) + 1;

  if p_kind is null or p_kind not in ('leave','sick','holiday','travel','wfh','exam','emergency') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if v_days > v_pol.max_stretch_days then
    raise exception 'too_long' using errcode = '22023',
      hint = format('The longest single application here is %s days.', v_pol.max_stretch_days);
  end if;
  if exists (select 1 from public.away_days a
              where a.org_id = p_org and a.user_id = v_for
                and a.status in ('pending', 'approved')
                and a.starts_on <= p_to and a.ends_on >= p_from) then
    raise exception 'overlaps' using errcode = '22023',
      hint = 'You already have time off booked across those dates.';
  end if;

  if p_kind = any(v_pol.free_kinds) then
    v_status := 'approved'; v_auto := true;
  elsif p_kind = any(v_pol.approval_kinds) then
    v_status := 'pending';
  elsif p_kind = any(v_pol.quota_kinds) then
    m := date_trunc('month', p_from)::date;
    while m <= date_trunc('month', p_to)::date loop
      if private.leave_days_in_month(p_org, v_for, m)
         + (select count(*)::int
              from generate_series(p_from, p_to, interval '1 day') d
             where date_trunc('month', d)::date = m)
         > v_pol.auto_approve_per_month then
        v_over := true;
      end if;
      m := (m + interval '1 month')::date;
    end loop;
    if v_over then v_status := 'pending';
    else v_status := 'approved'; v_auto := true; end if;
  else
    v_status := 'pending';
  end if;

  if p_kind = any(v_pol.flag_kinds) then
    v_flag := true;
    v_reason := 'Logged as an emergency no-show';
  elsif v_pol.flag_backdated and p_from < v_today and not (p_kind = any(v_pol.free_kinds)) then
    v_flag := true;
    v_reason := format('Filed on %s for an absence that began %s', v_today, p_from);
  end if;

  insert into public.away_days(org_id, user_id, starts_on, ends_on, kind, note,
                               status, auto_approved, flagged, flag_reason, filed_by,
                               decided_by, decided_at)
  values (p_org, v_for, p_from, p_to, p_kind, nullif(btrim(coalesce(p_note, '')), ''),
          v_status, v_auto, v_flag, v_reason, v_uid,
          case when v_auto then v_uid end,
          case when v_auto then now() end)
  returning * into v_row;

  -- ---- the new tail -------------------------------------------------------
  -- Approved and starting today or already running: the status follows it now
  -- rather than at the next midnight.
  if v_row.status = 'approved' and v_today between v_row.starts_on and v_row.ends_on then
    perform private.apply_leave_status(v_for, p_org, v_today);
  end if;
  perform private.notify_leave_filed(v_row);

  return jsonb_build_object(
    'id', v_row.id, 'status', v_row.status, 'auto_approved', v_row.auto_approved,
    'flagged', v_row.flagged, 'flag_reason', v_row.flag_reason,
    'days', v_row.days, 'kind', v_row.kind,
    'starts_on', v_row.starts_on, 'ends_on', v_row.ends_on,
    'user_id', v_row.user_id,
    'balance', public.leave_balance(p_org, v_for, p_from));
end;
$fn$;
grant execute on function public.apply_leave(uuid, date, date, text, text, uuid) to authenticated;

create or replace function public.decide_leave(
  p_id uuid, p_approve boolean, p_note text default null)
returns public.away_days language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_row   public.away_days;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_row from public.away_days where id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if not private.is_org_admin(v_row.org_id) then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only an organisation admin can approve or refuse leave.';
  end if;
  if v_row.status = 'cancelled' then
    raise exception 'already_cancelled' using errcode = '22023';
  end if;
  update public.away_days
     set status = case when p_approve then 'approved' else 'rejected' end,
         auto_approved = false,
         decided_by = v_uid, decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_id
   returning * into v_row;

  -- Approving something that covers today turns the status on; refusing
  -- something that was approved and is running turns it back off.
  if v_today between v_row.starts_on and v_row.ends_on then
    perform private.apply_leave_status(v_row.user_id, v_row.org_id, v_today);
  end if;
  perform private.notify_leave_decided(v_row);
  return v_row;
end;
$fn$;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;

create or replace function public.cancel_leave(p_id uuid, p_reason text default null)
returns public.away_days language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_row   public.away_days;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_row from public.away_days where id = p_id;
  if not found then return null; end if;
  if v_row.user_id <> v_uid and not private.is_org_admin(v_row.org_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_row.ends_on < v_today and not private.is_org_admin(v_row.org_id) then
    raise exception 'already_taken' using errcode = '22023',
      hint = 'That time off is in the past. Ask a coordinator to correct it.';
  end if;
  update public.away_days
     set status = 'cancelled',
         decided_by = v_uid, decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id returning * into v_row;

  -- Cancelling a leave that is running today takes the status off with it.
  if v_today between v_row.starts_on and v_row.ends_on then
    perform private.apply_leave_status(v_row.user_id, v_row.org_id, v_today);
  end if;
  return v_row;
end;
$fn$;
grant execute on function public.cancel_leave(uuid, text) to authenticated;

-- ============================================================================
-- 4. Activity
-- ============================================================================
--
-- Two arms and one new column. `ref_id` rather than reusing task_id: a leave id
-- sitting in a column called task_id is the kind of thing that reads fine today
-- and sends somebody to the wrong panel in six months.
--
-- The signature changes, so this is a drop and a create. Everything above the
-- two new arms is the deployed function verbatim.
drop function if exists public.get_activity(uuid, integer, text);

create function public.get_activity(p_workspace uuid, p_limit integer default 50,
                                    p_filter text default 'unread')
returns table(kind text, channel_id uuid, message_id uuid, actor_id uuid,
              created_at timestamptz, snippet text, conversation_id uuid,
              item_key text, is_read boolean, task_id uuid, title text, ref_id uuid)
language plpgsql stable security definer set search_path = '' as $function$
declare
  v_uid uuid := (select auth.uid());
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_f   text := lower(coalesce(p_filter, 'unread'));
  v_org uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_f not in ('unread', 'all', 'mentions', 'dms', 'tasks', 'replies') then
    raise exception 'invalid_filter:%', v_f using errcode = '22023',
      hint = 'unread, all, mentions, dms, tasks or replies.';
  end if;
  select w.org_id into v_org from public.workspaces w where w.id = p_workspace;

  return query
  with feed as (
    -- (a) somebody typed your name in a channel
    (
      select 'mention'::text as kind, m.channel_id, m.id as message_id,
             m.author_id as actor_id, m.created_at,
             left(m.body_text, 140) as snippet, null::uuid as conversation_id,
             null::uuid as task_id, null::text as title, null::uuid as ref_id
      from public.messages m
      where m.workspace_id = p_workspace and m.deleted_at is null
        and m.mention_user_ids @> array[v_uid]::uuid[]
        and m.author_id is distinct from v_uid
        and (select private.can_view_channel(m.channel_id))
      order by m.created_at desc limit v_lim
    )
    union all
    -- (b) somebody reacted to something you wrote in a channel
    (
      select 'reaction'::text, m.channel_id, m.id, r.user_id, r.created_at,
             left(m.body_text, 140), null::uuid, null::uuid, null::text, null::uuid
      from public.message_reactions r
      join public.messages m on m.id = r.message_id
      where m.workspace_id = p_workspace and m.author_id = v_uid
        and m.deleted_at is null and r.user_id <> v_uid
        and (select private.can_view_channel(m.channel_id))
      order by r.created_at desc limit v_lim
    )
    union all
    -- (c) a reply in a thread you started, rooted or joined
    (
      select 'thread_reply'::text, m.channel_id, m.id, m.author_id, m.created_at,
             left(m.body_text, 140), null::uuid, null::uuid, null::text, null::uuid
      from public.messages m
      join public.threads t on t.id = m.thread_id
      left join public.messages root on root.id = t.root_message_id
      where m.workspace_id = p_workspace and m.thread_id is not null
        and m.deleted_at is null and m.author_id is distinct from v_uid
        and ( t.created_by = v_uid or root.author_id = v_uid
           or exists (select 1 from public.messages me
                       where me.thread_id = t.id and me.author_id = v_uid) )
        and (select private.can_view_channel(m.channel_id))
      order by m.created_at desc limit v_lim
    )
    union all
    -- (d) a direct message. Split in two so a TAG in a DM is its own thing.
    (
      select case when d.mention_user_ids @> array[v_uid]::uuid[]
                  then 'dm_mention'::text else 'dm'::text end,
             null::uuid, d.id, d.author_id, d.created_at,
             left(coalesce(nullif(btrim(d.body_text), ''),
                  case when jsonb_array_length(coalesce(d.attachments, '[]'::jsonb)) > 0
                       then '(attachment)' else '' end), 140),
             d.conversation_id, null::uuid, null::text, null::uuid
      from public.dm_messages d
      join public.conversations cv on cv.id = d.conversation_id
      join public.conversation_members cm
        on cm.conversation_id = d.conversation_id and cm.user_id = v_uid
      where cv.workspace_id = p_workspace and d.deleted_at is null
        and d.author_id is distinct from v_uid
      order by d.created_at desc limit v_lim
    )
    union all
    -- (e) a reaction on one of YOUR direct messages
    (
      select 'dm_reaction'::text, null::uuid, d.id, r.user_id, r.created_at,
             left(d.body_text, 140), d.conversation_id, null::uuid, null::text, null::uuid
      from public.dm_message_reactions r
      join public.dm_messages d on d.id = r.message_id
      join public.conversations cv on cv.id = d.conversation_id
      where cv.workspace_id = p_workspace and d.author_id = v_uid
        and d.deleted_at is null and r.user_id <> v_uid
        and (select private.is_conversation_member(d.conversation_id))
      order by r.created_at desc limit v_lim
    )
    union all
    -- (f) work somebody handed you
    (
      select 'task'::text, t.channel_id, t.message_id,
             coalesce(t.assigned_by, t.created_by), t.created_at,
             left(t.title, 140), null::uuid, t.id, t.title, null::uuid
      from public.tasks t
      where t.workspace_id = p_workspace
        and t.assignee_id = v_uid
        and t.done_at is null
        and t.state not in ('proposed', 'rejected', 'cancelled')
        and coalesce(t.assigned_by, t.created_by) is distinct from v_uid
        and (select private.can_view_channel(t.channel_id))
      order by t.created_at desc limit v_lim
    )
    union all
    -- (g) leave waiting on YOU to decide. Org admins only: the subquery returns
    --     nothing for anybody else, so this arm costs a membership check.
    (
      select 'leave_request'::text, null::uuid, null::uuid, a.user_id, a.created_at,
             left(coalesce(a.note, ''), 140), null::uuid, null::uuid,
             a.kind || ' ' || a.starts_on::text
               || case when a.ends_on > a.starts_on then ' to ' || a.ends_on::text else '' end,
             a.id
      from public.away_days a
      where v_org is not null and a.org_id = v_org and a.status = 'pending'
        and a.user_id <> v_uid
        and (select private.is_org_admin(v_org))
      order by a.created_at desc limit v_lim
    )
    union all
    -- (h) a decision on YOUR leave. Only somebody else's decision: approving
    --     your own would be telling yourself what you just did.
    (
      select 'leave_decision'::text, null::uuid, null::uuid, a.decided_by, a.decided_at,
             left(coalesce(a.decision_note, ''), 140), null::uuid, null::uuid,
             a.status || ' ' || a.kind || ' ' || a.starts_on::text
               || case when a.ends_on > a.starts_on then ' to ' || a.ends_on::text else '' end,
             a.id
      from public.away_days a
      where v_org is not null and a.org_id = v_org and a.user_id = v_uid
        and a.status in ('approved', 'rejected')
        and a.decided_by is not null and a.decided_by <> v_uid
        and a.decided_at is not null
      order by a.decided_at desc limit v_lim
    )
  ),
  keyed as (
    select f.*,
           f.kind || ':' || coalesce(f.message_id::text, f.task_id::text, f.ref_id::text, '')
                  || ':' || coalesce(f.actor_id::text, '') as item_key
      from feed f
  )
  select k.kind, k.channel_id, k.message_id, k.actor_id, k.created_at, k.snippet,
         k.conversation_id, k.item_key, (ar.item_key is not null) as is_read,
         k.task_id, k.title, k.ref_id
    from keyed k
    left join public.activity_reads ar
      on ar.user_id = v_uid and ar.item_key = k.item_key
   where case v_f
           when 'unread'   then ar.item_key is null
           when 'all'      then true
           when 'mentions' then k.kind in ('mention', 'dm_mention')
           when 'dms'      then k.kind in ('dm', 'dm_mention', 'dm_reaction')
           when 'tasks'    then k.kind in ('task', 'leave_request')
           when 'replies'  then k.kind in ('reaction', 'thread_reply', 'dm_reaction')
           else true
         end
   order by k.created_at desc
   limit v_lim;
end;
$function$;

grant execute on function public.get_activity(uuid, integer, text) to authenticated;

-- ============================================================================
-- 5. The team, in one read
-- ============================================================================
--
-- The Team tab asked leave_balance once per person, which is fifty round trips
-- for a fifty-person organisation and about five seconds of an admin staring at
-- "Loading". Everything it needs is the same two aggregates over one table, so
-- it is one query that groups instead.
create or replace function public.leave_team(p_org uuid, p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Kolkata')::date))::date;
  v_pol   public.leave_policies;
  v_out   jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_admin(p_org) then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only an organisation admin can see everybody''s leave.';
  end if;
  v_pol := private.leave_policy_eff(p_org);

  select jsonb_build_object(
    'month', to_char(v_month, 'YYYY-MM'),
    'allowance', v_pol.auto_approve_per_month,
    'people', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.used desc, x.tenure_days desc)
        from (
          select om.user_id,
                 -- Days inside the month being asked about, approved only.
                 coalesce((
                   select count(*)::int
                     from public.away_days a
                    cross join lateral generate_series(a.starts_on, a.ends_on, interval '1 day') d
                    where a.org_id = p_org and a.user_id = om.user_id
                      and a.status = 'approved' and a.kind = any(v_pol.quota_kinds)
                      and date_trunc('month', d)::date = v_month), 0) as used,
                 coalesce((
                   select sum(a.days)::int from public.away_days a
                    where a.org_id = p_org and a.user_id = om.user_id
                      and a.status = 'approved' and a.kind = any(v_pol.quota_kinds)), 0) as tenure_days,
                 coalesce((
                   select count(*)::int from public.away_days a
                    where a.org_id = p_org and a.user_id = om.user_id
                      and a.status = 'approved'), 0) as tenure_requests,
                 coalesce((
                   select sum(a.days)::int from public.away_days a
                    where a.org_id = p_org and a.user_id = om.user_id
                      and a.status = 'pending'), 0) as pending_days,
                 coalesce((
                   select count(*)::int from public.away_days a
                    where a.org_id = p_org and a.user_id = om.user_id and a.flagged), 0) as flags,
                 -- Out right now, so the tab doubles as today's picture.
                 exists (
                   select 1 from public.away_days a
                    where a.org_id = p_org and a.user_id = om.user_id and a.status = 'approved'
                      and (now() at time zone 'Asia/Kolkata')::date between a.starts_on and a.ends_on
                 ) as away_today
            from public.org_members om
           where om.org_id = p_org) x), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$fn$;
grant execute on function public.leave_team(uuid, date) to authenticated;

-- ============================================================================
-- 6. What the push actually says
-- ============================================================================
--
-- app.notification_content falls through to "You have a new notification" for
-- any kind it does not know, which is honest but useless: the whole reason an
-- approver is pushed at all is so they know somebody is waiting and roughly
-- what for. Two branches, inserted ahead of that fallback, and a url that lands
-- on the panel - #/leave is the route js/main.js gained alongside this.
create or replace function app.notification_content(p_msg jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_kind text := coalesce(p_msg->'payload'->>'kind', 'message');
  v_mid  uuid := nullif(p_msg->'payload'->>'message_id', '')::uuid;
  v_cid  uuid := nullif(p_msg->'payload'->>'channel_id', '')::uuid;
  v_conv uuid := nullif(p_msg->'payload'->>'conversation_id', '')::uuid;
  v_who  text;
  v_txt  text;
  v_name text;
  v_from date;
  v_to   date;
  v_span text;
begin
  if v_kind = 'dm' then
    select coalesce(p.display_name, p.username::text, 'Someone'),
           left(coalesce(nullif(btrim(d.body_text), ''),
                         case when jsonb_array_length(coalesce(d.attachments, '[]'::jsonb)) > 0
                              then 'Sent an attachment' else 'Sent a message' end), 140)
      into v_who, v_txt
      from public.dm_messages d
      left join public.profiles p on p.id = d.author_id
     where d.id = v_mid and d.deleted_at is null;
    if v_who is null then return null; end if;
    return jsonb_build_object(
      'title', v_who,
      'body',  v_txt,
      'url',   './#/d/' || coalesce(v_conv::text, ''),
      'tag',   'dm:' || coalesce(v_conv::text, v_mid::text));
  end if;

  -- ---- leave (0131) -------------------------------------------------------
  if v_kind in ('leave_request', 'leave_decision') then
    v_from := nullif(p_msg->'payload'->>'starts_on', '')::date;
    v_to   := nullif(p_msg->'payload'->>'ends_on', '')::date;
    v_span := case
      when v_from is null then 'some dates'
      when v_to is null or v_to = v_from then to_char(v_from, 'FMDD Mon')
      else to_char(v_from, 'FMDD Mon') || ' to ' || to_char(v_to, 'FMDD Mon')
           || ' (' || ((v_to - v_from) + 1)::text || ' days)' end;

    if v_kind = 'leave_request' then
      select coalesce(p.display_name, p.username::text, 'Somebody')
        into v_who from public.profiles p
       where p.id = nullif(p_msg->'payload'->>'user_id', '')::uuid;
      return jsonb_build_object(
        'title', coalesce(v_who, 'Somebody') || ' is asking for time off',
        'body',  initcap(coalesce(p_msg->'payload'->>'leave_kind', 'leave')) || ', ' || v_span
                 || case when (p_msg->'payload'->>'flagged')::boolean
                         then ' - raised for your attention' else '' end,
        'url',   './#/leave',
        -- One tag per request, so two requests are two notifications rather
        -- than the second quietly replacing the first.
        'tag',   'leave:' || coalesce(p_msg->'payload'->>'leave_id', 'x'));
    end if;

    return jsonb_build_object(
      'title', case when p_msg->'payload'->>'status' = 'approved'
                    then 'Your time off was approved'
                    else 'Your time off was not approved' end,
      'body',  initcap(coalesce(p_msg->'payload'->>'leave_kind', 'leave')) || ', ' || v_span,
      'url',   './#/leave',
      'tag',   'leave:' || coalesce(p_msg->'payload'->>'leave_id', 'x'));
  end if;

  if v_kind in ('message', 'broadcast') or v_mid is not null then
    select coalesce(p.display_name, p.username::text, 'Someone'),
           left(coalesce(nullif(btrim(m.body_text), ''),
                         case when jsonb_array_length(coalesce(m.attachments, '[]'::jsonb)) > 0
                              then 'Sent an attachment' else 'Sent a message' end), 140),
           c.name::text
      into v_who, v_txt, v_name
      from public.messages m
      left join public.profiles p on p.id = m.author_id
      left join public.channels c on c.id = m.channel_id
     where m.id = v_mid and m.deleted_at is null;
    if v_who is null then return null; end if;
    return jsonb_build_object(
      'title', case when v_name is null then v_who else v_who || ' in #' || v_name end,
      'body',  v_txt,
      'url',   './#/c/' || coalesce(v_cid::text, ''),
      'tag',   'ch:' || coalesce(v_cid::text, v_mid::text));
  end if;

  return jsonb_build_object(
    'title', 'Dek',
    'body',  case v_kind
               when 'task_assigned' then 'A task was assigned to you'
               when 'task_due'      then 'A task is due'
               when 'call'          then 'Somebody is calling you'
               else 'You have a new notification' end,
    'url',   './',
    'tag',   v_kind);
end;
$fn$;
