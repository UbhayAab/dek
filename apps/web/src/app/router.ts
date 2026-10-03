// URL routes (DEK04, DEK18). Pure parse and format functions plus a tiny history
// store, so deep links from notifications and back navigation behave the same on
// the web, the installed PWA and the native shells.
import { useSyncExternalStore } from 'react';

export type AdminSection = 'overview' | 'members' | 'invites' | 'requests' | 'reports' | 'audit' | 'servers';
export type SettingsSection = 'profile' | 'notifications' | 'health' | 'devices' | 'appearance' | 'install' | 'account' | 'blocked';
export type OrgView = 'unread' | 'mentions' | 'threads' | 'saved' | 'dms' | 'activity';

export type Route =
  | { name: 'signin'; next: string | null }
  | { name: 'invite'; code: string }
  | { name: 'home' }
  | { name: 'org'; orgId: string }
  | { name: 'channel'; orgId: string; channelId: string; messageId: string | null; threadId: string | null; threadMessageId: string | null }
  | { name: 'call'; orgId: string; callId: string }
  | { name: 'view'; orgId: string; view: OrgView }
  | { name: 'search'; orgId: string; q: string }
  | { name: 'browse'; orgId: string; serverId: string | null }
  | { name: 'serverSettings'; orgId: string; serverId: string }
  | { name: 'channelSettings'; orgId: string; channelId: string }
  | { name: 'admin'; orgId: string; section: AdminSection }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'legacyChannel'; channelId: string; messageId: string | null }
  | { name: 'notFound'; path: string };

const ORG_VIEWS: readonly OrgView[] = ['unread', 'mentions', 'threads', 'saved', 'dms', 'activity'];
const ADMIN: readonly AdminSection[] = ['overview', 'members', 'invites', 'requests', 'reports', 'audit', 'servers'];
const SETTINGS: readonly SettingsSection[] = ['profile', 'notifications', 'health', 'devices', 'appearance', 'install', 'account', 'blocked'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9]{8,64}$/;
const isId = (s: string | undefined): s is string => !!s && UUID.test(s);

function seg(path: string): string[] {
  return path.split('?')[0]!.split('#')[0]!.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
}

export function parse(href: string): Route {
  const url = new URL(href, 'https://dek.local');
  const p = seg(url.pathname);
  const q = url.searchParams;

  // Legacy hash links (#/c/<channel>, #/c/<channel>/m/<message>, #/d/<conversation>,
  // #/invite/<token>) keep working: old notifications and bookmarks still open.
  if (p.length === 0 && url.hash.startsWith('#/')) {
    const h = seg(url.hash.slice(1));
    if ((h[0] === 'c' || h[0] === 'd') && isId(h[1])) {
      return { name: 'legacyChannel', channelId: h[1], messageId: h[2] === 'm' && isId(h[3]) ? h[3] : null };
    }
    if (h[0] === 'invite' && h[1] && CODE.test(h[1])) return { name: 'invite', code: h[1] };
  }

  if (p.length === 0) return { name: 'home' };
  if (p[0] === 'signin' && p.length === 1) return { name: 'signin', next: safeNext(q.get('next')) };
  if (p[0] === 'invite' && p[1] && CODE.test(p[1]) && p.length === 2) return { name: 'invite', code: p[1] };
  if (p[0] === 'settings') {
    const section = (p[1] ?? 'profile') as SettingsSection;
    if (SETTINGS.includes(section) && p.length <= 2) return { name: 'settings', section };
  }
  if (p[0] === 'c' && isId(p[1])) {
    return { name: 'legacyChannel', channelId: p[1], messageId: p[2] === 'm' && isId(p[3]) ? p[3] : null };
  }
  if (p[0] === 'o' && isId(p[1])) {
    const orgId = p[1];
    const rest = p.slice(2);
    if (rest.length === 0) return { name: 'org', orgId };
    const [a, b, c, d, e, f] = rest;
    if (a === 'c' && isId(b)) {
      if (c === 'settings' && rest.length === 3) return { name: 'channelSettings', orgId, channelId: b };
      if (rest.length === 2) return { name: 'channel', orgId, channelId: b, messageId: null, threadId: null, threadMessageId: null };
      if (c === 'm' && isId(d) && rest.length === 4) return { name: 'channel', orgId, channelId: b, messageId: d, threadId: null, threadMessageId: null };
      if (c === 't' && isId(d)) {
        if (rest.length === 4) return { name: 'channel', orgId, channelId: b, messageId: null, threadId: d, threadMessageId: null };
        if (e === 'm' && isId(f) && rest.length === 6) return { name: 'channel', orgId, channelId: b, messageId: null, threadId: d, threadMessageId: f };
      }
    }
    if (a === 'call' && isId(b) && rest.length === 2) return { name: 'call', orgId, callId: b };
    if (a && ORG_VIEWS.includes(a as OrgView) && rest.length === 1) return { name: 'view', orgId, view: a as OrgView };
    if (a === 'search' && rest.length === 1) return { name: 'search', orgId, q: q.get('q') ?? '' };
    if (a === 'browse' && rest.length === 1) return { name: 'browse', orgId, serverId: null };
    if (a === 'browse' && isId(b) && rest.length === 2) return { name: 'browse', orgId, serverId: b };
    if (a === 's' && isId(b) && c === 'settings' && rest.length === 3) return { name: 'serverSettings', orgId, serverId: b };
    if (a === 'admin') {
      const section = (b ?? 'overview') as AdminSection;
      if (ADMIN.includes(section) && rest.length <= 2) return { name: 'admin', orgId, section };
    }
  }
  return { name: 'notFound', path: url.pathname };
}

// Only same-app relative paths may be used as a post-sign-in destination.
function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}

export function href(r: Route): string {
  switch (r.name) {
    case 'signin': return r.next ? `/signin?next=${encodeURIComponent(r.next)}` : '/signin';
    case 'invite': return `/invite/${r.code}`;
    case 'home': return '/';
    case 'org': return `/o/${r.orgId}`;
    case 'channel': {
      const base = `/o/${r.orgId}/c/${r.channelId}`;
      if (r.threadId) return r.threadMessageId ? `${base}/t/${r.threadId}/m/${r.threadMessageId}` : `${base}/t/${r.threadId}`;
      return r.messageId ? `${base}/m/${r.messageId}` : base;
    }
    case 'call': return `/o/${r.orgId}/call/${r.callId}`;
    case 'view': return `/o/${r.orgId}/${r.view}`;
    case 'search': return r.q ? `/o/${r.orgId}/search?q=${encodeURIComponent(r.q)}` : `/o/${r.orgId}/search`;
    case 'browse': return r.serverId ? `/o/${r.orgId}/browse/${r.serverId}` : `/o/${r.orgId}/browse`;
    case 'serverSettings': return `/o/${r.orgId}/s/${r.serverId}/settings`;
    case 'channelSettings': return `/o/${r.orgId}/c/${r.channelId}/settings`;
    case 'admin': return r.section === 'overview' ? `/o/${r.orgId}/admin` : `/o/${r.orgId}/admin/${r.section}`;
    case 'settings': return `/settings/${r.section}`;
    case 'legacyChannel': return r.messageId ? `/c/${r.channelId}/m/${r.messageId}` : `/c/${r.channelId}`;
    case 'notFound': return r.path;
  }
}

export function channelRoute(orgId: string, channelId: string, extra: Partial<{ messageId: string | null; threadId: string | null; threadMessageId: string | null }> = {}): Route {
  return { name: 'channel', orgId, channelId, messageId: extra.messageId ?? null, threadId: extra.threadId ?? null, threadMessageId: extra.threadMessageId ?? null };
}

// ---------------------------------------------------------------- history store

type Listener = () => void;
const listeners = new Set<Listener>();
let current: { href: string; route: Route } | null = null;

function read(): { href: string; route: Route } {
  const h = typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search + window.location.hash;
  if (!current || current.href !== h) current = { href: h, route: parse(h) };
  return current;
}

function emit(): void {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', emit);
}

export function navigate(to: Route | string, opts: { replace?: boolean } = {}): void {
  const target = typeof to === 'string' ? to : href(to);
  const now = window.location.pathname + window.location.search + window.location.hash;
  if (target === now) return;
  if (opts.replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  emit();
}

// In-app back: history when there is in-app history, otherwise the given parent.
let depth = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => { depth = Math.max(0, depth - 1); });
}
export function navigateDeeper(to: Route | string): void {
  depth += 1;
  navigate(to);
}
export function back(fallback: Route | string): void {
  if (depth > 0) {
    window.history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}

export function currentRoute(): Route {
  return read().route;
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => read().route,
    () => ({ name: 'home' }) as Route,
  );
}
