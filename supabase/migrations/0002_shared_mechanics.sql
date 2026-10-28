-- 0002: mechanics more than one builder needs. Owner: lead. Builders CALL these and
-- never re-create them (one owner per function).
--
--   dek.soft_delete_message      used by api.delete_message [msg] and api.resolve_report [org]
--   dek.revoke_channel_membership, dek.revoke_server_membership, dek.revoke_org_membership
--                                used by [org] removal and leave functions and by
--                                api.request_account_deletion [plat]

-- One message to a tombstone. A moderator removal keeps the original text in audit_log
-- for review (only org admins can read it there); a self delete purges it.
create or replace function dek.soft_delete_message(p_message uuid, p_actor uuid, p_reason text, p_moderation boolean)
returns dek.messages language plpgsql security definer set search_path = '' as $$
declare
  m      dek.messages;
  v_root dek.messages;
begin
  select * into m from dek.messages where id = p_message for update;
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

-- Leave one channel. For a public channel of a server the person still belongs to,
-- this is only "leave the sidebar": they can still read it, so no revocation event.
create or replace function dek.revoke_channel_membership(p_channel uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from dek.channel_members where channel_id = p_channel and user_id = p_user;
  delete from dek.thread_follows where channel_id = p_channel and user_id = p_user;
  if dek.can_read_channel(p_user, p_channel) then
    perform dek.emit_user(p_user, 'member.upd',
      jsonb_build_object('scope', 'channel', 'id', p_channel, 'user_id', p_user, 'change', 'removed'));
  else
    perform dek.emit_user(p_user, 'access.revoked', jsonb_build_object('scope', 'channel', 'id', p_channel));
  end if;
end $$;

-- Leave or be removed from a team server: the server membership and every channel
-- membership inside it go (DEKA06). People who were only ever channel members of
-- that server (cross-team) are not touched; they are removed per channel.
create or replace function dek.revoke_server_membership(p_server uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from dek.server_members where server_id = p_server and user_id = p_user;
  delete from dek.thread_follows tf
   using dek.channels c
   where c.id = tf.channel_id and c.server_id = p_server and tf.user_id = p_user;
  delete from dek.channel_members cm
   using dek.channels c
   where c.id = cm.channel_id and c.server_id = p_server and cm.user_id = p_user;
  perform dek.emit_user(p_user, 'access.revoked', jsonb_build_object('scope', 'server', 'id', p_server));
  perform dek.emit_many(array['s:' || p_server::text], 'member.upd',
    jsonb_build_object('scope', 'server', 'id', p_server, 'user_id', p_user, 'change', 'removed'));
end $$;

-- Leave or be removed from an organization. Server and channel memberships go; DM
-- memberships stay so the other person's history still shows who they talked to,
-- but every access check requires an active org membership, so nothing in this org
-- is readable or notifiable any more.
create or replace function dek.revoke_org_membership(p_org uuid, p_user uuid, p_ban boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select sm.server_id from dek.server_members sm where sm.org_id = p_org and sm.user_id = p_user loop
    perform dek.revoke_server_membership(r.server_id, p_user);
  end loop;
  delete from dek.channel_members cm
   using dek.channels c
   where c.id = cm.channel_id and c.org_id = p_org and c.kind in ('text', 'audio') and cm.user_id = p_user;
  delete from dek.thread_follows where org_id = p_org and user_id = p_user;
  delete from dek.org_members where org_id = p_org and user_id = p_user;
  if p_ban then
    insert into dek.org_bans (org_id, user_id, reason, banned_by)
    values (p_org, p_user, left(p_reason, 500), auth.uid())
    on conflict (org_id, user_id) do update set reason = excluded.reason, banned_by = excluded.banned_by;
  end if;
  perform dek.emit_user(p_user, 'access.revoked', jsonb_build_object('scope', 'org', 'id', p_org));
end $$;
