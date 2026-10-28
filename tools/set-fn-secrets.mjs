#!/usr/bin/env node
// Edge Function secrets for push-dispatch, through the Management API. Idempotent:
// a secret whose digest already matches is left alone. Prints names and digest
// verdicts, never a value.
//
//   node tools/set-fn-secrets.mjs            set what differs, then verify by digest
//   node tools/set-fn-secrets.mjs --check    report only
//
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  the legacy pair from ../dek-backend/.env.local
//     (or DEK_VAPID_ENV_FILE): verified identical to what the legacy app signed with,
//     so the 135 existing browser subscriptions keep working. The two halves are
//     checked to belong together before anything is sent (legacy fault 4: a public key
//     that did not match the private one voided every subscription).
// VAPID_SUBJECT        mailto:ubhayvatsaanand@gmail.com
// DEK_INTERNAL_SECRET  from .env.local, checked equal to Vault dek_internal_secret,
//     which is what pg_net sends (legacy fault 1: a mismatch is a 401 on every push).
// Optional, only when present in .env.local: FCM_SERVICE_ACCOUNT_JSON, APNS_KEY_ID,
//     APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_TOPIC, APNS_ENV.
import { createECDH, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT, env, mgmt, need, pgConfig } from './lib/env.mjs';

const CHECK = process.argv.includes('--check');
const { SUPABASE_PROJECT_REF: ref, DEK_INTERNAL_SECRET } = need('SUPABASE_PROJECT_REF', 'DEK_INTERNAL_SECRET');
const VAPID_SUBJECT = 'mailto:ubhayvatsaanand@gmail.com';
const OPTIONAL = ['FCM_SERVICE_ACCOUNT_JSON', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY', 'APNS_TOPIC', 'APNS_ENV'];

const sha = (v) => createHash('sha256').update(v).digest('hex');

function readEnvFile(file) {
  const out = {};
  for (const raw of readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw || raw.startsWith('#') || !raw.includes('=')) continue;
    const i = raw.indexOf('=');
    out[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  return out;
}

function vapidPair() {
  const file = env().DEK_VAPID_ENV_FILE || join(ROOT, '..', 'dek-backend', '.env.local');
  if (!existsSync(file)) throw new Error(`VAPID source ${file} not found (set DEK_VAPID_ENV_FILE)`);
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv } = readEnvFile(file);
  if (!pub || !priv) throw new Error(`VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing in ${file}`);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(priv, 'base64url'));
  if (ecdh.getPublicKey('base64url') !== pub.replace(/=+$/, '')) {
    throw new Error('VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY: refusing to set a broken pair');
  }
  console.log(`VAPID pair: halves match (public key sha256 ${sha(pub).slice(0, 12)})`);
  return { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv };
}

async function vaultMatches(secret) {
  const client = new pg.Client(pgConfig());
  await client.connect();
  try {
    const { rows } = await client.query(
      "select d.decrypted_secret = $1 as same from vault.decrypted_secrets d where d.name = 'dek_internal_secret'", [secret]);
    if (!rows.length) throw new Error('Vault has no dek_internal_secret: run node tools/setup-project.mjs first');
    return rows[0].same;
  } finally {
    await client.end();
  }
}

async function main() {
  const want = { ...vapidPair(), VAPID_SUBJECT, DEK_INTERNAL_SECRET };
  if (!(await vaultMatches(DEK_INTERNAL_SECRET))) {
    throw new Error('DEK_INTERNAL_SECRET in .env.local differs from Vault dek_internal_secret: pg_net would be refused');
  }
  console.log('DEK_INTERNAL_SECRET: equals Vault dek_internal_secret');
  for (const k of OPTIONAL) if (env()[k]) want[k] = env()[k];

  const have = new Map((await mgmt('GET', `/v1/projects/${ref}/secrets`)).map((s) => [s.name, s.value]));
  const changes = Object.entries(want).filter(([k, v]) => have.get(k) !== sha(v));
  for (const [k] of Object.entries(want)) {
    console.log(`${k.padEnd(26)} ${changes.some(([c]) => c === k) ? (CHECK ? 'DIFFERS' : 'setting') : 'ok (digest matches)'}`);
  }
  for (const k of OPTIONAL) if (!want[k]) console.log(`${k.padEnd(26)} not in .env.local (adapter reports not_configured)`);
  if (CHECK || !changes.length) return;
  await mgmt('POST', `/v1/projects/${ref}/secrets`, changes.map(([name, value]) => ({ name, value })));
  const after = new Map((await mgmt('GET', `/v1/projects/${ref}/secrets`)).map((s) => [s.name, s.value]));
  const wrong = changes.filter(([k, v]) => after.get(k) !== sha(v)).map(([k]) => k);
  if (wrong.length) throw new Error(`digest mismatch after setting: ${wrong.join(', ')}`);
  console.log(`set ${changes.length} secret(s); every digest verified`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
