// Group calls through the Cloudflare SFU (migration 0914, the sfu function), end to end
// against the real project with the QA world: three people join the huddle room, and
// each one receives the other two's microphones, live and with bytes flowing, over ONE
// connection to the SFU, sending its own microphone once. Headless Chromium, fake
// microphones, all audio muted (silent).
//
// Needs, on the project it runs against: 0914 applied, the sfu function deployed with
// RTC_APP_ID and RTC_APP_TOKEN, and the QA organization on the SFU (dek.settings
// sfu_orgs lists dek-qa, the default from 0914, or sfu_enabled = 'true').
//
//   npx playwright test -c e2e/media/playwright.config.ts sfu
//
// DEK_E2E_PATH=mesh runs the same three-person room where the SFU is not live (before
// the deploy) and asserts the mesh instead: two connections each, the microphone sent
// twice. Both runs print each person's measured upload (getStats bytesSent).
import { expect, test, type Page } from '@playwright/test';
import { leaveStaleCalls, person, world, type Person } from './support';

const PATH = (process.env.DEK_E2E_PATH === 'mesh' ? 'mesh' : 'sfu') as 'mesh' | 'sfu';
const MEASURE_MS = 8000;

interface Transport {
  path: 'mesh' | 'sfu' | null;
  connections: number;
  bytesSent: number;
  bytesReceived: number;
  outbound: { kind: string; bytesSent: number }[];
  inbound: { userId: string | null; kind: string; bytesReceived: number; trackId: string | null }[];
}

interface Seen {
  status: string;
  sfu: boolean | null;
  peers: { user: string; state: string; liveAudio: number }[];
}

type Media = { __media: { callEngine: { view: Record<string, unknown>; transportStats(): Promise<Transport> } } };

const transport = (page: Page) => page.evaluate(() => (window as unknown as Media).__media.callEngine.transportStats());

const seen = (page: Page) => page.evaluate((): Seen => {
  const v = (window as unknown as Media).__media.callEngine.view as {
    status: string; call: { sfu?: boolean } | null;
    peers: Record<string, { userId: string; state: string; stream: MediaStream | null }>;
  };
  return {
    status: v.status,
    sfu: typeof v.call?.sfu === 'boolean' ? v.call.sfu : null,
    peers: Object.values(v.peers).map((p) => ({
      user: p.userId, state: p.state,
      liveAudio: p.stream?.getAudioTracks().filter((t) => t.readyState === 'live' && !t.muted).length ?? 0,
    })),
  };
});

// Audio bytes received from one person so far.
const fromUser = (t: Transport, user: string) =>
  t.inbound.filter((i) => i.userId === user && i.kind === 'audio').reduce((n, i) => n + i.bytesReceived, 0);

test.describe.configure({ mode: 'serial' });

test(`three people in the huddle: each hears the other two through the ${PATH === 'sfu' ? 'SFU, one connection each' : 'mesh, two connections each'}`, async ({ browser }) => {
  test.setTimeout(240_000);
  const w = await world();
  const people: Person[] = [];
  for (const who of ['alice', 'bob', 'admin'] as const) people.push(await person(browser, who, { channel: w.huddle }));
  try {
    for (const p of people) await leaveStaleCalls(p.page, w.org);
    for (const p of people) {
      await p.page.locator('.dc-room').getByRole('button', { name: 'Join room' }).click();
      await expect(p.page.locator('.dc-room').getByRole('button', { name: 'Leave room' })).toBeVisible({ timeout: 30_000 });
    }

    // The server decides the path for everyone (Call.sfu).
    for (const p of people) {
      await expect.poll(async () => (await seen(p.page)).sfu === true, {
        timeout: 20_000,
        message: PATH === 'sfu' ? 'the room must go through the SFU: is 0914 applied and dek-qa in sfu_orgs (or sfu_enabled true)?' : 'the room must be on the mesh',
      }).toBe(PATH === 'sfu');
    }

    // Everyone hears the other two: two people connected, each with a live microphone track.
    for (const p of people) {
      await expect.poll(async () => (await seen(p.page)).peers.filter((x) => x.state === 'connected' && x.liveAudio === 1).length,
        { timeout: 90_000, message: `${p.who} should receive two microphones` }).toBe(2);
    }

    // ...and the bytes keep coming from each of them, over the path's connections.
    for (const p of people) {
      const others = people.filter((o) => o !== p).map((o) => w.users[o.who]);
      const before = await transport(p.page);
      await expect.poll(async () => {
        const now = await transport(p.page);
        return others.filter((u) => fromUser(now, u) > fromUser(before, u) + 500).length;
      }, { timeout: 20_000, message: `${p.who}: audio from both others keeps arriving` }).toBe(2);
      const now = await transport(p.page);
      expect(now.path).toBe(PATH);
      expect(now.connections).toBe(PATH === 'sfu' ? 1 : 2);
      expect(now.outbound.filter((o) => o.kind === 'audio')).toHaveLength(PATH === 'sfu' ? 1 : 2);
    }

    // What each person uploads (all three measured over the same window).
    const first = await Promise.all(people.map((p) => transport(p.page)));
    const started = Date.now();
    await people[0]!.page.waitForTimeout(MEASURE_MS);
    const last = await Promise.all(people.map((p) => transport(p.page)));
    const secs = (Date.now() - started) / 1000;
    const lines = people.map((p, i) => {
      const up = ((last[i]!.bytesSent - first[i]!.bytesSent) * 8) / secs / 1000;
      const down = ((last[i]!.bytesReceived - first[i]!.bytesReceived) * 8) / secs / 1000;
      return `${p.who}: up ${up.toFixed(1)} kbit/s over ${last[i]!.connections} connection(s), ${last[i]!.outbound.length} outgoing stream(s); down ${down.toFixed(1)} kbit/s`;
    });
    console.log(`[${PATH}] 3-person huddle, ${secs.toFixed(1)} s window:\n  ${lines.join('\n  ')}`);
  } finally {
    for (const p of people) {
      await p.page.locator('.dc-room').getByRole('button', { name: 'Leave room' }).click({ timeout: 5000 }).catch(() => undefined);
    }
    await Promise.all(people.map((p) => p.context.close()));
  }
});
