// Signed URLs for private media (DEK11). The media-sign function mints them (15
// minutes, a lifetime the server decides) after checking, per path, that the
// person may read the channel, so a removed member gets nothing new the moment
// their membership goes. The only caller is sign.ts. Rules (LESSONS, Media):
//   - one batched request per render sweep (at most 100 paths), never one per file;
//   - cached by path until a minute before expiry;
//   - the cache is consulted BEFORE any request is created: a request promise is
//     only made for paths that are missing (creating a promise sends the request);
//   - refreshed when a media element reports an error;
//   - never a public URL, and wiped when the person signs out.
// The minter is injectable so the cache logic is unit tested without a network.

// media-sign links live 20 minutes and are shared by everyone who may open the
// file while they have at least 10 minutes left (migration 0913): expires_at is
// never sooner than that.
export const URL_TTL_S = 1200;
export const GUARANTEED_LEFT_S = 600;
export const REFRESH_MARGIN_MS = 60_000;
export const BATCH_DELAY_MS = 12;
export const BATCH_MAX = 100;
// After a path failed to mint, wait before asking again (a revoked member's
// screen must not hammer the server).
export const FAILURE_BACKOFF_MS = 30_000;
// A server lifetime shorter than this, measured on this device's clock, means the
// clock is wrong rather than the link short-lived: the known lifetime is used.
const MIN_PLAUSIBLE_LIFETIME_MS = 2 * REFRESH_MARGIN_MS;

export interface MintResult {
  path: string;
  url: string | null;
  error: string | null;
  // When the server said the link stops working (epoch ms, its clock).
  expiresAt?: number | null;
}

export type Minter = (paths: string[], expiresIn: number) => Promise<MintResult[]>;

interface Entry {
  url: string;
  exp: number;   // epoch ms when Storage stops honouring the URL
}

export interface SignedUrlCacheOptions {
  mint: Minter;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
}

export class SignedUrlCache {
  private readonly cache = new Map<string, Entry>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly queue = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private scheduled = false;
  private generation = 0;
  private version = 0;
  private readonly mint: Minter;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;

  constructor(opts: SignedUrlCacheOptions) {
    this.mint = opts.mint;
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  // A URL that is still good for at least the refresh margin, or null.
  peek(path: string): string | null {
    const e = this.cache.get(path);
    if (!e) return null;
    return e.exp - REFRESH_MARGIN_MS > this.now() ? e.url : null;
  }

  // The last URL minted for a path even if it is near its end: an <img> that has
  // loaded keeps working, and swapping its src would download it again.
  current(path: string): string | null {
    return this.cache.get(path)?.url ?? null;
  }

  // True when some cached URL has entered its refresh margin (a link on screen
  // should be re-minted before someone taps it).
  hasStale(paths: Iterable<string>): boolean {
    for (const p of paths) {
      const e = this.cache.get(p);
      if (e && e.exp - REFRESH_MARGIN_MS <= this.now()) return true;
    }
    return false;
  }

  failed(path: string): boolean {
    const at = this.failedAt.get(path);
    return at !== undefined && this.now() - at < FAILURE_BACKOFF_MS;
  }

  // Ask for paths. Cached and in-flight paths cost nothing; the rest join the
  // next batch. Returns true when every path is already usable.
  request(paths: Iterable<string | null | undefined>): boolean {
    let ready = true;
    for (const p of paths) {
      if (!p) continue;
      if (this.peek(p)) continue;
      ready = false;
      if (this.inflight.has(p) || this.queue.has(p) || this.failed(p)) continue;
      this.queue.add(p);
    }
    if (this.queue.size && !this.scheduled) {
      this.scheduled = true;
      this.schedule(() => { void this.flush(); }, BATCH_DELAY_MS);
    }
    return ready;
  }

  // A media element failed with this URL: forget it and mint a fresh one, unless
  // the failing URL is already not the cached one (a refresh is under way).
  invalidate(path: string, failedUrl?: string | null): void {
    const e = this.cache.get(path);
    if (e && failedUrl && e.url !== failedUrl) return;
    this.cache.delete(path);
    this.failedAt.delete(path);
    this.request([path]);
    this.bump();
  }

  // Sign-out: nothing a previous person could read survives.
  clear(): void {
    this.generation += 1;
    this.cache.clear();
    this.failedAt.clear();
    this.queue.clear();
    this.inflight.clear();
    this.bump();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  getVersion(): number {
    return this.version;
  }

  private bump(): void {
    this.version += 1;
    for (const l of [...this.listeners]) l();
  }

  async flush(): Promise<void> {
    this.scheduled = false;
    if (!this.queue.size) return;
    const paths = [...this.queue];
    this.queue.clear();
    for (const p of paths) this.inflight.add(p);
    const gen = this.generation;
    const started = this.now();
    const chunks: string[][] = [];
    for (let i = 0; i < paths.length; i += BATCH_MAX) chunks.push(paths.slice(i, i + BATCH_MAX));
    await Promise.all(chunks.map(async (chunk) => {
      let results: MintResult[] = [];
      try {
        results = await this.mint(chunk, URL_TTL_S);
      } catch {
        results = chunk.map((path) => ({ path, url: null, error: 'network' }));
      }
      if (gen !== this.generation) return;
      const seen = new Set<string>();
      for (const r of results) {
        if (!r.path) continue;
        seen.add(r.path);
        if (r.url) {
          // Measured from before the request: never trust a URL past its life.
          this.cache.set(r.path, { url: r.url, exp: started + lifetimeMs(r.expiresAt, started) });
          this.failedAt.delete(r.path);
        } else {
          this.failedAt.set(r.path, this.now());
        }
      }
      for (const p of chunk) if (!seen.has(p)) this.failedAt.set(p, this.now());
    }));
    if (gen !== this.generation) return;
    for (const p of paths) this.inflight.delete(p);
    this.bump();
  }
}

// How long a link minted at `started` may be used: the server's expires_at, never
// past the 20 minutes a link lives. Without a usable expires_at (none sent, or
// this device's clock far off from the server's: a phone set to the wrong time
// would otherwise see every link as expired, or keep one past its end), only the
// guaranteed 10 minutes are safe, since a shared link may have no more than that.
export function lifetimeMs(expiresAt: number | null | undefined, started: number): number {
  const max = URL_TTL_S * 1000;
  const safe = GUARANTEED_LEFT_S * 1000;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return safe;
  const told = expiresAt - started;
  if (told < MIN_PLAUSIBLE_LIFETIME_MS || told > max + MIN_PLAUSIBLE_LIFETIME_MS) return safe;
  return Math.min(max, told);
}

// media-sign's answer: { urls: { [path]: signedUrl }, expires_at }. A path it
// left out may not be opened by this person (or is not ready): no URL for it.
export function parseMediaSign(paths: string[], data: unknown): MintResult[] {
  const o = (data && typeof data === 'object' ? data : {}) as { urls?: unknown; expires_at?: unknown };
  const urls = (o.urls && typeof o.urls === 'object' ? o.urls : {}) as Record<string, unknown>;
  const exp = typeof o.expires_at === 'string' ? Date.parse(o.expires_at) : Number.NaN;
  return paths.map((path) => {
    const url = urls[path];
    return typeof url === 'string' && /^https:\/\//.test(url)
      ? { path, url, error: null, expiresAt: Number.isFinite(exp) ? exp : null }
      : { path, url: null, error: 'not_available' };
  });
}

// Download links: Storage serves the file as an attachment under this name when
// the signed URL carries `download`.
export function downloadUrl(signedUrl: string, fileName: string): string {
  return `${signedUrl}${signedUrl.includes('?') ? '&' : '?'}download=${encodeURIComponent(fileName)}`;
}
