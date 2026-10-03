#!/usr/bin/env node
// End-to-end check of the live push chain, without touching anybody's real device:
//
//   1. a throwaway org, channel and two throwaway users (...@dek-test.invalid), the
//      reader's only device a fake web push endpoint that answers 410 Gone
//   2. push-dispatch dry run of a message intent: the routing, payload and preview,
//      nothing sent (the intent is inserted as done, so the trigger's own call
//      claims nothing)
//   3. api.send_test_notification as the reader, committed: the intent trigger's
//      pg_net call reaches push-dispatch, which sends to the fake endpoint
//   4. waits for the intent to finish and shows the delivery (expired, 410), the
//      device (revoked) and net._http_response (status 200) for that intent
//   5. deletes everything it created (--keep leaves it for inspection)
//
//   node tools/push-smoke.mjs [--keep]
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { need, pgConfig } from './lib/env.mjs';

const KEEP = process.argv.includes('--keep');
const { SUPABASE_PROJECT_REF: ref, DEK_INTERNAL_SECRET: secret } = need('SUPABASE_PROJECT_REF', 'DEK_INTERNAL_SECRET');
const FN = `https://${ref}.supabase.co/functions/v1/push-dispatch`;
const GONE = 'https://httpbin.org/status/410';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ ...pgConfig(), application_name: 'dek-push-smoke' });
const made = { users: [], org: null };
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function user(name) {
  const id = randomUUID();
  await q(`insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                                   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
           values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(),
                   '{"provider":"email","providers":["email"]}', jsonb_build_object('display_name', $3::text), now(), now())`,
    [id, `push-smoke-${id.slice(0, 8)}@dek-test.invalid`, name]);
  made.users.push(id);
  return id;
}

async function world() {
  const author = await user('Smoke Author');
  const reader = await user('Smoke Reader');
  const [{ id: org }] = await q("insert into dek.orgs (slug, name, short_name) values ($1, 'Push Smoke', 'SMOKE') returning id",
    [`push-smoke-${randomUUID().slice(0, 8)}`]);
  made.org = org;
  await q("insert into dek.org_members (org_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'member')", [org, author, reader]);
  const [{ id: server }] = await q("insert into dek.servers (org_id, name) values ($1, 'Smoke') returning id", [org]);
  await q('insert into dek.server_members (server_id, user_id, org_id) values ($1, $2, $3), ($1, $4, $3)', [server, author, org, reader]);
  const [{ id: channel }] = await q("insert into dek.channels (org_id, server_id, kind, name) values ($1, $2, 'text', 'general') returning id",
    [org, server]);
  await q('insert into dek.channel_members (channel_id, user_id, org_id) values ($1, $2, $3), ($1, $4, $3)', [channel, author, org, reader]);
  await q("update dek.notification_prefs set default_level = 'all' where user_id = $1", [reader]);
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const [{ id: device }] = await q(
    `insert into dek.push_devices (user_id, kind, endpoint, p256dh, auth, label, platform, last_seen_at)
     values ($1, 'webpush', $2, $3, $4, 'push-smoke fake endpoint', 'test', now()) returning id`,
    [reader, `${GONE}?smoke=${randomUUID()}`, ecdh.getPublicKey('base64url'), randomBytes(16).toString('base64url')]);
  return { author, reader, org, channel, device };
}

async function dryRun(w) {
  const [{ id: msg }] = await q(
    `insert into dek.messages (org_id, channel_id, seq, author_id, body, mentions)
     select $1, $2, dek.allocate_seq($2, true), $3, $4, array[$5]::uuid[] returning id`,
    [w.org, w.channel, w.author, `Push smoke for <@${w.reader}>:\n  please   ignore`, w.reader]);
  const [{ id }] = await q(
    `insert into dek.notification_intents (kind, org_id, message_id, channel_id, actor_id, status, processed_at)
     values ('message', $1, $2, $3, $4, 'done', now()) returning id`, [w.org, msg, w.channel, w.author]);
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dek-internal': secret },
    body: JSON.stringify({ intent_id: Number(id), dry_run: true }),
  });
  console.log(`\n== dry run, message intent ${id}: HTTP ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
  return Number(id);
}

async function realSend(w) {
  let r;
  await db.query('begin');
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: w.reader, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    [{ r }] = await q('select api.send_test_notification(p_device => $1) as r', [w.device]);
    await db.query('commit');
  } catch (e) {
    await db.query('rollback');   // leaves the connection usable for the cleanup
    throw e;
  }
  const id = Number(r.intent_id);
  console.log(`\n== send_test_notification committed: intent ${id}; the trigger's pg_net call is on its way`);
  let intent;
  for (let i = 0; i < 60; i += 1) {
    [intent] = await q('select status, attempts, last_error from dek.notification_intents where id = $1', [id]);
    if (['done', 'failed', 'expired'].includes(intent.status)) break;
    await sleep(1000);
  }
  let http = [];
  for (let i = 0; i < 20 && !http.length; i += 1) {
    http = await q(`select id, status_code, timed_out, error_msg, content, created from net._http_response
                     where content like $1 order by id desc limit 1`, [`%"intent_id":${id},%`]);
    if (!http.length) await sleep(1000);
  }
  const deliveries = await q('select status, reason, http_status from dek.notification_deliveries where intent_id = $1', [id]);
  const [device] = await q('select enabled, revoked_at, last_status, failure_count, last_attempt_at from dek.push_devices where id = $1', [w.device]);
  console.log('intent:', JSON.stringify(intent));
  console.log('deliveries:', JSON.stringify(deliveries));
  console.log('device:', JSON.stringify(device));
  console.log('net._http_response:', JSON.stringify(http[0] ?? null));
  return intent.status === 'done' && deliveries[0]?.status === 'expired' && deliveries[0]?.http_status === 410
    && device.enabled === false && device.revoked_at !== null && http[0]?.status_code === 200;
}

async function dispatchResponse(id) {
  const rows = await q(`select status_code, content from net._http_response where content like $1 order by id desc limit 1`,
    [`%"intent_id":${id},%`]);
  console.log(`net._http_response for the dry-run intent's own trigger call: ${JSON.stringify(rows[0] ?? null)}`);
}

async function cleanup() {
  if (KEEP) {
    console.log(`\n--keep: left org ${made.org} and users ${made.users.join(', ')}`);
    return;
  }
  if (made.org) await q('delete from dek.orgs where id = $1', [made.org]);
  if (made.users.length) {
    await q('delete from dek.notification_intents where target_user_id = any($1) or actor_id = any($1)', [made.users]);
    await q('delete from dek.rate_buckets where user_id = any($1)', [made.users]);
    await q('delete from dek.profiles where id = any($1)', [made.users]);
    await q('delete from auth.users where id = any($1)', [made.users]);
  }
  const [left] = await q(`select (select count(*) from dek.profiles where id = any($1))::int profiles,
                                 (select count(*) from dek.push_devices where user_id = any($1))::int devices,
                                 (select count(*) from dek.orgs where id = $2)::int orgs`, [made.users, made.org]);
  console.log(`\ncleanup: left behind ${JSON.stringify(left)}`);
}

let ok = false;
try {
  await db.connect();
  const w = await world();
  const dry = await dryRun(w);
  ok = await realSend(w);
  await dispatchResponse(dry);
  console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}: the 410 endpoint ${ok ? 'was revoked through the live pg_net -> push-dispatch chain' : 'did not complete the chain'}`);
} catch (e) {
  console.error(`push-smoke error: ${e.message}`);
} finally {
  try { await cleanup(); } finally { await db.end(); }
}
process.exit(ok ? 0 : 1);
