// Close-ups at three times the pixel density of the parts where small defects hide
// (rows with pills and menus, switches on a touch screen, radio cards, the crop
// box, the header), light and dark, saved as zoom-*.png next to the screenshots
// for review.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { expect, test, type Locator } from '@playwright/test';
import { gotoRoute, settle } from './support/fixtures';
import { authFile, readWorld, SHOTS_DIR } from './support/qa';

for (const dark of [false, true]) {
  test(`zoomed details (${dark ? 'dark' : 'light'})`, async ({ browser }) => {
    const world = readWorld();
    mkdirSync(SHOTS_DIR, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
      colorScheme: dark ? 'dark' : 'light', storageState: authFile('owner'),
    });
    const page = await context.newPage();
    const snap = async (name: string, target: Locator) => {
      await settle(page);
      await expect(target).toBeVisible();
      await target.screenshot({ path: join(SHOTS_DIR, `zoom-${name}-${dark ? 'dark' : 'light'}.png`) });
    };
    try {
      await gotoRoute(page, `/o/${world.orgId}/admin/members`);
      await snap('header', page.locator('.ap-header'));
      await snap('member-row', page.getByTestId(`member-${world.ids.owner}`));
      await gotoRoute(page, `/o/${world.orgId}/c/${world.e2eChannelId}/settings#about`);
      await snap('switches', page.locator('.adm-switches'));
      await gotoRoute(page, `/o/${world.orgId}/admin/invites#new`);
      await snap('radio-cards', page.getByRole('dialog').locator('.ap-radios').first());
      await gotoRoute(page, `/o/${world.orgId}/s/${world.medId}/settings#channels`);
      await snap('channel-row', page.getByRole('listitem').filter({ hasText: 'announcements' }));
      await gotoRoute(page, '/settings/profile');
      await snap('status-presets', page.locator('.set-presets'));
      await snap('timezone-field', page.locator('.set-tz'));
    } finally {
      await context.close();
    }
  });
}
