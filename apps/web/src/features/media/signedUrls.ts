// Signed URLs for private media (DEK11). Storage mints them only after its select
// policy runs dek.can_read_object(path), so a removed member gets nothing new the
// moment their membership goes. Rules (LESSONS, Media):
//   - one batched createSignedUrls call per render sweep, never one per file;
//   - cached by path until a minute before expiry (15 minute URLs);
//   - the cache is consulted BEFORE any request is created: a request promise is
//     only made for paths that are missing (creating a promise sends the request);
//   - refreshed when a media element reports an error;
//   - never a public URL, and wiped when the person signs out.
// The minter is injectable so the cache logic is unit tested without a network.

export const URL_TTL_S = 900;
export const REFRESH_MARGIN_MS = 60_000;
export const BATCH_DELAY_MS = 12;
export const BATCH_MAX = 100;
// After a path failed to mint, wait before asking again (a revoked member's
// screen must not hammer Storage).
export const FAILURE_BACKOFF_MS = 30_000;

export interface MintResult {
  path: string;
  url: string | null;
  error: string | null;
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
          this.cache.set(r.path, { url: r.url, exp: started + URL_TTL_S * 1000 });
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

// Storage's answer for each path. A URL is only ever what Storage signed.
export function supabaseMinter(getClient: () => { storage: { from(bucket: string): { createSignedUrls(paths: string[], expiresIn: number): Promise<{ data: { path: string | null; signedUrl: string | null; error: string | null }[] | null; error: unknown }> } } }): Minter {
  return async (paths, expiresIn) => {
    const { data, error } = await getClient().storage.from('media').createSignedUrls(paths, expiresIn);
    if (error || !data) throw new Error('mint failed');
    return data.map((d, i) => ({ path: d.path ?? paths[i] ?? '', url: d.error ? null : d.signedUrl, error: d.error }));
  };
}

// Download links: Storage serves the file as an attachment under this name when
// the signed URL carries `download`.
export function downloadUrl(signedUrl: string, fileName: string): string {
  return `${signedUrl}${signedUrl.includes('?') ? '&' : '?'}download=${encodeURIComponent(fileName)}`;
}
