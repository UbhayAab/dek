// The geometry audit checks itself: a page with each kind of violation must be
// caught, and a clean page must pass. Without this a broken audit would pass
// every screen silently.
import { expect, test } from '@playwright/test';
import { auditGeometry } from './support/geometry';
import { PHONE } from './support/fixtures';

const BAD = `
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body{margin:0;font:16px sans-serif} .wide{width:600px;height:20px;background:#ccc}
  .nowrap{width:80px;white-space:nowrap} .ellipsis{width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tiny{width:20px;height:20px;padding:0} .scroller{overflow-x:auto;width:200px} .inner{width:900px;height:10px}</style>
  <div class="wide">wide</div>
  <div class="nowrap">this text is far too long for its box</div>
  <div class="ellipsis">this text is far too long but cut cleanly</div>
  <button class="tiny">x</button>
  <p>Inline <a href="#a">links in text</a> are exempt.</p>
  <label><input type="checkbox"> a checkbox whose label is too short</label>
  <div class="scroller"><div class="inner"></div></div>
  <div data-audit-owner="platform"><button class="tiny">y</button></div>`;

test('the audit catches every kind of violation on a touch phone', async ({ browser }) => {
  const context = await browser.newContext({ ...PHONE });
  const page = await context.newPage();
  await page.setContent(BAD);
  const { problems, warnings } = await auditGeometry(page);
  const text = problems.join('\n');
  expect(text).toMatch(/the page scrolls sideways/);
  expect(text).toMatch(/wider than the viewport: <div\.wide>/);
  expect(text).toMatch(/text overflows its box: <div\.nowrap>/);
  expect(text).not.toMatch(/<div\.ellipsis>/);
  expect(text).toMatch(/touch target under 44 px: <button\.tiny> "x"/);
  expect(text).not.toMatch(/links in text/);
  expect(text).toMatch(/touch target under 44 px: <input> .* is \d+ by \d+/);
  expect(text).not.toMatch(/<div\.inner>/);
  expect(warnings.join('\n')).toMatch(/\[platform\] touch target under 44 px: <button\.tiny> "y"/);
  await context.close();
});

test('a clean page passes, and desktop pointers skip the touch rule', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.setContent('<style>body{margin:0}</style><button style="width:20px;height:20px">x</button><p>Fine.</p>');
  expect(await auditGeometry(page)).toEqual({ problems: [], warnings: [] });
  await context.close();
});
