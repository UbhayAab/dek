#!/usr/bin/env node
// The one way to change the database. Nothing is applied by hand.
//
//   node tools/db.mjs migrate          apply supabase/migrations/*.sql in filename order
//   node tools/db.mjs status           applied and pending migrations, and any drift
//   node tools/db.mjs sql "<sql>"      run SQL and print rows as JSON (inspection)
//
// Each migration runs in one transaction, is recorded in dek_meta.migrations with its
// sha256, and is followed by dek_meta.lockdown() (grants are code, not memory) and
// `notify pgrst, 'reload schema'` (a replaced function is invisible to PostgREST until
// then; forgetting it took sending down on 2026-09-22). A file whose bytes changed
// after it was applied stops the run: applied migrations are immutable. A file with
// the line `-- dek:no-transaction` runs outside a transaction (CREATE INDEX
// CONCURRENTLY), one statement per `;` at the end of a line.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT, pgConfig } from './lib/env.mjs';

const DIR = join(ROOT, 'supabase', 'migrations');

function files() {
  return readdirSync(DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
}

function sha(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

async function connect() {
  const client = new pg.Client(pgConfig());
  await client.connect();
  await client.query("set statement_timeout = '300s'");
  return client;
}

async function ensureLedger(client) {
  await client.query('create schema if not exists dek_meta');
  await client.query(`create table if not exists dek_meta.migrations (
    filename text primary key, sha256 text not null,
    applied_at timestamptz not null default now(), applied_by text not null default current_user)`);
}

async function applied(client) {
  const { rows } = await client.query('select filename, sha256 from dek_meta.migrations');
  return new Map(rows.map((r) => [r.filename, r.sha256]));
}

async function postMigration(client) {
  const { rows } = await client.query(
    "select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'dek_meta' and p.proname = 'lockdown'");
  if (rows.length) await client.query('call dek_meta.lockdown()');
  await client.query("notify pgrst, 'reload schema'");
}

async function migrate() {
  const client = await connect();
  try {
    await ensureLedger(client);
    const done = await applied(client);
    let count = 0;
    for (const f of files()) {
      const text = readFileSync(join(DIR, f), 'utf8');
      const hash = sha(text);
      if (done.has(f)) {
        if (done.get(f) !== hash) {
          throw new Error(`${f} changed after it was applied. Applied migrations are immutable: write a new one.`);
        }
        continue;
      }
      const started = Date.now();
      if (/^-- dek:no-transaction\s*$/m.test(text)) {
        for (const stmt of text.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s))) {
          await client.query(stmt);
        }
        await client.query('insert into dek_meta.migrations (filename, sha256) values ($1, $2)', [f, hash]);
      } else {
        await client.query('begin');
        try {
          await client.query(text);
          await client.query('insert into dek_meta.migrations (filename, sha256) values ($1, $2)', [f, hash]);
          await client.query('commit');
        } catch (e) {
          await client.query('rollback');
          const where = e.position ? ` at character ${e.position}` : '';
          throw new Error(`${f} failed${where}: ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
        }
      }
      await postMigration(client);
      count += 1;
      console.log(`applied ${f} in ${Date.now() - started} ms`);
    }
    if (!count) {
      await postMigration(client);
      console.log('nothing to apply; lockdown re-run');
    }
  } finally {
    await client.end();
  }
}

async function status() {
  const client = await connect();
  try {
    await ensureLedger(client);
    const done = await applied(client);
    for (const f of files()) {
      const hash = sha(readFileSync(join(DIR, f), 'utf8'));
      const state = !done.has(f) ? 'PENDING' : done.get(f) === hash ? 'applied' : 'DRIFT (file changed after apply)';
      console.log(`${state.padEnd(34)} ${f}`);
    }
    for (const f of done.keys()) {
      if (!files().includes(f)) console.log(`${'APPLIED BUT MISSING ON DISK'.padEnd(34)} ${f}`);
    }
  } finally {
    await client.end();
  }
}

async function sql(text) {
  const client = await connect();
  try {
    const res = await client.query(text);
    const results = Array.isArray(res) ? res : [res];
    for (const r of results) console.log(JSON.stringify(r.rows ?? [], null, 1));
  } finally {
    await client.end();
  }
}

const [cmd, arg] = process.argv.slice(2);
const run = { migrate, status, sql: () => sql(arg) }[cmd];
if (!run) {
  console.error('usage: node tools/db.mjs migrate | status | sql "<sql>"');
  process.exit(2);
}
run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
