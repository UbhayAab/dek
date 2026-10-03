// The conversation's message list: virtualized with dynamic measurement and
// anchored to the bottom (new messages follow when you are at the end; older
// pages load above without moving what you are reading). Day separators, the New
// divider, deep-link highlight, jump to latest, mark read only when the newest
// message is on screen in a visible, focused window, scroll memory (DEK04).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Channel, Message } from '../../api/types';
import { actions, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Button, Spinner, toast } from '../../ui/kit';
import { navigate, channelRoute } from '../../app/router';
import { useCoarsePointer } from '../shell/layout';
import { MessageRow, PendingRow, type RowContext } from './MessageRow';
import { channelKindLabel } from './names';
import { buildRows, type Row } from './rows';
import { fire, run, useDocumentActive } from './safe';

type ListRow = Row | { kind: 'intro'; key: string } | { kind: 'loading'; key: string } | { kind: 'failed'; key: string };

export interface ListApi {
  scrollToEnd: () => void;
  clearNew: () => void;
}

const AT_END_PX = 80;
const HIGHLIGHT_MS = 4000;

const LINE = 22;

// A close guess at a row's height before it is measured: text lines at the
// list's width, attachments, reactions, a thread summary. Good guesses keep the
// scrollbar honest and restored positions from landing in the wrong place.
function estimate(row: ListRow | undefined, m: Message | undefined, charsPerLine: number, touch: boolean): number {
  if (!row) return 48;
  switch (row.kind) {
    case 'day': return 40;
    case 'new': return 28;
    case 'intro': return 132;
    case 'loading':
    case 'failed': return 56;
    case 'pending': return row.grouped ? (touch ? 44 : 26) : 56;
    case 'msg': {
      const base = row.grouped ? (touch ? 44 : 26) : 56;
      if (!m) return base;
      let lines = 0;
      for (const para of (m.deleted_at ? 'x' : m.body || 'x').split('\n')) lines += Math.max(1, Math.ceil(para.length / charsPerLine));
      let h = base + (lines - 1) * LINE;
      const media = m.attachments.filter((a) => a.mime_type.startsWith('image/') || a.mime_type.startsWith('video/')).length;
      if (media) h += 220;
      h += Math.min(3, m.attachments.length - media) * 60;
      if (Object.keys(m.reactions ?? {}).length) h += 34;
      if (m.reply_count > 0 && !m.thread_root_id) h += 38;
      if (m.also_in_channel && m.thread_root_id) h += 24;
      return h;
    }
  }
}

interface Props {
  orgId: string;
  channel: Channel;
  title: string;
  ctx: RowContext;
  messageId: string | null;
  // True while the conversation's open request (newest page, or the window
  // around a deep-linked message) is in flight.
  opening: boolean;
  // The first load failed (shown in the list so pending sends stay visible).
  loadError: string | null;
  onRetry: () => void;
  apiRef: MutableRefObject<ListApi | null>;
}

export function MessageList({ orgId, channel, title, ctx, messageId, opening, loadError, onRetry, apiRef }: Props) {
  const channelId = channel.id;
  const meId = ctx.who.meId;
  const timeline = useDek((s) => s.timelines[channelId]);
  const messages = useDek((s) => s.messages);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const coarse = useCoarsePointer();
  // Characters per text line at the list's current width (15 px text averages
  // about 7.6 px per character); measured once the list is on screen.
  const charsPerLine = useRef(64);
  const pendingMap = useDek((s) => s.pending);
  const docActive = useDocumentActive();

  // The New divider marks what was unread when the conversation opened.
  const [newAfterSeq, setNewAfterSeq] = useState<number | null>(() => (channel.unread > 0 ? channel.last_read_seq : null));
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [atEnd, setAtEnd] = useState(true);

  const ids = timeline?.ids;
  const msgs = useMemo(() => (ids ?? []).map((id) => messages[id]).filter((m): m is NonNullable<typeof m> => !!m), [ids, messages]);
  const pending = useMemo(
    () => Object.values(pendingMap).filter((p) => p.channelId === channelId && !p.threadRootId),
    [pendingMap, channelId],
  );
  const hasMoreBefore = timeline?.hasMoreBefore ?? false;
  const hasMoreAfter = timeline?.hasMoreAfter ?? false;
  const rows = useMemo<ListRow[]>(() => {
    const body = buildRows({ messages: msgs, pending, meId, newAfterSeq, hasMoreBefore });
    const top: ListRow = loadError && !msgs.length ? { kind: 'failed', key: 'top:failed' }
      : hasMoreBefore ? { kind: 'loading', key: 'top:loading' } : { kind: 'intro', key: 'top:intro' };
    return [top, ...body];
  }, [msgs, pending, meId, newAfterSeq, hasMoreBefore, loadError]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const row = rowsRef.current[i];
      return estimate(row, row && row.kind === 'msg' ? messagesRef.current[row.id] : undefined, charsPerLine.current, coarse);
    },
    getItemKey: (i) => rowsRef.current[i]?.key ?? i,
    overscan: 8,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: AT_END_PX,
    paddingEnd: 8,
  });

  const indexOf = useCallback((id: string) => rowsRef.current.findIndex((r) => r.kind === 'msg' && r.id === id), []);

  // ---------------------------------------------------------- positioning
  // A page painted from the local cache can be placed at once; the network page
  // then lands underneath without moving the reader.
  const ready = timeline?.status === 'ready' || (timeline?.ids.length ?? 0) > 0 || (!!loadError && pending.length > 0);
  const placed = useRef(false);
  const [settled, setSettled] = useState(false);
  const target = useRef<string | null>(messageId);
  const memory = useRef(useDek.getState().scroll[channelId] ?? null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Applies a position now and again on the next frame. In development React
  // re-attaches the virtualizer right after mount (StrictMode), which restores
  // its previous offset; the second application is the one that stays.
  const apply = useCallback((go: () => void, then?: () => void) => {
    go();
    requestAnimationFrame(() => {
      if (!alive.current) return;
      go();
      if (then) requestAnimationFrame(() => { if (alive.current) then(); });
    });
  }, []);

  // Puts a remembered message back at its remembered offset. Rows above it are
  // measured as they render, which moves it, so the position is re-applied each
  // frame until it holds, and abandoned the moment the person scrolls.
  const userScrolled = useRef(false);
  const restore = useCallback((anchorId: string, offset: number) => {
    userScrolled.current = false;
    let frames = 0;
    let stable = 0;
    const tick = () => {
      const el = scrollRef.current;
      const i = indexOf(anchorId);
      const m = i >= 0 ? virtualizer.measurementsCache[i] : undefined;
      if (!alive.current || userScrolled.current || !el || !m) return;
      const want = Math.max(0, m.start + offset);
      if (Math.abs(el.scrollTop - want) > 1) {
        el.scrollTop = want;
        stable = 0;
      } else {
        stable += 1;
      }
      frames += 1;
      if (stable < 4 && frames < 90) requestAnimationFrame(tick);
    };
    tick();
  }, [indexOf, virtualizer]);

  useLayoutEffect(() => {
    if (placed.current || !ready) return;
    placed.current = true;
    let go: () => void = () => virtualizer.scrollToEnd();
    const id = target.current;
    const mem = memory.current;
    const newAt = rowsRef.current.findIndex((r) => r.kind === 'new');
    if (id && indexOf(id) >= 0) {
      target.current = null;
      setHighlightId(id);
      go = () => { const i = indexOf(id); if (i >= 0) virtualizer.scrollToIndex(i, { align: 'center' }); };
    } else if (mem && !mem.atBottom && mem.anchorId && indexOf(mem.anchorId) >= 0) {
      const anchorId = mem.anchorId;
      const offset = mem.offset;
      go = () => restore(anchorId, offset);
    } else if (newAt > 0) {
      // The first unread message near the top, with a line of context above it.
      go = () => { const i = rowsRef.current.findIndex((r) => r.kind === 'new'); if (i > 0) virtualizer.scrollToIndex(i - 1, { align: 'start' }); };
    }
    apply(go, () => setSettled(true));
  }, [ready, indexOf, virtualizer, apply, restore]);

  // ---------------------------------------------------------- deep link target
  const seenTarget = useRef(messageId);
  // A missing target is only "not available" after a load for it has finished.
  const sawOpening = useRef(opening);
  useLayoutEffect(() => {
    if (messageId && messageId !== seenTarget.current) {
      target.current = messageId;
      sawOpening.current = false;
    }
    seenTarget.current = messageId;
    if (opening) sawOpening.current = true;
    const id = target.current;
    if (!id || !placed.current) return;
    if (indexOf(id) >= 0) {
      target.current = null;
      setHighlightId(id);
      apply(() => { const i = indexOf(id); if (i >= 0) virtualizer.scrollToIndex(i, { align: 'center' }); });
      return;
    }
    if (sawOpening.current && !opening && !msgs.some((m) => m.id === id)) {
      // Loaded, and the message is not there: deleted, or no longer visible to you.
      target.current = null;
      toast({ kind: 'info', title: 'That message is not available', body: 'It may have been deleted.' });
    }
  }, [rows, indexOf, virtualizer, msgs, opening, messageId, apply]);

  useEffect(() => {
    if (!highlightId) return undefined;
    const t = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightId]);

  // ---------------------------------------------------------- older pages keep the reader in place
  // The virtualizer anchors on whatever row is at the top; when that is a day
  // separator or the loading row (keys that survive a prepend) it would not move.
  // So the first visible MESSAGE is remembered, and after older rows arrive above
  // it, it is put back exactly where it was.
  const anchor = useRef<{ key: string; rel: number; id: string | null } | null>(null);
  const atEndRef = useRef(true);
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const at = virtualizer.getVirtualItemForOffset(top);
    if (!at) return;
    const list = rowsRef.current;
    for (let i = at.index; i < list.length; i += 1) {
      const row = list[i];
      const m = virtualizer.measurementsCache[i];
      if (!row || !m) break;
      if ((row.kind === 'msg' || row.kind === 'pending') && m.end > top) {
        anchor.current = { key: row.key, rel: m.start - top, id: row.kind === 'msg' ? row.id : null };
        return;
      }
    }
  }, [virtualizer]);

  const firstKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const first = rows.find((r) => r.kind === 'msg')?.key ?? null;
    const before = firstKey.current;
    firstKey.current = first;
    const el = scrollRef.current;
    const a = anchor.current;
    if (!settled || !el || !a || !before || first === before) return;
    virtualizer.getTotalSize();
    const i = rows.findIndex((r) => r.key === a.key);
    const m = i >= 0 ? virtualizer.measurementsCache[i] : undefined;
    if (!m) return;
    const want = Math.max(0, m.start - a.rel);
    if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
  }, [rows, settled, virtualizer]);

  useLayoutEffect(() => {
    if (settled) captureAnchor();
  });

  // ---------------------------------------------------------- paging
  const items = virtualizer.getVirtualItems();
  const firstIndex = items[0]?.index ?? 0;
  const lastIndex = items[items.length - 1]?.index ?? 0;

  const olderStatus = timeline?.olderStatus ?? 'idle';
  const newerStatus = timeline?.newerStatus ?? 'idle';
  const loadingOlder = olderStatus === 'loading';
  const loadOlder = useCallback(() => fire(() => actions.loadOlder(channelId)), [channelId]);

  useEffect(() => {
    if (!settled || !hasMoreBefore || olderStatus !== 'idle') return;
    if (firstIndex <= 2) loadOlder();
  }, [settled, firstIndex, hasMoreBefore, olderStatus, loadOlder]);

  useEffect(() => {
    if (!settled || !hasMoreAfter || newerStatus !== 'idle') return;
    if (lastIndex >= rows.length - 3) fire(() => actions.loadNewer(channelId));
  }, [settled, lastIndex, rows.length, hasMoreAfter, newerStatus, channelId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => { charsPerLine.current = Math.max(20, Math.floor((el.clientWidth - 56 - 48) / 7.6)); };
    measure();
    const stop = () => { userScrolled.current = true; };
    el.addEventListener('wheel', stop, { passive: true });
    el.addEventListener('touchstart', stop, { passive: true });
    el.addEventListener('keydown', stop);
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchstart', stop);
      el.removeEventListener('keydown', stop);
      window.removeEventListener('resize', measure);
    };
  }, []);

  // ---------------------------------------------------------- at end, read state
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
    atEndRef.current = end;
    setAtEnd(end);
    captureAnchor();
  }, [captureAnchor]);

  useEffect(() => {
    onScroll();
  }, [rows.length, settled, onScroll]);

  const newestSeq = msgs.length ? msgs[msgs.length - 1]!.seq : 0;
  const lastSeen = useRef(docActive ? newestSeq : channel.last_read_seq);

  useEffect(() => {
    if (!docActive || !atEnd || hasMoreAfter || !settled) return;
    lastSeen.current = newestSeq;
    if (!channel.member) return;
    if (channel.last_read_seq >= newestSeq && channel.unread === 0 && channel.mentions === 0) return;
    fire(() => actions.markRead(channelId, newestSeq || undefined));
  }, [docActive, atEnd, hasMoreAfter, newestSeq, channel.member, channel.last_read_seq, channel.unread, channel.mentions, channelId, settled]);

  // Messages that arrive while the window is in the background get a New line.
  useEffect(() => {
    if (docActive || newAfterSeq !== null) return;
    const unseen = msgs.find((m) => m.seq > lastSeen.current && m.author_id !== meId && m.kind === 'user');
    if (unseen) setNewAfterSeq(lastSeen.current);
  }, [docActive, newestSeq, newAfterSeq, msgs, meId]);

  // ---------------------------------------------------------- jump to latest
  const visibleEnd = virtualizer.range?.endIndex ?? lastIndex;
  const below = useMemo(() => {
    let n = 0;
    for (let i = visibleEnd + 1; i < rows.length; i += 1) {
      const r = rows[i]!;
      if (r.kind === 'msg') {
        const m = messages[r.id];
        if (m && m.author_id !== meId) n += 1;
      }
    }
    return n;
  }, [visibleEnd, rows, messages, meId]);

  const toEnd = useCallback(() => {
    if (useDek.getState().timelines[channelId]?.hasMoreAfter) {
      // Showing a window around an old message: go back to the newest page.
      navigate(channelRoute(orgId, channelId), { replace: true });
      // Opens are reference counted by the store: pair this extra one with a close.
      run(() => actions.openChannel(channelId))
        .then(() => apply(() => virtualizer.scrollToEnd()))
        .catch(() => undefined)
        .finally(() => fire(() => actions.closeChannel(channelId)));
      return;
    }
    virtualizer.scrollToEnd();
  }, [channelId, orgId, virtualizer, apply]);

  apiRef.current = {
    scrollToEnd: toEnd,
    clearNew: () => setNewAfterSeq(null),
  };

  // ---------------------------------------------------------- scroll memory
  // Remembered from this list's own tracking: by unmount the virtualizer has
  // already let go of its scroll element and would report "at the end".
  useLayoutEffect(() => () => {
    if (!placed.current) return;
    const a = anchor.current;
    fire(() => actions.rememberScroll(channelId, a?.id ?? null, a ? -a.rel : 0, atEndRef.current));
  }, [channelId]);

  // Screen readers hear new messages only when the list is settled at the end;
  // never while a page of history paints or while the person scrolls.
  const live = atEnd && settled && !loadingOlder && !virtualizer.isScrolling ? 'polite' : 'off';

  const renderRow = (row: ListRow) => {
    switch (row.kind) {
      case 'day':
        return <div className="dk-day" role="separator" aria-label={row.label}><span className="dk-day__label">{row.label}</span></div>;
      case 'new':
        return <div className="dk-newline" role="separator" aria-label="New messages"><span className="dk-newline__label">New</span></div>;
      case 'intro':
        return <Intro channel={channel} title={title} />;
      case 'failed':
        return (
          <div className="dk-list__older dk-list__older--failed" role="alert">
            <span>{`Messages did not load. ${loadError ?? ''}`}</span>
            <Button variant="secondary" icon="refresh" onClick={onRetry}>Try again</Button>
          </div>
        );
      case 'loading':
        return (
          <div className="dk-list__older">
            {olderStatus === 'error' ? (
              <Button variant="secondary" icon="refresh" onClick={loadOlder}>Earlier messages did not load. Try again</Button>
            ) : (
              <><Spinner size={18} /><span>Loading earlier messages</span></>
            )}
          </div>
        );
      case 'msg':
        return <MessageRow id={row.id} grouped={row.grouped} highlighted={row.id === highlightId} ctx={ctx} />;
      case 'pending':
        return <PendingRow clientId={row.clientId} grouped={row.grouped} orgId={orgId} />;
    }
  };

  const showJump = settled && (!atEnd || hasMoreAfter);

  return (
    <div className="dk-listwrap">
      <div
        ref={scrollRef}
        className="dk-list scroll-y"
        role="log"
        aria-live={live}
        aria-relevant="additions"
        aria-label={`Messages in ${title}`}
        aria-busy={!ready || loadingOlder}
        tabIndex={0}
        onScroll={onScroll}
      >
        <div className="dk-list__inner" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((it) => {
            const row = rows[it.index];
            if (!row) return null;
            return (
              <div key={it.key} data-index={it.index} ref={virtualizer.measureElement} className="dk-list__row"
                style={{ transform: `translateY(${it.start}px)` }}>
                {renderRow(row)}
              </div>
            );
          })}
        </div>
      </div>
      {showJump ? (
        <button type="button" className="dk-jump" onClick={toEnd}>
          <Icon name="chevronDown" size={16} />
          <span>{below > 0 ? `${below} new message${below === 1 ? '' : 's'}` : 'Jump to latest'}</span>
        </button>
      ) : null}
    </div>
  );
}

function Intro({ channel, title }: { channel: Channel; title: string }) {
  const dm = channel.kind === 'dm' || channel.kind === 'group_dm';
  return (
    <div className="dk-intro">
      <h2 className="dk-intro__title" dir="auto">{dm ? title : `#${channel.name ?? title}`}</h2>
      <p className="dk-intro__text">
        {dm
          ? `This is the beginning of your conversation with ${title}.`
          : `This is the very beginning of the ${channelKindLabel(channel).toLowerCase()} #${channel.name ?? ''}.`}
      </p>
      {channel.description ? <p className="dk-intro__desc" dir="auto">{channel.description}</p> : null}
    </div>
  );
}
