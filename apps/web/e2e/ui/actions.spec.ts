// The remaining message and conversation actions, each to a confirmed result and
// back again: mute and unmute, pin and unpin, save and remove, mark unread, the
// report dialog's validation (cancelled, so no report is filed), and the composer
// above an on-screen keyboard (--kb). Light projects only (they write).
import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { qaRpc, signIn } from './session';

interface Org { id: string; name: string }
interface Chan { id: string; name: string | null; kind: string; member: boolean; dm_user_ids: string[] | null }
interface Prof { id: string; display_name: string }

const phone = (info: TestInfo) => !!info.project.use.hasTouch;

async function world() {
  const me = await qaRpc<{ orgs: Org[] }>('alice', 'me', {});
  const org = me.orgs.find((o) => o.name === 'Dek QA')!;
  const boot = await qaRpc<{ channels: Chan[]; profiles: Prof[] }>('alice', 'bootstrap', { p_org: org.id });
  const general = boot.channels.find((c) => c.name === 'general' && c.member)!;
  const bob = boot.profiles.find((p) => p.display_name === 'Bob Member')!;
  const dm = boot.channels.find((c) => c.kind === 'dm' && c.dm_user_ids?.includes(bob.id))!;
  return { org, general, dm };
}

async function open(page: Page, context: BrowserContext, path: string) {
  await signIn(context, 'alice');
  await page.goto(path);
  await expect(page.locator('.dk-shell')).toBeVisible();
}

async function menuFor(page: Page, info: TestInfo, row: Locator): Promise<Locator> {
  if (phone(info)) {
    await row.getByRole('button', { name: 'Message actions' }).click();
    return page.getByRole('dialog', { name: 'Message actions' });
  }
  await row.hover();
  await row.getByRole('button', { name: 'More message actions' }).click();
  return page.getByRole('menu', { name: 'More message actions' });
}

test.describe('actions', () => {
  test.beforeEach(async ({}, info) => {
    test.skip(info.project.name.endsWith('-dark'), 'writes run once per layout, in the light projects');
  });

  test('mute for an hour, then unmute, from the details panel', async ({ page, context }) => {
    const w = await world();
    await open(page, context, `/o/${w.org.id}/c/${w.general.id}?pane=info`);
    const panel = page.locator('.dk-panel');
    await panel.getByRole('button', { name: 'Mute for 1 hour' }).click();
    await expect(page.getByText('Muted for 1 hour')).toBeVisible();
    await expect(panel.getByText(/^Muted until /)).toBeVisible();
    await panel.getByRole('button', { name: 'Unmute' }).click();
    await expect(panel.getByRole('button', { name: 'Mute for 1 hour' })).toBeVisible();
  });

  test('pin and unpin, save and remove, mark unread, and the report dialog', async ({ page, context }, info) => {
    const w = await world();
    await open(page, context, `/o/${w.org.id}/c/${w.dm.id}`);
    const row = page.locator('.dk-msg', { hasText: 'quick question about the Friday plan' }).first();
    await expect(row).toBeVisible();

    // Pin: the label shows only after the server confirmed.
    await (await menuFor(page, info, row)).getByRole('menuitem', { name: 'Pin to conversation' }).click();
    await expect(row.locator('.dk-msg__pinned')).toBeVisible();
    // Listed in the pins panel, and unpinned from there.
    await page.goto(`/o/${w.org.id}/c/${w.dm.id}?pane=pins`);
    const panel = page.locator('.dk-panel');
    await expect(panel.locator('.dk-card', { hasText: 'quick question about the Friday plan' })).toBeVisible();
    await panel.getByRole('button', { name: 'Unpin' }).first().click();
    await expect(panel.getByText('Nothing pinned yet')).toBeVisible();

    await page.goto(`/o/${w.org.id}/c/${w.dm.id}`);
    const again = page.locator('.dk-msg', { hasText: 'quick question about the Friday plan' }).first();
    await expect(again).toBeVisible();
    await expect(again.locator('.dk-msg__pinned')).toHaveCount(0);

    // Save, find it under Saved, remove it there.
    await (await menuFor(page, info, again)).getByRole('menuitem', { name: 'Save for later' }).click();
    await expect(page.getByText('Find it under Saved.')).toBeVisible();
    await page.goto(`/o/${w.org.id}/saved`);
    const card = page.locator('.dk-card', { hasText: 'quick question about the Friday plan' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /Remove/ }).click();
    await expect(card).toHaveCount(0);

    // Mark unread from here, confirmed by the server.
    await page.goto(`/o/${w.org.id}/c/${w.dm.id}`);
    const third = page.locator('.dk-msg', { hasText: 'quick question about the Friday plan' }).first();
    await (await menuFor(page, info, third)).getByRole('menuitem', { name: 'Mark unread from here' }).click();
    await expect(page.getByText('Marked unread from here')).toBeVisible();
  });

  test('the report dialog asks for a reason before sending', async ({ page, context }, info) => {
    const w = await world();
    await open(page, context, `/o/${w.org.id}/c/${w.general.id}`);
    // Someone else's message (your own cannot be reported).
    const target = page.locator('.dk-msg', { has: page.locator('.dk-msg__author', { hasText: 'Bob Member' }) }).last();
    await expect(target).toBeVisible();
    await (await menuFor(page, info, target)).getByRole('menuitem', { name: 'Report message' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report message' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Send report' }).click();
    await expect(dialog.getByText('Choose a reason so the admins know what to look at.')).toBeVisible();
    await dialog.getByText('Something else', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Send report' }).click();
    await expect(dialog.getByText('Add a few words about what is wrong.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('a message that arrives while scrolled up is counted on the jump button', async ({ page, context }) => {
    const w = await world();
    await open(page, context, `/o/${w.org.id}/c/${w.general.id}`);
    const list = page.locator('.dk-list');
    await expect(page.locator('.dk-msg').nth(5)).toBeVisible();
    await page.waitForTimeout(800);
    await list.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 1200); });
    await expect(page.locator('.dk-jump')).toBeVisible();
    const stamp = `e2e arrival ${Date.now()}`;
    const sent = await qaRpc<{ id: string }>('bob', 'send_message', {
      p_channel: w.general.id, p_client_id: crypto.randomUUID(), p_body: stamp,
    });
    try {
      // Live delivery over realtime; the reader is not moved.
      await expect(page.locator('.dk-jump')).toContainText('1 new message', { timeout: 20_000 });
      await page.locator('.dk-jump').click();
      await expect(page.locator('.dk-msg', { hasText: stamp })).toBeInViewport();
    } finally {
      await qaRpc('bob', 'delete_message', { p_message: sent.id, p_reason: null });
    }
  });

  test('the composer stays above the on-screen keyboard', async ({ page, context }, info) => {
    test.skip(!phone(info), 'the keyboard inset is a phone concern');
    const w = await world();
    await open(page, context, `/o/${w.org.id}/c/${w.general.id}`);
    const box = page.locator('.dk-composer__box');
    await expect(box).toBeVisible();
    // iOS reports the keyboard through visualViewport; the runtime turns it into --kb.
    await page.evaluate(() => document.documentElement.style.setProperty('--kb', '300px'));
    await page.waitForTimeout(200);
    const r = await box.boundingBox();
    const vh = page.viewportSize()!.height;
    expect(r!.y + r!.height).toBeLessThanOrEqual(vh - 300);
    await page.evaluate(() => document.documentElement.style.setProperty('--kb', '0px'));
  });
});
