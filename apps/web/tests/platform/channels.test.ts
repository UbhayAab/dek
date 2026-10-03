// Channel history races: a message that lands while the newest page is loading is
// not lost under the page (and the cursor heals); re-opening a channel turns off
// the spinner of a load it superseded; a heal makes a cached or failed timeline good.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/api/rpc', () => ({
  api: {
    listMessages: vi.fn(),
    listMessagesAround: vi.fn(),
    getMessageContext: vi.fn(),
    syncChannel: vi.fn(),
    getProfiles: vi.fn(async () => []),
  },
}));

import { api } from '../../src/api/rpc';
import type { Channel, Message, MessagePage, SyncResult } from '../../src/api/types';
import { closeChannel, healChannel, loadOlder, openChannel, resetChannels } from '../../src/sync/channels';
import { applyNewMessage, emptyTimeline } from '../../src/sync/reducers';
import { clearOpen } from '../../src/sync/runtime';
import { getState, resetState, setState } from '../../src/store/state';

const T0 = Date.parse('2026-10-03T12:00:00Z');
function m(seq: number, extra: Partial<Message> = {}): Message {
  const at = new Date(T0 + seq * 1000).toISOString();
  return {
    id: `m${seq}`, org_id: 'o1', channel_id: 'c1', seq, thread_root_id: null, author_id: 'bob', kind: 'user', body: `b${seq}`,
    mentions: [], mention_all: false, client_id: null, created_at: at, edited_at: null, deleted_at: null, updated_at: at,
    reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments: [], pinned: false, also_in_channel: false,
    meta: {}, ...extra,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const listMessages = api.listMessages as unknown as ReturnType<typeof vi.fn>;
const syncChannel = api.syncChannel as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  resetChannels();
  clearOpen();
  listMessages.mockReset();
  syncChannel.mockReset();
  setState({
    session: { status: 'signed_in', userId: 'me', email: null, setup: null },
    orgId: 'o1',
    channels: { c1: { id: 'c1', org_id: 'o1', last_seq: 10, last_read_seq: 10, unread: 0, mentions: 0 } as Channel },
  });
});

afterEach(() => {
  closeChannel('c1');
  vi.useRealTimers();
});

describe('opening a channel', () => {
  it('keeps a message that lands while the page loads, then heals the cursor past it', async () => {
    const page = deferred<MessagePage>();
    listMessages.mockReturnValueOnce(page.promise);
    syncChannel.mockResolvedValueOnce({ new: [m(11)], changed: [], last_seq: 11, truncated: false } satisfies SyncResult);
    const opening = openChannel('c1');
    await vi.advanceTimersByTimeAsync(0);
    // msg.new for seq 11 arrives before the page (which was read at seq 10)
    setState(applyNewMessage(getState(), m(11), { me: 'me', onScreen: () => true }).patch);
    page.resolve({ messages: [m(8), m(9), m(10)], has_more: true, last_seq: 10 });
    await opening;
    expect(getState().timelines.c1!.ids).toEqual(['m8', 'm9', 'm10', 'm11']);
    expect(getState().timelines.c1!.lastSeq).toBe(10);           // not past a message it has not confirmed
    await vi.advanceTimersByTimeAsync(1_600);                     // the gap heal
    expect(syncChannel).toHaveBeenCalledTimes(1);
    expect(syncChannel.mock.calls[0]![1]).toBe(10);
    expect(getState().timelines.c1!.lastSeq).toBe(11);
    expect(getState().timelines.c1!.ids).toEqual(['m8', 'm9', 'm10', 'm11']);
  });

  it('re-opening turns off the spinner of an older-page load it superseded', async () => {
    listMessages.mockResolvedValueOnce({ messages: [m(9), m(10)], has_more: true, last_seq: 10 });
    await openChannel('c1');
    const older = deferred<MessagePage>();
    listMessages.mockReturnValueOnce(older.promise);
    const loading = loadOlder('c1');
    await vi.advanceTimersByTimeAsync(0);
    expect(getState().timelines.c1!.olderStatus).toBe('loading');
    syncChannel.mockResolvedValue({ new: [], changed: [], last_seq: 10, truncated: false });
    await openChannel('c1');                                        // switch away and back
    expect(getState().timelines.c1!.olderStatus).toBe('idle');
    older.resolve({ messages: [m(7), m(8)], has_more: false, last_seq: 10 });
    await loading;
    expect(getState().timelines.c1!.olderStatus).toBe('idle');
    closeChannel('c1');
  });

  it('a heal makes a timeline painted from the cache, or failed, good again', async () => {
    setState({
      messages: { m9: m(9), m10: m(10) },
      timelines: { c1: emptyTimeline({ ids: ['m9', 'm10'], status: 'error', error: 'offline', lastSeq: 10, fromCache: true }) },
    });
    syncChannel.mockResolvedValueOnce({ new: [m(11)], changed: [], last_seq: 11, truncated: false });
    await healChannel('c1');
    expect(getState().timelines.c1).toMatchObject({ status: 'ready', error: null, fromCache: false, lastSeq: 11 });
    expect(getState().timelines.c1!.ids).toEqual(['m9', 'm10', 'm11']);
  });
});
