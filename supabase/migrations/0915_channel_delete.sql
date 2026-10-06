-- 0915: delete a team channel for good (Fixboard #16). Owner: lead.
-- docs/CONTRACT.md section 2.10.
--
-- Archive (0102) keeps a channel read only. People also need to remove a channel they
-- made by mistake, such as a duplicate. The same people who may archive it (the channel
-- owner, a server admin, an org admin: dek.org_channel_for_manage) may delete it, and
-- must type its name, so a stray tap cannot delete one.
--
-- Everything inside goes with it (messages, reactions, mentions, files, calls: every
-- foreign key to dek.channels cascades). Each member gets access.revoked first, inside
-- the same transaction, so every open client drops the channel at once. File bytes stay
-- in Storage, unreachable: media-sign only signs paths whose attachment row still exists
-- and the bucket has no select policy (0909).

create or replace function api.delete_channel(p_channel uuid, p_confirm_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid;
  c         dek.channels;
  v_members uuid[];
  v_msgs    bigint;
begin
  v_uid := dek.require_uid();
  c := dek.org_channel_for_manage(v_uid, p_channel);
  perform dek.rate_hit(v_uid, 'channel_delete', 20, 3600);
  if p_confirm_name is null or lower(btrim(p_confirm_name)) <> lower(btrim(coalesce(c.name, ''))) then
    perform dek.err('invalid_input', 'Type the channel name exactly to delete it.');
  end if;
  select coalesce(array_agg(cm.user_id), '{}') into v_members
    from (select user_id from dek.channel_members where channel_id = c.id limit 5000) cm;
  select count(*) into v_msgs from (select 1 from dek.messages m where m.channel_id = c.id limit 100000) x;
  perform dek.emit_users(v_members, 'access.revoked', jsonb_build_object('scope', 'channel', 'id', c.id));
  perform dek.audit(c.org_id, 'channel.deleted', 'channel', c.id,
                    jsonb_build_object('name', c.name, 'server_id', c.server_id, 'members', cardinality(v_members), 'messages', v_msgs));
  delete from dek.channels x where x.id = c.id;
  return jsonb_build_object('channel_id', c.id, 'deleted', true);
end $$;
