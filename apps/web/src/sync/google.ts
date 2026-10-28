// Google identity only. Gmail grants belong to Mailer, never this sign-in.
import { createClient, type Session, type SupportedStorage } from '@supabase/supabase-js';
import { acceptGoogleSession, googleStorage, supabase } from '../api/client';
import { config } from '../config';
import { navigate, parse } from '../app/router';
import { callNative, hasPlugin, isNativeApp, listenNative } from '../native/bridge';

const INTENT_KEY = 'dek.google.intent';
const OAUTH_KEY = 'dek.google.pkce';
const MAX_AGE = 10 * 60_000;
const CALLBACK = '/auth/google';
const RETRY = 'Google sign-in could not finish. Try again, or use your password or email code. New staff should first use their approved invite and email code.';
export type GoogleState = { busy: boolean; message: string | null };
let state: GoogleState = { busy: false, message: null };
const listeners = new Set<() => void>();
export const googleSnapshot = () => state;
export const subscribeGoogle = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function update(busy: boolean, message: string | null = null) {
  state = { busy, message }; listeners.forEach((fn) => fn());
}
interface Intent { nonce: string; at: number; next: string; flowId: string | null; }
let pending: Promise<void> | null = null;
let removeFinished: (() => void) | null = null;
let oauth: ReturnType<typeof createClient> | null = null;
const exchangeMemory = new Map<string, string>();
let epoch = 0;

// Only verifier entries survive navigation/restart. Provider and app tokens from
// the exchange stay in memory until accepted by the normal app client.
function exchangeClient() {
  if (oauth) return oauth;
  const durable = googleStorage();
  const storage: SupportedStorage = {
    getItem: (k) => k.includes('-code-verifier') ? durable.getItem(k) : exchangeMemory.get(k) ?? null,
    setItem: (k, v) => { if (k.includes('-code-verifier')) return durable.setItem(k, v); exchangeMemory.set(k, v); },
    removeItem: (k) => { if (k.includes('-code-verifier')) return durable.removeItem(k); exchangeMemory.delete(k); },
  };
  oauth = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { flowType: 'pkce', storageKey: OAUTH_KEY, storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, experimental: { appendPkceFlowIdToRedirects: true } },
  });
  return oauth;
}

export function googleAvailable(): boolean {
  return !isNativeApp() || (hasPlugin('Browser') && hasPlugin('SecureStorage'));
}

export function googleNext(value: string | null): string {
  if (!value || value.length > 512) return '/';
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return '/'; }
  for (const p of [value, decoded]) {
    if (!p.startsWith('/') || p.startsWith('//') || /[\\\x00-\x20\x7f]/.test(p) || p.includes('://')) return '/';
    const path = new URL(p, 'https://dek.local').pathname.toLowerCase();
    if (path === '/signin' || path.startsWith('/signin/') || path === '/auth' || path.startsWith('/auth/')) return '/';
  }
  return parse(value).name === 'notFound' ? '/' : value;
}

function returnPath(): string {
  const route = parse(window.location.href);
  return googleNext(route.name === 'signin' ? route.next : window.location.pathname + window.location.search);
}

async function clearIntent(): Promise<void> {
  await googleStorage().removeItem(INTENT_KEY);
  removeFinished?.(); removeFinished = null;
}

export async function cancelGoogle(): Promise<void> {
  epoch += 1;
  await clearIntent();
  update(false, 'Google sign-in was cancelled. You can try again or use another sign-in option.');
}

// Explicit sign-out invalidates a Google tab still open on a shared device.
export async function resetGoogle(): Promise<void> {
  epoch += 1;
  await clearIntent();
  exchangeMemory.clear();
  update(false);
}

export async function startGoogle(): Promise<void> {
  if (state.busy || pending) return;
  const ticket = ++epoch;
  update(true);
  try {
    if (!googleAvailable()) throw new Error('unsupported');
    const existing = await supabase().auth.getSession();
    if (existing.error || existing.data.session) throw new Error('active account');
    if (ticket !== epoch) return;
    const intent: Intent = { nonce: crypto.randomUUID(), at: Date.now(), next: returnPath(), flowId: null };
    const store = googleStorage();
    await store.setItem(INTENT_KEY, JSON.stringify(intent));
    if (await store.getItem(INTENT_KEY) !== JSON.stringify(intent)) throw new Error('storage');
    const target = new URL(isNativeApp() ? 'dek://auth/google' : window.location.origin + CALLBACK);
    target.searchParams.set('intent', intent.nonce);
    const { data, error } = await exchangeClient().auth.signInWithOAuth({
      provider: 'google', options: {
        scopes: 'openid email profile', redirectTo: target.href, skipBrowserRedirect: true,
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error || !data.url) throw new Error('start');
    if (ticket !== epoch) return;
    const authorize = new URL(data.url);
    if (authorize.origin !== new URL(config.supabaseUrl).origin || authorize.pathname !== '/auth/v1/authorize') throw new Error('authorize URL');
    const callback = new URL(authorize.searchParams.get('redirect_to') ?? '');
    intent.flowId = callback.searchParams.get('sb_flow_id');
    if (!intent.flowId || !/^[a-f0-9]{32}$/.test(intent.flowId) || callback.searchParams.get('intent') !== intent.nonce) throw new Error('missing PKCE flow');
    await store.setItem(INTENT_KEY, JSON.stringify(intent));
    if (ticket !== epoch) return;
    // A durable native verifier is mandatory, not the adapter's memory fallback.
    if ('lastError' in store && typeof store.lastError === 'function' && store.lastError()) throw new Error('secure storage');
    if (isNativeApp()) {
      removeFinished?.();
      removeFinished = listenNative('Browser', 'browserFinished', () => { if (!pending) void cancelGoogle().catch(() => update(false, RETRY)); });
      await callNative('Browser', 'open', { url: data.url });
    } else window.location.assign(data.url);
  } catch {
    if (ticket !== epoch) return;
    await clearIntent().catch(() => undefined);
    update(false, googleAvailable() ? RETRY : 'Google sign-in needs an updated Dek app with secure browser support. You can still use your password or email code.');
  }
}

function callbackUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    const native = isNativeApp() && u.protocol === 'dek:' && u.hostname === 'auth' && u.pathname === '/google';
    const web = !isNativeApp() && u.origin === window.location.origin && u.pathname === CALLBACK;
    return ((native && !u.port) || web) && !u.username && !u.password ? u : null;
  } catch { return null; }
}

async function finish(url: URL): Promise<void> {
  update(true);
  const ticket = ++epoch;
  let completed: Session | null = null;
  try {
    const raw = await googleStorage().getItem(INTENT_KEY);
    const intent = raw ? JSON.parse(raw) as Intent : null;
    if (!intent || typeof intent.at !== 'number' || !/^[a-f0-9-]{36}$/.test(intent.nonce) || intent.nonce !== url.searchParams.get('intent') || Date.now() - intent.at > MAX_AGE || intent.at > Date.now() + 30_000) throw new Error('expired intent');
    // Consume before network I/O. Errors and replay require a new flow.
    await clearIntent();
    if (url.searchParams.has('error')) {
      update(false, url.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled. Try again or use another sign-in option.' : RETRY);
      return;
    }
    const code = url.searchParams.get('code');
    const flowId = url.searchParams.get('sb_flow_id');
    if (!code || code.length > 2048 || !flowId || !/^[a-f0-9]{32}$/.test(flowId) || flowId !== intent.flowId || url.hash || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('intent').length !== 1 || url.searchParams.getAll('sb_flow_id').length !== 1) throw new Error('invalid callback');
    const active = await supabase().auth.getSession();
    if (active.error || active.data.session) throw new Error('active account');
    const result = await exchangeClient().auth.exchangeCodeForSession(code, { flowId });
    completed = result.data.session;
    if (result.error || !completed) throw new Error('exchange');
    if (ticket !== epoch) throw new Error('cancelled');
    await acceptGoogleSession(completed, () => ticket === epoch);
    navigate(googleNext(intent.next), { replace: true });
    update(false);
  } catch {
    await clearIntent().catch(() => undefined);
    update(false, RETRY);
  } finally {
    // Never call signOut here: even scope local revokes the current refresh
    // session on the server. The app has just accepted that same session.
    exchangeMemory.clear();
    if (isNativeApp()) await callNative('Browser', 'close').catch(() => undefined);
  }
}

// Recognise and scrub synchronously before crash reporting or route rendering.
// Duplicate launch/appUrlOpen deliveries share the same one-time operation.
export function handleGoogleCallback(raw: string): boolean {
  const url = callbackUrl(raw);
  if (!url) return false;
  if (!isNativeApp()) window.history.replaceState(null, '', '/signin');
  if (!pending) pending = finish(url).finally(() => { pending = null; });
  return true;
}

export async function googleCallbackSettled(): Promise<void> { await pending; }
