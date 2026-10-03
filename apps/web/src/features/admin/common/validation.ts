// Client-side form validation. Mirrors the server's own limits (docs/CONTRACT.md
// section 0 and the [org] and [plat] functions) so people see the problem under the
// field before a round trip; the server still decides. Pure, unit tested.

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export function hasErrors(e: Record<string, string | undefined>): boolean {
  return Object.values(e).some(Boolean);
}

// Lengths as the database counts them (characters, not UTF-16 units).
export function charCount(s: string): number {
  return Array.from(s).length;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

export function clean(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function text(value: string, label: string, max: number, opts: { required?: boolean; singleLine?: boolean } = {}): string | undefined {
  const v = clean(value);
  if (!v) return opts.required ? `${label} is required.` : undefined;
  if (charCount(v) > max) return `${label} can be at most ${max} characters.`;
  if (opts.singleLine !== false && CONTROL.test(v)) return `${label} must be a single line.`;
  return undefined;
}

// ------------------------------------------------------------------ servers, channels

export type ServerField = 'name' | 'description' | 'icon_emoji';

export function validateServer(v: { name: string; description: string; icon_emoji: string }): FieldErrors<ServerField> {
  return {
    name: text(v.name, 'Name', 80, { required: true }),
    description: text(v.description, 'Description', 1000, { singleLine: false }),
    icon_emoji: text(v.icon_emoji, 'Icon', 64),
  };
}

export type ChannelField = 'name' | 'topic' | 'description' | 'category';

export function validateChannel(v: { name: string; topic: string; description: string; category: string }): FieldErrors<ChannelField> {
  return {
    name: text(v.name, 'Name', 80, { required: true }),
    topic: text(v.topic, 'Topic', 250),
    description: text(v.description, 'Description', 1000, { singleLine: false }),
    category: text(v.category, 'Category', 40),
  };
}

// ------------------------------------------------------------------ invites

export type InviteField = 'email' | 'expires' | 'max_uses' | 'channels';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isEmail(s: string): boolean {
  const v = clean(s);
  return v.length <= 254 && EMAIL.test(v);
}

// Whole number text -> number, or null when it is not one.
export function wholeNumber(s: string): number | null {
  const v = clean(s);
  if (!/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

export function validateInvite(v: { email: string; expiresHours: number; maxUses: string; channelCount: number }): FieldErrors<InviteField> {
  const out: FieldErrors<InviteField> = {};
  if (clean(v.email) && !isEmail(v.email)) out.email = 'Enter an email address such as name@example.org, or leave it empty.';
  if (!Number.isInteger(v.expiresHours) || v.expiresHours < 1 || v.expiresHours > 720) out.expires = 'Pick an expiry from 1 hour to 30 days.';
  if (clean(v.maxUses)) {
    const n = wholeNumber(v.maxUses);
    if (n === null || n < 1 || n > 10000) out.max_uses = 'Use a whole number from 1 to 10000, or leave it empty for no limit.';
  }
  if (v.channelCount > 20) out.channels = 'An invite can name at most 20 channels.';
  return out;
}

// ------------------------------------------------------------------ moderation

export function validateReason(reason: string, max = 500): string | undefined {
  return charCount(clean(reason)) > max ? `Keep it to ${max} characters.` : undefined;
}

// ------------------------------------------------------------------ profile, status

export type ProfileField = 'display_name' | 'handle' | 'title' | 'timezone';

// "@Asha.R" -> "asha.r"; blank -> null.
export function normalizeHandle(raw: string): string | null {
  const v = clean(raw).replace(/^@+/, '').toLowerCase();
  return v ? v : null;
}

export function validateProfile(v: { display_name: string; handle: string; title: string }): FieldErrors<ProfileField> {
  const out: FieldErrors<ProfileField> = {};
  const name = clean(v.display_name);
  if (!name) out.display_name = 'Your name is required.';
  else if (charCount(name) > 80) out.display_name = 'Your name can be at most 80 characters.';
  else if (CONTROL.test(name)) out.display_name = 'Your name must be a single line.';
  const handle = normalizeHandle(v.handle);
  if (handle !== null && !/^[a-z0-9][a-z0-9._-]{1,30}$/.test(handle)) {
    out.handle = 'Use 2 to 31 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.';
  }
  const title = text(v.title, 'Title', 80);
  if (title) out.title = title;
  return out;
}

export type StatusField = 'text' | 'emoji';

export function validateStatus(v: { text: string; emoji: string }): FieldErrors<StatusField> {
  const out: FieldErrors<StatusField> = {};
  if (charCount(clean(v.text).replace(/\s+/g, ' ')) > 100) out.text = 'A status can be at most 100 characters.';
  if (charCount(clean(v.emoji)) > 64) out.emoji = 'Use one emoji.';
  return out;
}

// ------------------------------------------------------------------ quiet hours

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateQuietHours(v: { enabled: boolean; start: string; end: string }): FieldErrors<'quiet_start' | 'quiet_end'> {
  if (!v.enabled) return {};
  const out: FieldErrors<'quiet_start' | 'quiet_end'> = {};
  if (!HHMM.test(v.start)) out.quiet_start = 'Pick when quiet hours start.';
  if (!HHMM.test(v.end)) out.quiet_end = 'Pick when quiet hours end.';
  if (!out.quiet_start && !out.quiet_end && v.start === v.end) out.quiet_end = 'The end must be a different time from the start.';
  return out;
}

// "22:30" -> "10:30 pm" style text for summaries.
export function hhmmLabel(v: string | null, locale?: string): string {
  if (!v || !HHMM.test(v)) return '';
  const [h, m] = v.split(':').map(Number) as [number, number];
  const d = new Date(Date.UTC(2020, 0, 1, h, m));
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d);
}
