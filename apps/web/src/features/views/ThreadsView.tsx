// Threads: the threads you follow, newest activity first, with how many replies
// you have not read yet.
import { useState } from 'react';
import { api } from '../../api/rpc';
import { humanError } from '../../api/errors';
import type { InboxCursor, ThreadInboxItem } from '../../api/types';
import { Icon } from '../../ui/icons';
import { Button, EmptyState, toast } from '../../ui/kit';
import { MessageCard } from '../conversation/MessageCard';
import { openThread } from '../conversation/jump';
import { fullTimeLabel, relativeLong } from '../conversation/time';
import type { Layout } from '../shell/layout';
import { ListBody, ViewFrame, isDeeper, refreshCounters, usePagedList } from './common';
import { InboxControls, type InboxFilter } from './InboxControls';

const LIMIT = 30;

export function ThreadsView({ orgId, layout, embedded }: { orgId: string; layout: Layout; embedded?: boolean }) {
  return <ThreadsInner key={orgId} orgId={orgId} layout={layout} embedded={embedded} />;
}

function ThreadsInner({ orgId, layout, embedded }: { orgId: string; layout: Layout; embedded?: boolean }) {
  const deeper = isDeeper(layout);
  const [filter, setFilter] = useState<InboxFilter>('unread');
  const [marking, setMarking] = useState<string | null>(null);
  const { state, reload, loadMore } = usePagedList<ThreadInboxItem & { cursor: InboxCursor | null }, InboxCursor>({
    resetKey: `threads:${orgId}:${filter}`,
    fetchPage: async (before) => {
      const res = await api.listThreadInbox(orgId, before, filter === 'unread', LIMIT);
      if (res.has_more && !res.next_cursor) throw new Error('This page is incomplete. Refresh the inbox.');
      return { items: res.items.map(it => ({ ...it, cursor: res.next_cursor ?? null })), hasMore: res.has_more };
    },
    cursorOf: (it) => it.cursor!,
    idOf: (it) => it.root.id,
  });

  const markRead = async (it: ThreadInboxItem) => {
    if (marking) return;
    setMarking(it.root.id);
    try {
      await api.markThreadRead(it.root.id, it.last_reply_seq);
      reload();
      refreshCounters();
    } catch (e) {
      toast({ kind: 'error', title: 'Could not mark thread read', body: humanError(e) });
    } finally { setMarking(null); }
  };

  return (
    <ViewFrame title="Threads" icon="thread" embedded={embedded}>
      <InboxControls value={filter} onChange={setFilter} onRefresh={reload} loading={state.status === 'loading'} />
      <ListBody
        state={state}
        loadingLabel="Loading threads"
        errorTitle="Threads did not load"
        onRetry={reload}
        onMore={loadMore}
        empty={<EmptyState icon="thread" title={filter === 'unread' ? 'No unread replies' : 'No threads yet'}
          body={filter === 'unread' ? 'You are caught up on followed threads. Choose All to revisit earlier discussions.' : 'Threads you start, reply to or follow show up here.'} />}
      >
        <ul className="dk-view__list dk-thread-inbox" aria-label="Followed threads">
          {state.items.map((it) => (
            <li key={it.root.id}>
              <MessageCard
                message={it.root}
                channel={it.channel}
                orgId={orgId}
                unread={it.unread_replies > 0}
                onJump={() => openThread(orgId, it.channel.id, it.root.id, deeper)}
                jumpLabel="Open thread"
                extra={
                  <>
                  {it.unread_replies > 0 ? <Button variant="ghost" loading={marking === it.root.id}
                    disabled={marking !== null && marking !== it.root.id} onClick={() => void markRead(it)}>Mark read</Button> : null}
                  <span className="dk-threadmeta">
                    <Icon name="thread" size={14} />
                    {it.unread_replies > 0 ? (
                      <strong className="dk-threadmeta__new">{`${it.unread_replies} new ${it.unread_replies === 1 ? 'reply' : 'replies'}`}</strong>
                    ) : (
                      <span>{`${it.root.reply_count} ${it.root.reply_count === 1 ? 'reply' : 'replies'}`}</span>
                    )}
                    <time dateTime={it.activity_at} title={fullTimeLabel(it.activity_at)}>{`${it.last_reply_at ? 'Last reply' : 'Started'} ${relativeLong(it.activity_at)}`}</time>
                  </span>
                  </>
                }
              />
            </li>
          ))}
        </ul>
      </ListBody>
    </ViewFrame>
  );
}
