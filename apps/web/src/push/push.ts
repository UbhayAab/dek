// Web push (DEK15, DEK16, LESSONS "Push"):
// - permission is asked only from a click; a denial is never re-prompted,
// - subscribe with config.vapidPublicKey (one source) and register the device,
// - the VAPID mismatch guard: a subscription made with a different key (the legacy
//   meta-tag bug that made Apple reject every push) is replaced,
// - granted but unsubscribed: subscribe silently on login,
// - sign-out unsubscribes AND unregisters (shared phones),
// - iOS: a Safari tab has no PushManager; the answer is Add to Home Screen.
import { api } from '../api/rpc';
import type { Device } from '../api/types';
import { config } from '../config';
import { detect, deviceLabel, platformCode, type PlatformInfo } from '../lib/platform';
import { readJson, removeKey, userKey, writeJson } from '../lib/storage';
import { getRegistration, registerServiceWorker } from '../sw/register';

export type PushSupport = 'supported' | 'ios-needs-install' | 'ios-too-old' | 'unsupported' | 'insecure';
export type Permission = NotificationPermission | 'unsupported';

export interface StoredDevice {
  id: string;
  endpoint: string;
}

export type EnableResult =
  | { ok: true; device: Device }
  | { ok: false; reason: 'denied' | 'dismissed' | 'unsupported' | 'ios-needs-install' | 'no-worker' | 'error'; message: string };

export function pushSupport(p: PlatformInfo = detect()): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (p.isIOS) {
    if (p.iosVersion !== null && p.iosVersion < 16.4) return 'ios-too-old';
    if (!p.isStandalone) return 'ios-needs-install';
    return hasApis ? 'supported' : 'ios-too-old';
  }
  return hasApis ? 'supported' : 'unsupported';
}

export function permission(): Permission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// The VAPID guard: is this subscription bound to the key push-dispatch signs with?
export function keysMatch(subscriptionKey: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!subscriptionKey) return false;
  const a = new Uint8Array(subscriptionKey);
  if (a.length !== expected.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== expected[i]) return false;
  return true;
}

export function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

export function storedDevice(userId: string): StoredDevice | null {
  const d = readJson<StoredDevice | null>(userKey('push.device', userId), null);
  return d && typeof d.id === 'string' && typeof d.endpoint === 'string' ? d : null;
}

async function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  const reg = (await getRegistration()) ?? (await registerServiceWorker());
  if (!reg) return null;
  if (reg.active) return reg;
  // Installing for the first time: wait for it (bounded).
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
  ]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await getRegistration();
  if (!reg || !('pushManager' in reg)) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// From a click only: the browser shows its prompt here, never on page load.
export async function enablePush(userId: string): Promise<EnableResult> {
  const support = pushSupport();
  if (support === 'ios-needs-install') return { ok: false, reason: 'ios-needs-install', message: 'Add Dek to your Home Screen first, then turn notifications on from there.' };
  if (support !== 'supported') return { ok: false, reason: 'unsupported', message: 'This browser cannot show Dek notifications.' };
  let perm = permission();
  if (perm === 'default') {
    try {
      perm = await Notification.requestPermission();
    } catch {
      perm = permission();
    }
  }
  if (perm === 'denied') return { ok: false, reason: 'denied', message: 'Notifications are blocked for Dek in this browser.' };
  if (perm !== 'granted') return { ok: false, reason: 'dismissed', message: 'Notifications were not turned on.' };
  return subscribeAndRegister(userId);
}

export async function subscribeAndRegister(userId: string): Promise<EnableResult> {
  const reg = await workerRegistration();
  if (!reg) return { ok: false, reason: 'no-worker', message: 'The Dek service worker is not running in this browser yet. Reload and try again.' };
  const key = urlBase64ToUint8Array(config.vapidPublicKey);
  try {
    let sub = await reg.pushManager.getSubscription();
    if (sub && !keysMatch(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    const device = await api.registerPushDevice({
      kind: 'webpush',
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? null,
      auth: json.keys?.auth ?? null,
      label: deviceLabel(),
      platform: platformCode(),
    });
    writeJson(userKey('push.device', userId), { id: device.id, endpoint: sub.endpoint } satisfies StoredDevice);
    return { ok: true, device };
  } catch (e) {
    const message = e instanceof Error && e.message ? e.message : 'Could not turn on notifications.';
    return { ok: false, reason: 'error', message };
  }
}

// On every sign-in and when the worker reports a rotated subscription: if the
// person already allowed notifications here, make sure this device is registered
// to this account with the right key. Never prompts.
export async function ensurePushOnLogin(userId: string): Promise<void> {
  if (pushSupport() !== 'supported' || permission() !== 'granted') return;
  await subscribeAndRegister(userId).catch(() => undefined);
}

// Sign-out: the next person on this phone must not get this person's previews.
export async function disablePush(userId: string | null, opts: { unregister: boolean }): Promise<void> {
  const sub = await currentSubscription();
  const stored = userId ? storedDevice(userId) : null;
  if (opts.unregister) {
    try {
      if (sub) await api.unregisterPushDevice({ endpoint: sub.endpoint });
      else if (stored) await api.unregisterPushDevice({ device: stored.id });
    } catch {
      /* the unsubscribe below makes the endpoint dead; push-dispatch prunes it on 410 */
    }
  }
  if (sub) await sub.unsubscribe().catch(() => false);
  if (userId) removeKey(userKey('push.device', userId));
}
