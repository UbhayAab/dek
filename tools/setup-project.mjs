#!/usr/bin/env node
// Project configuration as code. Idempotent: run it after `npm run db:migrate` on a new
// project and any time the settings below change. Prints what it changed, never a secret.
//
//   node tools/setup-project.mjs            apply
//   node tools/setup-project.mjs --check    report drift only
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT, env, need, mgmt, pgConfig } from './lib/env.mjs';

const CHECK = process.argv.includes('--check');
const { SUPABASE_PROJECT_REF: ref } = need('SUPABASE_PROJECT_REF');

const SITE = 'https://dek-7o4.pages.dev';

const POSTGREST = { db_schema: 'api', max_rows: 500 };

const REALTIME = { private_only: true, presence_enabled: false };

const AUTH = {
  site_url: SITE,
  // Production, Pages preview branches, local dev, and the Capacitor shells.
  uri_allow_list: [
    `${SITE}/**`,
    'https://*.dek-7o4.pages.dev/**',
    'http://localhost:5173/**',
    'http://127.0.0.1:5173/**',
    'https://localhost/**',
    'capacitor://localhost/**',
  ].join(','),
  jwt_exp: 1800,
  mailer_otp_exp: 600,
  mailer_otp_length: 6,
  smtp_max_frequency: 60,
  // rate_limit_email_sent only applies to custom SMTP (the API refuses it otherwise).
  // Dek sends codes through the auth-email Send Email Hook and the JCF Mailer, whose
  // transactional guard is the brake.
  rate_limit_otp: 500,
  rate_limit_verify: 500,
  rate_limit_token_refresh: 2000,
  password_min_length: 8,
  password_hibp_enabled: true,
  external_email_enabled: true,
  disable_signup: false,
  mailer_autoconfirm: false,
  refresh_token_rotation_enabled: true,
  security_refresh_token_reuse_interval: 10,
};

function diff(want, have) {
  return Object.fromEntries(Object.entries(want).filter(([k, v]) => String(have?.[k]) !== String(v)));
}

async function section(name, getPath, patchPath, want, method = 'PATCH') {
  const have = await mgmt('GET', getPath);
  const changes = diff(want, have);
  if (!Object.keys(changes).length) {
    console.log(`${name}: ok`);
    return;
  }
  console.log(`${name}: ${CHECK ? 'DRIFT' : 'setting'} ${Object.keys(changes).join(', ')}`);
  if (!CHECK) await mgmt(method, patchPath, changes);
}

function saveEnv(key, value) {
  const file = join(ROOT, '.env.local');
  const text = readFileSync(file, 'utf8');
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${text.replace(/\n?$/, '\n')}${line}\n`;
  writeFileSync(file, next);
}

async function database() {
  const client = new pg.Client(pgConfig());
  await client.connect();
  try {
    const url = `https://${ref}.supabase.co/functions/v1`;
    const { rows } = await client.query("select value from dek.settings where key = 'functions_url'");
    if (rows[0]?.value !== url) {
      console.log(`settings.functions_url: ${CHECK ? 'DRIFT' : 'setting'}`);
      if (!CHECK) {
        await client.query(
          "insert into dek.settings (key, value) values ('functions_url', $1) on conflict (key) do update set value = excluded.value, updated_at = now()",
          [url]);
      }
    } else {
      console.log('settings.functions_url: ok');
    }

    // The secret pg_net sends to push-dispatch. Lives in Vault (database side) and in
    // the function's secrets (DEK_INTERNAL_SECRET); .env.local keeps the copy that
    // tools/deploy-fn.mjs pushes to the function.
    const have = await client.query("select id from vault.secrets where name = 'dek_internal_secret'");
    let secret = env().DEK_INTERNAL_SECRET;
    if (!have.rows.length || !secret) {
      console.log(`vault.dek_internal_secret: ${CHECK ? 'MISSING' : 'creating'}`);
      if (!CHECK) {
        secret = randomBytes(32).toString('base64url');
        if (have.rows.length) {
          await client.query('select vault.update_secret($1, $2)', [have.rows[0].id, secret]);
        } else {
          await client.query("select vault.create_secret($1, 'dek_internal_secret', 'pg_net to push-dispatch')", [secret]);
        }
        saveEnv('DEK_INTERNAL_SECRET', secret);
      }
    } else {
      console.log('vault.dek_internal_secret: ok');
    }
  } finally {
    await client.end();
  }
}

await section('postgrest', `/v1/projects/${ref}/postgrest`, `/v1/projects/${ref}/postgrest`, POSTGREST);
await section('realtime', `/v1/projects/${ref}/config/realtime`, `/v1/projects/${ref}/config/realtime`, REALTIME);
await section('auth', `/v1/projects/${ref}/config/auth`, `/v1/projects/${ref}/config/auth`, AUTH);
await database();
