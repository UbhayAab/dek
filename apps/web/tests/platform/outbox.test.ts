// The durable outbox (DEK06, DEKA03): written before the network, replayed with the
// same client id, FIFO per channel with one request in flight, backoff 2 s to
// 120 s plus jitter, failure states with retry and discard, 900 ms status delay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DekError } from '../../src/api/errors';
import type { Message } from '../../src/api/types';
import { Outbox, type OutboxDeps, type OutboxInput, type OutboxRecord } from '../../src/sync/outbox';
import { memoryOutboxStorage } from '../../src/sync/outbox-storage';
import type { PendingMessage } from '../../src/store/state';

function msg(rec: OutboxRecord, seq = 1): Message {
  return {
    id: `m-${rec.clientId}`, org_id: 'o1', channel_id: rec.channelId, seq, thread_root_id: rec.threadRootId, author_id: 'me',
    kind: 'user', body: rec.body, mentions: [], mention_all: false, client_id: rec.clientId, created_at: new Date().toISOString(),
    edited_at: null, deleted_at: null, updated_at: new Date().toISOString(), reply_count: 0, last_reply_at: null, reply_user_ids: [],
    reactions: {}, attachments: [], pinned: false, also_in_channel: false, meta: {},
  };
}

function input(channelId: string, body: string): OutboxInput {
  return { orgId: 'o1', channelId, threadRootId: null, body, attachmentIds: [], alsoInChannel: false };
}

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(opts: Partial<OutboxDeps> = {}, storage = memoryOutboxStorage()) {
  const updates = new Map<string, PendingMessage | null>();
  const accepted: string[] = [];
  const sends: { clientId: string; at: number; attempt: number }[] = [];
  const deps: OutboxDeps = {
    storage,
    send: vi.fn(async (rec: OutboxRecord) => {
      sends.push({ clientId: rec.clientId, at: Date.now(), attempt: rec.attempts });
      return msg(rec);
    }),
    onUpdate: (id, rec) => { updates.set(id, rec); },
    onAccepted: (id) => { accepted.push(id); },
    tabId: 'tab-1',
    now: () => Date.now(),
    random: () => 0,
    ...opts,
  };
  return { outbox: new Outbox(deps), deps, storage, updates, accepted, sends };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('outbox: durable first', () => {
  it('keeps a newly authorized enqueue durable when an old dropped-channel snapshot is loaded',async()=>{
    const h=harness({send:vi.fn(async()=>{throw new DekError('network');})});
    h.outbox.dropChannels(new Set(['c1']));const id=h.outbox.enqueue(input('c1','newly authorized draft'));
    await vi.advanceTimersByTimeAsync(0);await h.outbox.load();
    expect(h.storage.rows.get(id)?.body).toBe('newly authorized draft');expect(h.outbox.snapshot()).toHaveLength(1);h.outbox.stop();
  });
  it('never rehydrates a revoked channel from an older storage-load snapshot',async()=>{
    const old=deferred<OutboxRecord[]>(),storage=memoryOutboxStorage();
    const row={...input('c1','private stored reply'),clientId:'old',createdAt:1,attempts:0,status:'pending',nextAttemptAt:null,error:null,statusVisible:false,ownerTab:'tab-1'} as OutboxRecord;
    storage.rows.set('old',row);const h=harness({}, {...storage,load:()=>old.promise});
    const loading=h.outbox.load();h.outbox.dropChannels(new Set(['c1']));old.resolve([row]);await loading;await vi.advanceTimersByTimeAsync(0);
    expect(h.outbox.snapshot()).toEqual([]);expect(h.sends).toEqual([]);expect(storage.rows.size).toBe(0);expect(h.updates.has('old')).toBe(false);h.outbox.stop();
  });
  it('erases a revoked in-flight record immediately and never restores it from a late success',async()=>{
    const result=deferred<Message>();let sent!:OutboxRecord;
    const h=harness({send:vi.fn(rec=>{sent=rec;return result.promise;})});
    const id=h.outbox.enqueue({...input('c1','private thread reply'),threadRootId:'root'});
    await vi.advanceTimersByTimeAsync(0);h.outbox.dropChannels(new Set(['c1']));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.outbox.snapshot()).toEqual([]);expect(h.storage.rows.size).toBe(0);expect(h.updates.get(id)).toBeNull();
    result.resolve(msg(sent));await vi.advanceTimersByTimeAsync(0);
    expect(h.accepted).toEqual([]);expect(h.updates.get(id)).toBeNull();h.outbox.stop();
  });
  it('writes the record to storage before the network is touched', async () => {
    const write = deferred<void>();
    const base = memoryOutboxStorage();
    const order: string[] = [];
    const storage = {
      ...base,
      save: async (rec: OutboxRecord) => { order.push('save-start'); await write.promise; await base.save(rec); order.push('save-done'); },
    };
    const h = harness({ send: vi.fn(async (rec: OutboxRecord) => { order.push('send'); return msg(rec); }) }, storage as never);
    const id = h.outbox.enqueue(input('c1', 'hello'));
    expect(h.updates.get(id)?.status).toBe('pending');           // painted at once
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(['save-start']);                       // no network yet
    write.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['save-start', 'save-done', 'send']);
    expect(h.accepted).toEqual([id]);
    expect(base.rows.size).toBe(0);                              // removed once accepted
  });

  it('replays with the SAME client id after a reload', async () => {
    const storage = memoryOutboxStorage();
    const first = harness({ send: vi.fn(async () => { throw new DekError('network'); }) }, storage);
    const id = first.outbox.enqueue(input('c1', 'survives a reload'));
    await vi.advanceTimersByTimeAsync(10);
    expect(first.updates.get(id)?.status).toBe('retrying');
    first.outbox.stop();                                         // the tab died
    expect(storage.rows.get(id)?.body).toBe('survives a reload');

    const second = harness({}, storage);
    await second.outbox.load();
    await vi.advanceTimersByTimeAsync(10);
    expect(second.sends.map((s) => s.clientId)).toEqual([id]);
    expect(second.accepted).toEqual([id]);
    expect(storage.rows.size).toBe(0);
  });
});

describe('outbox: order', () => {
  it('is FIFO per channel with one request in flight, channels independent', async () => {
    const gates = new Map<string, Deferred<Message>>();
    const calls: string[] = [];
    const h = harness({
      send: vi.fn((rec: OutboxRecord) => {
        calls.push(rec.body);
        const d = deferred<Message>();
        gates.set(rec.body, d);
        return d.promise.then(() => msg(rec));
      }),
    });
    h.outbox.enqueue(input('A', 'a1'));
    h.outbox.enqueue(input('A', 'a2'));
    h.outbox.enqueue(input('B', 'b1'));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['a1', 'b1']);                         // a2 waits behind a1
    gates.get('a1')!.resolve(undefined as never);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['a1', 'b1', 'a2']);
  });

  it('holds later messages of a channel while the first one backs off', async () => {
    let fail = true;
    const calls: string[] = [];
    const h = harness({
      send: vi.fn(async (rec: OutboxRecord) => {
        calls.push(rec.body);
        if (fail && rec.body === 'first') throw new DekError('network');
        return msg(rec);
      }),
    });
    h.outbox.enqueue(input('A', 'first'));
    h.outbox.enqueue(input('A', 'second'));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['first']);
    fail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(['first', 'first', 'second']);
  });
});

describe('outbox: retry policy', () => {
  it('backs off 2 s doubling to 120 s, plus jitter', async () => {
    const h = harness({ send: vi.fn(async () => { throw new DekError('server'); }) });
    const id = h.outbox.enqueue(input('c1', 'x'));
    await vi.advanceTimersByTimeAsync(10);
    const delays: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const rec = h.updates.get(id)!;
      expect(rec.status).toBe('retrying');
      const wait = rec.nextAttemptAt! - Date.now();
      delays.push(Math.round(wait / 1000) * 1000);
      await vi.advanceTimersByTimeAsync(wait + 5);
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000, 120_000, 120_000]);
  });

  it('adds jitter on top of the base delay', async () => {
    const h = harness({ send: vi.fn(async () => { throw new DekError('network'); }), random: () => 1 });
    const id = h.outbox.enqueue(input('c1', 'x'));
    await vi.advanceTimersByTimeAsync(10);
    const wait = h.updates.get(id)!.nextAttemptAt! - Date.now();
    expect(wait).toBeGreaterThanOrEqual(2_990);                  // 2 s base + 1 s minimum jitter
    expect(wait).toBeLessThanOrEqual(3_010);
  });

  it.each([
    ['network', new DekError('network')],
    ['timeout', new DekError('timeout')],
    ['server error', new DekError('server')],
    ['429', new DekError('rate_limited')],
    ['auth_required', new DekError('auth_required')],
    ['raw fetch failure', new TypeError('Failed to fetch')],
  ])('retries on %s', async (_label, error) => {
    const h = harness({ send: vi.fn(async () => { throw error; }) });
    const id = h.outbox.enqueue(input('c1', 'x'));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.updates.get(id)?.status).toBe('retrying');
  });

  it('turns other errors into failed with the server hint, and later messages continue', async () => {
    const calls: string[] = [];
    const h = harness({
      send: vi.fn(async (rec: OutboxRecord) => {
        calls.push(rec.body);
        if (rec.body === 'bad') throw new DekError('archived', 'This channel is archived.');
        return msg(rec);
      }),
    });
    const bad = h.outbox.enqueue(input('A', 'bad'));
    const good = h.outbox.enqueue(input('A', 'good'));
    await vi.advanceTimersByTimeAsync(10);
    const rec = h.updates.get(bad)!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toEqual({ code: 'archived', hint: 'This channel is archived.' });
    expect(rec.statusVisible).toBe(true);                        // the person must act: shown at once
    expect(calls).toEqual(['bad', 'good']);
    expect(h.accepted).toEqual([good]);
    expect(h.storage.rows.get(bad)?.status).toBe('failed');      // the text is kept
  });

  it('retrySend tries again with the same client id; discard removes it', async () => {
    let reject = true;
    const h = harness({
      send: vi.fn(async (rec: OutboxRecord) => {
        h.sends.push({ clientId: rec.clientId, at: Date.now(), attempt: rec.attempts });
        if (reject) throw new DekError('invalid_input', 'Too long.');
        return msg(rec);
      }),
    });
    const a = h.outbox.enqueue(input('A', 'one'));
    const b = h.outbox.enqueue(input('A', 'two'));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.updates.get(a)?.status).toBe('failed');
    expect(h.updates.get(b)?.status).toBe('failed');
    reject = false;
    h.outbox.retry(a);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sends.filter((s) => s.clientId === a)).toHaveLength(2);
    expect(h.accepted).toEqual([a]);
    h.outbox.discard(b);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.updates.get(b)).toBeNull();
    expect(h.storage.rows.size).toBe(0);
  });

  it('kick() retries at once instead of waiting out the backoff', async () => {
    let offline = true;
    const h = harness({ send: vi.fn(async (rec: OutboxRecord) => { if (offline) throw new DekError('network'); return msg(rec); }) });
    const id = h.outbox.enqueue(input('c1', 'x'));
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(h.updates.get(id)!.nextAttemptAt! - Date.now() + 5);
    expect(h.updates.get(id)!.nextAttemptAt! - Date.now()).toBeGreaterThan(20_000);
    offline = false;
    h.outbox.kick();                                             // the online event
    await vi.advanceTimersByTimeAsync(10);
    expect(h.accepted).toEqual([id]);
  });
});

describe('outbox: status visibility and ownership', () => {
  it('shows delivery state only after 900 ms', async () => {
    const h = harness({ send: vi.fn(() => new Promise<Message>(() => undefined)) });
    const id = h.outbox.enqueue(input('c1', 'slow'));
    await vi.advanceTimersByTimeAsync(899);
    expect(h.updates.get(id)?.statusVisible).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.updates.get(id)?.statusVisible).toBe(true);
  });

  it('a fast send never shows a status', async () => {
    const h = harness();
    const id = h.outbox.enqueue(input('c1', 'fast'));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.accepted).toEqual([id]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.updates.get(id)).toBeNull();
  });

  it('settle() drops a record that was accepted elsewhere', async () => {
    const h = harness({ send: vi.fn(async () => { throw new DekError('network'); }) });
    const id = h.outbox.enqueue(input('c1', 'x'));
    await vi.advanceTimersByTimeAsync(10);
    h.outbox.settle(id);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.updates.get(id)).toBeNull();
    expect(h.storage.rows.size).toBe(0);
  });

  it('a message delivered while its own request is out shows no extra "Sending" bubble', async () => {
    let finish!: (m: Message) => void;
    let fail!: (e: unknown) => void;
    const h = harness({
      send: vi.fn((rec: OutboxRecord) => new Promise<Message>((res, rej) => { finish = () => res(msg(rec)); fail = rej; })),
    });
    const id = h.outbox.enqueue(input('c1', 'x'));
    await vi.advanceTimersByTimeAsync(10);
    h.outbox.settle(id);                                         // realtime msg.new with my client id
    expect(h.updates.get(id)).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);                    // the 900 ms reveal must not bring it back
    expect(h.updates.get(id)).toBeNull();
    fail(new DekError('timeout'));                               // the answer was lost, not the message
    await vi.advanceTimersByTimeAsync(10);
    expect(h.updates.get(id)).toBeNull();
    expect(h.storage.rows.size).toBe(0);
    await vi.advanceTimersByTimeAsync(130_000);
    expect((h.deps.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);   // no retry of a delivered message
    void finish;
  });

  it('leaves records of another open tab alone and adopts those of a closed tab', async () => {
    const mk = (clientId: string, ownerTab: string): OutboxRecord => ({
      clientId, orgId: 'o1', channelId: 'c1', threadRootId: null, body: clientId, attachmentIds: [], alsoInChannel: false,
      status: 'pending', attempts: 0, createdAt: Date.now(), nextAttemptAt: null, error: null, statusVisible: false, ownerTab,
    });
    const storage = memoryOutboxStorage([mk('live-tab-msg', 'tab-live'), mk('dead-tab-msg', 'tab-dead')]);
    const h = harness({ isTabAlive: async (t) => t === 'tab-live' }, storage);
    await h.outbox.load();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sends.map((s) => s.clientId)).toEqual(['dead-tab-msg']);
    expect(h.updates.get('live-tab-msg')?.status).toBe('pending');   // shown, not sent twice
  });

  it('a discard right after enqueue never resurrects the record', async () => {
    const h = harness({ send: vi.fn(async () => { throw new DekError('invalid_input'); }) });
    const id = h.outbox.enqueue(input('c1', 'oops'));
    await vi.advanceTimersByTimeAsync(10);
    h.outbox.discard(id);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.storage.rows.has(id)).toBe(false);
    expect(h.storage.log.at(-1)).toBe(`remove:${id}`);
  });
});
