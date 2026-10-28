// Message body conversion: legacy body_text is canonical; the new body encodes
// mentions as <@uuid>, <!here>, <!channel> (docs/CONTRACT.md section 0).
import { plain } from './util.mjs';

// The legacy client's word edges (dek-legacy/js/core/composer.js resolveMentions):
// a mention opens where the previous character is not [\w.-] and closes at the end
// of the text or before one of these characters.
const OPEN_BLOCKER = /[\w.-]/;
const CLOSERS = /[\s.,!?;:)'"\]]/;

// toLowerCase() can change a string's length (U+0130 becomes two code units), which
// would shift every index between the lowered copy and the original text. Lower a
// character only when that keeps its length.
export function lowerSameLength(s) {
  let out = '';
  for (const ch of String(s)) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

// Replace "@username" / "@Display Name" of the given users by <@uuid>, longest
// candidate first, case-insensitive, only at word edges. `people` maps a user id to
// { username, display_name }. Returns { text, matched: Set<uuid> }.
export function convertMentions(text, ids, people) {
  const matched = new Set();
  if (!text || !ids?.length) return { text: text || '', matched };
  const cands = [];
  for (const id of ids) {
    const p = people.get(id);
    if (!p) continue;
    for (const name of [p.username, p.display_name]) {
      const n = name == null ? '' : String(name).trim();
      if (n) cands.push([lowerSameLength(`@${n}`), id]);
    }
  }
  if (!cands.length) return { text, matched };
  cands.sort((a, b) => b[0].length - a[0].length);
  const lower = lowerSameLength(text);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf('@', i);
    if (at === -1) break;
    out += text.slice(i, at);
    let hit = null;
    if (!(at > 0 && OPEN_BLOCKER.test(lower[at - 1]))) {
      for (const [name, id] of cands) {
        if (!lower.startsWith(name, at)) continue;
        const ch = lower[at + name.length];
        if (ch !== undefined && !CLOSERS.test(ch)) continue;
        hit = [name, id];
        break;
      }
    }
    if (hit) {
      out += `<@${hit[1]}>`;
      matched.add(hit[1]);
      i = at + hit[0].length;
    } else {
      out += '@';
      i = at + 1;
    }
  }
  out += text.slice(i);
  return { text: out, matched };
}

// The legacy scope tokens (composer.js mentionScope): "@channel" / "@here" after a
// line start or whitespace, ending at a word boundary.
export function convertScope(text) {
  return text
    .replace(/(^|\s)@channel\b/g, '$1<!channel>')
    .replace(/(^|\s)@here\b/g, '$1<!here>');
}

// Card messages (polls, events, forms) became plain text. LEGACY-MAP section 10.
export function cardText(body, bodyText) {
  if (!body || typeof body !== 'object') return null;
  if (body.type === 'form') return { kind: 'form', text: `Form: ${body.title || bodyText || 'untitled'} (form retired)` };
  if (body.type === 'poll') return { kind: 'poll', text: `Poll: ${bodyText || body.question || 'untitled'} (poll retired)` };
  if (body.kind === 'event_announcement') return { kind: 'event', text: bodyText || 'Event (events retired)' };
  return null;
}

// The quote line that replaces a legacy reply_to_id (the legacy client showed
// "↩ Name: first 90 characters" above the reply).
export function quoteLine(parent, authorName) {
  if (!parent) return '> (original message unavailable)';
  const who = (authorName || 'Unknown').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (parent.deleted_at) return `> ${who}: (deleted message)`;
  const hasAtt = Array.isArray(parent.attachments) && parent.attachments.length > 0;
  const text = plain(parent.body_text, 90) || (hasAtt ? '[attachment]' : '');
  return `> ${who}: ${text}`.trimEnd();
}

// What a card's text was built from, for reconciliation.
export function cardInner(body, bodyText) {
  if (!body || typeof body !== 'object') return null;
  if (body.type === 'form') return body.title || bodyText || 'untitled';
  if (body.type === 'poll') return bodyText || body.question || 'untitled';
  if (body.kind === 'event_announcement') return bodyText || 'Event (events retired)';
  return null;
}

// Canonical text for reconciliation hashes: both sides with mention syntax, scope
// tokens, the quote line and the card wrapper removed, whitespace collapsed.
export function normalizeLegacy(text, ids, people) {
  return stripTokens(convertMentions(text || '', ids || [], people).text);
}

export function normalizeNew(body, meta) {
  let t = body || '';
  if (meta?.legacy?.reply_to !== undefined) t = t.replace(/^> [^\n]*(\n|$)/, '');
  if (meta?.legacy?.card === 'form') t = t.replace(/^Form: /, '').replace(/ \(form retired\)$/, '');
  if (meta?.legacy?.card === 'poll') t = t.replace(/^Poll: /, '').replace(/ \(poll retired\)$/, '');
  return stripTokens(t);
}

const stripTokens = (s) => s
  .replace(/<@[0-9a-f-]{36}>/g, ' ')
  .replace(/<!(channel|here)>/g, ' ')
  .replace(/(^|\s)@(channel|here)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
