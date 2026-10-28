// Reads the repo's .env.local without printing it. Every tool goes through here so
// there is exactly one place that knows where credentials live.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cache = null;

export function env() {
  if (cache) return cache;
  const file = join(ROOT, '.env.local');
  const out = { ...process.env };
  if (existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/^﻿/, '');
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const key = line.slice(0, i).trim();
      if (!(key in process.env)) out[key] = line.slice(i + 1).trim();
    }
  }
  cache = out;
  return out;
}

export function need(...keys) {
  const e = env();
  const missing = keys.filter((k) => !e[k]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')} in .env.local (see docs/OPERATIONS.md)`);
  }
  return Object.fromEntries(keys.map((k) => [k, e[k]]));
}

// Session-mode pooler (port 5432): transactions, SET LOCAL and multi-statement files
// behave exactly as on a direct connection, over IPv4.
// target 'test' is the persistent branch "test" (tools/create-test-branch.mjs), the only
// database the test suite may use. Without an argument DEK_DB_TARGET decides
// (DEK_DB_TARGET=test node tools/db.mjs migrate), defaulting to production.
export function pgConfig(target = process.env.DEK_DB_TARGET ?? 'production') {
  const test = target === 'test';
  if (!test && target !== 'production') throw new Error(`unknown database target ${target}`);
  const v = test
    ? need('TEST_POOLER_HOST', 'TEST_POOLER_USER', 'TEST_DB_PASSWORD')
    : need('SUPABASE_POOLER_HOST', 'SUPABASE_POOLER_USER', 'SUPABASE_DB_PASSWORD');
  return {
    host: test ? v.TEST_POOLER_HOST : v.SUPABASE_POOLER_HOST,
    port: 5432,
    user: test ? v.TEST_POOLER_USER : v.SUPABASE_POOLER_USER,
    password: test ? v.TEST_DB_PASSWORD : v.SUPABASE_DB_PASSWORD,
    database: 'postgres',
    // Verified TLS: the published Supabase Root 2021 CA (public; valid to 2031-04-26).
    ssl: { rejectUnauthorized: true, ca: readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'supabase-root-2021-ca.pem'), 'utf8') },
    application_name: 'dek-tools',
    connectionTimeoutMillis: 15000,
  };
}

export async function mgmt(method, path, body) {
  const { SUPABASE_ACCESS_TOKEN } = need('SUPABASE_ACCESS_TOKEN');
  const res = await fetch(`https://api.supabase.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`Management API ${method} ${path}: HTTP ${res.status} ${String(text).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
