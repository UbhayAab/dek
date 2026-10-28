// Words and dates for the admin and settings screens. Pure functions (unit tested in
// tests/admin/format.test.ts): what a role, policy, invite or audit entry says to a
// person reading it.
import type { AuditItem, InviteSummary, OrgRole, Server, ServerRole } from '../../../api/types';

export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

export const ORG_ROLE_HELP: Record<OrgRole, string> = {
  owner: 'Can change every setting, including who the other owners are.',
  admin: 'Manages members, invites, team servers, reports and the audit log.',
  member: 'Joins team servers and channels and talks with everyone.',
  guest: 'Sees only the channels someone adds them to. Never joins a team server.',
};

export const SERVER_ROLE_LABEL: Record<ServerRole, string> = {
  admin: 'Server admin',
  moderator: 'Moderator',
  member: 'Member',
};

export const SERVER_ROLE_HELP: Record<ServerRole, string> = {
  admin: 'Changes server settings, members and every channel in it.',
  moderator: 'Removes members (not admins) and moderates messages.',
  member: 'Reads public channels and joins the ones they want.',
};

export const JOIN_POLICY: Record<Server['join_policy'], { label: string; description: string }> = {
  open: { label: 'Invites + Open', description: 'Organization members can join from Browse or with an invite link.' },
  approval: { label: 'Invites + Ask to join', description: 'Members can ask from Browse or use an invite link. A server admin approves each request.' },
  invite: { label: 'Invite only', description: 'Only admins add people, directly or with an invite link.' },
};

export function isRole(v: string | null | undefined): v is OrgRole {
  return v === 'owner' || v === 'admin' || v === 'member' || v === 'guest';
}

export function isServerRole(v: string | null | undefined): v is ServerRole {
  return v === 'admin' || v === 'moderator' || v === 'member';
}

export function orgRoleName(v: unknown): string {
  return typeof v === 'string' && isRole(v) ? ORG_ROLE_LABEL[v] : String(v ?? 'unknown');
}

export function serverRoleName(v: unknown): string {
  return typeof v === 'string' && isServerRole(v) ? SERVER_ROLE_LABEL[v] : String(v ?? 'unknown');
}

// ------------------------------------------------------------------ time

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatDate(iso: string, locale?: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(t);
}

export function formatDateTime(iso: string, locale?: string, timeZone?: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone,
  }).format(t);
}

// "just now", "5 minutes ago", "in 3 hours", "yesterday", then a date after a week.
export function relTime(iso: string | null | undefined, now: number = Date.now(), locale?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  // Within a minute either way reads "just now": a server clock a few seconds ahead
  // of the device must not make a new row look like it is from the future.
  if (abs < 60_000) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
  if (abs < 7 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
  return formatDate(iso, locale);
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ------------------------------------------------------------------ invites

export type InviteStatus = 'active' | 'expired' | 'used_up' | 'revoked';

export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  used_up: 'Used up',
  revoked: 'Revoked',
};

// The same order of reasons as the server's org_invite_problem: revoked, expired,
// used up. An invite to an archived team server no longer works either.
export function inviteStatus(
  inv: Pick<InviteSummary, 'revoked_at' | 'expires_at' | 'max_uses' | 'use_count' | 'server_id'>,
  now: number = Date.now(),
  archivedServerIds: ReadonlySet<string> = new Set(),
): InviteStatus {
  if (inv.revoked_at) return 'revoked';
  if (Date.parse(inv.expires_at) <= now) return 'expired';
  if (inv.max_uses !== null && inv.use_count >= inv.max_uses) return 'used_up';
  if (inv.server_id && archivedServerIds.has(inv.server_id)) return 'revoked';
  return 'active';
}

export function usesText(inv: Pick<InviteSummary, 'max_uses' | 'use_count'>): string {
  return inv.max_uses === null ? `${plural(inv.use_count, 'use', 'uses')}, no limit` : `${inv.use_count} of ${inv.max_uses} used`;
}

export const EXPIRY_CHOICES: readonly { hours: number; label: string }[] = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 336, label: '14 days' },
  { hours: 720, label: '30 days' },
];

export function expiryChoices(defaultHours: number): { hours: number; label: string }[] {
  const list = [...EXPIRY_CHOICES];
  if (!list.some((c) => c.hours === defaultHours) && defaultHours >= 1 && defaultHours <= 720) {
    list.push({ hours: defaultHours, label: `${plural(defaultHours, 'hour', 'hours')} (organization default)` });
    list.sort((a, b) => a.hours - b.hours);
  }
  return list;
}

// ------------------------------------------------------------------ reports

export const REPORT_REASON_LABEL: Record<string, string> = {
  spam: 'Spam',
  harassment: 'Harassment',
  inappropriate: 'Inappropriate',
  other: 'Other',
};

export const REPORT_ACTION_LABEL: Record<string, string> = {
  dismiss: 'dismissed it',
  remove_message: 'removed the message',
  suspend_user: 'suspended the person',
  remove_user: 'removed the person',
};

// "remove_message: duplicate post" -> "Removed the message: duplicate post"
export function resolutionText(resolution: string | null): string {
  if (!resolution) return '';
  const i = resolution.indexOf(':');
  const code = i >= 0 ? resolution.slice(0, i) : resolution;
  const note = i >= 0 ? resolution.slice(i + 1).trim() : '';
  const label = REPORT_ACTION_LABEL[code];
  const head = label ? label.charAt(0).toUpperCase() + label.slice(1) : resolution;
  return label && note ? `${head}: ${note}` : head;
}

// ------------------------------------------------------------------ audit

export interface AuditNames {
  user: (id: string | null | undefined) => string;
  server: (id: string | null | undefined) => string;
  channel: (id: string | null | undefined) => string;
}

type Details = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

function target(item: AuditItem, n: AuditNames): string {
  switch (item.target_type) {
    case 'user': return n.user(item.target_id);
    case 'server': return n.server(item.target_id);
    case 'channel': return n.channel(item.target_id);
    case 'invite': return 'an invite link';
    case 'report': return 'a report';
    case 'message': return 'a message';
    case 'org': return 'the organization';
    default: return item.target_type ? `a ${item.target_type}` : 'something';
  }
}

const SENTENCES: Record<string, (item: AuditItem, d: Details, n: AuditNames) => string> = {
  'org.created': () => 'created the organization',
  'org.updated': () => 'changed the organization settings',
  'org.role_changed': (i, d, n) => `changed the role of ${target(i, n)} from ${orgRoleName(d.from)} to ${orgRoleName(d.to)}`,
  'org.member_suspended': (i, _d, n) => `suspended ${target(i, n)}`,
  'org.member_unsuspended': (i, _d, n) => `restored access for ${target(i, n)}`,
  'org.member_removed': (i, _d, n) => `removed ${target(i, n)} from the organization`,
  'org.member_banned': (i, _d, n) => `removed and banned ${target(i, n)}`,
  'org.member_left': () => 'left the organization',
  'member.account_deleted': () => 'deleted their account',
  'server.created': (i, d, n) => `created the team server ${str(d.name) ?? target(i, n)}`,
  'server.updated': (i, _d, n) => `changed the settings of ${target(i, n)}`,
  'server.archived': (i, _d, n) => `archived ${target(i, n)}`,
  'server.unarchived': (i, _d, n) => `unarchived ${target(i, n)}`,
  'server.members_added': (i, d, n) => `added ${plural(count(d.user_ids), 'person', 'people')} to ${target(i, n)}`,
  'server.member_removed': (i, d, n) => `removed ${n.user(str(d.user_id))} from ${target(i, n)}`,
  'server.role_changed': (i, d, n) => `made ${target(i, n)} ${serverRoleName(d.to).toLowerCase()} in ${n.server(str(d.server_id))}`,
  'channel.created': (i, d, n) => `created the channel ${str(d.name) ? `#${str(d.name)}` : target(i, n)}`,
  'channel.updated': (i, _d, n) => `changed the settings of ${target(i, n)}`,
  'channel.archived': (i, _d, n) => `archived ${target(i, n)}`,
  'channel.unarchived': (i, _d, n) => `unarchived ${target(i, n)}`,
  'channel.members_added': (i, d, n) => `added ${plural(count(d.user_ids), 'person', 'people')} to ${target(i, n)}`,
  'channel.member_removed': (i, d, n) => `removed ${n.user(str(d.user_id))} from ${target(i, n)}`,
  'invite.created': (_i, d, n) => (str(d.server_id) ? `created an invite link to ${n.server(str(d.server_id))}` : 'created an invite link to the organization'),
  'invite.revoked': () => 'revoked an invite link',
  'invite.accepted': () => 'joined with an invite link',
  'invite.join_requested': () => 'asked to join with an invite link',
  'join_request.approved': (i, _d, n) => `approved the join request of ${target(i, n)}`,
  'join_request.rejected': (i, _d, n) => `turned down the join request of ${target(i, n)}`,
  'report.resolved': (_i, d) => `resolved a report and ${REPORT_ACTION_LABEL[str(d.action) ?? ''] ?? 'closed it'}`,
  'message.removed': (_i, d, n) => `removed a message by ${n.user(str(d.author_id))}`,
};

// What happened, as a sentence that follows the actor's name.
export function auditSentence(item: AuditItem, names: AuditNames): string {
  const d = (item.details ?? {}) as Details;
  const make = SENTENCES[item.action];
  if (make) return make(item, d, names);
  const [area, verb] = item.action.split('.');
  const words = (verb ?? item.action).replace(/_/g, ' ');
  return `${words}${area && verb ? ` (${area})` : ''}`;
}

// Extra lines worth showing under the sentence (a reason, a note, a removed text).
export function auditExtras(item: AuditItem): { label: string; value: string }[] {
  const d = (item.details ?? {}) as Details;
  const out: { label: string; value: string }[] = [];
  const reason = str(d.reason);
  if (reason) out.push({ label: 'Reason', value: reason });
  const note = str(d.note);
  if (note) out.push({ label: 'Note', value: note });
  if (item.action === 'message.removed') {
    const body = str(d.body);
    if (body) out.push({ label: 'Removed text', value: body });
  }
  if (item.action === 'invite.created') {
    const email = str(d.email);
    if (email) out.push({ label: 'For', value: email });
  }
  const patch = d.patch;
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    const p = patch as Record<string, unknown>;
    // org settings arrive nested: name them one by one
    const keys = Object.keys(p).flatMap((k) => (k === 'settings' && p.settings && typeof p.settings === 'object' ? Object.keys(p.settings as Record<string, unknown>) : [k]))
      .map((k) => FIELD_WORDS[k] ?? k.replace(/_/g, ' '));
    if (keys.length) out.push({ label: 'Changed', value: keys.join(', ') });
  }
  return out;
}

const FIELD_WORDS: Record<string, string> = {
  allow_guests: 'guests',
  member_can_create_channels: 'who creates channels',
  member_can_invite: 'who invites',
  edit_window_minutes: 'editing window',
  default_invite_hours: 'invite expiry',
  posting_policy: 'who can post',
  allow_replies: 'replies',
  allow_reactions: 'reactions',
  auto_join: 'automatic joining',
  join_policy: 'who can join',
  icon_emoji: 'icon',
  brand_color: 'brand color',
  short_name: 'short name',
  logo_path: 'logo',
};

// Mentions in a message body as names: <@uuid> -> @Name, <!channel> -> @channel.
export function readableBody(body: string, nameOf: (id: string) => string): string {
  return body
    .replace(/<@([0-9a-f-]{36})>/gi, (_m, id: string) => `@${nameOf(id)}`)
    .replace(/<!(channel|here)>/g, '@$1')
    .replace(/<#([0-9a-f-]{36})>/gi, '#channel');
}

// ------------------------------------------------------------------ organization settings

export const EDIT_WINDOW_CHOICES: readonly { minutes: number | null; label: string }[] = [
  { minutes: null, label: 'Any time' },
  { minutes: 15, label: 'Within 15 minutes' },
  { minutes: 60, label: 'Within 1 hour' },
  { minutes: 1440, label: 'Within 1 day' },
  { minutes: 10080, label: 'Within 7 days' },
  { minutes: 0, label: 'Not at all' },
];

export function editWindowChoices(current: number | null): { minutes: number | null; label: string }[] {
  const list = [...EDIT_WINDOW_CHOICES];
  if (!list.some((c) => c.minutes === current) && current !== null && current > 0 && current <= 43200) {
    list.splice(list.length - 1, 0, { minutes: current, label: `Within ${plural(current, 'minute', 'minutes')}` });
  }
  return list;
}

// Select values are strings: "any" for no limit, minutes otherwise.
export function editWindowValue(m: number | null): string {
  return m === null ? 'any' : String(m);
}

export function editWindowFromValue(v: string): number | null {
  return v === 'any' ? null : Number(v);
}
