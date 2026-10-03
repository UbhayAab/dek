// Saved: your personal bookmarks, newest saved first, with Remove and Load more.
import { useEffect, useState } from 'react';
import { api } from '../../api/rpc';
import type { Channel, ISO, Message } from '../../api/types';
import { humanError } from '../../api/errors';
import { actions } from '../../store';
import { Button, EmptyState, toast } from '../../ui/kit';
import { MessageCard } from '../conversation/MessageCard';
import { openMessage } from '../conversation/jump';
import type { Layout } from '../shell/layout';
import { markSaved } from '../shell/ui-store';
import { ListBody, ViewFrame, isDeeper, runAction, usePagedList } from './common';

interface Item {
  message: Message;
  channel: Channel;
  saved_at: ISO;
}

const PAGE = 30;

export function SavedView({ orgId, layout, embedded }: { orgId: string; layout: Layout; embedded?: boolean }) {
  const deeper = isDeeper(layout);
  const [removing, setRemoving] = useState<string | null>(null);
  const { state, reload, loadMore, remove } = usePagedList<Item, ISO>({
    resetKey: `saved:${orgId}`,
    fetchPage: async (before) => {
      const res = await api.listSaved(orgId, before, PAGE);
      return { items: res.items, hasMore: res.has_more };
    },
    cursorOf: (last) => last.saved_at,
    idOf: (it) => it.message.id,
  });

  // The Message shape has no "saved" flag: tell the message menus what we know.
  useEffect(() => {
    if (state.items.length) markSaved(state.items.map((it) => it.message.id), true);
  }, [state.items]);

  const unsave = async (id: string) => {
    if (removing) return;
    setRemoving(id);
    try {
      await runAction(() => actions.saveMessage(id, false));
      remove(id);
      markSaved([id], false);
      toast({ kind: 'success', title: 'Removed from saved' });
    } catch (e) {
      toast({ kind: 'error', title: 'Could not remove it from saved', body: humanError(e) });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <ViewFrame title="Saved" icon="bookmark" embedded={embedded}>
      <ListBody
        state={state}
        loadingLabel="Loading saved messages"
        errorTitle="Saved messages did not load"
        onRetry={reload}
        onMore={loadMore}
        empty={<EmptyState icon="bookmark" title="Nothing saved yet"
          body="Save a message from its actions menu to find it here later. Only you can see what you save." />}
      >
        <ul className="dk-view__list" aria-label="Saved messages">
          {state.items.map((it) => (
            <li key={it.message.id}>
              <MessageCard
                message={it.message}
                channel={it.channel}
                orgId={orgId}
                onJump={() => openMessage(orgId, it.message, deeper)}
                jumpLabel="Open"
                extra={
                  <Button variant="ghost" icon="bookmark" onClick={() => void unsave(it.message.id)}
                    loading={removing === it.message.id} disabled={removing !== null && removing !== it.message.id}>
                    Remove
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
      </ListBody>
    </ViewFrame>
  );
}
