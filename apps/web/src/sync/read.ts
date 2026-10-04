// Read state (DEK07, DEKA10). markRead is local at once (badges clear), sent to the
// server debounced 1.5 s, and monotonic: a seq at or below what is already read or
// already asked for is ignored. The server's `read` event (from this tab, another
// tab or the phone) is authoritative, except that a local read the server has not
// confirmed yet is never undone by an older event (the "floor").
import { api } from '../api/rpc';
import { toDekError } from '../api/errors';
import { backoffDelay, type BackoffOptions } from '../lib/backoff';
import { getState, setState } from '../store/state';
import { applyRead, applyThreadRead } from './reducers';

// At most one mark_read per conversation per 5 s window (it was the most frequent call
// in the capacity audit); badges on this device clear at once, other devices within 5 s.
export const READ_DEBOUNCE_MS = 5_000;
// A read that could not reach the server is retried 5 s doubling to 2 min, plus
// jitter; a newer markRead replaces it, a success resets the schedule.
export const READ_RETRY: BackoffOptions = { baseMs: 5_000, maxMs: 120_000, jitterRatio: 0.25, minJitterMs: 500 };

type Timer = ReturnType<typeof setTimeout>;

export interface ReadDeps<R> {
  send(key: string, seq: number): Promise<R>;
  confirmed(key: string, result: R): number;
  currentRead(key: string): number;
  applyLocal(key: string, seq: number): void;
  applyServer(key: string, serverSeq: number): void;
  debounceMs?: number;
  random?: () => number;
}

export class ReadTracker<R> {
  private readonly want = new Map<string, number>();
  private readonly inflight = new Map<string, number>();
  private readonly timers = new Map<string, Timer>();
  private readonly failures = new Map<string, number>();
  private gen = 0;

  constructor(private readonly deps: ReadDeps<R>) {}

  // The highest read position this tab asked for that the server has not confirmed.
  floor(key: string): number {
    return Math.max(this.want.get(key) ?? 0, this.inflight.get(key) ?? 0);
  }

  mark(key: string, seq: number): boolean {
    if (!Number.isFinite(seq) || seq <= 0) return false;
    const known = Math.max(this.deps.currentRead(key), this.floor(key));
    if (seq <= known) return false;
    this.want.set(key, seq);
    this.deps.applyLocal(key, seq);
    this.schedule(key, this.deps.debounceMs ?? READ_DEBOUNCE_MS);
    return true;
  }

  // A window, not a resetting debounce: the first mark starts the timer and later marks
  // only move the position, so a reader in a busy channel still reaches the server once
  // per window (a debounce that reset on every new message never fired while messages
  // kept arriving).
  private schedule(key: string, delay: number): void {
    if (this.timers.has(key)) return;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.flush(key);
    }, delay));
  }

  async flush(key: string): Promise<void> {
    const seq = this.want.get(key);
    if (seq === undefined) return;
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.want.delete(key);
    this.inflight.set(key, Math.max(this.inflight.get(key) ?? 0, seq));
    const gen = this.gen;
    try {
      const result = await this.deps.send(key, seq);
      if (gen !== this.gen) return;
      if ((this.inflight.get(key) ?? 0) <= seq) this.inflight.delete(key);
      this.failures.delete(key);
      this.deps.applyServer(key, this.deps.confirmed(key, result));
    } catch (e) {
      if (gen !== this.gen) return;
      if ((this.inflight.get(key) ?? 0) <= seq) this.inflight.delete(key);
      if (toDekError(e).retryable) {
        // Keep the read and try again later; a newer markRead replaces it.
        this.want.set(key, Math.max(this.want.get(key) ?? 0, seq));
        const n = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, n);
        this.schedule(key, backoffDelay(n, { ...READ_RETRY, random: this.deps.random ?? Math.random }));
      } else {
        this.failures.delete(key);   // a real refusal (no access): nothing to retry
      }
    }
  }

  flushAll(): void {
    for (const key of Array.from(this.want.keys())) void this.flush(key);
  }

  // Forget local intent for one key (the person chose "mark unread").
  forget(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.want.delete(key);
    this.inflight.delete(key);
    this.failures.delete(key);
  }

  stop(): void {
    this.gen += 1;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.want.clear();
    this.inflight.clear();
    this.failures.clear();
  }
}

// ---------------------------------------------------------------- wiring

let refreshHook: (() => void) | null = null;
export function setCounterRefreshHook(fn: () => void): void {
  refreshHook = fn;
}

function me(): string | null {
  return getState().session.userId;
}

export const channelReads = new ReadTracker<{ channel_id: string; last_read_seq: number }>({
  send: (channelId, seq) => api.markRead(channelId, seq),
  confirmed: (_k, r) => r.last_read_seq,
  currentRead: (channelId) => getState().channels[channelId]?.last_read_seq ?? 0,
  applyLocal: (channelId, seq) => {
    const s = getState();
    const r = applyRead(s, channelId, s.channels[channelId]?.last_read_seq ?? 0, seq, me());
    if (r.patch) setState(r.patch);
  },
  applyServer: (channelId, serverSeq) => applyChannelRead(channelId, serverSeq),
});

export const threadReads = new ReadTracker<{ root_id: string; last_read_reply_seq: number }>({
  send: (rootId, seq) => api.markThreadRead(rootId, seq),
  confirmed: (_k, r) => r.last_read_reply_seq,
  currentRead: (rootId) => getState().threads[rootId]?.lastReadReplySeq ?? 0,
  applyLocal: (rootId, seq) => {
    const patch = applyThreadRead(getState(), rootId, getState().threads[rootId]?.lastReadReplySeq ?? 0, seq);
    if (patch) setState(patch);
  },
  applyServer: (rootId, serverSeq) => applyThreadReadEvent(rootId, serverSeq),
});

// A read position from the server (RPC result or the realtime `read` event).
export function applyChannelRead(channelId: string, serverSeq: number): void {
  const r = applyRead(getState(), channelId, serverSeq, channelReads.floor(channelId), me());
  if (r.patch) setState(r.patch);
  if (r.needsRefresh) refreshHook?.();
}

export function applyThreadReadEvent(rootId: string, serverSeq: number): void {
  const patch = applyThreadRead(getState(), rootId, serverSeq, threadReads.floor(rootId));
  if (patch) setState(patch);
}

function highestKnownSeq(channelId: string): number {
  const s = getState();
  let max = s.channels[channelId]?.last_seq ?? 0;
  const tl = s.timelines[channelId];
  if (tl && tl.ids.length > 0) {
    const last = s.messages[tl.ids[tl.ids.length - 1]!];
    if (last) max = Math.max(max, last.seq);
  }
  return Math.max(max, tl?.lastSeq ?? 0);
}

export function markRead(channelId: string, seq?: number): void {
  const target = seq ?? highestKnownSeq(channelId);
  channelReads.mark(channelId, target);
}

export async function markUnread(channelId: string, seq: number): Promise<void> {
  channelReads.forget(channelId);
  const r = await api.markUnread(channelId, seq);
  applyChannelRead(channelId, r.last_read_seq);
}

export function markThreadRead(rootId: string): void {
  const s = getState();
  const tv = s.threads[rootId];
  if (!tv) return;
  let max = 0;
  for (const id of tv.replyIds) max = Math.max(max, s.messages[id]?.seq ?? 0);
  if (max > 0) threadReads.mark(rootId, max);
}

export function flushReads(): void {
  channelReads.flushAll();
  threadReads.flushAll();
}

export function resetReads(): void {
  channelReads.stop();
  threadReads.stop();
}
