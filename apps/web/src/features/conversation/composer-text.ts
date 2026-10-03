// The composer shows people "@Alice Member" and "#grants" while the message body
// carries <@uuid> and <#uuid> tokens (CONTRACT 0), so a rename never breaks an old
// mention. Drafts are stored ENCODED, so they survive reloads with their mentions.
// Pure functions; unit tested.

export type RefKind = 'user' | 'channel' | 'special';

export interface MentionRef {
  kind: RefKind;
  id: string;          // user or channel uuid, or 'channel' / 'here' for specials
  display: string;     // exactly what the textarea shows: "@Alice Member", "#grants", "@here"
}

export interface Resolvers {
  user: (id: string) => string | null;
  channel: (id: string) => string | null;
}

const TOKEN = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>|<#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>|<!(channel|here)>/gi;

// Encoded body (from a draft or a message being edited) to what the textarea shows.
export function decodeForEditing(body: string, resolve: Resolvers): { text: string; refs: MentionRef[] } {
  const refs: MentionRef[] = [];
  const text = body.replace(TOKEN, (whole, userId: string | undefined, channelId: string | undefined, special: string | undefined) => {
    if (userId) {
      const name = resolve.user(userId.toLowerCase());
      if (!name) return whole;
      const display = `@${name}`;
      refs.push({ kind: 'user', id: userId.toLowerCase(), display });
      return display;
    }
    if (channelId) {
      const name = resolve.channel(channelId.toLowerCase());
      if (!name) return whole;
      const display = `#${name}`;
      refs.push({ kind: 'channel', id: channelId.toLowerCase(), display });
      return display;
    }
    const display = `@${special!.toLowerCase()}`;
    refs.push({ kind: 'special', id: special!.toLowerCase(), display });
    return display;
  });
  return { text, refs: dedupeRefs(refs) };
}

export function dedupeRefs(refs: MentionRef[]): MentionRef[] {
  const byDisplay = new Map<string, MentionRef>();
  for (const r of refs) byDisplay.set(r.display, r); // the latest choice wins
  return [...byDisplay.values()];
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// What the textarea shows to the body the server receives. A display string is
// replaced only as a whole word, longest first, so "@Ann" never eats "@Anna".
// "@channel" and "@here" become tokens only where they are allowed.
export function encodeForSending(text: string, refs: MentionRef[], opts: { allowAll: boolean }): string {
  const all: MentionRef[] = [...refs];
  if (opts.allowAll) {
    if (!all.some((r) => r.display === '@channel')) all.push({ kind: 'special', id: 'channel', display: '@channel' });
    if (!all.some((r) => r.display === '@here')) all.push({ kind: 'special', id: 'here', display: '@here' });
  }
  const usable = all.filter((r) => r.kind !== 'special' || opts.allowAll);
  if (!usable.length) return text;
  usable.sort((a, b) => b.display.length - a.display.length);
  const byDisplay = new Map(usable.map((r) => [r.display.toLowerCase(), r]));
  const re = new RegExp(usable.map((r) => escapeRe(r.display)).join('|'), 'giu');
  return text.replace(re, (match, offset: number, whole: string) => {
    const before = whole[offset - 1];
    const after = whole[offset + match.length];
    if (isWordChar(before) || isWordChar(after)) return match;
    const ref = byDisplay.get(match.toLowerCase());
    if (!ref) return match;
    // Specials are case-insensitive; names must match as written.
    if (ref.kind !== 'special' && ref.display !== match) return match;
    if (ref.kind === 'user') return `<@${ref.id}>`;
    if (ref.kind === 'channel') return `<#${ref.id}>`;
    return `<!${ref.id}>`;
  });
}

export interface Trigger {
  char: '@' | '#' | ':';
  start: number;   // index of the trigger character
  query: string;   // text between the trigger and the caret
}

// The mention, channel or emoji being typed at the caret, if any. A trigger
// counts at the start of the text or after whitespace or an opening bracket;
// people names may contain up to two spaces; nothing spans a line break.
export function findTrigger(text: string, caret: number): Trigger | null {
  const upto = text.slice(0, caret);
  const maxBack = 48;
  for (let i = upto.length - 1; i >= 0 && upto.length - i <= maxBack; i -= 1) {
    const ch = upto[i]!;
    if (ch === '\n') return null;
    if (ch === '@' || ch === '#' || ch === ':') {
      const prev = upto[i - 1];
      if (prev !== undefined && !/[\s([{"']/u.test(prev)) continue;
      const query = upto.slice(i + 1);
      const spaces = (query.match(/ /g) ?? []).length;
      if (ch === '@' && spaces > 2) return null;
      if (ch !== '@' && spaces > 0) return null;
      if (/^\s/u.test(query)) return null;
      if (ch === ':' && query.length < 2) return null;
      return { char: ch, start: i, query };
    }
  }
  return null;
}

// Replace the trigger and its query with the chosen text plus one space.
export function applyCompletion(text: string, trig: Trigger, caret: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, trig.start);
  const after = text.slice(caret);
  const spacer = after.startsWith(' ') ? '' : ' ';
  const next = `${before}${insert}${spacer}${after}`;
  return { text: next, caret: before.length + insert.length + 1 };
}

// Insert at the caret (emoji picker, paste helpers).
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}
