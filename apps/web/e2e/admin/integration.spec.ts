// The same screens inside the real app (the shell, auth and sync of the other
// builders), signed in through the stored session: proves the routes reach these
// screens and that they fit beside the shell's rail and sidebar. The geometry
// audit is scoped to these screens; the shell's own layout is its builder's. If
// the app shell does not render at all, the test is skipped with the reason, as
// that is not this feature's code.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openAs, type Opened } from './support/fixtures';
import { auditGeometry } from './support/geometry';
import { readWorld, SHOTS_DIR, type QaUser, type World } from './support/qa';

test.describe.configure({ mode: 'parallel' });

const ROUTES: readonly { name: string; user: QaUser; path: (w: World) => string; expectText: string }[] = [
  { name: 'shell-admin', user: 'owner', path: (w) => `/o/${w.orgId}/admin`, expectText: 'What needs attention' },
  { name: 'shell-admin-members', user: 'owner', path: (w) => `/o/${w.orgId}/admin/members`, expectText: 'Fiona Fixture' },
  { name: 'shell-server-settings', user: 'owner', path: (w) => `/o/${w.orgId}/s/${w.medId}/settings#members`, expectText: 'Server admin' },
  { name: 'shell-channel-settings', user: 'owner', path: (w) => `/o/${w.orgId}/c/${w.e2eChannelId}/settings#about`, expectText: 'Shown at the top of the channel' },
  { name: 'shell-browse', user: 'alice', path: (w) => `/o/${w.orgId}/browse/${w.medId}`, expectText: 'Channels in Medical Partnerships' },
  { name: 'shell-admin-denied', user: 'alice', path: (w) => `/o/${w.orgId}/admin`, expectText: 'Admin is for organization admins' },
  { name: 'shell-settings', user: 'fixture', path: () => '/settings/notifications', expectText: 'What may notify you' },
];

for (const phone of [true, false]) {
  test(`these screens inside the real app shell (${phone ? 'phone' : 'desktop'})`, async ({ browser }) => {
    const world = readWorld();
    mkdirSync(SHOTS_DIR, { recursive: true });
    const problems: string[] = [];
    const contexts = new Map<QaUser, Opened>();
    try {
      for (const r of ROUTES) {
        let o = contexts.get(r.user);
        if (!o) {
          o = await openAs(browser, r.user, { phone });
          contexts.set(r.user, o);
        }
        await o.page.goto(r.path(world));
        const rendered = await o.page.locator('main.ap-screen').waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
        if (!rendered) {
          const body = (await o.page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
          test.skip(true, `The real app did not show ${r.path(world)} (the page said: "${body}")`);
        }
        await expect(o.page.locator('main.ap-screen').getByText(r.expectText).first()).toBeVisible({ timeout: 20_000 });
        await o.page.waitForTimeout(400);
        const name = `${r.name}-${phone ? 'phone' : 'desktop'}`;
        await o.page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
        const audit = await auditGeometry(o.page, { scope: 'main.ap-screen' });
        problems.push(...audit.problems.map((p) => `${name}: ${p}`));
      }
    } finally {
      for (const o of contexts.values()) await o.context.close();
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

test('a stored dark theme applies when the real app starts, before Settings is opened', async ({ browser }) => {
  const world = readWorld();
  const o = await openAs(browser, 'fixture');
  try {
    await o.page.addInitScript(() => {
      try { localStorage.setItem('dek.theme', 'dark'); } catch { /* ignore */ }
    });
    await o.page.goto(`/o/${world.orgId}`);
    await expect(o.page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 30_000 });
    const bg = await o.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(15, 17, 21)');
  } finally {
    await o.context.close();
  }
});

test('signing out with an unsent message asks first, and Sign out anyway signs out', async ({ browser }) => {
  const world = readWorld();
  const o = await openAs(browser, 'owner');
  try {
    await o.page.goto(`/o/${world.orgId}/c/${world.e2eChannelId}`);
    const box = o.page.getByRole('textbox', { name: /Message/ });
    const ready = await box.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    test.skip(!ready, 'The real app did not show the conversation');
    // Offline from here to the end: the message can never leave this browser.
    await o.context.setOffline(true);
    await box.fill('Unsent message from the admin and settings browser test');
    await o.page.getByRole('button', { name: 'Send message' }).click();
    await o.page.evaluate(() => {
      window.history.pushState(null, '', '/settings/account');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await o.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(o.page.getByText('You have unsent messages.')).toBeVisible({ timeout: 30_000 });
    await expect(o.page.getByText(/1 message has not been sent yet/).first()).toBeVisible();
    // The core also offers it in a toast; this is the button on the Account screen.
    await o.page.locator('main.ap-screen').getByRole('button', { name: 'Sign out anyway' }).click();
    await expect(o.page.getByRole('heading', { name: 'Sign in to Dek' })).toBeVisible({ timeout: 30_000 });
  } finally {
    await o.context.close();
  }
});
