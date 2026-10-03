// A tour of every screen this builder owns, each with a screenshot and the
// geometry audit: the views, the conversation panels, an old-style link, a page
// that does not exist.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { check } from './audit';
import { qaRpc, signIn } from './session';

interface Org { id: string; name: string }
interface Chan { id: string; name: string | null; kind: string; member: boolean }

const phone = (info: TestInfo) => !!info.project.use.hasTouch;

async function world() {
  const me = await qaRpc<{ orgs: Org[] }>('alice', 'me', {});
  const org = me.orgs.find((o) => o.name === 'Dek QA')!;
  const boot = await qaRpc<{ channels: Chan[] }>('alice', 'bootstrap', { p_org: org.id });
  const general = boot.channels.find((c) => c.name === 'general' && c.member)!;
  return { org, general, channels: boot.channels };
}

async function go(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('.dk-shell')).toBeVisible();
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(400);
}

test.describe('screens', () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context, 'alice');
  });

  for (const view of ['unread', 'mentions', 'threads', 'saved', 'dms', 'activity'] as const) {
    test(`view: ${view}`, async ({ page }, info) => {
      const w = await world();
      // A real mention of alice (the seed wrote none through the API), removed after.
      let mention: string | null = null;
      if (view === 'mentions') {
        const me = await qaRpc<{ user_id: string }>('alice', 'me', {});
        const sent = await qaRpc<{ id: string }>('bob', 'send_message', {
          p_channel: w.general.id, p_client_id: randomUUID(), p_body: `<@${me.user_id}> e2e mention check, please ignore`,
        });
        mention = sent.id;
      }
      try {
        await go(page, `/o/${w.org.id}/${view}`);
        await expect(page.locator('.dk-screenhead').first()).toBeVisible();
        // Settled: no skeleton left (loading ended in content, empty or error).
        await expect(page.locator('.dk-skeleton')).toHaveCount(0, { timeout: 20_000 });
        await expect(page.locator('.dk-state--error')).toHaveCount(0);
        if (view === 'mentions') await expect(page.locator('.dk-card', { hasText: 'e2e mention check' }).first()).toBeVisible();
        if (view === 'dms') await expect(page.getByRole('link', { name: /Bob Member/ }).first()).toBeVisible();
        await settle(page);
        await check(page, info, `10-view-${view}`);
      } finally {
        if (mention) await qaRpc('bob', 'delete_message', { p_message: mention, p_reason: null });
      }
    });
  }

  for (const pane of ['members', 'pins', 'info'] as const) {
    test(`panel: ${pane}`, async ({ page }, info) => {
      const w = await world();
      await go(page, `/o/${w.org.id}/c/${w.general.id}?pane=${pane}`);
      const panel = page.locator('.dk-panel');
      await expect(panel).toBeVisible();
      await expect(panel.locator('.dk-skeleton')).toHaveCount(0, { timeout: 20_000 });
      if (pane === 'members') await expect(panel.locator('.dk-member').first()).toBeVisible();
      if (pane === 'info') await expect(panel.getByRole('group', { name: 'Notification level' })).toBeVisible();
      await settle(page);
      await check(page, info, `11-panel-${pane}`);
      if (phone(info)) {
        // One layer at a time: the panel replaces the conversation, back closes it.
        await page.getByRole('button', { name: 'Back to the conversation' }).click();
        await expect(page.locator('.dk-panel')).toHaveCount(0);
        await expect(page.locator('.dk-convo')).toBeVisible();
      } else {
        await page.getByRole('button', { name: /^Close / }).click();
        await expect(page.locator('.dk-panel')).toHaveCount(0);
      }
    });
  }

  test('an old link opens the message in its new place', async ({ page }) => {
    const w = await world();
    const found = await qaRpc<{ items: { message: { id: string } }[] }>('alice', 'search', {
      p_org: w.org.id, p_query: 'History line 40', p_channel: w.general.id,
    });
    const id = found.items[0]!.message.id;
    await go(page, `/c/${w.general.id}/m/${id}`);
    await expect(page).toHaveURL(new RegExp(`/o/${w.org.id}/c/${w.general.id}/m/${id}$`));
    await expect(page.locator(`[data-message-id="${id}"]`)).toBeInViewport();
  });

  test('a page that does not exist', async ({ page }, info) => {
    await go(page, '/tasks/board');
    await expect(page.getByRole('heading', { name: 'This page does not exist' })).toBeVisible();
    await check(page, info, '12-not-found');
  });
});
