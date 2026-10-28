// Layout signals the shell and screens share: the breakpoint, the open side panel (kept in the URL so the browser back
// button closes it on phones), and whether this is a touch device.
import { useSyncExternalStore } from 'react';
import { navigate, useRoute } from '../../app/router';

export type Layout = 'phone' | 'tablet' | 'desktop';

const DESKTOP = '(min-width: 1100px)';
const TABLET = '(min-width: 768px)';

function mq(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
}

function readLayout(): Layout {
  if (mq(DESKTOP)?.matches) return 'desktop';
  if (mq(TABLET)?.matches) return 'tablet';
  return 'phone';
}

function subscribeLayout(cb: () => void): () => void {
  const lists = [mq(DESKTOP), mq(TABLET)].filter((x): x is MediaQueryList => !!x);
  lists.forEach((l) => l.addEventListener('change', cb));
  return () => lists.forEach((l) => l.removeEventListener('change', cb));
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, readLayout, () => 'desktop');
}

function readCoarse(): boolean {
  return !!mq('(pointer: coarse)')?.matches;
}

function subscribeCoarse(cb: () => void): () => void {
  const l = mq('(pointer: coarse)');
  l?.addEventListener('change', cb);
  return () => l?.removeEventListener('change', cb);
}

// Touch-first device: Enter makes a newline, actions are always visible.
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarse, readCoarse, () => false);
}

// The keyboard inset (--kb) is maintained by the platform runtime
// (src/lib/viewport.ts); screens only consume it.

// ------------------------------------------------------------------ side panel

export type Pane = 'members' | 'pins' | 'info';
const PANES: readonly Pane[] = ['members', 'pins', 'info'];

export function currentPane(): Pane | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('pane');
  return v && (PANES as readonly string[]).includes(v) ? (v as Pane) : null;
}

// Re-reads on every route change (the router emits on push, replace and popstate).
export function usePane(): Pane | null {
  useRoute();
  return currentPane();
}

// The URL a pane was opened from, so closing can pop that history entry instead
// of stacking another one (the phone back button and the close button agree).
let openedFrom: { base: string; with: string } | null = null;

function here(): string {
  return window.location.pathname + window.location.search;
}

export function openPane(pane: Pane): void {
  const url = new URL(window.location.href);
  const base = here();
  url.searchParams.set('pane', pane);
  const target = url.pathname + url.search;
  const replace = currentPane() !== null;
  if (!replace) openedFrom = { base, with: target };
  else if (openedFrom) openedFrom = { base: openedFrom.base, with: target };
  navigate(target, { replace });
}

export function closePane(): void {
  if (!currentPane()) return;
  const url = new URL(window.location.href);
  url.searchParams.delete('pane');
  const target = url.pathname + url.search;
  if (openedFrom && openedFrom.with === here() && openedFrom.base === target) {
    openedFrom = null;
    window.history.back();
    return;
  }
  openedFrom = null;
  navigate(target, { replace: true });
}
