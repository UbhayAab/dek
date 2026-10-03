// The geometry audit every screenshot goes through. A violation fails the run:
//   - the page scrolls sideways, or any visible box reaches past the viewport
//     (boxes clipped by a scrolling or clipping ancestor count only where visible);
//   - text overflows its box (spills out without wrapping or an ellipsis);
//   - on a touch viewport, an interactive target smaller than 44 by 44 px (a
//     checkbox or radio counts its label; links inside running text are exempt).
// Findings inside an element marked data-audit-owner (another builder's component
// rendered in these screens, such as NotificationHealth) come back as warnings for
// that owner instead of failures.
import type { Page } from '@playwright/test';

export interface Audit {
  problems: string[];
  warnings: string[];
}

// scope: only boxes inside this selector (the page-wide sideways scroll check
// still applies), for running inside another builder's frame.
export async function auditGeometry(page: Page, opts: { scope?: string } = {}): Promise<Audit> {
  return page.evaluate((scope) => {
    const out: string[] = [];
    const foreign: string[] = [];
    const vw = document.documentElement.clientWidth;
    const coarse = window.matchMedia('(pointer: coarse)').matches;

    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
      const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `<${el.tagName.toLowerCase()}${id}${cls}> "${label}"`;
    };

    const de = document.documentElement;
    if (de.scrollWidth > vw + 1) out.push(`the page scrolls sideways (${de.scrollWidth} > ${vw})`);
    if (document.body.scrollWidth > vw + 1) out.push(`the body is wider than the viewport (${document.body.scrollWidth} > ${vw})`);

    const shown = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
    };

    // The part of a box that can actually be seen through clipping ancestors.
    const visibleSpan = (el: Element): { left: number; right: number } => {
      const r = el.getBoundingClientRect();
      let left = r.left;
      let right = r.right;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX !== 'visible' || cs.contain.includes('paint')) {
          const ar = a.getBoundingClientRect();
          left = Math.max(left, ar.left);
          right = Math.min(right, ar.right);
        }
      }
      return { left, right };
    };

    const interactive = (el: Element): boolean => {
      if (el.closest('[aria-hidden="true"], [inert]')) return false;
      if (el instanceof HTMLInputElement) return el.type !== 'hidden';
      if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return true;
      if (el instanceof HTMLAnchorElement) return el.hasAttribute('href');
      const role = el.getAttribute('role');
      if (role && ['button', 'switch', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'link'].includes(role)) return true;
      const ti = el.getAttribute('tabindex');
      return ti !== null && ti !== '-1';
    };

    for (const el of Array.from(document.querySelectorAll(scope ? `${scope}, ${scope} *` : 'body *'))) {
      if (el.closest('dialog:not([open])') || el.closest('.sr-only') || el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;
      const owner = el.closest('[data-audit-owner]')?.getAttribute('data-audit-owner') ?? null;
      const sink = owner ? foreign : out;
      if (!shown(el)) continue;
      const span = visibleSpan(el);
      if (span.right - span.left <= 0) continue;
      if (span.right > vw + 1 || span.left < -1) sink.push(`${owner ? `[${owner}] ` : ''}wider than the viewport: ${describe(el)} spans ${Math.round(span.left)} to ${Math.round(span.right)} of ${vw}`);

      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
      if (ownText && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLOptionElement)) {
        const cs = getComputedStyle(el);
        if (cs.display !== 'inline' && cs.display !== 'contents' && el.scrollWidth > el.clientWidth + 1
          && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
          sink.push(`${owner ? `[${owner}] ` : ''}text overflows its box: ${describe(el)} (${el.scrollWidth} > ${el.clientWidth})`);
        }
      }

      if (coarse && interactive(el)) {
        if (el instanceof HTMLAnchorElement && getComputedStyle(el).display === 'inline') continue;
        let target: Element = el;
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          target = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null) ?? el;
        }
        const r = target.getBoundingClientRect();
        if (r.width < 43.5 || r.height < 43.5) sink.push(`${owner ? `[${owner}] ` : ''}touch target under 44 px: ${describe(el)} is ${Math.round(r.width)} by ${Math.round(r.height)}`);
      }
    }
    return { problems: Array.from(new Set(out)), warnings: Array.from(new Set(foreign)) };
  }, opts.scope ?? null);
}
