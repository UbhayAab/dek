// Journeys through the shell as the seeded QA people (node tools/seed-qa.mjs),
// each ending in a screenshot and a geometry audit that fails the run on any
// violation. Projects: phone 390x844 and desktop 1280x800, light and dark.
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { check, shoot } from './audit';
import { qaRpc, signIn, type QaPerson } from './session';

interface Org { id: string; name: string }
interface Chan { id: string; name: string | null; server_id: string | null; kind: string; member: boolean }
interface Srv { id: string; name: string; my_role: string | null }

const phone = (info: TestInfo) => !!info.project.use.hasTouch;

async function world(who: QaPerson) {
  const me = await qaRpc<{ orgs: Org[] }>(who, 'me', {});
  const org = me.orgs.find((o) => o.name === 'Dek QA');
  if (!org) throw new Error(`${who} is not in Dek QA; run node tools/seed-qa.mjs`);
  const boot = await qaRpc<{ channels: Chan[]; servers: Srv[] }>(who, 'bootstrap', { p_org: org.id });
  return { org, ...boot };
}

async function open(page: Page, context: BrowserContext, who: QaPerson, path = '/') {
  await signIn(context, who);
  await page.goto(path);
  await expect(page.locator('.dk-shell'), 'the signed-in shell renders (is the auth wiring in place?)').toBeVisible();
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(400);
}

test.describe('alice', () => {
  test('home and sidebar', async ({ page, context }, info) => {
    await open(page, context, 'alice');
    await expect(page.locator('.dk-tree').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /general/ }).first()).toBeVisible();
    if (phone(info)) {
      await expect(page.locator('.dk-tabbar')).toBeVisible();
      await expect(page.locator('.dk-home__head')).toBeVisible();
    } else {
      await expect(page.locator('.dk-sidebar')).toBeVisible();
      // No rail since Fixboard #19: the sidebar header switches organization.
      await expect(page.locator('.dk-rail')).toHaveCount(0);
      await expect(page.getByRole('link', { name: /Direct messages/ })).toBeVisible();
      await expect(page.getByRole('link', { name: /Activity/ })).toBeVisible();
    }
    // The organization's brand color is on the header (DEK01).
    const bg = await page.locator(phone(info) ? '.dk-home__head' : '.dk-orghead').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(15, 118, 110)');
    await settle(page);
    await check(page, info, '01-home');
  });

  test('a conversation with history', async ({ page, context }, info) => {
    await open(page, context, 'alice');
    await page.getByRole('link', { name: /general/ }).first().click();
    await expect(page.locator('.dk-msg').nth(5)).toBeVisible();
    await expect(page.locator('.dk-composer__input')).toBeVisible();
    // The newest message is at the bottom and visible.
    await expect(page.locator('.dk-msg').last()).toBeInViewport();
    await settle(page);
    await check(page, info, '02-conversation');
    if (phone(info)) {
      // Back returns to Home (one layer at a time).
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.locator('.dk-home')).toBeVisible();
    }
  });

  test('a thread from a deep link', async ({ page, context }, info) => {
    const w = await world('alice');
    const general = w.channels.find((c) => c.name === 'general' && c.member)!;
    const found = await qaRpc<{ items: { message: { id: string; reply_count: number } }[] }>('alice', 'search', {
      p_org: w.org.id, p_query: 'Welcome Dek QA', p_channel: general.id,
    });
    const root = found.items.find((i) => i.message.reply_count > 0)?.message;
    expect(root, 'the seeded welcome message with replies').toBeTruthy();
    await open(page, context, 'alice', `/o/${w.org.id}/c/${general.id}/t/${root!.id}`);
    const thread = page.locator('.dk-thread');
    await expect(thread).toBeVisible();
    await expect(thread.locator('.dk-msg')).toHaveCount(3);
    await expect(thread.getByText('Thread reply: great, see you there.')).toBeVisible();
    await settle(page);
    await check(page, info, '03-thread');
  });

  test('search results', async ({ page, context }, info) => {
    const w = await world('alice');
    await open(page, context, 'alice', `/o/${w.org.id}/search`);
    const box = page.getByRole('searchbox', { name: 'Search messages' });
    await box.fill('History line 11');
    await box.press('Enter');
    await expect(page.locator('.dk-card').first()).toBeVisible();
    await expect(page.locator('mark').first()).toBeVisible();
    await settle(page);
    await check(page, info, '04-search');
  });

  test('the new message picker', async ({ page, context }, info) => {
    const w = await world('alice');
    await open(page, context, 'alice', `/o/${w.org.id}`);
    await page.getByRole('button', { name: 'New message' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New message' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('To').fill('Bob');
    await expect(dialog.getByRole('button', { name: /Bob Member/ })).toBeVisible();
    await dialog.getByRole('button', { name: /Bob Member/ }).click();
    await expect(dialog.getByRole('button', { name: 'Remove Bob Member' })).toBeVisible();
    await settle(page);
    await check(page, info, '05-dm-picker');
  });

  test('message actions', async ({ page, context }, info) => {
    const w = await world('alice');
    const general = w.channels.find((c) => c.name === 'general' && c.member)!;
    await open(page, context, 'alice', `/o/${w.org.id}/c/${general.id}`);
    const last = page.locator('.dk-msg').last();
    await expect(last).toBeVisible();
    if (phone(info)) {
      await last.getByRole('button', { name: 'Message actions' }).click();
      const sheet = page.getByRole('dialog', { name: 'Message actions' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('menuitem', { name: 'Reply in thread' })).toBeVisible();
      await expect(sheet.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
      await settle(page);
      await check(page, info, '06-actions-sheet');
    } else {
      await last.hover();
      await expect(last.getByRole('toolbar', { name: 'Message actions' })).toBeVisible();
      await last.getByRole('button', { name: 'More message actions' }).click();
      await expect(page.getByRole('menu', { name: 'More message actions' })).toBeVisible();
      await settle(page);
      await check(page, info, '06-actions-menu');
    }
  });
});

test('carol, cross-team: Medical Partnerships shows only #grants (DEKA04)', async ({ page, context }, info) => {
  await open(page, context, 'carol');
  const section = page.locator('.dk-tree__section', { has: page.getByText('Medical Partnerships', { exact: true }) }).first();
  await expect(section).toBeVisible();
  const names = await section.locator('.dk-conv__name').allTextContents();
  expect(names).toEqual(['grants']);
  await expect(section.getByText('Shared with you: only the channels you were added to.')).toBeVisible();
  // The private channels of the host server are nowhere in the app.
  await expect(page.getByText('leadership')).toHaveCount(0);
  await settle(page);
  await shoot(page, info, '07-carol-crossteam');
  await check(page, info, '07-carol-crossteam');
});
