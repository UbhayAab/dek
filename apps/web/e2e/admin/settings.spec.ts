// Settings flows as the fixture member (Fiona) so nobody else's profile changes:
// profile, time zone and status persist across a reload; a picture is cropped,
// resized to a 256 px WebP, uploaded to avatars/<user>/ and removed again;
// notification preferences persist; the theme applies and sticks; account
// deletion explains the last-owner refusal and deletes a throwaway account.
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { gotoRoute, openAs } from './support/fixtures';
import { authFile, ensureUser, forget, record, readWorld, serviceClient, signIn, storageState, writeJson, type World } from './support/qa';

test.describe.configure({ mode: 'serial' });

let world: World;
test.beforeAll(() => {
  world = readWorld();
});

async function call<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(async ({ fn, args }) => {
    const api = window.dekHarness.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return api[fn]!(...args);
  }, { fn, args }) as Promise<T>;
}

test('profile, time zone and status persist across a reload', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'fixture');
  const title = `Fixture title ${randomBytes(3).toString('hex')}`;
  try {
    await gotoRoute(page, '/settings/profile');
    await page.getByLabel('Title (optional)').fill(title);
    await page.getByRole('button', { name: 'Change time zone' }).click();
    const tz = page.getByRole('dialog', { name: 'Time zone' });
    await tz.getByLabel('Search').fill('kathmandu');
    await tz.getByRole('button', { name: /Kathmandu/ }).click();
    await expect(page.getByText('Kathmandu (Asia)')).toBeVisible();
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Profile saved')).toBeVisible();

    await gotoRoute(page, '/settings/profile');
    await expect(page.getByLabel('Title (optional)')).toHaveValue(title);
    await expect(page.getByText('Kathmandu (Asia)')).toBeVisible();

    await page.getByRole('button', { name: 'In a meeting', exact: true }).click();
    await page.getByLabel('Clear after').selectOption('4h');
    await page.getByRole('button', { name: 'Set status' }).click();
    await expect(page.getByText('Status set')).toBeVisible();
    await gotoRoute(page, '/settings/profile');
    await expect(page.locator('.set-status__now')).toContainText('In a meeting');
    await expect(page.locator('.set-status__now')).toContainText('clears');
    await page.getByRole('button', { name: 'Clear status' }).click();
    await expect(page.getByText('Status cleared')).toBeVisible();
    await expect(page.locator('.set-status__now')).toContainText('No status right now.');
  } finally {
    await call(page, 'updateProfile', { title: null, timezone: 'Asia/Kolkata' }).catch(() => undefined);
    await call(page, 'setStatus', null, null, null).catch(() => undefined);
    await context.close();
  }
});

async function avatarFiles(userId: string): Promise<string[]> {
  const { data, error } = await serviceClient().storage.from('avatars').list(userId, { limit: 100 });
  if (error) throw error;
  return (data ?? []).map((o) => `${userId}/${o.name}`);
}

test('a picture is cropped, resized to a 256 px WebP, uploaded, shown, and removed', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'fixture');
  let uploaded: string | null = null;
  try {
    await gotoRoute(page, '/settings/profile');
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 480;
      const x = c.getContext('2d') as CanvasRenderingContext2D;
      x.fillStyle = '#0f766e';
      x.fillRect(0, 0, 640, 480);
      x.fillStyle = '#ffd166';
      x.beginPath();
      x.arc(320, 240, 150, 0, Math.PI * 2);
      x.fill();
      return c.toDataURL('image/png').split(',')[1] as string;
    });
    await page.getByTestId('avatar-file').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const crop = page.getByRole('dialog', { name: 'Crop your picture' });
    await expect(crop).toBeVisible();
    const box = crop.getByRole('group', { name: /Picture to crop/ });
    await box.focus();
    await box.press('+');
    await box.press('ArrowLeft');
    await crop.getByRole('button', { name: 'Save picture' }).click();
    await expect(page.getByText('Picture saved')).toBeVisible();

    const img = page.locator('.set-avatar .dk-avatar img');
    const src = await img.getAttribute('src');
    expect(src).toMatch(new RegExp(`/storage/v1/object/public/avatars/${world.ids.fixture}/[0-9a-f-]+\\.webp$`));
    const file = await page.evaluate(async (url) => {
      const r = await fetch(url as string);
      const b = await r.blob();
      const bmp = await createImageBitmap(b);
      return { status: r.status, type: b.type, w: bmp.width, h: bmp.height, bytes: b.size };
    }, src);
    expect(file).toMatchObject({ status: 200, type: 'image/webp', w: 256, h: 256 });
    expect(file.bytes).toBeLessThan(60_000);

    await gotoRoute(page, '/settings/profile');
    await expect(page.locator('.set-avatar .dk-avatar img')).toHaveAttribute('src', src as string);
    const first = (src as string).split('/public/avatars/')[1] as string;
    uploaded = first;
    expect(await avatarFiles(world.ids.fixture)).toContain(first);

    // A new picture replaces the old one, and the old file is deleted.
    await page.getByTestId('avatar-file').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.getByRole('dialog', { name: 'Crop your picture' }).getByRole('button', { name: 'Save picture' }).click();
    await expect(page.locator('.set-avatar .dk-avatar img')).not.toHaveAttribute('src', src as string);
    const src2 = await page.locator('.set-avatar .dk-avatar img').getAttribute('src');
    const path = (src2 as string).split('/public/avatars/')[1] as string;
    uploaded = path;
    await expect.poll(() => avatarFiles(world.ids.fixture), { timeout: 15_000 }).not.toContain(first);
    expect(await avatarFiles(world.ids.fixture)).toContain(path);

    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('dialog', { name: 'Remove your picture?' }).getByRole('button', { name: 'Remove picture' }).click();
    await expect(page.getByText('Picture removed')).toBeVisible();
    await expect(page.locator('.set-avatar .dk-avatar img')).toHaveCount(0);
    expect((await call<{ avatar_path: string | null }>(page, 'me') as unknown as { profile: { avatar_path: string | null } }).profile.avatar_path).toBeNull();
    // The file itself goes too (removed right after the profile no longer points at it).
    await expect.poll(() => avatarFiles(world.ids.fixture), { timeout: 15_000 }).not.toContain(path);
  } finally {
    await call(page, 'updateProfile', { avatar_path: null }).catch(() => undefined);
    if (uploaded) await serviceClient().storage.from('avatars').remove([uploaded]).catch(() => undefined);
    await context.close();
  }
});

test('notification preferences persist across a reload', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'fixture');
  try {
    await gotoRoute(page, '/settings/notifications');
    await expect(page.getByText('Inside Dek', { exact: true })).toBeVisible();
    await page.getByRole('group', { name: 'Channels' }).getByRole('radio', { name: 'Every new message' }).check();
    await page.getByRole('group', { name: 'Direct messages' }).getByRole('radio', { name: 'Nothing' }).check();
    await page.getByRole('switch', { name: 'Replies in threads I follow' }).click();
    await page.getByRole('switch', { name: 'Pause notifications at night' }).click();
    await page.getByLabel('From').fill('21:30');
    await page.getByLabel('Until').fill('06:45');
    await page.getByRole('group', { name: 'Lock screen preview' }).getByRole('radio', { name: 'Only who and where' }).check();
    await page.getByRole('button', { name: 'Save notification settings' }).click();
    await expect(page.getByText('Notification settings saved')).toBeVisible();

    await gotoRoute(page, '/settings/notifications');
    await expect(page.getByRole('group', { name: 'Channels' }).getByRole('radio', { name: 'Every new message' })).toBeChecked();
    await expect(page.getByRole('group', { name: 'Direct messages' }).getByRole('radio', { name: 'Nothing' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Replies in threads I follow' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Pause notifications at night' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('From')).toHaveValue('21:30');
    await expect(page.getByLabel('Until')).toHaveValue('06:45');
    await expect(page.getByRole('group', { name: 'Lock screen preview' }).getByRole('radio', { name: 'Only who and where' })).toBeChecked();
    const prefs = await call<Record<string, unknown>>(page, 'getNotificationPrefs');
    expect(prefs).toMatchObject({ default_level: 'all', dm_level: 'none', thread_replies: false, quiet_start: '21:30', quiet_end: '06:45', preview: 'name_only' });
  } finally {
    await call(page, 'setNotificationPrefs', {
      default_level: 'mentions', dm_level: 'all', thread_replies: true, quiet_start: null, quiet_end: null, quiet_tz: 'Asia/Kolkata', preview: 'full',
    }).catch(() => undefined);
    await context.close();
  }
});

test('the theme applies at once, survives a reload, and "same as this device" removes it', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'fixture');
  try {
    await gotoRoute(page, '/settings/appearance');
    await page.getByRole('radio', { name: 'Dark', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('dek.theme'))).toBe('dark');
    await gotoRoute(page, '/settings/appearance');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
    await page.getByRole('radio', { name: 'Same as this device', exact: true }).check();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect(await page.evaluate(() => localStorage.getItem('dek.theme'))).toBeNull();
  } finally {
    await context.close();
  }
});

test('deleting the account of the last owner is refused with a clear message', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner');
  try {
    await gotoRoute(page, '/settings/account');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
    const button = dialog.getByRole('button', { name: 'Delete account' });
    await expect(button).toBeDisabled();
    await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(dialog.getByText(`You are the last owner of ${world.orgName}`)).toBeVisible();
    await expect(button).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // nothing happened: the owner still has the organization
    const me = await call<{ orgs: { id: string; my_role: string }[] }>(page, 'me');
    expect(me.orgs.find((o) => o.id === world.orgId)?.my_role).toBe('owner');
  } finally {
    await context.close();
  }
});

test('a throwaway account deletes itself from settings, sign-in account included', async ({ browser }) => {
  const email = `qa-del-${randomBytes(4).toString('hex')}@dek-test.invalid`;
  const id = await ensureUser(email, 'Temporary Tester');
  record('users', id);
  record('profiles', id);
  const signed = await signIn(email);
  writeJson(authFile('throwaway'), storageState(signed.storageValue));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: authFile('throwaway') });
  const page = await context.newPage();
  try {
    await gotoRoute(page, '/settings/account');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
    await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
    await dialog.getByRole('button', { name: 'Delete account' }).click();
    // request_account_deletion, then the account-delete function, then sign out.
    const partial = page.getByRole('dialog', { name: 'Almost done' });
    await expect(page.getByRole('dialog', { name: 'Account deleted' }).or(page.getByTestId('harness-signed-out')).or(partial).first()).toBeVisible({ timeout: 30_000 });
    if (await partial.isVisible()) {
      const why = await partial.innerText();
      throw new Error(`Deletion stopped after the first step: ${why.replace(/\s+/g, ' ')}`);
    }
    await expect(page.getByTestId('harness-signed-out')).toBeVisible({ timeout: 15_000 });
    // The sign-in account is gone, and the profile reads as "Deleted user".
    const { data } = await serviceClient().auth.admin.getUserById(id);
    expect(data?.user ?? null).toBeNull();
    forget('users', id);
  } finally {
    await context.close();
  }
});
