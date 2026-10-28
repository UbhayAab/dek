// The one Supabase client. Database calls go to schema `api` only (CONTRACT); the
// realtime socket and storage come from the same client so they share the session.
import { createClient, type Session, type SupportedStorage } from '@supabase/supabase-js';
import { config } from '../config';
import { toDekError } from './errors';

let customStorage: SupportedStorage | undefined;

export const AUTH_STORAGE_KEY = 'dek.auth';

// Native shells (Capacitor) call this before first use to keep the session in
// secure storage instead of localStorage.
export function setAuthStorage(storage: SupportedStorage): void {
  if (client) throw new Error('setAuthStorage must run before the client is created');
  customStorage = storage;
}

// /auth/v1/token is limited per network address (a burst of 30, then 15 a second), so an
// office behind one NAT can hit it after an outage. auth-js treats a 429 on a refresh as
// final and, once the access token has expired, signs the person out. A rate limit is
// not a dead session: report it as a 503, which auth-js keeps the session for and retries.
const authAwareFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status !== 429) return res;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/auth/v1/token') || !url.includes('grant_type=refresh_token')) return res;
  return new Response(await res.text(), { status: 503, statusText: 'Rate limited', headers: res.headers });
};

// Google uses a separate PKCE-only exchange client. It cannot write an app
// session until the callback has checked the existing account.
export function googleStorage(): SupportedStorage {
  return customStorage ?? window.sessionStorage;
}

let googleUser: string | null = null;
let googleValid: (() => boolean) | null = null;
function guardedStorage(): SupportedStorage {
  let storage = customStorage;
  if (!storage) {
    try { storage = window.localStorage; } catch { /* blocked browser storage */ }
  }
  // Preserve the SDK's memory-only recovery on browsers that disable storage.
  if (!storage) {
    const memory = new Map<string, string>();
    storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: (k) => { memory.delete(k); } };
  }
  const backing = storage;
  const check = (key: string, raw: string | null) => {
    if (key !== AUTH_STORAGE_KEY || !googleUser || !raw) return;
    let uid: unknown;
    try { uid = (JSON.parse(raw) as { user?: { id?: unknown } }).user?.id; }
    catch { throw new Error('Cannot replace an unreadable saved account.'); }
    if (uid !== googleUser) throw new Error('The active account changed. Sign out before trying Google again.');
  };
  return {
    getItem: (key) => backing.getItem(key),
    removeItem: (key) => backing.removeItem(key),
    setItem(key, value) {
      if (key === AUTH_STORAGE_KEY && googleValid && !googleValid()) throw new Error('Google sign-in was cancelled.');
      // Check at the actual storage commit, including a sign-in in another tab
      // while the exchange was in flight. No await gap for browser storage.
      const raw = backing.getItem(key);
      if (raw instanceof Promise) return raw.then((v) => {
        if (key === AUTH_STORAGE_KEY && googleValid && !googleValid()) throw new Error('Google sign-in was cancelled.');
        check(key, v); return backing.setItem(key, value);
      });
      check(key, raw);
      return backing.setItem(key, value);
    },
  };
}

export async function acceptGoogleSession(session: Session, valid: () => boolean): Promise<void> {
  const auth = supabase().auth;
  const existing = await auth.getSession();
  if (existing.error) throw existing.error;
  if (!valid()) throw new Error('Google sign-in was cancelled.');
  if (existing.data.session) {
    if (existing.data.session.user.id === session.user.id) return;
    throw new Error('The active account changed.');
  }
  googleUser = session.user.id;
  googleValid = valid;
  try {
    const result = await auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (result.error || result.data.session?.user.id !== session.user.id) throw new Error('Google sign-in did not finish.');
  } finally { googleUser = null; googleValid = null; }
}

function makeClient() {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    db: { schema: 'api' },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: AUTH_STORAGE_KEY,
      storage: guardedStorage(),
    },
    realtime: { heartbeatIntervalMs: 25_000 },
    global: { headers: { 'x-dek-build': config.buildId }, fetch: authAwareFetch },
  });
}

export type DekClient = ReturnType<typeof makeClient>;
let client: DekClient | null = null;

export function supabase(): DekClient {
  if (!client) client = makeClient();
  return client;
}

export interface RpcOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Every database call. 15 s default timeout (the server caps statements at 8 s),
// errors normalised to DekError with the contract's machine code.
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}, opts: RpcOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const { data, error, status } = await supabase().rpc(fn, args).abortSignal(ctrl.signal);
    if (error) throw toDekError(error, status);
    return data as T;
  } catch (e) {
    throw toDekError(e);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
