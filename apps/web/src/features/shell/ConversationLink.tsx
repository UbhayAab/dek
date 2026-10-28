// One conversation in a list (sidebar, phone Home, DMs): kind icon or avatar,
// name, unread weight, mention badge, muted styling. A real link, so it opens in
// a new tab with a middle click and reads as a link to screen readers.
import type { MouseEvent } from 'react';
import type { Channel, Profile } from '../../api/types';
import { channelRoute, href } from '../../app/router';
import { Icon } from '../../ui/icons';
import { Avatar } from '../../ui/kit';
import { channelIcon, channelTitle, isMuted } from '../conversation/names';
import { isActive } from '../conversation/time';
import { badgeCount } from './model';

export function CountBadge({ count, label, tone = 'danger' }: { count: number; label: string; tone?: 'danger' | 'neutral' }) {
  if (!count) return null;
  return (
    <span className={`dk-count dk-count--${tone}`}>
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{`${count} ${label}`}</span>
    </span>
  );
}

// A channel where you were tagged (by name, or by @channel or @here: the server counts
// both) shows "@", with the number when there is more than one (Fixboard #19).
export function MentionBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="dk-count dk-count--danger dk-count--at">
      <span aria-hidden="true">{`@${count > 1 ? (count > 99 ? '99+' : count) : ''}`}</span>
      <span className="sr-only">{`${count} ${count === 1 ? 'mention' : 'mentions'}`}</span>
    </span>
  );
}

interface Props {
  channel: Channel;
  profiles: Record<string, Profile>;
  active: boolean;
  onOpen: (channelId: string) => void;
  size?: 'compact' | 'roomy';
}

export function ConversationLink({ channel: c, profiles, active, onOpen, size = 'compact' }: Props) {
  const muted = isMuted(c);
  const unread = c.unread > 0 && (!muted || c.kind === 'dm' || c.kind === 'group_dm');
  const count = badgeCount(c);
  const title = channelTitle(c, profiles);
  const dm = c.kind === 'dm' || c.kind === 'group_dm';
  const other = dm ? c.dm_user_ids?.[0] : undefined;
  const otherProfile = other ? profiles[other] : undefined;
  const to = href(channelRoute(c.org_id, c.id));

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(c.id);
  };

  return (
    <a
      href={to}
      onClick={onClick}
      className={['dk-conv', `dk-conv--${size}`, unread && 'is-unread', muted && 'is-muted', active && 'is-active'].filter(Boolean).join(' ')}
      aria-current={active ? 'page' : undefined}
    >
      {dm ? (
        <span className="dk-conv__avatar">
          <Avatar name={otherProfile?.display_name ?? title} path={otherProfile?.avatar_path} seed={other ?? c.id}
            size={size === 'roomy' ? 32 : 22} active={c.kind === 'dm' && isActive(otherProfile?.last_active_at)} />
          {c.kind === 'group_dm' && (c.dm_user_ids?.length ?? 0) > 1 ? (
            <span className="dk-conv__more" aria-hidden="true">{`+${(c.dm_user_ids?.length ?? 1) - 1}`}</span>
          ) : null}
        </span>
      ) : (
        <span className="dk-conv__icon"><Icon name={channelIcon(c)} size={16} /></span>
      )}
      <span className="dk-conv__name">{title}</span>
      {c.kind === 'dm' && isActive(otherProfile?.last_active_at) ? <span className="sr-only">, active now</span> : null}
      {muted ? <span className="dk-conv__mute" title="Muted"><Icon name="bellOff" size={14} /><span className="sr-only">, muted</span></span> : null}
      {unread && !count ? <span className="sr-only">, unread messages</span> : null}
      {dm ? <CountBadge count={count} label="unread" /> : <MentionBadge count={count} />}
    </a>
  );
}
