// Shared helpers for the media and calls end-to-end tests. QA world from
// tools/seed-qa.mjs; the password is read from .env.local and never printed.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function envFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(resolve(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const ENV = envFile();
export const PASSWORD = ENV.DEK_QA_PASSWORD ?? '';
if (!PASSWORD) throw new Error('DEK_QA_PASSWORD missing from .env.local (run node tools/seed-qa.mjs)');

export type Who = 'alice' | 'bob' | 'admin' | 'owner';
export const emailOf = (who: Who) => `qa-${who}@dek-test.invalid`;

export interface QaWorld {
  org: string;
  users: Record<Who, string>;
  general: string;
  dm: string;
  huddle: string;
}

let cached: QaWorld | null = null;

// Ids of the seeded world, read once (read only).
export async function world(): Promise<QaWorld> {
  if (cached) return cached;
  const db = new pg.Client({
    host: ENV.SUPABASE_POOLER_HOST, port: 5432, user: ENV.SUPABASE_POOLER_USER, password: ENV.SUPABASE_DB_PASSWORD,
    database: 'postgres', ssl: { rejectUnauthorized: false }, application_name: 'dek-e2e-media',
  });
  await db.connect();
  try {
    const org = (await db.query("select id from dek.orgs where slug = 'dek-qa'")).rows[0]?.id as string;
    const users = Object.fromEntries((await db.query(
      "select replace(replace(email, 'qa-', ''), '@dek-test.invalid', '') as who, id from auth.users where email like 'qa-%@dek-test.invalid'",
    )).rows.map((r: { who: string; id: string }) => [r.who, r.id])) as Record<Who, string>;
    const chans = (await db.query(
      `select c.id, c.kind, c.name, s.name as server from dek.channels c left join dek.servers s on s.id = c.server_id
        where c.org_id = $1`, [org])).rows as { id: string; kind: string; name: string | null; server: string | null }[];
    const general = chans.find((c) => c.name === 'general' && c.server === 'Medical Partnerships')?.id ?? '';
    const huddle = chans.find((c) => c.name === 'huddle')?.id ?? '';
    const dmKey = `${org}:${[users.alice, users.bob].sort().join(':')}`;
    const dm = (await db.query('select id from dek.channels where dm_key = $1', [dmKey])).rows[0]?.id as string;
    cached = { org, users, general, dm, huddle };
    return cached;
  } finally {
    await db.end();
  }
}

export interface Person {
  who: Who;
  context: BrowserContext;
  page: Page;
}

export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };

// A fresh browser profile per person on the media test page (harness.tsx), signed
// in with the real auth client and booted with the real API and realtime hub.
export async function person(browser: Browser, who: Who, opts: { phone?: boolean; channel?: string } = {}): Promise<Person> {
  const context = await browser.newContext({
    viewport: opts.phone ? PHONE : DESKTOP,
    ...(opts.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    permissions: ['microphone', 'camera'],
  });
  const page = await context.newPage();
  await page.goto(`/e2e/media/harness.html${opts.channel ? `?c=${opts.channel}` : ''}`);
  await page.waitForFunction(() => !!(window as unknown as { __media?: unknown }).__media);
  await page.evaluate(async ([email, password]) => {
    const m = (window as unknown as { __media: { boot(e: string, p: string): Promise<unknown> } }).__media;
    await m.boot(email as string, password as string);
  }, [emailOf(who), PASSWORD]);
  return { who, context, page };
}

// The same, through the app's own sign-in form (when the full app is running).
export async function appPerson(browser: Browser, who: Who, opts: { phone?: boolean } = {}): Promise<Person> {
  const context = await browser.newContext({
    viewport: opts.phone ? PHONE : DESKTOP,
    ...(opts.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    permissions: ['microphone', 'camera'],
  });
  const page = await context.newPage();
  await page.goto('/signin');
  await page.getByLabel('Email').fill(emailOf(who));
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForFunction(() => {
    const d = (window as unknown as { __dek?: { useDek: { getState(): { session: { status: string }; orgId: string | null } } } }).__dek;
    const s = d?.useDek.getState();
    return s?.session.status === 'signed_in' && !!s.orgId;
  }, undefined, { timeout: 60_000 });
  return { who, context, page };
}

export async function showChannel(page: Page, channel: string): Promise<void> {
  await page.evaluate((c) => {
    window.history.pushState(null, '', `/e2e/media/harness.html?c=${c}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, channel);
}

export async function openChannel(page: Page, org: string, channel: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/o/${org}/c/${channel}`);
}

// Ends calls a previous run may have left behind for this person (through the
// API as that person, never by writing tables).
export async function leaveStaleCalls(page: Page, org: string): Promise<void> {
  await page.evaluate(async (orgId) => {
    const d = (window as unknown as { __media: { api: { activeCalls(o: string): Promise<{ id: string }[]>; leaveCall(id: string): Promise<unknown> } } }).__media;
    const calls = await d.api.activeCalls(orgId).catch(() => []);
    for (const c of calls) await d.api.leaveCall(c.id).catch(() => undefined);
  }, org);
}

// Geometry audit: no horizontal overflow of the viewport, and every interactive
// element inside `scope` at least `min` px in both directions.
export async function audit(page: Page, scope: string, min: number): Promise<string[]> {
  return page.evaluate(({ sel, minSize }) => {
    const problems: string[] = [];
    const vw = document.documentElement.clientWidth;
    const se = document.scrollingElement;
    if (se && se.scrollWidth > se.clientWidth + 1) problems.push(`page scrolls sideways (${se.scrollWidth} > ${se.clientWidth})`);
    const name = (el: Element) => {
      const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? '';
      return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''} "${label}"`;
    };
    const interactive = 'button, a[href], [role="button"], input:not([type="hidden"]), select, textarea';
    for (const root of Array.from(document.querySelectorAll(sel))) {
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (el.closest('[aria-hidden="true"]') && !el.matches(interactive)) continue;
        if (r.right > vw + 1 || r.left < -1) problems.push(`outside the viewport: ${name(el)} [${Math.round(r.left)}, ${Math.round(r.right)}] of ${vw}`);
        if (el.matches(interactive) && !(el as HTMLInputElement).hidden) {
          if (r.width + 0.5 < minSize || r.height + 0.5 < minSize) problems.push(`target under ${minSize} px: ${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
    }
    return problems;
  }, { sel: scope, minSize: min });
}

export function shotPath(name: string): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'shots', `${name}.png`);
}
