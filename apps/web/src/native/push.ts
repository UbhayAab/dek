// OWNER: native builder. Native push for the Android (FCM) and iOS (APNs) apps
// (DEK15 to DEK20 on native). Same rules as web push in src/push/push.ts:
// - the permission prompt comes only from a click in notification settings,
// - a granted device registers silently at sign-in and on every token refresh,
// - sign-out unregisters the device AND deletes the token (shared phones),
// - a build without a push configuration says so instead of failing.
import { api } from '../api/rpc';
import type { Device } from '../api/types';
import { callNative, hasPlugin, isNativeApp, listenNative, nativePlatform } from './bridge';

const PUSH = 'PushNotifications';
const NATIVE = 'DekNative';
const TOKEN_WAIT_MS = 20_000;
const UNREGISTER_WAIT_MS = 5_000;
export const NOT_CONFIGURED = 'Push not configured on this build';

export type NativePushState =
  | 'unsupported'      // the web, or a shell without the push plugin
  | 'not_configured'   // no Firebase config (Android) or no APNs entitlement (iOS)
  | 'prompt'           // never asked
  | 'denied'           // refused: only system settings can change it now
  | 'registering'
  | 'registered'
  | 'error';

export interface NativePushStatus {
  platform: 'android' | 'ios' | 'web';
  provider: 'fcm' | 'apns' | null;
  state: NativePushState;
  message: string;
  deviceId: string | null;
  lastError: string | null;
}

// Assignable to EnableResult in src/push/push.ts, so enablePush can delegate.
export type NativeEnableResult =
  | { ok: true; device: Device }
  | { ok: false; reason: 'denied' | 'dismissed' | 'unsupported' | 'error'; message: string };

type Permission = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';
interface StoredRegistration { userId: string; deviceId: string; token: string }

const STORE_KEY = 'dek.native.push';

let currentUserId: string | null = null;
let lastError: string | null = null;
let registering: Promise<NativeEnableResult> | null = null;
interface TokenWaiter { resolve: (t: string) => void; reject: (e: Error) => void }
const tokenWaiters: TokenWaiter[] = [];

// ---------------------------------------------------------------- small helpers

function provider(): 'fcm' | 'apns' | null {
  const p = nativePlatform();
  return p === 'android' ? 'fcm' : p === 'ios' ? 'apns' : null;
}

function readStored(): StoredRegistration | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? (JSON.parse(raw) as StoredRegistration) : null;
    return v && typeof v.token === 'string' && typeof v.userId === 'string' ? v : null;
  } catch {
    return null;
  }
}

function writeStored(v: StoredRegistration | null): void {
  try {
    if (v) localStorage.setItem(STORE_KEY, JSON.stringify(v));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable: the next sign-in registers again, nothing is lost */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e);
}

export function deviceLabel(): string {
  const p = nativePlatform();
  if (p === 'android') {
    const model = /Android [^;)]+; ([^;)]+?)(?: Build\/|\))/.exec(navigator.userAgent)?.[1]?.trim();
    return model ? `Dek app on Android (${model})` : 'Dek app on Android';
  }
  if (p === 'ios') return /iPad/.test(navigator.userAgent) ? 'Dek app on iPad' : 'Dek app on iPhone';
  return 'Dek app';
}

// Android: a build without google-services.json must never call register(), which
// throws inside the plugin and crashes the app. iOS has no DekNative plugin; a
// missing APNs entitlement shows up as a registrationError instead.
async function pushConfigured(): Promise<boolean> {
  if (nativePlatform() !== 'android') return true;
  if (!hasPlugin(NATIVE)) return false;
  try {
    const info = await callNative<{ pushConfigured?: boolean }>(NATIVE, 'info');
    return info?.pushConfigured === true;
  } catch {
    return false;
  }
}

async function permission(): Promise<Permission> {
  const r = await callNative<{ receive: Permission }>(PUSH, 'checkPermissions');
  return r.receive;
}

// Resolves with the next token the plugin reports; the waiter leaves the queue on
// success, error and timeout alike, so a stale waiter never swallows a refresh.
function waitForToken(): Promise<string> {
  let entry: TokenWaiter | null = null;
  const inner = new Promise<string>((resolve, reject) => {
    entry = { resolve, reject };
    tokenWaiters.push(entry);
  });
  return withTimeout(inner, TOKEN_WAIT_MS, 'Push registration').finally(() => {
    const i = entry ? tokenWaiters.indexOf(entry) : -1;
    if (i >= 0) tokenWaiters.splice(i, 1);
  });
}

function isEntitlementError(msg: string): boolean {
  return /aps-environment|entitlement|not configured|FirebaseApp/i.test(msg);
}

// ---------------------------------------------------------------- registration

async function registerToken(userId: string, token: string): Promise<Device> {
  const stored = readStored();
  if (stored && stored.token !== token && stored.userId === userId) {
    // Token rotated: retire the old endpoint first (best effort; push-dispatch also
    // prunes it when the provider reports it unregistered).
    await api.unregisterPushDevice({ endpoint: stored.token }).catch(() => undefined);
  }
  const device = await api.registerPushDevice({
    kind: provider() ?? 'fcm',
    endpoint: token,
    label: deviceLabel(),
    platform: nativePlatform(),
  });
  writeStored({ userId, deviceId: device.id, token });
  lastError = null;
  return device;
}

async function registerNow(userId: string): Promise<NativeEnableResult> {
  const tokenP = waitForToken();
  try {
    await callNative(PUSH, 'register');
    const token = await tokenP;
    if (currentUserId && currentUserId !== userId) {
      return { ok: false, reason: 'error', message: 'The signed-in account changed. Try again.' };
    }
    return { ok: true, device: await registerToken(userId, token) };
  } catch (e) {
    tokenP.catch(() => undefined);
    lastError = messageOf(e);
    if (isEntitlementError(lastError)) return { ok: false, reason: 'unsupported', message: NOT_CONFIGURED };
    return { ok: false, reason: 'error', message: `Could not register this phone for notifications: ${lastError}` };
  }
}

function serialized(run: () => Promise<NativeEnableResult>): Promise<NativeEnableResult> {
  if (registering) return registering;
  registering = run().finally(() => {
    registering = null;
  });
  return registering;
}

// From a click in notification settings: the OS prompt appears here, never at launch.
export async function enableNativePush(userId: string): Promise<NativeEnableResult> {
  if (!isNativeApp() || !hasPlugin(PUSH)) return { ok: false, reason: 'unsupported', message: 'This app build cannot show notifications.' };
  currentUserId = userId;
  if (!(await pushConfigured())) return { ok: false, reason: 'unsupported', message: NOT_CONFIGURED };
  return serialized(async () => {
    let perm = await permission();
    if (perm === 'prompt' || perm === 'prompt-with-rationale') {
      perm = (await callNative<{ receive: Permission }>(PUSH, 'requestPermissions')).receive;
    }
    if (perm === 'denied') {
      return { ok: false, reason: 'denied', message: 'Notifications are turned off for Dek in system settings. Open settings to turn them on.' };
    }
    if (perm !== 'granted') return { ok: false, reason: 'dismissed', message: 'Notifications were not turned on.' };
    return registerNow(userId);
  });
}

// Sign-in, app start and resume: if this person already allowed notifications on
// this phone, make sure the device is registered to them. Never prompts.
export async function ensureNativePushOnLogin(userId: string): Promise<void> {
  if (!isNativeApp() || !hasPlugin(PUSH)) return;
  currentUserId = userId;
  if (!(await pushConfigured())) return;
  if ((await permission().catch(() => 'denied' as Permission)) !== 'granted') return;
  await serialized(() => registerNow(userId)).catch(() => undefined);
}

// Sign-out, BEFORE the session ends (unregistering needs it). With
// unregister=false only the local token and notifications go (session expired).
export async function disableNativePush(userId: string | null, opts: { unregister: boolean }): Promise<void> {
  if (!isNativeApp() || !hasPlugin(PUSH)) return;
  const stored = readStored();
  if (opts.unregister && stored && (!userId || stored.userId === userId)) {
    await withTimeout(api.unregisterPushDevice({ endpoint: stored.token }), UNREGISTER_WAIT_MS, 'Unregister')
      .catch(() => undefined); // the token is deleted below; push-dispatch prunes it on the next send
  }
  await clearLocalPush();
}

// No previews of the previous person on a shared phone, and no token left behind.
async function clearLocalPush(): Promise<void> {
  writeStored(null);
  currentUserId = null;
  await callNative(PUSH, 'removeAllDeliveredNotifications').catch(() => undefined);
  if (await pushConfigured()) await callNative(PUSH, 'unregister').catch(() => undefined);
}

export async function nativePushStatus(): Promise<NativePushStatus> {
  const base = { platform: nativePlatform(), provider: provider(), deviceId: null as string | null, lastError };
  if (!isNativeApp() || !hasPlugin(PUSH)) return { ...base, state: 'unsupported', message: 'Notifications are not available in this build.' };
  if (!(await pushConfigured())) return { ...base, state: 'not_configured', message: NOT_CONFIGURED };
  if (registering) return { ...base, state: 'registering', message: 'Registering this phone for notifications.' };
  let perm: Permission;
  try {
    perm = await permission();
  } catch (e) {
    return { ...base, state: 'error', message: 'Could not read the notification permission.', lastError: messageOf(e) };
  }
  if (perm === 'denied') return { ...base, state: 'denied', message: 'Notifications are turned off for Dek in system settings. Open settings to turn them on.' };
  if (perm !== 'granted') return { ...base, state: 'prompt', message: 'Turn on notifications to get messages while Dek is closed.' };
  if (lastError && isEntitlementError(lastError)) return { ...base, state: 'not_configured', message: NOT_CONFIGURED };
  const stored = readStored();
  if (stored && (!currentUserId || stored.userId === currentUserId)) {
    return { ...base, state: 'registered', deviceId: stored.deviceId, message: 'This phone receives Dek notifications.' };
  }
  if (lastError) return { ...base, state: 'error', message: `This phone is not registered for notifications: ${lastError}` };
  return { ...base, state: 'prompt', message: 'Notifications are allowed but this phone is not registered yet. Turn them on to register.' };
}

// ---------------------------------------------------------------- events

export interface ForegroundPush {
  title: string | null;
  body: string | null;
  data: Record<string, string>;
}

const foregroundListeners = new Set<(p: ForegroundPush) => void>();

// The open app gets pushes as events, never as OS banners (presentationOptions: []).
export function onNativePushReceived(cb: (p: ForegroundPush) => void): () => void {
  foregroundListeners.add(cb);
  return () => foregroundListeners.delete(cb);
}

// Removes delivered notifications of one conversation (tag c:<channel> or
// t:<thread root>, the tags push-dispatch sets), e.g. when it is opened.
export async function clearConversationNotifications(channelId: string, threadRootId: string | null = null): Promise<number> {
  if (!isNativeApp() || !hasPlugin(PUSH)) return 0;
  const tags = new Set([`c:${channelId}`, ...(threadRootId ? [`t:${threadRootId}`] : [])]);
  try {
    const { notifications } = await callNative<{ notifications: { id: string; tag?: string; data?: Record<string, unknown> }[] }>(PUSH, 'getDeliveredNotifications');
    const match = (notifications ?? []).filter((n) => tags.has(String(n.tag ?? n.data?.tag ?? '')));
    if (match.length) await callNative(PUSH, 'removeDeliveredNotifications', { notifications: match });
    return match.length;
  } catch {
    return 0;
  }
}

export function installPushListeners(openUrl: (url: unknown) => void): () => void {
  if (!isNativeApp() || !hasPlugin(PUSH)) return () => undefined;
  const offs = [
    listenNative<{ value: string }>(PUSH, 'registration', ({ value }) => {
      const waiter = tokenWaiters.shift();
      if (waiter) {
        waiter.resolve(value);
        return;
      }
      // Token refresh outside a registration (FCM rotation): re-register silently.
      if (currentUserId) void registerToken(currentUserId, value).catch((e) => { lastError = messageOf(e); });
    }),
    listenNative<{ error: string }>(PUSH, 'registrationError', ({ error }) => {
      lastError = error || 'registration failed';
      const waiter = tokenWaiters.shift();
      waiter?.reject(new Error(lastError));
    }),
    listenNative<{ title?: string; body?: string; data?: Record<string, string> }>(PUSH, 'pushNotificationReceived', (n) => {
      const p: ForegroundPush = { title: n.title ?? null, body: n.body ?? null, data: n.data ?? {} };
      for (const l of foregroundListeners) l(p);
      window.dispatchEvent(new CustomEvent('dek:push', { detail: p }));
    }),
    listenNative<{ actionId: string; notification?: { data?: Record<string, unknown> } }>(PUSH, 'pushNotificationActionPerformed', (a) => {
      openUrl(a.notification?.data?.url);
    }),
  ];
  return () => offs.forEach((off) => off());
}

// Test seam.
export function __resetNativePushForTests(): void {
  currentUserId = null;
  lastError = null;
  registering = null;
  tokenWaiters.length = 0;
  foregroundListeners.clear();
}
