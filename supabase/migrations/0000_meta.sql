-- 0000: the migration ledger and the grants lockdown.
--
-- tools/db.mjs records every applied file here with its sha256 and refuses to run
-- if an applied file has changed since. After EVERY migration it calls
-- dek_meta.lockdown(), which makes grants a property of the code instead of a
-- line each author has to remember:
--
--   * nothing in schema dek or dek_meta is executable or readable by public, anon,
--     authenticated or service_role, except the four helpers that Storage and
--     Realtime policies call as the signed-in user;
--   * every function in schema api is executable by authenticated only, except
--     svc_* (service_role only) and the anon allow-list below.
--
-- New schemas get no default ACL in this project, so PostgreSQL's own default
-- (EXECUTE to PUBLIC on every new function) would otherwise apply. That default is
-- how Arc's `revoke ... from authenticated` closed nothing on 2026-09-15.

create schema if not exists dek_meta;
revoke all on schema dek_meta from public;

create table if not exists dek_meta.migrations (
  filename   text primary key,
  sha256     text not null,
  applied_at timestamptz not null default now(),
  applied_by text not null default current_user
);

create or replace procedure dek_meta.lockdown()
language plpgsql
set search_path = ''
as $$
declare
  r record;
  policy_helpers constant text[] := array['can_use_topic', 'can_read_object', 'can_write_object'];
  anon_api constant text[] := array['preview_invite'];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname, n.nspname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('dek', 'dek_meta', 'api')
       and p.prokind in ('f', 'p')
  loop
    execute format('revoke all on routine %s from public, anon, authenticated, service_role', r.sig);
    if r.nspname = 'dek' and r.proname = any (policy_helpers) then
      execute format('grant execute on routine %s to authenticated', r.sig);
    elsif r.nspname = 'api' and r.proname like 'svc\_%' then
      execute format('grant execute on routine %s to service_role', r.sig);
    elsif r.nspname = 'api' then
      execute format('grant execute on routine %s to authenticated', r.sig);
      if r.proname = any (anon_api) then
        execute format('grant execute on routine %s to anon', r.sig);
      end if;
    end if;
  end loop;

  for r in
    select c.oid::regclass as rel
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('dek', 'dek_meta', 'api')
       and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  loop
    execute format('revoke all on %s from public, anon, authenticated, service_role', r.rel);
  end loop;
end;
$$;
