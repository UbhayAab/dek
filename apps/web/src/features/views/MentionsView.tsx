// Mentions: messages that mention you (or everyone where you are), newest first,
// unread ones marked, with Load more.
import { useState } from 'react';
import { api } from '../../api/rpc';
import { humanError } from '../../api/errors';
import type { InboxCursor, MentionInboxItem } from '../../api/types';
import { Button, EmptyState, toast } from '../../ui/kit';
import { MessageCard } from '../conversation/MessageCard';
import { openMessage } from '../conversation/jump';
import type { Layout } from '../shell/layout';
import { ListBody, ViewFrame, isDeeper, refreshCounters, usePagedList } from './common';
import { InboxControls, type InboxFilter } from './InboxControls';

const PAGE = 30;

export function MentionsView({ orgId, layout, embedded }: { orgId: string; layout: Layout; embedded?: boolean }) {
  return <MentionsInner key={orgId} orgId={orgId} layout={layout} embedded={embedded} />;
}

function MentionsInner({ orgId, layout, embedded }: { orgId: string; layout: Layout; embedded?: boolean }) {
  const deeper = isDeeper(layout);
  const [filter, setFilter] = useState<InboxFilter>('unread');
  const [marking, setMarking] = useState<string | null>(null);
  const { state, reload, loadMore } = usePagedList<MentionInboxItem & { cursor: InboxCursor | null }, InboxCursor>({
    resetKey: `mentions:${orgId}:${filter}`,
    fetchPage: async (before) => {
      const res = await api.listMentionInbox(orgId, before, filter === 'unread', PAGE);
      if (res.has_more && !res.next_cursor) throw new Error('This page is incomplete. Refresh the inbox.');
      return { items: res.items.map(it => ({ ...it, cursor: res.next_cursor ?? null })), hasMore: res.has_more };
    },
    cursorOf: (last) => last.cursor!,
    idOf: (it) => it.message.id,
  });

  const markRead = async (it: MentionInboxItem) => {
    if (marking) return;
    setMarking(it.message.id);
    try {
      await api.markRead(it.channel.id, it.message.seq);
      reload();
      refreshCounters();
      toast({ kind: 'success', title: 'Marked read through this mention', body: 'Earlier messages in this conversation are also marked read.' });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not mark mention read', body: humanError(e) });
    } finally { setMarking(null); }
  };

  return (
    <ViewFrame title="Mentions" icon="at" embedded={embedded}>
      <InboxControls value={filter} onChange={setFilter} onRefresh={reload} loading={state.status === 'loading'} />
      <ListBody
        state={state}
        loadingLabel="Loading mentions"
        errorTitle="Mentions did not load"
        onRetry={reload}
        onMore={loadMore}
        empty={<EmptyState icon="at" title={filter === 'unread' ? 'No unread mentions' : 'No mentions yet'}
          body={filter === 'unread' ? 'You are caught up. Choose All to revisit earlier mentions.' : 'When someone mentions you, or uses @channel or @here in a conversation you are in, it shows up here.'} />}
      >
        <ul className="dk-view__list" aria-label="Mentions">
          {state.items.map((it) => (
            <li key={it.message.id}>
              <MessageCard message={it.message} channel={it.channel} orgId={orgId} unread={!it.read}
                onJump={() => openMessage(orgId, it.message, deeper)} jumpLabel="Open"
                extra={!it.read && it.channel.member ? <Button variant="ghost" title="Mark this conversation read up to this mention. Later messages stay unread."
                  loading={marking === it.message.id} disabled={marking !== null && marking !== it.message.id}
                  onClick={() => void markRead(it)}>Mark read</Button> : null} />
            </li>
          ))}
        </ul>
      </ListBody>
    </ViewFrame>
  );
}
