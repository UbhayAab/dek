// Database test harness. Every test runs inside one transaction that is ALWAYS
// rolled back, against the real project: real RLS, real grants, real functions,
// nothing left behind. Calls go through the same path the browser uses (role
// authenticated or anon, JWT claims in request.jwt.claims), so a missing grant or a
// leaky access check fails here exactly as it would in production.
//
//   import { test } from 'node:test';
//   import { tx, expectError } from './_harness.mjs';
//   test('stranger cannot read', () => tx(async (db) => {
//     const f = await db.fixture();                  // org, server, channels, people
//     await expectError(db.call(f.stranger, 'list_messages', { p_channel: f.general }), 'not_found');
//   }));
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after } from 'node:test';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { env, pgConfig } from '../../tools/lib/env.mjs';

// Tests run on the branch "test", never on production (capacity audit 2026-10-04: the
// suite had put 84,385 rolled-back transactions and their dead rows into production).
// Production only with DEK_TESTS_ON_PRODUCTION=1, for a deliberate one-off check.
function target() {
  if (process.env.DEK_TESTS_ON_PRODUCTION === '1') return 'production';
  if (process.env.DEK_DB_TARGET && process.env.DEK_DB_TARGET !== 'test') {
    throw new Error('the test suite runs on the test branch only (set DEK_TESTS_ON_PRODUCTION=1 to override)');
  }
  return 'test';
}

let pool = null;
function getPool() {
  pool ??= new pg.Pool({ ...pgConfig(target()), max: 3, application_name: 'dek-tests' });
  return pool;
}

// Supabase creates realtime.messages partitions (today and the next few days) only when a
// realtime client connects to the project. On a branch nobody uses, today's partition can
// be missing, and every event a test emits would vanish: one connection attempt (even a
// refused join) creates them. Checked once per run.
let partitions = null;
function ensureRealtimePartitions() {
  partitions ??= (async () => {
    if (target() !== 'test') return;
    const today = `messages_${new Date().toISOString().slice(0, 10).replace(/-/g, '_')}`;
    const has = async () => (await getPool().query(
      `select exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
                       where i.inhparent = 'realtime.messages'::regclass and c.relname = $1) ok`, [today])).rows[0].ok;
    if (await has()) return;
    const e = env();
    if (!e.TEST_SUPABASE_URL || !e.TEST_PUBLISHABLE_KEY) throw new Error('TEST_SUPABASE_URL and TEST_PUBLISHABLE_KEY missing: run node tools/create-test-branch.mjs');
    const sb = createClient(e.TEST_SUPABASE_URL, e.TEST_PUBLISHABLE_KEY, { auth: { persistSession: false } });
    sb.channel('dek-test-warmup').subscribe();
    for (let i = 0; i < 30 && !(await has()); i += 1) await new Promise((r) => setTimeout(r, 2000));
    await sb.removeAllChannels();
    if (!(await has())) throw new Error(`realtime partition ${today} still missing on the test branch`);
  })();
  return partitions;
}
after(async () => {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
});

export class DekError extends Error {
  constructor(code, hint, sqlstate) {
    super(code);
    this.code = code;
    this.hint = hint;
    this.sqlstate = sqlstate;
  }
}

export async function expectError(promise, code) {
  try {
    await promise;
  } catch (e) {
    // DekError carries the machine code in .code; a raw pg error from db.q() carries
    // it in .message (dek.err puts the code in the message, SQLSTATE P0001 in .code).
    const got = e instanceof DekError ? e.code : e.message;
    if (code && got !== code) {
      throw new Error(`expected error "${code}", got "${got}"${e.hint ? ` (${e.hint})` : ''}`);
    }
    return e;
  }
  throw new Error(`expected error "${code}", but the call succeeded`);
}

export async function tx(fn) {
  await ensureRealtimePartitions();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '30s'");
    // Candidate regressions use normal local migration bytes inside this same
    // rollback transaction. Never persist them or permit this mode on production.
    if (process.env.DEK_TEST_MIGRATIONS) {
      if (target() !== 'test') throw new Error('candidate migration tests require the dedicated test branch');
      for (const name of process.env.DEK_TEST_MIGRATIONS.split(',')) {
        if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) throw new Error('invalid test migration filename');
        await client.query(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      }
      await client.query('call dek_meta.lockdown()');
    }
    return await fn(new Db(client));
  } finally {
    try { await client.query('rollback'); } catch { /* connection already broken */ }
    client.release();
  }
}

class Db {
  constructor(client) {
    this.c = client;
    this.n = 0;
  }

  async q(sql, params = []) {
    return (await this.c.query(sql, params)).rows;
  }

  async one(sql, params = []) {
    return (await this.q(sql, params))[0];
  }

  // Raw SQL that is EXPECTED to fail sometimes: a savepoint keeps the transaction
  // usable after the error (otherwise everything after it is 25P02).
  async safe(sql, params = []) {
    const sp = `sp_${++this.n}`;
    await this.c.query(`savepoint ${sp}`);
    try {
      const res = await this.c.query(sql, params);
      await this.c.query(`release savepoint ${sp}`);
      return res.rows;
    } catch (e) {
      await this.c.query(`rollback to savepoint ${sp}`);
      throw e;
    }
  }

  // An auth user (and, through the auth trigger, its profile and prefs).
  async user(name = 'Test User', email = null) {
    const id = randomUUID();
    const mail = email ?? `t-${id.slice(0, 8)}@dek-test.invalid`;
    await this.q(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                               raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(),
               '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('display_name', $3::text),
               now(), now())`,
      [id, mail, name]);
    return id;
  }

  // Call api.<fn> as `uid` (null = anonymous) with named arguments. Returns the
  // function's jsonb result. Errors come back as DekError with the machine code.
  async call(uid, fn, args = {}) {
    if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`bad function name ${fn}`);
    const keys = Object.keys(args);
    for (const k of keys) if (!/^p_[a-z0-9_]+$/.test(k)) throw new Error(`bad argument name ${k}`);
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const values = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    const claims = uid
      ? JSON.stringify({ sub: uid, role: 'authenticated', aud: 'authenticated' })
      : JSON.stringify({ role: 'anon' });
    const sp = `sp_${++this.n}`;
    await this.c.query(`savepoint ${sp}`);
    try {
      await this.c.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await this.c.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
      const res = await this.c.query(`select api.${fn}(${named}) as result`, values);
      await this.c.query('reset role');
      await this.c.query(`release savepoint ${sp}`);
      return res.rows[0]?.result;
    } catch (e) {
      await this.c.query(`rollback to savepoint ${sp}`);
      await this.c.query('reset role');
      throw new DekError(e.message, e.hint, e.code);
    }
  }

  // Run raw SQL as a user (for policy checks such as realtime.messages and
  // storage.objects). Returns rows.
  async as(uid, sql, params = []) {
    const sp = `sp_${++this.n}`;
    await this.c.query(`savepoint ${sp}`);
    try {
      await this.c.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: uid, role: 'authenticated', aud: 'authenticated' })]);
      await this.c.query('set local role authenticated');
      const res = await this.c.query(sql, params);
      await this.c.query('reset role');
      await this.c.query(`release savepoint ${sp}`);
      return res.rows;
    } catch (e) {
      await this.c.query(`rollback to savepoint ${sp}`);
      await this.c.query('reset role');
      throw new DekError(e.message, e.hint, e.code);
    }
  }

  // ---------------------------------------------------------------- fixtures
  // Written straight into dek.* as the owner, so builders can test their own
  // functions without depending on each other's.

  async org(name = 'Test Org', { owner = null } = {}) {
    const slug = `t-${randomUUID().slice(0, 12)}`;
    const o = await this.one(
      'insert into dek.orgs (slug, name, created_by) values ($1, $2, $3) returning id', [slug, name, owner]);
    if (owner) await this.member(o.id, owner, 'owner');
    return o.id;
  }

  async member(org, user, role = 'member', status = 'active') {
    await this.q(
      `insert into dek.org_members (org_id, user_id, role, status) values ($1, $2, $3, $4)
       on conflict (org_id, user_id) do update set role = excluded.role, status = excluded.status`,
      [org, user, role, status]);
  }

  async server(org, name = 'Team', { members = [], admins = [], moderators = [], joinPolicy = 'invite' } = {}) {
    const s = await this.one(
      'insert into dek.servers (org_id, name, join_policy) values ($1, $2, $3) returning id', [org, name, joinPolicy]);
    for (const u of admins) await this.serverMember(s.id, u, 'admin');
    for (const u of moderators) await this.serverMember(s.id, u, 'moderator');
    for (const u of members) await this.serverMember(s.id, u, 'member');
    return s.id;
  }

  async serverMember(server, user, role = 'member') {
    await this.q(
      `insert into dek.server_members (server_id, user_id, org_id, role)
       select $1, $2, s.org_id, $3 from dek.servers s where s.id = $1
       on conflict (server_id, user_id) do update set role = excluded.role`,
      [server, user, role]);
  }

  async channel(server, name = 'general', { visibility = 'public', kind = 'text', members = [], owner = null,
                                             postingPolicy = 'everyone', allowReplies = true } = {}) {
    const c = await this.one(
      `insert into dek.channels (org_id, server_id, kind, name, visibility, posting_policy, allow_replies, created_by)
       select s.org_id, s.id, $2, $3, $4, $5, $6, $7 from dek.servers s where s.id = $1 returning id`,
      [server, kind, name, visibility, postingPolicy, allowReplies, owner]);
    if (owner) await this.channelMember(c.id, owner, 'owner');
    for (const u of members) await this.channelMember(c.id, u);
    return c.id;
  }

  async channelMember(channel, user, role = 'member') {
    await this.q(
      `insert into dek.channel_members (channel_id, user_id, org_id, role)
       select $1, $2, c.org_id, $3 from dek.channels c where c.id = $1
       on conflict (channel_id, user_id) do update set role = excluded.role`,
      [channel, user, role]);
  }

  async dm(org, a, b) {
    const key = `${org}:${[a, b].sort().join(':')}`;
    const c = await this.one(
      `insert into dek.channels (org_id, kind, visibility, dm_key) values ($1, 'dm', 'private', $2) returning id`,
      [org, key]);
    await this.channelMember(c.id, a);
    await this.channelMember(c.id, b);
    return c.id;
  }

  // A message inserted directly (seq allocated the real way).
  async message(channel, author, body = 'hello', { root = null } = {}) {
    return this.one(
      `insert into dek.messages (org_id, channel_id, seq, author_id, body, thread_root_id, in_timeline)
       select c.org_id, c.id, dek.allocate_seq(c.id, $4::uuid is null), $2, $3, $4, $4::uuid is null
         from dek.channels c where c.id = $1
       returning id, seq`,
      [channel, author, body, root]);
  }

  // The standard world most tests need:
  //   org JCF: owner, admin, alice, bob (members of server Medical), carol (org member,
  //   not in Medical, added to the private Grants channel only), guest (org guest,
  //   added to Grants), suspended (suspended org member, in Medical)
  //   org SS (the other tenant): eve
  //   stranger: no org at all
  async fixture() {
    const owner = await this.user('Owner');
    const admin = await this.user('Admin');
    const alice = await this.user('Alice');
    const bob = await this.user('Bob');
    const carol = await this.user('Carol');
    const guest = await this.user('Guest');
    const suspended = await this.user('Suspended');
    const eve = await this.user('Eve');
    const stranger = await this.user('Stranger');

    const org = await this.org('JCF Test', { owner });
    await this.member(org, admin, 'admin');
    await this.member(org, alice);
    await this.member(org, bob);
    await this.member(org, carol);
    await this.member(org, guest, 'guest');
    await this.member(org, suspended, 'member', 'suspended');

    const otherOrg = await this.org('Safalta Test', { owner: eve });

    const medical = await this.server(org, 'Medical Partnerships', {
      admins: [owner], members: [admin, alice, bob, suspended] });
    const tech = await this.server(org, 'Tech', { members: [carol] });
    const general = await this.channel(medical, 'general', { members: [owner, admin, alice, bob, suspended] });
    const grants = await this.channel(medical, 'grants', {
      visibility: 'private', owner: alice, members: [carol, guest] });
    const secret = await this.channel(medical, 'leadership', { visibility: 'private', owner: owner });
    const techGeneral = await this.channel(tech, 'general', { members: [carol] });
    const otherServer = await this.server(otherOrg, 'SS Team', { admins: [eve] });
    const otherChannel = await this.channel(otherServer, 'general', { members: [eve] });
    const dmAliceBob = await this.dm(org, alice, bob);

    return {
      owner, admin, alice, bob, carol, guest, suspended, eve, stranger,
      org, otherOrg, medical, tech, otherServer,
      general, grants, secret, techGeneral, otherChannel, dmAliceBob,
    };
  }
}
