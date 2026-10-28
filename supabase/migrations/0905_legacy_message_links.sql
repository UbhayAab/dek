-- 0905: old message links (#/m/<channel>/<legacy seq>) open the exact migrated message,
-- thread replies included. The migration renumbered seqs and kept the old one in
-- meta.legacy.seq (docs/migration/LEGACY-URLS.md). Owner: lead.

create index if not exists messages_legacy_seq_idx
  on dek.messages (channel_id, ((meta->'legacy'->>'seq')::bigint))
  where meta ? 'legacy';

create or replace function api.resolve_legacy_message(p_channel uuid, p_legacy_seq bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := dek.require_uid();
  m     dek.messages;
begin
  if p_channel is null or p_legacy_seq is null or p_legacy_seq < 0 then
    perform dek.err('invalid_input', 'channel and seq: required.');
  end if;
  -- one answer for "no such channel" and "not yours", so ids cannot be probed
  if not dek.can_read_channel(v_uid, p_channel) then
    perform dek.err('not_found', 'That message is not available.');
  end if;
  -- two merged DM conversations share low seqs; the older message wins
  select * into m from dek.messages x
   where x.channel_id = p_channel and x.meta ? 'legacy'
     and (x.meta->'legacy'->>'seq')::bigint = p_legacy_seq
   order by x.created_at, x.id
   limit 1;
  if not found then
    perform dek.err('not_found', 'That message is not available.');
  end if;
  return jsonb_build_object('org_id', m.org_id, 'channel_id', m.channel_id, 'message_id', m.id,
                            'thread_root_id', m.thread_root_id, 'deleted', m.deleted_at is not null);
end $$;
