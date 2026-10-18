// A thread: persistent parent context, its replies, a dedicated composer,
// follow and unfollow, and reads bounded by the replies actually on screen.
// Desktop: the right pane. Phone: a full-screen layer over the conversation.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { humanError } from '../../api/errors';
import { actions, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { toPlainText } from '../../ui/markdown';
import { Button, ErrorState, IconButton, Skeleton, Spinner, toast } from '../../ui/kit';
import { ScreenHeader } from '../shell/ScreenHeader';
import { Composer } from './Composer';
import { MessageRow, PendingRow, type RowContext } from './MessageRow';
import { channelLabel, personName } from './names';
import { buildRows } from './rows';
import { fire, run, useDocumentActive } from './safe';
import { TypingLine } from './TypingLine';

const AT_END_PX = 60;

interface Props {
  rootId: string;
  messageId: string | null;
  ctx: RowContext;
  variant: 'pane' | 'screen';
  onClose: () => void;
  onPostInChannel?: () => void;
}

export function ThreadPane({ rootId, messageId, ctx, variant, onClose, onPostInChannel }: Props) {
  const thread = useDek((s) => s.threads[rootId]);
  const root = useDek((s) => s.messages[rootId]);
  const messages = useDek((s) => s.messages);
  const pendingMap = useDek((s) => s.pending);
  const profiles = useDek((s) => s.profiles);
  const docActive = useDocumentActive();
  const [openError, setOpenError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const [scrollVersion, setScrollVersion] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(messageId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const placed = useRef(false);
  const ctxThread = useMemo<RowContext>(() => ({ ...ctx, inThread: true,onOpenThread:id=>{
    if(id===rootId)document.querySelector<HTMLTextAreaElement>('.dk-thread textarea')?.focus({preventScroll:true});
    else ctx.onOpenThread(id);
  } }), [ctx,rootId]);

  useEffect(() => {
    let live = true;
    setOpenError(null);
    run(() => actions.openThread(rootId, { messageId, channelId: ctx.channel.id })).catch((e: unknown) => { if (live) setOpenError(humanError(e)); });
    return () => { live = false; fire(() => actions.closeThread(rootId)); };
  }, [rootId, messageId, ctx.channel.id, attempt]);

  const replies = useMemo(
    () => (thread?.replyIds ?? []).map((id) => messages[id]).filter((m): m is NonNullable<typeof m> => !!m),
    [thread?.replyIds, messages],
  );
  const pending = useMemo(() => Object.values(pendingMap).filter((p) => p.threadRootId === rootId), [pendingMap, rootId]);
  const rows = useMemo(
    () => buildRows({ messages: replies, pending, meId: ctx.who.meId, newAfterSeq: null, hasMoreBefore: false }).filter((r) => r.kind !== 'day'),
    [replies, pending, ctx.who.meId],
  );

  useLayoutEffect(() => { placed.current = false; stick.current = !messageId; setHighlightId(messageId); }, [rootId, messageId]);

  // Bottom anchored: follow new replies while at the end; first paint goes to
  // the deep-linked reply or the end.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !thread || thread.status !== 'ready') return;
    if ((thread.targetId ?? null) !== messageId) return;
    if (!placed.current) {
      const target = messageId ? el.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`) : null;
      if (messageId && !target) return;
      placed.current = true;
      if (target) {
        target.scrollIntoView({ block: 'center' });
        setHighlightId(messageId);
        return;
      }
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, thread, messageId]);

  useEffect(() => {
    if (!highlightId) return undefined;
    const t = setTimeout(() => setHighlightId(null), 4000);
    return () => clearTimeout(t);
  }, [highlightId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
    stick.current = end;
    setAtEnd(end);
    setScrollVersion(n => n + 1);
  };

  const newest = replies.length ? replies[replies.length - 1]!.seq : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!docActive || !placed.current || !thread || thread.status !== 'ready' || !el) return;
    if (!newest || thread.lastReadReplySeq >= newest) return;
    const bounds = el.getBoundingClientRect();
    const visible = replies.filter(m => {
      const row = el.querySelector<HTMLElement>(`[data-message-id="${m.id}"]`);
      const rect = row?.getBoundingClientRect();
      return rect && rect.bottom <= bounds.bottom + 1 && rect.bottom > bounds.top;
    });
    const seq = Math.max(0, ...visible.map(m => m.seq));
    if (seq) fire(() => actions.markThreadRead(rootId, seq));
  }, [docActive, scrollVersion, thread, newest, rootId, replies]);

  const toggleFollow = async () => {
    if (!thread) return;
    setFollowBusy(true);
    const next = !thread.following;
    try {
      await run(() => actions.followThread(rootId, next));
      toast({ kind: 'success', title: next ? 'Following this thread' : 'Unfollowed this thread', body: next ? 'Reply alerts respect your notification settings, mute and quiet hours.' : 'Conversation alerts and direct or group tags still follow your notification settings.' });
    } catch (e) {
      toast({ kind: 'error', title: 'Not changed', body: humanError(e) });
    } finally {
      setFollowBusy(false);
    }
  };

  const loadMore = async (direction: 'before' | 'after') => {
    setMoreBusy(true);
    stick.current = false;
    const el = scrollRef.current;
    const oldHeight = el?.scrollHeight ?? 0, oldTop = el?.scrollTop ?? 0;
    try {
      await run(() => actions.loadThreadMore(rootId, direction));
      if (direction === 'before') requestAnimationFrame(() => { if (el) el.scrollTop = oldTop + el.scrollHeight - oldHeight; });
    } catch (e) {
      toast({ kind: 'error', title: 'More replies did not load', body: humanError(e) });
    } finally {
      setMoreBusy(false);
    }
  };
  const showLatest = () => {
    placed.current=false;stick.current=true;setHighlightId(null);
    if(messageId)ctx.onOpenThread(rootId);
    else setAttempt(n=>n+1);
  };

  const title = variant === 'screen' ? 'Reply in thread' : 'Thread';
  const where = channelLabel(ctx.channel, profiles);
  const following = thread?.following ?? false;
  const followButton = (
    <Button variant={following ? 'secondary' : 'ghost'} icon={following ? 'bellOff' : 'bell'} loading={followBusy} onClick={() => void toggleFollow()} disabled={!thread || thread.status !== 'ready'}
      title={following ? 'Stop reply alerts. Direct tags may still notify you.' : 'Reply alerts respect your notification preferences and quiet hours.'}>
      {following ? 'Unfollow' : 'Follow'}
    </Button>
  );

  return (
    <section className={`dk-thread dk-thread--${variant}`} aria-label={`Thread in ${where}`}>
      {variant === 'screen' ? (
        <ScreenHeader title={title} subtitle={where} onBack={onClose} backLabel="Back to the conversation" actions={followButton} />
      ) : (
        <header className="dk-panehead">
          <div className="dk-panehead__titles">
            <h2 className="dk-panehead__title"><Icon name="thread" size={18} />{title}</h2>
            <p className="dk-panehead__sub">{where}</p>
          </div>
          {followButton}
          <IconButton icon="x" label="Close thread" onClick={onClose} />
        </header>
      )}
      {root && root.channel_id === ctx.channel.id ? <div className="dk-thread__context">
        <button type="button" className="dk-thread__parent" onClick={() => scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${rootId}"]`)?.scrollIntoView({ block: 'start' })}>
          <strong>{`Thread started by ${personName(profiles, root.author_id)}`}</strong>
          <span>{root.deleted_at ? 'The original message was deleted.' : toPlainText(root.body, ctx.md).slice(0, 200) || 'Attachment'}</span>
        </button>
        {onPostInChannel ? <Button variant="ghost" onClick={onPostInChannel}>{`Post to ${where}`}</Button> : null}
      </div> : null}
      <div ref={scrollRef} className="dk-thread__scroll scroll-y" role="log" aria-live={atEnd && placed.current ? 'polite' : 'off'} aria-label="Replies" tabIndex={0} onScroll={onScroll}>
        {(openError || thread?.status === 'error') && (!root || root.channel_id !== ctx.channel.id) ? (
          <ErrorState title="This thread did not load" body={openError} onRetry={() => setAttempt((n) => n + 1)} />
        ) : !root || root.channel_id !== ctx.channel.id ? (
          <div className="dk-thread__loading"><Skeleton lines={3} /><Skeleton lines={2} /></div>
        ) : (
          <>
            <MessageRow id={rootId} grouped={false} highlighted={highlightId === rootId} ctx={ctxThread} isThreadRoot />
            <div className="dk-thread__count" role="separator">
              <span>{root.reply_count === 1 ? '1 reply' : `${root.reply_count} replies`}</span>
            </div>
            {thread?.hasBefore ? <div className="dk-thread__more"><Button variant="secondary" loading={moreBusy} onClick={() => void loadMore('before')}>Load earlier replies</Button></div> : null}
            {!thread || thread.status === 'loading' ? (
              <div className="dk-thread__loading"><Spinner size={18} label="Loading replies" /></div>
            ) : thread.status === 'error' ? (
              <ErrorState title="Replies did not load" body={thread.error ?? undefined} onRetry={() => setAttempt((n) => n + 1)} />
            ) : null}
            {rows.map((r) => (r.kind === 'msg'
              ? <MessageRow key={r.key} id={r.id} grouped={r.grouped} highlighted={highlightId === r.id} ctx={ctxThread} />
              : r.kind === 'pending'
                ? <PendingRow key={r.key} clientId={r.clientId} grouped={r.grouped} orgId={ctx.orgId} />
                : null))}
            {thread?.hasAfter ? (
              <div className="dk-thread__more">
                <Button variant="secondary" loading={moreBusy} onClick={() => void loadMore('after')}>Load newer replies</Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      {thread?.newReplies ? <div className="dk-thread__new"><Button variant="secondary" onClick={showLatest}>New replies - show latest</Button></div> : null}
      <TypingLine channelId={ctx.channel.id} threadRootId={rootId} meId={ctx.who.meId} />
      {root && root.channel_id === ctx.channel.id && !root.deleted_at && thread?.status === 'ready' && !openError ? (
        <Composer orgId={ctx.orgId} channel={ctx.channel} who={ctx.who} threadRootId={rootId} placeholder="Reply in thread"
          autoFocus compact onSent={() => { stick.current = true; }} />
      ) : root?.deleted_at ? (
        <p className="dk-thread__closed">The first message of this thread was deleted, so it takes no new replies.</p>
      ) : null}
    </section>
  );
}
