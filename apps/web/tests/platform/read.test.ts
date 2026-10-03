// markRead: debounced 1.5 s, monotonic, local at once, floor while unconfirmed,
// retried after a network failure, forgotten on mark unread (DEKA10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DekError } from '../../src/api/errors';
import { READ_DEBOUNCE_MS, ReadTracker } from '../../src/sync/read';

function tracker(sendImpl?: (key: string, seq: number) => Promise<number>) {
  const server = new Map<string, number>();
  const local = new Map<string, number>();
  const sent: [string, number][] = [];
  const t = new ReadTracker<number>({
    send: vi.fn(async (key: string, seq: number) => {
      sent.push([key, seq]);
      if (sendImpl) return sendImpl(key, seq);
      const v = Math.max(server.get(key) ?? 0, seq);
      server.set(key, v);
      return v;
    }),
    confirmed: (_k, r) => r,
    currentRead: (key) => local.get(key) ?? 0,
    applyLocal: (key, seq) => { local.set(key, seq); },
    applyServer: (key, seq) => { local.set(key, Math.max(seq, t.floor(key))); },
    random: () => 0,
  });
  return { t, sent, local, server };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('markRead', () => {
  it('applies locally at once and sends once, debounced 1.5 s, with the highest seq', async () => {
    const { t, sent, local } = tracker();
    t.mark('c1', 5);
    expect(local.get('c1')).toBe(5);
    t.mark('c1', 7);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([['c1', 7]]);
  });

  it('is monotonic: an older or equal seq is ignored', async () => {
    const { t, sent } = tracker();
    expect(t.mark('c1', 7)).toBe(true);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
    expect(t.mark('c1', 7)).toBe(false);
    expect(t.mark('c1', 3)).toBe(false);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS * 2);
    expect(sent).toEqual([['c1', 7]]);
  });

  it('keeps a floor while a read is unconfirmed', async () => {
    let release!: (v: number) => void;
    const { t } = tracker(() => new Promise<number>((r) => { release = r; }));
    t.mark('c1', 9);
    expect(t.floor('c1')).toBe(9);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
    expect(t.floor('c1')).toBe(9);          // in flight
    release(9);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.floor('c1')).toBe(0);          // confirmed: the server value rules again
  });

  it('backs off between failed sends: 5 s, 10 s, 20 s ...', async () => {
    const at: number[] = [];
    const { t } = tracker(async () => { at.push(Date.now()); throw new DekError('network'); });
    t.mark('c1', 4);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000);
    const gaps = at.slice(1).map((x, i) => x - at[i]!);
    expect(gaps).toEqual([5_000, 10_000, 20_000]);
  });

  it('retries after a network failure and gives up on a real refusal', async () => {
    let fail: DekError | null = new DekError('network');
    const { t, sent } = tracker(async (_k, seq) => {
      if (fail) throw fail;
      return seq;
    });
    t.mark('c1', 4);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
    fail = null;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([['c1', 4], ['c1', 4]]);
    fail = new DekError('not_found');
    t.mark('c2', 2);
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS + 10_000);
    expect(sent.filter(([k]) => k === 'c2')).toHaveLength(1);
  });

  it('forget() drops unsent intent (mark unread from here)', async () => {
    const { t, sent } = tracker();
    t.mark('c1', 6);
    t.forget('c1');
    await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS * 2);
    expect(sent).toEqual([]);
    expect(t.floor('c1')).toBe(0);
  });

  it('flushAll sends now (page hiding)', async () => {
    const { t, sent } = tracker();
    t.mark('c1', 3);
    t.mark('c2', 8);
    t.flushAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.sort()).toEqual([['c1', 3], ['c2', 8]]);
  });
});
