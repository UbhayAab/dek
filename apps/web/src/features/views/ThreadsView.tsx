// Threads: the threads you follow, newest activity first, with how many replies
// you have not read yet.
import { api } from '../../api/rpc';
import type { Channel, ISO, Message } from '../../api/types';
import { Icon } from '../../ui/icons';
import { EmptyState } from '../../ui/kit';
import { MessageCard } from '../conversation/MessageCard';
import { openThread } from '../conversation/jump';
import { fullTimeLabel, relativeLong } from '../conversation/time';
import type { Layout } from '../shell/layout';
import { ListBody, ViewFrame, isDeeper, usePagedList } from './common';

interface Item {
  root: Message;
  channel: Channel;
  unread_replies: number;
  last_reply_at: ISO;
}

const LIMIT = 30;

export function ThreadsView({ orgId, layout, embedded }: { orgId: string; layout: Layout; embedded?: boolean }) {
  const deeper = isDeeper(layout);
  const { state, reload } = usePagedList<Item, null>({
    resetKey: `threads:${orgId}`,
    fetchPage: async () => {
      const res = await api.listThreads(orgId, LIMIT);
      return { items: res.threads, hasMore: false };
    },
    cursorOf: () => null,
    idOf: (it) => it.root.id,
  });

  return (
    <ViewFrame title="Threads" icon="thread" embedded={embedded}>
      <ListBody
        state={state}
        loadingLabel="Loading threads"
        errorTitle="Threads did not load"
        onRetry={reload}
        empty={<EmptyState icon="thread" title="No threads yet"
          body="Threads you start, reply to or follow show up here, with the replies you have not read." />}
      >
        <ul className="dk-view__list" aria-label="Followed threads">
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
                  <span className="dk-threadmeta">
                    <Icon name="thread" size={14} />
                    {it.unread_replies > 0 ? (
                      <strong className="dk-threadmeta__new">{`${it.unread_replies} new ${it.unread_replies === 1 ? 'reply' : 'replies'}`}</strong>
                    ) : (
                      <span>{`${it.root.reply_count} ${it.root.reply_count === 1 ? 'reply' : 'replies'}`}</span>
                    )}
                    <time dateTime={it.last_reply_at} title={fullTimeLabel(it.last_reply_at)}>{`Last reply ${relativeLong(it.last_reply_at)}`}</time>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      </ListBody>
    </ViewFrame>
  );
}
