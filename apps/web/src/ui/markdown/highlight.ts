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
  const re = parts.length ? new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(?:${parts.join('|')})`, 'giu') : null;
  if (cache.size > 64) cache.clear();
  cache.set(key, re);
  return re;
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
    if (!m[0]) continue;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(createElement('mark', { key: key++, className: 'dk-md-hl' }, m[0]));
    last = start + m[0].length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}
