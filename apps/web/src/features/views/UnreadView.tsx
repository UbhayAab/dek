// Unread: every conversation with unread messages, newest messages per channel,
// with "Mark read" per channel and "Mark all read" for the organization.
import { useMemo, useState } from 'react';
import { api } from '../../api/rpc';
import type { Channel, Message } from '../../api/types';
import { humanError } from '../../api/errors';
import { channelRoute, navigate, navigateDeeper } from '../../app/router';
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Button, EmptyState, toast } from '../../ui/kit';
import { MessageCard } from '../conversation/MessageCard';
import { openMessage } from '../conversation/jump';
import { channelIcon, channelLabel } from '../conversation/names';
import type { Layout } from '../shell/layout';
import { CountBadge } from '../shell/ConversationLink';
import { ListBody, ViewFrame, isDeeper, refreshCounters, useEnsureProfiles, usePagedList } from './common';

interface Group {
  channel: Channel;
  messages: Message[];
}

const PER_CHANNEL = 20;

export function UnreadView({ orgId, layout, embedded }: { orgId: string; layout: Layout; embedded?: boolean }) {
  const profiles = useDek((s) => s.profiles);
  const deeper = isDeeper(layout);
  const [marking, setMarking] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const { state, reload, remove } = usePagedList<Group, null>({
    resetKey: `unread:${orgId}`,
    fetchPage: async () => {
      const res = await api.unreadFeed(orgId, PER_CHANNEL);
      return { items: res.channels.filter((g) => g.messages.length > 0), hasMore: false };
    },
    cursorOf: () => null,
    idOf: (g) => g.channel.id,
  });

  const dmIds = useMemo(() => state.items.flatMap((g) => g.channel.dm_user_ids ?? []), [state.items]);
  useEnsureProfiles(dmIds);

  const markRead = async (g: Group) => {
    if (marking) return;
    setMarking(g.channel.id);
    try {
      const newest = g.messages.reduce((n, m) => Math.max(n, m.seq), g.channel.last_seq);
      await api.markRead(g.channel.id, newest);
      remove(g.channel.id);
      refreshCounters();
    } catch (e) {
      toast({ kind: 'error', title: 'Could not mark it read', body: humanError(e) });
    } finally {
      setMarking(null);
    }
  };

  const markAll = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      const res = await api.markAllRead(orgId);
      toast({
        kind: 'success',
        title: res.count ? `Marked ${res.count} conversation${res.count === 1 ? '' : 's'} as read` : 'Everything was already read',
      });
      reload();
      refreshCounters();
    } catch (e) {
      toast({ kind: 'error', title: 'Could not mark everything read', body: humanError(e) });
    } finally {
      setMarkingAll(false);
    }
  };

  const openChannel = (channelId: string) => {
    const to = channelRoute(orgId, channelId);
    if (deeper) navigateDeeper(to);
    else navigate(to);
  };

  const headerAction = state.status === 'ready' && state.items.length ? (
    <Button variant="secondary" icon="check" onClick={() => void markAll()} loading={markingAll}>Mark all read</Button>
  ) : null;

  return (
    <ViewFrame title="Unread" icon="inbox" actions={headerAction} embedded={embedded}
      subtitle={state.status === 'ready' && state.items.length ? `${state.items.length} conversation${state.items.length === 1 ? '' : 's'} with new messages` : undefined}>
      <ListBody
        state={state}
        loadingLabel="Loading unread messages"
        errorTitle="Unread messages did not load"
        onRetry={reload}
        empty={<EmptyState icon="check" title="You are all caught up" body="New messages in your channels and direct messages show up here." />}
      >
        <ul className="dk-view__list" aria-label="Conversations with unread messages">
          {state.items.map((g) => {
            const label = channelLabel(g.channel, profiles);
            const count = Math.max(g.channel.unread, g.messages.length);
            return (
              <li key={g.channel.id} className="dk-ugroup">
                <div className="dk-ugroup__head">
                  <span className="dk-ugroup__icon" aria-hidden="true"><Icon name={channelIcon(g.channel)} size={16} /></span>
                  <h2 className="dk-ugroup__title" dir="auto">{label}</h2>
                  <CountBadge count={g.channel.mentions} label={g.channel.mentions === 1 ? 'mention' : 'mentions'} />
                  <span className="dk-ugroup__count">{`${count >= 100 ? '100+' : count} new`}</span>
                  <div className="dk-ugroup__actions">
                    <Button variant="ghost" icon="check" onClick={() => void markRead(g)} loading={marking === g.channel.id}
                      disabled={marking !== null && marking !== g.channel.id} aria-label={`Mark read: ${label}`}>Mark read</Button>
                    <Button variant="secondary" icon="chevronRight" onClick={() => openChannel(g.channel.id)} aria-label={`Open ${label}`}>Open</Button>
                  </div>
                </div>
                <ul className="dk-ugroup__msgs" aria-label={`New in ${label}`}>
                  {g.messages.map((m) => (
                    <li key={m.id}>
                      <MessageCard message={m} channel={g.channel} orgId={orgId} showChannel={false}
                        onJump={() => openMessage(orgId, m, deeper)} jumpLabel="Open" />
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </ListBody>
    </ViewFrame>
  );
}
