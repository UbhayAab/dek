// Desktop and tablet sidebar: the organization header in its brand color (DEK01),
// the notification prompt, the views, servers and channels, DMs, and the person.
import { useMemo, type MouseEvent } from 'react';
import { channelRoute, href, navigate, type OrgView, type Route } from '../../app/router';
import { actions, useDek } from '../../store';
import { Icon, type IconName } from '../../ui/icons';
import { Avatar, Button, Menu, type MenuItem } from '../../ui/kit';
import { NotificationPrompt } from '../notifications';
import { ChannelTree } from './ChannelTree';
import { CountBadge } from './ConversationLink';
import { orgCounts } from './model';
import { useMeId, useOrgSummary } from './hooks';
import { openDmPicker } from './ui-store';
import { orgInitials } from './branding';

export function OrgSwitcherMenu({ orgId, variant }: { orgId: string; variant: 'sidebar' | 'home' }) {
  const orgs = useDek((s) => s.orgs);
  const org = useOrgSummary(orgId);
  const items: MenuItem[] = [];
  for (const o of orgs) {
    if (o.id === orgId) continue;
    items.push({ label: `Switch to ${o.name}`, icon: 'globe', onSelect: () => navigate({ name: 'org', orgId: o.id }) });
  }
  if (org && (org.my_role === 'owner' || org.my_role === 'admin')) {
    items.push({ label: 'Organization admin', icon: 'shield', onSelect: () => navigate({ name: 'admin', orgId, section: 'overview' }) });
  }
  items.push({ label: 'Browse channels', icon: 'search', onSelect: () => navigate({ name: 'browse', orgId, serverId: null }) });
  items.push({ label: 'Settings', icon: 'settings', onSelect: () => navigate({ name: 'settings', section: 'profile' }) });
  items.push({ label: 'Sign out', icon: 'logout', danger: true, onSelect: () => { void Promise.resolve().then(() => actions.signOut()).catch(() => undefined); } });
  const name = org?.name ?? 'Organization';
  return (
    <Menu
      label={`${name}: switch organization and options`}
      items={items}
      align="start"
      trigger={(p) => (
        <button type="button" className={`dk-orgbtn dk-orgbtn--${variant}`} {...p}>
          <span className="dk-orgbtn__mark" aria-hidden="true">{orgInitials(name, org?.short_name)}</span>
          <span className="dk-orgbtn__text">
            <span className="dk-orgbtn__name">{name}</span>
            {orgs.length > 1 ? <span className="dk-orgbtn__hint">Switch organization</span> : null}
          </span>
          <Icon name="chevronDown" size={16} />
        </button>
      )}
    />
  );
}

function QuickLink({ icon, label, to, active, count, tone }: { icon: IconName; label: string; to: Route; active: boolean; count?: number; tone?: 'danger' | 'neutral' }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={href(to)} onClick={onClick} className={`dk-quick__link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} size={18} />
      <span className="dk-quick__label">{label}</span>
      {count ? <CountBadge count={count} label={label.toLowerCase()} tone={tone} /> : null}
    </a>
  );
}

export function MeButton({ compact }: { compact?: boolean }) {
  const profile = useDek((s) => s.me?.profile ?? null);
  const meId = useMeId();
  const name = profile?.display_name ?? 'You';
  const status = profile?.status_text ? `${profile.status_emoji ?? ''} ${profile.status_text}`.trim() : null;
  return (
    <a
      href={href({ name: 'settings', section: 'profile' })}
      className={`dk-me${compact ? ' dk-me--compact' : ''}`}
      onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate({ name: 'settings', section: 'profile' }); } }}
      aria-label={`${name}: your profile and settings`}
    >
      <Avatar name={name} path={profile?.avatar_path} seed={meId ?? name} size={compact ? 28 : 32} active />
      {!compact ? (
        <span className="dk-me__text">
          <span className="dk-me__name">{name}</span>
          <span className="dk-me__status">{status ?? 'Profile and settings'}</span>
        </span>
      ) : null}
      {!compact ? <Icon name="settings" size={18} /> : null}
    </a>
  );
}

interface SidebarProps {
  orgId: string;
  route: Route;
  activeChannelId: string | null;
}

export function Sidebar({ orgId, route, activeChannelId }: SidebarProps) {
  const channels = useDek((s) => s.channels);
  const counts = useMemo(() => orgCounts(orgId, channels), [orgId, channels]);
  const view: OrgView | 'search' | null = route.name === 'view' ? route.view : route.name === 'search' ? 'search' : null;
  const open = (channelId: string) => navigate(channelRoute(orgId, channelId));

  return (
    <aside className="dk-sidebar" aria-label="Conversations">
      <header className="dk-orghead">
        <OrgSwitcherMenu orgId={orgId} variant="sidebar" />
        <button type="button" className="dk-orghead__new" onClick={openDmPicker} aria-label="New message" title="New message">
          <Icon name="edit" size={18} />
        </button>
      </header>
      <div className="dk-sidebar__scroll scroll-y">
        <div className="dk-sidebar__prompt"><NotificationPrompt /></div>
        <nav className="dk-quick" aria-label="Views">
          <QuickLink icon="inbox" label="Unread" to={{ name: 'view', orgId, view: 'unread' }} active={view === 'unread'} count={counts.unreadChannels} tone="neutral" />
          <QuickLink icon="at" label="Mentions" to={{ name: 'view', orgId, view: 'mentions' }} active={view === 'mentions'} count={counts.mentions} />
          <QuickLink icon="thread" label="Threads" to={{ name: 'view', orgId, view: 'threads' }} active={view === 'threads'} />
          <QuickLink icon="bookmark" label="Saved" to={{ name: 'view', orgId, view: 'saved' }} active={view === 'saved'} />
          <QuickLink icon="search" label="Search" to={{ name: 'search', orgId, q: '' }} active={view === 'search'} />
        </nav>
        <ChannelTree orgId={orgId} activeChannelId={activeChannelId} onOpen={open} variant="sidebar" />
        <div className="dk-sidebar__actions">
          <Button variant="ghost" icon="plus" block onClick={() => navigate({ name: 'browse', orgId, serverId: null })}>Browse channels</Button>
        </div>
      </div>
      <footer className="dk-sidebar__foot">
        <MeButton />
      </footer>
    </aside>
  );
}
