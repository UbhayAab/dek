#!/usr/bin/env node
// Creates (or finds) the persistent Supabase branch "test" of the Dek project, the only
// place the database test suite may run (capacity audit 2026-10-04: the suite had run
// 84,385 rolled-back transactions against production). Writes its connection settings
// to .env.local as TEST_POOLER_HOST, TEST_POOLER_USER, TEST_DB_PASSWORD, TEST_PROJECT_REF
// and never prints a secret. Cost: one Micro branch, about USD 10 a month (docs/COSTS.md).
//   node tools/create-test-branch.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, need } from './lib/env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { SUPABASE_PROJECT_REF: ref, SUPABASE_POOLER_HOST: pooler } = need('SUPABASE_PROJECT_REF', 'SUPABASE_POOLER_HOST');
const PAT = env().SUPABASE_ACCESS_TOKEN;
const api = async (method, path, body) => {
  const res = await fetch(`https://api.supabase.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

let branch = (await api('GET', `/v1/projects/${ref}/branches`)).find((b) => b.name === 'test');
if (!branch) {
  branch = await api('POST', `/v1/projects/${ref}/branches`, { branch_name: 'test', persistent: true });
  console.log(`created branch test (${branch.id})`);
} else {
  console.log(`branch test exists (${branch.id})`);
}

let detail = null;
for (let i = 0; i < 60; i += 1) {
  detail = await api('GET', `/v1/branches/${branch.id}`).catch(() => null);
  const status = detail?.status ?? 'unknown';
  if (detail?.db_pass && detail?.ref && /ACTIVE|FUNCTIONS|MIGRATIONS_PASSED|HEALTHY/i.test(status)) break;
  if (i % 6 === 0) console.log(`waiting for the branch: ${status}`);
  await new Promise((r) => setTimeout(r, 10_000));
}
if (!detail?.db_pass || !detail?.ref) throw new Error('the branch did not become ready in 10 minutes');

const file = join(ROOT, '.env.local');
let text = readFileSync(file, 'utf8');
const set = (k, v) => {
  const line = `${k}=${v}`;
  text = new RegExp(`^${k}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
};
set('TEST_PROJECT_REF', detail.ref);
set('TEST_POOLER_HOST', pooler);
set('TEST_POOLER_USER', `postgres.${detail.ref}`);
set('TEST_DB_PASSWORD', detail.db_pass);
// The publishable key lets the test harness open one realtime connection: Supabase only
// creates realtime.messages partitions for a project a realtime client has connected to.
const keys = await api('GET', `/v1/projects/${detail.ref}/api-keys?reveal=true`);
const publishable = (keys ?? []).find((k) => k.type === 'publishable')?.api_key
  ?? (keys ?? []).find((k) => k.name === 'anon')?.api_key;
if (!publishable) throw new Error('the branch has no publishable or anon key');
set('TEST_SUPABASE_URL', `https://${detail.ref}.supabase.co`);
set('TEST_PUBLISHABLE_KEY', publishable);
writeFileSync(file, text);

// The project-level pieces the database expects (tools/setup-project.mjs does the same on
// production): where its functions live, and the internal secret pg_net sends with. The
// branch runs no functions, so these requests simply fail there; the secret is random and
// belongs to the branch only. Skipped until the migrations have created dek.settings.
const { default: pg } = await import('pg');
const { pgConfig } = await import('./lib/env.mjs');
const db = new pg.Client({ ...pgConfig('test'), application_name: 'dek-branch-setup' });
await db.connect();
try {
  const ready = (await db.query("select to_regclass('dek.settings') is not null as ok")).rows[0].ok;
  if (!ready) {
    console.log('apply the migrations first (DEK_DB_TARGET=test npm run db:migrate), then run this again');
  } else {
    await db.query(`insert into dek.settings (key, value) values ('functions_url', $1)
                    on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [`https://${detail.ref}.supabase.co/functions/v1`]);
    const has = (await db.query("select 1 from vault.secrets where name = 'dek_internal_secret'")).rowCount > 0;
    if (!has) {
      const { randomBytes } = await import('node:crypto');
      await db.query("select vault.create_secret($1, 'dek_internal_secret', 'test branch only')", [randomBytes(32).toString('base64url')]);
    }
    console.log('branch settings: functions_url and vault.dek_internal_secret in place');
  }
} finally {
  await db.end();
}
console.log(`branch ready: ref ${detail.ref}, status ${detail.status}; TEST_* settings written to .env.local`);
