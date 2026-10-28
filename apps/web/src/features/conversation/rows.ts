// Turns a timeline (server messages ascending by seq, plus local pending sends) into
// the rows the virtual list renders: day separators, the "New" divider, author
// grouping, tombstones. Pure, so the rules are unit tested.
import type { Message } from '../../api/types';
import type { PendingMessage } from '../../store';
import { dayKey, dayLabel } from './time';

export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'new'; key: string }
  | { kind: 'msg'; key: string; id: string; grouped: boolean }
  | { kind: 'pending'; key: string; clientId: string; grouped: boolean };

export interface RowInput {
  messages: Message[];
  pending: PendingMessage[];
  meId: string | null;
  // The reader's last_read_seq when the conversation was opened; null hides the divider.
  newAfterSeq: number | null;
  // True when older messages exist above the loaded window.
  hasMoreBefore: boolean;
  now?: Date;
}

// Deleted messages disappear, except a deleted thread root that still has replies:
// it stays as a tombstone so the thread remains reachable.
export function isVisible(m: Message): boolean {
  return !m.deleted_at || m.reply_count > 0;
}

export function messageKey(m: Pick<Message, 'id' | 'client_id'>): string {
  // The client id keeps a row's key stable when a pending send becomes the
  // accepted server message, so the row is not re-mounted and re-measured.
  return m.client_id ? `c:${m.client_id}` : `m:${m.id}`;
}

export function pendingKey(p: Pick<PendingMessage, 'clientId'>): string {
  return `c:${p.clientId}`;
}

interface Groupable {
  author: string | null;
  at: number;
  plain: boolean; // an ordinary, visible user message (system rows and tombstones never group)
}

function canGroup(prev: Groupable | null, cur: Groupable): boolean {
  if (!prev || !prev.plain || !cur.plain) return false;
  if (!prev.author || prev.author !== cur.author) return false;
  return cur.at - prev.at >= 0 && cur.at - prev.at < GROUP_WINDOW_MS;
}

// The first message that counts as unread: after last_read_seq, not mine, not deleted.
// Matches the server's Channel.unread definition.
export function firstUnreadIndex(messages: Message[], newAfterSeq: number | null, meId: string | null): number {
  if (newAfterSeq === null) return -1;
  return messages.findIndex((m) => m.seq > newAfterSeq && !m.deleted_at && m.author_id !== meId && m.kind === 'user');
}

export function buildRows(input: RowInput): Row[] {
  const { pending, meId, newAfterSeq, hasMoreBefore } = input;
  const now = input.now ?? new Date();
  const messages = input.messages.filter(isVisible);
  const rows: Row[] = [];

  // The divider shows only when its true position is inside the loaded window:
  // either a read message precedes it here, or nothing older exists.
  let unreadAt = firstUnreadIndex(messages, newAfterSeq, meId);
  if (unreadAt === 0 && hasMoreBefore) unreadAt = -1;

  let lastDay: string | null = null;
  let prev: Groupable | null = null;

  messages.forEach((m, i) => {
    const day = dayKey(m.created_at);
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day:${day}`, label: dayLabel(m.created_at, now) });
      lastDay = day;
      prev = null;
    }
    if (i === unreadAt) {
      rows.push({ kind: 'new', key: 'new' });
      prev = null;
    }
    const cur: Groupable = {
      author: m.author_id,
      at: Date.parse(m.created_at),
      plain: m.kind === 'user' && !m.deleted_at,
    };
    rows.push({ kind: 'msg', key: messageKey(m), id: m.id, grouped: canGroup(prev, cur) });
    prev = cur;
  });

  // Pending sends are newer than anything the server has accepted.
  const seen = new Set(messages.map((m) => m.client_id).filter(Boolean));
  for (const p of [...pending].sort((a, b) => a.createdAt - b.createdAt)) {
    if (seen.has(p.clientId)) continue;
    const day = dayKey(p.createdAt);
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day:${day}`, label: dayLabel(p.createdAt, now) });
      lastDay = day;
      prev = null;
    }
    const cur: Groupable = { author: meId, at: p.createdAt, plain: true };
    rows.push({ kind: 'pending', key: pendingKey(p), clientId: p.clientId, grouped: canGroup(prev, cur) });
    prev = cur;
  }
  return rows;
}

// Index of the row that shows a message id (for deep links and highlights).
export function rowIndexOfMessage(rows: Row[], id: string): number {
  return rows.findIndex((r) => r.kind === 'msg' && r.id === id);
}
