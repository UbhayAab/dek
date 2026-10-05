// The SFU path (src/features/calls/sfu.ts) in Chromium, against a loopback SFU made of
// real RTCPeerConnections that follows Cloudflare's API (loopback.ts): three people in
// one page join, each hears the other two over one connection, a camera and a shared
// screen come and go, someone leaves, someone rebuilds on a new session. No network,
// no accounts, no Cloudflare: this proves the browser side of every SDP exchange;
// sfu.spec.ts proves the real thing once the sfu function is deployed.
//
//   npx playwright test -c e2e/media/playwright.config.ts sfu-loopback
import { expect, test, type Page } from '@playwright/test';

interface Seen {
  state: string;
  connectionState: string | null;
  session: string | null;
  publishing: string[];
  transceivers: number;
  received: { from: string; role: string; kind: string; live: boolean }[];
  states: Record<string, string>;
  inbound: { kind: string; bytes: number; from: string | null }[];
  sent: number;
  outbound: number;
  errors: string[];
}
type Report = Record<string, Seen>;

const report = (page: Page) => page.evaluate(() => (window as unknown as { __loop: { report(): Promise<Report> } }).__loop.report());
const act = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => {
  const loop = (window as unknown as { __loop: Record<string, (...x: unknown[]) => unknown> }).__loop;
  return loop[f as string]?.(...(a as unknown[]));
}, [fn, args] as const);

const USERS = ['alice', 'bob', 'carol'];
const hears = (r: Report, user: string, from: string, role = 'audio') =>
  !!r[user]?.received.some((x) => x.from === from && x.role === role && x.live);

test('the SFU path in Chromium: hear everyone over one connection; camera, screen, leaving and a rebuild', async ({ page }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/e2e/media/loopback.html');
  await page.waitForFunction(() => !!(window as unknown as { __loop?: unknown }).__loop);
  for (const u of USERS) await act(page, 'join', u);

  // everyone receives the other two microphones...
  await expect.poll(async () => {
    const r = await report(page);
    return USERS.every((u) => USERS.filter((o) => o !== u).every((o) => hears(r, u, o)));
  }, { timeout: 30_000, message: 'each person receives both other microphones' }).toBe(true);
  // ...with bytes arriving from both, sending once, over one connection
  try {
    await expect.poll(async () => {
      const r = await report(page);
      return USERS.every((u) => new Set(r[u]?.inbound.filter((i) => i.kind === 'audio' && i.bytes > 0).map((i) => i.from)).size === 2);
    }, { timeout: 30_000, message: 'audio bytes from both others' }).toBe(true);
  } catch (e) {
    console.log(JSON.stringify(await report(page), null, 1));
    throw e;
  }
  let r = await report(page);
  for (const u of USERS) {
    expect(r[u]?.connectionState).toBe('connected');
    expect(r[u]?.outbound).toBe(1);
    expect(r[u]?.publishing).toEqual(['mic-1']);
    expect(Object.values(r[u]?.states ?? {})).toEqual(['connected', 'connected']);
  }
  // what each person uploads: one microphone stream, whoever listens
  const t0 = Date.now();
  await page.waitForTimeout(6000);
  const r2 = await report(page);
  const secs = (Date.now() - t0) / 1000;
  console.log(`loopback SFU, 3 people, ${secs.toFixed(1)} s: ${USERS.map((u) =>
    `${u} up ${((((r2[u]?.sent ?? 0) - (r[u]?.sent ?? 0)) * 8) / secs / 1000).toFixed(1)} kbit/s in ${r2[u]?.outbound} stream(s)`).join('; ')}`);

  // alice turns her camera on: the others receive it as a camera
  await act(page, 'camera', 'alice', true);
  await expect.poll(async () => {
    const x = await report(page);
    return hears(x, 'bob', 'alice', 'camera') && hears(x, 'carol', 'alice', 'camera');
  }, { timeout: 30_000, message: 'alice\'s camera reaches bob and carol' }).toBe(true);

  // bob shares a screen: the others receive it as a screen, not a camera
  await act(page, 'screen', 'bob', true);
  await expect.poll(async () => {
    const x = await report(page);
    return hears(x, 'alice', 'bob', 'screen') && hears(x, 'carol', 'bob', 'screen') && !hears(x, 'alice', 'bob', 'camera');
  }, { timeout: 30_000, message: 'bob\'s screen reaches alice and carol' }).toBe(true);
  r = await report(page);
  expect(r.alice?.publishing).toEqual(['mic-1', 'cam-2']);
  expect(r.bob?.publishing).toEqual(['mic-1', 'screen-2']);

  // camera off and sharing stopped: gone for everyone
  await act(page, 'camera', 'alice', false);
  await act(page, 'screen', 'bob', false);
  await expect.poll(async () => {
    const x = await report(page);
    return USERS.every((u) => !hears(x, u, 'alice', 'camera') && !hears(x, u, 'bob', 'screen'));
  }, { timeout: 30_000, message: 'camera and screen gone' }).toBe(true);
  r = await report(page);
  expect(r.alice?.publishing).toEqual(['mic-1']);
  expect(r.bob?.publishing).toEqual(['mic-1']);

  // carol leaves: alice and bob close what they pulled from her
  const before = await report(page);
  await act(page, 'leave', 'carol');
  await expect.poll(async () => {
    const x = await report(page);
    return ['alice', 'bob'].every((u) => !x[u]?.received.some((e) => e.from === 'carol') && !('carol' in (x[u]?.states ?? {})));
  }, { timeout: 30_000, message: 'carol\'s tracks closed' }).toBe(true);
  r = await report(page);
  expect(r.alice?.transceivers).toBeLessThan(before.alice?.transceivers ?? 0);

  // bob's connection starts over on a new SFU session: alice pulls him again
  const old = r.bob?.session;
  await act(page, 'restart', 'bob');
  await expect.poll(async () => {
    const x = await report(page);
    return !!x.bob?.session && x.bob.session !== old && hears(x, 'alice', 'bob') && hears(x, 'bob', 'alice')
      && x.alice?.states.bob === 'connected' && x.bob?.states.alice === 'connected';
  }, { timeout: 30_000, message: 'bob back on a new session, both ways' }).toBe(true);

  r = await report(page);
  const actions = await act(page, 'actions') as string[];
  console.log(`loopback SFU: ${actions.length} function calls: ${actions.join(' ')}`);
  expect(r.alice?.errors).toEqual([]);
  expect(r.bob?.errors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
