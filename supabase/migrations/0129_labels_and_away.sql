-- 0129_labels_and_away.sql
--
-- Two requests from the people running this:
--
--   "Message Labels - add labels such as Important, High Priority, Pending and
--    Task."
--   "Leave Status - show who is on leave today in a visible side section,
--    similar to Microsoft Teams."
--
-- ============================================================================
-- 1. Labels on a message
-- ============================================================================
--
-- Why a table rather than a column. `messages.priority` already exists and is
-- exactly two values, normal and urgent, and it is load-bearing: the ack loop in
-- js/features/messageExtras.js reads it as its ONLY signal for "this one needs a
-- reply", so widening it would quietly change which messages nag people.
-- `messages.topic` is a single free-text value that organises a channel by
-- subject and is a different idea again. So: a new table, and a message can
-- carry more than one label, because Important and Pending are both true of the
-- same message often enough that forcing a choice would be the wrong model.
--
-- TASK IS DELIBERATELY NOT A LABEL. It was asked for in the same list, and this
-- app already has tasks - a real row with an assignee, a due date, a state
-- machine, a place in Later and a notification. A label spelled "task" would be
-- a second, weaker task system sitting next to the real one, and the first time
-- somebody labelled a message Task and it did not appear in Later, the feature
-- would have lied to them. The client offers Task in the same menu and routes it
-- to create_task, so the person gets what they asked for and there is one
-- answer to "what work exists".
create table if not exists public.message_labels (
  message_id   uuid not null references public.messages(id) on delete cascade,
  label        text not null check (label in ('important', 'high', 'pending', 'blocked', 'fyi')),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  set_by       uuid references auth.users(id) on delete set null,
  set_at       timestamptz not null default now(),
  primary key (message_id, label)
);
create index if not exists message_labels_msg_idx on public.message_labels (message_id);
-- The query the filter view runs: every labelled message in a Space, newest
-- first. Without this it is a sequential scan over every label ever set.
create index if not exists message_labels_ws_idx
  on public.message_labels (workspace_id, label, set_at desc);

alter table public.message_labels enable row level security;
drop policy if exists message_labels_select on public.message_labels;
-- Readable by anybody who can read the message it is on, which is the same
-- predicate messages_select uses. Writes go through the RPC below.
create policy message_labels_select on public.message_labels
  for select to authenticated
  using ((select private.can_view_channel(
    (select m.channel_id from public.messages m where m.id = message_id))));
grant select on public.message_labels to authenticated;

-- Toggle one label on one message.
--
-- Anybody who can SEND in the channel may label. Deliberately not restricted to
-- the author or to a moderator: a label is how a coordinator triages somebody
-- else's message, which is the entire point of asking for them, and the audit of
-- who set what is in set_by.
create or replace function public.toggle_message_label(p_message uuid, p_label text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_ch    uuid;
  v_ws    uuid;
  v_added boolean;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_label not in ('important', 'high', 'pending', 'blocked', 'fyi') then
    raise exception 'invalid_label' using errcode = '22023';
  end if;
  select m.channel_id, m.workspace_id into v_ch, v_ws
    from public.messages m where m.id = p_message and m.deleted_at is null;
  if v_ch is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.can_view_channel(v_ch) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.has_channel_perm(v_ch, 1) then raise exception 'forbidden' using errcode = '42501'; end if;

  delete from public.message_labels
   where message_id = p_message and label = p_label;
  if found then
    v_added := false;
  else
    insert into public.message_labels(message_id, label, workspace_id, set_by)
    values (p_message, p_label, v_ws, v_uid)
    on conflict do nothing;
    v_added := true;
  end if;

  -- The same topic every message delivery already rides, with an event name the
  -- client can bind next to the reaction handler it already has.
  perform app.emit('ch:'||v_ch::text, 'label',
    jsonb_build_object('message_id', p_message, 'label', p_label,
                       'added', v_added, 'by', v_uid));
  return v_added;
end;
$fn$;

grant execute on function public.toggle_message_label(uuid, text) to authenticated;

-- Everything labelled in this Space, for the filter view. Bounded and newest
-- first; a label nobody has used costs nothing here.
create or replace function public.list_labelled(p_workspace uuid, p_label text default null, p_limit int default 60)
returns table(message_id uuid, label text, channel_id uuid, channel_name text,
              author_id uuid, body_text text, created_at timestamptz,
              set_by uuid, set_at timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_lim int := least(greatest(coalesce(p_limit, 60), 1), 200);
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select l.message_id, l.label, m.channel_id, c.name::text, m.author_id,
         left(m.body_text, 200), m.created_at, l.set_by, l.set_at
    from public.message_labels l
    join public.messages m on m.id = l.message_id and m.deleted_at is null
    join public.channels c on c.id = m.channel_id
   where l.workspace_id = p_workspace
     and (p_label is null or l.label = p_label)
     and (select private.can_view_channel(m.channel_id))
   order by l.set_at desc
   limit v_lim;
end;
$fn$;

grant execute on function public.list_labelled(uuid, text, int) to authenticated;

-- ============================================================================
-- 2. Who is away
-- ============================================================================
--
-- profiles already carries status_text, status_emoji and status_expires_at, and
-- somebody CAN type "on leave" into it. That is not the same thing: free text
-- cannot be aggregated, so the question the request is actually asking - "who is
-- out today" - has no answer, and a side section cannot be built on a sentence.
--
-- Scoped to the ORGANISATION, not the Space. You are away from the
-- organisation, not from one channel, and a coordinator who is in four Spaces
-- should say it once. The listing below is per Space only because that is where
-- the panel lives: it asks which MEMBERS OF THIS SPACE are away, which is the
-- useful shape and leaks nothing about an org member you do not share a Space
-- with.
create table if not exists public.away_days (
  id         uuid primary key default util.uuidv7(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  starts_on  date not null,
  ends_on    date not null,
  kind       text not null default 'leave'
             check (kind in ('leave', 'sick', 'holiday', 'travel', 'wfh')),
  note       text,
  created_at timestamptz not null default now(),
  constraint away_days_order check (ends_on >= starts_on)
);
-- The only query that matters: who in this org is away on a given date.
create index if not exists away_days_org_span_idx
  on public.away_days (org_id, starts_on, ends_on);
create index if not exists away_days_user_idx on public.away_days (user_id, starts_on desc);

alter table public.away_days enable row level security;
drop policy if exists away_days_select on public.away_days;
-- Anybody in the organisation may see who is away. That is the point of it: a
-- calendar nobody can read is a diary.
create policy away_days_select on public.away_days
  for select to authenticated
  using ((select private.is_org_member(org_id)));
grant select on public.away_days to authenticated;

-- Book time off. Your own, or somebody else's if you run the organisation -
-- an HR lead entering approved leave for a volunteer without a laptop is the
-- ordinary case here, not the exception.
create or replace function public.set_away(
  p_org   uuid,
  p_from  date,
  p_to    date,
  p_kind  text default 'leave',
  p_note  text default null,
  p_user  uuid default null)
returns public.away_days language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_for  uuid := coalesce(p_user, (select auth.uid()));
  v_row  public.away_days;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_for <> v_uid and not private.is_org_admin(p_org) then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only an organisation admin can book time off for somebody else.';
  end if;
  if not exists (select 1 from public.org_members om
                  where om.org_id = p_org and om.user_id = v_for) then
    raise exception 'not_a_member' using errcode = '22023';
  end if;
  if p_from is null or p_to is null then raise exception 'dates_required' using errcode = '22023'; end if;
  if p_to < p_from then raise exception 'ends_before_it_starts' using errcode = '22023'; end if;
  -- A year is a generous upper bound for one entry and a cheap guard against a
  -- mistyped year turning into a row that shadows the panel forever.
  if p_to - p_from > 366 then raise exception 'too_long' using errcode = '22023'; end if;
  if p_kind is null or p_kind not in ('leave', 'sick', 'holiday', 'travel', 'wfh') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;

  insert into public.away_days(org_id, user_id, starts_on, ends_on, kind, note)
  values (p_org, v_for, p_from, p_to, p_kind, nullif(btrim(coalesce(p_note, '')), ''))
  returning * into v_row;
  return v_row;
end;
$fn$;

grant execute on function public.set_away(uuid, date, date, text, text, uuid) to authenticated;

create or replace function public.clear_away(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_row public.away_days;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_row from public.away_days where id = p_id;
  if not found then return; end if;                       -- idempotent
  if v_row.user_id <> v_uid and not private.is_org_admin(v_row.org_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.away_days where id = p_id;
end;
$fn$;

grant execute on function public.clear_away(uuid) to authenticated;

-- The side section. Members of THIS Space who are away on a given day, plus the
-- caller's own upcoming entries so the panel can offer to cancel one.
--
-- "Today" is Asia/Kolkata rather than the server's UTC. A volunteer in Mumbai
-- opening this at 01:00 IST is still on the 13th, and a panel that says
-- somebody is back when they are not is worse than no panel.
create or replace function public.who_is_away(p_workspace uuid, p_on date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
  v_day date := coalesce(p_on, (now() at time zone 'Asia/Kolkata')::date);
  v_out jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_member(p_workspace) then raise exception 'forbidden' using errcode = '42501'; end if;
  select w.org_id into v_org from public.workspaces w where w.id = p_workspace;
  if v_org is null then return jsonb_build_object('day', v_day, 'away', '[]'::jsonb, 'mine', '[]'::jsonb); end if;

  select jsonb_build_object(
    'day', v_day,
    'away', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', a.user_id, 'kind', a.kind, 'note', a.note,
               'starts_on', a.starts_on, 'ends_on', a.ends_on,
               -- "back Monday" is the thing somebody actually wants to know.
               'back_on', a.ends_on + 1)
             order by a.ends_on, a.user_id)
        from public.away_days a
        join public.workspace_members wm
          on wm.workspace_id = p_workspace and wm.user_id = a.user_id
       where a.org_id = v_org
         and v_day between a.starts_on and a.ends_on), '[]'::jsonb),
    'mine', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'kind', a.kind, 'note', a.note,
               'starts_on', a.starts_on, 'ends_on', a.ends_on)
             order by a.starts_on)
        from public.away_days a
       where a.org_id = v_org and a.user_id = v_uid and a.ends_on >= v_day), '[]'::jsonb))
    into v_out;
  return v_out;
end;
$fn$;

grant execute on function public.who_is_away(uuid, date) to authenticated;
