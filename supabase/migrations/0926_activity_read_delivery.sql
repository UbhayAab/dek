-- An exact Read receipt suppresses only this already-viewed ordinary alert.
-- Clear does not suppress delivery; newly addressed edit intents retain their read bypass.
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
    return;   -- deleted before dispatch, or a system line: nothing to say
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
  -- Rendered once; a body with channel links is rendered per recipient instead, so a
  -- channel name shows only to people who can read that channel.
  v_links := m.body ~ '<#[0-9a-fA-F-]{36}>';
  v_text := coalesce(nullif(dek.plat_render_body(m.body, m.org_id), ''), v_empty);
  return query
  with cand as (
    select cm.user_id as uid from dek.channel_members cm where cm.channel_id = m.channel_id
    union
    select tf.user_id from dek.thread_follows tf
     where m.thread_root_id is not null and tf.root_id = m.thread_root_id and tf.following
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
           dek.thread_read_seq(x.uid, m.thread_root_id) as read_reply_seq,
           x.uid = any (m.mentions) as direct
      from cand x
      join dek.profiles p on p.id = x.uid and p.deleted_at is null
      left join dek.notification_prefs n on n.user_id = x.uid
      left join dek.channel_members cm on cm.channel_id = m.channel_id and cm.user_id = x.uid
      left join dek.thread_follows tf on tf.root_id = m.thread_root_id and tf.user_id = x.uid
     where x.uid <> m.author_id
       and (i.target_user_id is null or x.uid = i.target_user_id)
       and not (x.uid = any(i.exclude_user_ids))
       and (i.target_user_id is not null or not exists (
         select 1 from dek.notification_intents ni where ni.kind='message' and ni.message_id=m.id
           and ni.target_user_id=x.uid and ni.created_at>=i.created_at))
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
       -- an intent aimed at one person (a mention added by an edit) skips the read check
       and (i.target_user_id is not null
            or not ((m.in_timeline and w.read_seq >= m.seq)
                    or (m.thread_root_id is not null and w.read_reply_seq >= m.seq)
                    or exists(select 1 from dek.activity_states a where a.user_id=w.uid and a.kind='mention' and a.target_id=m.id and a.read_at is not null)))
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
