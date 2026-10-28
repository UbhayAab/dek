// Read receipts go out once per window even while new messages keep being read (the
// old resetting debounce never fired in a busy channel).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadTracker, READ_DEBOUNCE_MS } from '../../src/sync/read';

describe('ReadTracker window', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function tracker() {
    const sent: number[] = [];
    let server = 0;
    const t = new ReadTracker<number>({
      send: async (_k, seq) => { sent.push(seq); return seq; },
      confirmed: (_k, r) => r,
      currentRead: () => server,
      applyLocal: () => undefined,
      applyServer: (_k, s) => { server = s; },
    });
    return { t, sent };
  }

  it('sends once per window while marks keep arriving, with the latest position', async () => {
    const { t, sent } = tracker();
    for (let seq = 1; seq <= 12; seq += 1) {
      t.mark('c1', seq);
      await vi.advanceTimersByTimeAsync(1_000);   // a new message read every second
    }
    // 12 s of continuous reading with a 5 s window: two sends, never zero
    expect(READ_DEBOUNCE_MS).toBe(5_000);
    expect(sent.length).toBe(2);
    expect(sent[0]).toBe(5);
    expect(sent[1]).toBe(10);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent.at(-1)).toBe(12);
  });

  it('a single mark goes out after one window', async () => {
    const { t, sent } = tracker();
    t.mark('c1', 7);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([7]);
  });
});
