-- 0900: integration fixes after the four backend builders reported. Owner: lead.
--
-- OWNERSHIP CHANGES (the builders are finished; from here these are lead-owned and may
-- only be changed in a lead migration): dek.plat_route_message (was [plat], 0310),
-- api.get_profiles (was [msg], 0200).
--
--  1. emit_many put its own event id under "id" and overwrote the scope id that
--     access.revoked and member.upd carry, so clients could not tell WHAT was revoked
--     (found by [plat] and [org], confirmed live). The event id is now "eid".
--  2. call: topics: sending signals needs a joined participant; listening needs
--     joined or ringing, or reading the room's channel ([media] review).
--  3. Public channel events also go to the u: topic of guests who are members of the
--     channel (guests never join s: topics) ([msg]).
--  4. soft_delete_message locks the message FOR NO KEY UPDATE so it does not block
--     reply inserts under that root ([msg]).
--  5. can_write_object returned null in one branch; it returns false now ([media]).
--  6. server_json carries "access": member, partial or browse ([org]).
--  7. Push candidates include the people mentioned in a message, so a mention of
--     someone who reads a public channel without having joined it notifies them ([msg]).
--  8. api.get_profiles resolves authors who left or deleted their account when the
--     caller can read one of their messages (reduced profile), so old messages keep a
--     name ([msg]).
--  9. Cron timeouts are set INSIDE the command: ALTER FUNCTION ... SET statement_timeout
--     arms nothing for the calling statement ([media] measured a 1 s setting letting a
--     3 s sleep finish). prune also forgets devices revoked over 30 days ago ([plat]).
-- 10. Media bucket MIME allow-list on the bucket itself ([media]).
-- 11. Media links: clients could mint signed URLs with any lifetime (a link valid for
--     years, kept after leaving). Ready objects now open only through the media-sign
--     function, which mints 15 minute links after the same access check. The select
--     policy remains only for the uploader of a pending object.
-- 12. New events so open apps stay right without polling: server.upd, org.upd, and
--     chan.self (the caller's own notify, mute and hidden settings on other devices).

-- 1 -----------------------------------------------------------------------------
create or replace function dek.emit_many(p_topics text[], p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_topics is null or cardinality(p_topics) = 0 then
    return;
  end if;
  insert into realtime.messages (id, topic, extension, event, payload, private)
  select x.id, x.topic, 'broadcast', p_event,
         coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('v', 1, 'eid', x.id), true
    from (select gen_random_uuid() as id, t.topic
            from (select distinct u as topic from unnest(p_topics) u where u is not null) t) x;
exception when others then
  raise warning 'dek.emit_many(% topics, %) failed: %', cardinality(p_topics), p_event, sqlerrm;
end $$;

-- 2 -----------------------------------------------------------------------------
create or replace function dek.can_use_topic(p_topic text, p_mode text, p_extension text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_prefix text;
  v_rest   text;
  v_id     uuid;
begin
  if v_uid is null or p_topic is null or p_mode not in ('read', 'write') then
    return false;
  end if;
  v_prefix := split_part(p_topic, ':', 1);
  v_rest := substr(p_topic, char_length(v_prefix) + 2);
  if v_rest !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_id := v_rest::uuid;

  if v_prefix = 'u' then
    return p_mode = 'read' and v_id = v_uid and p_extension = 'broadcast';
  elsif v_prefix = 's' then
    return p_mode = 'read' and p_extension = 'broadcast'
       and exists (select 1 from dek.servers s
                     join dek.org_members om on om.org_id = s.org_id and om.user_id = v_uid
                                            and om.status = 'active' and om.role <> 'guest'
                     join dek.server_members sm on sm.server_id = s.id and sm.user_id = v_uid
                    where s.id = v_id);
  elsif v_prefix = 't' then
    return p_extension = 'broadcast' and dek.can_read_channel(v_uid, v_id);
  elsif v_prefix = 'call' then
    -- Realtime checks these at join and caches them: a callee joins call:<id> after
    -- answer_call, when it is a joined participant.
    return p_extension in ('broadcast', 'presence')
       and exists (
         select 1 from dek.calls c
          where c.id = v_id and c.ended_at is null
            and dek.org_role(v_uid, c.org_id) is not null
            and (exists (select 1 from dek.call_participants p
                          where p.call_id = c.id and p.user_id = v_uid
                            and (p.state = 'joined' or (p_mode = 'read' and p.state = 'ringing')))
                 or (p_mode = 'read' and c.kind = 'room' and dek.can_read_channel(v_uid, c.channel_id))));
  end if;
  return false;
end $$;

-- 3 -----------------------------------------------------------------------------
create or replace function dek.emit_channel(p_channel uuid, p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c        dek.channels;
  v_topics text[];
begin
  select * into c from dek.channels where id = p_channel;
  if not found then return; end if;
  if c.server_id is not null and c.visibility = 'public' then
    v_topics := array['s:' || c.server_id::text] || array(
      select 'u:' || cm.user_id::text from dek.channel_members cm
       where cm.channel_id = c.id
         and (not exists (select 1 from dek.server_members sm
                           where sm.server_id = c.server_id and sm.user_id = cm.user_id)
              or exists (select 1 from dek.org_members om
                          where om.org_id = c.org_id and om.user_id = cm.user_id and om.role = 'guest')));
  else
    v_topics := array(select 'u:' || cm.user_id::text from dek.channel_members cm where cm.channel_id = c.id);
  end if;
  perform dek.emit_many(v_topics, p_event, p_payload);
end $$;

-- 4 -----------------------------------------------------------------------------
create or replace function dek.soft_delete_message(p_message uuid, p_actor uuid, p_reason text, p_moderation boolean)
returns dek.messages language plpgsql security definer set search_path = '' as $$
declare
  m      dek.messages;
  v_root dek.messages;
begin
  select * into m from dek.messages where id = p_message for no key update;
  if not found then
    perform dek.err('not_found', 'That message does not exist.');
  end if;
  if m.deleted_at is not null then
    return m;
  end if;
  if p_moderation then
    insert into dek.audit_log (org_id, actor_id, action, target_type, target_id, details)
    values (m.org_id, p_actor, 'message.removed', 'message', m.id,
            jsonb_build_object('channel_id', m.channel_id, 'author_id', m.author_id, 'body', m.body,
                               'reason', p_reason, 'posted_at', m.created_at));
  end if;
  update dek.messages
     set deleted_at = now(), deleted_by = p_actor, body = '', mentions = '{}', mention_all = false,
         reactions = '{}', pinned_at = null, pinned_by = null, updated_at = now()
   where id = m.id
  returning * into m;
  delete from dek.reactions where message_id = m.id;
  delete from dek.mentions where message_id = m.id;
  delete from dek.saved_messages where message_id = m.id;
  update dek.attachments set status = 'deleted', deleted_at = now()
   where message_id = m.id and status in ('pending', 'ready');
  if m.thread_root_id is not null then
    update dek.messages r
       set reply_count = greatest(r.reply_count - 1, 0), updated_at = now()
     where r.id = m.thread_root_id
    returning * into v_root;
    if v_root.id is not null then
      perform dek.emit_channel(m.channel_id, 'msg.upd', jsonb_build_object('message', dek.message_json(v_root)));
    end if;
  end if;
  perform dek.emit_channel(m.channel_id, 'msg.upd', jsonb_build_object('message', dek.message_json(m)));
  return m;
end $$;

-- 5 -----------------------------------------------------------------------------
create or replace function dek.can_write_object(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[];
  a       dek.attachments;
begin
  if v_uid is null or p_name is null then return false; end if;
  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) <> 4
     or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  select * into a from dek.attachments where id = v_parts[3]::uuid;
  if not found then return false; end if;
  return coalesce(a.status = 'pending'
     and a.uploader_id = v_uid
     and a.created_at > now() - interval '2 hours'
     and (p_name = a.object_path or p_name = a.thumb_path), false);
end $$;

-- 6 -----------------------------------------------------------------------------
create or replace function dek.server_json(s dek.servers, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'org_id', s.org_id, 'name', s.name, 'description', s.description,
    'icon_emoji', s.icon_emoji, 'position', s.position, 'join_policy', s.join_policy,
    'archived', s.archived_at is not null,
    'my_role', dek.server_role(p_uid, s.id),
    'access', dek.org_server_access(p_uid, s.id),
    'member_count', (select count(*) from dek.server_members sm where sm.server_id = s.id))
$$;

-- 7 -----------------------------------------------------------------------------
create or replace function dek.plat_route_message(i dek.notification_intents)
returns table (r_user uuid, r_device uuid, r_quiet boolean, r_title text, r_body text, r_url text,
               r_tag text, r_org uuid, r_org_short text, r_preview text, r_urgency text)
language plpgsql stable security definer set search_path = '' as $$
declare
  m       dek.messages;
  c       dek.channels;
  v_dm    boolean;
  v_org   text;
  v_title text;
  v_text  text;
  v_empty text;
  v_links boolean;
begin
  select * into m from dek.messages x where x.id = i.message_id;
  if not found or m.deleted_at is not null or m.kind <> 'user' or m.author_id is null then
    return;
  end if;
  select * into c from dek.channels x where x.id = m.channel_id;
  v_dm := c.kind in ('dm', 'group_dm');
  select coalesce(o.short_name, o.name) into v_org from dek.orgs o where o.id = m.org_id;
  select case c.kind when 'dm' then a.name when 'group_dm' then a.name || ' in a group message'
                     else a.name || ' in #' || c.name end
    into v_title
    from (select coalesce((select case when p.deleted_at is null then p.display_name else 'Deleted user' end
                             from dek.profiles p where p.id = m.author_id), 'Someone') as name) a;
  v_empty := case when m.attachment_count > 0 then 'Sent an attachment' else 'New message' end;
  v_links := m.body ~ '<#[0-9a-fA-F-]{36}>';
  v_text := coalesce(nullif(dek.plat_render_body(m.body, m.org_id), ''), v_empty);
  return query
  with cand as (
    select cm.user_id as uid from dek.channel_members cm where cm.channel_id = m.channel_id
    union
    select tf.user_id from dek.thread_follows tf
     where m.thread_root_id is not null and tf.root_id = m.thread_root_id and tf.following
    union
    -- mentioned people who read the channel without having joined it
    select u from unnest(m.mentions) u
  ), who as (
    select x.uid,
           coalesce(n.preview, 'full') as preview,
           coalesce(n.thread_replies, true) as thread_replies,
           n.quiet_start, n.quiet_end, n.quiet_tz,
           case when coalesce(cm.notify, 'default') <> 'default' then cm.notify
                when v_dm then coalesce(n.dm_level, 'all')
                else coalesce(n.default_level, 'mentions') end as level,
           cm.muted_until,
           coalesce(cm.last_read_seq, 0) as read_seq,
           coalesce(tf.following, false) as follows,
           coalesce(tf.last_read_reply_seq, 0) as read_reply_seq,
           x.uid = any (m.mentions) as direct
      from cand x
      join dek.profiles p on p.id = x.uid and p.deleted_at is null
      left join dek.notification_prefs n on n.user_id = x.uid
      left join dek.channel_members cm on cm.channel_id = m.channel_id and cm.user_id = x.uid
      left join dek.thread_follows tf on tf.root_id = m.thread_root_id and tf.user_id = x.uid
     where x.uid <> m.author_id
       and (i.target_user_id is null or x.uid = i.target_user_id)
       and not exists (select 1 from dek.user_blocks b where b.blocker_id = x.uid and b.blocked_id = m.author_id)
       and dek.can_read_channel(x.uid, m.channel_id)
  ), wanted as materialized (
    select w.*,
           case when w.preview <> 'full' then 'New message'
                when v_links then coalesce(nullif(dek.plat_render_body(m.body, m.org_id, w.uid), ''), v_empty)
                else v_text end as body_text
      from who w
     where w.level <> 'none'
       and ((w.level = 'all' and (v_dm or m.in_timeline))
            or w.direct or m.mention_all
            or (m.thread_root_id is not null and w.follows and w.thread_replies))
       and (w.muted_until is null or w.muted_until <= now() or w.direct)
       and (i.target_user_id is not null
            or not ((m.in_timeline and w.read_seq >= m.seq)
                    or (m.thread_root_id is not null and w.read_reply_seq >= m.seq)))
  )
  select w.uid, d.id,
         case when w.quiet_start is not null and w.quiet_end is not null
              then dek.plat_in_quiet_hours(w.quiet_start, w.quiet_end, w.quiet_tz) else false end,
         case when w.preview = 'none' then 'Dek' else v_title end,
         w.body_text,
         '/o/' || m.org_id || '/c/' || m.channel_id || coalesce('/t/' || m.thread_root_id, '') || '/m/' || m.id,
         coalesce('t:' || m.thread_root_id, 'c:' || m.channel_id),
         m.org_id, v_org, w.preview,
         case when w.direct or m.mention_all then 'high' else 'normal' end
    from wanted w
    join dek.push_devices d on d.user_id = w.uid and d.enabled and d.revoked_at is null
   where not exists (select 1 from dek.notification_deliveries nd
                      where nd.intent_id = i.id and nd.device_id = d.id
                        and not dek.plat_retryable(nd.status, nd.http_status))
   order by w.uid, d.id
   limit 5000;
end $$;

-- 8 -----------------------------------------------------------------------------
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
  select coalesce(jsonb_agg(
           case when x.shared then dek.profile_json(p)
                -- someone who left or deleted their account: a name for their old
                -- messages, nothing about what they do now
                else dek.profile_json(p) || jsonb_build_object(
                       'title', null, 'timezone', null, 'status_text', null, 'status_emoji', null,
                       'status_until', null, 'last_active_at', null) end
           order by x.ord), '[]'::jsonb)
    into v_out
    from (select u.id, min(u.ord) as ord, dek.shares_org(v_uid, u.id) as shared
            from unnest(p_ids) with ordinality as u(id, ord)
           where u.id is not null
           group by u.id) x
    join dek.profiles p on p.id = x.id
   where x.shared
      or exists (select 1 from dek.messages m
                  where m.author_id = p.id
                    and m.org_id in (select om.org_id from dek.org_members om
                                      where om.user_id = v_uid and om.status = 'active')
                    and dek.can_read_channel(v_uid, m.channel_id));
  return v_out;
end $$;

-- 9 -----------------------------------------------------------------------------
create or replace function dek.prune()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from dek.notification_deliveries where created_at < now() - interval '14 days';
  delete from dek.notification_intents
   where status in ('done', 'failed', 'expired') and created_at < now() - interval '7 days';
  delete from dek.rate_buckets where window_start < now() - interval '1 day';
  delete from dek.push_devices where revoked_at is not null and revoked_at < now() - interval '30 days';
  begin
    delete from cron.job_run_details where end_time < now() - interval '2 days';
  exception when others then
    raise warning 'dek.prune: cron history not pruned: %', sqlerrm;
  end;
end $$;

do $$
declare r record;
begin
  for r in select jobid, jobname from cron.job where jobname in ('dek-sweep-intents', 'dek-prune') loop
    perform cron.alter_job(job_id => r.jobid, command => case r.jobname
      when 'dek-sweep-intents' then 'set statement_timeout = ''20s''; select dek.sweep_intents()'
      else 'set statement_timeout = ''120s''; select dek.prune()' end);
  end loop;
end $$;

-- 10 ----------------------------------------------------------------------------
update storage.buckets
   set allowed_mime_types = array[
     'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif',
     'video/mp4', 'video/webm', 'video/quicktime',
     'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/aac',
     'application/pdf', 'text/plain', 'text/csv',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
     'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
     'application/vnd.oasis.opendocument.presentation', 'application/zip']
 where id = 'media';

-- 11 ----------------------------------------------------------------------------
create or replace function dek.can_read_object_as(p_uid uuid, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_parts text[];
  a       dek.attachments;
begin
  if p_uid is null or p_name is null then return false; end if;
  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) <> 4
     or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  select * into a from dek.attachments where id = v_parts[3]::uuid;
  if not found or a.status <> 'ready' then return false; end if;
  if p_name <> a.object_path and p_name is distinct from a.thumb_path then return false; end if;
  return coalesce(dek.can_read_channel(p_uid, a.channel_id), false);
end $$;

create or replace function dek.can_read_object(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select dek.can_read_object_as(auth.uid(), p_name)
$$;

-- media-sign asks which of these paths the person may open (at most 100).
create or replace function api.svc_media_sign_check(p_user uuid, p_paths text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct p), '[]'::jsonb)
    from unnest(coalesce(p_paths[1:100], '{}'::text[])) p
   where dek.can_read_object_as(p_user, p)
$$;

drop policy if exists dek_media_read on storage.objects;
create policy dek_media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and dek.can_write_object(name));

-- 12 ----------------------------------------------------------------------------
create or replace function dek.on_server_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.name, new.description, new.icon_emoji, new.position, new.join_policy, new.archived_at)
     is distinct from (old.name, old.description, old.icon_emoji, old.position, old.join_policy, old.archived_at) then
    perform dek.emit_many(
      array['s:' || new.id::text] || array(
        select distinct 'u:' || cm.user_id::text
          from dek.channel_members cm join dek.channels c on c.id = cm.channel_id
         where c.server_id = new.id
           and not exists (select 1 from dek.server_members sm where sm.server_id = new.id and sm.user_id = cm.user_id)),
      'server.upd',
      jsonb_build_object('server', jsonb_build_object(
        'id', new.id, 'org_id', new.org_id, 'name', new.name, 'description', new.description,
        'icon_emoji', new.icon_emoji, 'position', new.position, 'join_policy', new.join_policy,
        'archived', new.archived_at is not null)));
  end if;
  return new;
end $$;
drop trigger if exists dek_server_changed on dek.servers;
create trigger dek_server_changed after update on dek.servers
  for each row execute function dek.on_server_changed();

create or replace function dek.on_org_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.name, new.short_name, new.brand_color, new.logo_path, new.settings, new.archived_at)
     is distinct from (old.name, old.short_name, old.brand_color, old.logo_path, old.settings, old.archived_at) then
    perform dek.emit_many(
      array(select 'u:' || m.user_id::text from dek.org_members m where m.org_id = new.id and m.status = 'active'),
      'org.upd',
      jsonb_build_object('org', jsonb_build_object(
        'id', new.id, 'name', new.name, 'short_name', new.short_name, 'brand_color', new.brand_color,
        'logo_path', new.logo_path, 'settings', dek.org_settings(new), 'archived', new.archived_at is not null)));
  end if;
  return new;
end $$;
drop trigger if exists dek_org_changed on dek.orgs;
create trigger dek_org_changed after update on dek.orgs
  for each row execute function dek.on_org_changed();

create or replace function dek.on_channel_member_self()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.notify, new.muted_until, new.hidden) is distinct from (old.notify, old.muted_until, old.hidden) then
    perform dek.emit_user(new.user_id, 'chan.self', jsonb_build_object(
      'channel_id', new.channel_id, 'notify', new.notify, 'muted_until', new.muted_until, 'hidden', new.hidden));
  end if;
  return new;
end $$;
drop trigger if exists dek_channel_member_self on dek.channel_members;
create trigger dek_channel_member_self after update of notify, muted_until, hidden on dek.channel_members
  for each row execute function dek.on_channel_member_self();
