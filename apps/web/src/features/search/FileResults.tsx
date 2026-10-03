// File search: file names (or the newest files when there is no query) in the
// conversations this person can open, with Open jumping to the message.
import { useMemo } from 'react';
import { api } from '../../api/rpc';
import type { Attachment, Channel, Message } from '../../api/types';
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Button, EmptyState } from '../../ui/kit';
import { highlightText, splitTerms } from '../../ui/markdown';
import { openMessage } from '../conversation/jump';
import { channelLabel, personName } from '../conversation/names';
import { fullTimeLabel, relativeShort } from '../conversation/time';
import { ListBody, useEnsureProfiles, usePagedList } from '../views/common';
import { fileIcon, fileKind, fileKindLabel, humanSize } from './files';

interface Row {
  attachment: Attachment;
  message: Message;
  channel: Channel;
  at: number;
}

const PAGE = 30;

interface Props {
  orgId: string;
  query: string;
  channel: string;
  run: number;
  deeper: boolean;
}

export function FileResults({ orgId, query, channel, run, deeper }: Props) {
  const profiles = useDek((s) => s.profiles);
  const terms = useMemo(() => splitTerms(query), [query]);
  const q = query.trim();

  const { state, reload, loadMore } = usePagedList<Row, number>({
    resetKey: `${orgId}|${run}|${q}|${channel}`,
    fetchPage: async (cursor) => {
      const offset = cursor ?? 0;
      const res = await api.searchFiles(orgId, q || null, channel || null, PAGE, offset);
      return { items: res.items.map((it, i) => ({ ...it, at: offset + i })), hasMore: res.has_more };
    },
    cursorOf: (last) => last.at + 1,
    idOf: (row) => row.attachment.id,
  });

  const people = useMemo(
    () => state.items.flatMap((r) => [r.message.author_id, ...(r.channel.dm_user_ids ?? [])]),
    [state.items],
  );
  useEnsureProfiles(people);

  return (
    <div className="dk-sresults">
      {state.status === 'ready' && state.items.length ? (
        <p className="dk-sresults__count" role="status">
          {q ? `${state.items.length}${state.hasMore ? '+' : ''} file${state.items.length === 1 && !state.hasMore ? '' : 's'}` : 'Newest files'}
        </p>
      ) : null}
      <ListBody
        state={state}
        loadingLabel="Searching files"
        errorTitle="File search did not finish"
        onRetry={reload}
        onMore={loadMore}
        empty={<EmptyState icon="file" title={q ? 'No files match' : 'No files yet'}
          body={q ? 'File search matches the file name. Try part of the name, or another conversation.' : 'Files shared in your conversations show up here.'} />}
      >
        <ul className="dk-files" aria-label="File results">
          {state.items.map((row) => {
            const kind = fileKind(row.attachment.mime_type);
            const author = personName(profiles, row.message.author_id);
            const where = channelLabel(row.channel, profiles);
            return (
              <li key={row.attachment.id} className="dk-file">
                <span className={`dk-file__icon dk-file__icon--${kind}`} aria-hidden="true">
                  <Icon name={fileIcon(kind)} size={20} />
                </span>
                <div className="dk-file__main">
                  <span className="dk-file__name" dir="auto">{highlightText(row.attachment.file_name, terms)}</span>
                  <span className="dk-file__meta">
                    <span>{fileKindLabel(kind)}</span>
                    {humanSize(row.attachment.size_bytes) ? <span>{humanSize(row.attachment.size_bytes)}</span> : null}
                    <span dir="auto">{where}</span>
                    <span dir="auto">{author}</span>
                    <time dateTime={row.message.created_at} title={fullTimeLabel(row.message.created_at)}>{relativeShort(row.message.created_at)}</time>
                  </span>
                </div>
                <Button variant="secondary" icon="chevronRight" onClick={() => openMessage(orgId, row.message, deeper)}
                  aria-label={`Open ${row.attachment.file_name} in ${where}`}>
                  Open
                </Button>
              </li>
            );
          })}
        </ul>
      </ListBody>
    </div>
  );
}
