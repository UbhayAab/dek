#!/usr/bin/env node
// Cutover step 1 and rollback step 1 (docs/CUTOVER.md). Makes the LEGACY Dek API refuse
// browser calls so old tabs stop writing into the old database, and restores exactly
// what was there before.
//
//   node tools/cutover/legacy-freeze.mjs --status
//   node tools/cutover/legacy-freeze.mjs --freeze     save every grant, then revoke
//   node tools/cutover/legacy-freeze.mjs --unfreeze   replay the saved grants
//
// Grants cannot be restored by editing catalogs (no superuser on Supabase), so the
// snapshot stores aclexplode() rows and --unfreeze turns each into a GRANT statement.
// Runs through the Management API as postgres on the legacy project; prints counts only.
import { readFileSync } from 'node:fs';

const LEGACY = 'ybddogqphinruyunnuwx';
const PAT = readFileSync('C:/Users/abhay/Desktop/claude/dek-backend/.env.local', 'utf8').replace(/^\uFEFF/, '')
  .split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='))?.split('=').slice(1).join('=').trim();
if (!PAT) throw new Error('legacy SUPABASE_ACCESS_TOKEN not found in dek-backend/.env.local');

const ROLES = ['anon', 'authenticated'];

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${LEGACY}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`legacy SQL HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

async function authConfig(patch) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${LEGACY}/config/auth`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`legacy auth config HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function status() {
  const [r] = await sql(`
    select
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')) as fn_exec_by_authenticated,
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'm') and has_table_privilege('authenticated', c.oid, 'select')) as tables_readable_by_authenticated,
      (select count(*) from information_schema.tables where table_schema = 'dek_cutover' and table_name = 'saved_grants') as snapshot_exists`);
  console.log(r);
  return r;
}

async function freeze() {
  const [snap] = await sql("select count(*)::int n from information_schema.tables where table_schema = 'dek_cutover' and table_name = 'saved_grants'");
  if (snap.n) {
    const [rows] = await sql('select count(*)::int n from dek_cutover.saved_grants');
    if (rows.n) throw new Error('a snapshot already exists: unfreeze first (or inspect dek_cutover.saved_grants)');
  }
  await sql(`
    create schema if not exists dek_cutover;
    revoke all on schema dek_cutover from public, anon, authenticated;
    create table if not exists dek_cutover.saved_grants (
      kind text not null, object text not null, grantee text not null, privilege text not null,
      saved_at timestamptz not null default now());
    insert into dek_cutover.saved_grants (kind, object, grantee, privilege)
    select 'function', p.oid::regprocedure::text,
           case when a.grantee = 0 then 'public' else a.grantee::regrole::text end, a.privilege_type
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = 'public' and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'));
    insert into dek_cutover.saved_grants (kind, object, grantee, privilege)
    select 'table', c.oid::regclass::text, a.grantee::regrole::text, a.privilege_type
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm') and c.relacl is not null
       and a.grantee <> 0 and a.grantee::regrole::text in ('anon', 'authenticated');`);
  const [saved] = await sql("select count(*) filter (where kind = 'function')::int f, count(*) filter (where kind = 'table')::int t from dek_cutover.saved_grants");
  await sql(`
    revoke execute on all functions in schema public from public, ${ROLES.join(', ')};
    revoke all on all tables in schema public from ${ROLES.join(', ')};
    notify pgrst, 'reload schema';`);
  // no new legacy accounts either: a later --sessions-only pass must not import an
  // address someone else registered after the final copy
  await authConfig({ disable_signup: true });
  console.log(`frozen: saved ${saved.f} function grants and ${saved.t} table grants, then revoked them; legacy sign-up closed`);
  await status();
}

async function unfreeze() {
  const rows = await sql('select kind, object, grantee, privilege from dek_cutover.saved_grants');
  if (!rows.length) throw new Error('no snapshot to restore');
  const stmts = rows.map((r) => r.kind === 'function'
    ? `grant execute on function ${r.object} to ${r.grantee === 'public' ? 'public' : `"${r.grantee}"`};`
    : `grant ${r.privilege.toLowerCase()} on ${r.object} to "${r.grantee}";`);
  for (let i = 0; i < stmts.length; i += 200) await sql(stmts.slice(i, i + 200).join('\n'));
  await sql("delete from dek_cutover.saved_grants; notify pgrst, 'reload schema';");
  await authConfig({ disable_signup: false });
  console.log(`unfrozen: replayed ${stmts.length} grants; legacy sign-up reopened`);
  await status();
}

const mode = process.argv[2];
const run = { '--status': status, '--freeze': freeze, '--unfreeze': unfreeze }[mode];
if (!run) {
  console.error('usage: node tools/cutover/legacy-freeze.mjs --status | --freeze | --unfreeze');
  process.exit(2);
}
run().catch((e) => { console.error(e.message); process.exit(1); });
