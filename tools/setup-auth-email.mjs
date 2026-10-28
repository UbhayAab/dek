#!/usr/bin/env node
// The Send Email Hook: Supabase Auth -> auth-email -> JCF Mailer (template dek-otp).
//
//   node tools/setup-auth-email.mjs            secret, probes, then enable when ready
//   node tools/setup-auth-email.mjs --check    report only, writes nothing
//   node tools/setup-auth-email.mjs --e2e      after enabling, ask Auth for a code for an
//                                              example.com address: proves Auth reaches the
//                                              hook; the function refuses before the mailer
//   node tools/setup-auth-email.mjs --disable  hook off (Auth falls back to its own mailer)
//
// 1. AUTH_EMAIL_HOOK_SECRET ('v1,whsec_' + 32 random bytes) is made once and kept in
//    .env.local; the function receives it as SEND_EMAIL_HOOK_SECRET (digest verified).
// 2. auth-email must be deployed with verify_jwt false and pass four probes, none of
//    which can put mail on the wire: unsigned -> 401; tampered -> 401; signed dry run
//    -> the expected plan; signed real request for a .invalid address -> refused
//    before the mailer.
// 3. The hook is enabled only when MAIL_API_KEY exists among the project's function
//    secrets (it is set there directly and never copied into .env.local).
// Prints names and verdicts, never a secret.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT, env, mgmt, need, pgConfig } from './lib/env.mjs';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const { SUPABASE_PROJECT_REF: ref } = need('SUPABASE_PROJECT_REF');
const FN = 'auth-email';
const FN_URL = `https://${ref}.supabase.co/functions/v1/${FN}`;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function saveEnv(key, value) {
  const file = join(ROOT, '.env.local');
  const text = readFileSync(file, 'utf8');
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(file, re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`);
}

function hookSecret() {
  let secret = env().AUTH_EMAIL_HOOK_SECRET;
  if (secret && !/^v1,whsec_[A-Za-z0-9+/=]{40,}$/.test(secret)) throw new Error('AUTH_EMAIL_HOOK_SECRET in .env.local is malformed');
  if (!secret) {
    if (CHECK) return null;
    secret = `v1,whsec_${randomBytes(32).toString('base64')}`;
    saveEnv('AUTH_EMAIL_HOOK_SECRET', secret);
    console.log('AUTH_EMAIL_HOOK_SECRET: created and saved to .env.local');
  } else {
    console.log('AUTH_EMAIL_HOOK_SECRET: present in .env.local');
  }
  return secret;
}

function signed(secret, body) {
  const id = `msg_${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^v1,whsec_/, ''), 'base64');
  return { 'webhook-id': id, 'webhook-timestamp': ts,
           'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}` };
}

async function post(headers, body) {
  const res = await fetch(FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const text = (await res.text()).slice(0, 400);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function probes(secret, mailConfigured) {
  const to = `probe-${randomUUID().slice(0, 8)}@dek-test.invalid`;
  const body = JSON.stringify({ user: { id: randomUUID(), email: to },
    email_data: { token: '123456', token_hash: 'x', email_action_type: 'magiclink', redirect_to: '', site_url: '' } });
  const out = [];
  const unsigned = await post({}, body);
  out.push(['unsigned request refused', unsigned.status === 401, `${unsigned.status} ${unsigned.text}`]);
  const tampered = await post(signed(secret, body), body.replace('123456', '654321'));
  out.push(['tampered body refused', tampered.status === 401, `${tampered.status} ${tampered.text}`]);
  const dry = await post({ ...signed(secret, body), 'x-dek-dry-run': '1' }, body);
  const plan = dry.json?.mails?.[0];
  out.push(['signed dry run plans one code mail, mailer configured as expected',
    dry.status === 200 && dry.json?.dry_run === true && dry.json?.mails?.length === 1 && plan?.to === to
      && plan?.code_digits === 6 && plan?.undeliverable === true && dry.json?.configured === mailConfigured,
    `${dry.status} ${dry.text}`]);
  const real = await post(signed(secret, body), body);
  out.push(['signed request for a .invalid address refused before the mailer',
    real.status === 200 && real.json?.error?.http_code === 400 && /cannot receive mail/.test(real.text),
    `${real.status} ${real.text}`]);
  return out;
}

// Auth itself rejects .invalid addresses, but passes example.com (a domain with a null
// MX that can never receive mail) to the hook, which refuses it before the mailer.
// Each run uses one unit of Auth's rate_limit_email_sent budget even though no mail
// leaves.
async function e2e() {
  const { SUPABASE_PUBLISHABLE_KEY: key } = need('SUPABASE_PUBLISHABLE_KEY');
  const email = `hook-e2e-${randomUUID().slice(0, 8)}@example.com`;
  const res = await fetch(`https://${ref}.supabase.co/auth/v1/otp`, {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, create_user: true }),
  });
  const text = (await res.text()).slice(0, 300);
  const client = new pg.Client(pgConfig());
  await client.connect();
  let removed = 0;
  try {
    const { rows } = await client.query('select id from auth.users where email = $1', [email]);
    for (const r of rows) {
      await client.query('delete from dek.profiles where id = $1', [r.id]);
      await client.query('delete from auth.users where id = $1', [r.id]);
      removed += 1;
    }
  } finally {
    await client.end();
  }
  console.log(`e2e: Auth /otp for an example.com address -> HTTP ${res.status} ${text}`);
  console.log(`e2e: test auth users removed afterwards: ${removed}`);
  if (/over_email_send_rate_limit/.test(text)) {
    console.log('e2e: blocked by Auth rate_limit_email_sent before the hook; try again later');
  }
  return res.status === 400 && /cannot receive mail/.test(text);
}

async function main() {
  if (args.has('--disable')) {
    await mgmt('PATCH', `/v1/projects/${ref}/config/auth`, { hook_send_email_enabled: false });
    console.log('hook_send_email_enabled: false (Auth uses its built-in mailer again)');
    return;
  }
  const secret = hookSecret();
  const have = new Map((await mgmt('GET', `/v1/projects/${ref}/secrets`)).map((s) => [s.name, s.value]));
  const mailConfigured = have.has('MAIL_API_KEY');
  console.log(`MAIL_API_KEY among function secrets: ${mailConfigured ? 'yes' : 'no'}`);
  if (!secret) {
    console.log('no hook secret yet (run without --check to create one)');
    return;
  }
  if (have.get('SEND_EMAIL_HOOK_SECRET') === sha(secret)) {
    console.log('SEND_EMAIL_HOOK_SECRET: ok (digest matches)');
  } else if (CHECK) {
    console.log('SEND_EMAIL_HOOK_SECRET: DIFFERS');
  } else {
    await mgmt('POST', `/v1/projects/${ref}/secrets`, [{ name: 'SEND_EMAIL_HOOK_SECRET', value: secret }]);
    const after = new Map((await mgmt('GET', `/v1/projects/${ref}/secrets`)).map((s) => [s.name, s.value]));
    if (after.get('SEND_EMAIL_HOOK_SECRET') !== sha(secret)) throw new Error('SEND_EMAIL_HOOK_SECRET digest mismatch after setting');
    console.log('SEND_EMAIL_HOOK_SECRET: set (digest verified)');
  }

  const fns = await mgmt('GET', `/v1/projects/${ref}/functions`);
  const fn = fns.find((f) => f.slug === FN);
  if (!fn || fn.status !== 'ACTIVE' || fn.verify_jwt !== false) {
    console.log(`${FN}: ${fn ? `${fn.status}, verify_jwt ${fn.verify_jwt}` : 'not deployed'}; deploy with node tools/deploy-fn.mjs ${FN}. Hook left as is.`);
    return;
  }
  let results = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    results = await probes(secret, mailConfigured);
    if (results.every(([, ok]) => ok)) break;
    await sleep(5000);   // a secret set seconds ago may not have reached every function instance yet
  }
  for (const [name, ok, detail] of results) console.log(`probe ${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ` (${detail})`}`);
  const auth = await mgmt('GET', `/v1/projects/${ref}/config/auth`);
  const enabledNow = auth.hook_send_email_enabled === true && auth.hook_send_email_uri === FN_URL;
  // Signup is open, so this project-wide cap is the brake on how many codes (and so
  // how many possible bounces on the shared SES account) can go out per hour. Every
  // hook call counts, mailed or refused.
  console.log(`Auth rate_limit_email_sent: ${auth.rate_limit_email_sent} per hour`);
  console.log(`hook now: enabled=${auth.hook_send_email_enabled}, uri ${auth.hook_send_email_uri === FN_URL ? 'auth-email' : auth.hook_send_email_uri ?? 'none'}`);
  if (!results.every(([, ok]) => ok)) throw new Error('probes failed: hook not changed');
  if (!mailConfigured) {
    console.log('hook NOT enabled: MAIL_API_KEY is not among the function secrets');
  } else if (CHECK) {
    console.log(enabledNow ? 'hook: enabled' : 'hook: would be enabled (run without --check)');
  } else {
    await mgmt('PATCH', `/v1/projects/${ref}/config/auth`, {
      hook_send_email_enabled: true, hook_send_email_uri: FN_URL, hook_send_email_secrets: secret });
    const now = await mgmt('GET', `/v1/projects/${ref}/config/auth`);
    if (now.hook_send_email_enabled !== true || now.hook_send_email_uri !== FN_URL) throw new Error('hook did not stick');
    console.log('hook ENABLED: Auth sends every code through auth-email and the JCF Mailer');
  }
  if (args.has('--e2e')) {
    const ok = await e2e();
    console.log(`e2e ${ok ? 'PASS' : 'FAIL'}: Auth -> hook -> auth-email ${ok ? 'reached the function, which refused before the mailer' : 'did not show the function\'s answer'}`);
    if (!ok) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
