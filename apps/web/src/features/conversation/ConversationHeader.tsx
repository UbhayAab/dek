// The conversation header: name and topic, members, pins, call, notification
// level with mute durations, details, settings for people who can manage it,
// leave. On phones: a back button and the essentials, the rest in one menu.
import type { Channel } from '../../api/types';
import { navigate } from '../../app/router';
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { IconButton, Menu, type MenuItem } from '../../ui/kit';
import { CallButton } from '../calls';
import { openPane, type Pane } from '../shell/layout';
import { channelIcon, channelKindLabel, channelTitle, isDm, isMuted } from './names';
import { LEVELS, MUTES, muteUntil, setNotify } from './notify';
import { canManageChannel, type Who } from './permissions';
import { useLeaveChannel } from './panels';
import { isActive } from './time';

interface Props {
  channel: Channel;
  orgId: string;
  who: Who;
  phone: boolean;
  pane: Pane | null;
  onBack?: () => void;
}

export function ConversationHeader({ channel, orgId, who, phone, pane, onBack }: Props) {
  const profiles = useDek((s) => s.profiles);
  const title = channelTitle(channel, profiles);
  const dm = isDm(channel);
  const muted = isMuted(channel);
  const manage = canManageChannel(channel, who);
  const leave = useLeaveChannel(channel, orgId);
  const other = channel.kind === 'dm' ? channel.dm_user_ids?.[0] : undefined;
  const otherProfile = other ? profiles[other] : undefined;
  const subtitle = channel.kind === 'dm'
    ? (otherProfile?.status_text ? `${otherProfile.status_emoji ?? ''} ${otherProfile.status_text}`.trim() : isActive(otherProfile?.last_active_at) ? 'Active now' : otherProfile?.title ?? null)
    : channel.topic;

  const toggle = (p: Pane) => () => openPane(p);

  const notifyItems: MenuItem[] = [
    ...LEVELS.map<MenuItem>((l) => ({
      label: l.level === channel.notify ? `${l.label} (current)` : l.label,
      icon: l.level === channel.notify ? 'check' : l.level === 'none' ? 'bellOff' : 'bell',
      onSelect: () => void setNotify(channel, l.level, channel.muted_until, `Notifications: ${l.label.toLowerCase()}`),
    })),
    ...(muted && channel.muted_until
      ? [{ label: 'Unmute', icon: 'bell' as const, onSelect: () => void setNotify(channel, channel.notify === 'none' ? 'default' : channel.notify, null, 'Unmuted') }]
      : MUTES.map<MenuItem>((m) => ({
        label: m.label, icon: 'clock', onSelect: () => void setNotify(channel, channel.notify, muteUntil(m.minutes), m.label.replace('Mute for', 'Muted for')),
      }))),
  ];

  const moreItems: MenuItem[] = [];
  if (phone) {
    moreItems.push({ label: dm ? 'People' : `Members (${channel.member_count})`, icon: 'users', onSelect: toggle('members') });
    moreItems.push({ label: 'Pinned messages', icon: 'pin', onSelect: toggle('pins') });
  }
  moreItems.push({ label: 'Details and notifications', icon: 'info', onSelect: toggle('info') });
  if (manage) moreItems.push({ label: 'Channel settings', icon: 'settings', onSelect: () => navigate({ name: 'channelSettings', orgId, channelId: channel.id }) });
  if (!dm && channel.member) moreItems.push({ label: 'Leave channel', icon: 'logout', danger: true, onSelect: leave.ask });

  return (
    <header className={`dk-convhead${phone ? ' dk-convhead--phone' : ''}`}>
      {onBack ? <IconButton icon="chevronLeft" label="Back" onClick={onBack} className="dk-convhead__back" /> : null}
      <button type="button" className="dk-convhead__title" onClick={toggle('info')} aria-label={`${title}, ${channelKindLabel(channel)}. Show details`}>
        <span className="dk-convhead__icon"><Icon name={channelIcon(channel)} size={18} /></span>
        <span className="dk-convhead__texts">
          <span className="dk-convhead__name" dir="auto">{title}</span>
          {subtitle ? <span className="dk-convhead__topic" dir="auto">{subtitle}</span> : null}
        </span>
        {muted ? <Icon name="bellOff" size={14} className="dk-convhead__muted" /> : null}
        {channel.archived ? <span className="dk-convhead__tag">Archived</span> : null}
      </button>
      <div className="dk-convhead__actions">
        {!phone ? (
          <>
            <button type="button" className={`dk-convhead__members${pane === 'members' ? ' is-active' : ''}`} onClick={toggle('members')}
              aria-label={`${channel.member_count} members. Show members`} title="Members">
              <Icon name="users" size={18} />
              <span>{channel.member_count}</span>
            </button>
            <IconButton icon="pin" label="Pinned messages" onClick={toggle('pins')} active={pane === 'pins'} />
          </>
        ) : null}
        <CallButton channelId={channel.id} />
        {!phone && channel.member ? <Menu label={muted ? 'Notifications: muted' : 'Notifications'} icon={muted ? 'bellOff' : 'bell'} items={notifyItems} /> : null}
        <Menu label="Conversation options" items={moreItems} />
      </div>
      {leave.dialog}
    </header>
  );
}
