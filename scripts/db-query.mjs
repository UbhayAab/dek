// Run SQL against the live project through the Supabase Management API.
//
// The schema is not in this repo, so "what does this RPC actually do" can only
// be answered by asking the live database. The CLI needs a login and a link
// step; this needs the same two values scripts/deploy-fn.mjs already reads, and
// it never prints them.
//
// Usage:
//   node scripts/db-query.mjs "select proname from pg_proc limit 5"
//   node scripts/db-query.mjs -f supabase/migrations/0107_org_exit_and_invites.sql
//
// Reading a function body, which is the thing worth knowing here:
//   node scripts/db-query.mjs "select pg_get_functiondef(p.oid) from pg_proc p
//     join pg_namespace n on n.oid=p.pronamespace
//     where n.nspname='public' and p.proname='my_orgs'"
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('C:/Users/abhay/Desktop/claude/dek-backend/.env.local', 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const REF = (env.SUPABASE_PROJECT_REF || '').trim();
const TOKEN = (env.SUPABASE_ACCESS_TOKEN || '').trim();
if (!REF || !TOKEN) {
  console.error('Missing SUPABASE_PROJECT_REF or SUPABASE_ACCESS_TOKEN in dek-backend/.env.local');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('usage: node scripts/db-query.mjs "<sql>" | -f <file.sql>');
  process.exit(1);
}
const sql = argv[0] === '-f' ? readFileSync(argv[1], 'utf8') : argv[0];

const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await r.text();
if (!r.ok) {
  console.error(`HTTP ${r.status}: ${text.slice(0, 800)}`);
  process.exit(1);
}
try { console.log(JSON.stringify(JSON.parse(text), null, 1)); }
catch { console.log(text.slice(0, 8000)); }
