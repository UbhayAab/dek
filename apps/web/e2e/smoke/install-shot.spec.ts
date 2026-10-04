// Visual check of the sidebar's "Install the Dek app" button on a deployed build. Chromium
// does not offer installation to a headless test, so the page gets a stand-in
// beforeinstallprompt event; the button must appear, be a full-size target, fit the
// sidebar without overflow, and disappear after "Not now".
import { expect, test } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qaRpc, signIn } from '../ui/session';

test('install button: visible, tap-sized, no overflow, dismissible', async ({ page, context }, info) => {
  const me = await qaRpc<{ orgs: { id: string; name: string }[] }>('alice', 'me', {});
  const org = me.orgs.find((o) => o.name === 'Dek QA')!.id;
  await signIn(context, 'alice');
  await context.addInitScript(() => {
    window.addEventListener('load', () => {
      const e = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
      e.prompt = async () => undefined;
      e.userChoice = Promise.resolve({ outcome: 'dismissed', platform: 'web' });
      window.dispatchEvent(e);
    });
  });
  await page.goto(`/o/${org}`);
  const go = page.getByRole('button', { name: /Install the Dek app/ });
  await expect(go).toBeVisible({ timeout: 45_000 });
  const close = page.getByRole('button', { name: 'Not now' });
  for (const b of [go, close]) {
    const box = await b.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  // the desktop sidebar, or the phone Home tab (one layer at a time)
  const sidebar = page.locator('.dk-sidebar:visible, .dk-home:visible').first();
  const sb = await sidebar.boundingBox();
  const wrap = await page.locator('.dk-install').boundingBox();
  expect(wrap!.x).toBeGreaterThanOrEqual(sb!.x);
  expect(wrap!.x + wrap!.width).toBeLessThanOrEqual(sb!.x + sb!.width + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), `dek-install-${info.project.name}.png`) });
  await close.click();
  await expect(go).toBeHidden();
});
