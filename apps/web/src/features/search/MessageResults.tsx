// Message search results for one applied search: loading, error (rate limits say
// when to retry), empty, results with highlighted terms, and Load more by offset.
import { useMemo } from 'react';
import { api } from '../../api/rpc';
import type { Channel, Message } from '../../api/types';
import { EmptyState } from '../../ui/kit';
import { splitTerms } from '../../ui/markdown';
import { MessageCard } from '../conversation/MessageCard';
import { openMessage } from '../conversation/jump';
import { ListBody, usePagedList } from '../views/common';
import { dayStartIso, nextDayStartIso } from './dates';
import type { SearchFilters } from './Filters';

export interface AppliedSearch {
  query: string;
  filters: SearchFilters;
  run: number; // increments on every submit, so the same search can run again
}

interface Row {
  message: Message;
  channel: Channel;
  at: number; // offset of this row, the cursor for the next page
}

const PAGE = 20;

export function searchArgs(orgId: string, s: AppliedSearch, offset: number) {
  const f = s.filters;
  return {
    org: orgId,
    query: s.query,
    channel: f.channel || null,
    author: f.author?.id ?? null,
    after: f.after ? dayStartIso(f.after) : null,
    before: f.before ? nextDayStartIso(f.before) : null,
    has: f.has || null,
    limit: PAGE,
    offset,
  };
}

export function MessageResults({ orgId, search, deeper }: { orgId: string; search: AppliedSearch; deeper: boolean }) {
  const terms = useMemo(() => splitTerms(search.query), [search.query]);
  const resetKey = `${orgId}|${search.run}|${JSON.stringify(searchArgs(orgId, search, 0))}`;

  const { state, reload, loadMore } = usePagedList<Row, number>({
    resetKey,
    fetchPage: async (cursor) => {
      const offset = cursor ?? 0;
      const res = await api.search(searchArgs(orgId, search, offset));
      return { items: res.items.map((it, i) => ({ ...it, at: offset + i })), hasMore: res.has_more };
    },
    cursorOf: (last) => last.at + 1,
    idOf: (row) => row.message.id,
  });

  const count = state.items.length;

  return (
    <div className="dk-sresults">
      {state.status === 'ready' && count ? (
        <p className="dk-sresults__count" role="status">{`${count}${state.hasMore ? '+' : ''} message${count === 1 && !state.hasMore ? '' : 's'}`}</p>
      ) : null}
      <ListBody
        state={state}
        loadingLabel="Searching messages"
        errorTitle="Search did not finish"
        onRetry={reload}
        onMore={loadMore}
        empty={<EmptyState icon="search" title="No messages match"
          body="Try fewer or different words, a wider date range, or remove a filter. Search looks only in conversations you can open in this organization." />}
      >
        <ul className="dk-view__list" aria-label="Message results">
          {state.items.map((row) => (
            <li key={row.message.id}>
              <MessageCard message={row.message} channel={row.channel} orgId={orgId} highlight={terms}
                onJump={() => openMessage(orgId, row.message, deeper)} jumpLabel="Open" />
            </li>
          ))}
        </ul>
      </ListBody>
    </div>
  );
}
