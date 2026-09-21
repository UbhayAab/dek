-- 0132: the send lock convoy, and the two doors that never opened
--
-- Three unrelated reports, one migration, because they share a cause worth
-- stating once: this database does real work while holding a lock somebody
-- else is waiting for, and it tells nobody when something needs a human.
--
-- 1. THE CRASH. public.send_message takes an exclusive row lock on the channel
--    (`from public.channels c where c.id = p_channel for update`) to allocate a
--    gapless per-channel seq, and then, still holding it, does six more writes
--    plus one realtime publish per mentioned user - up to fifty. Every send in
--    a channel is single file behind that lock, so the room degrades with
--    concurrency IN ONE ROOM, which is exactly the report. Measured on the live
--    database before this change: mean 14-108 ms, max 6,430 ms. With
--    max_connections at 60 and every waiter holding a pooler connection, a busy
--    room takes the whole project down, not just itself.
--
--    A row lock cannot be released early inside a function - one function is one
--    transaction. So the lever is total time under it. This moves the expensive
--    mention-visibility query to BEFORE the lock is taken, folds three separate
--    updates of the same locked row into one, and replaces the per-mention
--    publish loop with a single set-returning statement.
--
-- 2. ASK TO JOIN. request_join writes the row correctly and emits a realtime
--    broadcast on `ws:<workspace>`. That topic only reaches an admin who has
--    that exact server open at that moment. There is no push, no mail, no
--    badge that survives a reload. Evidence: one pending request for Carcinome
--    sat from 2026-09-18 to 2026-09-22 while three people with the permission
--    to approve it were active in the app. Nothing was broken. Nothing told
--    them. Now it rides app.enqueue_notification, the same queue leave uses.
--
--    Also: list_join_requests required KICK, while approve_join_request accepts
--    KICK **or** MANAGE_WORKSPACE. Somebody with only MANAGE_WORKSPACE could
--    approve a request they were not allowed to see. The list now matches.
--
-- 3. PRIVATE CHANNELS. add_channel_member adds one person and tells them
--    nothing - no notification, and no realtime event, so the channel does not
--    appear for them until a full reload. Every one of the 12 private channels
--    on this database has exactly one member. This adds a bulk call that
--    reports per-person outcomes and actually tells the people it added.

-- ===========================================================================
-- 1. send_message: same guarantees, shorter critical section
-- ===========================================================================
create or replace function public.send_message(
  p_channel uuid, p_client_msg_id uuid, p_body jsonb, p_body_text text,
  p_attachments jsonb default '[]'::jsonb, p_mentions uuid[] default '{}'::uuid[],
  p_mention_scope text default 'none', p_reply_to uuid default null,
  p_thread uuid default null, p_also_send boolean default false)
returns public.messages language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid; v_bmode text; v_row public.messages;
  v_mentions uuid[]; v_visible uuid[];
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select workspace_id, broadcast_mode into v_ws, v_bmode from public.channels where id = p_channel;
  if v_ws is null or not private.can_view_channel(p_channel) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (private.channel_perms(v_uid, p_channel) & 1) = 0 then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from public.workspace_members wm
              where wm.workspace_id = v_ws and wm.user_id = v_uid and wm.timeout_until > now()) then
    raise exception 'timed_out' using errcode = '42501';
  end if;
  if length(coalesce(p_body_text, '')) > 8000 then raise exception 'body_too_long' using errcode = '22023'; end if;
  if pg_column_size(coalesce(p_attachments, '[]'::jsonb)) > 65536 then raise exception 'attachments_too_large' using errcode = '22023'; end if;
  if p_thread is not null and not exists (select 1 from public.threads t where t.id = p_thread and t.channel_id = p_channel) then
    raise exception 'invalid_thread' using errcode = '22023';
  end if;
  if p_reply_to is not null and not exists (select 1 from public.messages r where r.id = p_reply_to and r.channel_id = p_channel) then
    raise exception 'invalid_reply' using errcode = '22023';
  end if;
  v_mentions := (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_mentions, '{}')) x);
  if coalesce(array_length(v_mentions, 1), 0) > 50 then raise exception 'too_many_mentions' using errcode = '22023'; end if;
  perform private.rate_limit('send', v_uid, p_channel, 30, interval '10 seconds');

  -- MOVED ABOVE THE LOCK. This is a four-table visibility test per mentioned
  -- user and it does not depend on the row about to be written, so there is no
  -- reason for the channel to be locked while it runs. Same predicate as before.
  v_visible := (select coalesce(array_agg(u), '{}') from unnest(v_mentions) u
    where u <> v_uid and exists (
      select 1 from public.channels c where c.id = p_channel and (
        (not c.is_private and exists (select 1 from public.workspace_members wm
           where wm.workspace_id = c.workspace_id and wm.user_id = u))
        or exists (select 1 from public.channel_members cm
           where cm.channel_id = p_channel and cm.user_id = u)))
      and not private.channel_view_denied(u, p_channel));

  -- ---- critical section: the channel row is locked from here to commit -----
  insert into public.messages(channel_id, workspace_id, thread_id, author_id, seq, client_msg_id,
                              body, body_text, attachments, mention_user_ids, mention_scope, reply_to_id,
                              also_send_to_channel)
  select p_channel, v_ws, p_thread, v_uid, c.last_seq + 1, p_client_msg_id,
         coalesce(p_body,'{}'::jsonb), coalesce(p_body_text,''), coalesce(p_attachments,'[]'::jsonb),
         v_mentions, coalesce(p_mention_scope,'none'), p_reply_to,
         (p_thread is not null and coalesce(p_also_send, false))
  from public.channels c where c.id = p_channel for update
  on conflict (channel_id, author_id, client_msg_id) do nothing
  returning * into v_row;

  if not found then
    select * into v_row from public.messages
      where channel_id = p_channel and author_id = v_uid and client_msg_id = p_client_msg_id;
    return v_row;
  end if;

  -- Folded three separate `update public.channels` statements into one. They
  -- all hit the same already-locked row; doing it once is three fewer row
  -- versions per message for autovacuum to clean up on the hottest table here.
  update public.channels
     set last_seq = v_row.seq,
         last_message_at = now(),
         last_broadcast_seq = case
           when p_mention_scope in ('here','channel')
            and private.has_channel_perm(p_channel, (1::bigint << 8))
           then v_row.seq else last_broadcast_seq end,
         last_nudge_at = case
           when v_bmode <> 'full'
            and (last_nudge_at is null or last_nudge_at < now() - interval '2 seconds')
           then now() else last_nudge_at end
   where id = p_channel;

  insert into public.channel_events(channel_id, workspace_id, seq, kind, message_id, actor_id, data)
  values (p_channel, v_ws, v_row.seq, 'msg', v_row.id, v_uid, jsonb_build_object('thread_id', p_thread));

  if p_thread is not null then
    update public.threads set reply_count = reply_count + 1, last_message_at = now() where id = p_thread;
    insert into public.thread_followers(thread_id, user_id, workspace_id)
    values (p_thread, v_uid, v_ws) on conflict (thread_id, user_id) do nothing;
  end if;

  insert into public.read_state(user_id, scope_type, scope_id, mention_count)
  select u, 'channel', p_channel, 1 from unnest(v_visible) u
  on conflict (user_id, scope_type, scope_id)
    do update set mention_count = public.read_state.mention_count + 1;

  -- The publishes go last, so anything above that raises has not already told
  -- the world about a message that is about to roll back. `foreach ... loop`
  -- over v_visible was one plpgsql statement per mentioned user - up to fifty
  -- round trips with the channel still locked. One set-returning statement now.
  if v_bmode = 'full' then
    perform app.emit('ch:'||p_channel::text, 'msg', to_jsonb(v_row));
  else
    perform app.emit('ch:'||p_channel::text, 'nudge', jsonb_build_object('last_seq', v_row.seq));
  end if;

  perform app.emit('user:'||u::text, 'mention',
            jsonb_build_object('channel_id', p_channel, 'message_id', v_row.id, 'workspace_id', v_ws))
     from unnest(v_visible) u;

  return v_row;
end;
$fn$;

-- ===========================================================================
-- 2. Ask to join: tell somebody
-- ===========================================================================
--
-- Who can act on a request, resolved the same way approve_join_request checks
-- it, so the people who are told are exactly the people who can do something.
-- ADMINISTRATOR (bit 40) short-circuits in private.has_perm, so it is included
-- here rather than being a fourth special case.
create or replace function private.join_request_approvers(p_workspace uuid)
returns table(user_id uuid) language sql stable security definer set search_path = '' as $fn$
  select distinct wm.user_id
    from public.workspace_members wm
   where wm.workspace_id = p_workspace
     and coalesce((
       select bit_or(r.permissions) from public.roles r
        where r.workspace_id = p_workspace
          and ( r.is_everyone
                or exists (select 1 from public.member_roles mr
                            where mr.role_id = r.id and mr.user_id = wm.user_id
                              and mr.workspace_id = p_workspace) )
     ), 0) & ((1::bigint << 4) | (1::bigint << 6) | (1::bigint << 40)) <> 0;
$fn$;

create or replace function private.notify_join_request(p_req public.workspace_join_requests)
returns void language plpgsql security definer set search_path = '' as $fn$
declare r record; v_ws_name text; v_who text;
begin
  if p_req.status <> 'pending' then return; end if;
  select name into v_ws_name from public.workspaces where id = p_req.workspace_id;
  select coalesce(display_name, username::text, 'Somebody') into v_who
    from public.profiles where id = p_req.user_id;

  for r in select a.user_id from private.join_request_approvers(p_req.workspace_id) a
            where a.user_id <> p_req.user_id
  loop
    perform app.enqueue_notification(r.user_id, jsonb_build_object(
      'kind', 'join_request', 'request_id', p_req.id,
      'workspace_id', p_req.workspace_id, 'workspace_name', v_ws_name,
      'user_id', p_req.user_id, 'who', v_who));
    -- user:<uid> reaches them wherever they are in the app, not only if they
    -- happen to have this server open, which is all ws:<id> could do.
    perform app.emit('user:'||r.user_id::text, 'join_request', jsonb_build_object(
      'request_id', p_req.id, 'workspace_id', p_req.workspace_id,
      'workspace_name', v_ws_name, 'user_id', p_req.user_id, 'who', v_who));
  end loop;
end;
$fn$;

create or replace function public.request_join(p_workspace uuid)
returns public.workspace_join_requests language plpgsql security definer set search_path = '' as $fn$
declare v_uid uuid := (select auth.uid()); v_req public.workspace_join_requests; v_gated boolean;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select requires_approval into v_gated from public.workspaces where id = p_workspace;
  if v_gated is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not v_gated then raise exception 'not_gated' using errcode = '22023'; end if;
  if exists (select 1 from public.workspace_members wm
              where wm.workspace_id = p_workspace and wm.user_id = v_uid) then
    raise exception 'already_member' using errcode = '42501';
  end if;
  if exists (select 1 from public.bans b where b.workspace_id = p_workspace and b.user_id = v_uid) then
    raise exception 'banned' using errcode = '42501';
  end if;
  perform private.rate_limit('request_join', v_uid, null, 10, interval '60 seconds');

  insert into public.workspace_join_requests(workspace_id, user_id, status)
  values (p_workspace, v_uid, 'pending')
  on conflict (workspace_id, user_id) do update
    set status = 'pending', decided_by = null, decided_at = null, created_at = now()
  returning * into v_req;

  -- Kept: an open admin console still repaints from this one.
  perform app.emit('ws:'||p_workspace::text, 'join_request',
    jsonb_build_object('request_id', v_req.id, 'user_id', v_uid));
  -- Added: the part that reaches somebody who is not already looking.
  perform private.notify_join_request(v_req);
  return v_req;
end;
$fn$;

-- The list required KICK; approve accepts KICK or MANAGE_WORKSPACE. A person
-- holding only MANAGE_WORKSPACE could approve a request they could not see,
-- which reads from the admin console as "there are no requests".
create or replace function public.list_join_requests(p_workspace uuid)
returns table(id uuid, user_id uuid, display_name text, created_at timestamp with time zone)
language sql stable security definer set search_path = '' as $fn$
  select r.id, r.user_id, p.display_name, r.created_at
  from public.workspace_join_requests r
  left join public.profiles p on p.id = r.user_id
  where r.workspace_id = p_workspace
    and r.status = 'pending'
    and ( private.has_perm(p_workspace, (1::bigint << 4))
       or private.has_perm(p_workspace, (1::bigint << 6)) )
  order by r.created_at;
$fn$;

create or replace function public.count_join_requests(p_workspace uuid)
returns integer language sql stable security definer set search_path = '' as $fn$
  select count(*)::int from public.workspace_join_requests r
   where r.workspace_id = p_workspace and r.status = 'pending'
     and ( private.has_perm(p_workspace, (1::bigint << 4))
        or private.has_perm(p_workspace, (1::bigint << 6)) );
$fn$;

-- ===========================================================================
-- 3. The org-wide queue the client has been calling all along
-- ===========================================================================
--
-- js/api.js calls list_org_join_requests, count_org_join_requests,
-- approve_org_join_request and reject_org_join_request. None of the four
-- existed on this database. tryRpc swallows a missing RPC, so the org admin
-- console rendered an empty queue rather than an error - the failure mode this
-- repo has been bitten by before. There is no org-level request table and one
-- would be a second kind of request half the app cannot render, so these are
-- the workspace queue scoped to the org's servers.
create or replace function public.list_org_join_requests(p_org uuid)
returns table(id uuid, user_id uuid, display_name text, workspace_id uuid,
              workspace_name text, created_at timestamp with time zone)
language sql stable security definer set search_path = '' as $fn$
  select r.id, r.user_id, p.display_name, r.workspace_id, w.name::text, r.created_at
  from public.workspace_join_requests r
  join public.workspaces w on w.id = r.workspace_id
  left join public.profiles p on p.id = r.user_id
  where w.org_id = p_org
    and r.status = 'pending'
    and (select private.pw_ok())
    and exists (select 1 from public.org_members om
                 where om.org_id = p_org and om.user_id = (select auth.uid())
                   and om.org_role = 'admin')
  order by r.created_at;
$fn$;

create or replace function public.count_org_join_requests(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $fn$
  select count(*)::int from public.list_org_join_requests(p_org);
$fn$;

-- Approve/reject at org level defer to the workspace functions so there is one
-- permission path and one audit row, never a second copy that drifts.
create or replace function public.approve_org_join_request(p_request uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_ws uuid; v_org uuid;
begin
  select r.workspace_id, w.org_id into v_ws, v_org
    from public.workspace_join_requests r
    join public.workspaces w on w.id = r.workspace_id
   where r.id = p_request;
  if v_ws is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.org_members om
                  where om.org_id = v_org and om.user_id = (select auth.uid())
                    and om.org_role = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.approve_join_request(p_request);
end;
$fn$;

create or replace function public.reject_org_join_request(p_request uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_ws uuid; v_org uuid;
begin
  select r.workspace_id, w.org_id into v_ws, v_org
    from public.workspace_join_requests r
    join public.workspaces w on w.id = r.workspace_id
   where r.id = p_request;
  if v_ws is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.org_members om
                  where om.org_id = v_org and om.user_id = (select auth.uid())
                    and om.org_role = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public.reject_join_request(p_request);
end;
$fn$;

-- Approving should tell the person they are in. claims_changed already fires;
-- it repaints a running client and says nothing to a closed one.
create or replace function public.approve_join_request(p_request uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_uid uuid := (select auth.uid()); v_req public.workspace_join_requests; v_name text;
begin
  select * into v_req from public.workspace_join_requests where id = p_request;
  if v_req.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not (private.has_perm(v_req.workspace_id, (1::bigint << 4))
          or private.has_perm(v_req.workspace_id, (1::bigint << 6))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from public.bans b
              where b.workspace_id = v_req.workspace_id and b.user_id = v_req.user_id) then
    raise exception 'banned' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then raise exception 'already_decided' using errcode = '22023'; end if;

  insert into public.workspace_members(workspace_id, user_id, member_type)
    values (v_req.workspace_id, v_req.user_id, 'member') on conflict do nothing;
  update public.workspace_join_requests
    set status = 'approved', decided_by = v_uid, decided_at = now() where id = p_request;
  insert into public.audit_log(workspace_id, actor_id, action, target)
    values (v_req.workspace_id, v_uid, 'approve_join_request', jsonb_build_object('user_id', v_req.user_id));

  select name into v_name from public.workspaces where id = v_req.workspace_id;
  perform app.emit('user:'||v_req.user_id::text, 'claims_changed',
    jsonb_build_object('workspace_id', v_req.workspace_id));
  perform app.enqueue_notification(v_req.user_id, jsonb_build_object(
    'kind', 'join_approved', 'workspace_id', v_req.workspace_id, 'workspace_name', v_name));
end;
$fn$;

-- ===========================================================================
-- 4. Private channels: add people, and tell them
-- ===========================================================================
--
-- The single-row add stays (one caller still uses it) but gains the two side
-- effects it never had. Without the realtime event the channel does not appear
-- for the person until they reload, which is indistinguishable from not having
-- been added at all - and is most of why "the invite link does not work" was
-- the report rather than "nothing happened".
create or replace function public.add_channel_member(p_channel uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_ws uuid; v_name text; v_added int;
begin
  select workspace_id, name into v_ws, v_name from public.channels where id = p_channel;
  if v_ws is null or not private.has_perm(v_ws, 4) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_members
                  where workspace_id = v_ws and user_id = p_user) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  insert into public.channel_members(channel_id, user_id, workspace_id)
  values (p_channel, p_user, v_ws) on conflict do nothing;
  get diagnostics v_added = row_count;
  if v_added = 0 then return; end if;

  perform app.emit('user:'||p_user::text, 'channel_added',
    jsonb_build_object('channel_id', p_channel, 'workspace_id', v_ws, 'name', v_name));
  perform app.emit('ch:'||p_channel::text, 'members_changed',
    jsonb_build_object('channel_id', p_channel));
  perform app.enqueue_notification(p_user, jsonb_build_object(
    'kind', 'channel_added', 'channel_id', p_channel, 'workspace_id', v_ws, 'channel_name', v_name));
end;
$fn$;

-- The bulk call. One permission check and one membership check for the whole
-- list instead of one round trip per person, and it returns a row per person
-- so the caller can render outcomes rather than guessing from an exception.
create or replace function public.add_channel_members(p_channel uuid, p_users uuid[])
returns table(user_id uuid, outcome text)
language plpgsql security definer set search_path = '' as $fn$
declare v_ws uuid; v_name text; r record;
begin
  select workspace_id, name into v_ws, v_name from public.channels where id = p_channel;
  if v_ws is null or not private.has_perm(v_ws, 4) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(array_length(p_users, 1), 0) > 200 then
    raise exception 'too_many' using errcode = '22023';
  end if;
  perform private.rate_limit('add_members', (select auth.uid()), p_channel, 20, interval '60 seconds');

  create temp table _add_result(uid uuid primary key, res text) on commit drop;

  insert into _add_result(uid, res)
  select u, case
           when not exists (select 1 from public.workspace_members wm
                             where wm.workspace_id = v_ws and wm.user_id = u) then 'not_a_member'
           when exists (select 1 from public.channel_members cm
                         where cm.channel_id = p_channel and cm.user_id = u) then 'already_in'
           else 'added' end
    from unnest(coalesce(p_users, '{}'::uuid[])) u
  on conflict (uid) do nothing;

  insert into public.channel_members(channel_id, user_id, workspace_id)
  select p_channel, a.uid, v_ws from _add_result a where a.res = 'added'
  on conflict do nothing;

  for r in select a.uid from _add_result a where a.res = 'added' loop
    perform app.emit('user:'||r.uid::text, 'channel_added',
      jsonb_build_object('channel_id', p_channel, 'workspace_id', v_ws, 'name', v_name));
    perform app.enqueue_notification(r.uid, jsonb_build_object(
      'kind', 'channel_added', 'channel_id', p_channel,
      'workspace_id', v_ws, 'channel_name', v_name));
  end loop;

  -- So an already-open members panel repaints for everybody looking at it.
  perform app.emit('ch:'||p_channel::text, 'members_changed',
    jsonb_build_object('channel_id', p_channel));

  return query select a.uid, a.res from _add_result a;
end;
$fn$;

-- Who is in a private channel, for the admin panel. channel_members is
-- readable under RLS only for channels you can already see, and an admin
-- managing a private channel they are not in is exactly the case that needs it.
create or replace function public.list_channel_members(p_channel uuid)
returns table(user_id uuid, display_name text, username text)
language sql stable security definer set search_path = '' as $fn$
  select cm.user_id, p.display_name, p.username::text
    from public.channel_members cm
    left join public.profiles p on p.id = cm.user_id
   where cm.channel_id = p_channel
     and ( private.can_view_channel(p_channel)
        or private.has_perm((select workspace_id from public.channels where id = p_channel), 4) )
   order by coalesce(p.display_name, p.username::text);
$fn$;

create or replace function public.remove_channel_member(p_channel uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.channels where id = p_channel;
  if v_ws is null or not private.has_perm(v_ws, 4) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.channel_members where channel_id = p_channel and user_id = p_user;
  perform app.emit('user:'||p_user::text, 'channel_removed',
    jsonb_build_object('channel_id', p_channel, 'workspace_id', v_ws));
  perform app.emit('ch:'||p_channel::text, 'members_changed',
    jsonb_build_object('channel_id', p_channel));
end;
$fn$;

-- ===========================================================================
-- 5. Notification copy for the three new kinds
-- ===========================================================================
create or replace function app.notification_content(p_msg jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_kind text := coalesce(p_msg->'payload'->>'kind', 'message');
  v_mid  uuid := nullif(p_msg->'payload'->>'message_id', '')::uuid;
  v_cid  uuid := nullif(p_msg->'payload'->>'channel_id', '')::uuid;
  v_conv uuid := nullif(p_msg->'payload'->>'conversation_id', '')::uuid;
  v_who  text; v_txt text; v_name text;
  v_from date; v_to date; v_span text;
begin
  -- ---- joining (0132) -----------------------------------------------------
  if v_kind = 'join_request' then
    return jsonb_build_object(
      'title', coalesce(p_msg->'payload'->>'who', 'Somebody') || ' wants to join',
      'body',  coalesce(p_msg->'payload'->>'workspace_name', 'a server')
               || ' - tap to approve or decline',
      'url',   './#/admin/requests',
      -- One tag per request: two people asking is two notifications, not one
      -- silently replacing the other.
      'tag',   'joinreq:' || coalesce(p_msg->'payload'->>'request_id', 'x'));
  end if;

  if v_kind = 'join_approved' then
    return jsonb_build_object(
      'title', 'You are in',
      'body',  coalesce(p_msg->'payload'->>'workspace_name', 'The server') || ' approved your request',
      'url',   './#/s/' || coalesce(p_msg->'payload'->>'workspace_id', ''),
      'tag',   'joinok:' || coalesce(p_msg->'payload'->>'workspace_id', 'x'));
  end if;

  if v_kind = 'channel_added' then
    return jsonb_build_object(
      'title', 'Added to #' || coalesce(p_msg->'payload'->>'channel_name', 'a channel'),
      'body',  'You now have access to this channel',
      'url',   './#/c/' || coalesce(v_cid::text, ''),
      'tag',   'chadd:' || coalesce(v_cid::text, 'x'));
  end if;

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
    return jsonb_build_object('title', v_who, 'body', v_txt,
      'url', './#/d/' || coalesce(v_conv::text, ''),
      'tag', 'dm:' || coalesce(v_conv::text, v_mid::text));
  end if;

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

  return jsonb_build_object('title', 'Dek',
    'body', case v_kind
              when 'task_assigned' then 'A task was assigned to you'
              when 'task_due'      then 'A task is due'
              when 'call'          then 'Somebody is calling you'
              else 'You have a new notification' end,
    'url', './', 'tag', v_kind);
end;
$fn$;

-- ===========================================================================
-- 6. Housekeeping that was never scheduled
-- ===========================================================================
--
-- private.rate_counters is written on every send, every join request and every
-- invite redemption, one row per bucket:user:scope, and nothing has ever
-- deleted from it. 19,323 rows on this database with the oldest window_start
-- from 2026-07-23. Not fatal, but it is an ever-growing hot-write table on the
-- path of every message.
create or replace function app.prune_rate_counters()
returns integer language plpgsql security definer set search_path = '' as $fn$
declare n integer;
begin
  delete from private.rate_counters where window_start < now() - interval '1 day';
  get diagnostics n = row_count;
  return n;
end;
$fn$;

select cron.unschedule('prune-rate-counters')
 where exists (select 1 from cron.job where jobname = 'prune-rate-counters');
select cron.schedule('prune-rate-counters', '23 4 * * *', 'select app.prune_rate_counters();');

grant execute on function public.add_channel_members(uuid, uuid[]) to authenticated;
grant execute on function public.list_channel_members(uuid) to authenticated;
grant execute on function public.remove_channel_member(uuid, uuid) to authenticated;
grant execute on function public.list_org_join_requests(uuid) to authenticated;
grant execute on function public.count_org_join_requests(uuid) to authenticated;
grant execute on function public.approve_org_join_request(uuid) to authenticated;
grant execute on function public.reject_org_join_request(uuid) to authenticated;
