// Channel history (DEK07, DEK08): bounded pages, a cached page painted instantly,
// deep links around a message, pagination both ways, and healing by cursor after a
// reconnect or a hole. Nothing ever reloads a whole history.
import { api } from '../api/rpc';
import { humanError, toDekError } from '../api/errors';
import type { BootstrapResult,MeResult,Message, SyncResult } from '../api/types';
import { limits } from '../config';
import { clearConversationNotifications, isNativeApp } from '../native';
import { hub } from '../realtime/hub';
import { clearWebNotifications } from '../sw/register';
import { getState, setState } from '../store/state';
import type { DekState, Timeline } from '../store/state';
import { ensureProfiles } from './profiles';
import { emptyTimeline, inTimeline, mergeIds, mergeMessages, dropPendingByClientId } from './reducers';
import {
  currentOrgGen, isOpen, markClosed, markOpen, openChannels, runtime, serverNowIso,
} from './runtime';

const PAGE = limits.pageSize;
const CACHE_SIZE = 50;
const KEEP_TIMELINES = 8;
const CACHE_WRITE_MS = 1_000;
const GAP_WAIT_MS = 1_500;
const CHANGED_MARGIN_MS = 30_000;    // sync_channel: "a little before the server time" (in-flight transactions)
const FAR_FUTURE = '9999-12-31T00:00:00Z';

interface PageRecord {
  channelId: string;
  orgId: string;
  messages: Message[];
  lastSeq: number;
  savedAt: number;
}

const loadGen = new Map<string, number>();
const healing = new Map<string, Promise<void>>();
const cacheTimers = new Map<string, ReturnType<typeof setTimeout>>();
const gapTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recent: string[] = [];

function bump(channelId: string): number {
  const n = (loadGen.get(channelId) ?? 0) + 1;
  loadGen.set(channelId, n);
  return n;
}

function current(channelId: string, gen: number, orgGen: number): boolean {
  return (loadGen.get(channelId) ?? 0) === gen && currentOrgGen() === orgGen && !!getState().channels[channelId];
}
export function invalidateChannelLoads(ids:ReadonlySet<string>):void {
  for(const id of ids) {
    bump(id);healing.delete(id);
    const gap=gapTimers.get(id);if(gap)clearTimeout(gap);gapTimers.delete(id);
  }
}

function setTimeline(channelId: string, update: (t: Timeline) => Timeline): void {
  const s = getState();
  const tl = s.timelines[channelId] ?? emptyTimeline();
  setState({ timelines: { ...s.timelines, [channelId]: update(tl) } });
}

function authorsOf(list: readonly Message[]): string[] {
  const out = new Set<string>();
  for (const m of list) {
    if (m.author_id) out.add(m.author_id);
    for (const u of m.mentions) out.add(u);
  }
  return Array.from(out);
}

function sortBySeq(list: Message[]): Message[] {
  return list.slice().sort((a, b) => a.seq - b.seq);
}

function touch(channelId: string): void {
  const i = recent.indexOf(channelId);
  if (i >= 0) recent.splice(i, 1);
  recent.push(channelId);
}

// ---------------------------------------------------------------- open / close

// The conversation is on screen: its notifications leave the tray (DEK17).
export function clearNotificationsFor(channelId: string, threadRootId: string | null = null): void {
  if (isNativeApp()) {
    void clearConversationNotifications(channelId, threadRootId);
    return;
  }
  void clearWebNotifications(threadRootId ? [`t:${threadRootId}`] : [`c:${channelId}`]);
}

export async function openChannel(channelId: string, opts: { aroundMessageId?: string | null; visible?: boolean } = {}): Promise<void> {
  if (markOpen(channelId) === 1) hub.joinView(channelId);
  if (opts.visible !== false) clearNotificationsFor(channelId);
  touch(channelId);
  const aroundId = opts.aroundMessageId ?? null;
  const gen = bump(channelId);
  const orgGen = currentOrgGen();
  // Loads started before this open answer to an old generation and are dropped:
  // their spinners must not stay on.
  settleSubLoad(channelId, orgGen, 'olderStatus');
  settleSubLoad(channelId, orgGen, 'newerStatus');
  const before = getState().timelines[channelId];

  // Re-opening a live timeline still in memory: heal by cursor, no reload.
  if (!aroundId && before && before.status === 'ready' && !before.hasMoreAfter && !before.fromCache && before.lastSeq > 0) {
    await healChannel(channelId);
    return;
  }

  if (!aroundId && (!before || before.ids.length === 0)) await paintFromCache(channelId, gen, orgGen);
  if (!current(channelId, gen, orgGen)) return;
  setTimeline(channelId, (t) => ({ ...t, status: 'loading', error: null }));

  try {
    if (aroundId) await loadAround(channelId, aroundId, gen, orgGen);
    else await loadNewest(channelId, gen, orgGen);
  } catch (e) {
    if (!current(channelId, gen, orgGen)) return;
    setTimeline(channelId, (t) => ({ ...t, status: 'error', error: humanError(e) }));
  }
}

export function closeChannel(channelId: string): void {
  if (markClosed(channelId) === 0) {
    hub.leaveView(channelId);
    scheduleCacheWrite(channelId, 0);
    evict();
  }
}

async function loadNewest(channelId: string, gen: number, orgGen: number): Promise<void> {
  const startedAt = serverNowIso();
  const page = await api.listMessages(channelId, null, PAGE);
  if (!current(channelId, gen, orgGen)) return;
  const list = sortBySeq(page.messages);
  const s = getState();
  const messages = mergeMessages(s.messages, list);
  setState({
    messages,
    timelines: {
      ...s.timelines,
      [channelId]: emptyTimeline({
        ids: withLiveArrivals(list, s.timelines[channelId]?.ids ?? [], page.last_seq, messages),
        hasMoreBefore: page.has_more,
        hasMoreAfter: false,
        status: 'ready',
        lastSeq: page.last_seq,
        syncedAt: startedAt,
      }),
    },
    pending: settleMine(s.pending, list),
  });
  ensureProfiles(authorsOf(list));
  scheduleCacheWrite(channelId);
  healIfBehind(channelId);
}

// A message that arrived live while the page was on its way (seq past the page)
// stays in the timeline instead of vanishing under the page.
function withLiveArrivals(page: Message[], previous: readonly string[], pageLastSeq: number, messages: Record<string, Message>): string[] {
  const live = previous
    .map((id) => messages[id])
    .filter((m): m is Message => !!m && m.seq > pageLastSeq && inTimeline(m));
  return mergeIds(page.map((m) => m.id), live, messages);
}

// The channel is known to be ahead of the cursor just set (a message landed while
// the page was loading): heal by cursor instead of waiting for the next message.
function healIfBehind(channelId: string): void {
  const s = getState();
  const tl = s.timelines[channelId];
  if (!tl || tl.hasMoreAfter) return;
  let ahead = s.channels[channelId]?.last_seq ?? 0;
  for (const id of tl.ids) ahead = Math.max(ahead, s.messages[id]?.seq ?? 0);
  if (ahead > tl.lastSeq) noteGap(channelId, ahead);
}

// A sub-load whose answer arrived for an older generation: its spinner goes off.
function settleSubLoad(channelId: string, orgGen: number, key: 'olderStatus' | 'newerStatus'): void {
  if (orgGen !== currentOrgGen()) return;
  const tl = getState().timelines[channelId];
  if (tl && tl[key] === 'loading') setTimeline(channelId, (t) => ({ ...t, [key]: 'idle' }));
}

async function loadAround(channelId: string, messageId: string, gen: number, orgGen: number): Promise<void> {
  let target = getState().messages[messageId];
  let seq: number | null = target && target.channel_id === channelId ? target.seq : null;
  if (target && target.thread_root_id && !target.also_in_channel) {
    const root = getState().messages[target.thread_root_id];
    seq = root ? root.seq : null;
  }
  if (seq === null) {
    const ctx = await api.getMessageContext(messageId);
    if (!current(channelId, gen, orgGen)) return;
    const extra = [ctx.message, ...(ctx.thread_root ? [ctx.thread_root] : [])];
    setState({ messages: mergeMessages(getState().messages, extra) });
    target = ctx.message;
    // A reply that is not shown in the channel: open the channel at its root.
    seq = ctx.thread_root && !ctx.message.also_in_channel ? ctx.thread_root.seq : ctx.message.seq;
  }
  const startedAt = serverNowIso();
  const page = await api.listMessagesAround(channelId, seq, PAGE);
  if (!current(channelId, gen, orgGen)) return;
  const list = sortBySeq(page.messages);
  const s = getState();
  const maxSeq = list.length ? list[list.length - 1]!.seq : seq;
  setState({
    messages: mergeMessages(s.messages, list),
    timelines: {
      ...s.timelines,
      [channelId]: emptyTimeline({
        ids: list.map((m) => m.id),
        hasMoreBefore: page.has_more_before,
        hasMoreAfter: page.has_more_after,
        status: 'ready',
        // Live (cursor-tracked) only when the window reaches the newest message.
        lastSeq: page.has_more_after ? maxSeq : page.last_seq,
        syncedAt: startedAt,
      }),
    },
  });
  ensureProfiles(authorsOf(list));
  if (!page.has_more_after) {
    scheduleCacheWrite(channelId);
    healIfBehind(channelId);
  }
}

// ---------------------------------------------------------------- pagination

export async function loadOlder(channelId: string): Promise<void> {
  const tl = getState().timelines[channelId];
  if (!tl || !tl.hasMoreBefore || tl.olderStatus === 'loading' || tl.ids.length === 0) return;
  const first = getState().messages[tl.ids[0]!];
  if (!first) return;
  const gen = loadGen.get(channelId) ?? 0;
  const orgGen = currentOrgGen();
  setTimeline(channelId, (t) => ({ ...t, olderStatus: 'loading' }));
  try {
    const page = await api.listMessages(channelId, first.seq, PAGE);
    if (!current(channelId, gen, orgGen)) {
      settleSubLoad(channelId, orgGen, 'olderStatus');
      return;
    }
    const list = sortBySeq(page.messages);
    const s = getState();
    const messages = mergeMessages(s.messages, list);
    const t = s.timelines[channelId] ?? tl;
    setState({
      messages,
      timelines: { ...s.timelines, [channelId]: { ...t, ids: mergeIds(t.ids, list, messages), hasMoreBefore: page.has_more, olderStatus: 'idle' } },
    });
    ensureProfiles(authorsOf(list));
  } catch (e) {
    if (!current(channelId, gen, orgGen)) {
      settleSubLoad(channelId, orgGen, 'olderStatus');
      return;
    }
    setTimeline(channelId, (t) => ({ ...t, olderStatus: 'error', error: humanError(e) }));
  }
}

export async function loadNewer(channelId: string): Promise<void> {
  const tl = getState().timelines[channelId];
  if (!tl || !tl.hasMoreAfter || tl.newerStatus === 'loading' || tl.ids.length === 0) return;
  const last = getState().messages[tl.ids[tl.ids.length - 1]!];
  if (!last) return;
  const gen = loadGen.get(channelId) ?? 0;
  const orgGen = currentOrgGen();
  setTimeline(channelId, (t) => ({ ...t, newerStatus: 'loading' }));
  try {
    const startedAt = serverNowIso();
    const after = Math.max(last.seq, tl.lastSeq);
    const res = await api.syncChannel(channelId, after, FAR_FUTURE, after);
    if (!current(channelId, gen, orgGen)) {
      settleSubLoad(channelId, orgGen, 'newerStatus');
      return;
    }
    const list = sortBySeq(res.new);
    const s = getState();
    const messages = mergeMessages(s.messages, list);
    const t = s.timelines[channelId] ?? tl;
    const shown = list.filter(inTimeline);
    const reachedEnd = !res.truncated;
    setState({
      messages,
      timelines: {
        ...s.timelines,
        [channelId]: {
          ...t,
          ids: mergeIds(t.ids, shown, messages),
          hasMoreAfter: !reachedEnd,
          lastSeq: reachedEnd ? Math.max(res.last_seq, after) : (list.length ? list[list.length - 1]!.seq : after),
          syncedAt: reachedEnd ? startedAt : t.syncedAt,
          newerStatus: 'idle',
        },
      },
    });
    ensureProfiles(authorsOf(list));
    if (reachedEnd) {
      scheduleCacheWrite(channelId);
      healIfBehind(channelId);
    }
  } catch (e) {
    if (!current(channelId, gen, orgGen)) {
      settleSubLoad(channelId, orgGen, 'newerStatus');
      return;
    }
    setTimeline(channelId, (t) => ({ ...t, newerStatus: 'error', error: humanError(e) }));
  }
}

// ---------------------------------------------------------------- healing by cursor

export function healChannel(channelId: string): Promise<void> {
  const running = healing.get(channelId);
  if (running) return running;
  const p = doHeal(channelId).finally(() => healing.delete(channelId));
  healing.set(channelId, p);
  return p;
}

async function doHeal(channelId: string): Promise<void> {
  const tl = getState().timelines[channelId];
  if (!tl || tl.hasMoreAfter || tl.status === 'loading' || tl.lastSeq <= 0) return;
  const gen = loadGen.get(channelId) ?? 0;
  const orgGen = currentOrgGen();
  const first = tl.ids.length ? getState().messages[tl.ids[0]!] : undefined;
  const since = tl.syncedAt
    ? new Date(Date.parse(tl.syncedAt) - CHANGED_MARGIN_MS).toISOString()
    : serverNowIso(-CHANGED_MARGIN_MS);
  const startedAt = serverNowIso();
  let res: SyncResult;
  try {
    res = await api.syncChannel(channelId, tl.lastSeq, since, first?.seq ?? tl.lastSeq);
  } catch (e) {
    // A failed heal must not move the cursor; the next reconnect or event retries.
    if (toDekError(e).code === 'not_found') setTimeline(channelId, (t) => ({ ...t, status: 'error', error: humanError(e) }));
    return;
  }
  if (!current(channelId, gen, orgGen)) return;
  if (res.truncated) {
    // Too much happened: drop what we hold for this channel and load the newest page.
    await dropCache(channelId);
    setTimeline(channelId, () => emptyTimeline({ status: 'loading' }));
    try {
      await loadNewest(channelId, bump(channelId), orgGen);
    } catch (e) {
      setTimeline(channelId, (t) => ({ ...t, status: 'error', error: humanError(e) }));
    }
    return;
  }
  applySync(channelId, res, startedAt);
}

export function applySync(channelId: string, res: SyncResult, startedAt: string): void {
  const s = getState();
  const all = sortBySeq([...res.new, ...res.changed]);
  const messages = mergeMessages(s.messages, all);
  const patch: Partial<DekState> = { messages };
  const tl = s.timelines[channelId];
  if (tl) {
    const shown = sortBySeq(res.new).filter(inTimeline);
    let ids = mergeIds(tl.ids, shown, messages);
    // An edit may have moved a reply in or out of the channel view.
    for (const m of res.changed) {
      if (!inTimeline(m) && ids.includes(m.id)) ids = ids.filter((id) => id !== m.id);
    }
    // A successful heal makes the timeline good again: from the cache or after an error.
    patch.timelines = {
      ...s.timelines,
      [channelId]: { ...tl, ids, lastSeq: Math.max(tl.lastSeq, res.last_seq), syncedAt: startedAt, status: 'ready', error: null, fromCache: false },
    };
  }
  // Replies for an open thread pane.
  let threads = s.threads;
  for (const m of res.new) {
    if (!m.thread_root_id) continue;
    const tv = threads[m.thread_root_id];
    if (tv && !tv.replyIds.includes(m.id)) {
      threads = { ...threads, [m.thread_root_id]: { ...tv, replyIds: mergeIds(tv.replyIds, [m], messages) } };
    }
  }
  if (threads !== s.threads) patch.threads = threads;
  const ch = s.channels[channelId];
  if (ch && res.last_seq > ch.last_seq) patch.channels = { ...s.channels, [channelId]: { ...ch, last_seq: res.last_seq } };
  const pending = settleMine(s.pending, res.new);
  if (pending !== s.pending) patch.pending = pending;
  setState(patch);
  ensureProfiles(authorsOf(all));
  scheduleCacheWrite(channelId);
}

// My own messages that arrived in a page or a sync settle their pending copies.
function settleMine(pending: DekState['pending'], list: readonly Message[]): DekState['pending'] {
  const me = getState().session.userId;
  let out = pending;
  for (const m of list) {
    if (m.client_id && m.author_id === me && out[m.client_id]) {
      out = dropPendingByClientId(out, m.client_id);
      runtime()?.outbox.settle(m.client_id);
    }
  }
  return out;
}

// After a reconnect: heal every open channel by cursor; one that never loaded (an
// error while offline, nothing cached) loads its newest page now.
export async function healOpenChannels(): Promise<void> {
  await Promise.all(openChannels().map((id) => {
    const tl = getState().timelines[id];
    if (!tl || tl.lastSeq <= 0) return reloadChannel(id);
    if (tl.status === 'loading') return undefined;
    return healChannel(id);
  }));
}

async function reloadChannel(channelId: string): Promise<void> {
  const gen = bump(channelId);
  const orgGen = currentOrgGen();
  setTimeline(channelId, (t) => ({ ...t, status: 'loading', error: null }));
  try {
    await loadNewest(channelId, gen, orgGen);
  } catch (e) {
    if (!current(channelId, gen, orgGen)) return;
    setTimeline(channelId, (t) => ({ ...t, status: 'error', error: humanError(e) }));
  }
}

// A message arrived past a hole in the cursor: give the missing one a moment to
// arrive on its own, then heal.
export function noteGap(channelId: string, seq: number): void {
  if (gapTimers.has(channelId)) return;
  gapTimers.set(channelId, setTimeout(() => {
    gapTimers.delete(channelId);
    const tl = getState().timelines[channelId];
    if (tl && !tl.hasMoreAfter && tl.lastSeq < seq) void healChannel(channelId);
  }, GAP_WAIT_MS));
}

// ---------------------------------------------------------------- page cache

async function paintFromCache(channelId: string, gen: number, orgGen: number): Promise<void> {
  const rt = runtime();
  if (!rt) return;
  const db = await rt.db;
  if (!db.ok) return;
  const rec = await db.get<PageRecord>('pages', channelId);
  if (!rec || !current(channelId, gen, orgGen) || rec.orgId !== getState().orgId) return;
  const now = getState().timelines[channelId];
  if (now && now.ids.length > 0) return;
  const list = sortBySeq(rec.messages ?? []);
  const s = getState();
  setState({
    messages: mergeMessages(s.messages, list),
    timelines: {
      ...s.timelines,
      [channelId]: emptyTimeline({ ids: list.map((m) => m.id), status: 'loading', lastSeq: rec.lastSeq, fromCache: true }),
    },
  });
  ensureProfiles(authorsOf(list));
}

export function scheduleCacheWrite(channelId: string, delay = CACHE_WRITE_MS): void {
  const old = cacheTimers.get(channelId);
  if (old) clearTimeout(old);
  cacheTimers.set(channelId, setTimeout(() => {
    cacheTimers.delete(channelId);
    void writeCache(channelId);
  }, delay));
}

async function writeCache(channelId: string): Promise<void> {
  const rt = runtime();
  const s = getState();
  const tl = s.timelines[channelId];
  if (!rt || !tl || tl.hasMoreAfter || tl.fromCache || tl.status !== 'ready' || !s.orgId) return;
  const ids = tl.ids.slice(-CACHE_SIZE);
  const messages = ids.map((id) => s.messages[id]).filter((m): m is Message => !!m);
  const db = await rt.db;
  if (!db.ok) return;
  const rec: PageRecord = { channelId, orgId: s.orgId, messages, lastSeq: tl.lastSeq, savedAt: Date.now() };
  await db.put('pages', rec);
}

export async function dropCache(channelId: string): Promise<void> {
  const t = cacheTimers.get(channelId);
  if (t) clearTimeout(t);
  cacheTimers.delete(channelId);
  const rt = runtime();
  if (!rt) return;
  const db = await rt.db;
  if (db.ok) await db.delete('pages', channelId);
}

export async function dropCachedOrg(orgId: string): Promise<string[]> {
  const rt = runtime();
  if (!rt) return [];
  const db = await rt.db;
  if (!db.ok) return [];
  const cached=await db.get<{value:BootstrapResult}>('meta',`bootstrap:${orgId}`);
  const rows = await db.getAll<PageRecord>('pages');
  const ids=new Set([...(cached?.value.channels??[]).map(c=>c.id),...rows.filter(r=>r.orgId===orgId).map(r=>r.channelId)]);
  for (const id of ids) {
    const timer=cacheTimers.get(id);if(timer)clearTimeout(timer);cacheTimers.delete(id);
    await db.delete('pages',id);
  }
  await db.delete('meta',`bootstrap:${orgId}`);
  const me=await db.get<{key:string;value:MeResult;savedAt:number}>('meta','me');
  if(me)await db.put('meta',{...me,value:{...me.value,orgs:me.value.orgs.filter(o=>o.id!==orgId)}});
  return [...ids];
}

// ---------------------------------------------------------------- memory bound

// Keep the last few closed timelines for quick switching; drop the rest and their
// messages (a person who browses 40 channels must not hold 40 pages in memory).
function evict(): void {
  const closed = recent.filter((id) => !isOpen(id));
  const excess = closed.length - KEEP_TIMELINES;
  if (excess <= 0) return;
  const drop = new Set(closed.slice(0, excess));
  for (const id of drop) recent.splice(recent.indexOf(id), 1);
  const s = getState();
  const keepIds = new Set<string>();
  for (const [cid, t] of Object.entries(s.timelines)) if (!drop.has(cid)) t.ids.forEach((id) => keepIds.add(id));
  for (const t of Object.values(s.threads)) {
    keepIds.add(t.rootId);
    t.replyIds.forEach((id) => keepIds.add(id));
  }
  const timelines = { ...s.timelines };
  for (const id of drop) delete timelines[id];
  const messages: Record<string, Message> = {};
  for (const [id, m] of Object.entries(s.messages)) {
    if (!drop.has(m.channel_id) || keepIds.has(id)) messages[id] = m;
  }
  setState({ timelines, messages });
}

export function resetChannels(): void {
  for (const t of cacheTimers.values()) clearTimeout(t);
  for (const t of gapTimers.values()) clearTimeout(t);
  cacheTimers.clear();
  gapTimers.clear();
  healing.clear();
  loadGen.clear();
  recent.length = 0;
}
