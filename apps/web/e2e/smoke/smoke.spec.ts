// The go-live smoke (docs/CUTOVER.md steps 5 and 6): a deployed build, the live backend,
// QA accounts only. Messages it sends start with "smoke-" and are deleted afterwards by
// node tools/db.mjs sql "delete from dek.messages where body like 'smoke-%' ..." (see CUTOVER).
import { expect, test, type Page } from '@playwright/test';
import { qaRpc, signIn } from '../ui/session';
// @ts-expect-error plain ESM helper shared by the repo's tools
import { env } from '../../../../tools/lib/env.mjs';

interface Named { id: string; name: string }

async function qaGeneral(): Promise<{ org: string; general: string }> {
  const me = await qaRpc<{ orgs: Named[] }>('alice', 'me', {});
  const org = me.orgs.find((o) => o.name === 'Dek QA')?.id;
  if (!org) throw new Error('alice is not in Dek QA: run node tools/seed-qa.mjs');
  const servers = await qaRpc<Named[]>('alice', 'list_servers', { p_org: org });
  const med = servers.find((s) => s.name === 'Medical Partnerships')?.id;
  const channels = await qaRpc<Named[]>('alice', 'list_channels', { p_server: med });
  const general = channels.find((c) => c.name === 'general')?.id;
  if (!general) throw new Error('no #general in Medical Partnerships');
  return { org, general };
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('sign in through the screen, old link lands in #general, a message reaches bob live', async ({ page, browser }, info) => {
  const { org, general } = await qaGeneral();
  const errors = watchErrors(page);

  // bob watches #general from a second browser
  const bobContext = await browser.newContext({ ...info.project.use });
  await signIn(bobContext, 'bob');
  const bob = await bobContext.newPage();
  const bobErrors = watchErrors(bob);
  await bob.goto(`/o/${org}/c/${general}`);
  await expect(bob.locator('.dk-composer__input').first()).toBeVisible({ timeout: 45_000 });

  // alice through the real sign-in screen
  const t0 = Date.now();
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('qa-alice@dek-test.invalid');
  await page.getByLabel('Password', { exact: true }).fill((env() as Record<string, string>).DEK_QA_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Medical Partnerships').first()).toBeVisible({ timeout: 45_000 });
  console.log(`[${info.project.name}] sign-in to sidebar: ${Date.now() - t0} ms`);

  // an old app link (#/c/<channel>) opens the same conversation
  await page.goto(`/#/c/${general}`);
  await expect(page).toHaveURL(new RegExp(`/o/${org}/c/${general}`), { timeout: 45_000 });
  const box = page.locator('.dk-composer__input').first();
  await expect(box).toBeVisible({ timeout: 45_000 });

  const stamp = `smoke-${info.project.name}-${Date.now()}`;
  await box.click();
  await box.pressSequentially(stamp);
  const sent = Date.now();
  if (info.project.name === 'phone') await page.getByRole('button', { name: 'Send message' }).click();
  else await box.press('Enter');
  await expect(page.getByText(stamp)).toBeVisible({ timeout: 15_000 });
  await expect(bob.getByText(stamp)).toBeVisible({ timeout: 15_000 });
  console.log(`[${info.project.name}] alice to bob on screen: ${Date.now() - sent} ms`);

  // nothing crashed in either page
  expect([...errors, ...bobErrors]).toEqual([]);
  await bobContext.close();
});
