// Saved ids (isSaved, useIsSaved, setSaved, saved.upd, list_saved_ids), the
// membership store actions (setChannelNotify, joinChannel, leaveChannel, openDm),
// and the call ordering rule (a late copy never brings an ended call back).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/api/rpc', () => ({
  api: {
    saveMessage: vi.fn(),
    listSavedIds: vi.fn(),
    setChannelNotify: vi.fn(),
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    openDm: vi.fn(),
    getProfiles: vi.fn(async () => []),
  },
}));

import { api } from '../../src/api/rpc';
import { DekError } from '../../src/api/errors';
import type { Call, Channel } from '../../src/api/types';
import { joinChannel, leaveChannel, openDm, setChannelNotify } from '../../src/sync/membership';
import { applyCall, isOlderCall } from '../../src/sync/reducers';
import { applySavedEvent, isSaved, loadSavedIds, resetSaved, setSaved } from '../../src/sync/saved';
import { getState, resetState, setState } from '../../src/store/state';

const mock = <T extends keyof typeof api>(k: T) => api[k] as unknown as ReturnType<typeof vi.fn>;

function ch(id: string, extra: Partial<Channel> = {}): Channel {
  return {
    id, org_id: 'o1', server_id: 's1', kind: 'text', name: id, topic: null, description: null, visibility: 'public',
    posting_policy: 'everyone', allow_replies: true, allow_reactions: true, auto_join: false, archived: false, position: 0,
    category: null, created_by: null, created_at: '2026-10-03T00:00:00Z', member: true, my_role: 'member', notify: 'default',
    muted_until: null, last_seq: 1, last_read_seq: 1, unread: 0, mentions: 0, last_message_at: null, member_count: 2, dm_user_ids: null, ...extra,
  };
}

beforeEach(() => {
  resetState();
  resetSaved();
  for (const k of Object.keys(api) as (keyof typeof api)[]) mock(k).mockReset();
  setState({ session: { status: 'signed_in', userId: 'me', email: null, setup: null }, orgId: 'o1', channels: { c1: ch('c1') } });
});

afterEach(() => vi.useRealTimers());

describe('saved ids', () => {
  it('setSaved is optimistic and keeps the server answer', async () => {
    let answer!: (v: { message_id: string; saved: boolean }) => void;
    mock('saveMessage').mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const p = setSaved('m1', true);
    expect(isSaved('m1')).toBe(true);
    answer({ message_id: 'm1', saved: true });
    await p;
    expect(isSaved('m1')).toBe(true);
    expect(mock('saveMessage')).toHaveBeenCalledWith('m1', true);
  });

  it('rolls back when the server refuses, and rethrows', async () => {
    setState({ saved: { m1: true } });
    mock('saveMessage').mockRejectedValueOnce(new DekError('not_found'));
    await expect(setSaved('m1', false)).rejects.toBeInstanceOf(DekError);
    expect(isSaved('m1')).toBe(true);
  });

  it('a double tap ends where the last tap said, whatever answers first', async () => {
    const answers: ((v: { message_id: string; saved: boolean }) => void)[] = [];
    mock('saveMessage').mockImplementation(() => new Promise((r) => { answers.push(r); }));
    const a = setSaved('m1', true);
    const b = setSaved('m1', false);
    answers[1]!({ message_id: 'm1', saved: false });
    answers[0]!({ message_id: 'm1', saved: true });
    await Promise.all([a, b]);
    expect(isSaved('m1')).toBe(false);
  });

  it('saved.upd from another device applies; another organization or my own tap in flight does not', async () => {
    applySavedEvent({ org_id: 'o1', message_id: 'm2', saved: true });
    expect(isSaved('m2')).toBe(true);
    applySavedEvent({ org_id: 'o2', message_id: 'm3', saved: true });
    expect(isSaved('m3')).toBe(false);
    mock('saveMessage').mockReturnValueOnce(new Promise(() => undefined));
    void setSaved('m4', true);
    applySavedEvent({ org_id: 'o1', message_id: 'm4', saved: false });
    expect(isSaved('m4')).toBe(true);
  });

  it('loads the ids for the organization, keeping a tap made while they load', async () => {
    let list!: (ids: string[]) => void;
    mock('listSavedIds').mockReturnValueOnce(new Promise((r) => { list = r; }));
    const loading = loadSavedIds('o1');
    mock('saveMessage').mockReturnValueOnce(new Promise(() => undefined));
    void setSaved('tapped', true);
    list(['a', 'b']);
    await loading;
    expect(Object.keys(getState().saved).sort()).toEqual(['a', 'b', 'tapped']);
  });

  it('ignores a list that answers after a switch to another organization', async () => {
    let list!: (ids: string[]) => void;
    mock('listSavedIds').mockReturnValueOnce(new Promise((r) => { list = r; }));
    const loading = loadSavedIds('o1');
    setState({ orgId: 'o2' });
    list(['from-o1']);
    await loading;
    expect(getState().saved).toEqual({});
  });
});

describe('membership actions update the store from the reply', () => {
  it('setChannelNotify', async () => {
    mock('setChannelNotify').mockResolvedValueOnce({ channel_id: 'c1', notify: 'none', muted_until: '2026-12-01T00:00:00Z' });
    await setChannelNotify('c1', 'none', '2026-12-01T00:00:00Z');
    expect(getState().channels.c1).toMatchObject({ notify: 'none', muted_until: '2026-12-01T00:00:00Z' });
  });

  it('joinChannel and leaveChannel', async () => {
    mock('joinChannel').mockResolvedValueOnce(ch('c2', { unread: 3 }));
    await joinChannel('c2');
    expect(getState().channels.c2).toMatchObject({ member: true, unread: 3 });
    mock('leaveChannel').mockResolvedValueOnce(null);
    await leaveChannel('c2');
    expect(getState().channels.c2).toBeUndefined();
  });

  it('openDm returns the channel id and shows it, unhidden', async () => {
    mock('openDm').mockResolvedValueOnce(ch('d1', { kind: 'dm', server_id: null, visibility: 'private', dm_user_ids: ['bob'], hidden: true }));
    const id = await openDm(['bob', 'bob']);
    expect(id).toBe('d1');
    expect(mock('openDm')).toHaveBeenCalledWith('o1', ['bob']);
    expect(getState().channels.d1).toMatchObject({ kind: 'dm', hidden: false });
  });

  it('a reply for another organization does not land in this one', async () => {
    mock('joinChannel').mockResolvedValueOnce(ch('x9', { org_id: 'o2' }));
    await joinChannel('x9');
    expect(getState().channels.x9).toBeUndefined();
  });
});

describe('calls: a late copy never wins', () => {
  const call = (extra: Partial<Call> = {}): Call => ({
    id: 'k1', org_id: 'o1', channel_id: 'd1', kind: 'direct', media: 'audio', started_by: 'bob', created_at: '2026-10-03T00:00:00Z',
    ended_at: null, end_reason: null,
    participants: [{ user_id: 'bob', state: 'joined', session_id: 's1', joined_at: '2026-10-03T00:00:01Z' }, { user_id: 'me', state: 'ringing', session_id: null, joined_at: null }],
    ...extra,
  });

  it('an ended call is never replaced by an older unended copy', () => {
    const ended = call({ ended_at: '2026-10-03T00:01:00Z', end_reason: 'declined', participants: [call().participants[0]!, { user_id: 'me', state: 'declined', session_id: null, joined_at: null }] });
    setState({ calls: { k1: ended } });
    expect(applyCall(getState(), call())).toEqual({});
    expect(isOlderCall(call(), ended)).toBe(true);
  });

  it('a late ring after I answered does not bring the incoming sheet back', () => {
    const answered = call({ participants: [call().participants[0]!, { user_id: 'me', state: 'joined', session_id: 's2', joined_at: '2026-10-03T00:00:05Z' }] });
    setState({ calls: { k1: answered } });
    expect(applyCall(getState(), call())).toEqual({});
  });

  it('a copy missing a participant is older; a newer copy replaces', () => {
    const two = call();
    expect(isOlderCall({ ...two, participants: [two.participants[0]!] }, two)).toBe(true);
    const ended = call({ ended_at: '2026-10-03T00:02:00Z' });
    setState({ calls: { k1: two } });
    expect(applyCall(getState(), ended).calls?.k1?.ended_at).toBe('2026-10-03T00:02:00Z');
  });

  it('uses a version or updated_at when the server sends one', () => {
    const v1 = { ...call(), version: 1 } as Call;
    const v2 = { ...call({ ended_at: '2026-10-03T00:02:00Z' }), version: 2 } as Call;
    expect(isOlderCall(v1, v2)).toBe(true);
    expect(isOlderCall(v2, v1)).toBe(false);
  });
});
