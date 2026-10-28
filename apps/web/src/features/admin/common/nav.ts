// Links and layers. Real <a href> links (open in a new tab works, screen readers
// announce links) whose click stays in the app. On phones a section is a second
// layer: going in pushes history so the back button (in the header or the
// browser's) returns to the menu. On desktop the sections are side by side, so
// switching replaces the entry instead of stacking one per click.
import type { MouseEvent } from 'react';
import { back, href, navigate, navigateDeeper, useRoute, type Route } from '../../../app/router';
import { isNarrowNow } from './context';

export type GoMode = 'auto' | 'deeper' | 'replace' | 'push';

export function toHref(to: Route | string): string {
  return typeof to === 'string' ? to : href(to);
}

export function go(to: Route | string, mode: GoMode = 'deeper'): void {
  const m = mode === 'auto' ? (isNarrowNow() ? 'deeper' : 'replace') : mode;
  if (m === 'deeper') navigateDeeper(to);
  else if (m === 'replace') navigate(to, { replace: true });
  else navigate(to);
}

export function goBack(fallback: Route | string): void {
  back(fallback);
}

export function linkProps(to: Route | string, mode: GoMode = 'deeper') {
  return {
    href: toHref(to),
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go(to, mode);
    },
  };
}

// The '#section' part of the address, re-read whenever the route changes (the
// router's store compares the full address, hash included).
export function useHashValue(): string {
  useRoute();
  if (typeof window === 'undefined') return '';
  const raw = window.location.hash.replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // a malformed %-escape (a pasted or cut-off link) must not crash the screen
  }
}

export function pathWithHash(hash: string | null): string {
  const base = window.location.pathname + window.location.search;
  return hash ? `${base}#${encodeURIComponent(hash)}` : base;
}

// Exactly the given path, with no section after it (for example "/settings").
export function isBarePath(path: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.replace(/\/+$/, '') === path;
}
