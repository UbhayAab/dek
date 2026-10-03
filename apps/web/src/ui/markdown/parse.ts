// Message body parser for exactly the CONTRACT section 0 subset, rendered the way
// the legacy markdown-it setup (breaks: true, linkify) rendered the real data:
// paragraphs with kept line breaks, **bold**, *italic* and _italic_, ~~strike~~,
// `code`, fenced code blocks, > quotes, - * + and 1. lists, safe links, and the
// <@user>, <#channel>, <!channel>, <!here> tokens. Everything else is literal text.
//
// Pure functions that build a small AST (types.ts). Every scanner is linear or
// bounded, no regex can backtrack catastrophically, and nesting is capped at
// MAX_DEPTH so a hostile body cannot hang the tab or overflow the stack.
import type { Block, Inline, ListItem } from './types';

export const MAX_DEPTH = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const MAX_URL = 2048;
const EMPHASIS_BUDGET = 200_000;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const WS_RE = /^\s$/u;
const PUNCT_RE = /^[\p{P}\p{S}]$/u;
const URL_STOP = /[\s<>"`]/u;

// ------------------------------------------------------------------ links

// The only way a link reaches the DOM: an explicit http, https or mailto URL that
// the URL parser accepts. Whitespace and control characters anywhere (java\tscript:)
// are refused before parsing, and the parsed protocol is checked again after.
export function safeHref(raw: string): string | null {
  if (!raw || raw.length > MAX_URL) return null;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return null;
  }
  const scheme = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(raw);
  if (!scheme || !SAFE_PROTOCOLS.has(`${scheme[1]!.toLowerCase()}:`)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
  if (url.protocol === 'mailto:') {
    if (!/^[^@\s]+@[^@\s]+$/.test(url.pathname)) return null;
  } else if (!url.hostname) {
    return null;
  }
  return url.href;
}

function prevChar(src: string, i: number): string {
  if (i <= 0) return '';
  const low = src.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = src.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return src.slice(i - 2, i);
  }
  return src.charAt(i - 1);
}

function nextChar(src: string, i: number): string {
  if (i >= src.length) return '';
  const cp = src.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

// Trailing punctuation is not part of a bare URL, and neither is a closing bracket
// without its opener ("(see https://x.org)"), but Foo_(bar) keeps its parenthesis.
function trimUrlEnd(src: string, start: number, end: number): number {
  let e = end;
  while (e > start) {
    const c = src.charAt(e - 1);
    if ('.,:;!?\'"*_~'.includes(c)) {
      e -= 1;
      continue;
    }
    const open = c === ')' ? '(' : c === ']' ? '[' : c === '}' ? '{' : '';
    if (open) {
      let opens = 0;
      let closes = 0;
      for (let k = start; k < e; k += 1) {
        const d = src.charAt(k);
        if (d === open) opens += 1;
        else if (d === c) closes += 1;
      }
      if (closes > opens) {
        e -= 1;
        continue;
      }
    }
    break;
  }
  return e;
}

// A bare http(s):// or www. URL starting at i. A candidate that is not a usable
// link is consumed as plain text (node null) so the scan stays linear.
function bareUrl(src: string, i: number): { node: Inline | null; end: number } | null {
  const head = src.slice(i, i + 8).toLowerCase();
  const www = head.startsWith('www.');
  const https = head.startsWith('https://');
  if (!www && !https && !head.startsWith('http://')) return null;
  const lim = Math.min(src.length, i + MAX_URL);
  let j = i;
  while (j < lim && !URL_STOP.test(src.charAt(j))) j += 1;
  const end = trimUrlEnd(src, i, j);
  const text = src.slice(i, end);
  const prefix = www ? 4 : https ? 8 : 7;
  if (text.length <= prefix) return null;
  const href = safeHref(www ? `http://${text}` : text);
  let host = '';
  if (href) {
    try {
      host = new URL(href).hostname;
    } catch {
      host = '';
    }
  }
  if (!href || (!host.includes('.') && host !== 'localhost')) return { node: null, end };
  return { node: { t: 'link', href, c: [{ t: 'text', v: text }] }, end };
}

// <@uuid>, <#uuid>, <!channel>, <!here> and <scheme:...> autolinks. Anything else
// in angle brackets (all HTML) stays literal. The scan stops at the next '<' or
// whitespace, so a run of '<' characters costs O(1) each.
function angleToken(src: string, i: number, links: boolean): { node: Inline; end: number } | null {
  const lim = Math.min(src.length, i + MAX_URL + 2);
  let j = i + 1;
  while (j < lim) {
    const c = src.charAt(j);
    if (c === '>') break;
    if (c === '<' || c === ' ' || c === '\t' || c === '\n') return null;
    j += 1;
  }
  if (j >= lim || src.charAt(j) !== '>') return null;
  const inner = src.slice(i + 1, j);
  const end = j + 1;
  const sigil = inner.charAt(0);
  const rest = inner.slice(1);
  if (sigil === '@' && UUID_RE.test(rest)) return { node: { t: 'user', id: rest.toLowerCase() }, end };
  if (sigil === '#' && UUID_RE.test(rest)) return { node: { t: 'channel', id: rest.toLowerCase() }, end };
  if (inner === '!channel') return { node: { t: 'all', v: 'channel' }, end };
  if (inner === '!here') return { node: { t: 'all', v: 'here' }, end };
  if (links && /^[a-z][a-z0-9+.-]{1,31}:/i.test(inner)) {
    const href = safeHref(inner);
    if (href) return { node: { t: 'link', href, c: [{ t: 'text', v: inner }] }, end };
  }
  return null;
}

// Matching brackets for every '[' in one pass, so link detection is linear.
function matchBrackets(src: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      // backslash: the next character is escaped
      i += 1;
      continue;
    }
    if (c === 91) stack.push(i);
    else if (c === 93) {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  return pairs;
}

function unescapePunct(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charAt(i);
    const d = s.charAt(i + 1);
    if (c === '\\' && d && ASCII_PUNCT.includes(d)) {
      out += d;
      i += 1;
    } else {
      out += c;
    }
  }
  return out;
}

const isSpace = (c: string) => c === ' ' || c === '\t';

// The "(url "optional title")" part of a [label](url) link, starting after '('.
function linkDestination(src: string, p: number): { url: string; end: number } | null {
  const n = src.length;
  let i = p;
  while (i < n && isSpace(src.charAt(i))) i += 1;
  let url: string;
  if (src.charAt(i) === '<') {
    let j = i + 1;
    const lim = Math.min(n, j + MAX_URL);
    while (j < lim && src.charAt(j) !== '>' && src.charAt(j) !== '<' && src.charAt(j) !== '\n') j += 1;
    if (src.charAt(j) !== '>') return null;
    url = src.slice(i + 1, j);
    i = j + 1;
  } else {
    const start = i;
    const lim = Math.min(n, i + MAX_URL);
    let parens = 0;
    while (i < lim) {
      const c = src.charAt(i);
      const d = src.charAt(i + 1);
      if (c === '\\' && d && ASCII_PUNCT.includes(d)) {
        i += 2;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') {
        parens += 1;
        if (parens > 32) return null;
      } else if (c === ')') {
        if (parens === 0) break;
        parens -= 1;
      }
      i += 1;
    }
    if (i >= lim && lim < n) return null;
    url = unescapePunct(src.slice(start, i));
  }
  while (i < n && (isSpace(src.charAt(i)) || src.charAt(i) === '\n')) i += 1;
  const q = src.charAt(i);
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    const lim = Math.min(n, i + 1 + 1024);
    let j = i + 1;
    while (j < lim && src.charAt(j) !== close) j += 1;
    if (src.charAt(j) !== close) return null;
    i = j + 1;
    while (i < n && isSpace(src.charAt(i))) i += 1;
  }
  if (src.charAt(i) !== ')') return null;
  return { url, end: i + 1 };
}

// [label](url). An unsafe destination turns the whole source into literal text.
function linkAt(src: string, i: number, pairs: Map<number, number>, depth: number): { node: Inline; end: number } | null {
  const close = pairs.get(i);
  if (close === undefined || src.charAt(close + 1) !== '(') return null;
  const dest = linkDestination(src, close + 2);
  if (!dest) return null;
  const href = safeHref(dest.url);
  if (!href) return { node: { t: 'text', v: src.slice(i, dest.end) }, end: dest.end };
  const label = src.slice(i + 1, close);
  const children: Inline[] = depth + 1 >= MAX_DEPTH
    ? (label ? [{ t: 'text', v: label }] : [])
    : parseInline(label, depth + 1, false);
  return { node: { t: 'link', href, c: children.length ? children : [{ t: 'text', v: dest.url }] }, end: dest.end };
}

// ------------------------------------------------------------------ inline

interface Delim {
  t: 'delim';
  ch: string;
  len: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
}

type Tok = Inline | Delim;

const isDelim = (x: Tok): x is Delim => x.t === 'delim';

// CommonMark delimiter run rules, with Unicode whitespace and punctuation.
function flanking(ch: string, before: string, after: string): { canOpen: boolean; canClose: boolean } {
  const bWs = before === '' || WS_RE.test(before);
  const aWs = after === '' || WS_RE.test(after);
  const bP = PUNCT_RE.test(before);
  const aP = PUNCT_RE.test(after);
  const left = !aWs && (!aP || bWs || bP);
  const right = !bWs && (!bP || aWs || aP);
  if (ch === '_') return { canOpen: left && (!right || bP), canClose: right && (!left || aP) };
  return { canOpen: left, canClose: right };
}

function tickCloser(src: string, from: number, run: number): number {
  let i = from;
  for (;;) {
    const j = src.indexOf('`', i);
    if (j < 0) return -1;
    let k = j;
    while (k < src.length && src.charCodeAt(k) === 96) k += 1;
    if (k - j === run) return j;
    i = k;
  }
}

function trimEndSpaces(s: string): string {
  let e = s.length;
  while (e > 0 && isSpace(s.charAt(e - 1))) e -= 1;
  return e === s.length ? s : s.slice(0, e);
}

function tokenize(src: string, depth: number, links: boolean): Tok[] {
  const out: Tok[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };
  const pairs = links ? matchBrackets(src) : null;
  // A backtick run length with no closer after some position has none after any
  // later position either, so each length is searched for at most once in vain.
  const deadTicks = new Set<number>();
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charAt(i);

    if (c === '\\') {
      const d = src.charAt(i + 1);
      if (d === '\n') {
        buf = trimEndSpaces(buf);
        flush();
        out.push({ t: 'br' });
        i += 2;
        continue;
      }
      if (d && ASCII_PUNCT.includes(d)) {
        buf += d;
        i += 2;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '\n') {
      buf = trimEndSpaces(buf);
      flush();
      out.push({ t: 'br' });
      i += 1;
      while (i < n && isSpace(src.charAt(i))) i += 1;
      continue;
    }

    if (c === '`') {
      let run = 1;
      while (i + run < n && src.charCodeAt(i + run) === 96) run += 1;
      const close = deadTicks.has(run) ? -1 : tickCloser(src, i + run, run);
      if (close < 0) {
        deadTicks.add(run);
        buf += '`'.repeat(run);
        i += run;
        continue;
      }
      let code = src.slice(i + run, close).replace(/\n/g, ' ');
      if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
      flush();
      out.push({ t: 'code', v: code });
      i = close + run;
      continue;
    }

    if (c === '<') {
      const tok = angleToken(src, i, links);
      if (tok) {
        flush();
        out.push(tok.node);
        i = tok.end;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '[' && pairs) {
      const tok = linkAt(src, i, pairs, depth);
      if (tok) {
        if (tok.node.t === 'text') {
          buf += tok.node.v;
        } else {
          flush();
          out.push(tok.node);
        }
        i = tok.end;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (i + run < n && src.charAt(i + run) === c) run += 1;
      // Only the subset's markers: * and ** (*** is both), single _, and ~~.
      const usable = c === '~' ? run === 2 : c === '_' ? run === 1 : run <= 3;
      const { canOpen, canClose } = usable
        ? flanking(c, prevChar(src, i), nextChar(src, i + run))
        : { canOpen: false, canClose: false };
      if (!canOpen && !canClose) {
        buf += c.repeat(run);
        i += run;
        continue;
      }
      flush();
      out.push({ t: 'delim', ch: c, len: run, orig: run, canOpen, canClose });
      i += run;
      continue;
    }

    if (links && (c === 'h' || c === 'H' || c === 'w' || c === 'W') && !WORD_CHAR.test(prevChar(src, i))) {
      const tok = bareUrl(src, i);
      if (tok) {
        if (tok.node) {
          flush();
          out.push(tok.node);
        } else {
          buf += src.slice(i, tok.end);
        }
        i = Math.max(tok.end, i + 1);
        continue;
      }
    }

    buf += c;
    i += 1;
  }
  flush();
  return out;
}

function finalize(tokens: Tok[]): Inline[] {
  const out: Inline[] = [];
  for (const tok of tokens) {
    const node: Inline = isDelim(tok) ? { t: 'text', v: tok.ch.repeat(tok.len) } : tok;
    if (node.t === 'text') {
      if (!node.v) continue;
      const last = out[out.length - 1];
      if (last && last.t === 'text') {
        out[out.length - 1] = { t: 'text', v: last.v + node.v };
        continue;
      }
    }
    out.push(node);
  }
  return out;
}

// CommonMark "process emphasis" over the token list. The delimiter objects are
// fresh per parse, so updating their remaining lengths in place is local state.
// Matching stops after a fixed amount of work, and wrapping stops at MAX_DEPTH;
// whatever is left over renders as the literal characters.
function processEmphasis(tokens: Tok[]): Inline[] {
  const nodes: Tok[] = tokens.slice();
  const depthOf = new WeakMap<object, number>();
  let budget = EMPHASIS_BUDGET;
  let ci = 0;
  while (ci < nodes.length && budget > 0) {
    const closer = nodes[ci]!;
    if (!isDelim(closer) || !closer.canClose || closer.len === 0) {
      ci += 1;
      continue;
    }
    let oi = -1;
    for (let k = ci - 1; k >= 0 && budget > 0; k -= 1) {
      budget -= 1;
      const o = nodes[k]!;
      if (!isDelim(o) || o.ch !== closer.ch || !o.canOpen || o.len === 0) continue;
      if (closer.ch !== '~' && (o.canClose || closer.canOpen)
        && (o.orig + closer.orig) % 3 === 0 && !(o.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
      oi = k;
      break;
    }
    if (oi < 0) {
      ci += 1;
      continue;
    }
    const opener = nodes[oi] as Delim;
    const use = closer.ch === '~' ? 2 : opener.len >= 2 && closer.len >= 2 ? 2 : 1;
    const inner = finalize(nodes.slice(oi + 1, ci));
    let innerDepth = 0;
    for (const x of inner) innerDepth = Math.max(innerDepth, depthOf.get(x) ?? 0);
    if (innerDepth + 1 > MAX_DEPTH) {
      ci += 1;
      continue;
    }
    const wrapped: Inline = closer.ch === '~' ? { t: 'del', c: inner } : { t: use === 2 ? 'strong' : 'em', c: inner };
    depthOf.set(wrapped, innerDepth + 1);
    opener.len -= use;
    closer.len -= use;
    nodes.splice(oi + 1, ci - oi - 1, wrapped);
    let at = oi + 2;
    if (opener.len === 0) {
      nodes.splice(oi, 1);
      at -= 1;
    }
    if (closer.len === 0) nodes.splice(at, 1);
    ci = at;
  }
  return finalize(nodes);
}

// Inline content of one paragraph or list item. `links` false inside link labels
// (a link cannot contain a link).
export function parseInline(src: string, depth = 0, links = true): Inline[] {
  if (!src) return [];
  return processEmphasis(tokenize(src, depth, links));
}

// ------------------------------------------------------------------ blocks

interface Marker {
  indent: number;
  ordered: boolean;
  ch: string;
  start: number;
  contentCol: number;
  text: string;
}

interface Fence {
  indent: number;
  len: number;
  lang: string | null;
}

const isBlank = (line: string) => line.trim() === '';

function indentOf(line: string): number {
  let col = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (c === ' ') col += 1;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Removes up to `cols` columns of leading whitespace (tabs count to the next stop).
function stripColumns(line: string, cols: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const c = line.charAt(i);
    if (c === ' ') {
      col += 1;
      i += 1;
      continue;
    }
    if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w > cols) return ' '.repeat(col + w - cols) + line.slice(i + 1);
      col += w;
      i += 1;
      continue;
    }
    break;
  }
  return line.slice(i);
}

function minIndent(lines: string[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (isBlank(line)) continue;
    min = Math.min(min, indentOf(line));
  }
  return Number.isFinite(min) ? min : 0;
}

function listMarker(line: string): Marker | null {
  let i = 0;
  let indent = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === ' ') indent += 1;
    else if (c === '\t') indent += 4 - (indent % 4);
    else break;
    i += 1;
  }
  const c = line.charAt(i);
  let markerEnd: number;
  let ordered = false;
  let start = 1;
  let ch = c;
  if (c === '-' || c === '*' || c === '+') {
    markerEnd = i + 1;
  } else if (c >= '0' && c <= '9') {
    let j = i;
    while (j < line.length && j - i < 10 && line.charAt(j) >= '0' && line.charAt(j) <= '9') j += 1;
    if (j - i > 9) return null;
    const d = line.charAt(j);
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    ch = d;
    start = Number.parseInt(line.slice(i, j), 10);
    markerEnd = j + 1;
  } else {
    return null;
  }
  let k = markerEnd;
  while (k < line.length && isSpace(line.charAt(k))) k += 1;
  const spaces = k - markerEnd;
  if (spaces === 0) return null;
  const text = line.slice(k).trimEnd();
  if (!text) return null;
  const contentCol = indent + (markerEnd - i) + (spaces > 4 ? 1 : spaces);
  return { indent, ordered, ch, start, contentCol, text };
}

function fenceOpen(line: string): Fence | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const rest = line.trimStart();
  let n = 0;
  while (n < rest.length && rest.charCodeAt(n) === 96) n += 1;
  if (n < 3) return null;
  const info = rest.slice(n).trim();
  if (info.includes('`')) return null;
  const lang = info ? (info.split(/\s+/)[0] ?? '').slice(0, 32) : '';
  return { indent, len: n, lang: lang || null };
}

function fenceClose(line: string, len: number): boolean {
  if (indentOf(line) > 3) return false;
  const rest = line.trimStart();
  let n = 0;
  while (n < rest.length && rest.charCodeAt(n) === 96) n += 1;
  return n >= len && rest.slice(n).trim() === '';
}

function quoteContent(line: string): string | null {
  if (indentOf(line) > 3) return null;
  const rest = line.trimStart();
  if (rest.charAt(0) !== '>') return null;
  const after = rest.slice(1);
  return after.startsWith(' ') || after.startsWith('\t') ? after.slice(1) : after;
}

function startsFenceOrQuote(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('```') || t.startsWith('>');
}

// A bullet list may interrupt a paragraph; an ordered list only when it starts at 1.
function interruptsParagraph(line: string): boolean {
  if (fenceOpen(line) || quoteContent(line) !== null) return true;
  const m = listMarker(line);
  return !!m && m.indent < 4 && (!m.ordered || m.start === 1);
}

function paragraph(lines: string[]): Block {
  return { t: 'p', c: parseInline(lines.map((l) => l.trim()).join('\n')) };
}

function flatParagraphs(lines: string[]): Block[] {
  const kept = lines.filter((l) => !isBlank(l));
  return kept.length ? [paragraph(kept)] : [];
}

const sameList = (a: Marker, b: Marker) => a.ordered === b.ordered && a.ch === b.ch;

function buildItem(textLines: string[], childLines: string[], depth: number): ListItem {
  if (childLines.length === 0) return { c: parseInline(textLines.join('\n')), children: [] };
  if (depth + 1 >= MAX_DEPTH) {
    const flat = [...textLines, ...childLines.filter((l) => !isBlank(l)).map((l) => l.trim())];
    return { c: parseInline(flat.join('\n')), children: [] };
  }
  const base = minIndent(childLines);
  const children = blocksFromLines(childLines.map((l) => stripColumns(l, base)), depth + 1);
  return { c: parseInline(textLines.join('\n')), children };
}

// Items at the first marker's indentation are siblings; a marker indented further
// nests; a plain line right after an item continues it (rendered with a line break).
function parseList(lines: string[], startIdx: number, first: Marker, depth: number): { block: Block; next: number } {
  const items: ListItem[] = [];
  const n = lines.length;
  let i = startIdx;
  let current: Marker | null = first;
  while (current) {
    const textLines: string[] = [current.text];
    const childLines: string[] = [];
    let next: Marker | null = null;
    i += 1;
    while (i < n) {
      const line = lines[i]!;
      if (isBlank(line)) {
        let k = i + 1;
        while (k < n && isBlank(lines[k]!)) k += 1;
        if (k >= n) {
          i = k;
          break;
        }
        const ahead = lines[k]!;
        const am = listMarker(ahead);
        if (am && am.indent === first.indent && sameList(am, first)) {
          i = k;
          next = am;
          break;
        }
        const aIndent = indentOf(ahead);
        if (aIndent > first.indent && (childLines.length > 0 || am !== null || aIndent >= current.contentCol)) {
          if (childLines.length > 0) for (let b = i; b < k; b += 1) childLines.push('');
          i = k;
          continue;
        }
        break;
      }
      const m = listMarker(line);
      if (m && m.indent === first.indent && sameList(m, first)) {
        next = m;
        break;
      }
      if (m && m.indent <= first.indent) break;
      const ind = indentOf(line);
      const blockish = startsFenceOrQuote(line);
      if (ind > first.indent && (m !== null || childLines.length > 0 || (blockish && ind >= current.contentCol))) {
        childLines.push(line);
        i += 1;
        continue;
      }
      if (blockish) break;
      if (childLines.length > 0) childLines.push(line);
      else textLines.push(line.trim());
      i += 1;
    }
    items.push(buildItem(textLines, childLines, depth));
    current = next;
  }
  return { block: { t: 'list', ordered: first.ordered, start: first.start, items }, next: i };
}

function blocksFromLines(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < n && !fenceClose(lines[i]!, fence.len)) {
        body.push(stripColumns(lines[i]!, fence.indent));
        i += 1;
      }
      if (i < n) i += 1;
      out.push({ t: 'code', v: body.join('\n'), lang: fence.lang });
      continue;
    }

    if (quoteContent(line) !== null) {
      const inner: string[] = [];
      while (i < n) {
        const q = quoteContent(lines[i]!);
        if (q === null) break;
        inner.push(q);
        i += 1;
      }
      out.push({ t: 'quote', c: depth + 1 >= MAX_DEPTH ? flatParagraphs(inner) : blocksFromLines(inner, depth + 1) });
      continue;
    }

    const marker = listMarker(line);
    if (marker && marker.indent < 4) {
      const list = parseList(lines, i, marker, depth);
      out.push(list.block);
      i = list.next;
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < n && !isBlank(lines[i]!) && !interruptsParagraph(lines[i]!)) {
      para.push(lines[i]!);
      i += 1;
    }
    out.push(paragraph(para));
  }
  return out;
}

export function parseBlocks(body: string): Block[] {
  if (!body) return [];
  return blocksFromLines(body.replace(/\r\n?/g, '\n').split('\n'), 0);
}

// ------------------------------------------------------------------ emoji

// One emoji: a flag pair, a keycap, or a pictograph with optional VS16, skin tone,
// tag sequence and ZWJ joins. Every repetition needs a fixed leading character, so
// the pattern cannot backtrack badly.
const EMOJI_SEQ = /(?:\p{Regional_Indicator}\p{Regional_Indicator}|[0-9#*]️?⃣|\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:‍\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]*)*)/uy;

// True when the whole body is 1 to 3 emoji (whitespace between allowed).
export function isJumboEmoji(body: string): boolean {
  const s = (body ?? '').trim();
  if (!s || s.length > 64) return false;
  let i = 0;
  let count = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === ' ' || c === '\n' || c === '\t') {
      i += 1;
      continue;
    }
    EMOJI_SEQ.lastIndex = i;
    const m = EMOJI_SEQ.exec(s);
    if (!m || m[0].length === 0) return false;
    count += 1;
    if (count > 3) return false;
    i += m[0].length;
  }
  return count > 0;
}
