// Types for the shared theme.mjs (E:/claude/jcf-themes, copied unchanged).
export type ThemeId = 'auto' | 'light' | 'dark' | 'classic' | 'contrast';
export const THEMES: readonly { id: ThemeId; label: string; hint: string }[];
export function initTheme(key?: string): void;
export function currentTheme(): ThemeId;
export function setTheme(id: ThemeId): void;
