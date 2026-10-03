-- 0907: two follow-ups. Owner: lead.
--
-- 1. Media reads go through the media-sign function (15 minute links after the access
--    check) since the web client switched to it. Direct Storage reads go back to the
--    0900 rule: only the uploader of a still-pending object. 0901 had reopened them as a
--    stopgap; with that policy a member could mint links of any lifetime themselves.
-- 2. The message menu must say Save or Unsave correctly. message_json is shared by every
--    viewer (realtime payloads), so it cannot carry a per-person flag. Instead the client
--    loads its saved ids once (list_saved_ids) and keeps them current from saved.upd,
--    which every save and unsave now sends to the person's own devices.

drop policy if exists dek_media_read on storage.objects;
create policy dek_media_read on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and dek.can_write_object(name));

create or replace function api.list_saved_ids(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := dek.require_uid();
  v_out jsonb;
begin
  perform dek.org_require_member(v_uid, p_org, 'That organization does not exist or you are not in it.');
  select coalesce(jsonb_agg(x.message_id order by x.created_at desc), '[]'::jsonb) into v_out
    from (select s.message_id, s.created_at from dek.saved_messages s
           where s.user_id = v_uid and s.org_id = p_org
           order by s.created_at desc
           limit 2000) x;
  return v_out;
end $$;

create or replace function dek.on_saved_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform dek.emit_user(new.user_id, 'saved.upd',
      jsonb_build_object('org_id', new.org_id, 'message_id', new.message_id, 'saved', true));
  else
    perform dek.emit_user(old.user_id, 'saved.upd',
      jsonb_build_object('org_id', old.org_id, 'message_id', old.message_id, 'saved', false));
  end if;
  return null;
end $$;

drop trigger if exists dek_saved_changed on dek.saved_messages;
create trigger dek_saved_changed after insert or delete on dek.saved_messages
  for each row execute function dek.on_saved_changed();
