import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/api/rpc', () => ({ api: { threadWindow: vi.fn(), getProfiles: vi.fn(async () => []) } }));
vi.mock('../../src/sync/channels', () => ({ clearNotificationsFor: vi.fn() }));
vi.mock('../../src/sync/org', () => ({ scheduleBootstrapRefresh: vi.fn() }));
vi.mock('../../src/sync/profiles', () => ({ ensureProfiles: vi.fn() }));
import { api } from '../../src/api/rpc';
import { DekError } from '../../src/api/errors';
import type { Message, ThreadWindow } from '../../src/api/types';
import { getState, resetState, setState } from '../../src/store/state';
import { channel, ORG, CHAN } from '../ui/collaboration-fixture';
import { closeThread, healThread, loadThreadMore, openThread, resetThreads } from '../../src/sync/threads';
import { applyNewMessage, applyThreadRead } from '../../src/sync/reducers';
import { scheduleBootstrapRefresh } from '../../src/sync/org';
const rpc = vi.mocked(api.threadWindow);
function msg(seq: number, root = 'root'): Message {
  return { id: `r${seq}`, org_id: ORG, channel_id: CHAN, seq, thread_root_id: root,
    author_id: 'bob', kind: 'user', body: `reply ${seq}`, mentions: [], mention_all: false, client_id: null,
    created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', edited_at: null, deleted_at: null,
    reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments: [], pinned: false,
    also_in_channel: false, meta: {} };
}
function page(seqs: number[], extra: Partial<ThreadWindow> = {}): ThreadWindow {
  return { root: { ...msg(1), id: 'root', thread_root_id: null }, replies: seqs.map(n => msg(n)),
    has_before: false, has_after: false, has_more: false, first_seq: seqs[0] ?? 0, last_seq: seqs.at(-1) ?? 0,
    following: false, last_read_reply_seq: 0, target_id: null, ...extra };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
beforeEach(() => { resetThreads(); resetState(); vi.clearAllMocks(); rpc.mockReset();
  setState({ orgId: ORG, channels: { [CHAN]: channel }, session: { status: 'signed_in', userId: 'alice', email: null, setup: null } }); });
describe('thread windows and access', () => {
  it('uses the exact target on reopen, then confirmed page edges rather than realtime maxima', async () => {
    rpc.mockResolvedValueOnce(page([100,101,102], { target_id: 'r101', has_after: true, has_before: true }));
    await openThread('root', { channelId: CHAN, messageId: 'r101' });
    expect(rpc).toHaveBeenLastCalledWith('root', { target: 'r101' });
    setState(applyNewMessage(getState(), msg(200), { me: 'alice', onScreen: () => false }).patch);
    rpc.mockResolvedValueOnce(page([103,104], { has_after: true }));
    await loadThreadMore('root');
    expect(rpc).toHaveBeenLastCalledWith('root', { after: 102 });
    expect(getState().threads.root!.replyIds).toEqual(['r100','r101','r102','r103','r104']);
  });
  it('queues a bounded catch-up for a second reply arriving during the first query', async () => {
    rpc.mockResolvedValueOnce(page([2])); await openThread('root', { channelId: CHAN });
    const pending = deferred<ThreadWindow>(); rpc.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([4]));
    const healing = healThread('root');
    setState(applyNewMessage(getState(), msg(4), { me: 'alice', onScreen: () => false }).patch);
    await healThread('root');
    pending.resolve(page([3])); await healing;
    expect(rpc.mock.calls.slice(1)).toEqual([['root',{after:2}],['root',{after:3}]]);
    expect(getState().threads.root!.replyIds).toEqual(['r2','r3','r4']);
    expect(getState().threads.root!.newReplies).toBe(false);
  });
  it('heals a reply arriving between the opening query snapshot and its response', async () => {
    const pending=deferred<ThreadWindow>(); rpc.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([3]));
    const opening=openThread('root',{channelId:CHAN});
    setState(applyNewMessage(getState(),msg(3),{me:'alice',onScreen:()=>false}).patch);
    await healThread('root'); pending.resolve(page([2])); await opening;
    expect(getState().threads.root!.replyIds).toEqual(['r2','r3']);
    expect(rpc).toHaveBeenLastCalledWith('root',{after:2});
  });
  it('an old heal cannot consume the reopened generation catch-up flag',async()=>{
    rpc.mockResolvedValueOnce(page([2]));await openThread('root',{channelId:CHAN});
    const old=deferred<ThreadWindow>(),fresh=deferred<ThreadWindow>();
    rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise).mockResolvedValueOnce(page([4]));
    const healing=healThread('root'),opening=openThread('root',{channelId:CHAN});
    setState(applyNewMessage(getState(),msg(4),{me:'alice',onScreen:()=>false}).patch);await healThread('root');
    old.resolve(page([3]));await healing;fresh.resolve(page([2,3]));await opening;
    expect(getState().threads.root!.replyIds).toEqual(['r2','r3','r4']);
  });
  it.each(['not_found','forbidden','suspended'] as const)('purges all cached private replies on %s paging denial', async code => {
    rpc.mockResolvedValueOnce(page([2], { has_after: true })); await openThread('root', { channelId: CHAN });
    setState({ messages: { ...getState().messages, r99: msg(99), other: { ...msg(7,'other-root'), id:'other' } } });
    rpc.mockRejectedValueOnce(new DekError(code)); await expect(loadThreadMore('root')).rejects.toThrow();
    expect(Object.keys(getState().messages)).toEqual(['other']);
    expect(getState().threads.root).toMatchObject({ status: 'error', replyIds: [] });
    expect(scheduleBootstrapRefresh).toHaveBeenCalled();
  });
  it('also purges a reconnect denial and rejects an in-flight result after close', async () => {
    rpc.mockResolvedValueOnce(page([2])); await openThread('root', { channelId: CHAN });
    rpc.mockRejectedValueOnce(new DekError('forbidden')); await healThread('root');
    expect(getState().messages.root).toBeUndefined();
    const pending=deferred<ThreadWindow>(); rpc.mockReturnValueOnce(pending.promise);
    const opening=openThread('root',{channelId:CHAN}); closeThread('root'); pending.resolve(page([3])); await opening;
    expect(getState().messages.r3).toBeUndefined();
  });
  it('keeps the six-thread cache bounded and read receipts monotonic after confirmation', async () => {
    for(let i=0;i<10;i++) { rpc.mockResolvedValueOnce(page([],{root:{...msg(1),id:`root${i}`,thread_root_id:null}})); await openThread(`root${i}`,{channelId:CHAN}); }
    expect(Object.keys(getState().threads)).toHaveLength(6);
    const s=getState(), tv=s.threads.root9!;
    setState({threads:{...s.threads,root9:{...tv,lastReadReplySeq:50}}});
    expect(applyThreadRead(getState(),'root9',20,0)).toBeNull();
  });
});
