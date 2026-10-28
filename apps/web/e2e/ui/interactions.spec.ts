// The interactions behind the screens, end to end against the QA world: mention
// autocomplete and send, reactions, edit, delete, a send while offline (DEKA03:
// visible pending state, one message after reconnecting), deep-link highlight,
// jump to latest, opening a DM from the picker, the offline banner, and scroll
// memory with the browser back button. Writes go to the alice and bob DM and
// are deleted again; they run in the light projects only.
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
  return { org, general, dm, bob };
}

async function open(page: Page, context: BrowserContext, path: string) {
  await signIn(context, 'alice');
  await page.goto(path);
  await expect(page.locator('.dk-shell')).toBeVisible();
}

async function messageActions(page: Page, info: TestInfo, row: Locator): Promise<Locator> {
  if (phone(info)) {
    await row.getByRole('button', { name: 'Message actions' }).click();
    return page.getByRole('dialog', { name: 'Message actions' });
  }
  await row.hover();
  await row.getByRole('button', { name: 'More message actions' }).click();
  return page.getByRole('menu', { name: 'More message actions' });
}

async function send(page: Page, info: TestInfo) {
  if (phone(info)) await page.getByRole('button', { name: 'Send message' }).click();
  else await page.locator('.dk-composer__input').first().press('Enter');
}

test.describe('interactions', () => {
  test.beforeEach(async ({}, info) => {
    test.skip(info.project.name.endsWith('-dark'), 'writes run once per layout, in the light projects');
  });

  test('mention, react, edit and delete a message', async ({ page, context }, info) => {
    const w = await world();
    await open(page, context, `/o/${w.org.id}/c/${w.dm.id}`);
    const box = page.locator('.dk-composer__input');
    await expect(box).toBeVisible();
    const stamp = `e2e ui ${Date.now()}`;
    await box.click();
    await box.pressSequentially(`${stamp} for @Bo`);
    const option = page.getByRole('option', { name: /@Bob Member/ });
    await expect(option).toBeVisible();
    if (phone(info)) await option.click();
    else await box.press('Enter');
    await expect(box).toHaveValue(`${stamp} for @Bob Member `);
    await box.pressSequentially('please check');
    await send(page, info);
    await expect(box).toHaveValue('');

    const row = page.locator('.dk-msg', { hasText: stamp }).last();
    await expect(row).toBeVisible();
    await expect(row.locator('.dk-mention', { hasText: '@Bob Member' })).toBeVisible();
    await expect(row).not.toHaveClass(/is-pending/, { timeout: 15_000 });

    // React through the picker, then take the reaction back.
    const menu = await messageActions(page, info, row);
    await menu.getByRole('menuitem', { name: 'Add reaction' }).click();
    await page.getByRole('searchbox', { name: 'Search emoji' }).fill('thumbs up');
    await page.getByRole('button', { name: 'thumbs up', exact: true }).first().click();
    const chip = row.locator('.dk-react[aria-pressed="true"]');
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(row.locator('.dk-react[aria-pressed="true"]')).toHaveCount(0);

    // Edit in place.
    const menu2 = await messageActions(page, info, row);
    await menu2.getByRole('menuitem', { name: 'Edit message' }).click();
    const editor = row.getByRole('textbox', { name: 'Edit message' });
    await expect(editor).toBeVisible();
    await editor.fill(`${stamp} edited`);
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.locator('.dk-msg__edited')).toBeVisible();
    await expect(row).toContainText(`${stamp} edited`);

    // Delete, confirmed.
    const menu3 = await messageActions(page, info, row);
    await menu3.getByRole('menuitem', { name: 'Delete message' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this message?' });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.dk-msg', { hasText: stamp })).toHaveCount(0);
  });

  test('a send while offline shows its state and arrives once (DEKA03)', async ({ page, context }, info) => {
    const w = await world();
    await open(page, context, `/o/${w.org.id}/c/${w.dm.id}`);
    const box = page.locator('.dk-composer__input');
    await expect(box).toBeVisible();
    // The connection drops in the middle of a loaded conversation.
    await expect(page.locator('.dk-msg').first()).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText(/You are offline/)).toBeVisible();
    const stamp = `e2e offline ui ${Date.now()}`;
    await box.click();
    await box.pressSequentially(stamp);
    await send(page, info);
    await expect(box).toHaveValue('');
    const pending = page.locator('.dk-msg.is-pending', { hasText: stamp });
    await expect(pending).toBeVisible();
    await expect(pending.locator('.dk-msg__sending, .dk-msg__failed')).toBeVisible({ timeout: 10_000 });
    await context.setOffline(false);
    await expect(page.locator('.dk-msg.is-pending', { hasText: stamp })).toHaveCount(0, { timeout: 45_000 });
    await expect(page.locator('.dk-msg', { hasText: stamp })).toHaveCount(1);

    const row = page.locator('.dk-msg', { hasText: stamp });
    const menu = await messageActions(page, info, row);
    await menu.getByRole('menuitem', { name: 'Delete message' }).click();
    await page.getByRole('dialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.dk-msg', { hasText: stamp })).toHaveCount(0);
  });

  test('a deep link highlights an old message and jump to latest returns', async ({ page, context }) => {
    const w = await world();
    const found = await qaRpc<{ items: { message: { id: string } }[] }>('alice', 'search', {
      p_org: w.org.id, p_query: 'History line 30', p_channel: w.general.id,
    });
    const id = found.items[0]!.message.id;
    await open(page, context, `/o/${w.org.id}/c/${w.general.id}/m/${id}`);
    const target = page.locator(`.dk-msg[data-message-id="${id}"]`);
    await expect(target).toBeInViewport();
    await expect(target).toHaveClass(/is-highlighted/);
    const jump = page.locator('.dk-jump');
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(page).toHaveURL(new RegExp(`/o/${w.org.id}/c/${w.general.id}$`));
    await expect(page.locator('.dk-jump')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('.dk-msg').last()).toBeInViewport();
  });

  test('the picker opens the existing DM', async ({ page, context }) => {
    const w = await world();
    await open(page, context, `/o/${w.org.id}`);
    await page.getByRole('button', { name: 'New message' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New message' });
    await dialog.getByLabel('To').fill('Bob');
    await dialog.getByRole('button', { name: /Bob Member/ }).click();
    await dialog.getByRole('button', { name: 'Open conversation' }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${w.org.id}/c/${w.dm.id}$`));
    await expect(page.locator('.dk-convhead__name', { hasText: 'Bob Member' })).toBeVisible();
  });

  test('scroll position survives leaving and coming back with the back button', async ({ page, context }) => {
    const w = await world();
    await open(page, context, `/o/${w.org.id}/c/${w.general.id}`);
    const list = page.locator('.dk-list');
    await expect(page.locator('.dk-msg').nth(5)).toBeVisible();
    await page.waitForTimeout(600);
    await list.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 900); });
    await page.waitForTimeout(600);
    const firstVisible = () => list.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const rows = Array.from(el.querySelectorAll<HTMLElement>('.dk-msg[data-message-id]'));
      return rows.find((r) => r.getBoundingClientRect().bottom > top + 4)?.dataset.messageId ?? null;
    });
    const before = await firstVisible();
    expect(before).toBeTruthy();
    // Leave inside the app (a reload would start a new session in memory)...
    await page.evaluate((to) => {
      window.history.pushState(null, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/o/${w.org.id}/c/${w.dm.id}`);
    await expect(page.locator('.dk-convhead__name', { hasText: 'Bob Member' })).toBeVisible();
    // ...and come back with the browser's back button.
    await page.goBack();
    await expect(page.locator('.dk-convhead__name', { hasText: 'general' })).toBeVisible();
    await page.waitForTimeout(800);
    const after = await firstVisible();
    expect(after).toBe(before);
  });
});
