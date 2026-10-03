// Geometry audit run on every screen: the page must not scroll sideways, no
// element may stick out of the viewport, no text may spill out of its box, and on
// touch viewports every interactive element must be at least 44 x 44 px.
// Exempt by design: inline links and mention chips inside message text (WCAG
// 2.5.8 inline exception), children of horizontal scrollers (tab strips), and
// screen-reader-only text.
import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHOTS = join(HERE, 'screenshots');

export interface Violation {
  kind: 'page-scroll' | 'outside' | 'too-wide' | 'text-overflow' | 'small-target';
  detail: string;
}

export async function geometry(page: Page, touch: boolean): Promise<Violation[]> {
  return page.evaluate((isTouch) => {
    const out: { kind: string; detail: string }[] = [];
    const vw = document.documentElement.clientWidth;
    const de = document.documentElement;
    if (de.scrollWidth > vw + 1) out.push({ kind: 'page-scroll', detail: `document ${de.scrollWidth}px wide in a ${vw}px viewport` });
    if (document.body.scrollWidth > vw + 1) out.push({ kind: 'page-scroll', detail: `body ${document.body.scrollWidth}px wide in a ${vw}px viewport` });

    const describe = (el: Element): string => {
      const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
      const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40);
      return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}> "${label}"`;
    };
    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
      if (el.closest('.sr-only, [hidden], dialog:not([open])')) return false;
      for (let p: Element | null = el; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (Number(ps.opacity) === 0 || ps.visibility === 'hidden') return false;
      }
      return true;
    };
    const scrollerX = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
      }
      return false;
    };
    // The nearest ancestor that clips horizontally decides what can be seen.
    const visibleRect = (el: Element): { left: number; right: number } => {
      const r = el.getBoundingClientRect();
      let left = r.left;
      let right = r.right;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== 'visible') {
          const pr = p.getBoundingClientRect();
          left = Math.max(left, pr.left);
          right = Math.min(right, pr.right);
        }
      }
      return { left, right };
    };
    const interactive = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"]';
    const inlineText = (el: Element): boolean => !!el.closest('.dk-md');

    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      const inScroller = scrollerX(el);
      if (!inScroller) {
        const v = visibleRect(el);
        if (v.right > vw + 1 || v.left < -1) out.push({ kind: 'outside', detail: `${describe(el)} spans ${Math.round(v.left)} to ${Math.round(v.right)} in ${vw}` });
        if (r.width > vw + 1 && v.right - v.left > vw + 1) out.push({ kind: 'too-wide', detail: `${describe(el)} is ${Math.round(r.width)}px` });
      }
      const cs = getComputedStyle(el);
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
      if (ownText && cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1
        && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && !inScroller) {
        out.push({ kind: 'text-overflow', detail: `${describe(el)} text ${el.scrollWidth}px in a ${el.clientWidth}px box` });
      }
      if (isTouch && el.matches(interactive) && !inlineText(el)) {
        // A checkbox or radio inside its label: the label is the target.
        const target = (el.matches('input[type="checkbox"], input[type="radio"]') && el.closest('label')) || el;
        const tr = target.getBoundingClientRect();
        if (tr.width < 43.5 || tr.height < 43.5) {
          out.push({ kind: 'small-target', detail: `${describe(el)} is ${Math.round(tr.width)}x${Math.round(tr.height)}` });
        }
      }
    }
    // One line per distinct problem.
    const seen = new Set<string>();
    return out.filter((v) => { const k = `${v.kind}:${v.detail}`; if (seen.has(k)) return false; seen.add(k); return true; }) as never;
  }, touch);
}

export async function shoot(page: Page, info: TestInfo, name: string): Promise<string> {
  const dir = join(SHOTS, info.project.name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  return file;
}

// Screenshot plus audit; the run fails on any violation, listing all of them.
export async function check(page: Page, info: TestInfo, name: string): Promise<void> {
  const touch = !!info.project.use.hasTouch;
  // Toasts belong to the lead's kit and fade on their own; let them go first.
  await page.waitForFunction(() => !document.querySelector('.dk-toast'), undefined, { timeout: 10_000 }).catch(() => undefined);
  await shoot(page, info, name);
  const problems = await geometry(page, touch);
  await info.attach(`${name}-geometry.json`, { body: JSON.stringify(problems, null, 2), contentType: 'application/json' });
  expect(problems, `${name}: geometry violations on ${info.project.name}`).toEqual([]);
}
