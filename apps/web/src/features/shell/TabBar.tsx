// Phone bottom tabs (DEK04): Home, DMs, Activity, Search, You. Root layers only;
// a conversation opens full screen without them.
import { useMemo, type MouseEvent } from 'react';
import { href, navigate, type Route } from '../../app/router';
import { useDek } from '../../store';
import { Icon, type IconName } from '../../ui/icons';
import { CountBadge } from './ConversationLink';
import { orgCounts } from './model';

export type Tab = 'home' | 'dms' | 'activity' | 'search' | 'you';

export function tabOf(route: Route): Tab | null {
  switch (route.name) {
    case 'org': return 'home';
    case 'view':
      if (route.view === 'dms') return 'dms';
      return 'activity';
    case 'search': return 'search';
    case 'settings': return 'you';
    case 'browse':
    case 'serverSettings':
    case 'admin':
    case 'channelSettings':
      return 'home';
    default: return null;
  }
}

export function TabBar({ orgId, route }: { orgId: string; route: Route }) {
  const channels = useDek((s) => s.channels);
  const counts = useMemo(() => orgCounts(orgId, channels), [orgId, channels]);
  const active = tabOf(route);
  const tabs: { id: Tab; label: string; icon: IconName; to: Route; count: number; countLabel: string }[] = [
    { id: 'home', label: 'Home', icon: 'home', to: { name: 'org', orgId }, count: 0, countLabel: '' },
    { id: 'dms', label: 'DMs', icon: 'message', to: { name: 'view', orgId, view: 'dms' }, count: counts.dmUnread, countLabel: 'unread direct messages' },
    { id: 'activity', label: 'Activity', icon: 'bell', to: { name: 'view', orgId, view: 'activity' }, count: counts.mentions, countLabel: 'mentions' },
    { id: 'search', label: 'Search', icon: 'search', to: { name: 'search', orgId, q: '' }, count: 0, countLabel: '' },
    { id: 'you', label: 'You', icon: 'user', to: { name: 'settings', section: 'profile' }, count: 0, countLabel: '' },
  ];
  return (
    <nav className="dk-tabbar" aria-label="Main">
      {tabs.map((t) => {
        const on = t.id === active;
        const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          if (!on || route.name !== t.to.name) navigate(t.to);
        };
        return (
          <a key={t.id} href={href(t.to)} onClick={onClick} className={`dk-tab${on ? ' is-active' : ''}`} aria-current={on ? 'page' : undefined}>
            <span className="dk-tab__icon">
              <Icon name={t.icon} size={22} />
              {t.id === 'home' && counts.unreadChannels ? <span className="dk-tab__dot" aria-hidden="true" /> : null}
              <CountBadge count={t.count} label={t.countLabel} />
            </span>
            <span className="dk-tab__label">{t.label}</span>
            {t.id === 'home' && counts.unreadChannels ? <span className="sr-only">{`, ${counts.unreadChannels} channels with unread messages`}</span> : null}
          </a>
        );
      })}
    </nav>
  );
}
