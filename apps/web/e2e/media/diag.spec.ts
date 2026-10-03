import { test } from '@playwright/test';
import { audit, person, world } from './support';

test('diagnose: lightbox arrows, repeated', async ({ browser }) => {
  const w = await world();
  const bob = await person(browser, 'bob', { channel: w.general });
  const tile = bob.page.locator('.dm-grid--2 .dm-tile').first();
  await tile.waitFor({ timeout: 30_000 });
  for (let i = 0; i < 6; i += 1) {
    await tile.click();
    const box = bob.page.locator('dialog.dm-lightbox');
    await box.locator('img.dm-lightbox__img.is-ready').waitFor({ timeout: 30_000 });
    if (i % 2 === 0) await bob.page.screenshot({ path: 'e2e/media/.results/diag.png' });
    await audit(bob.page, 'dialog.dm-lightbox', 24);
    const before = await bob.page.evaluate(() => {
      const a = document.activeElement;
      return { active: a ? `${a.tagName}.${a.className}` : 'none', count: document.querySelector('.dm-lightbox__count')?.textContent };
    });
    await bob.page.keyboard.press('ArrowRight');
    await bob.page.waitForTimeout(300);
    const after = await bob.page.locator('.dm-lightbox__count').textContent();
    let synthetic = '';
    if (after !== '2 / 2') {
      await bob.page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      await bob.page.waitForTimeout(300);
      synthetic = (await bob.page.locator('.dm-lightbox__count').textContent()) ?? '';
    }
    console.log(JSON.stringify({ i, before, after, synthetic }));
    await bob.page.keyboard.press('Escape');
    await box.waitFor({ state: 'detached' });
  }
  await bob.context.close();
});
