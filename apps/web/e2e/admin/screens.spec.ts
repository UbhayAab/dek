// Every admin, team server, channel, browse and settings screen (and the main
// dialogs) at 390 x 844 with touch and at 1280 x 800, light and dark: a screenshot
// in e2e/admin/screenshots and the geometry audit. Any violation fails the run.
import { expect, test, type Page } from '@playwright/test';
import { gotoRoute, openAs, shoot, type Opened } from './support/fixtures';
import { readWorld, type QaUser, type World } from './support/qa';

test.describe.configure({ mode: 'parallel' });

interface ScreenCase {
  name: string;
  user: QaUser;
  route: (w: World) => string;
  act?: (page: Page) => Promise<void>;
  phoneOnly?: boolean;
}

const SCREENS: readonly ScreenCase[] = [
  { name: 'admin-overview', user: 'owner', route: (w) => `/o/${w.orgId}/admin` },
  { name: 'admin-members', user: 'owner', route: (w) => `/o/${w.orgId}/admin/members` },
  {
    name: 'admin-member-menu', user: 'owner', route: (w) => `/o/${w.orgId}/admin/members`,
    act: async (page) => {
      await page.getByLabel('Search').fill('Fiona');
      await page.getByRole('button', { name: 'Actions for Fiona Fixture' }).click();
      await expect(page.getByRole('menu', { name: 'Actions for Fiona Fixture' })).toBeVisible();
    },
  },
  { name: 'admin-invites', user: 'owner', route: (w) => `/o/${w.orgId}/admin/invites` },
  { name: 'admin-invite-dialog', user: 'owner', route: (w) => `/o/${w.orgId}/admin/invites#new` },
  { name: 'admin-requests', user: 'owner', route: (w) => `/o/${w.orgId}/admin/requests` },
  { name: 'admin-reports', user: 'owner', route: (w) => `/o/${w.orgId}/admin/reports` },
  { name: 'admin-audit', user: 'owner', route: (w) => `/o/${w.orgId}/admin/audit` },
  { name: 'admin-servers', user: 'owner', route: (w) => `/o/${w.orgId}/admin/servers` },
  { name: 'admin-create-server', user: 'owner', route: (w) => `/o/${w.orgId}/admin/servers#new` },
  { name: 'admin-denied', user: 'alice', route: (w) => `/o/${w.orgId}/admin` },
  { name: 'server-menu', user: 'owner', route: (w) => `/o/${w.orgId}/s/${w.medId}/settings`, phoneOnly: true },
  { name: 'server-general', user: 'owner', route: (w) => `/o/${w.orgId}/s/${w.medId}/settings#general` },
  { name: 'server-members', user: 'owner', route: (w) => `/o/${w.orgId}/s/${w.medId}/settings#members` },
  { name: 'server-channels', user: 'owner', route: (w) => `/o/${w.orgId}/s/${w.medId}/settings#channels` },
  {
    name: 'server-new-channel', user: 'owner', route: (w) => `/o/${w.orgId}/s/${w.medId}/settings#channels`,
    act: async (page) => {
      await page.getByRole('button', { name: 'New channel' }).click();
      await expect(page.getByRole('dialog', { name: /New channel in/ })).toBeVisible();
    },
  },
  { name: 'server-requests', user: 'owner', route: (w) => `/o/${w.orgId}/s/${w.medId}/settings#requests` },
  { name: 'server-danger', user: 'owner', route: (w) => `/o/${w.orgId}/s/${w.medId}/settings#danger` },
  { name: 'server-readonly', user: 'alice', route: (w) => `/o/${w.orgId}/s/${w.medId}/settings#general` },
  { name: 'channel-menu', user: 'owner', route: (w) => `/o/${w.orgId}/c/${w.e2eChannelId}/settings`, phoneOnly: true },
  { name: 'channel-about', user: 'owner', route: (w) => `/o/${w.orgId}/c/${w.e2eChannelId}/settings#about` },
  { name: 'channel-members', user: 'owner', route: (w) => `/o/${w.orgId}/c/${w.e2eChannelId}/settings#members` },
  { name: 'channel-notifications', user: 'owner', route: (w) => `/o/${w.orgId}/c/${w.e2eChannelId}/settings#notifications` },
  { name: 'channel-danger', user: 'owner', route: (w) => `/o/${w.orgId}/c/${w.e2eChannelId}/settings#danger` },
  { name: 'channel-readonly', user: 'alice', route: (w) => `/o/${w.orgId}/c/${w.generalId}/settings#about` },
  { name: 'browse', user: 'alice', route: (w) => `/o/${w.orgId}/browse` },
  { name: 'browse-server', user: 'alice', route: (w) => `/o/${w.orgId}/browse/${w.medId}` },
  { name: 'settings-menu', user: 'fixture', route: () => '/settings', phoneOnly: true },
  { name: 'settings-profile', user: 'fixture', route: () => '/settings/profile' },
  {
    name: 'settings-timezone', user: 'fixture', route: () => '/settings/profile',
    act: async (page) => {
      await page.getByRole('button', { name: 'Change time zone' }).click();
      await expect(page.getByRole('dialog', { name: 'Time zone' })).toBeVisible();
    },
  },
  { name: 'settings-notifications', user: 'fixture', route: () => '/settings/notifications' },
  { name: 'settings-health', user: 'fixture', route: () => '/settings/health' },
  { name: 'settings-devices', user: 'fixture', route: () => '/settings/devices' },
  { name: 'settings-appearance', user: 'fixture', route: () => '/settings/appearance' },
  { name: 'settings-install', user: 'fixture', route: () => '/settings/install' },
  { name: 'settings-blocked', user: 'fixture', route: () => '/settings/blocked' },
  { name: 'settings-account', user: 'fixture', route: () => '/settings/account' },
  {
    name: 'settings-delete-dialog', user: 'fixture', route: () => '/settings/account',
    act: async (page) => {
      await page.getByRole('button', { name: 'Delete my account' }).click();
      await expect(page.getByRole('dialog', { name: 'Delete your account?' })).toBeVisible();
    },
  },
];

const VARIANTS = [
  { key: 'phone-light', phone: true, dark: false },
  { key: 'phone-dark', phone: true, dark: true },
  { key: 'desktop-light', phone: false, dark: false },
  { key: 'desktop-dark', phone: false, dark: true },
] as const;

for (const v of VARIANTS) {
  test(`every screen at ${v.key} passes the geometry audit`, async ({ browser }) => {
    const world = readWorld();
    const contexts = new Map<QaUser, Opened>();
    const problems: string[] = [];
    const warnings: string[] = [];
    try {
      for (const s of SCREENS) {
        if (s.phoneOnly && !v.phone) continue;
        let opened = contexts.get(s.user);
        if (!opened) {
          opened = await openAs(browser, s.user, { phone: v.phone, dark: v.dark });
          contexts.set(s.user, opened);
        }
        const { page } = opened;
        await gotoRoute(page, s.route(world));
        await expect(page.locator('main.ap-screen')).toBeVisible();
        if (s.act) await s.act(page);
        const r = await shoot(page, `${s.name}-${v.key}`);
        problems.push(...r.problems);
        warnings.push(...r.warnings);
        if (v.phone) {
          const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
          expect(coarse, 'the phone viewport emulates touch').toBe(true);
        }
      }
    } finally {
      for (const o of contexts.values()) await o.context.close();
    }
    if (warnings.length) test.info().annotations.push({ type: 'other builders', description: warnings.join('\n') });
    expect(problems, problems.join('\n')).toEqual([]);
  });
}
