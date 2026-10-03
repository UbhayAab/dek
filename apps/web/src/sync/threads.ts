// Thread panes: the root, replies ascending, follow state and the thread read
// position. Replies that arrive live are merged by reducers.applyNewMessage.
import { api } from '../api/rpc';
import { humanError } from '../api/errors';
import type { Message } from '../api/types';
import { getState, setState } from '../store/state';
import type { ThreadView } from '../store/state';
import { ensureProfiles } from './profiles';
import { mergeIds, mergeMessages } from './reducers';
import { currentOrgGen } from './runtime';

const PAGE = 100;
const KEEP_THREADS = 6;
const order: string[] = [];

function blank(rootId: string): ThreadView {
  const root = getState().messages[rootId];
  return {
    rootId,
    channelId: root?.channel_id ?? '',
    replyIds: [],
    status: 'loading',
    error: null,
    hasMore: false,
    following: false,
    lastReadReplySeq: 0,
  };
}

function people(list: readonly Message[]): string[] {
  const out = new Set<string>();
  for (const m of list) if (m.author_id) out.add(m.author_id);
  return Array.from(out);
}

function remember(rootId: string): void {
  const i = order.indexOf(rootId);
  if (i >= 0) order.splice(i, 1);
  order.push(rootId);
  while (order.length > KEEP_THREADS) {
    const old = order.shift()!;
    const s = getState();
    if (!s.threads[old]) continue;
    const threads = { ...s.threads };
    delete threads[old];
    setState({ threads });
  }
}

export async function openThread(rootId: string): Promise<void> {
  remember(rootId);
  const orgGen = currentOrgGen();
  const existing = getState().threads[rootId];
  setState({ threads: { ...getState().threads, [rootId]: { ...(existing ?? blank(rootId)), status: 'loading', error: null } } });
  try {
    const page = await api.listThread(rootId, 0, PAGE);
    if (orgGen !== currentOrgGen()) return;
    const replies = page.replies.slice().sort((a, b) => a.seq - b.seq);
    const s = getState();
    const messages = mergeMessages(s.messages, [page.root, ...replies]);
    const prev = s.threads[rootId];
    setState({
      messages,
      threads: {
        ...s.threads,
        [rootId]: {
          rootId,
          channelId: page.root.channel_id,
          // keep live replies that landed while the page was loading
          replyIds: mergeIds(prev?.replyIds ?? [], replies, messages),
          status: 'ready',
          error: null,
          hasMore: page.has_more,
          following: page.following,
          lastReadReplySeq: Math.max(page.last_read_reply_seq, prev?.lastReadReplySeq ?? 0),
        },
      },
    });
    ensureProfiles(people([page.root, ...replies]));
  } catch (e) {
    if (orgGen !== currentOrgGen()) return;
    const s = getState();
    const tv = s.threads[rootId] ?? blank(rootId);
    setState({ threads: { ...s.threads, [rootId]: { ...tv, status: 'error', error: humanError(e) } } });
  }
}

export async function loadThreadMore(rootId: string): Promise<void> {
  const s = getState();
  const tv = s.threads[rootId];
  if (!tv || !tv.hasMore) return;
  let after = 0;
  for (const id of tv.replyIds) after = Math.max(after, s.messages[id]?.seq ?? 0);
  const orgGen = currentOrgGen();
  const page = await api.listThread(rootId, after, PAGE);
  if (orgGen !== currentOrgGen()) return;
  const replies = page.replies.slice().sort((a, b) => a.seq - b.seq);
  const now = getState();
  const messages = mergeMessages(now.messages, [page.root, ...replies]);
  const cur = now.threads[rootId] ?? tv;
  setState({
    messages,
    threads: { ...now.threads, [rootId]: { ...cur, replyIds: mergeIds(cur.replyIds, replies, messages), hasMore: page.has_more } },
  });
  ensureProfiles(people(replies));
}

// After a reconnect: replies newer than the last one we hold, for each open pane.
export async function healThreads(): Promise<void> {
  const ids = Object.keys(getState().threads);
  await Promise.all(ids.map(async (rootId) => {
    const s = getState();
    const tv = s.threads[rootId];
    if (!tv || tv.status !== 'ready') return;
    let after = 0;
    for (const id of tv.replyIds) after = Math.max(after, s.messages[id]?.seq ?? 0);
    const orgGen = currentOrgGen();
    try {
      const page = await api.listThread(rootId, after, PAGE);
      if (orgGen !== currentOrgGen()) return;
      const now = getState();
      const messages = mergeMessages(now.messages, [page.root, ...page.replies]);
      const cur = now.threads[rootId];
      if (!cur) return;
      setState({
        messages,
        threads: { ...now.threads, [rootId]: { ...cur, replyIds: mergeIds(cur.replyIds, page.replies, messages), following: page.following } },
      });
    } catch {
      /* the pane keeps what it has; the next reconnect tries again */
    }
  }));
}

export async function followThread(rootId: string, follow: boolean): Promise<void> {
  const r = await api.followThread(rootId, follow);
  const s = getState();
  const tv = s.threads[rootId];
  if (tv) setState({ threads: { ...s.threads, [rootId]: { ...tv, following: r.following } } });
}

export function resetThreads(): void {
  order.length = 0;
}
