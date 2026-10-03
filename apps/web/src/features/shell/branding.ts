// The organization's brand color drives --org and --org-fg (DEK01: switching
// organization must be unmistakable). The color comes from the database, so it is
// validated before it reaches a style attribute (legacy lesson: an unvalidated
// value in a style was an XSS).
import type { CSSProperties } from 'react';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const FALLBACK = '#4f46e5';

export function safeColor(input: string | null | undefined): string {
  if (!input || !HEX.test(input.trim())) return FALLBACK;
  const v = input.trim().toLowerCase();
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return v;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const v = safeColor(hex);
  const r = parseInt(v.slice(1, 3), 16);
  const g = parseInt(v.slice(3, 5), 16);
  const b = parseInt(v.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// White text when it reads at 4.5:1 on the brand color, otherwise near-black.
export function onColor(bg: string): string {
  return contrast(bg, '#ffffff') >= 4.5 ? '#ffffff' : '#111114';
}

export function brandVars(color: string | null | undefined): CSSProperties {
  const org = safeColor(color);
  return { ['--org' as string]: org, ['--org-fg' as string]: onColor(org) } as CSSProperties;
}

export function orgInitials(name: string, short?: string | null): string {
  const src = (short && short.trim()) || name;
  const words = src.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
