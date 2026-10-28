-- 0918 was validated on the test branch before release. Keep its queries private
-- and expose cursors bound to this user, organization, inbox and unread choice.
-- Existing released list_threads/list_mentions signatures remain unchanged.
do $$ begin
  if to_regprocedure('api.list_thread_inbox(uuid,timestamptz,uuid,boolean,integer)') is not null then
    alter function api.list_thread_inbox(uuid, timestamptz, uuid, boolean, int) set schema dek;
  end if;
  if to_regprocedure('api.list_mention_inbox(uuid,timestamptz,uuid,boolean,integer)') is not null then
    alter function api.list_mention_inbox(uuid, timestamptz, uuid, boolean, int) set schema dek;
  end if;
end $$;

create or replace function dek.inbox_page(
  p_uid uuid, p_kind text, p_org uuid, p_cursor jsonb, p_unread_only boolean, p_limit int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_before timestamptz;
  v_before_id uuid;
  v_result jsonb;
  v_last jsonb;
  v_next jsonb;
begin
  perform dek.require_org(p_uid, p_org);
  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
       or p_cursor->>'v' is distinct from '1'
       or p_cursor->>'user' is distinct from p_uid::text
       or p_cursor->>'org' is distinct from p_org::text
       or p_cursor->>'kind' is distinct from p_kind
       or p_cursor->>'unread' is distinct from p_unread_only::text
       or p_cursor->>'order' is distinct from 'activity-desc-id-desc'
       or p_cursor->>'at' is null or p_cursor->>'id' is null then
      perform dek.err('invalid_input', 'This page belongs to another view. Refresh the inbox.');
    end if;
    begin
      v_before := (p_cursor->>'at')::timestamptz;
      v_before_id := (p_cursor->>'id')::uuid;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      perform dek.err('invalid_input', 'This page cursor is invalid. Refresh the inbox.');
    end;
    if not isfinite(v_before) then
      perform dek.err('invalid_input', 'This page cursor is invalid. Refresh the inbox.');
    end if;
  end if;
  if p_kind = 'threads' then
    v_result := dek.list_thread_inbox(p_org, v_before, v_before_id, p_unread_only, p_limit);
  elsif p_kind = 'mentions' then
    v_result := dek.list_mention_inbox(p_org, v_before, v_before_id, p_unread_only, p_limit);
  else
    perform dek.err('invalid_input', 'Unknown inbox.');
  end if;
  if (v_result->>'has_more')::boolean then
    v_last := v_result->'items'->(jsonb_array_length(v_result->'items') - 1);
    v_next := jsonb_build_object('v', 1, 'user', p_uid, 'org', p_org, 'kind', p_kind,
      'unread', p_unread_only, 'order', 'activity-desc-id-desc',
      'at', case when p_kind = 'threads' then v_last->>'activity_at' else v_last->'message'->>'created_at' end,
      'id', case when p_kind = 'threads' then v_last->'root'->>'id' else v_last->'message'->>'id' end);
  end if;
  return v_result || jsonb_build_object('next_cursor', v_next);
end $$;

create or replace function api.list_thread_inbox(
  p_org uuid, p_cursor jsonb default null, p_unread_only boolean default false, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := dek.require_uid();
  return dek.inbox_page(v_uid, 'threads', p_org, p_cursor, p_unread_only, p_limit);
end $$;

create or replace function api.list_mention_inbox(
  p_org uuid, p_cursor jsonb default null, p_unread_only boolean default false, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := dek.require_uid();
  return dek.inbox_page(v_uid, 'mentions', p_org, p_cursor, p_unread_only, p_limit);
end $$;
