-- 0130_leave_management.sql
--
-- Leave stops being a display and becomes a system.
--
-- 0129 shipped away_days as "who is out today", which is half of it. What was
-- actually asked for, verbatim:
--
--   "It has to be two way. Anyone who's applying leave has to apply from this
--    dashboard only, because we need to maintain how many total number of
--    leaves any specific person had raised during their tenure here."
--
--   "If I'm going on a vacation for four days I'm not going to mark every
--    single day. Since it was planned I predefined it in a leave form, and my
--    status will auto update because of that. Even if I just put my status as
--    leave, it's as if I auto applied for it."
--
--   "Two leaves are auto approved every month... let organisations set custom
--    policies. Ours is two leaves. For exams they can take up to fifteen days
--    at a stretch but they have to show it to the coordinating team, so they
--    approve it. Any other leave is also approval. Any emergency no-shows
--    should be mentioned like that and those are flag-worthy."
--
-- So there are five things here and they are all one table:
--
--   1. AN APPLICATION, not a mark. One row covers a range, because a four-day
--      vacation is one decision and nobody is going to file four of anything.
--   2. A LEDGER. Rows are never deleted once decided - cancelling sets a
--      status - because "how many leaves during their tenure" is a question you
--      can only answer if the history survives the person changing their mind.
--   3. A POLICY, per organisation. Two auto-approved days a month is Jarurat
--      Care's number, not a law of nature, and the other organisation on this
--      deployment will want its own.
--   4. AN APPROVAL for everything the policy does not wave through, which is
--      where exams live: fifteen days at a stretch, never automatic.
--   5. A FLAG. A no-show is not a leave and must not be laundered into one by
--      being filed as one after the fact.
--
-- ============================================================================
-- 1. The policy
-- ============================================================================
--
-- One row per organisation, created on demand with the defaults below. The
-- defaults ARE Jarurat Care's stated policy, so an org that never opens the
-- settings page still behaves the way the person who asked for this expects.
create table if not exists public.leave_policies (
  org_id                 uuid primary key references public.organizations(id) on delete cascade,
  -- Days, not requests. "Two leaves a month" means two days off, and counting
  -- requests instead would make a four-day vacation cheaper than two Mondays.
  auto_approve_per_month int  not null default 2 check (auto_approve_per_month between 0 and 31),
  -- The longest single application anybody may file. Exams are the reason this
  -- is fifteen rather than five.
  max_stretch_days       int  not null default 15 check (max_stretch_days between 1 and 366),
  -- Kinds that spend the monthly allowance. Everything here is auto-approved
  -- while the allowance lasts and needs a decision once it runs out.
  quota_kinds            text[] not null default array['leave', 'sick', 'holiday'],
  -- Kinds that are not leave at all: no approval, no allowance spent. You are
  -- working, you are just not in the usual place.
  free_kinds             text[] not null default array['wfh', 'travel'],
  -- Kinds that always need a decision however much allowance is left.
  approval_kinds         text[] not null default array['exam'],
  -- Kinds that are recorded as an absence AND raised. Not a punishment: a
  -- no-show that nobody can see is the thing that actually costs the team.
  flag_kinds             text[] not null default array['emergency'],
  -- Filing an absence that already started is the other flag. Somebody sick
  -- this morning writing it up this afternoon is ordinary and is NOT caught by
  -- this: only a start date that is already in the past when the row is filed.
  flag_backdated         boolean not null default true,
  note                   text,             -- shown on the application form
  updated_by             uuid references auth.users(id) on delete set null,
  updated_at             timestamptz not null default now()
);

alter table public.leave_policies enable row level security;
drop policy if exists leave_policies_select on public.leave_policies;
-- Everyone in the org may read the rules they are being held to.
create policy leave_policies_select on public.leave_policies
  for select to authenticated
  using ((select private.is_org_member(org_id)));
grant select on public.leave_policies to authenticated;

-- Read-with-defaults. Never returns null, so no caller has to carry a second
-- code path for "this org has not configured anything yet".
create or replace function public.get_leave_policy(p_org uuid)
returns public.leave_policies language plpgsql stable security definer set search_path = '' as $fn$
declare v_row public.leave_policies;
begin
  if (select auth.uid()) is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.leave_policies where org_id = p_org;
  if found then return v_row; end if;
  -- The defaults, materialised but not persisted: writing here would need the
  -- caller to be an admin and a member opening the form is not one.
  v_row.org_id := p_org;
  v_row.auto_approve_per_month := 2;
  v_row.max_stretch_days := 15;
  v_row.quota_kinds := array['leave', 'sick', 'holiday'];
  v_row.free_kinds := array['wfh', 'travel'];
  v_row.approval_kinds := array['exam'];
  v_row.flag_kinds := array['emergency'];
  v_row.flag_backdated := true;
  v_row.updated_at := now();
  return v_row;
end;
$fn$;
grant execute on function public.get_leave_policy(uuid) to authenticated;

create or replace function public.set_leave_policy(
  p_org uuid,
  p_auto_per_month int    default null,
  p_max_stretch    int    default null,
  p_quota_kinds    text[] default null,
  p_free_kinds     text[] default null,
  p_approval_kinds text[] default null,
  p_flag_kinds     text[] default null,
  p_flag_backdated boolean default null,
  p_note           text   default null)
returns public.leave_policies language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_cur public.leave_policies;
  v_row public.leave_policies;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_admin(p_org) then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only an organisation admin can change the leave policy.';
  end if;
  v_cur := public.get_leave_policy(p_org);

  insert into public.leave_policies(org_id, auto_approve_per_month, max_stretch_days,
    quota_kinds, free_kinds, approval_kinds, flag_kinds, flag_backdated, note, updated_by, updated_at)
  values (p_org,
    coalesce(p_auto_per_month, v_cur.auto_approve_per_month),
    coalesce(p_max_stretch,    v_cur.max_stretch_days),
    coalesce(p_quota_kinds,    v_cur.quota_kinds),
    coalesce(p_free_kinds,     v_cur.free_kinds),
    coalesce(p_approval_kinds, v_cur.approval_kinds),
    coalesce(p_flag_kinds,     v_cur.flag_kinds),
    coalesce(p_flag_backdated, v_cur.flag_backdated),
    coalesce(p_note,           v_cur.note),
    v_uid, now())
  on conflict (org_id) do update set
    auto_approve_per_month = excluded.auto_approve_per_month,
    max_stretch_days       = excluded.max_stretch_days,
    quota_kinds            = excluded.quota_kinds,
    free_kinds             = excluded.free_kinds,
    approval_kinds         = excluded.approval_kinds,
    flag_kinds             = excluded.flag_kinds,
    flag_backdated         = excluded.flag_backdated,
    note                   = excluded.note,
    updated_by             = excluded.updated_by,
    updated_at             = excluded.updated_at
  returning * into v_row;
  return v_row;
end;
$fn$;
grant execute on function public.set_leave_policy(uuid, int, int, text[], text[], text[], text[], boolean, text) to authenticated;

-- ============================================================================
-- 2. The application
-- ============================================================================
--
-- away_days from 0129 becomes the application table rather than a second one
-- next to it. Two tables holding "when is this person out" would disagree
-- within a week, and the display side already reads this one.
alter table public.away_days
  add column if not exists status        text    not null default 'approved',
  add column if not exists auto_approved boolean not null default false,
  add column if not exists decided_by    uuid    references auth.users(id) on delete set null,
  add column if not exists decided_at    timestamptz,
  add column if not exists decision_note text,
  add column if not exists flagged       boolean not null default false,
  add column if not exists flag_reason   text,
  add column if not exists filed_by      uuid    references auth.users(id) on delete set null;

do $$ begin
  alter table public.away_days
    add constraint away_days_status_ck check (status in ('pending', 'approved', 'rejected', 'cancelled'));
exception when duplicate_object then null; end $$;

-- The seven kinds. 0129 shipped five; exam and emergency are the two the policy
-- above needs in order to mean anything.
do $$ begin
  alter table public.away_days drop constraint if exists away_days_kind_check;
  alter table public.away_days
    add constraint away_days_kind_check
    check (kind in ('leave', 'sick', 'holiday', 'travel', 'wfh', 'exam', 'emergency'));
exception when duplicate_object then null; end $$;

-- Days is a property of the dates, so it is never stored out of step with them.
do $$ begin
  alter table public.away_days
    add column days int generated always as ((ends_on - starts_on) + 1) stored;
exception when duplicate_column then null; end $$;

-- The two queries this table now serves: an approver's inbox, and one person's
-- ledger over their whole tenure.
create index if not exists away_days_pending_idx
  on public.away_days (org_id, status, starts_on) where status = 'pending';
create index if not exists away_days_ledger_idx
  on public.away_days (org_id, user_id, starts_on desc);
create index if not exists away_days_flagged_idx
  on public.away_days (org_id, starts_on desc) where flagged;

-- ============================================================================
-- 3. Counting, which is the whole point of a ledger
-- ============================================================================
--
-- Per DAY, not per request, and charged to the month the day actually falls in.
-- A request from 29 September to 3 October is two September days and three
-- October ones, and rounding that to "the month it started in" is exactly the
-- sort of quiet wrongness that makes people stop trusting a number.
-- get_leave_policy is SECURITY DEFINER and checks membership, which is right for
-- a caller but wrong inside a counting helper whose caller has already been
-- checked. This is the same defaults without the check, and it lives in private
-- because nothing outside this file has any business calling it.
--
-- Defined BEFORE the counting function below: an SQL-language body is parsed
-- when it is created, so a forward reference here is a migration that fails.
create or replace function private.leave_policy_eff(p_org uuid)
returns public.leave_policies language sql stable security definer set search_path = '' as $fn$
  select coalesce(
    (select p from public.leave_policies p where p.org_id = p_org),
    row(p_org, 2, 15,
        array['leave', 'sick', 'holiday'], array['wfh', 'travel'],
        array['exam'], array['emergency'], true, null, null, now())::public.leave_policies);
$fn$;

create or replace function private.leave_days_in_month(
  p_org uuid, p_user uuid, p_month date, p_exclude uuid default null)
returns int language sql stable security definer set search_path = '' as $fn$
  select coalesce(count(*)::int, 0)
    from public.away_days a
    join private.leave_policy_eff(p_org) pol on true
   cross join lateral generate_series(a.starts_on, a.ends_on, interval '1 day') d
   where a.org_id = p_org
     and a.user_id = p_user
     and a.status = 'approved'
     and a.kind = any(pol.quota_kinds)
     and (p_exclude is null or a.id <> p_exclude)
     and date_trunc('month', d)::date = date_trunc('month', p_month)::date;
$fn$;

-- The balance somebody sees before they file: what they have left this month,
-- what is still waiting on a decision, and the tenure total the request asked
-- for by name.
create or replace function public.leave_balance(
  p_org uuid, p_user uuid default null, p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_for   uuid := coalesce(p_user, (select auth.uid()));
  v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Kolkata')::date))::date;
  v_pol   public.leave_policies;
  v_used  int;
  v_out   jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  -- Your own balance, or anybody's if you run the organisation. A coordinator
  -- deciding on a request has to be able to see what it is being spent against.
  if v_for <> v_uid and not private.is_org_admin(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_pol  := private.leave_policy_eff(p_org);
  v_used := private.leave_days_in_month(p_org, v_for, v_month);

  select jsonb_build_object(
    'user_id', v_for,
    'month', to_char(v_month, 'YYYY-MM'),
    'allowance', v_pol.auto_approve_per_month,
    'used', v_used,
    'remaining', greatest(v_pol.auto_approve_per_month - v_used, 0),
    'max_stretch_days', v_pol.max_stretch_days,
    'quota_kinds', to_jsonb(v_pol.quota_kinds),
    'free_kinds', to_jsonb(v_pol.free_kinds),
    'approval_kinds', to_jsonb(v_pol.approval_kinds),
    'policy_note', v_pol.note,
    'pending_days', coalesce((
      select sum(a.days)::int from public.away_days a
       where a.org_id = p_org and a.user_id = v_for and a.status = 'pending'), 0),
    'pending_requests', coalesce((
      select count(*)::int from public.away_days a
       where a.org_id = p_org and a.user_id = v_for and a.status = 'pending'), 0),
    -- "How many total leaves during their tenure here", which is the sentence
    -- that started all of this.
    'tenure_days', coalesce((
      select sum(a.days)::int from public.away_days a
       where a.org_id = p_org and a.user_id = v_for and a.status = 'approved'
         and a.kind = any(v_pol.quota_kinds)), 0),
    'tenure_requests', coalesce((
      select count(*)::int from public.away_days a
       where a.org_id = p_org and a.user_id = v_for and a.status = 'approved'), 0),
    'flags', coalesce((
      select count(*)::int from public.away_days a
       where a.org_id = p_org and a.user_id = v_for and a.flagged), 0),
    'by_kind', coalesce((
      select jsonb_object_agg(k.kind, k.n) from (
        select a.kind, sum(a.days)::int as n from public.away_days a
         where a.org_id = p_org and a.user_id = v_for and a.status = 'approved'
         group by a.kind) k), '{}'::jsonb))
    into v_out;
  return v_out;
end;
$fn$;
grant execute on function public.leave_balance(uuid, uuid, date) to authenticated;

-- ============================================================================
-- 4. Applying
-- ============================================================================
--
-- Returns the row plus a verdict the form can read out loud, because "filed"
-- and "approved" are different outcomes and a screen that says neither is how
-- somebody ends up believing they have leave they do not have.
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
  -- Two overlapping applications for the same person is a double count in every
  -- number this file produces, so it is refused rather than reconciled later.
  if exists (select 1 from public.away_days a
              where a.org_id = p_org and a.user_id = v_for
                and a.status in ('pending', 'approved')
                and a.starts_on <= p_to and a.ends_on >= p_from) then
    raise exception 'overlaps' using errcode = '22023',
      hint = 'You already have time off booked across those dates.';
  end if;

  -- ---- the decision -------------------------------------------------------
  if p_kind = any(v_pol.free_kinds) then
    -- Not leave. Working from home is not a day off and must not spend one.
    v_status := 'approved'; v_auto := true;
  elsif p_kind = any(v_pol.approval_kinds) then
    -- Exams. Never automatic, however much allowance is left.
    v_status := 'pending';
  elsif p_kind = any(v_pol.quota_kinds) then
    -- Month by month, because a request can straddle two of them and the
    -- allowance is monthly.
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

  -- ---- the flag -----------------------------------------------------------
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

-- 0129's set_away, kept so nothing that already calls it breaks, now routed
-- through the policy instead of writing straight to the table.
create or replace function public.set_away(
  p_org uuid, p_from date, p_to date, p_kind text default 'leave',
  p_note text default null, p_user uuid default null)
returns public.away_days language plpgsql security definer set search_path = '' as $fn$
declare v_res jsonb; v_row public.away_days;
begin
  v_res := public.apply_leave(p_org, p_from, p_to, p_kind, p_note, p_user);
  select * into v_row from public.away_days where id = (v_res->>'id')::uuid;
  return v_row;
end;
$fn$;
grant execute on function public.set_away(uuid, date, date, text, text, uuid) to authenticated;

-- ============================================================================
-- 5. Deciding
-- ============================================================================
create or replace function public.decide_leave(
  p_id uuid, p_approve boolean, p_note text default null)
returns public.away_days language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_row public.away_days;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_row from public.away_days where id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if not private.is_org_admin(v_row.org_id) then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only an organisation admin can approve or refuse leave.';
  end if;
  -- Deliberately allowed on an already-decided row: a coordinator who approved
  -- the wrong one needs a way back that is not deleting the ledger entry.
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
  return v_row;
end;
$fn$;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;

-- Raising or clearing a flag by hand, with a reason. An org admin only: the
-- point of a flag is that the person it is about cannot quietly remove it.
create or replace function public.flag_leave(p_id uuid, p_on boolean, p_reason text default null)
returns public.away_days language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_row public.away_days;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_row from public.away_days where id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if not private.is_org_admin(v_row.org_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.away_days
     set flagged = coalesce(p_on, true),
         flag_reason = case when coalesce(p_on, true)
                            then coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Raised by a coordinator')
                            else null end
   where id = p_id returning * into v_row;
  return v_row;
end;
$fn$;
grant execute on function public.flag_leave(uuid, boolean, text) to authenticated;

-- Cancelling KEEPS THE ROW. 0129's clear_away deleted it, which is fine for a
-- status and wrong for a ledger: a person who books and cancels four times is a
-- pattern worth being able to see, and a deleted row cannot be seen.
create or replace function public.cancel_leave(p_id uuid, p_reason text default null)
returns public.away_days language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_row   public.away_days;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into v_row from public.away_days where id = p_id;
  if not found then return null; end if;                   -- idempotent
  if v_row.user_id <> v_uid and not private.is_org_admin(v_row.org_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Time that has already been taken cannot be un-taken by the person who took
  -- it. An admin may still do it, because correcting a mis-filed row is a real
  -- job; anybody else gets told to talk to one.
  if v_row.ends_on < v_today and not private.is_org_admin(v_row.org_id) then
    raise exception 'already_taken' using errcode = '22023',
      hint = 'That time off is in the past. Ask a coordinator to correct it.';
  end if;
  update public.away_days
     set status = 'cancelled',
         decided_by = v_uid, decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id returning * into v_row;
  return v_row;
end;
$fn$;
grant execute on function public.cancel_leave(uuid, text) to authenticated;

-- 0129's name, kept working, now cancelling rather than deleting.
create or replace function public.clear_away(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  perform public.cancel_leave(p_id, null);
end;
$fn$;
grant execute on function public.clear_away(uuid) to authenticated;

-- ============================================================================
-- 6. The lists
-- ============================================================================
--
-- One function for both audiences, because they are the same question asked
-- from two chairs: an ordinary member sees their own ledger, an org admin sees
-- everybody's and can filter it down to the inbox of things awaiting them.
create or replace function public.list_leave(
  p_org    uuid,
  p_status text default null,          -- null = every status
  p_user   uuid default null,          -- null = me, or everybody for an admin
  p_from   date default null,
  p_limit  int  default 100)
returns table(id uuid, user_id uuid, kind text, status text, starts_on date, ends_on date,
              days int, note text, flagged boolean, flag_reason text,
              auto_approved boolean, decided_by uuid, decided_at timestamptz,
              decision_note text, filed_by uuid, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_admin boolean;
  v_lim   int := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_admin := private.is_org_admin(p_org);
  if p_user is not null and p_user <> v_uid and not v_admin then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select a.id, a.user_id, a.kind, a.status, a.starts_on, a.ends_on, a.days, a.note,
         a.flagged, a.flag_reason, a.auto_approved, a.decided_by, a.decided_at,
         a.decision_note, a.filed_by, a.created_at
    from public.away_days a
   where a.org_id = p_org
     and (case when v_admin then coalesce(p_user, a.user_id) else v_uid end) = a.user_id
     and (p_status is null or a.status = p_status)
     and (p_from is null or a.ends_on >= p_from)
   order by a.starts_on desc, a.created_at desc
   limit v_lim;
end;
$fn$;
grant execute on function public.list_leave(uuid, text, uuid, date, int) to authenticated;

-- What a coordinator opens: everything waiting on them, plus what has been
-- flagged, in one read so the dashboard is one round trip.
create or replace function public.leave_inbox(p_org uuid, p_limit int default 60)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_lim int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_out jsonb;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not private.is_org_admin(p_org) then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only an organisation admin has a leave inbox.';
  end if;
  select jsonb_build_object(
    'pending', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.starts_on)
        from (select a.id, a.user_id, a.kind, a.starts_on, a.ends_on, a.days, a.note,
                     a.flagged, a.flag_reason, a.created_at, a.filed_by
                from public.away_days a
               where a.org_id = p_org and a.status = 'pending'
               order by a.starts_on limit v_lim) x), '[]'::jsonb),
    'flagged', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.starts_on desc)
        from (select a.id, a.user_id, a.kind, a.status, a.starts_on, a.ends_on, a.days,
                     a.flag_reason, a.note, a.created_at
                from public.away_days a
               where a.org_id = p_org and a.flagged
               order by a.starts_on desc limit v_lim) x), '[]'::jsonb),
    -- Who has spent what this month, so a decision is made next to the number
    -- it is being made against rather than in a second screen.
    'month_used', coalesce((
      select jsonb_object_agg(u.user_id::text, u.n) from (
        select a.user_id, count(*)::int as n
          from public.away_days a
          join private.leave_policy_eff(p_org) pol on true
         cross join lateral generate_series(a.starts_on, a.ends_on, interval '1 day') d
         where a.org_id = p_org and a.status = 'approved' and a.kind = any(pol.quota_kinds)
           and date_trunc('month', d) = date_trunc('month', (now() at time zone 'Asia/Kolkata'))
         group by a.user_id) u), '{}'::jsonb))
    into v_out;
  return v_out;
end;
$fn$;
grant execute on function public.leave_inbox(uuid, int) to authenticated;

-- ============================================================================
-- 7. The display side, corrected
-- ============================================================================
--
-- 0129's who_is_away counted every row. Now that a row can be pending, rejected
-- or cancelled, only an APPROVED one means somebody is actually out - otherwise
-- asking for leave would show you as on it, which is the opposite of a system
-- with approval in it.
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
  if v_org is null then
    return jsonb_build_object('day', v_day, 'away', '[]'::jsonb, 'mine', '[]'::jsonb,
                              'balance', null, 'inbox', 0);
  end if;

  select jsonb_build_object(
    'day', v_day,
    'org_id', v_org,
    'is_admin', private.is_org_admin(v_org),
    'away', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'user_id', a.user_id, 'kind', a.kind, 'note', a.note,
               'starts_on', a.starts_on, 'ends_on', a.ends_on, 'back_on', a.ends_on + 1)
             order by a.ends_on, a.user_id)
        from public.away_days a
        join public.workspace_members wm
          on wm.workspace_id = p_workspace and wm.user_id = a.user_id
       where a.org_id = v_org
         and a.status = 'approved'
         and v_day between a.starts_on and a.ends_on), '[]'::jsonb),
    -- Mine now includes what is still waiting, because "did my leave go
    -- through" is the first thing anybody opens this to find out.
    'mine', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'kind', a.kind, 'note', a.note, 'status', a.status,
               'auto_approved', a.auto_approved, 'flagged', a.flagged,
               'flag_reason', a.flag_reason, 'decision_note', a.decision_note,
               'starts_on', a.starts_on, 'ends_on', a.ends_on, 'days', a.days)
             order by a.starts_on)
        from public.away_days a
       where a.org_id = v_org and a.user_id = v_uid
         and a.ends_on >= v_day and a.status in ('pending', 'approved')), '[]'::jsonb),
    'balance', case when private.is_org_member(v_org)
                    then public.leave_balance(v_org, v_uid, v_day) end,
    -- A number for the sidebar badge, and zero for everybody who is not an
    -- approver so the row simply does not appear for them.
    'inbox', case when private.is_org_admin(v_org)
      then coalesce((select count(*)::int from public.away_days a
                      where a.org_id = v_org and a.status = 'pending'), 0)
      else 0 end)
    into v_out;
  return v_out;
end;
$fn$;
grant execute on function public.who_is_away(uuid, date) to authenticated;
