// Pure state transitions for everything that arrives from the server: realtime
// events, RPC results and sync pages. No I/O here, so every rule (merge, pending
// reconciliation, timeline order, counters, read monotonicity, revocation purge)
// is unit tested in tests/platform/reducers.test.ts.
import type { Call, Channel, ChannelBase, Message } from '../api/types';
import type { DekState, PendingMessage, Timeline, ThreadView, TypingEntry } from '../store/state';

export const COUNTER_CAP = 100;

export interface EventCtx {
  me: string | null;
  // The channel is open AND the page is visible: the person is looking at it, so
  // new messages there do not raise its unread or mention counters.
  onScreen: (channelId: string) => boolean;
}

export function inTimeline(m: Pick<Message, 'thread_root_id' | 'also_in_channel'>): boolean {
  return m.thread_root_id === null || m.also_in_channel;
}

export function emptyTimeline(partial: Partial<Timeline> = {}): Timeline {
  return {
    ids: [],
    hasMoreBefore: true,
    hasMoreAfter: false,
    status: 'idle',
    error: null,
    lastSeq: 0,
    syncedAt: null,
    fromCache: false,
    olderStatus: 'idle',
    newerStatus: 'idle',
    ...partial,
  };
}

// Newer wins: a msg.new can arrive after a msg.upd for the same row (sync and
// realtime race), and an older copy must never overwrite a newer one.
export function newer(a: Message | undefined, b: Message): boolean {
  if (!a) return true;
  return b.updated_at >= a.updated_at;
}

// Ids ascending by seq, no duplicates. Messages arrive almost always at the end,
// so walk from the back.
export function insertBySeq(ids: readonly string[], messages: Record<string, Message>, msg: Message): string[] {
  if (ids.includes(msg.id)) return ids as string[];
  const out = ids.slice();
  let i = out.length;
  while (i > 0) {
    const prev = messages[out[i - 1]!];
    if (!prev || prev.seq < msg.seq) break;
    i -= 1;
  }
  out.splice(i, 0, msg.id);
  return out;
}

export function mergeIds(ids: readonly string[], add: Message[], messages: Record<string, Message>): string[] {
  let out = ids.slice();
  for (const m of add) out = insertBySeq(out, messages, m);
  return out;
}

function capped(n: number): number {
  return Math.max(0, Math.min(COUNTER_CAP, n));
}

function mentionsMe(m: Message, me: string | null): boolean {
  if (!me || m.author_id === me || m.deleted_at) return false;
  return m.mention_all || m.mentions.includes(me);
}

// ---------------------------------------------------------------- pending

export function dropPendingByClientId(pending: Record<string, PendingMessage>, clientId: string | null): Record<string, PendingMessage> {
  if (!clientId || !(clientId in pending)) return pending;
  const next = { ...pending };
  delete next[clientId];
  return next;
}

// ---------------------------------------------------------------- msg.new

export interface NewMessageResult {
  patch: Partial<DekState>;
  // The channel's cursor could not advance: a message between lastSeq and this
  // one never arrived, so the caller heals by cursor (never skip a hole).
  gap: boolean;
}

export function applyNewMessage(s: DekState, msg: Message, ctx: EventCtx): NewMessageResult {
  const patch: Partial<DekState> = {};
  let gap = false;

  const existing = s.messages[msg.id];
  const effective = newer(existing, msg) ? msg : existing!;
  const messages = { ...s.messages, [msg.id]: effective };
  patch.messages = messages;

  // My own send, accepted: the pending copy goes (same client id, DEK06).
  if (msg.client_id && msg.author_id && msg.author_id === ctx.me) {
    const pending = dropPendingByClientId(s.pending, msg.client_id);
    if (pending !== s.pending) patch.pending = pending;
  }

  // Timeline: only while it shows the newest messages (not a window into history).
  const tl = s.timelines[msg.channel_id];
  if (tl) {
    let ids = tl.ids;
    if (inTimeline(msg) && !tl.hasMoreAfter) ids = insertBySeq(ids, messages, effective);
    let lastSeq = tl.lastSeq;
    if (!tl.hasMoreAfter) {
      if (msg.seq === lastSeq + 1) lastSeq = msg.seq;
      else if (msg.seq > lastSeq + 1) gap = true;
    }
    if (ids !== tl.ids || lastSeq !== tl.lastSeq) {
      patch.timelines = { ...s.timelines, [msg.channel_id]: { ...tl, ids, lastSeq } };
    }
  }

  // Thread pane and the root's counters.
  if (msg.thread_root_id) {
    const tv = s.threads[msg.thread_root_id];
    if (tv && !tv.replyIds.includes(msg.id)) {
      patch.threads = { ...s.threads, [msg.thread_root_id]: { ...tv, replyIds: insertBySeq(tv.replyIds, messages, effective) } };
    }
    const root = messages[msg.thread_root_id];
    // The root's own msg.upd carries the true counters; count locally only when
    // the root does not reflect this reply yet, so the two never double count.
    if (root && (!root.last_reply_at || root.last_reply_at < msg.created_at)) {
      const authors = msg.author_id && !root.reply_user_ids.includes(msg.author_id)
        ? [...root.reply_user_ids, msg.author_id]
        : root.reply_user_ids;
      messages[root.id] = { ...root, reply_count: root.reply_count + 1, last_reply_at: msg.created_at, reply_user_ids: authors };
    }
  }

  // Sidebar counters.
  const ch = s.channels[msg.channel_id];
  if (ch) {
    const next: Channel = {
      ...ch,
      last_seq: Math.max(ch.last_seq, msg.seq),
      last_message_at: !ch.last_message_at || ch.last_message_at < msg.created_at ? msg.created_at : ch.last_message_at,
    };
    const unseen = msg.seq > ch.last_read_seq && !ctx.onScreen(msg.channel_id);
    const isNew = !existing;
    if (isNew && unseen && inTimeline(msg) && !msg.deleted_at && msg.author_id !== ctx.me) {
      next.unread = capped(ch.unread + 1);
    }
    if (isNew && unseen && mentionsMe(msg, ctx.me)) {
      next.mentions = capped(ch.mentions + 1);
    }
    // A DM someone hid comes back with a new message.
    if (next.hidden) next.hidden = false;
    patch.channels = { ...s.channels, [ch.id]: next };
  }

  // That person stopped typing: their message is here.
  const typing = s.typing[msg.channel_id];
  if (typing && msg.author_id && typing.some((t) => t.userId === msg.author_id)) {
    patch.typing = { ...s.typing, [msg.channel_id]: typing.filter((t) => t.userId !== msg.author_id) };
  }

  return { patch, gap };
}

// ---------------------------------------------------------------- msg.upd

export function applyUpdatedMessage(s: DekState, msg: Message): Partial<DekState> | null {
  const existing = s.messages[msg.id];
  if (!existing) return null;          // not on any screen: nothing to update
  if (!newer(existing, msg)) return null;
  const patch: Partial<DekState> = { messages: { ...s.messages, [msg.id]: msg } };
  // A reply that is now also shown in the channel (or no longer) moves in or out.
  const tl = s.timelines[msg.channel_id];
  if (tl && !tl.hasMoreAfter) {
    const shown = tl.ids.includes(msg.id);
    if (inTimeline(msg) && !shown && tl.ids.length > 0) {
      const first = s.messages[tl.ids[0]!];
      if (first && msg.seq > first.seq) {
        patch.timelines = { ...s.timelines, [msg.channel_id]: { ...tl, ids: insertBySeq(tl.ids, patch.messages!, msg) } };
      }
    } else if (!inTimeline(msg) && shown) {
      patch.timelines = { ...s.timelines, [msg.channel_id]: { ...tl, ids: tl.ids.filter((id) => id !== msg.id) } };
    }
  }
  return patch;
}

// Sync results and pages: merge many at once, newer wins.
export function mergeMessages(base: Record<string, Message>, list: Message[]): Record<string, Message> {
  if (list.length === 0) return base;
  const out = { ...base };
  for (const m of list) if (newer(out[m.id], m)) out[m.id] = m;
  return out;
}

// ---------------------------------------------------------------- read state

// Unread for a channel recounted from what is loaded: used when the read position
// moved backwards (mark unread here or on another device).
export function countUnreadFromTimeline(s: DekState, channelId: string, lastRead: number, me: string | null): number | null {
  const tl = s.timelines[channelId];
  if (!tl || tl.hasMoreAfter) return null;
  let n = 0;
  for (const id of tl.ids) {
    const m = s.messages[id];
    if (m && m.seq > lastRead && !m.deleted_at && m.author_id !== me && inTimeline(m)) n += 1;
  }
  const first = tl.ids[0] ? s.messages[tl.ids[0]] : undefined;
  // If the loaded page starts after the read position, older unread exist that we
  // cannot see: only a lower bound, so let the caller ask the server.
  if (first && first.seq > lastRead + 1 && tl.hasMoreBefore) return null;
  return capped(n);
}

export interface ReadResult {
  patch: Partial<DekState> | null;
  needsRefresh: boolean;   // counters unknown after a backwards move: refresh from bootstrap
}

// The server's value is authoritative (it already applies monotonic mark_read and
// deliberate mark_unread), except that a local read the server has not seen yet
// (`localFloor`, debounced or in flight) is never undone by an older event.
export function applyRead(s: DekState, channelId: string, serverSeq: number, localFloor: number, me: string | null): ReadResult {
  const ch = s.channels[channelId];
  if (!ch) return { patch: null, needsRefresh: false };
  const value = Math.max(serverSeq, localFloor);
  if (value === ch.last_read_seq && !(value >= ch.last_seq && (ch.unread > 0 || ch.mentions > 0))) {
    return { patch: null, needsRefresh: false };
  }
  const next: Channel = { ...ch, last_read_seq: value };
  let needsRefresh = false;
  if (value >= ch.last_seq) {
    next.unread = 0;
    next.mentions = 0;
  } else if (value < ch.last_read_seq) {
    const recount = countUnreadFromTimeline(s, channelId, value, me);
    if (recount === null) needsRefresh = true;
    else next.unread = recount;
  } else {
    // Moved forward but not to the end: the loaded page knows how many remain.
    const recount = countUnreadFromTimeline(s, channelId, value, me);
    if (recount !== null) next.unread = Math.min(ch.unread, recount);
    else needsRefresh = ch.unread > 0;
  }
  return { patch: { channels: { ...s.channels, [channelId]: next } }, needsRefresh };
}

export function applyThreadRead(s: DekState, rootId: string, serverSeq: number, localFloor: number): Partial<DekState> | null {
  const tv = s.threads[rootId];
  if (!tv) return null;
  const value = Math.max(serverSeq, localFloor);
  if (value === tv.lastReadReplySeq) return null;
  return { threads: { ...s.threads, [rootId]: { ...tv, lastReadReplySeq: value } } };
}

// ---------------------------------------------------------------- channels

// chan.upd carries the channel without per-user fields: keep mine.
export function applyChannelUpdate(s: DekState, base: ChannelBase): Partial<DekState> | null {
  const ch = s.channels[base.id];
  if (!ch) return null;
  const next: Channel = { ...ch, ...base };
  return { channels: { ...s.channels, [base.id]: next } };
}

export function applyMemberCount(s: DekState, channelId: string, delta: number): Partial<DekState> | null {
  const ch = s.channels[channelId];
  if (!ch || delta === 0) return null;
  return { channels: { ...s.channels, [channelId]: { ...ch, member_count: Math.max(0, ch.member_count + delta) } } };
}

// ---------------------------------------------------------------- revocation

// Everything a removed channel put in memory goes at once (DEK05, DEKA06).
export function purgeChannels(s: DekState, channelIds: ReadonlySet<string>): Partial<DekState> {
  if (channelIds.size === 0) return {};
  const without = <T>(rec: Record<string, T>, drop: (key: string, value: T) => boolean): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(rec)) if (!drop(k, v)) out[k] = v;
    return out;
  };
  return {
    channels: without(s.channels, (k) => channelIds.has(k)),
    timelines: without(s.timelines, (k) => channelIds.has(k)),
    messages: without(s.messages, (_k, m) => channelIds.has(m.channel_id)),
    threads: without(s.threads, (_k, t: ThreadView) => channelIds.has(t.channelId)),
    typing: without(s.typing, (k) => channelIds.has(k)),
    pending: without(s.pending, (_k, p: PendingMessage) => channelIds.has(p.channelId)),
    drafts: without(s.drafts, (k) => channelIds.has(k.split(':')[0]!)),
    scroll: without(s.scroll, (k) => channelIds.has(k)),
  };
}

export function channelsOfServer(s: DekState, serverId: string): Set<string> {
  const out = new Set<string>();
  for (const c of Object.values(s.channels)) if (c.server_id === serverId) out.add(c.id);
  for (const t of Object.values(s.threads)) {
    const c = s.channels[t.channelId];
    if (c?.server_id === serverId) out.add(t.channelId);
  }
  return out;
}

// ---------------------------------------------------------------- typing

export function applyTyping(s: DekState, channelId: string, userId: string, threadRootId: string | null, me: string | null, until: number): Partial<DekState> | null {
  if (!userId || userId === me) return null;
  const list = s.typing[channelId] ?? [];
  const entry: TypingEntry = { userId, threadRootId, until };
  const next = [...list.filter((t) => !(t.userId === userId && t.threadRootId === threadRootId)), entry];
  return { typing: { ...s.typing, [channelId]: next } };
}

export function expireTyping(s: DekState, now: number): Partial<DekState> | null {
  let changed = false;
  const out: Record<string, TypingEntry[]> = {};
  for (const [k, list] of Object.entries(s.typing)) {
    const keep = list.filter((t) => t.until > now);
    if (keep.length !== list.length) changed = true;
    if (keep.length > 0) out[k] = keep;
    else if (list.length > 0) changed = true;
  }
  return changed ? { typing: out } : null;
}

// ---------------------------------------------------------------- calls

export function applyCall(s: DekState, call: Call): Partial<DekState> {
  return { calls: { ...s.calls, [call.id]: call } };
}
