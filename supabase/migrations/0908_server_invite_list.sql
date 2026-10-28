-- 0908: server admins who are not org admins could create invite links for their team
-- server but list only the ones they made themselves. list_invites(p_org, p_server)
-- shows a server admin every invite of that server, so they can see and revoke what is
-- out there (revoke_invite already allows them). Without p_server nothing changes.
-- Owner: lead.

drop function if exists api.list_invites(uuid);
create or replace function api.list_invites(p_org uuid, p_server uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_admin boolean;
  v_all   boolean;
  v_items jsonb;
  s       dek.servers;
begin
  v_uid := dek.require_uid();
  v_admin := dek.require_org(v_uid, p_org) in ('owner', 'admin');
  v_all := v_admin;
  if p_server is not null then
    s := dek.org_server_for_admin(v_uid, p_server);  -- not_found or forbidden for others
    if s.org_id <> p_org then
      perform dek.err('not_found', 'That team server does not exist or you do not have access to it.');
    end if;
    v_all := true;
  end if;
  select coalesce(jsonb_agg(dek.org_invite_json(i) order by i.created_at desc, i.id), '[]'::jsonb)
    into v_items
    from (select x.id from dek.invites x
           where x.org_id = p_org
             and (p_server is null or x.server_id = p_server)
             and (v_all or x.created_by = v_uid)
           order by x.created_at desc
           limit 200) ids
    join dek.invites i on i.id = ids.id;
  return jsonb_build_object('items', v_items);
end $$;
