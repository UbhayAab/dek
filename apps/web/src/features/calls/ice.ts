// ICE servers for a call, from the `turn` Edge Function (CONTRACT 5): Cloudflare
// TURN credentials when the key is configured (relay: true), STUN only otherwise
// (relay: false). Fetched when a call starts and cached for at most an hour (and
// never past the credentials' own lifetime): LESSONS, Calls: never cache them
// forever, and await the token (legacy sent "Bearer [object Promise]" and every
// call was STUN only).

export const ICE_CACHE_MAX_MS = 60 * 60 * 1000;
const FALLBACK_CACHE_MS = 5 * 60 * 1000;
const CREDENTIAL_MARGIN_MS = 5 * 60 * 1000;

export const STUN_FALLBACK: RTCIceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['stun:stun.l.google.com:19302'] },
];

export interface IceInfo {
  iceServers: RTCIceServer[];
  relay: boolean;
  // false when the function could not be reached and STUN is a guess.
  fromServer: boolean;
  fetchedAt: number;
  expiresAt: number;
}

const urlsOf = (s: RTCIceServer): string[] => (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u): u is string => typeof u === 'string');

export function hasTurn(servers: RTCIceServer[]): boolean {
  return servers.some((s) => urlsOf(s).some((u) => /^turns?:/i.test(u)));
}

function asServer(v: unknown): RTCIceServer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const urls = Array.isArray(o.urls) ? o.urls.filter((u) => typeof u === 'string') as string[] : typeof o.urls === 'string' ? [o.urls] : [];
  if (!urls.length) return null;
  const s: RTCIceServer = { urls };
  if (typeof o.username === 'string') s.username = o.username;
  if (typeof o.credential === 'string') s.credential = o.credential;
  return s;
}

// The function's answer, whichever shape: { iceServers: [...] | {...}, relay, ttl
// | expires_at }. Cloudflare's own API answers with an object or an array.
export function parseIce(data: unknown, now: number): IceInfo | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const raw = o.iceServers ?? o.ice_servers;
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(asServer).filter((s): s is RTCIceServer => !!s);
  if (!list.length) return null;
  const relay = typeof o.relay === 'boolean' ? o.relay && hasTurn(list) : hasTurn(list);
  let expiresAt = now + ICE_CACHE_MAX_MS;
  const ttl = typeof o.ttl === 'number' ? o.ttl : typeof o.ttl_seconds === 'number' ? o.ttl_seconds : null;
  if (ttl && ttl > 0) expiresAt = Math.min(expiresAt, now + ttl * 1000 - CREDENTIAL_MARGIN_MS);
  const exp = typeof o.expires_at === 'string' ? Date.parse(o.expires_at) : Number.NaN;
  if (Number.isFinite(exp)) expiresAt = Math.min(expiresAt, exp - CREDENTIAL_MARGIN_MS);
  if (expiresAt <= now) expiresAt = now + 60_000;
  return { iceServers: list, relay, fromServer: true, fetchedAt: now, expiresAt };
}

export type IceFetcher = () => Promise<unknown>;

export class IceProvider {
  private cached: IceInfo | null = null;
  private inflight: Promise<IceInfo> | null = null;

  constructor(private readonly fetcher: IceFetcher, private readonly now: () => number = () => Date.now()) {}

  peek(): IceInfo | null {
    return this.cached && this.cached.expiresAt > this.now() ? this.cached : null;
  }

  async get(force = false): Promise<IceInfo> {
    const hit = force ? null : this.peek();
    if (hit) return hit;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const at = this.now();
      let info: IceInfo | null = null;
      try {
        info = parseIce(await this.fetcher(), at);
      } catch {
        info = null;
      }
      const result = info ?? {
        iceServers: STUN_FALLBACK, relay: false, fromServer: false, fetchedAt: at, expiresAt: at + FALLBACK_CACHE_MS,
      };
      this.cached = result;
      return result;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  clear(): void {
    this.cached = null;
  }
}
