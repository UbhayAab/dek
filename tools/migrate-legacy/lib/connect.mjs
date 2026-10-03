// Connections. The legacy database is production and READ ONLY: one session-mode
// pooler connection, every query inside a READ ONLY transaction, nothing in
// parallel (it fell over under concurrent load on 2026-09-30). Credentials are read
// from the two .env.local files and never printed.
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { need, pgConfig } from '../../lib/env.mjs';
import { LEGACY_ENV_FILE, LEGACY_REF } from './config.mjs';

// Timestamps stay strings: Date objects drop microseconds, and an exact round
// trip is what makes a second --apply a no-op.
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (v) => v);

// Verified TLS to both poolers: the published Supabase Root 2021 CA (public, from
// supabase-downloads/prod/ssl/prod-ca-2021.crt, valid to 2031-04-26).
const SSL = {
  rejectUnauthorized: true,
  ca: readFileSync(new URL('./supabase-root-2021-ca.pem', import.meta.url), 'utf8'),
};

let legacyCache = null;
export function legacyEnv() {
  if (legacyCache) return legacyCache;
  if (!existsSync(LEGACY_ENV_FILE)) throw new Error(`legacy env file not found (${LEGACY_ENV_FILE})`);
  const out = {};
  for (const raw of readFileSync(LEGACY_ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const k of ['SUPABASE_DB_URL', 'SUPABASE_SECRET_KEY', 'VITE_SUPABASE_URL']) {
    if (!out[k]) throw new Error(`legacy env is missing ${k}`);
  }
  legacyCache = out;
  return out;
}

// The direct host is IPv6 only; the session pooler serves IPv4. Its host comes from
// the Management API (it moved from aws-0 to aws-1 once), with an override.
async function legacyPoolerHost() {
  if (process.env.LEGACY_POOLER_HOST) return process.env.LEGACY_POOLER_HOST;
  const e = legacyEnv();
  if (e.SUPABASE_ACCESS_TOKEN) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${LEGACY_REF}/config/database/pooler`,
        { headers: { Authorization: `Bearer ${e.SUPABASE_ACCESS_TOKEN}` } });
      if (res.ok) {
        const list = await res.json();
        const host = (Array.isArray(list) ? list : [list]).find((x) => x?.db_host)?.db_host;
        if (host) return host;
      }
    } catch { /* fall through to the known host */ }
  }
  return 'aws-1-ap-south-1.pooler.supabase.com';
}

async function session(client, readOnly) {
  await client.query("set timezone = 'UTC'");
  await client.query("set datestyle = 'ISO, MDY'");
  await client.query("set intervalstyle = 'postgres'");
  await client.query("set statement_timeout = '60s'");
  if (readOnly) await client.query('set session characteristics as transaction read only');
}

export async function connectLegacy() {
  const url = new URL(legacyEnv().SUPABASE_DB_URL);
  const client = new pg.Client({
    host: await legacyPoolerHost(),
    port: 5432,
    user: `postgres.${LEGACY_REF}`,
    password: decodeURIComponent(url.password),
    database: 'postgres',
    ssl: SSL,
    application_name: 'dek-migrate-legacy (read only)',
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  await session(client, true);
  // One snapshot for the whole extract: every table is read as of the same instant.
  await client.query('begin isolation level repeatable read read only');
  return {
    query: (sql, params) => client.query(sql, params),
    rows: async (sql, params) => (await client.query(sql, params)).rows,
    close: async () => {
      try { await client.query('rollback'); } catch { /* already closed */ }
      await client.end();
    },
  };
}

export async function connectTarget() {
  const client = new pg.Client({ ...pgConfig(), ssl: SSL, application_name: 'dek-migrate-legacy' });
  await client.connect();
  await session(client, false);
  await client.query("set statement_timeout = '180s'");
  return client;
}

const AUTH_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export function legacyStorage() {
  const e = legacyEnv();
  return createClient(e.VITE_SUPABASE_URL, e.SUPABASE_SECRET_KEY, AUTH_OPTS).storage;
}

export function targetClients() {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY } =
    need('SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  return {
    url: SUPABASE_URL,
    publishable: SUPABASE_PUBLISHABLE_KEY,
    admin: createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, AUTH_OPTS),
  };
}
