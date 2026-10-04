// Search term helpers. splitTerms mirrors the server's search, which matches every
// word as a prefix of a whole word (single characters match whole words only);
// highlightText marks those matches inside plain text as React elements.
import { Fragment, createElement, type ReactNode } from 'react';

const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const MAX_TERMS = 8;

export function splitTerms(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of (query ?? '').toLowerCase().matchAll(WORD)) {
    const word = m[0];
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cache = new Map<string, RegExp | null>();

function termsRegex(terms: string[]): RegExp | null {
  const key = terms.join('\u0000');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const clean = [...new Set(terms.map((t) => (t ?? '').toLowerCase().trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_TERMS);
  const parts = clean.map((t) => (t.length >= 2 ? escapeRe(t) : `${escapeRe(t)}(?![\\p{L}\\p{N}\\p{M}])`));
  // No lookbehind: WebKit before iOS 16.4 throws a SyntaxError on it, and this runs
  // during render. The start-of-word rule is checked in highlightText instead.
  let re: RegExp | null = null;
  try {
    re = parts.length ? new RegExp(`(?:${parts.join('|')})`, 'giu') : null;
  } catch {
    re = null;
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, re);
  return re;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

// True when the match starts inside a word (the previous code point is a letter,
// number or mark), which the old lookbehind used to exclude.
function insideWord(text: string, start: number): boolean {
  if (start === 0) return false;
  const unit = text.charCodeAt(start - 1);
  // a low surrogate ends a two-unit character that starts one unit earlier
  const at = unit >= 0xdc00 && unit <= 0xdfff && start >= 2 ? start - 2 : start - 1;
  const cp = text.codePointAt(at);
  return cp !== undefined && WORD_CHAR.test(String.fromCodePoint(cp));
}

export function highlightText(text: string, terms: string[] | undefined | null): ReactNode {
  if (!text || !terms?.length) return text;
  const re = termsRegex(terms);
  if (!re) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (!m[0] || insideWord(text, start)) continue;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(createElement('mark', { key: key++, className: 'dk-md-hl' }, m[0]));
    last = start + m[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}
