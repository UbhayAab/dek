// Bounded thread windows. Fetched page edges are independent of realtime IDs.
import { api } from '../api/rpc';
import { DekError, humanError, toDekError } from '../api/errors';
import type { ThreadWindow } from '../api/types';
import { draftKey, getState, setState, type ThreadView } from '../store/state';
import { ensureProfiles } from './profiles';
import { clearNotificationsFor } from './channels';
import { mergeIds, mergeMessages } from './reducers';
import { currentOrgGen, runtime } from './runtime';
import { scheduleBootstrapRefresh } from './org';
import { setDraft } from './local';

const generations = new Map<string, number>();
const active = new Set<string>();
const busy = new Map<string, Promise<void>>();
const dirty = new Set<string>();
const order: string[] = [];
const bump = (id: string) => { const n = (generations.get(id) ?? 0) + 1; generations.set(id, n); return n; };
function valid(id: string, gen: number, org: number, channel: string): boolean {
  return active.has(id) && generations.get(id) === gen && currentOrgGen() === org && !!getState().channels[channel];
}
function blank(id: string, channelId: string): ThreadView {
  return { rootId: id, channelId, replyIds: [], status: 'loading', error: null, hasMore: false, following: false, lastReadReplySeq: 0 };
}
function put(rootId: string, page: ThreadWindow, mode: 'open' | 'before' | 'after'): void {
  const s = getState(), prev = s.threads[rootId] ?? blank(rootId, page.root.channel_id);
  const messages = mergeMessages(s.messages, [page.root, ...page.replies]);
  const replace = mode === 'open';
  setState({ messages, threads: { ...s.threads, [rootId]: {
    ...prev, rootId, channelId: page.root.channel_id, status: 'ready', error: null, unavailable: false,
    replyIds: mergeIds(replace ? [] : prev.replyIds, page.replies, messages),
    hasBefore: mode === 'after' ? prev.hasBefore : page.has_before,
    hasAfter: mode === 'before' ? prev.hasAfter : page.has_after,
    hasMore: mode === 'before' ? !!prev.hasAfter : page.has_after,
    firstSeq: mode === 'after' ? (prev.firstSeq || page.first_seq) : (page.first_seq || prev.firstSeq || 0),
    lastSeq: mode === 'before' ? (prev.lastSeq || page.last_seq) : (page.last_seq || (replace ? 0 : prev.lastSeq) || 0),
    targetId: replace ? page.target_id : prev.targetId,
    following: page.following,
    lastReadReplySeq: Math.max(page.last_read_reply_seq, prev.lastReadReplySeq),
    newReplies: mode === 'before' ? prev.newReplies : page.has_after,
  } } });
  ensureProfiles([...new Set([page.root, ...page.replies].flatMap(m => [m.author_id, ...m.mentions]).filter((id): id is string => !!id))]);
}
export async function openThread(rootId: string, opts: { messageId?: string | null; channelId?: string } = {}): Promise<void> {
  const s = getState();
  const channel = opts.channelId ?? s.messages[rootId]?.channel_id ?? s.threads[rootId]?.channelId;
  if (!channel || !s.channels[channel]) throw new DekError('not_found');
  active.add(rootId); const gen = bump(rootId), org = currentOrgGen();
  busy.delete(rootId);
  dirty.delete(rootId);
  const i = order.indexOf(rootId); if (i >= 0) order.splice(i, 1); order.push(rootId);
  while (order.length > 6) { const old = order.shift()!; closeThread(old); const threads = { ...getState().threads }; delete threads[old]; setState({ threads }); }
  const threads = getState().threads;
  setState({ threads: { ...threads, [rootId]: { ...(threads[rootId] ?? blank(rootId, channel)), status: 'loading', error: null, targetId: opts.messageId ?? null } } });
  try {
    const page = await api.threadWindow(rootId, { target: opts.messageId });
    if (!valid(rootId, gen, org, channel)) return;
    if (page.root.channel_id !== channel || page.root.org_id !== getState().orgId) throw new DekError('not_found');
    put(rootId, page, 'open');
    clearNotificationsFor(channel, rootId);
    if (dirty.delete(rootId)) await healThread(rootId);
  } catch (e) {
    if (!valid(rootId, gen, org, channel)) return;
    fail(rootId, channel, e);
    throw e;
  }
}
function fail(rootId: string, channel: string, error: unknown): boolean {
  const now = getState(), tv = now.threads[rootId] ?? blank(rootId, channel);
  const denied = ['not_found', 'forbidden', 'suspended'].includes(toDekError(error).code);
  const messages = { ...now.messages };
  if (denied) {
    closeThread(rootId);
    for (const [id, message] of Object.entries(messages)) if (id === rootId || message.thread_root_id === rootId) delete messages[id];
    for (const p of Object.values(now.pending)) if (p.threadRootId === rootId) runtime()?.outbox.discard(p.clientId);
    setDraft(draftKey(channel, rootId), '');
    scheduleBootstrapRefresh();
  }
  setState({ messages, threads: { ...getState().threads, [rootId]: { ...tv, replyIds: denied ? [] : tv.replyIds, status: 'error', error: humanError(error), unavailable: denied } } });
  return denied;
}
export function closeThread(rootId: string): void { active.delete(rootId); bump(rootId); busy.delete(rootId); dirty.delete(rootId); }
export function invalidateThreadChannels(ids: ReadonlySet<string>): void {
  for (const [id, tv] of Object.entries(getState().threads)) if (ids.has(tv.channelId)) closeThread(id);
}
export async function loadThreadMore(rootId: string, direction: 'before' | 'after' = 'after'): Promise<void> {
  if (busy.has(rootId)) return busy.get(rootId);
  const tv = getState().threads[rootId];
  if (!tv || !active.has(rootId) || (direction === 'before' ? !tv.hasBefore : !tv.hasAfter)) return;
  return fetchMore(rootId, direction);
}
async function fetchMore(rootId: string, direction: 'before' | 'after', heal = false): Promise<void> {
  const tv = getState().threads[rootId]; if (!tv) return;
  const gen = generations.get(rootId) ?? 0, org = currentOrgGen();
  const request = (async () => {
    const page = await api.threadWindow(rootId, direction === 'before' ? { before: tv.firstSeq } : { after: tv.lastSeq ?? 0 });
    if (!valid(rootId, gen, org, tv.channelId)) return;
    if (page.root.channel_id !== tv.channelId || page.root.org_id !== getState().orgId) throw new DekError('not_found');
    put(rootId, page, direction);
  })();
  busy.set(rootId, request);
  try { await request; } catch (e) {
    if (valid(rootId, gen, org, tv.channelId) && ['not_found', 'forbidden', 'suspended'].includes(toDekError(e).code)) fail(rootId, tv.channelId, e);
    if (!heal) throw e;
  } finally {
    if (busy.get(rootId) === request) {
      busy.delete(rootId);
      if (valid(rootId, gen, org, tv.channelId) && dirty.delete(rootId)) await healThread(rootId);
    }
  }
}
// Reconnect and realtime use the fetched edge, never the newest merged event.
export async function healThread(rootId: string): Promise<void> {
  const tv = getState().threads[rootId];
  if (!active.has(rootId) || !tv) return;
  if (tv.status === 'loading') { dirty.add(rootId); return; }
  if (tv.status !== 'ready' || tv.hasAfter) return;
  if (busy.has(rootId)) { dirty.add(rootId); return; }
  await fetchMore(rootId, 'after', true);
}
export async function healThreads(): Promise<void> { await Promise.all([...active].map(healThread)); }
export async function followThread(rootId: string, follow: boolean): Promise<void> {
  const org = currentOrgGen(), r = await api.followThread(rootId, follow);
  if (org !== currentOrgGen()) return;
  const s = getState(), tv = s.threads[rootId];
  if (tv) setState({ threads: { ...s.threads, [rootId]: { ...tv, following: r.following } } });
}
export function resetThreads(): void { for (const id of active) bump(id); active.clear(); busy.clear(); dirty.clear(); order.length = 0; }
