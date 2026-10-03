// The realtime hub: one socket per browser through a Web Locks leader, relay over
// BroadcastChannel, de-duplication by payload.id, follower sends forwarded, takeover
// when the leader closes, and the resubscribe state machine (token refresh first,
// backoff, onReconnected after the rejoin).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Hub, type BusLike, type HubEnv, type LocksLike, type SubStatus, type Transport, type WireChannel, type WireMessage,
} from '../../src/realtime/hub';
import type { ReconnectReason, ServerEvent } from '../../src/realtime/types';

// ---------------------------------------------------------------- fakes

class FakeNet {
  private readonly ends = new Set<FakeBus>();
  open(): FakeBus {
    const b = new FakeBus(this);
    this.ends.add(b);
    return b;
  }
  deliver(from: FakeBus, data: unknown): void {
    for (const e of this.ends) {
      if (e !== from && !e.closed) queueMicrotask(() => e.emit(structuredClone(data)));
    }
  }
  drop(b: FakeBus): void {
    this.ends.delete(b);
  }
}

class FakeBus implements BusLike {
  closed = false;
  private readonly listeners: ((e: MessageEvent) => void)[] = [];
  constructor(private readonly net: FakeNet) {}
  postMessage(m: unknown): void {
    if (!this.closed) this.net.deliver(this, m);
  }
  addEventListener(_t: 'message', l: (e: MessageEvent) => void): void {
    this.listeners.push(l);
  }
  emit(data: unknown): void {
    for (const l of this.listeners) l({ data } as MessageEvent);
  }
  close(): void {
    this.closed = true;
    this.net.drop(this);
  }
}

class FakeLocks implements LocksLike {
  private holder: { name: string } | null = null;
  private readonly queue: { cb: () => Promise<void>; resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: AbortSignal; done: boolean }[] = [];
  request(_name: string, options: { signal?: AbortSignal }, cb: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = { cb, resolve, reject, signal: options.signal, done: false };
      options.signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new DOMException('aborted', 'AbortError'));
        }
      });
      this.queue.push(entry);
      this.pump();
    });
  }
  private pump(): void {
    if (this.holder) return;
    const next = this.queue.shift();
    if (!next) return;
    this.holder = { name: 'held' };
    void Promise.resolve(next.cb()).then((v) => {
      this.holder = null;
      next.resolve(v);
      this.pump();
    });
  }
}

class FakeChannel implements WireChannel {
  removed = false;
  readonly sent: [string, unknown][] = [];
  private onMsg: ((m: WireMessage) => void) | null = null;
  private onSub: ((s: SubStatus, e?: Error) => void) | null = null;
  constructor(readonly topic: string, private readonly t: FakeTransport) {}
  onMessage(cb: (m: WireMessage) => void): void { this.onMsg = cb; }
  subscribe(cb: (s: SubStatus, e?: Error) => void): void {
    this.onSub = cb;
    if (this.t.autoAck) queueMicrotask(() => this.status('SUBSCRIBED'));
  }
  async send(event: string, payload: unknown): Promise<string> {
    this.sent.push([event, payload]);
    return 'ok';
  }
  status(s: SubStatus, msg?: string): void { this.onSub?.(s, msg ? new Error(msg) : undefined); }
  emit(event: string, payload: unknown): void { this.onMsg?.({ event, payload }); }
}

class FakeTransport implements Transport {
  autoAck = true;
  refreshes = 0;
  resets = 0;
  readonly channels: FakeChannel[] = [];
  readonly log: string[] = [];
  channel(topic: string): FakeChannel {
    const ch = new FakeChannel(topic, this);
    this.channels.push(ch);
    this.log.push(`join:${topic}`);
    return ch;
  }
  async remove(ch: WireChannel): Promise<void> {
    (ch as FakeChannel).removed = true;
    this.log.push(`remove:${(ch as FakeChannel).topic}`);
  }
  async refreshAuth(): Promise<void> {
    this.refreshes += 1;
    this.log.push('refresh');
  }
  async reset(): Promise<void> {
    this.resets += 1;
  }
  isConnected(): boolean {
    return true;
  }
  live(topic: string): FakeChannel | undefined {
    return [...this.channels].reverse().find((c) => c.topic === topic && !c.removed);
  }
}

function env(id: string, t: FakeTransport, net: FakeNet | null, locks: FakeLocks | null): HubEnv {
  return {
    transport: () => t,
    locks: () => locks,
    openBus: () => (net ? net.open() : null),
    online: () => true,
    hidden: () => false,
    listen: () => () => undefined,
    now: () => Date.now(),
    random: () => 0,
    newTabId: () => id,
  };
}

// Since migration 0900 the event id is "eid"; "id" is a scope id where a payload has one.
function msgNew(eid: string): unknown {
  return { v: 1, eid, message: { id: `m-${eid}`, channel_id: 'c1' } };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------- tests

describe('one socket per browser', () => {
  it('elects one leader; only the leader opens channels, for the union of topics', async () => {
    const net = new FakeNet();
    const locks = new FakeLocks();
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    const a = new Hub(env('A', tA, net, locks));
    const b = new Hub(env('B', tB, net, locks));
    for (const h of [a, b]) { h.setIdentity('u1'); h.start(); }
    a.setTopics(['u:u1', 's:s1']);
    b.setTopics(['u:u1']);
    b.joinView('c9');
    await settle();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(tB.channels).toHaveLength(0);
    expect(a.debug().joined).toEqual(['s:s1', 't:c9', 'u:u1']);
    expect(a.debug().tabs).toBe(2);
    expect(b.status()).toBe('online');
  });

  it('relays server events to followers, de-duplicated by payload.id', async () => {
    const net = new FakeNet();
    const locks = new FakeLocks();
    const tA = new FakeTransport();
    const a = new Hub(env('A', tA, net, locks));
    const b = new Hub(env('B', new FakeTransport(), net, locks));
    for (const h of [a, b]) { h.setIdentity('u1'); h.start(); h.setTopics(['u:u1']); }
    await settle();
    const gotA: ServerEvent[] = [];
    const gotB: ServerEvent[] = [];
    a.onEvent((e) => gotA.push(e));
    b.onEvent((e) => gotB.push(e));
    const ch = tA.live('u:u1')!;
    ch.emit('msg.new', msgNew('e1'));
    ch.emit('msg.new', msgNew('e1'));     // the same event delivered twice
    ch.emit('msg.new', msgNew('e2'));
    ch.emit('presence', { id: 'p' });     // not a server event
    await settle();
    expect(gotA.map((e) => (e.payload as { eid: string }).eid)).toEqual(['e1', 'e2']);
    expect(gotB.map((e) => (e.payload as { eid: string }).eid)).toEqual(['e1', 'e2']);
  });

  it('de-duplicates by eid, never by the scope id two different events share', async () => {
    const t = new FakeTransport();
    const h = new Hub(env('A', t, null, null));
    h.setIdentity('u1');
    h.start();
    h.setTopics(['u:u1']);
    await settle();
    const got: ServerEvent[] = [];
    h.onEvent((e) => got.push(e));
    const ch = t.live('u:u1')!;
    ch.emit('member.upd', { v: 1, eid: 'a', scope: 'channel', id: 'c9', user_id: 'x', change: 'added' });
    ch.emit('member.upd', { v: 1, eid: 'b', scope: 'channel', id: 'c9', user_id: 'y', change: 'added' });
    ch.emit('access.revoked', { v: 1, eid: 'c', scope: 'channel', id: 'c9' });
    ch.emit('access.revoked', { v: 1, eid: 'c', scope: 'channel', id: 'c9' });   // a repeat
    ch.emit('chan.self', { v: 1, eid: 'd', channel_id: 'c9', notify: 'all', muted_until: null, hidden: false });
    ch.emit('org.upd', { v: 1, eid: 'e', org: { id: 'o1' } });
    ch.emit('server.upd', { v: 1, eid: 'f', server: { id: 's1' } });
    await settle();
    expect(got.map((e) => e.event)).toEqual(['member.upd', 'member.upd', 'access.revoked', 'chan.self', 'org.upd', 'server.upd']);
  });

  it('ignores relays from a tab of another person', async () => {
    const net = new FakeNet();
    const locks = new FakeLocks();
    const tA = new FakeTransport();
    const a = new Hub(env('A', tA, net, locks));
    const b = new Hub(env('B', new FakeTransport(), net, locks));
    a.setIdentity('u1');
    b.setIdentity('u2');
    a.start();
    b.start();
    a.setTopics(['u:u1']);
    await settle();
    const gotB: ServerEvent[] = [];
    b.onEvent((e) => gotB.push(e));
    tA.live('u:u1')!.emit('msg.new', msgNew('x'));
    await settle();
    expect(gotB).toEqual([]);
  });

  it('forwards a follower\'s typing and call signals through the leader\'s channel', async () => {
    const net = new FakeNet();
    const locks = new FakeLocks();
    const tA = new FakeTransport();
    const a = new Hub(env('A', tA, net, locks));
    const b = new Hub(env('B', new FakeTransport(), net, locks));
    for (const h of [a, b]) { h.setIdentity('u1'); h.start(); }
    b.joinView('c1');
    b.joinCall('k1');
    await settle();
    b.sendTyping('c1', null);
    b.sendSignal('k1', { from_user: 'u1', from_session: 's1', to_session: null, kind: 'hello', data: null });
    await settle();
    expect(tA.live('t:c1')!.sent).toEqual([['typing', { user_id: 'u1', thread_root_id: null }]]);
    expect(tA.live('call:k1')!.sent[0]![0]).toBe('signal');
  });

  it('relays typing and signals received by the leader', async () => {
    const net = new FakeNet();
    const locks = new FakeLocks();
    const tA = new FakeTransport();
    const a = new Hub(env('A', tA, net, locks));
    const b = new Hub(env('B', new FakeTransport(), net, locks));
    for (const h of [a, b]) { h.setIdentity('u1'); h.start(); }
    b.joinView('c1');
    await settle();
    const typing: [string, string][] = [];
    b.onTyping((c, s) => typing.push([c, s.user_id]));
    tA.live('t:c1')!.emit('typing', { user_id: 'bob', thread_root_id: null });
    await settle();
    expect(typing).toEqual([['c1', 'bob']]);
  });

  it('a follower takes over when the leader tab closes, rejoins and heals', async () => {
    const net = new FakeNet();
    const locks = new FakeLocks();
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    const a = new Hub(env('A', tA, net, locks));
    const b = new Hub(env('B', tB, net, locks));
    for (const h of [a, b]) { h.setIdentity('u1'); h.start(); h.setTopics(['u:u1']); }
    await settle();
    const reasons: ReconnectReason[] = [];
    b.onReconnected((r) => reasons.push(r));
    a.stop();
    await settle();
    expect(b.isLeader()).toBe(true);
    expect(tB.live('u:u1')).toBeDefined();
    await vi.advanceTimersByTimeAsync(300);
    expect(reasons).toEqual(['takeover']);
    expect(b.status()).toBe('online');
  });

  it('without Web Locks every tab connects on its own', async () => {
    const tA = new FakeTransport();
    const a = new Hub(env('A', tA, new FakeNet(), null));
    a.setIdentity('u1');
    a.start();
    a.setTopics(['u:u1']);
    await settle();
    expect(a.isLeader()).toBe(true);
    expect(tA.live('u:u1')).toBeDefined();
  });

  it('drops a follower\'s topics when it says bye', async () => {
    const net = new FakeNet();
    const locks = new FakeLocks();
    const tA = new FakeTransport();
    const a = new Hub(env('A', tA, net, locks));
    const b = new Hub(env('B', new FakeTransport(), net, locks));
    for (const h of [a, b]) { h.setIdentity('u1'); h.start(); }
    a.setTopics(['u:u1']);
    b.joinView('c7');
    await settle();
    expect(a.debug().joined).toContain('t:c7');
    b.stop();
    await settle();
    expect(a.debug().joined).toEqual(['u:u1']);
  });
});

describe('resubscribe state machine', () => {
  it('on CHANNEL_ERROR: remove, back off, refresh the token, rejoin, then onReconnected', async () => {
    const t = new FakeTransport();
    const h = new Hub(env('A', t, null, null));
    h.setIdentity('u1');
    h.start();
    h.setTopics(['u:u1']);
    await vi.advanceTimersByTimeAsync(300);
    const reasons: ReconnectReason[] = [];
    h.onReconnected((r) => reasons.push(r));
    expect(h.status()).toBe('online');
    const first = t.live('u:u1')!;
    first.status('CHANNEL_ERROR', 'socket closed');
    await settle();
    expect(first.removed).toBe(true);
    expect(h.status()).toBe('reconnecting');
    expect(t.live('u:u1')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(999);
    expect(t.live('u:u1')).toBeUndefined();          // 1 s backoff not over
    await vi.advanceTimersByTimeAsync(1);
    const i = t.log.lastIndexOf('refresh');
    expect(i).toBeGreaterThan(t.log.indexOf('remove:u:u1'));
    expect(t.log[i + 1]).toBe('join:u:u1');           // token first, then the join
    await vi.advanceTimersByTimeAsync(300);
    expect(h.status()).toBe('online');
    expect(reasons).toEqual(['rejoin']);
  });

  it('backs off 1 s, 2 s, 4 s ... up to 30 s while joins keep failing', async () => {
    const t = new FakeTransport();
    t.autoAck = false;
    const h = new Hub(env('A', t, null, null));
    h.setIdentity('u1');
    h.start();
    h.setTopics(['u:u1']);
    await settle();
    const gaps: number[] = [];
    let last = Date.now();
    for (let n = 0; n < 7; n += 1) {
      t.live('u:u1')!.status('TIMED_OUT');
      const joinsBefore = t.channels.length;
      while (t.channels.length === joinsBefore) await vi.advanceTimersByTimeAsync(100);
      gaps.push(Math.round((Date.now() - last) / 1000) * 1000);
      last = Date.now();
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('a call topic refused before the answer commits retries on the fast schedule', async () => {
    const t = new FakeTransport();
    const h = new Hub(env('A', t, null, null));
    h.setIdentity('u1');
    h.start();
    h.setTopics(['u:u1']);
    h.joinCall('k1');
    await settle();
    t.live('call:k1')!.status('CHANNEL_ERROR', 'Unauthorized: You do not have permissions to read from this Channel topic: call:k1');
    await settle();
    expect(h.status()).toBe('online');            // a call topic never shows "Reconnecting"
    const before = t.channels.filter((c) => c.topic === 'call:k1').length;
    await vi.advanceTimersByTimeAsync(1_100);     // not the 2 minute denied schedule
    expect(t.channels.filter((c) => c.topic === 'call:k1').length).toBe(before + 1);
  });

  it('a topic the server refuses does not leave the status stuck on reconnecting', async () => {
    const t = new FakeTransport();
    const h = new Hub(env('A', t, null, null));
    h.setIdentity('u1');
    h.start();
    h.setTopics(['u:u1', 's:gone']);
    await settle();
    t.live('s:gone')!.status('CHANNEL_ERROR', 'Unauthorized: You do not have permissions to read from this Channel topic: s:gone');
    await settle();
    expect(h.status()).toBe('online');
    expect(h.debug().joined).toEqual(['u:u1']);
  });

  it('a topic dropped and re-added before its channel finished leaving joins on a fresh channel', async () => {
    const t = new FakeTransport();
    let finishLeave!: () => void;
    const leaving = new Promise<void>((r) => { finishLeave = r; });
    const realRemove = t.remove.bind(t);
    t.remove = async (ch) => { await leaving; await realRemove(ch); };
    const h = new Hub(env('A', t, null, null));
    h.setIdentity('u1');
    h.start();
    h.setTopics(['u:u1']);
    h.joinView('c1');
    await settle();
    const first = t.channels.find((c) => c.topic === 't:c1')!;
    h.leaveView('c1');          // switch away ...
    h.joinView('c1');           // ... and straight back
    await settle();
    expect(t.channels.filter((c) => c.topic === 't:c1')).toHaveLength(1);   // waits, no join on the leaving one
    finishLeave();
    await settle();
    await settle();
    const joins = t.channels.filter((c) => c.topic === 't:c1');
    expect(joins).toHaveLength(2);
    expect(joins[1]).not.toBe(first);
    expect(h.debug().joined).toContain('t:c1');
    expect(h.status()).toBe('online');
  });

  it('ignores late callbacks from a channel it already replaced', async () => {
    const t = new FakeTransport();
    const h = new Hub(env('A', t, null, null));
    h.setIdentity('u1');
    h.start();
    h.setTopics(['u:u1']);
    await settle();
    const old = t.live('u:u1')!;
    old.status('CLOSED');
    await vi.advanceTimersByTimeAsync(1_100);
    const got: ServerEvent[] = [];
    h.onEvent((e) => got.push(e));
    old.emit('msg.new', msgNew('stale'));
    old.status('SUBSCRIBED');
    t.live('u:u1')!.emit('msg.new', msgNew('fresh'));
    await settle();
    expect(got.map((e) => (e.payload as { eid: string }).eid)).toEqual(['fresh']);
  });
});
