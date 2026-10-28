// A message shown out of its conversation: views (Unread, Mentions, Threads,
// Saved), search results and the pins panel. Read only, with a clear way to jump
// to the message in place.
import { useEffect, type ReactNode } from 'react';
import type { Channel, Message } from '../../api/types';
import { actions, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Avatar, Button } from '../../ui/kit';
import { Markdown } from '../../ui/markdown';
import { MessageAttachments } from '../media';
import { useMdContext } from './md';
import { channelIcon, channelLabel, channelTitle, personName } from './names';
import { fullTimeLabel, relativeShort } from './time';

interface Props {
  message: Message;
  channel: Channel | null;
  orgId: string;
  highlight?: string[];
  onJump?: () => void;
  jumpLabel?: string;
  extra?: ReactNode;       // trailing actions (unsave, unpin)
  unread?: boolean;
  showChannel?: boolean;
}

export function MessageCard({ message: m, channel, orgId, highlight, onJump, jumpLabel = 'Open', extra, unread, showChannel = true }: Props) {
  const profiles = useDek((s) => s.profiles);
  const ctx = useMdContext(orgId, highlight);
  const author = m.author_id ? profiles[m.author_id] : undefined;
  const name = m.kind === 'system' ? 'Dek' : personName(profiles, m.author_id);

  useEffect(() => {
    const missing = [m.author_id, ...m.mentions].filter((id): id is string => !!id && !profiles[id]);
    if (missing.length) {
      try { actions.ensureProfiles(missing); } catch { /* profiles arrive later; names show as Someone meanwhile */ }
    }
  }, [m.author_id, m.mentions, profiles]);

  const actionsEl = onJump || extra ? (
    <div className="dk-card__actions">
      {extra}
      {onJump ? <Button size="md" variant="secondary" icon="chevronRight" onClick={onJump}>{jumpLabel}</Button> : null}
    </div>
  ) : null;
  const where = showChannel && channel;

  return (
    <article className={`dk-card${unread ? ' is-unread' : ''}`} aria-label={`${name} in ${channelLabel(channel ?? undefined, profiles)}`}>
      {where ? (
        <div className="dk-card__top">
          <div className="dk-card__where">
            <Icon name={channelIcon(channel)} size={14} />
            <span className="dk-card__chan">{channelTitle(channel, profiles)}</span>
            {m.thread_root_id ? <span className="dk-card__thread">in a thread</span> : null}
          </div>
          {actionsEl}
        </div>
      ) : null}
      <div className="dk-card__row">
        <Avatar name={name} path={author?.avatar_path} seed={m.author_id ?? 'dek'} size={32} />
        <div className="dk-card__main">
          <div className="dk-card__head">
            <span className="dk-card__author">{name}</span>
            <time className="dk-card__time" dateTime={m.created_at} title={fullTimeLabel(m.created_at)}>{relativeShort(m.created_at)}</time>
            {unread ? <span className="dk-card__new">New</span> : null}
            {!where ? actionsEl : null}
          </div>
          {m.deleted_at ? (
            <p className="dk-card__deleted">This message was deleted.</p>
          ) : (
            <div className="dk-card__body"><Markdown body={m.body} ctx={ctx} /></div>
          )}
          {m.attachments.length && !m.deleted_at ? <MessageAttachments message={m} attachments={m.attachments} /> : null}
        </div>
      </div>
    </article>
  );
}
