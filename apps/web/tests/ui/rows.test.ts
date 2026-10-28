import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/api/types';
import type { PendingMessage } from '../../src/store';
import { buildRows, firstUnreadIndex, GROUP_WINDOW_MS, messageKey, rowIndexOfMessage, type Row } from '../../src/features/conversation/rows';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const NOW = new Date(2026, 9, 3, 18, 0, 0);

// Local wall-clock times so day separators do not depend on the test machine's zone.
function at(day: number, hour: number, minute = 0, second = 0): string {
  return new Date(2026, 9, day, hour, minute, second).toISOString();
}

let seq = 0;
function msg(author: string | null, created: string, extra: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    org_id: 'o', channel_id: 'c', seq, thread_root_id: null, author_id: author, kind: 'user',
    body: `message ${seq}`, mentions: [], mention_all: false, client_id: null,
    created_at: created, edited_at: null, deleted_at: null, updated_at: created,
    reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments: [],
    pinned: false, also_in_channel: false, meta: {}, ...extra,
  };
}

function pending(clientId: string, createdAt: number): PendingMessage {
  return {
    clientId, orgId: 'o', channelId: 'c', threadRootId: null, body: 'hi', attachmentIds: [], alsoInChannel: false,
    status: 'pending', attempts: 0, createdAt, nextAttemptAt: null, error: null, statusVisible: false,
  };
}

const kinds = (rows: Row[]) => rows.map((r) => (r.kind === 'msg' || r.kind === 'pending' ? `${r.kind}${r.grouped ? '+' : ''}` : r.kind));

describe('author grouping', () => {
  it('groups consecutive messages by the same author inside five minutes', () => {
    const ms = [msg(ALICE, at(3, 10, 0)), msg(ALICE, at(3, 10, 2)), msg(ALICE, at(3, 10, 4, 59))];
    const rows = buildRows({ messages: ms, pending: [], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW });
    expect(kinds(rows)).toEqual(['day', 'msg', 'msg+', 'msg+']);
  });

  it('starts a new group at exactly five minutes, on a new author, and after a system message', () => {
    const a = msg(ALICE, at(3, 10, 0));
    const b = msg(ALICE, new Date(Date.parse(a.created_at) + GROUP_WINDOW_MS).toISOString());
    const c = msg(BOB, at(3, 10, 6));
    const d = msg(null, at(3, 10, 7), { kind: 'system' });
    const e = msg(BOB, at(3, 10, 8));
    const rows = buildRows({ messages: [a, b, c, d, e], pending: [], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW });
    expect(kinds(rows)).toEqual(['day', 'msg', 'msg', 'msg', 'msg', 'msg']);
  });

  it('never groups across a day separator', () => {
    const rows = buildRows({
      messages: [msg(ALICE, at(2, 23, 58)), msg(ALICE, at(3, 0, 1))],
      pending: [], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW,
    });
    expect(kinds(rows)).toEqual(['day', 'msg', 'day', 'msg']);
  });

  it('groups my pending sends with my last accepted message', () => {
    const mine = msg(ME, at(3, 17, 58));
    const rows = buildRows({
      messages: [mine], pending: [pending('p1', Date.parse(at(3, 17, 59)))], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW,
    });
    expect(kinds(rows)).toEqual(['day', 'msg', 'pending+']);
  });
});

describe('day separators', () => {
  it('labels today, yesterday and older days', () => {
    const rows = buildRows({
      messages: [msg(ALICE, at(1, 9)), msg(BOB, at(2, 9)), msg(ALICE, at(3, 9))],
      pending: [], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW,
    });
    const days = rows.filter((r) => r.kind === 'day').map((r) => (r.kind === 'day' ? r.label : ''));
    expect(days).toHaveLength(3);
    expect(days[1]).toBe('Yesterday');
    expect(days[2]).toBe('Today');
    expect(days[0]).toMatch(/1/);
  });

  it('adds a separator for a pending send on a new day', () => {
    const rows = buildRows({
      messages: [msg(ALICE, at(2, 9))], pending: [pending('p1', Date.parse(at(3, 9)))], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW,
    });
    expect(kinds(rows)).toEqual(['day', 'msg', 'day', 'pending']);
  });
});

describe('the New divider', () => {
  it('sits before the first unread message from someone else', () => {
    const ms = [msg(ALICE, at(3, 9)), msg(ME, at(3, 9, 1)), msg(BOB, at(3, 9, 2)), msg(ALICE, at(3, 9, 3))];
    // Read up to the first message; my own message after it does not count as unread.
    const rows = buildRows({ messages: ms, pending: [], meId: ME, newAfterSeq: ms[0]!.seq, hasMoreBefore: false, now: NOW });
    expect(kinds(rows)).toEqual(['day', 'msg', 'msg', 'new', 'msg', 'msg']);
    const newAt = rows.findIndex((r) => r.kind === 'new');
    const after = rows[newAt + 1];
    expect(after && after.kind === 'msg' ? after.id : null).toBe(ms[2]!.id);
  });

  it('breaks author grouping', () => {
    const ms = [msg(ALICE, at(3, 9)), msg(ALICE, at(3, 9, 1))];
    const rows = buildRows({ messages: ms, pending: [], meId: ME, newAfterSeq: ms[0]!.seq, hasMoreBefore: false, now: NOW });
    expect(kinds(rows)).toEqual(['day', 'msg', 'new', 'msg']);
  });

  it('is absent when everything is read, when the divider is off, or when its place is above the loaded window', () => {
    const ms = [msg(ALICE, at(3, 9)), msg(BOB, at(3, 9, 1))];
    expect(kinds(buildRows({ messages: ms, pending: [], meId: ME, newAfterSeq: ms[1]!.seq, hasMoreBefore: false, now: NOW }))).not.toContain('new');
    expect(kinds(buildRows({ messages: ms, pending: [], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW }))).not.toContain('new');
    expect(kinds(buildRows({ messages: ms, pending: [], meId: ME, newAfterSeq: 0, hasMoreBefore: true, now: NOW }))).not.toContain('new');
    expect(kinds(buildRows({ messages: ms, pending: [], meId: ME, newAfterSeq: 0, hasMoreBefore: false, now: NOW }))).toContain('new');
  });

  it('skips deleted messages when finding the first unread', () => {
    const ms = [msg(ALICE, at(3, 9)), msg(BOB, at(3, 9, 1), { deleted_at: at(3, 9, 2) }), msg(BOB, at(3, 9, 3))];
    expect(firstUnreadIndex(ms, ms[0]!.seq, ME)).toBe(2);
  });
});

describe('tombstones and keys', () => {
  it('hides deleted messages unless they are thread roots with replies', () => {
    const gone = msg(ALICE, at(3, 9), { deleted_at: at(3, 9, 5) });
    const root = msg(BOB, at(3, 9, 1), { deleted_at: at(3, 9, 5), reply_count: 2 });
    const live = msg(ALICE, at(3, 9, 2));
    const rows = buildRows({ messages: [gone, root, live], pending: [], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW });
    expect(rows.filter((r) => r.kind === 'msg').map((r) => (r.kind === 'msg' ? r.id : ''))).toEqual([root.id, live.id]);
    // A tombstone never groups with the next message.
    expect(kinds(rows)).toEqual(['day', 'msg', 'msg']);
  });

  it('keys accepted messages by client id so the pending row keeps its identity', () => {
    const accepted = msg(ME, at(3, 9), { client_id: 'abc' });
    expect(messageKey(accepted)).toBe('c:abc');
    const rows = buildRows({ messages: [accepted], pending: [pending('abc', Date.parse(at(3, 9)))], meId: ME, newAfterSeq: null, hasMoreBefore: false, now: NOW });
    // The pending copy of an accepted message is not shown twice.
    expect(kinds(rows)).toEqual(['day', 'msg']);
    expect(rowIndexOfMessage(rows, accepted.id)).toBe(1);
  });
});
