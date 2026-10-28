// Shared steps for the platform end-to-end tests. Credentials come from the repo's
// .env.local and are never printed.
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

let cache: Record<string, string> | null = null;
export function env(): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  for (const raw of readFileSync(join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  cache = out;
  return out;
}

export const QA = {
  alice: 'qa-alice@dek-test.invalid',
  bob: 'qa-bob@dek-test.invalid',
  owner: 'qa-owner@dek-test.invalid',
};

export function password(): string {
  const p = env().DEK_QA_PASSWORD;
  if (!p) throw new Error('DEK_QA_PASSWORD missing in .env.local (run node tools/seed-qa.mjs)');
  return p;
}

// Read-only checks straight from the database (counts by client id).
export async function db<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const e = env();
  const client = new pg.Client({
    host: e.SUPABASE_POOLER_HOST, port: 5432, user: e.SUPABASE_POOLER_USER, password: e.SUPABASE_DB_PASSWORD,
    database: 'postgres', ssl: { rejectUnauthorized: false }, application_name: 'dek-e2e-platform',
  });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

// Counts realtime WebSockets this page opened and how many are still open.
export async function countSockets(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const W = window.WebSocket;
    const stats = { opened: 0, open: 0 };
    (window as unknown as { __ws: typeof stats }).__ws = stats;
    class Counted extends W {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes('/realtime/v1/websocket')) {
          stats.opened += 1;
          stats.open += 1;
          this.addEventListener('close', () => { stats.open -= 1; });
        }
      }
    }
    window.WebSocket = Counted as typeof WebSocket;
  });
}

export async function signIn(page: Page, email: string, pass = password()): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to Dek' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await waitSignedIn(page);
}

export async function waitSignedIn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const d = (window as unknown as DekWindow).__dek;
    return !!d && d.useDek.getState().session.status === 'signed_in';
  }, undefined, { timeout: 30_000 });
}

export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as DekWindow).__dek?.useDek.getState();
    return !!s && s.bootstrap.status === 'ready' && !!s.orgId && s.connection.realtime === 'online';
  }, undefined, { timeout: 45_000 });
}

export async function channelId(page: Page, name: string): Promise<string> {
  const id = await page.evaluate((n) => {
    const s = (window as unknown as DekWindow).__dek.useDek.getState();
    return Object.values(s.channels).find((c) => c.name === n)?.id ?? null;
  }, name);
  if (!id) throw new Error(`channel ${name} not found`);
  return id;
}

export interface DekWindow {
  __dek: {
    useDek: { getState(): import('../../src/store/state').DekState; subscribe(fn: (s: import('../../src/store/state').DekState) => void): () => void };
    actions: import('../../src/store/actions').DekActions;
    hub: import('../../src/realtime/types').RealtimeHub;
    api: typeof import('../../src/api/rpc').api;
    outbox: () => unknown[];
    supabase: () => import('../../src/api/client').DekClient;
  };
  __ws: { opened: number; open: number };
}
