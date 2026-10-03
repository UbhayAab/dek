-- 0903: public sign-up is switched off (disable_signup), so an invited newcomer's account
-- is created by the auth-code function through the admin API after a verified code.
-- svc_auth_code_verify now says whether the account already exists. Owner: lead.

create or replace function api.svc_auth_code_verify(p_email text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  c       dek.auth_codes;
begin
  select * into c from dek.auth_codes x
   where x.email = v_email and x.created_at > now() - interval '1 hour'
   order by x.created_at desc limit 1
   for update;
  if not found or c.consumed_at is not null or c.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if c.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  end if;
  if c.code_hash <> coalesce(p_code_hash, '') then
    update dek.auth_codes set attempts = attempts + 1 where id = c.id;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 4 - c.attempts);
  end if;
  update dek.auth_codes set consumed_at = now() where id = c.id;
  return jsonb_build_object('ok', true,
    'existing', exists (select 1 from auth.users u where lower(u.email) = v_email and u.deleted_at is null));
end $$;
