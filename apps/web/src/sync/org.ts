// Organization context (DEK01). Switching is a deliberate, complete change: the
// previous organization's channels, messages, threads and typing leave memory, its
// view topics are left, the brand color changes (--org, --org-fg) and the realtime
// topics are replaced. Nothing from one organization is shown inside another.
import { api } from '../api/rpc';
import { toDekError } from '../api/errors';
import type { BootstrapResult, Channel, MeResult, OrgSummary, Server } from '../api/types';
import { currentRoute, navigate } from '../app/router';
import { applyBrand } from '../lib/color';
import { hub } from '../realtime/hub';
import { getState, setState } from '../store/state';
import { toast } from '../ui/kit';
import { lastOrg, rememberOrg } from './local';
import { mergeProfiles } from './profiles';
import { channelReads } from './read';
import { purgeLocal,purgeOrgLocal } from './access';
import { loadSavedIds } from './saved';
import {
  clearOpen, currentAccessGen,currentOrgGen, currentSessionGen, nextOrgGen, noteServerTime, openChannels, runtime, serverNowIso,
} from './runtime';

const REFRESH_DEBOUNCE_MS = 1_000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing: { gen:number; dirty:boolean; promise:Promise<void> } | null = null;
let summariesDirty=false;
let summaryRetries=0;
let moderationTimer: ReturnType<typeof setTimeout> | null = null;

// A single in-app expiry deadline. No polling: before a long deadline only
// re-arm the timer; at expiry repaint time-based guards and fetch one snapshot.
export function refreshModerationDeadline(): void {
  if (moderationTimer) clearTimeout(moderationTimer);
  moderationTimer = null;
  const state = getState();
  const now = Date.parse(serverNowIso());
  const deadlines = Object.values(state.servers).map(s => Date.parse(s.moderation?.muted_until ?? ''))
    .filter(t => Number.isFinite(t) && t > now);
  if (!deadlines.length) return;
  const deadline = Math.min(...deadlines);
  const gen = currentOrgGen(), session = currentSessionGen(), org = state.orgId;
  moderationTimer = setTimeout(() => {
    moderationTimer = null;
    if (gen !== currentOrgGen() || session !== currentSessionGen() || org !== getState().orgId) return;
    if (Date.parse(serverNowIso()) < deadline) { refreshModerationDeadline(); return; }
    setState({ servers: { ...getState().servers } });
    scheduleBootstrapRefresh(0);
  }, Math.min(deadline - now + 100, 86_400_000));
}

// session.ts registers its start routine here (it imports this module, so this
// module cannot import it back).
let startHook: (() => Promise<void>) | null = null;
export function setStartHook(fn: () => Promise<void>): void {
  startHook = fn;
}

function byId<T extends { id: string }>(list: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const x of list) out[x.id] = x;
  return out;
}

// Route org, else the last used org for this person, else the first.
export function pickOrg(orgs: readonly OrgSummary[], routeOrgId: string | null, remembered: string | null): string | null {
  if (routeOrgId && orgs.some((o) => o.id === routeOrgId)) return routeOrgId;
  if (remembered && orgs.some((o) => o.id === remembered)) return remembered;
  return orgs[0]?.id ?? null;
}

export function routeOrgId(): string | null {
  const r = currentRoute();
  return 'orgId' in r ? r.orgId : null;
}

// ---------------------------------------------------------------- me

export async function refreshMe(): Promise<MeResult> {
  const gen = currentSessionGen();
  const access=currentAccessGen();
  const me = await api.me();
  if (gen !== currentSessionGen()) return me;
  if(access!==currentAccessGen())return refreshMe();
  setState({ me, orgs: me.orgs });
  mergeProfiles([me.profile]);
  void saveMeta('me', me);
  return me;
}

// ---------------------------------------------------------------- select

export async function selectOrg(orgId: string, opts: { force?: boolean } = {}): Promise<void> {
  const s = getState();
  const uid = s.session.userId;
  if (!uid) return;
  if (!opts.force && s.orgId === orgId && (s.bootstrap.status === 'ready' || s.bootstrap.status === 'loading')) return;
  let summary = s.orgs.find((o) => o.id === orgId);
  if (!summary) {
    // Maybe just joined (an invite accepted in another tab): ask once.
    try {
      const me = await refreshMe();
      summary = me.orgs.find((o) => o.id === orgId);
    } catch {
      summary = undefined;
    }
    if (!summary) {
      toast({ kind: 'error', title: 'That organization is not available to you.' });
      const fallback = getState().orgId;
      navigate(fallback ? { name: 'org', orgId: fallback } : { name: 'home' }, { replace: true });
      return;
    }
  }
  const gen = nextOrgGen();
  if (moderationTimer) clearTimeout(moderationTimer);
  moderationTimer = null;
  // Leave the previous organization completely.
  for (const id of openChannels()) hub.leaveView(id);
  clearOpen();
  setState({
    orgId,
    org: null,
    bootstrap: { status: 'loading', error: null, at: null },
    servers: {},
    channels: {},
    messages: {},
    timelines: {},
    threads: {},
    typing: {},
    saved: {},
  });
  applyBrand(summary.brand_color);
  rememberOrg(uid, orgId);
  await loadBootstrap(gen, { paintCache: true });
}

async function loadBootstrap(gen: number, opts: { paintCache?: boolean } = {}): Promise<void> {
  const orgId = getState().orgId;
  if (!orgId) return;
  const sentAt = Date.now();
  const access=currentAccessGen();
  try {
    const b = await api.bootstrap(orgId);
    if (gen !== currentOrgGen()) return;
    if(access!==currentAccessGen()) {scheduleBootstrapRefresh();return;}
    noteServerTime(b.server_time, sentAt, Date.now());
    applyBootstrap(b);
    void saveMeta(`bootstrap:${orgId}`, b);
    // Bookmarks with every fresh bootstrap: at the start, and after a reconnect
    // (a saved.upd missed while away).
    void loadSavedIds(orgId);
  } catch (e) {
    if (gen !== currentOrgGen()) return;
    const err = toDekError(e);
    if (err.code === 'not_found' || err.code === 'forbidden' || err.code==='suspended') {
      await orgGone(orgId);
      return;
    }
    // Offline or a server problem: show the last copy if we have one, keep the
    // error so the shell can offer Try again, and retry when the network returns.
    if (opts.paintCache && getState().bootstrap.status !== 'ready') {
      const cached = await readMeta<BootstrapResult>(`bootstrap:${orgId}`);
      if (cached && gen === currentOrgGen()) {
        applyBootstrap(cached, { offline: true });
        setState({ bootstrap: { status: 'ready', error: err.hint, at: null } });
        return;
      }
    }
    if (getState().bootstrap.status !== 'ready') setState({ bootstrap: { status: 'error', error: err.hint, at: null } });
  }
}

export function applyBootstrap(b: BootstrapResult, opts: { offline?: boolean } = {}): void {
  const s = getState();
  const channels: Record<string, Channel> = {};
  for (const c of b.channels) {
    // A read this tab made that the server has not confirmed yet stays read.
    const floor = channelReads.floor(c.id);
    if (floor > c.last_read_seq) {
      channels[c.id] = floor >= c.last_seq ? { ...c, last_read_seq: floor, unread: 0, mentions: 0 } : { ...c, last_read_seq: floor };
    } else {
      channels[c.id] = c;
    }
  }
  // Channels that disappeared since the last bootstrap: access went while we were
  // away. Purge what we hold for them.
  const gone = new Set<string>();
  if (s.bootstrap.status === 'ready' && !opts.offline) {
    for (const id of Object.keys(s.channels)) if (!channels[id]) gone.add(id);
  }
  const servers: Record<string, Server> = byId(b.servers);
  const lostServerScope=!opts.offline&&s.bootstrap.status==='ready'&&Object.values(s.servers).some(old=>old.my_role!==null&&(!servers[old.id]||servers[old.id]!.my_role===null));
  if(gone.size||lostServerScope)purgeLocal(gone,s.orgId);
  const orgs = s.orgs.map((o) => (o.id === b.org.id ? { ...o, ...b.org } : o));
  setState({
    org: b.org,
    servers,
    channels,
    topics: b.topics,
    orgs,
    bootstrap: { status: 'ready', error: null, at: Date.now() },
  });
  refreshModerationDeadline();
  applyBrand(b.org.brand_color);
  mergeProfiles(b.profiles, Date.now(), !opts.offline);
  hub.setTopics(b.topics);
}

// The last copy of an organization, on screen without asking the network (an
// offline start, or a start while sign-in cannot refresh its token). Marked as a
// copy (bootstrap.at null) so the first good answer replaces it in place.
export async function paintCachedOrg(orgId: string, hint: string): Promise<boolean> {
  const cached = await readMeta<BootstrapResult>(`bootstrap:${orgId}`);
  if (!cached) return false;
  const uid = getState().session.userId;
  nextOrgGen();
  for (const id of openChannels()) hub.leaveView(id);
  clearOpen();
  setState({
    orgId, org: null, servers: {}, channels: {}, messages: {}, timelines: {}, threads: {}, typing: {}, saved: {},
    bootstrap: { status: 'loading', error: null, at: null },
  });
  if (uid) rememberOrg(uid, orgId);
  applyBootstrap(cached, { offline: true });
  setState({ bootstrap: { status: 'ready', error: hint, at: null } });
  return true;
}

// ---------------------------------------------------------------- refresh

export async function refreshBootstrap(): Promise<void> {
  const s = getState();
  if (!s.session.userId) return;
  if (!s.orgId) {
    // Nothing selected yet (the start failed or there is no organization): start over.
    await startHook?.();
    return;
  }
  const gen=currentOrgGen();
  if (refreshing?.gen===gen) {refreshing.dirty=true;return refreshing.promise;}
  if(refreshTimer) {clearTimeout(refreshTimer);refreshTimer=null;}
  const request={gen,dirty:false,promise:Promise.resolve()};
  refreshing=request;
  request.promise=loadBootstrap(gen).then(async()=>{if(gen===currentOrgGen()&&summariesDirty){summariesDirty=false;try{await refreshMe();summaryRetries=0;}catch{summariesDirty=true;summaryRetries+=1;}}}).finally(() => {
    if(refreshing!==request)return;
    refreshing=null;
    // The in-flight snapshot may predate a confirmed read/edit. Keep a bounded,
    // coalesced follow-up instead of discarding that newer refresh request.
    if(request.dirty&&gen===currentOrgGen())scheduleBootstrapRefresh();
    else if(summariesDirty&&summaryRetries<=3&&gen===currentOrgGen())scheduleBootstrapRefresh(1000*2**summaryRetries);
  });
  return request.promise;
}

export function scheduleSummaryRefresh():void {summariesDirty=true;summaryRetries=0;scheduleBootstrapRefresh();}

export function scheduleBootstrapRefresh(delay = REFRESH_DEBOUNCE_MS): void {
  if(refreshing?.gen===currentOrgGen()) {refreshing.dirty=true;return;}
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshBootstrap();
  }, delay);
}

export function resetOrg(): void {
  if (moderationTimer) clearTimeout(moderationTimer);
  moderationTimer = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  refreshing = null;
  summariesDirty=false;
  summaryRetries=0;
}

// The current organization is gone for this person (removed, left, suspended into
// not_found): switch to another one or say so.
export async function orgGone(orgId: string, notice?: string): Promise<void> {
  const owner=getState().session.userId;
  await purgeOrgLocal(orgId);
  if(getState().session.userId!==owner)return;
  const s = getState();
  const name = s.orgs.find((o) => o.id === orgId)?.name ?? s.org?.name ?? 'that organization';
  const orgs = s.orgs.filter((o) => o.id !== orgId);
  const me = s.me ? { ...s.me, orgs } : s.me;
  setState({ orgs, me });
  if (s.orgId !== orgId) return;
  const uid = s.session.userId;
  if (uid && lastOrg(uid) === orgId) rememberOrg(uid, null);
  toast({ kind: 'info', title: notice ?? `You are no longer a member of ${name}.`, duration: 8_000 });
  for (const id of openChannels()) hub.leaveView(id);
  clearOpen();
  const next = orgs[0];
  if (next) {
    navigate({ name: 'org', orgId: next.id }, { replace: true });
    await selectOrg(next.id, { force: true });
    return;
  }
  nextOrgGen();
  setState({
    orgId: null, org: null, servers: {}, channels: {}, messages: {}, timelines: {}, threads: {}, typing: {}, saved: {},
    bootstrap: { status: 'ready', error: null, at: Date.now() },
  });
  hub.setTopics(uid ? [`u:${uid}`] : []);
  navigate({ name: 'home' }, { replace: true });
}

// ---------------------------------------------------------------- offline copies

async function saveMeta(key: string, value: unknown): Promise<void> {
  const rt = runtime();
  const access=currentAccessGen();
  if (!rt) return;
  const db = await rt.db;
  if (db.ok && runtime()===rt && access===currentAccessGen()) await db.put('meta', { key, value, savedAt: Date.now() });
}

export async function readMeta<T>(key: string): Promise<T | null> {
  const rt = runtime();
  if (!rt) return null;
  const db = await rt.db;
  if (!db.ok) return null;
  const row = await db.get<{ key: string; value: T }>('meta', key);
  return row?.value ?? null;
}

export function rememberedOrg(): string | null {
  const uid = getState().session.userId;
  return uid ? lastOrg(uid) : null;
}
