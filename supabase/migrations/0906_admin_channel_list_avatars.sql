-- 0906: two requests from the admin screens. Owner: lead.
--
-- 1. list_channels(p_server, p_manage => true) gives server admins every channel of the
--    server, private ones they are not in included. They can already manage those
--    channels (0102 channel access 'manage'), but Server settings could not list them.
--    Names, settings and counts only: reading messages stays gated by can_read_channel.
--    Without p_manage nothing changes, so the sidebar and Browse still show a private
--    channel only to its members.
-- 2. Storage deletes an object only when the caller may also SELECT it; avatars had no
--    select policy, so replacing a picture left the old file behind.

drop function if exists api.list_channels(uuid);
create or replace function api.list_channels(p_server uuid, p_manage boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_access text;
  v_all    boolean := false;
  v_out    jsonb;
  s        dek.servers;
begin
  v_uid := dek.require_uid();
  if coalesce(p_manage, false) then
    s := dek.org_server_for_admin(v_uid, p_server);  -- not_found or forbidden otherwise
    v_all := true;
  else
    s := dek.org_find_server(v_uid, p_server);
  end if;
  v_access := dek.org_server_access(v_uid, s.id);
  if v_access is null and not v_all then
    perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
  end if;
  select coalesce(jsonb_agg(dek.channel_json(c, v_uid) order by c.position, lower(c.name), c.id), '[]'::jsonb)
    into v_out
    from (select x.id from dek.channels x
           where x.server_id = s.id
             and (v_all
                  or (v_access = 'member' and x.visibility = 'public')
                  or exists (select 1 from dek.channel_members cm where cm.channel_id = x.id and cm.user_id = v_uid))
           order by x.position, x.id
           limit 500) ids
    join dek.channels c on c.id = ids.id;
  return v_out;
end $$;

drop policy if exists dek_avatar_select on storage.objects;
create policy dek_avatar_select on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
