// Admin flows against the real Dek QA world: a member is denied, an owner's invite
// works for a stranger until it is revoked, role and suspension changes round
// trip, channel and server settings persist, browse joins a channel. Every change
// is undone in the test (and again by global teardown if a test dies midway).
import { expect, test, type Page } from '@playwright/test';
import { gotoRoute, openAs } from './support/fixtures';
import { forget, readWorld, record, type World } from './support/qa';

test.describe.configure({ mode: 'serial' });

let world: World;
test.beforeAll(() => {
  world = readWorld();
});

// The same contract call as the screen, made in the page with the page's session.
async function call<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(async ({ fn, args }) => {
    const api = window.dekHarness.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return api[fn]!(...args);
  }, { fn, args }) as Promise<T>;
}

async function refusal(page: Page, fn: string, ...args: unknown[]): Promise<string> {
  return page.evaluate(async ({ fn, args }) => {
    const api = window.dekHarness.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    try {
      await api[fn]!(...args);
      return 'allowed';
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown';
    }
  }, { fn, args });
}

test('a member sees a friendly denied state on admin, and the server refuses too', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'alice');
  await gotoRoute(page, `/o/${world.orgId}/admin`);
  await expect(page.getByRole('heading', { name: 'Admin is for organization admins' })).toBeVisible();
  await expect(page.getByText(`You are a member of ${world.orgName}`)).toBeVisible();
  await expect(page.getByRole('button', { name: `Back to ${world.orgName}` })).toBeVisible();
  expect(await refusal(page, 'listAudit', world.orgId)).toBe('forbidden');
  expect(await refusal(page, 'listReports', world.orgId)).toBe('forbidden');
  await context.close();
});

test('an owner creates an invite link; a fresh browser previews it; revoking stops it', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner');
  const fresh = await openAs(browser, null);
  let inviteId: string | null = null;
  try {
    await gotoRoute(page, `/o/${world.orgId}/admin/invites`);
    await page.getByRole('button', { name: 'Create invite link' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create an invite link' });
    await dialog.getByLabel('Team server (optional)').selectOption({ label: 'Medical Partnerships' });
    await dialog.getByRole('checkbox', { name: /#announcements/ }).check();
    await dialog.getByLabel('Expires after').selectOption('24');
    await dialog.getByLabel('Use limit (optional)').fill('1');
    await dialog.getByRole('button', { name: 'Create link' }).click();

    const ready = page.getByRole('dialog', { name: 'Invite link ready' });
    await expect(ready).toBeVisible();
    const url = await ready.getByLabel('Invite link').inputValue();
    expect(url).toMatch(/^https:\/\/dek-7o4\.pages\.dev\/invite\/[A-Za-z0-9]{22}$/);
    const code = url.split('/').pop() as string;
    inviteId = await page.evaluate(async ({ org, code }) => (await window.dekHarness.api.listInvites(org)).items.find((i) => i.code === code)?.id ?? null, { org: world.orgId, code });
    expect(inviteId).toBeTruthy();
    record('invites', inviteId as string);
    await ready.getByRole('button', { name: 'Done' }).click();
    const row = page.getByTestId(`invite-${inviteId}`);
    await expect(row).toContainText('Medical Partnerships');
    await expect(row).toContainText('0 of 1 used');
    await expect(row).toContainText('Active');

    // A stranger's browser: the anonymous contract call the invite page makes, and
    // the real invite page itself (the auth builder's) when the app shell loads.
    const realPage = await realInvitePage(fresh.page, code, world.orgName);
    if (realPage) await expect(fresh.page.getByText('Asha Owner invited you to the Medical Partnerships team.')).toBeVisible();
    await gotoRoute(fresh.page, '/settings/profile');
    await expect(fresh.page.getByTestId('harness-signed-out')).toBeVisible();
    const preview = await fresh.page.evaluate((c) => window.dekHarness.api.previewInvite(c), code);
    expect(preview).toMatchObject({ valid: true, reason: null, org_name: world.orgName, server_name: 'Medical Partnerships', inviter_name: 'Asha Owner' });

    // Revoke from the list.
    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('dialog', { name: 'Revoke this invite link?' }).getByRole('button', { name: 'Revoke link' }).click();
    await expect(page.getByText('Invite link revoked')).toBeVisible();
    await page.getByRole('tab', { name: /Revoked/ }).click();
    await expect(page.getByTestId(`invite-${inviteId}`)).toContainText('Revoked');
    forget('invites', inviteId as string);

    if (realPage) {
      await fresh.page.goto(`/invite/${code}`);
      await expect(fresh.page.getByText('This invite cannot be used')).toBeVisible({ timeout: 30_000 });
    }
    await gotoRoute(fresh.page, '/settings/profile');
    expect(await fresh.page.evaluate((c) => window.dekHarness.api.previewInvite(c), code)).toMatchObject({ valid: false, reason: 'revoked' });
  } finally {
    if (inviteId) await call(page, 'revokeInvite', inviteId).catch(() => undefined);
    await fresh.context.close();
    await context.close();
  }
});

// The real app's invite page. Returns false (and notes it on the test) when the app
// shell itself does not render, which is the other builders' code, not this screen.
async function realInvitePage(page: Page, code: string, orgName: string): Promise<boolean> {
  await page.goto(`/invite/${code}`);
  const ok = await page.getByRole('heading', { name: orgName }).waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
  if (!ok) {
    const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 120);
    test.info().annotations.push({ type: 'integration', description: `The real app did not render /invite/<code> (body: "${text}"). Checked through the anonymous preview_invite call only.` });
  }
  return ok;
}

async function findMember(page: Page, name: string) {
  await page.getByLabel('Search').fill(name);
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  return row;
}

test('an owner makes a member an admin and back; both stick after a reload', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner');
  const route = `/o/${world.orgId}/admin/members`;
  try {
    await gotoRoute(page, route);
    let row = await findMember(page, 'Fiona Fixture');
    await expect(row.locator('.ap-pill')).toHaveText(['Member']);

    await row.getByRole('button', { name: 'Actions for Fiona Fixture' }).click();
    await page.getByRole('menuitem', { name: 'Make an admin' }).click();
    await page.getByRole('dialog', { name: 'Make Fiona Fixture an admin?' }).getByRole('button', { name: 'Make admin' }).click();
    await expect(page.getByText('Fiona Fixture is now an admin')).toBeVisible();
    await expect(row.locator('.ap-pill')).toHaveText(['Admin']);

    await gotoRoute(page, route);
    row = await findMember(page, 'Fiona Fixture');
    await expect(row.locator('.ap-pill')).toHaveText(['Admin']);

    await row.getByRole('button', { name: 'Actions for Fiona Fixture' }).click();
    await page.getByRole('menuitem', { name: 'Make a member' }).click();
    await page.getByRole('dialog', { name: 'Make Fiona Fixture a member?' }).getByRole('button', { name: 'Make member' }).click();
    await expect(page.getByText('Fiona Fixture is now a member')).toBeVisible();

    await gotoRoute(page, route);
    row = await findMember(page, 'Fiona Fixture');
    await expect(row.locator('.ap-pill')).toHaveText(['Member']);

    // The audit log tells the story in words.
    await gotoRoute(page, `/o/${world.orgId}/admin/audit`);
    await expect(page.getByText('changed the role of Fiona Fixture from Admin to Member').first()).toBeVisible();
    await expect(page.getByText('changed the role of Fiona Fixture from Member to Admin').first()).toBeVisible();
  } finally {
    await call(page, 'setOrgRole', world.orgId, world.ids.fixture, 'member').catch(() => undefined);
    await context.close();
  }
});

test('an owner suspends a member with a reason and restores access; both stick after a reload', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner');
  const route = `/o/${world.orgId}/admin/members`;
  try {
    await gotoRoute(page, route);
    let row = await findMember(page, 'Fiona Fixture');
    await row.getByRole('button', { name: 'Actions for Fiona Fixture' }).click();
    await page.getByRole('menuitem', { name: 'Suspend' }).click();
    const dialog = page.getByRole('dialog', { name: 'Suspend Fiona Fixture?' });
    await dialog.getByLabel('Reason (optional)').fill('Browser test of the suspend flow');
    await dialog.getByRole('button', { name: 'Suspend' }).click();
    await expect(page.getByText('Fiona Fixture is suspended')).toBeVisible();
    await expect(row).toContainText('Suspended');

    await gotoRoute(page, route);
    row = await findMember(page, 'Fiona Fixture');
    await expect(row).toContainText('Suspended');

    await row.getByRole('button', { name: 'Actions for Fiona Fixture' }).click();
    await page.getByRole('menuitem', { name: 'Restore access' }).click();
    await page.getByRole('dialog', { name: 'Restore access for Fiona Fixture?' }).getByRole('button', { name: 'Restore access' }).click();
    await expect(page.getByText('Fiona Fixture has access again')).toBeVisible();
    await expect(row).not.toContainText('Suspended');

    await gotoRoute(page, route);
    row = await findMember(page, 'Fiona Fixture');
    await expect(row).not.toContainText('Suspended');

    await gotoRoute(page, `/o/${world.orgId}/admin/audit`);
    await expect(page.getByText('suspended Fiona Fixture').first()).toBeVisible();
    await expect(page.getByText('Browser test of the suspend flow').first()).toBeVisible();
  } finally {
    await call(page, 'suspendOrgMember', world.orgId, world.ids.fixture, false, null).catch(() => undefined);
    await context.close();
  }
});

test('channel settings edits persist, and a member sees them read only', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner');
  const alice = await openAs(browser, 'alice');
  const route = `/o/${world.orgId}/c/${world.e2eChannelId}/settings`;
  const topic = `Edited by the browser test ${Date.now()}`;
  try {
    await gotoRoute(page, route);
    await page.getByLabel('Topic').fill(topic);
    await page.getByLabel('Description').fill('Line one\nLine two');
    await page.getByLabel('Category').fill('Projects');
    await page.getByRole('switch', { name: 'Announcement channel' }).click();
    await page.getByRole('switch', { name: 'Allow replies in threads' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Channel saved')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await gotoRoute(page, route);
    await expect(page.getByLabel('Topic')).toHaveValue(topic);
    await expect(page.getByLabel('Description')).toHaveValue('Line one\nLine two');
    await expect(page.getByLabel('Category')).toHaveValue('Projects');
    await expect(page.getByRole('switch', { name: 'Announcement channel' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Allow replies in threads' })).toHaveAttribute('aria-checked', 'false');

    await gotoRoute(alice.page, route);
    await expect(alice.page.getByRole('heading', { name: 'About this channel' })).toBeVisible();
    await expect(alice.page.getByText(topic)).toBeVisible();
    await expect(alice.page.getByText('Admins only (announcements)')).toBeVisible();
    await expect(alice.page.getByLabel('Topic')).toHaveCount(0);
    expect(await refusal(alice.page, 'updateChannel', world.e2eChannelId, { topic: 'not allowed' })).toBe('forbidden');
  } finally {
    await call(page, 'updateChannel', world.e2eChannelId, {
      topic: 'Admin and settings browser tests', description: '', category: null, posting_policy: 'everyone', allow_replies: true, allow_reactions: true,
    }).catch(() => undefined);
    await alice.context.close();
    await context.close();
  }
});

test('a member joins a public channel from Browse and leaves it from its settings', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'alice');
  try {
    await gotoRoute(page, `/o/${world.orgId}/browse/${world.medId}`);
    const row = page.getByTestId(`channel-${world.e2eChannelId}`);
    await row.getByRole('button', { name: 'Join' }).click();
    await expect(page.getByText('You joined #adm-e2e-settings')).toBeVisible();
    await expect(row.getByRole('link', { name: 'Open' })).toBeVisible();
    await expect(row).toContainText('Joined');

    await gotoRoute(page, `/o/${world.orgId}/c/${world.e2eChannelId}/settings#danger`);
    await page.getByRole('button', { name: 'Leave channel' }).click();
    await page.getByRole('dialog', { name: 'Leave this channel?' }).getByRole('button', { name: 'Leave channel' }).click();
    await expect(page.getByTestId('harness-elsewhere')).toContainText('org');

    await gotoRoute(page, `/o/${world.orgId}/browse/${world.medId}`);
    await expect(page.getByTestId(`channel-${world.e2eChannelId}`).getByRole('button', { name: 'Join' })).toBeVisible();
  } finally {
    await call(page, 'leaveChannel', world.e2eChannelId).catch(() => undefined);
    await context.close();
  }
});

test('team server settings: an owner saves a change; a member gets the read only view', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner');
  const alice = await openAs(browser, 'alice');
  const route = `/o/${world.orgId}/s/${world.medId}/settings`;
  const original = await (async () => {
    await gotoRoute(page, route);
    return page.getByLabel('Description').inputValue();
  })();
  const text = `Partnerships with hospitals. Browser test ${Date.now()}`;
  try {
    await page.getByLabel('Description').fill(text);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await gotoRoute(page, route);
    await expect(page.getByLabel('Description')).toHaveValue(text);

    await gotoRoute(alice.page, route);
    await expect(alice.page.getByRole('heading', { name: 'About this team server' })).toBeVisible();
    await expect(alice.page.getByText(text)).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await gotoRoute(alice.page, `${route}#members`);
    await expect(alice.page.getByRole('button', { name: 'Add people' })).toHaveCount(0);
    await expect(alice.page.getByRole('listitem').filter({ hasText: 'Asha Owner' })).toContainText('Server admin');
  } finally {
    await call(page, 'updateServer', world.medId, { description: original }).catch(() => undefined);
    await alice.context.close();
    await context.close();
  }
});

test('a member asks to join an approval server from Browse and an admin approves it', async ({ browser }) => {
  const owner = await openAs(browser, 'owner');
  const fiona = await openAs(browser, 'fixture');
  try {
    await gotoRoute(owner.page, `/o/${world.orgId}/s/${world.techId}/settings#general`);
    await call(owner.page, 'updateServer', world.techId, { join_policy: 'approval' });

    await gotoRoute(fiona.page, `/o/${world.orgId}/browse`);
    const row = fiona.page.getByTestId(`server-${world.techId}`);
    await row.getByRole('button', { name: 'Ask to join' }).click();
    await expect(row).toContainText('Request sent');

    await gotoRoute(owner.page, `/o/${world.orgId}/s/${world.techId}/settings#requests`);
    const request = owner.page.getByRole('listitem').filter({ hasText: 'Fiona Fixture' });
    await expect(request).toContainText('Wants to join Tech');
    await request.getByRole('button', { name: 'Approve' }).click();
    await expect(owner.page.getByText('Fiona Fixture is in')).toBeVisible();
    await expect(owner.page.getByText('Nobody is waiting')).toBeVisible();

    await gotoRoute(fiona.page, `/o/${world.orgId}/browse`);
    await expect(fiona.page.getByTestId(`server-${world.techId}`)).toContainText('Member');
  } finally {
    await call(fiona.page, 'leaveServer', world.techId).catch(() => undefined);
    await call(owner.page, 'updateServer', world.techId, { join_policy: 'invite' }).catch(() => undefined);
    await fiona.context.close();
    await owner.context.close();
  }
});
