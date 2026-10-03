#!/usr/bin/env node
// Load harness for the PRD's gates (DEKA01, DEKA02, "Load and experience acceptance").
// Synthetic users only (load-NNNN@dek-test.invalid in org "Dek Load"), never real people.
//
//   node tools/load/run.mjs --setup 500 --servers 10     create the load world
//   node tools/load/run.mjs --scenario signin --users 60
//   node tools/load/run.mjs --scenario sustained --users 300 --minutes 60 --rate 1
//   node tools/load/run.mjs --scenario reconnect --users 500 --minutes 3
//   node tools/load/run.mjs --wipe                        delete the load world
//
// Virtual users are split over worker processes (tools/load/worker.mjs). Each one signs in
// for real, calls me and bootstrap, joins its realtime topics, opens #general, then sends
// at the configured org-wide rate and marks read. Measured: sign-in, bootstrap, join,
// send acknowledgement (durable, DEK06), live delivery to the other members, errors by
// code, database connections. At the end every acknowledged message is looked up in the
// database: an acknowledged message that is missing is a LOST message (zero tolerance).
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { ROOT, need, pgConfig } from '../lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const { SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY, DEK_QA_PASSWORD } =
  need('SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'DEK_QA_PASSWORD');
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const email = (i) => `load-${String(i).padStart(4, '0')}@dek-test.invalid`;

async function allLoadUsers() {
  const out = new Map();
  for (let page = 1; page < 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) if (u.email?.startsWith('load-') && u.email.endsWith('@dek-test.invalid')) out.set(u.email, u.id);
    if (data.users.length < 1000) break;
  }
  return out;
}

async function setup(n, servers) {
  const db = new pg.Client(pgConfig());
  await db.connect();
  try {
    let org = (await db.query("select id from dek.orgs where slug = 'dek-load'")).rows[0]?.id;
    if (!org) org = (await db.query("insert into dek.orgs (slug, name, short_name, brand_color) values ('dek-load', 'Dek Load', 'Load', '#B45309') returning id")).rows[0].id;
    const serverIds = [];
    const generals = [];
    for (let s = 0; s < servers; s += 1) {
      const name = `Load ${s + 1}`;
      let id = (await db.query('select id from dek.servers where org_id = $1 and name = $2', [org, name])).rows[0]?.id;
      if (!id) id = (await db.query("insert into dek.servers (org_id, name, join_policy) values ($1, $2, 'invite') returning id", [org, name])).rows[0].id;
      let ch = (await db.query("select id from dek.channels where server_id = $1 and name = 'general'", [id])).rows[0]?.id;
      if (!ch) ch = (await db.query("insert into dek.channels (org_id, server_id, kind, name, auto_join) values ($1, $2, 'text', 'general', true) returning id", [org, id])).rows[0].id;
      serverIds.push(id);
      generals.push(ch);
    }
    const existing = await allLoadUsers();
    const ids = [];
    const queue = Array.from({ length: n }, (_, i) => i + 1);
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const i = queue.shift();
        let id = existing.get(email(i));
        if (!id) {
          for (let attempt = 0; attempt < 5 && !id; attempt += 1) {
            const { data, error } = await admin.auth.admin.createUser({
              email: email(i), password: DEK_QA_PASSWORD, email_confirm: true, user_metadata: { display_name: `Load User ${i}` } });
            if (error) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            else id = data.user.id;
          }
        }
        if (id) ids[i - 1] = id;
      }
    });
    await Promise.all(workers);
    for (let i = 0; i < n; i += 1) {
      const uid = ids[i];
      if (!uid) continue;
      const s = i % servers;
      await db.query("insert into dek.org_members (org_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [org, uid]);
      await db.query("insert into dek.server_members (server_id, user_id, org_id, role) values ($1, $2, $3, 'member') on conflict do nothing", [serverIds[s], uid, org]);
      await db.query('insert into dek.channel_members (channel_id, user_id, org_id) values ($1, $2, $3) on conflict do nothing', [generals[s], uid, org]);
    }
    console.log(`load world ready: org ${org}, ${servers} servers, ${ids.filter(Boolean).length} users`);
  } finally {
    await db.end();
  }
}

async function wipe() {
  const db = new pg.Client(pgConfig());
  await db.connect();
  try {
    await db.query("delete from dek.orgs where slug = 'dek-load'");
    const users = await allLoadUsers();
    let n = 0;
    for (const id of users.values()) {
      await admin.auth.admin.deleteUser(id);
      await db.query('delete from dek.notification_prefs where user_id = $1', [id]);
      await db.query('delete from dek.profiles where id = $1', [id]);
      n += 1;
    }
    console.log(`load world wiped: ${n} users`);
  } finally {
    await db.end();
  }
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

async function scenario(name) {
  const users = Number(args.users ?? 60);
  const minutes = Number(args.minutes ?? (name === 'signin' ? 2 : 5));
  const rate = Number(args.rate ?? 1);
  const workers = Number(args.workers ?? Math.min(8, Math.max(1, Math.ceil(users / 60))));
  const db = new pg.Client(pgConfig());
  await db.connect();
  const org = (await db.query("select id from dek.orgs where slug = 'dek-load'")).rows[0]?.id;
  if (!org) throw new Error('run --setup first');
  const ids = await allLoadUsers();
  const people = Array.from({ length: users }, (_, i) => ({ i: i + 1, email: email(i + 1), id: ids.get(email(i + 1)) })).filter((p) => p.id);
  if (people.length < users) throw new Error(`only ${people.length} load users exist; run --setup ${users}`);

  const results = { sends: [], signins: [], boots: [], joins: [], deliver: [], reconnect: [], errors: {}, accepted: [], received: 0, joinFailures: 0, sockets: 0 };
  const procs = [];
  const started = Date.now();
  const dbSamples = [];
  const sampler = setInterval(async () => {
    try {
      const r = await db.query("select count(*)::int total, count(*) filter (where application_name ilike '%postgrest%')::int rest, count(*) filter (where state = 'active')::int active from pg_stat_activity");
      dbSamples.push({ t: Math.round((Date.now() - started) / 1000), ...r.rows[0] });
    } catch { /* sampling must never stop the run */ }
  }, 10_000);

  const per = Math.ceil(people.length / workers);
  for (let w = 0; w < workers; w += 1) {
    const slice = people.slice(w * per, (w + 1) * per);
    if (!slice.length) continue;
    const child = fork(join(HERE, 'worker.mjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    procs.push(new Promise((resolve) => {
      child.on('message', (m) => {
        if (m.type === 'result') {
          for (const k of ['sends', 'signins', 'boots', 'joins', 'deliver', 'reconnect', 'accepted']) results[k].push(...m[k]);
          for (const [code, c] of Object.entries(m.errors)) results.errors[code] = (results.errors[code] ?? 0) + c;
          results.received += m.received;
          results.joinFailures += m.joinFailures;
          results.sockets += m.sockets;
          resolve();
        }
      });
      child.on('exit', () => resolve());
    }));
    child.send({
      type: 'start',
      cfg: {
        url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY, password: DEK_QA_PASSWORD, org, people: slice,
        scenario: name, durationMs: minutes * 60_000, ratePerUser: rate / people.length,
        rampMs: name === 'signin' ? 0 : Number(args.ramp ?? 60) * 1000, worker: w,
      },
    });
  }
  await Promise.all(procs);
  clearInterval(sampler);

  // Durability: every acknowledged message must exist.
  const accepted = results.accepted;
  let found = 0;
  for (let i = 0; i < accepted.length; i += 500) {
    const chunk = accepted.slice(i, i + 500);
    found += (await db.query('select count(*)::int n from dek.messages where id = any($1::uuid[])', [chunk])).rows[0].n;
  }
  await db.end();

  const summary = {
    scenario: name, users, minutes, rate, workers, at: new Date().toISOString(),
    signin_ms: { p50: pct(results.signins, 50), p95: pct(results.signins, 95), max: pct(results.signins, 100), n: results.signins.length },
    bootstrap_ms: { p50: pct(results.boots, 50), p95: pct(results.boots, 95), max: pct(results.boots, 100), n: results.boots.length },
    join_ms: { p50: pct(results.joins, 50), p95: pct(results.joins, 95), n: results.joins.length, failures: results.joinFailures },
    send_ack_ms: { p50: pct(results.sends, 50), p95: pct(results.sends, 95), p99: pct(results.sends, 99), max: pct(results.sends, 100), n: results.sends.length },
    delivery_ms: { p50: pct(results.deliver, 50), p95: pct(results.deliver, 95), p99: pct(results.deliver, 99), n: results.deliver.length },
    reconnect_ms: { p50: pct(results.reconnect, 50), p95: pct(results.reconnect, 95), max: pct(results.reconnect, 100), n: results.reconnect.length },
    acknowledged: accepted.length, found_in_db: found, lost: accepted.length - found,
    errors: results.errors,
    sockets_peak: results.sockets,
    db_connections_peak: dbSamples.reduce((m, s) => Math.max(m, s.total), 0),
    db_active_peak: dbSamples.reduce((m, s) => Math.max(m, s.active), 0),
  };
  const dir = join(ROOT, 'docs', 'load-results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${summary.at.replace(/[:.]/g, '-')}-${name}-${users}.json`);
  writeFileSync(file, JSON.stringify({ summary, dbSamples }, null, 1));
  const md = join(ROOT, 'docs', 'LOAD.md');
  if (!existsSync(md)) writeFileSync(md, '# Load results\n\nGenerated by tools/load/run.mjs. Synthetic users, real project.\n');
  appendFileSync(md, `\n## ${summary.at} ${name}, ${users} users, ${minutes} min, ${rate} msg/s\n\n\`\`\`json\n${JSON.stringify(summary, null, 1)}\n\`\`\`\n`);
  console.log(JSON.stringify(summary, null, 1));
}

if (args.setup) await setup(Number(args.setup), Number(args.servers ?? 10));
else if (args.wipe) await wipe();
else if (args.scenario) await scenario(args.scenario);
else console.log('usage: --setup N [--servers S] | --scenario signin|sustained|reconnect --users N [--minutes M] [--rate R] | --wipe');
process.exit(0);
