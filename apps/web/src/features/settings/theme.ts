// Appearance: the five shared themes (Fixboard #17, E:/claude/jcf-themes): Auto (follows
// the device), Light, Dark, Classic, High contrast. Stored per device in localStorage
// under dek.theme and applied as data-theme on <html>; "auto" removes the attribute so
// prefers-color-scheme decides. public/js/theme-boot.js applies the saved choice before
// first paint; the shared theme.mjs switches it and keeps the browser bar in step. This
// file adds the React hook, the native status bars, and the checks the tests pin.
import { useSyncExternalStore } from 'react';
import { initTheme, setTheme as setSharedTheme, THEMES, type ThemeId } from '../../ui/themes/theme.mjs';

export type ThemeChoice = ThemeId;
export { THEMES };

export const THEME_KEY = 'dek.theme';

const listeners = new Set<() => void>();
const IDS: readonly string[] = THEMES.map((t) => t.id);

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return typeof v === 'string' && IDS.includes(v);
}

export function readTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ThemeChoice {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isThemeChoice(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

// A ?theme= link applies to this page load only (the shared rule): it wins over the
// saved choice but is not stored.
function addressTheme(): ThemeChoice | null {
  try {
    const v = new URLSearchParams(window.location.search).get('theme');
    return isThemeChoice(v) ? v : null;
  } catch {
    return null;
  }
}

export function applyTheme(choice: ThemeChoice, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

// The shared module learns Dek's storage key once (initTheme), before any pick.
let started = false;
function start(): void {
  if (started) return;
  started = true;
  initTheme(THEME_KEY);
}

export function setTheme(choice: ThemeChoice): void {
  const next = isThemeChoice(choice) ? choice : 'auto';
  start();
  setSharedTheme(next);   // data-theme, storage, browser bar, drops ?theme=
  current = next;
  syncNativeBars(next);
  for (const l of listeners) l();
}

// The Android and iOS apps tint their status bar to match (a no-op in browsers).
// Loaded on demand so this file stays free of the native layer's imports, which
// main.tsx initialises in its own order.
function syncNativeBars(choice: ThemeChoice): void {
  const style = choice === 'dark' ? 'dark' : choice === 'auto' ? 'system' : 'light';
  void import('../../native')
    .then((m) => m.setNativeBarStyle(style))
    .catch(() => undefined);
}

export function applyStoredTheme(): ThemeChoice {
  const choice = addressTheme() ?? readTheme();
  current = choice;
  applyTheme(choice);
  start();
  return choice;
}

let current: ThemeChoice | null = null;

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current ?? (current = readTheme()),
    () => 'auto' as ThemeChoice,
  );
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
