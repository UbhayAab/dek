// The one Supabase client. Database calls go to schema `api` only (CONTRACT); the
// realtime socket and storage come from the same client so they share the session.
import { createClient, type SupportedStorage } from '@supabase/supabase-js';
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

function makeClient() {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    db: { schema: 'api' },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: AUTH_STORAGE_KEY,
      ...(customStorage ? { storage: customStorage } : {}),
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
