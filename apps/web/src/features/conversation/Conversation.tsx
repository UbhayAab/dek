// A conversation screen (DEK06 to DEK09): header, message list, typing line and
// composer, with the thread or a side panel. Desktop: the side is a column;
// tablet: an overlay; phone: one layer at a time (thread or panel on top), and
// the browser back button walks back through them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/rpc';
import { humanError } from '../../api/errors';
import { back, channelRoute, navigate, navigateDeeper } from '../../app/router';
import { actions, useDek } from '../../store';
import { Banner, Button, EmptyState, ErrorState, Skeleton } from '../../ui/kit';
import { useMeId, useOrgRole, useOrgSettings } from '../shell/hooks';
import { closePane, useLayout, usePane } from '../shell/layout';
import { rememberChannel } from '../shell/ui-store';
import { Composer } from './Composer';
import { ConversationHeader } from './ConversationHeader';
import { lazyMdContext } from './md';
import { MessageList, type ListApi } from './MessageList';
import type { RowContext } from './MessageRow';
import { channelTitle, isDm } from './names';
import { SidePanel } from './panels';
import type { Who } from './permissions';
import { fire, run } from './safe';
import { ThreadPane } from './ThreadPane';
import { TypingLine } from './TypingLine';

interface Props {
  orgId: string;
  channelId: string;
  messageId: string | null;
  threadId: string | null;
  threadMessageId: string | null;
}

// Opens the channel in the store (newest page, or the window around a
// deep-linked message) and reports whether that request is still in flight.
function useOpenChannel(channelId: string, messageId: string | null, enabled: boolean) {
  const [opening, setOpening] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    first.current = true;
    setOpening(true);
    setError(null);
    run(() => actions.openChannel(channelId, { aroundMessageId: messageId }))
      .then(() => { if (live) setOpening(false); })
      .catch((e: unknown) => { if (live) { setOpening(false); setError(humanError(e)); } });
    return () => {
      live = false;
      fire(() => actions.closeChannel(channelId));
    };
    // messageId is read once per open; later changes are handled below.
  }, [channelId, enabled, attempt]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    if (!messageId || !enabled) return undefined;
    const st = useDek.getState();
    if (st.timelines[channelId]?.ids.includes(messageId)) return undefined;
    let live = true;
    setOpening(true);
    // Opens are reference counted by the store: this extra one is closed again.
    run(() => actions.openChannel(channelId, { aroundMessageId: messageId }))
      .catch(() => undefined)
      .finally(() => {
        fire(() => actions.closeChannel(channelId));
        if (live) setOpening(false);
      });
    return () => { live = false; };
  }, [messageId, channelId, enabled]);

  return { opening, error, retry: () => setAttempt((n) => n + 1) };
}

export function Conversation({ orgId, channelId, messageId, threadId, threadMessageId }: Props) {
  const layout = useLayout();
  const phone = layout === 'phone';
  const channel = useDek((s) => s.channels[channelId]);
  const bootstrapStatus = useDek((s) => s.bootstrap.status);
  const storeOrg = useDek((s) => s.orgId);
  const timeline = useDek((s) => s.timelines[channelId]);
  const profiles = useDek((s) => s.profiles);
  const server = useDek((s) => (channel?.server_id ? s.servers[channel.server_id] : undefined));
  const meId = useMeId();
  const orgRole = useOrgRole(orgId);
  const settings = useOrgSettings(orgId);
  const pane = usePane();
  const listApi = useRef<ListApi | null>(null);
  const pendingHere = useDek((s) => Object.values(s.pending).some((p) => p.channelId === channelId && !p.threadRootId));
  const { opening, error: openError, retry } = useOpenChannel(channelId, messageId, !!channel);

  useEffect(() => {
    if (channel) rememberChannel(meId, orgId, channelId);
  }, [channel, meId, orgId, channelId]);

  // Rows re-render only when something that changes what they show or allow
  // changes, not on every unread counter tick of the channel.
  const permSig = channel
    ? [channel.member, channel.archived, channel.allow_reactions, channel.allow_replies, channel.posting_policy, channel.my_role,
      channel.member_count > 50, channel.name, channel.kind].join('|')
    : '';
  const stableChannel = useMemo(() => channel, [permSig, channelId]);
  const who = useMemo<Who>(() => ({ meId, orgRole, server }), [meId, orgRole, server]);

  const onOpenThread = useCallback((rootId: string) => {
    const to = channelRoute(orgId, channelId, { threadId: rootId });
    if (phone) navigateDeeper(to);
    else navigate(to);
  }, [orgId, channelId, phone]);

  const md = useMemo(() => lazyMdContext(orgId, meId), [orgId, meId]);
  const ctx = useMemo<RowContext | null>(() => (stableChannel ? {
    orgId, channel: stableChannel, who, settings, inThread: false, onOpenThread, md,
  } : null), [orgId, stableChannel, who, settings, onOpenThread, md]);

  const closeThread = useCallback(() => {
    const to = channelRoute(orgId, channelId);
    if (phone) back(to);
    else navigate(to);
  }, [orgId, channelId, phone]);

  // ------------------------------------------------------------ not (yet) here
  if (!channel || !ctx) {
    if (bootstrapStatus !== 'ready' || storeOrg !== orgId) return <ConversationSkeleton />;
    return <Unavailable orgId={orgId} channelId={channelId} />;
  }

  const title = channelTitle(channel, profiles);
  // A failed load never hides the conversation's own pending sends.
  const loadError = timeline?.status === 'error' ? (timeline.error ?? openError ?? 'Check your connection.') : (!timeline?.ids.length ? openError : null);
  const placeholder = isDm(channel) ? `Message ${title}` : `Message #${channel.name ?? title}`;

  // Phones: one layer at a time.
  if (phone && threadId) {
    return <ThreadPane key={threadId} rootId={threadId} messageId={threadMessageId} ctx={ctx} variant="screen" onClose={closeThread} />;
  }
  if (phone && pane) {
    return <SidePanel pane={pane} channel={channel} orgId={orgId} variant="screen" who={who} deeper />;
  }

  const main = (
    <section className="dk-convo" aria-label={title}>
      <ConversationHeader channel={channel} orgId={orgId} who={who} phone={phone} pane={pane}
        onBack={phone ? () => back({ name: 'org', orgId }) : undefined} />
      {loadError && (timeline?.ids.length ?? 0) > 0 ? (
        <div className="dk-convo__banner">
          <Banner tone="warning" action={<Button variant="ghost" icon="refresh" onClick={retry}>Try again</Button>}>
            {`This conversation could not refresh. ${loadError}`}
          </Banner>
        </div>
      ) : null}
      {loadError && !timeline?.ids.length && !pendingHere ? (
        <div className="dk-convo__state">
          <ErrorState title="Messages did not load" body={loadError} onRetry={retry} />
        </div>
      ) : !loadError && (!timeline || (timeline.status === 'loading' && !timeline.ids.length)) ? (
        <div className="dk-convo__state dk-convo__state--loading" aria-busy="true" aria-label="Loading messages">
          <Skeleton /><Skeleton lines={2} /><Skeleton lines={4} /><Skeleton lines={1} />
        </div>
      ) : (
        <MessageList key={channelId} orgId={orgId} channel={channel} title={title} ctx={ctx} messageId={messageId}
          opening={opening} loadError={loadError} onRetry={retry} apiRef={listApi} />
      )}
      <TypingLine channelId={channelId} threadRootId={null} meId={meId} />
      <Composer key={`${channelId}:main`} orgId={orgId} channel={channel} who={who} threadRootId={null} placeholder={placeholder}
        autoFocus={!threadId && !pane}
        onSent={() => { listApi.current?.clearNew(); listApi.current?.scrollToEnd(); }} />
    </section>
  );

  const side = threadId
    ? <ThreadPane key={threadId} rootId={threadId} messageId={threadMessageId} ctx={ctx} variant="pane" onClose={closeThread} />
    : pane
      ? <SidePanel pane={pane} channel={channel} orgId={orgId} variant="pane" who={who} deeper={false} />
      : null;

  return (
    <div className={`dk-convo-layout${side ? ' has-side' : ''}`}>
      {main}
      {side ? (
        <>
          {layout === 'tablet' ? (
            <button type="button" className="dk-side__scrim" aria-label="Close panel" tabIndex={-1}
              onClick={() => (threadId ? closeThread() : closePane())} />
          ) : null}
          <div className="dk-side">{side}</div>
        </>
      ) : null}
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <section className="dk-convo" aria-busy="true" aria-label="Loading conversation">
      <div className="dk-convhead dk-convhead--skeleton"><Skeleton lines={1} avatar={false} /></div>
      <div className="dk-convo__state dk-convo__state--loading"><Skeleton /><Skeleton lines={2} /><Skeleton lines={3} /></div>
    </section>
  );
}

// DEK18: a link to something you cannot open shows a safe unavailable state,
// and a public channel you have not joined can be joined from here.
function Unavailable({ orgId, channelId }: { orgId: string; channelId: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const join = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await api.joinChannel(channelId);
      await run(() => actions.refreshBootstrap());
    } catch (e) {
      setFailed(humanError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="dk-convo dk-convo--empty" aria-label="Conversation not available">
      {failed ? (
        <ErrorState title="This conversation is not available" body="It may be private, archived, in another organization, or you were removed from it."
          className="dk-convo__unavailable" />
      ) : (
        <EmptyState icon="lock" title="This conversation is not in your list"
          body="If it is a public channel in one of your servers, you can join it. Private conversations need someone to add you."
          action={<div className="dk-row-actions">
            <Button variant="primary" loading={busy} onClick={() => void join()}>Join channel</Button>
            <Button variant="secondary" onClick={() => navigate({ name: 'org', orgId })}>Go to Home</Button>
          </div>} />
      )}
      {failed ? <div className="dk-row-actions dk-row-actions--center"><Button variant="secondary" onClick={() => navigate({ name: 'org', orgId })}>Go to Home</Button></div> : null}
    </section>
  );
}
