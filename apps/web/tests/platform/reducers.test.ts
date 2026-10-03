// Event reducers: merge, pending reconciliation, timeline order, cursor holes,
// counters for channels not on screen, thread counters, read monotonicity,
// revocation purge, typing.
import { describe, expect, it } from 'vitest';
import type { Channel, Message } from '../../src/api/types';
import { initialState, type DekState, type PendingMessage } from '../../src/store/state';
import {
  applyChannelUpdate, applyNewMessage, applyRead, applyTyping, applyUpdatedMessage, emptyTimeline, expireTyping,
  insertBySeq, purgeChannels, type EventCtx,
} from '../../src/sync/reducers';

const ME = 'me-0000';
const T0 = '2026-10-03T12:00:00.000Z';

function m(id: string, seq: number, extra: Partial<Message> = {}): Message {
  return {
    id, org_id: 'o1', channel_id: 'c1', seq, thread_root_id: null, author_id: 'bob', kind: 'user', body: id, mentions: [],
    mention_all: false, client_id: null, created_at: new Date(Date.parse(T0) + seq * 1000).toISOString(), edited_at: null,
    deleted_at: null, updated_at: new Date(Date.parse(T0) + seq * 1000).toISOString(), reply_count: 0, last_reply_at: null,
    reply_user_ids: [], reactions: {}, attachments: [], pinned: false, also_in_channel: false, meta: {}, ...extra,
  };
}

function ch(id: string, extra: Partial<Channel> = {}): Channel {
  return {
    id, org_id: 'o1', server_id: 's1', kind: 'text', name: id, topic: null, description: null, visibility: 'public',
    posting_policy: 'everyone', allow_replies: true, allow_reactions: true, auto_join: false, archived: false, position: 0,
    category: null, created_by: null, created_at: T0, member: true, my_role: 'member', notify: 'default', muted_until: null,
    last_seq: 10, last_read_seq: 10, unread: 0, mentions: 0, last_message_at: T0, member_count: 4, dm_user_ids: null, ...extra,
  };
}

function pending(clientId: string, channelId = 'c1'): PendingMessage {
  return {
    clientId, orgId: 'o1', channelId, threadRootId: null, body: 'x', attachmentIds: [], alsoInChannel: false, status: 'pending',
    attempts: 1, createdAt: 1, nextAttemptAt: null, error: null, statusVisible: false,
  };
}

function world(): DekState {
  const s = initialState();
  const msgs = [m('a', 8), m('b', 9), m('c', 10)];
  s.session = { status: 'signed_in', userId: ME, email: null, setup: null };
  s.orgId = 'o1';
  s.channels = { c1: ch('c1'), c2: ch('c2', { last_seq: 3, last_read_seq: 3 }) };
  s.messages = Object.fromEntries(msgs.map((x) => [x.id, x]));
  s.timelines = { c1: emptyTimeline({ ids: msgs.map((x) => x.id), status: 'ready', lastSeq: 10 }) };
  return s;
}

const offScreen: EventCtx = { me: ME, onScreen: () => false };
const onScreen: EventCtx = { me: ME, onScreen: (id) => id === 'c1' };

function apply(s: DekState, msg: Message, ctx = offScreen): DekState {
  return { ...s, ...applyNewMessage(s, msg, ctx).patch };
}

describe('timeline order', () => {
  it('inserts by seq, in the middle when late, never twice', () => {
    const s = world();
    const late = m('late', 9.5 as unknown as number);
    s.messages.late = late;
    const ids = insertBySeq(s.timelines.c1!.ids, s.messages, late);
    expect(ids).toEqual(['a', 'b', 'late', 'c']);
    expect(insertBySeq(ids, s.messages, late)).toBe(ids);
  });

  it('appends a live message and advances the cursor by one', () => {
    const s = apply(world(), m('d', 11));
    expect(s.timelines.c1!.ids).toEqual(['a', 'b', 'c', 'd']);
    expect(s.timelines.c1!.lastSeq).toBe(11);
  });

  it('reports a hole and does not move the cursor past it', () => {
    const r = applyNewMessage(world(), m('f', 13), offScreen);
    expect(r.gap).toBe(true);
    const s = { ...world(), ...r.patch };
    expect(s.timelines.c1!.ids).toContain('f');
    expect(s.timelines.c1!.lastSeq).toBe(10);
  });

  it('a thread reply advances the cursor but stays out of the channel view', () => {
    const s = apply(world(), m('r1', 11, { thread_root_id: 'a' }));
    expect(s.timelines.c1!.ids).toEqual(['a', 'b', 'c']);
    expect(s.timelines.c1!.lastSeq).toBe(11);
  });

  it('does not insert into a window opened around an old message', () => {
    const s0 = world();
    s0.timelines.c1 = { ...s0.timelines.c1!, hasMoreAfter: true };
    const s = apply(s0, m('d', 11));
    expect(s.timelines.c1!.ids).toEqual(['a', 'b', 'c']);
    expect(s.messages.d).toBeDefined();
  });
});

describe('merge and pending reconciliation', () => {
  it('drops my pending copy when my message arrives with its client id', () => {
    const s0 = world();
    s0.pending = { 'cid-1': pending('cid-1'), 'cid-2': pending('cid-2') };
    const s = apply(s0, m('mine', 11, { author_id: ME, client_id: 'cid-1' }));
    expect(Object.keys(s.pending)).toEqual(['cid-2']);
  });

  it('never drops a pending copy because of someone else\'s message', () => {
    const s0 = world();
    s0.pending = { 'cid-1': pending('cid-1') };
    const s = apply(s0, m('theirs', 11, { author_id: 'bob', client_id: 'cid-1' }));
    expect(Object.keys(s.pending)).toEqual(['cid-1']);
  });

  it('a newer copy is never replaced by an older one', () => {
    const s0 = world();
    const edited = { ...s0.messages.c!, body: 'edited', updated_at: '2026-10-03T13:00:00.000Z' };
    s0.messages.c = edited;
    const s = apply(s0, m('c', 10));
    expect(s.messages.c!.body).toBe('edited');
  });

  it('msg.upd: newer wins, older is ignored, unknown is ignored', () => {
    const s0 = world();
    const newer = { ...s0.messages.b!, body: 'v2', updated_at: '2026-10-03T13:00:00.000Z' };
    const s1 = { ...s0, ...applyUpdatedMessage(s0, newer)! };
    expect(s1.messages.b!.body).toBe('v2');
    expect(applyUpdatedMessage(s1, { ...newer, body: 'v1', updated_at: T0 })).toBeNull();
    expect(applyUpdatedMessage(s1, m('zzz', 99))).toBeNull();
  });
});

describe('counters', () => {
  it('raises unread and mentions for a channel not on screen', () => {
    const s = apply(world(), m('d', 11, { mentions: [ME] }));
    expect(s.channels.c1!.unread).toBe(1);
    expect(s.channels.c1!.mentions).toBe(1);
    expect(s.channels.c1!.last_seq).toBe(11);
  });

  it('leaves counters alone for the channel on screen', () => {
    const s = apply(world(), m('d', 11, { mentions: [ME] }), onScreen);
    expect(s.channels.c1!.unread).toBe(0);
    expect(s.channels.c1!.mentions).toBe(0);
    expect(s.channels.c1!.last_seq).toBe(11);
  });

  it('never counts my own messages, deleted messages or a duplicate', () => {
    let s = apply(world(), m('mine', 11, { author_id: ME }));
    expect(s.channels.c1!.unread).toBe(0);
    s = apply(s, m('gone', 12, { deleted_at: T0 }));
    expect(s.channels.c1!.unread).toBe(0);
    s = apply(s, m('d', 13));
    s = apply(s, m('d', 13));
    expect(s.channels.c1!.unread).toBe(1);
  });

  it('counts @channel as a mention, a reply as a mention but not as unread', () => {
    let s = apply(world(), m('all', 11, { mention_all: true }));
    expect(s.channels.c1!.mentions).toBe(1);
    s = apply(s, m('reply', 12, { thread_root_id: 'a', mentions: [ME] }));
    expect(s.channels.c1!.unread).toBe(1);
    expect(s.channels.c1!.mentions).toBe(2);
  });

  it('caps counters at 100 like the server', () => {
    const s0 = world();
    s0.channels.c1 = { ...s0.channels.c1!, unread: 100 };
    expect(apply(s0, m('d', 11)).channels.c1!.unread).toBe(100);
  });

  it('bumps the thread root once, even if the root update arrived first', () => {
    const s1 = apply(world(), m('r1', 11, { thread_root_id: 'a', author_id: 'carol' }));
    expect(s1.messages.a!.reply_count).toBe(1);
    expect(s1.messages.a!.reply_user_ids).toEqual(['carol']);
    // the root's own msg.upd already counted r2:
    const r2 = m('r2', 12, { thread_root_id: 'a' });
    const s2 = { ...s1, messages: { ...s1.messages, a: { ...s1.messages.a!, reply_count: 2, last_reply_at: r2.created_at } } };
    expect(apply(s2, r2).messages.a!.reply_count).toBe(2);
  });

  it('clears the author\'s typing entry when their message lands', () => {
    const s0 = world();
    s0.typing = { c1: [{ userId: 'bob', threadRootId: null, until: 1e15 }, { userId: 'carol', threadRootId: null, until: 1e15 }] };
    expect(apply(s0, m('d', 11)).typing.c1!.map((t) => t.userId)).toEqual(['carol']);
  });
});

describe('read state', () => {
  it('reading to the end clears unread and mentions', () => {
    const s0 = world();
    s0.channels.c1 = { ...s0.channels.c1!, last_seq: 12, last_read_seq: 10, unread: 2, mentions: 1 };
    const r = applyRead(s0, 'c1', 12, 0, ME);
    expect(r.patch!.channels!.c1).toMatchObject({ last_read_seq: 12, unread: 0, mentions: 0 });
  });

  it('an older server value never undoes a local read the server has not confirmed', () => {
    const s0 = world();
    s0.channels.c1 = { ...s0.channels.c1!, last_seq: 12, last_read_seq: 12, unread: 0 };
    const r = applyRead(s0, 'c1', 9, 12, ME);
    expect(r.patch).toBeNull();
  });

  it('a deliberate move back (mark unread elsewhere) recounts from the loaded page', () => {
    const s0 = world();
    s0.channels.c1 = { ...s0.channels.c1!, last_seq: 10, last_read_seq: 10, unread: 0 };
    const r = applyRead(s0, 'c1', 8, 0, ME);
    expect(r.patch!.channels!.c1).toMatchObject({ last_read_seq: 8, unread: 2 });
    expect(r.needsRefresh).toBe(false);
  });

  it('asks for a refresh when the loaded page cannot know the count', () => {
    const s0 = world();
    s0.channels.c1 = { ...s0.channels.c1!, last_seq: 10, last_read_seq: 10 };
    const r = applyRead(s0, 'c1', 2, 0, ME);
    expect(r.needsRefresh).toBe(true);
  });
});

describe('revocation and channel updates', () => {
  it('purges everything a removed channel put in memory', () => {
    const s0 = world();
    s0.pending = { p1: pending('p1', 'c1'), p2: pending('p2', 'c2') };
    s0.drafts = { c1: 'draft', 'c1:root': 'reply draft', c2: 'keep' };
    s0.typing = { c1: [{ userId: 'bob', threadRootId: null, until: 1 }] };
    s0.threads = { a: { rootId: 'a', channelId: 'c1', replyIds: [], status: 'ready', error: null, hasMore: false, following: false, lastReadReplySeq: 0 } };
    s0.scroll = { c1: { anchorId: null, offset: 0, atBottom: true } };
    const s = { ...s0, ...purgeChannels(s0, new Set(['c1'])) };
    expect(Object.keys(s.channels)).toEqual(['c2']);
    expect(s.timelines.c1).toBeUndefined();
    expect(Object.values(s.messages).filter((x) => x.channel_id === 'c1')).toHaveLength(0);
    expect(Object.keys(s.pending)).toEqual(['p2']);
    expect(s.drafts).toEqual({ c2: 'keep' });
    expect(s.typing.c1).toBeUndefined();
    expect(s.threads.a).toBeUndefined();
    expect(s.scroll.c1).toBeUndefined();
  });

  it('chan.upd keeps my per-user fields', () => {
    const s0 = world();
    s0.channels.c1 = { ...s0.channels.c1!, unread: 3, notify: 'all' };
    const { member: _m, unread: _u, notify: _n, ...base } = { ...s0.channels.c1!, name: 'renamed', archived: true };
    const s = { ...s0, ...applyChannelUpdate(s0, base as never)! };
    expect(s.channels.c1).toMatchObject({ name: 'renamed', archived: true, unread: 3, notify: 'all', member: true });
  });
});

describe('typing', () => {
  it('ignores my own signal, replaces a repeat, expires after its time', () => {
    const s0 = world();
    expect(applyTyping(s0, 'c1', ME, null, ME, 100)).toBeNull();
    let s = { ...s0, ...applyTyping(s0, 'c1', 'bob', null, ME, 100)! };
    s = { ...s, ...applyTyping(s, 'c1', 'bob', null, ME, 200)! };
    expect(s.typing.c1).toEqual([{ userId: 'bob', threadRootId: null, until: 200 }]);
    expect(expireTyping(s, 150)).toBeNull();
    expect(expireTyping(s, 250)).toEqual({ typing: {} });
  });
});
