// Cold-load performance of a deployed build on a mid-range phone: 4x CPU slowdown and a
// slow 4G link (1.6 Mbps down, 750 kbps up, 150 ms latency), no cache, 3 runs each.
// Measures the sign-in screen and a signed-in organization home, plus JS bytes on the wire.
//   PERF_URL=https://dek-7o4.pages.dev npx playwright test -c e2e/perf/playwright.config.ts
import { expect, test, type Page } from '@playwright/test';
import { qaRpc, signIn } from '../ui/session';

const RUNS = 3;

async function throttle(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

function jsBytes(page: Page): () => number {
  let total = 0;
  page.on('response', async (r) => {
    if (r.request().resourceType() !== 'script') return;
    const len = Number(r.headers()['content-length'] ?? 0);
    if (len) total += len;
    else total += (await r.body().catch(() => Buffer.alloc(0))).length;
  });
  return () => total;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test('sign-in screen, cold', async ({ browser }) => {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await throttle(page);
    const js = jsBytes(page);
    const t0 = Date.now();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 60_000 });
    times.push(Date.now() - t0);
    bytes = js();
    await context.close();
  }
  console.log(`PERF sign-in screen: median ${median(times)} ms (runs ${times.join(', ')}), JS on the wire ${(bytes / 1024).toFixed(0)} KB`);
});

test('organization home, signed in, cold', async ({ browser }) => {
  const me = await qaRpc<{ orgs: { id: string; name: string }[] }>('alice', 'me', {});
  const org = me.orgs.find((o) => o.name === 'Dek QA')!.id;
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await signIn(context, 'alice');
    const page = await context.newPage();
    await throttle(page);
    const js = jsBytes(page);
    const t0 = Date.now();
    await page.goto(`/o/${org}`);
    await expect(page.getByText('Medical Partnerships').first()).toBeVisible({ timeout: 60_000 });
    times.push(Date.now() - t0);
    bytes = js();
    await context.close();
  }
  console.log(`PERF org home: median ${median(times)} ms (runs ${times.join(', ')}), JS on the wire ${(bytes / 1024).toFixed(0)} KB`);
});
