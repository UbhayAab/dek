-- 0917: all active team servers are discoverable inside their organization (#53).
-- Directory metadata never grants server/channel membership or content access.
-- Existing join_policy and invitation approval semantics remain unchanged.

create or replace function dek.org_server_access(p_uid uuid, p_server uuid)
returns text language sql stable set search_path = '' as $$
  select case
           when sm.user_id is not null and om.role <> 'guest' then 'member'
           when exists (select 1 from dek.channel_members cm
                          join dek.channels c on c.id = cm.channel_id
                         where cm.user_id = p_uid and cm.org_id = s.org_id and c.server_id = s.id) then 'partial'
           when om.role in ('owner', 'admin') then 'browse'
           when om.role = 'member' and s.archived_at is null then 'browse'
         end
    from dek.servers s
    join dek.org_members om on om.org_id = s.org_id and om.user_id = p_uid and om.status = 'active'
    left join dek.server_members sm on sm.server_id = s.id and sm.user_id = p_uid
   where s.id = p_server
$$;

create or replace function api.list_servers(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_role text;
  v_out jsonb;
begin
  v_uid := dek.require_uid();
  v_role := dek.require_org(v_uid, p_org);
  select coalesce(jsonb_agg(dek.server_json(s, v_uid) order by s.position, lower(s.name), s.id), '[]'::jsonb)
    into v_out
    from (select x.id
            from dek.servers x
           where x.org_id = p_org
             and (v_role in ('owner', 'admin')
                  or (v_role = 'member' and x.archived_at is null)
                  or x.id in (select sm.server_id from dek.server_members sm
                               where sm.user_id = v_uid and sm.org_id = p_org)
                  or x.id in (select c.server_id from dek.channel_members cm
                                join dek.channels c on c.id = cm.channel_id
                               where cm.user_id = v_uid and cm.org_id = p_org and c.server_id is not null))
           order by x.position, x.id
           limit 200) ids
    join dek.servers s on s.id = ids.id;
  return v_out;
end $$;

-- Optional additive field: old installed clients keep the same policy enum.
create or replace function dek.server_json(s dek.servers, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'org_id', s.org_id, 'name', s.name, 'description', s.description,
    'icon_emoji', s.icon_emoji, 'position', s.position, 'join_policy', s.join_policy,
    'archived', s.archived_at is not null,
    'my_role', dek.server_role(p_uid, s.id),
    'access', dek.org_server_access(p_uid, s.id),
    'requested', exists (select 1 from dek.join_requests r
                         where r.server_id = s.id and r.user_id = p_uid and r.status = 'pending'),
    'member_count', (select count(*) from dek.server_members sm where sm.server_id = s.id))
$$;
