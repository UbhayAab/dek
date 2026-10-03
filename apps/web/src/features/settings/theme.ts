// Appearance: light, dark or follow the system. Stored per device in localStorage
// under dek.theme and applied as data-theme on <html> (tokens.css has both
// palettes); "system" removes the attribute so prefers-color-scheme decides.
// applyStoredTheme() belongs at app start (before first paint) so a dark choice
// does not flash light.
import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_KEY = 'dek.theme';

const listeners = new Set<() => void>();

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === 'light' || v === 'dark' || v === 'system';
}

export function readTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ThemeChoice {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isThemeChoice(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setTheme(choice: ThemeChoice, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()): void {
  try {
    if (choice === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, choice);
  } catch {
    // private mode or blocked storage: the choice still applies for this visit
  }
  current = choice;
  applyTheme(choice);
  for (const l of listeners) l();
}

export function applyStoredTheme(): ThemeChoice {
  const choice = readTheme();
  current = choice;
  applyTheme(choice);
  return choice;
}

let current: ThemeChoice | null = null;

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current ?? (current = readTheme()),
    () => 'system' as ThemeChoice,
  );
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
