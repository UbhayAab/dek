-- 0902: Dek's own sign-in codes. Owner: lead.
--
-- Supabase Auth caps the emails it sends (including through the Send Email Hook) at
-- rate_limit_email_sent per hour for the WHOLE project: 2, and the API refuses to raise
-- it without custom SMTP. Two codes an hour would lock an office out. So codes are
-- issued here and mailed by the auth-code edge function through the JCF Mailer, the
-- way legacy Dek did for months; a verified code becomes a session through the admin
-- generateLink plus verifyOtp path, which sends no email.
--
-- Who may receive a code (the outbound mail rule: never mail an address with no reason
-- to believe it is real): an existing account, or a new person holding a valid invite
-- (a link invite, or a targeted invite to exactly that address). Brakes: one code per
-- address per 60 s, 10 per address per hour, 30 per client address per hour, 300 per
-- hour for the whole project. Codes live 10 minutes, 5 wrong tries burn a code, and only
-- an HMAC of (email, code) under a server secret is stored.

create table if not exists dek.auth_codes (
  id          bigint generated always as identity primary key,
  email       text not null check (char_length(email) <= 254),
  code_hash   text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  ip          text check (char_length(ip) <= 64),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  consumed_at timestamptz
);
create index if not exists auth_codes_email_idx on dek.auth_codes (email, created_at desc);
create index if not exists auth_codes_ip_idx on dek.auth_codes (ip, created_at desc) where ip is not null;
create index if not exists auth_codes_created_idx on dek.auth_codes (created_at);
alter table dek.auth_codes enable row level security;

create or replace function dek.auth_email_ok(p_email text)
returns boolean language sql immutable set search_path = '' as $$
  select p_email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]{2,}$'
     and char_length(p_email) <= 254
     -- reserved and test domains never receive mail (RFC 2606, 6761)
     and p_email !~ '[.@](invalid|test|example|localhost|local)$'
     and p_email !~ '@example[.](com|org|net)$'
$$;

create or replace function api.svc_auth_code_issue(p_email text, p_code_hash text, p_invite_code text default null,
                                                   p_ip text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_exists boolean;
  v_last   timestamptz;
  v_count  int;
begin
  if not dek.auth_email_ok(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_email');
  end if;
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  v_exists := exists (select 1 from auth.users u where lower(u.email) = v_email and u.deleted_at is null
                        and (u.banned_until is null or u.banned_until < now()));
  if not v_exists then
    if p_invite_code is null or not exists (
         select 1 from dek.invites i
          where i.code_sha256 = sha256(convert_to(p_invite_code, 'UTF8'))
            and i.revoked_at is null and i.expires_at > now()
            and (i.max_uses is null or i.use_count < i.max_uses)
            and (i.email is null or lower(i.email) = v_email)) then
      return jsonb_build_object('ok', false, 'reason', 'no_account');
    end if;
  end if;
  select max(c.created_at), count(*) into v_last, v_count
    from dek.auth_codes c where c.email = v_email and c.created_at > now() - interval '1 hour';
  if v_last > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'too_soon',
      'retry_after', ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::int);
  end if;
  if v_count >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if p_ip is not null and (select count(*) from dek.auth_codes c
                            where c.ip = p_ip and c.created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if (select count(*) from dek.auth_codes c where c.created_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  insert into dek.auth_codes (email, code_hash, ip, expires_at)
  values (v_email, p_code_hash, left(p_ip, 64), now() + interval '10 minutes');
  return jsonb_build_object('ok', true, 'existing', v_exists);
end $$;

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
  return jsonb_build_object('ok', true);
end $$;

-- prune now also forgets sign-in codes after a day
create or replace function dek.prune()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from dek.notification_deliveries where created_at < now() - interval '14 days';
  delete from dek.notification_intents
   where status in ('done', 'failed', 'expired') and created_at < now() - interval '7 days';
  delete from dek.rate_buckets where window_start < now() - interval '1 day';
  delete from dek.push_devices where revoked_at is not null and revoked_at < now() - interval '30 days';
  delete from dek.auth_codes where created_at < now() - interval '1 day';
  begin
    delete from cron.job_run_details where end_time < now() - interval '2 days';
  exception when others then
    raise warning 'dek.prune: cron history not pruned: %', sqlerrm;
  end;
end $$;
