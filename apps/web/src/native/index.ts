// OWNER: native builder. The web side of the Android and iOS apps (docs/NATIVE.md).
//
// main.tsx calls initNative() first, before anything creates the Supabase client.
// On the web every export here is a no-op (isNativeApp() is false), so the same
// bundle serves the browser, the installed PWA and the native shells.
import { setAuthStorage, supabase } from '../api/client';
import { currentRoute } from '../app/router';
import { handleGoogleCallback } from '../sync/google';
import { callNative, hasPlugin, isNativeApp, listenNative, nativePlatform } from './bridge';
import { installBackButton } from './back';
import { installKeyboard } from './keyboard';
import { openInApp } from './links';
import { createSecureStorage, type SecureSessionStorage } from './secureStorage';
import {
  clearConversationNotifications, disableNativePush, ensureNativePushOnLogin, installPushListeners, nativePushStatus,
} from './push';

export { isNativeApp, nativePlatform } from './bridge';
export { BACK_EVENT } from './back';
export { inAppPath, openInApp, WEB_ORIGIN } from './links';
export {
  NOT_CONFIGURED, clearConversationNotifications, disableNativePush, enableNativePush,
  ensureNativePushOnLogin, nativePushStatus, onNativePushReceived,
  type ForegroundPush, type NativeEnableResult, type NativePushState, type NativePushStatus,
} from './push';

const DUPLICATE_LINK_MS = 2_000;

let started = false;
let storage: SecureSessionStorage | null = null;
let ensuredFor: string | null = null;
let signedInUser: string | null = null;
let lastLink: { url: string; at: number } | null = null;

// Android delivers a cold-start link both as appUrlOpen and as the launch URL.
function openLinkOnce(url: unknown): void {
  if (typeof url !== 'string') return;
  const now = Date.now();
  if (lastLink && lastLink.url === url && now - lastLink.at < DUPLICATE_LINK_MS) return;
  lastLink = { url, at: now };
  if (handleGoogleCallback(url)) return;
  openInApp(url);
}

function installLinks(): void {
  listenNative<{ url: string }>('App', 'appUrlOpen', (e) => openLinkOnce(e?.url));
  void callNative<{ url?: string } | undefined>('App', 'getLaunchUrl')
    .then((r) => openLinkOnce(r?.url))
    .catch(() => undefined);
}

function clearVisibleConversation(): void {
  const r = currentRoute();
  if (r.name === 'channel') void clearConversationNotifications(r.channelId, r.threadId);
}

// A registration that failed (offline cold start, a failed RPC) or a permission
// granted later in system settings is retried on resume and when the network
// returns. Cheap when nothing is needed: one permission check, no RPC.
async function retryPushIfNeeded(): Promise<void> {
  const uid = signedInUser;
  if (!uid) return;
  const status = await nativePushStatus().catch(() => null);
  if (!status || status.state === 'registered' || status.state === 'registering') return;
  if (status.state === 'unsupported' || status.state === 'not_configured') return;
  await ensureNativePushOnLogin(uid);
}

function installLifecycle(): void {
  listenNative<{ isActive: boolean }>('App', 'appStateChange', ({ isActive }) => {
    if (isActive) {
      // supabase-js only watches visibilitychange; a resumed app must refresh an
      // access token that expired in the background before realtime rejoins.
      void supabase().auth.startAutoRefresh();
      clearVisibleConversation();
      void retryPushIfNeeded();
      window.dispatchEvent(new Event('dek:resume'));
    } else {
      window.dispatchEvent(new Event('dek:pause'));
    }
  });
  window.addEventListener('online', () => {
    void retryPushIfNeeded();
  });
}

// Sign-in (or an app start with a stored session) registers an already allowed
// device; a session that ended (signed out here or revoked elsewhere) deletes the
// token and the notifications on this phone.
function installAuthHook(): void {
  supabase().auth.onAuthStateChange((event, session) => {
    const uid = session?.user?.id ?? null;
    // Never call Supabase inside this callback: auth-js holds its lock here.
    setTimeout(() => {
      if (uid) signedInUser = uid;
      if (uid && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && ensuredFor !== uid) {
        ensuredFor = uid;
        void ensureNativePushOnLogin(uid);
      } else if (event === 'SIGNED_OUT') {
        ensuredFor = null;
        signedInUser = null;
        void disableNativePush(null, { unregister: false });
      }
    }, 0);
  });
}

export function initNative(): void {
  if (started || !isNativeApp()) return;
  started = true;
  document.documentElement.classList.add('dk-native', `dk-${nativePlatform()}`);
  if (hasPlugin('SecureStorage')) {
    storage = createSecureStorage();
    setAuthStorage(storage);
  }
  installLinks();
  installBackButton();
  installKeyboard();
  installPushListeners(openLinkOnce);
  installLifecycle();
  installAuthHook();
}

// ---------------------------------------------------------------- settings helpers

// Where a person fixes a denied permission: Android opens Dek's notification
// settings; iOS opens Dek's page in the Settings app.
export async function openNativeNotificationSettings(): Promise<void> {
  if (nativePlatform() === 'android') return callNative('DekNative', 'openNotificationSettings');
  if (nativePlatform() === 'ios') window.location.href = 'app-settings:';
}

export async function openNativeAppSettings(): Promise<void> {
  if (nativePlatform() === 'android') return callNative('DekNative', 'openAppSettings');
  if (nativePlatform() === 'ios') window.location.href = 'app-settings:';
}

// Status bar icons to match the in-app theme: 'dark' = light icons on a dark app.
export async function setNativeBarStyle(theme: 'light' | 'dark' | 'system'): Promise<void> {
  if (!isNativeApp() || !hasPlugin('StatusBar')) return;
  const style = theme === 'dark' ? 'DARK' : theme === 'light' ? 'LIGHT' : 'DEFAULT';
  await callNative('StatusBar', 'setStyle', { style }).catch(() => undefined);
}

export function nativeDiagnostics(): { platform: string; sessionStorage: 'secure' | 'default'; storageError: string | null } {
  return {
    platform: nativePlatform(),
    sessionStorage: storage ? 'secure' : 'default',
    storageError: storage?.lastError() ?? null,
  };
}

// Test seam.
export function __resetNativeForTests(): void {
  started = false;
  storage = null;
  ensuredFor = null;
  signedInUser = null;
  lastLink = null;
}
