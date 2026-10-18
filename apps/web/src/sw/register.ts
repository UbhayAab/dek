// The page's side of the service worker: registration, update checks every 15
// minutes and on visibility, applying a waiting worker only when it is safe (no
// unsent composer text in the open conversation, no open dialog, not in a call) or
// when the person taps "New version ready", and the messages the worker sends
// (navigate after a notification tap, push shown or suppressed).
import { navigate } from '../app/router';
import { isNativeApp } from '../native';
import { getState, setState } from '../store/state';
import { MEDIA_CACHE, SHELL_PREFIX } from './helpers';

const UPDATE_EVERY_MS = 15 * 60 * 1000;
const SAFE_CHECK_MS = 30_000;
const RELOAD_GUARD = 'dek.sw.reloaded';

type Handler = (data: Record<string, unknown>) => void;
const handlers = new Map<string, Set<Handler>>();
let registration: ServiceWorkerRegistration | null = null;
let started = false;
let reloading = false;
let safeTimer: ReturnType<typeof setInterval> | null = null;
let isSafeCheck: () => boolean = () => true;
let userAsked = false;
let reloadWhenSafe: ReturnType<typeof setInterval> | null = null;

export function swSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function onSwMessage(type: string, handler: Handler): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  return () => { handlers.get(type)?.delete(handler); };
}

// The app tells us how to judge "safe to reload now".
export function setUpdateSafetyCheck(fn: () => boolean): void {
  isSafeCheck = fn;
}

export function listenToWorker(): void {
  if (!swSupported()) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'visible-context' && event.ports[0]) {
      const main = document.querySelector('.dk-convo');
      const uncovered=!document.querySelector('dialog[open],[role="dialog"],[role="alertdialog"]');
      const channelVisible = !!main && (!document.querySelector('.dk-side') || window.matchMedia('(min-width: 1100px)').matches) && uncovered;
      const threadVisible=!!document.querySelector('.dk-thread')&&uncovered;
      event.ports[0].postMessage({ url: window.location.href, channelVisible,threadVisible });
      return;
    }
    if (data.type === 'navigate' && typeof data.url === 'string') {
      // Only same-app paths (the worker already strips other origins).
      if (data.url.startsWith('/') && !data.url.startsWith('//')) navigate(data.url);
    }
    for (const h of handlers.get(data.type) ?? []) {
      try { h(data); } catch { /* keep going */ }
    }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    // A first install claiming this page is not an update.
    if (!getState().app.updateReady && !userAsked) return;
    // The tab whose person tapped "Reload" goes now. Every other tab that the new
    // worker took over reloads only when it is safe there (no unsent composer
    // text, no open dialog, not in a call): checked now, every 30 s and on hiding.
    if (userAsked || safeNow()) {
      reload();
      return;
    }
    if (!reloadWhenSafe) {
      reloadWhenSafe = setInterval(() => { if (safeNow()) reload(); }, SAFE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && safeNow()) reload();
      });
    }
  });
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!swSupported()) return null;
  // The dev server does not build sw.js; production and preview builds do. The apps
  // bundle their assets and push natively: no service worker there (docs/NATIVE.md).
  if (import.meta.env.DEV && !import.meta.env.VITE_SW_IN_DEV) return null;
  if (isNativeApp()) return null;
  if (started) return registration;
  started = true;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  } catch {
    started = false;
    return null;
  }
  watch(registration);
  setInterval(() => void checkForUpdate(), UPDATE_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate();
    else maybeApply();   // hidden is the least disruptive moment
  });
  void readVersion();
  return registration;
}

export async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (registration) return registration;
  if (!swSupported()) return null;
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(): Promise<boolean> {
  const reg = registration;
  if (!reg) return false;
  try {
    await reg.update();
  } catch {
    return false;
  }
  return !!reg.waiting;
}

function watch(reg: ServiceWorkerRegistration): void {
  const flag = () => {
    if (reg.waiting && navigator.serviceWorker.controller) {
      setState({ app: { ...getState().app, updateReady: true } });
      startSafeChecks();
      maybeApply();
    }
  };
  flag();
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed') flag();
    });
  });
}

function startSafeChecks(): void {
  if (safeTimer) return;
  safeTimer = setInterval(maybeApply, SAFE_CHECK_MS);
}

function safeNow(): boolean {
  try {
    return isSafeCheck();
  } catch {
    return false;
  }
}

function reload(): void {
  if (reloading) return;
  reloading = true;
  if (reloadWhenSafe) clearInterval(reloadWhenSafe);
  window.location.reload();
}

function maybeApply(): void {
  if (!getState().app.updateReady || !registration?.waiting) return;
  if (safeNow()) activateWaiting();
}

// The banner's "Reload": the person chose it, so it happens now.
export function applyUpdate(): void {
  userAsked = true;
  if (!activateWaiting()) reload();
}

function activateWaiting(): boolean {
  const w = registration?.waiting;
  if (!w) return false;
  if (safeTimer) clearInterval(safeTimer);
  safeTimer = null;
  w.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

async function readVersion(): Promise<void> {
  const v = await workerVersion();
  if (v) setState({ app: { ...getState().app, version: v } });
}

export async function workerVersion(): Promise<string | null> {
  const ctl = swSupported() ? navigator.serviceWorker.controller : null;
  if (!ctl) return null;
  return new Promise<string | null>((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2_000);
    ch.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      const v = (e.data as { version?: unknown } | null)?.version;
      resolve(typeof v === 'string' ? v : null);
    };
    ctl.postMessage({ type: 'version' }, [ch.port2]);
  });
}

function post(message: unknown): boolean {
  const ctl = swSupported() ? navigator.serviceWorker.controller : null;
  if (!ctl) return false;
  try {
    ctl.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

// Sign-out: the worker wipes its media cache; the page deletes it too in case no
// worker controls this page (first visit, dev build).
export async function wipeMedia(): Promise<void> {
  post({ type: 'wipe-media' });
  try {
    if (typeof caches !== 'undefined') await caches.delete(MEDIA_CACHE);
  } catch {
    /* no Cache Storage */
  }
}

// A conversation opened: its notifications (one tag per conversation, c:<channel>
// and t:<root>) leave the notification tray, as they do in the apps.
export async function clearWebNotifications(tags: readonly string[]): Promise<number> {
  const reg = registration ?? (await getRegistration());
  if (!reg || typeof reg.getNotifications !== 'function') return 0;
  let n = 0;
  for (const tag of tags) {
    try {
      for (const note of await reg.getNotifications({ tag })) {
        note.close();
        n += 1;
      }
    } catch {
      /* no notification access: nothing to clear */
    }
  }
  return n;
}

// Revocation: drop cached files under these "<org>/<channel>/" prefixes.
export function purgeMedia(prefixes: string[]): void {
  if (prefixes.length === 0) return;
  post({ type: 'purge-media', prefixes });
}

// A stale index.html running against newer chunks (or the reverse) fails to load a
// module: clear caches and reload once (LESSONS "Auth": stale shell).
export function installChunkRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    let already = false;
    try {
      already = sessionStorage.getItem(RELOAD_GUARD) === '1';
      sessionStorage.setItem(RELOAD_GUARD, '1');
    } catch {
      already = true;
    }
    if (already) return;
    event.preventDefault();
    void (async () => {
      try {
        // Leftover caches go; the worker's own shell precache (version-consistent:
        // it is what makes Dek open offline) and the media cache stay.
        if (typeof caches !== 'undefined') {
          for (const k of await caches.keys()) {
            if (k !== MEDIA_CACHE && !k.startsWith(SHELL_PREFIX)) await caches.delete(k);
          }
        }
      } finally {
        window.location.reload();
      }
    })();
  });
  window.addEventListener('load', () => {
    setTimeout(() => {
      try { sessionStorage.removeItem(RELOAD_GUARD); } catch { /* fine */ }
    }, 10_000);
  });
}
