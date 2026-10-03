// 768 to 1099 px: rail, sidebar and main, with the thread or a panel as an
// overlay over the conversation. Run in the desktop projects at 900 x 700.
import { expect, test } from '@playwright/test';
import { check } from './audit';
import { qaRpc, signIn } from './session';

test.use({ viewport: { width: 900, height: 700 } });

test('tablet: conversation with the thread as an overlay', async ({ page, context }, info) => {
  test.skip(!!info.project.use.hasTouch, 'the tablet width runs in the desktop projects');
  const me = await qaRpc<{ orgs: { id: string; name: string }[] }>('alice', 'me', {});
  const org = me.orgs.find((o) => o.name === 'Dek QA')!;
  const boot = await qaRpc<{ channels: { id: string; name: string | null; member: boolean }[] }>('alice', 'bootstrap', { p_org: org.id });
  const general = boot.channels.find((c) => c.name === 'general' && c.member)!;
  const found = await qaRpc<{ items: { message: { id: string; reply_count: number } }[] }>('alice', 'search', {
    p_org: org.id, p_query: 'Welcome Dek QA', p_channel: general.id,
  });
  const root = found.items.find((i) => i.message.reply_count > 0)!.message;
  await signIn(context, 'alice');
  await page.goto(`/o/${org.id}/c/${general.id}`);
  await expect(page.locator('.dk-shell[data-layout="tablet"]')).toBeVisible();
  await expect(page.locator('.dk-rail')).toBeVisible();
  await expect(page.locator('.dk-sidebar')).toBeVisible();
  await expect(page.locator('.dk-msg').nth(3)).toBeVisible();
  await page.waitForTimeout(400);
  await check(page, info, '20-tablet-conversation');

  await page.goto(`/o/${org.id}/c/${general.id}/t/${root.id}`);
  const side = page.locator('.dk-side');
  await expect(side).toBeVisible();
  // An overlay: it covers the conversation instead of squeezing it.
  expect(await side.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  await expect(side.locator('.dk-msg')).toHaveCount(3);
  await page.waitForTimeout(400);
  await check(page, info, '21-tablet-thread');
  // The scrim closes it.
  await page.locator('.dk-side__scrim').click({ position: { x: 20, y: 300 } });
  await expect(page.locator('.dk-side')).toHaveCount(0);
});
