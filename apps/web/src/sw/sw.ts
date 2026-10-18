/// <reference lib="webworker" />
// OWNER: core platform builder. Built by scripts/build-sw.mjs into dist/sw.js with
// the precache list of this build's hashed files injected as self.__DEK_PRECACHE
// and a content-derived version as self.__DEK_VERSION.
//
// - Install precaches this build; it never calls skipWaiting (a new worker taking
//   over open pages strands them on old modules). The page sends SKIP_WAITING
//   when it is safe or when the person taps "New version ready".
// - Navigations: network first, the cached shell when offline.
// - Hashed assets: cache first. The Supabase API is never cached.
// - Media: signed storage URLs cached by object path (no token), cache first, LRU
//   150 MB or 500 entries, wiped on 'wipe-media' (sign-out), purged by prefix when
//   access to a channel or organization is revoked.
// - Push (LESSONS "Push"): one tag per conversation with renotify, app badge, and
//   on Chromium only, no OS notification when a focused visible window already
//   shows that conversation (it gets a postMessage instead). WebKit always shows.
import {
  MEDIA_CACHE, MEDIA_INDEX_KEY, MEDIA_MAX_ITEM_BYTES, SHELL_PREFIX, isChromiumUA, isMediaUrl, isStale, matchesPrefix,
  mediaCacheKey, parsePushData, pickWindow, planEviction, safeTargetUrl, suppressFor, tagFor, type IndexEntry,
} from './helpers';

declare const self: ServiceWorkerGlobalScope & { __DEK_PRECACHE: string[]; __DEK_VERSION: string };

const VERSION: string = self.__DEK_VERSION;
const PRECACHE: string[] = self.__DEK_PRECACHE;
const SHELL = `${SHELL_PREFIX}${VERSION}`;
const ORIGIN = self.location.origin;
const SHELL_KEY = '/';
const NAV_TIMEOUT_MS = 5_000;

// ------------------------------------------------------------------ install / activate

// A response that went through a redirect cannot answer a navigation, so store a
// clean copy (Cloudflare Pages redirects /index.html to /).
async function clean(res: Response): Promise<Response> {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const urls = Array.from(new Set(PRECACHE.map((u) => (u === '/index.html' ? SHELL_KEY : u))));
    if (!urls.includes(SHELL_KEY)) urls.push(SHELL_KEY);
    await Promise.all(urls.map(async (u) => {
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (!res.ok) throw new Error(`precache ${u}: ${res.status}`);
      await cache.put(u, await clean(res));
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Everything that is not this version's shell or the media cache goes,
    // including the legacy app's caches.
    for (const name of await caches.keys()) {
      if (name !== SHELL && name !== MEDIA_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// ------------------------------------------------------------------ messages

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; prefixes?: unknown } | null;
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case 'SKIP_WAITING':
      void self.skipWaiting();
      return;
    case 'wipe-media':
      event.waitUntil(wipeMedia());
      return;
    case 'purge-media': {
      const prefixes = Array.isArray(data.prefixes) ? data.prefixes.filter((p): p is string => typeof p === 'string') : [];
      event.waitUntil(purgeMedia(prefixes));
      return;
    }
    case 'version': {
      const reply = { type: 'version', version: VERSION };
      const port = event.ports[0];
      if (port) port.postMessage(reply);
      else (event.source as Client | null)?.postMessage(reply);
      return;
    }
  }
});

// ------------------------------------------------------------------ fetch

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== ORIGIN) {
    if (isMediaUrl(req.url)) event.respondWith(mediaFetch(req));
    return;   // the Supabase API and realtime are never touched
  }
  if (req.mode === 'navigate') {
    event.respondWith(navigation(req));
    return;
  }
  if (url.pathname === '/sw.js' || url.pathname === '/version.json') return;
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(req));
  }
});

async function navigation(req: Request): Promise<Response> {
  const net = fetch(req);
  net.catch(() => undefined);   // answered from the shell instead: not an error
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([net, slow]);
    if (res) return res;
    // Lie-fi: the network is "up" but nothing comes back. The shell works offline.
    const shell = await shellResponse();
    return shell ?? (await net);
  } catch {
    const shell = await shellResponse();
    return shell ?? Response.error();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shellResponse(): Promise<Response | null> {
  const cache = await caches.open(SHELL);
  return (await cache.match(SHELL_KEY, { ignoreVary: true })) ?? (await cache.match('/index.html', { ignoreVary: true })) ?? null;
}

// Hashed files never change, so Vary (Origin, Accept-Encoding) must not turn a
// module script request into a miss: that miss is a blank page offline.
async function cacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreVary: true, ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') void cache.put(req, res.clone());
  return res;
}

// ------------------------------------------------------------------ media cache

let index: Record<string, IndexEntry> | null = null;
let indexLoading: Promise<Record<string, IndexEntry>> | null = null;
let indexTimer: ReturnType<typeof setTimeout> | null = null;

// Single flight: several images requested at once on a cold worker must share one
// index object, or entries recorded in a losing copy are forgotten.
function loadIndex(cache: Cache): Promise<Record<string, IndexEntry>> {
  if (index) return Promise.resolve(index);
  if (!indexLoading) {
    indexLoading = (async () => {
      let loaded: Record<string, IndexEntry> = {};
      try {
        const res = await cache.match(MEDIA_INDEX_KEY);
        if (res) loaded = (await res.json()) as Record<string, IndexEntry>;
      } catch {
        loaded = {};
      }
      index = index ?? loaded;
      indexLoading = null;
      return index;
    })();
  }
  return indexLoading;
}

function saveIndexSoon(): void {
  if (indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    void (async () => {
      const cache = await caches.open(MEDIA_CACHE);
      await cache.put(MEDIA_INDEX_KEY, new Response(JSON.stringify(index ?? {}), { headers: { 'content-type': 'application/json' } }));
    })();
  }, 2_000);
}

async function mediaFetch(req: Request): Promise<Response> {
  // Video and audio stream with Range requests: a 206 is never cached.
  if (req.headers.has('range')) return fetch(req);
  const key = mediaCacheKey(req.url);
  const cache = await caches.open(MEDIA_CACHE);
  const idx = await loadIndex(cache);
  const hit = await cache.match(key);
  if (hit) {
    const e = idx[key];
    idx[key] = { size: e?.size ?? 0, at: Date.now() };
    saveIndexSoon();
    return hit;
  }
  let res: Response;
  if (req.mode === 'no-cors') {
    // An <img> without crossorigin asks no-cors and gets an opaque response that
    // cannot be measured and is padded to megabytes in the quota: ask with CORS.
    try {
      res = await fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }));
    } catch {
      return fetch(req);
    }
  } else {
    res = await fetch(req);
  }
  if (res.status === 200 && res.type !== 'opaque') {
    try {
      const copy = res.clone();
      const declared = Number(copy.headers.get('content-length'));
      const blob = Number.isFinite(declared) && declared > MEDIA_MAX_ITEM_BYTES ? null : await copy.blob();
      if (blob && blob.size <= MEDIA_MAX_ITEM_BYTES) {
        await cache.put(key, new Response(blob, { status: 200, headers: res.headers }));
        idx[key] = { size: blob.size, at: Date.now() };
        for (const old of planEviction(idx)) {
          delete idx[old];
          await cache.delete(old);
        }
        saveIndexSoon();
      }
    } catch {
      /* caching is a bonus; the response still goes to the page */
    }
  }
  return res;
}

async function wipeMedia(): Promise<void> {
  index = {};
  indexLoading = null;
  if (indexTimer) clearTimeout(indexTimer);
  indexTimer = null;
  await caches.delete(MEDIA_CACHE);
}

async function purgeMedia(prefixes: string[]): Promise<void> {
  if (prefixes.length === 0) return;
  const cache = await caches.open(MEDIA_CACHE);
  const idx = await loadIndex(cache);
  for (const req of await cache.keys()) {
    if (matchesPrefix(req.url, prefixes)) {
      await cache.delete(req);
      delete idx[req.url];
    }
  }
  saveIndexSoon();
}

// ------------------------------------------------------------------ push

type DekNotificationOptions = NotificationOptions & { renotify?: boolean; timestamp?: number };
type BadgeNavigator = WorkerNavigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

self.addEventListener('push', (event) => {
  event.waitUntil(onPush(event.data ? event.data.text() : null));
});

async function onPush(text: string | null): Promise<void> {
  const p = parsePushData(text);
  const url = safeTargetUrl(p.url, ORIGIN);
  const tag = tagFor({ ...p, url }, ORIGIN);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const chromium = isChromiumUA(self.navigator.userAgent);
  const contexts = await Promise.all(windows.map(async client => {
    const shown = chromium && client.focused && client.visibilityState === 'visible' ? await visibleContext(client) : {};
    return { client, url: client.url, focused: client.focused, visibilityState: client.visibilityState, ...shown };
  }));
  const target = suppressFor({ ...p, url }, contexts, chromium, ORIGIN)?.client;
  if (target) {
    target.postMessage({ type: 'push', suppressed: true, tag, url, kind: p.kind ?? null, intent_id: p.intent_id ?? null });
    return;
  }
  try {
    await (self.navigator as BadgeNavigator).setAppBadge?.();
  } catch {
    /* badges are optional */
  }
  const stale = isStale(p, Date.now());
  const options: DekNotificationOptions = {
    body: p.body ?? '',
    tag,
    renotify: !stale,
    silent: stale,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    timestamp: p.ts ?? Date.now(),
    requireInteraction: p.kind === 'call',
    data: { url, org_id: p.org_id ?? null, kind: p.kind ?? 'message', intent_id: p.intent_id ?? null },
  };
  await self.registration.showNotification(p.title || 'Dek', options);
  // The health screen tells "the push service accepted it" apart from "this
  // device displayed it" (DEK19): this is the second half.
  for (const w of windows) w.postMessage({ type: 'push-shown', tag, kind: p.kind ?? null, intent_id: p.intent_id ?? null, at: Date.now() });
}

// A focused desktop can show main and thread side by side. Phone/tablet cannot.
// Ask the live page; an old/nonresponsive page gets conservative exact-URL matching.
function visibleContext(client: WindowClient): Promise<{ url?: string; channelVisible?: boolean;threadVisible?:boolean }> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve({}); }, 250);
    channel.port1.onmessage = event => {
      clearTimeout(timer); channel.port1.close();
      const d = event.data;
      try {
        resolve(d && typeof d.url === 'string' && new URL(d.url, ORIGIN).origin === ORIGIN
          ? { url: d.url, channelVisible: d.channelVisible === true,threadVisible:d.threadVisible===true } : {});
      } catch { resolve({}); }
    };
    try { client.postMessage({ type: 'visible-context' }, [channel.port2]); }
    catch { clearTimeout(timer); channel.port1.close(); resolve({}); }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { url?: string };
  const url = safeTargetUrl(data.url, ORIGIN);
  event.waitUntil((async () => {
    try {
      await (self.navigator as BadgeNavigator).clearAppBadge?.();
    } catch {
      /* optional */
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = pickWindow(windows, url, ORIGIN);
    if (target) {
      try {
        await target.focus();
      } catch {
        /* focus can be refused; the navigate message still lands */
      }
      target.postMessage({ type: 'navigate', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// The browser rotated the subscription: subscribe again with the same server key
// and ask open pages to register it (the worker has no session to do it itself).
self.addEventListener('pushsubscriptionchange', ((event: ExtendableEvent & { oldSubscription?: PushSubscription | null }) => {
  event.waitUntil((async () => {
    const key = event.oldSubscription?.options?.applicationServerKey ?? null;
    if (key) {
      try {
        await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch {
        /* the page re-subscribes on its next start */
      }
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) w.postMessage({ type: 'push-resubscribe' });
  })());
}) as EventListener);
