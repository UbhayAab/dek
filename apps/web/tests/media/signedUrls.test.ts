import { describe, expect, test } from 'vitest';
import {
  BATCH_DELAY_MS, FAILURE_BACKOFF_MS, REFRESH_MARGIN_MS, SignedUrlCache, URL_TTL_S, downloadUrl, lifetimeMs, parseMediaSign,
  type MintResult,
} from '../../src/features/media/signedUrls';

// A clock and a scheduler the test drives by hand.
function harness(mintImpl?: (paths: string[]) => Promise<MintResult[]>) {
  let now = 1_000_000;
  const queue: { at: number; fn: () => void }[] = [];
  const mints: string[][] = [];
  let n = 0;
  const cache = new SignedUrlCache({
    now: () => now,
    schedule: (fn, ms) => { queue.push({ at: now + ms, fn }); },
    mint: async (paths) => {
      mints.push(paths);
      if (mintImpl) return mintImpl(paths);
      n += 1;
      return paths.map((path) => ({ path, url: `https://x.supabase.co/storage/v1/object/sign/media/${path}?token=t${n}`, error: null }));
    },
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const job of queue.splice(0).filter((j) => j.at <= now)) job.fn();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return { cache, mints, advance, setNow: (t: number) => { now = t; }, get now() { return now; } };
}

describe('signed URL cache (DEK11)', () => {
  test('everything requested in one render sweep is minted in one batch', async () => {
    const h = harness();
    h.cache.request(['org/c/a/1.jpg', 'org/c/a/thumb.webp']);
    h.cache.request(['org/c/b/2.png']);
    h.cache.request(['org/c/a/1.jpg']);   // asked twice, minted once
    expect(h.mints).toHaveLength(0);
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toEqual([['org/c/a/1.jpg', 'org/c/a/thumb.webp', 'org/c/b/2.png']]);
    expect(h.cache.peek('org/c/b/2.png')).toMatch(/\/object\/sign\/media\/org\/c\/b\/2\.png\?token=t1$/);
  });

  test('a cached path never creates a request (the legacy promise-before-cache mistake)', async () => {
    const h = harness();
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toHaveLength(1);
    expect(h.cache.request(['p/1.jpg'])).toBe(true);
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toHaveLength(1);
  });

  test('a path asked for while its mint is in flight is not minted twice', async () => {
    let release!: () => void;
    const h = harness((paths) => new Promise((res) => {
      release = () => res(paths.map((path) => ({ path, url: `u:${path}`, error: null })));
    }));
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toHaveLength(1);
    release();
    await h.advance(0);
    expect(h.cache.peek('p/1.jpg')).toBe('u:p/1.jpg');
  });

  test('URLs are reused until a minute before their 15 minutes run out, then minted again', async () => {
    const h = harness();
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    const first = h.cache.peek('p/1.jpg');
    expect(first).toBeTruthy();
    await h.advance(URL_TTL_S * 1000 - REFRESH_MARGIN_MS - BATCH_DELAY_MS - 1000);
    expect(h.cache.peek('p/1.jpg')).toBe(first);
    await h.advance(2000);
    expect(h.cache.peek('p/1.jpg')).toBeNull();
    // A loaded <img> keeps the URL it has: current() still answers.
    expect(h.cache.current('p/1.jpg')).toBe(first);
    expect(h.cache.hasStale(['p/1.jpg'])).toBe(true);
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toHaveLength(2);
    expect(h.cache.peek('p/1.jpg')).not.toBe(first);
  });

  test('a media error re-mints, but only for the URL that failed', async () => {
    const h = harness();
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    const first = h.cache.peek('p/1.jpg');
    h.cache.invalidate('p/1.jpg', 'https://some/older/url');   // a stale element: nothing to do
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toHaveLength(1);
    h.cache.invalidate('p/1.jpg', first);
    expect(h.cache.peek('p/1.jpg')).toBeNull();
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toHaveLength(2);
    expect(h.cache.peek('p/1.jpg')).not.toBe(first);
  });

  test('a path Storage refuses (no longer readable) is not asked for again for a while', async () => {
    const h = harness(async (paths) => paths.map((path) => ({ path, url: null, error: 'Object not found' })));
    h.cache.request(['gone/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(h.cache.failed('gone/1.jpg')).toBe(true);
    h.cache.request(['gone/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toHaveLength(1);
    await h.advance(FAILURE_BACKOFF_MS);
    h.cache.request(['gone/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints).toHaveLength(2);
  });

  test('a network failure marks the batch failed instead of throwing at the screen', async () => {
    const h = harness(async () => { throw new Error('offline'); });
    h.cache.request(['p/1.jpg', 'p/2.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(h.cache.failed('p/1.jpg')).toBe(true);
    expect(h.cache.peek('p/2.jpg')).toBeNull();
  });

  test('more than 100 paths go in chunks of 100', async () => {
    const h = harness();
    h.cache.request(Array.from({ length: 230 }, (_, i) => `p/${i}.jpg`));
    await h.advance(BATCH_DELAY_MS);
    expect(h.mints.map((m) => m.length)).toEqual([100, 100, 30]);
  });

  test('sign-out wipes the cache, and a mint that was in flight cannot refill it', async () => {
    let release!: () => void;
    const h = harness((paths) => new Promise((res) => {
      release = () => res(paths.map((path) => ({ path, url: `u:${path}`, error: null })));
    }));
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    h.cache.clear();
    release();
    await h.advance(0);
    expect(h.cache.peek('p/1.jpg')).toBeNull();
    expect(h.cache.current('p/1.jpg')).toBeNull();
  });

  test('listeners hear about new URLs', async () => {
    const h = harness();
    let calls = 0;
    const off = h.cache.subscribe(() => { calls += 1; });
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(calls).toBe(1);
    off();
  });

  test('a shorter lifetime from the server is honoured: refreshed a minute before its end', async () => {
    const h = harness(async (paths) => paths.map((path) => ({ path, url: `u:${path}`, error: null, expiresAt: h.now + 300_000 })));
    h.cache.request(['p/1.jpg']);
    await h.advance(BATCH_DELAY_MS);
    expect(h.cache.peek('p/1.jpg')).toBe('u:p/1.jpg');
    await h.advance(300_000 - REFRESH_MARGIN_MS - BATCH_DELAY_MS + 1000);
    expect(h.cache.peek('p/1.jpg')).toBeNull();
  });

  test('download links ask Storage for an attachment under the original name', () => {
    expect(downloadUrl('https://x/sign/media/a.pdf?token=abc', 'Q3 report (final).pdf'))
      .toBe('https://x/sign/media/a.pdf?token=abc&download=Q3%20report%20(final).pdf');
  });
});

describe('media-sign answers', () => {
  const T = 5_000_000;

  test('the server lifetime is used, never past 15 minutes, and a wrong device clock falls back to 15 minutes', () => {
    expect(lifetimeMs(T + 900_000, T)).toBe(900_000);
    expect(lifetimeMs(T + 300_000, T)).toBe(300_000);
    expect(lifetimeMs(T + 5 * 3600_000, T)).toBe(900_000);   // device clock far behind
    expect(lifetimeMs(T - 20 * 60_000, T)).toBe(900_000);     // device clock far ahead
    expect(lifetimeMs(null, T)).toBe(900_000);
  });

  test('paths left out are not available; only https links are believed', () => {
    const at = '2026-10-04T10:15:00.000Z';
    const r = parseMediaSign(['a/1.jpg', 'b/2.pdf', 'c/3.png'], {
      urls: { 'a/1.jpg': 'https://x.supabase.co/storage/v1/object/sign/media/a/1.jpg?token=t', 'c/3.png': 'javascript:alert(1)' },
      expires_at: at,
    });
    expect(r[0]).toEqual({ path: 'a/1.jpg', url: 'https://x.supabase.co/storage/v1/object/sign/media/a/1.jpg?token=t', error: null, expiresAt: Date.parse(at) });
    expect(r[1]).toEqual({ path: 'b/2.pdf', url: null, error: 'not_available' });
    expect(r[2]?.url).toBeNull();
    expect(parseMediaSign(['a'], { urls: {}, expires_at: null })[0]?.url).toBeNull();
    expect(parseMediaSign(['a'], null)[0]?.url).toBeNull();
  });
});
