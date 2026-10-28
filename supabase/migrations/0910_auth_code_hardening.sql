-- 0910: hardening after the 2026-10-04 security and client reviews. Owner: lead.
--
-- Sign-in codes (0902, 0903):
--  1. A code can only be tried together with the request token its requester got back
--     from send, so nobody else can burn or guess someone's code.
--  2. Codes are 8 digits (1 in 100,000,000), 3 tries each, at most 5 codes an hour and
--     30 wrong tries a day per address.
--  3. No enumeration: an address with no account (and no usable invite) gets the same
--     answer as a real one. A decoy row is written instead of a code: never mailed, never
--     verifiable, but counted by the same brakes.
--  4. A newcomer's invite must be one that preview_invite and accept_invite would honor
--     (dek.org_invite_problem), capped at 10 codes an hour per invite and 30 in total.
--  5. All counters are read and the row written under one advisory lock.
--  6. Addresses must be plain ASCII (no display names, commas or markup).
--  7. svc_auth_code_release puts back a code that was consumed when the session could
--     not be created, so a server hiccup does not cost the person their code.
-- Uploads: at most 20 unfinished reservations and 2 GB declared per uploader per day.
-- Realtime: one event id per emitted event (shared by every topic it reaches), so a
-- client that hears it on two topics can drop the copy.

alter table dek.auth_codes add column if not exists request_hash text check (request_hash ~ '^[0-9a-f]{64}$');
alter table dek.auth_codes add column if not exists invite_id uuid;
alter table dek.auth_codes add column if not exists decoy boolean not null default false;
create index if not exists auth_codes_invite_idx on dek.auth_codes (invite_id, created_at desc) where invite_id is not null;

create or replace function dek.auth_email_ok(p_email text)
returns boolean language sql immutable set search_path = '' as $$
  select char_length(p_email) <= 254
     and p_email ~ '^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*[.][a-z]{2,24}$'
     and p_email !~ '[.][.]'
     -- reserved and test domains never receive mail (RFC 2606, 6761)
     and p_email !~ '[.@](invalid|test|example|localhost|local)$'
     and p_email !~ '@example[.](com|org|net)$'
$$;

drop function if exists api.svc_auth_code_issue(text, text, text, text);
create or replace function api.svc_auth_code_issue(p_email text, p_code_hash text, p_request_hash text,
                                                   p_invite_code text default null, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_exists boolean;
  v_invite uuid;
  v_decoy  boolean := false;
  v_last   timestamptz;
  v_count  int;
begin
  if not dek.auth_email_ok(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_email');
  end if;
  if coalesce(p_code_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(7314010);

  v_exists := exists (select 1 from auth.users u where lower(u.email) = v_email and u.deleted_at is null
                        and (u.banned_until is null or u.banned_until < now()));
  if not v_exists then
    if p_invite_code is not null then
      select i.id into v_invite from dek.invites i
       where i.code_sha256 = sha256(convert_to(p_invite_code, 'UTF8'))
         and dek.org_invite_problem(i) is null
         and (i.email is null or lower(i.email) = v_email);
    end if;
    v_decoy := v_invite is null;
  end if;

  select max(c.created_at), count(*) into v_last, v_count
    from dek.auth_codes c where c.email = v_email and c.created_at > now() - interval '1 hour';
  if v_last > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'too_soon',
      'retry_after', ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::int);
  end if;
  if v_count >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if p_ip is not null and (select count(*) from dek.auth_codes c
                            where c.ip = p_ip and c.created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if v_invite is not null
     and ((select count(*) from dek.auth_codes c where c.invite_id = v_invite and c.created_at > now() - interval '1 hour') >= 10
          or (select count(*) from dek.auth_codes c where c.invite_id is not null and c.created_at > now() - interval '1 hour') >= 30) then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  if (select count(*) from dek.auth_codes c where c.created_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;

  insert into dek.auth_codes (email, code_hash, request_hash, ip, invite_id, decoy, expires_at, consumed_at)
  values (v_email, p_code_hash, p_request_hash, left(p_ip, 64), v_invite, v_decoy,
          now() + interval '10 minutes', case when v_decoy then now() end);
  return jsonb_build_object('ok', true, 'mail', not v_decoy);
end $$;

drop function if exists api.svc_auth_code_verify(text, text);
create or replace function api.svc_auth_code_verify(p_email text, p_code_hash text, p_request_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_fails int;
  c       dek.auth_codes;
begin
  if coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  select * into c from dek.auth_codes x
   where x.email = v_email and x.request_hash = p_request_hash
     and x.created_at > now() - interval '1 hour'
   for update;
  if not found or c.decoy or c.consumed_at is not null or c.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  select coalesce(sum(x.attempts), 0) into v_fails
    from dek.auth_codes x where x.email = v_email and x.created_at > now() - interval '24 hours';
  if c.attempts >= 3 or v_fails >= 30 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  end if;
  if c.code_hash <> coalesce(p_code_hash, '') then
    update dek.auth_codes set attempts = attempts + 1 where id = c.id;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 2 - c.attempts);
  end if;
  update dek.auth_codes set consumed_at = now() where id = c.id;
  return jsonb_build_object('ok', true,
    'existing', exists (select 1 from auth.users u where lower(u.email) = v_email and u.deleted_at is null));
end $$;

create or replace function api.svc_auth_code_release(p_email text, p_request_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update dek.auth_codes c set consumed_at = null
   where c.email = lower(btrim(coalesce(p_email, ''))) and c.request_hash = p_request_hash
     and not c.decoy and c.consumed_at > now() - interval '2 minutes' and c.expires_at > now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('released', v_n > 0);
end $$;

-- uploads ---------------------------------------------------------------------------
create index if not exists attachments_uploader_idx on dek.attachments (uploader_id, created_at desc);

create or replace function dek.attachment_quota()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.uploader_id is null or new.status is distinct from 'pending' then
    return new;
  end if;
  if (select count(*) from dek.attachments a
       where a.uploader_id = new.uploader_id and a.status = 'pending'
         and a.created_at > now() - interval '1 day') >= 20 then
    perform dek.err('rate_limited', 'Too many uploads are still unfinished. Finish or remove some, then try again.');
  end if;
  if (select coalesce(sum(a.size_bytes), 0) from dek.attachments a
       where a.uploader_id = new.uploader_id and a.created_at > now() - interval '1 day')
     + coalesce(new.size_bytes, 0) > 2147483648 then
    perform dek.err('rate_limited', 'You have reached the 2 GB daily upload limit. Try again tomorrow.');
  end if;
  return new;
end $$;

drop trigger if exists dek_attachment_quota on dek.attachments;
create trigger dek_attachment_quota before insert on dek.attachments
  for each row execute function dek.attachment_quota();

-- realtime ----------------------------------------------------------------------------
create or replace function dek.emit_many(p_topics text[], p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_eid uuid := gen_random_uuid();
begin
  if p_topics is null or cardinality(p_topics) = 0 then
    return;
  end if;
  insert into realtime.messages (id, topic, extension, event, payload, private)
  select gen_random_uuid(), t.topic, 'broadcast', p_event,
         coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('v', 1, 'eid', v_eid), true
    from (select distinct u as topic from unnest(p_topics) u where u is not null) t;
exception when others then
  raise warning 'dek.emit_many(% topics, %) failed: %', cardinality(p_topics), p_event, sqlerrm;
end $$;
