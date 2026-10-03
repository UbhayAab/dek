// The built service worker in a real browser: precache under the build version,
// the offline shell, the version message, and push handling (one tag per
// conversation that replaces, and on Chromium no OS notification when a focused
// window already shows that conversation; it gets a postMessage instead).
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const VERSION = (JSON.parse(readFileSync(join(DIST, 'version.json'), 'utf8')) as { version: string }).version;
const O = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const C2 = '33333333-3333-4333-8333-333333333333';

async function controlled(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  }
}

async function registrationId(cdp: CDPSession): Promise<string> {
  return new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; isDeleted: boolean }[] }) => {
      const live = e.registrations.find((r) => !r.isDeleted);
      if (live) resolve(live.registrationId);
    });
    void cdp.send('ServiceWorker.enable');
  });
}

async function push(cdp: CDPSession, regId: string, origin: string, payload: unknown): Promise<void> {
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: regId, data: JSON.stringify(payload) });
}

async function notifications(page: Page): Promise<{ title: string; tag: string; body: string }[]> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.getNotifications()).map((n) => ({ title: n.title, tag: n.tag, body: n.body }));
  });
}

test('precaches this build, answers its version, and serves the shell offline', async ({ page, context }) => {
  await controlled(page);
  const caches = await page.evaluate(async () => {
    const names = await caches.keys();
    const out: Record<string, string[]> = {};
    for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  expect(Object.keys(caches)).toContain(`dek-shell-${VERSION}`);
  const shell = caches[`dek-shell-${VERSION}`]!;
  expect(shell).toContain('/');
  expect(shell.some((p) => p.startsWith('/assets/') && p.endsWith('.js'))).toBe(true);
  const version = await page.evaluate(() => new Promise<string>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve((e.data as { version: string }).version);
    navigator.serviceWorker.controller!.postMessage({ type: 'version' }, [ch.port2]);
  }));
  expect(version).toBe(VERSION);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to Dek' })).toBeVisible();
  await context.setOffline(false);
});

test('push: one notification per conversation, replaced by the next; suppressed for the focused window showing it', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await controlled(page);
  const origin = new URL(page.url()).origin;
  const cdp = await context.newCDPSession(page);
  const regId = await registrationId(cdp);

  // Not looking at that conversation: shown, and the second one replaces the first.
  await push(cdp, regId, origin, { title: 'Asha', body: 'first', url: `/o/${O}/c/${C}/m/${O}`, tag: `c:${C}`, kind: 'message', ts: Date.now() });
  await expect.poll(() => notifications(page)).toHaveLength(1);
  await push(cdp, regId, origin, { title: 'Asha', body: 'second', url: `/o/${O}/c/${C}/m/${C2}`, tag: `c:${C}`, kind: 'message', ts: Date.now() });
  await expect.poll(async () => (await notifications(page)).map((n) => n.body)).toEqual(['second']);
  await push(cdp, regId, origin, { title: 'Ravi', body: 'other channel', url: `/o/${O}/c/${C2}/m/${C}`, tag: `c:${C2}`, kind: 'message', ts: Date.now() });
  await expect.poll(async () => (await notifications(page)).map((n) => n.tag).sort()).toEqual([`c:${C}`, `c:${C2}`].sort());
  await page.evaluate(async () => { for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close(); });

  // Looking at that conversation in a focused window: no OS notification, a message instead.
  await page.goto(`/o/${O}/c/${C}`);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.bringToFront();
  const focused = await page.evaluate(() => document.hasFocus() && document.visibilityState === 'visible');
  await page.evaluate(() => {
    (window as unknown as { __push: unknown[] }).__push = [];
    navigator.serviceWorker.addEventListener('message', (e) => (window as unknown as { __push: unknown[] }).__push.push(e.data));
  });
  await push(cdp, regId, origin, { title: 'Asha', body: 'while looking', url: `/o/${O}/c/${C}/m/${C2}`, tag: `c:${C}`, kind: 'message', ts: Date.now() });
  await page.waitForTimeout(1_500);
  const shown = await notifications(page);
  const messages = await page.evaluate(() => (window as unknown as { __push: { type: string; suppressed?: boolean }[] }).__push);
  console.log(`[measured] focused=${focused}; notifications while looking: ${shown.length}; page messages: ${JSON.stringify(messages.map((m) => m.type))}`);
  if (focused) {
    expect(shown).toHaveLength(0);
    expect(messages.some((m) => m.type === 'push' && m.suppressed)).toBe(true);
  }

  // A test notification always shows, even while looking.
  await push(cdp, regId, origin, { title: 'Dek test', body: 'test', url: `/o/${O}/c/${C}`, tag: 'test', kind: 'test', ts: Date.now() });
  await expect.poll(async () => (await notifications(page)).map((n) => n.tag)).toContain('test');
  expect((await page.evaluate(() => (window as unknown as { __push: { type: string }[] }).__push)).some((m) => m.type === 'push-shown')).toBe(true);
});
