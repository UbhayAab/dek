// Mentions: messages that mention you (or everyone where you are), newest first,
// unread ones marked, with Load more.
import { api } from '../../api/rpc';
import type { Channel, ISO, Message } from '../../api/types';
import { EmptyState } from '../../ui/kit';
import { MessageCard } from '../conversation/MessageCard';
import { openMessage } from '../conversation/jump';
import type { Layout } from '../shell/layout';
import { ListBody, ViewFrame, isDeeper, usePagedList } from './common';

interface Item {
  message: Message;
  channel: Channel;
  read: boolean;
}

const PAGE = 30;

export function MentionsView({ orgId, layout, embedded }: { orgId: string; layout: Layout; embedded?: boolean }) {
  const deeper = isDeeper(layout);
  const { state, reload, loadMore } = usePagedList<Item, ISO>({
    resetKey: `mentions:${orgId}`,
    fetchPage: async (before) => {
      const res = await api.listMentions(orgId, before, PAGE);
      return { items: res.items, hasMore: res.has_more };
    },
    cursorOf: (last) => last.message.created_at,
    idOf: (it) => it.message.id,
  });

  return (
    <ViewFrame title="Mentions" icon="at" embedded={embedded}>
      <ListBody
        state={state}
        loadingLabel="Loading mentions"
        errorTitle="Mentions did not load"
        onRetry={reload}
        onMore={loadMore}
        empty={<EmptyState icon="at" title="No mentions yet"
          body="When someone mentions you, or uses @channel or @here in a conversation you are in, it shows up here." />}
      >
        <ul className="dk-view__list" aria-label="Mentions">
          {state.items.map((it) => (
            <li key={it.message.id}>
              <MessageCard message={it.message} channel={it.channel} orgId={orgId} unread={!it.read}
                onJump={() => openMessage(orgId, it.message, deeper)} jumpLabel="Open" />
            </li>
          ))}
        </ul>
      </ListBody>
    </ViewFrame>
  );
}
