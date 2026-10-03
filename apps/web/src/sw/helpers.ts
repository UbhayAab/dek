// Pure helpers shared by the service worker (sw.ts) and the page (register.ts),
// unit tested in tests/platform/sw-helpers.test.ts. No globals here.

export const SHELL_PREFIX = 'dek-shell-';
export const MEDIA_CACHE = 'dek-media-v1';
export const MEDIA_INDEX_KEY = '/__dek_media_index__';
export const MEDIA_MAX_BYTES = 150 * 1024 * 1024;
export const MEDIA_MAX_ENTRIES = 500;
export const MEDIA_MAX_ITEM_BYTES = 25 * 1024 * 1024;
export const STALE_PUSH_MS = 60 * 60 * 1000;
const MEDIA_PATH = '/storage/v1/object/sign/media/';

// What push-dispatch sends (supabase/functions/push-dispatch/lib.ts buildPayload).
export interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  org_id?: string | null;
  org?: string | null;
  kind?: string;
  intent_id?: number;
  ts?: number;
}

export function parsePushData(text: string | null | undefined): PushPayload {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object') return { body: String(text).slice(0, 500) };
    const o = v as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
    const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
    return {
      title: str('title'),
      body: str('body'),
      url: str('url'),
      tag: str('tag'),
      org_id: str('org_id') ?? null,
      org: str('org') ?? null,
      kind: str('kind'),
      intent_id: num('intent_id'),
      ts: num('ts'),
    };
  } catch {
    return { body: String(text).slice(0, 500) };
  }
}

export interface Conversation {
  orgId: string | null;
  channelId: string;
  threadId: string | null;
}

const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const CONV = new RegExp(`^/o/(${ID})/c/(${ID})(?:/t/(${ID}))?(?:/|$)`);
const LEGACY = new RegExp(`^/c/(${ID})(?:/|$)`);

function pathOf(url: string, origin: string): string | null {
  try {
    return new URL(url, origin).pathname;
  } catch {
    return null;
  }
}

// The conversation a URL shows: /o/<org>/c/<channel>[/t/<thread>][/m/<message>].
export function conversationOf(url: string, origin = 'https://dek.local'): Conversation | null {
  const path = pathOf(url, origin);
  if (!path) return null;
  const m = CONV.exec(path);
  if (m) return { orgId: m[1]!.toLowerCase(), channelId: m[2]!.toLowerCase(), threadId: m[3]?.toLowerCase() ?? null };
  const l = LEGACY.exec(path);
  if (l) return { orgId: null, channelId: l[1]!.toLowerCase(), threadId: null };
  return null;
}

// One tag per conversation (the server sends c:<channel>, t:<root> or call:<id>),
// so a phone replaces the previous alert instead of stacking them.
export function tagFor(p: PushPayload, origin = 'https://dek.local'): string {
  if (p.tag && p.tag.length <= 200) return p.tag;
  const path = p.url ? pathOf(p.url, origin) : null;
  if (path) {
    const call = new RegExp(`^/o/${ID}/call/(${ID})`).exec(path);
    if (call) return `call:${call[1]!.toLowerCase()}`;
  }
  const conv = p.url ? conversationOf(p.url, origin) : null;
  if (conv) return conv.threadId ? `t:${conv.threadId}` : `c:${conv.channelId}`;
  return 'dek';
}

// Does a window at clientUrl already show the conversation pushUrl points to?
// A channel message: that channel is open. A thread reply: that thread is open.
export function sameConversation(pushUrl: string, clientUrl: string, origin = 'https://dek.local'): boolean {
  const a = conversationOf(pushUrl, origin);
  const b = conversationOf(clientUrl, origin);
  if (!a || !b || a.channelId !== b.channelId) return false;
  if (a.orgId && b.orgId && a.orgId !== b.orgId) return false;
  if (a.threadId) return b.threadId === a.threadId;
  return true;
}

export interface WindowLike {
  url: string;
  focused: boolean;
  visibilityState: string;
}

export function isChromiumUA(ua: string): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return false;   // every iOS browser is WebKit
  return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
}

// Chromium only (DEK17): skip the OS notification when a focused, visible window
// already shows that conversation, and tell that window instead. WebKit revokes
// subscriptions whose pushes show nothing, and Firefox counts silent pushes against
// a quota, so there the notification is ALWAYS shown. Calls and test notifications
// always show.
export function suppressFor<T extends WindowLike>(p: PushPayload, windows: readonly T[], chromium: boolean, origin = 'https://dek.local'): T | null {
  if (!chromium || !p.url) return null;
  if (p.kind === 'test' || p.kind === 'call') return null;
  return windows.find((w) => w.focused && w.visibilityState === 'visible' && sameConversation(p.url!, w.url, origin)) ?? null;
}

export function isStale(p: PushPayload, now: number): boolean {
  return typeof p.ts === 'number' && now - p.ts > STALE_PUSH_MS;
}

// Only same-origin paths may be opened from a notification.
export function safeTargetUrl(url: string | null | undefined, origin: string): string {
  if (!url) return '/';
  try {
    const u = new URL(url, origin);
    if (u.origin !== origin) return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

// Which open window a tap should go to: one already in that conversation, else
// the focused one, else a visible one, else any.
export function pickWindow<T extends WindowLike>(windows: readonly T[], url: string, origin = 'https://dek.local'): T | null {
  return windows.find((w) => sameConversation(url, w.url, origin))
    ?? windows.find((w) => w.focused)
    ?? windows.find((w) => w.visibilityState === 'visible')
    ?? windows[0]
    ?? null;
}

// ---------------------------------------------------------------- media cache

export function isMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.pathname.startsWith(MEDIA_PATH);
  } catch {
    return false;
  }
}

// Signed URLs carry ?token=...; the cache key is the object path without it, so a
// fresh signature for the same file is a cache hit.
export function mediaCacheKey(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

// "<org>/<channel>/<attachment>/<name>" for a cache key (used for purges).
export function mediaObjectPath(key: string): string | null {
  try {
    const p = new URL(key).pathname;
    if (!p.startsWith(MEDIA_PATH)) return null;
    return decodeURIComponent(p.slice(MEDIA_PATH.length));
  } catch {
    return null;
  }
}

export function matchesPrefix(key: string, prefixes: readonly string[]): boolean {
  const path = mediaObjectPath(key);
  return !!path && prefixes.some((p) => p.length > 0 && path.startsWith(p));
}

export interface IndexEntry {
  size: number;
  at: number;
}

// Least recently used first, until both limits hold.
export function planEviction(index: Record<string, IndexEntry>, maxBytes = MEDIA_MAX_BYTES, maxEntries = MEDIA_MAX_ENTRIES): string[] {
  const entries = Object.entries(index).sort((a, b) => a[1].at - b[1].at);
  let bytes = entries.reduce((n, [, e]) => n + Math.max(0, e.size), 0);
  let count = entries.length;
  const out: string[] = [];
  for (const [key, e] of entries) {
    if (bytes <= maxBytes && count <= maxEntries) break;
    out.push(key);
    bytes -= Math.max(0, e.size);
    count -= 1;
  }
  return out;
}
