import { expect, test } from '@playwright/test';
import { appPerson, openChannel, world } from './support';

test('integration probe: the assembled app renders the media and call controls', async ({ browser }) => {
  const w = await world();
  const alice = await appPerson(browser, 'alice');
  const errors: string[] = [];
  alice.page.on('pageerror', (e) => errors.push(e.message));
  await openChannel(alice.page, w.org, w.general);
  await expect(alice.page.getByRole('button', { name: 'Attach files' })).toBeVisible({ timeout: 30_000 });
  await expect(alice.page.locator('.dm-atts').first()).toBeVisible({ timeout: 30_000 });
  await openChannel(alice.page, w.org, w.dm);
  await expect(alice.page.getByRole('button', { name: 'Start a voice call' })).toBeVisible({ timeout: 30_000 });
  await openChannel(alice.page, w.org, w.huddle);
  await expect(alice.page.getByRole('button', { name: /Join/ }).first()).toBeVisible({ timeout: 30_000 });
  console.log('PROBE errors', JSON.stringify(errors));
  await alice.context.close();
});
