// Organization branding (DEK01): the org's brand color becomes --org, and --org-fg
// is whichever of white or near-black reads better on it (WCAG contrast ratio).
export const DEFAULT_BRAND = '#4f46e5';
export const ON_DARK = '#ffffff';
export const ON_LIGHT = '#0f1115';

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX3 = /^#([0-9a-f]{3})$/i;

// Only #rgb and #rrggbb are accepted; anything else (names, rgb(), injected CSS)
// falls back to the default. Brand colors come from the database and end up in a
// style property, so they are validated, never passed through.
export function normalizeHex(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const m6 = HEX6.exec(s);
  if (m6) return `#${m6[1]!.toLowerCase()}`;
  const m3 = HEX3.exec(s);
  if (m3) return `#${m3[1]!.split('').map((c) => c + c).join('').toLowerCase()}`;
  return null;
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const h = normalizeHex(hex) ?? DEFAULT_BRAND;
  const n = Number.parseInt(h.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function foregroundFor(brand: string | null | undefined): string {
  const bg = normalizeHex(brand) ?? DEFAULT_BRAND;
  return contrastRatio(bg, ON_DARK) >= contrastRatio(bg, ON_LIGHT) ? ON_DARK : ON_LIGHT;
}

export function brandVars(brand: string | null | undefined): { org: string; orgFg: string } {
  const org = normalizeHex(brand) ?? DEFAULT_BRAND;
  return { org, orgFg: foregroundFor(org) };
}

export function applyBrand(brand: string | null | undefined, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return;
  const v = brandVars(brand);
  root.style.setProperty('--org', v.org);
  root.style.setProperty('--org-fg', v.orgFg);
}

export function clearBrand(root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return;
  root.style.removeProperty('--org');
  root.style.removeProperty('--org-fg');
}
