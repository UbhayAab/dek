// Servers with their channels (grouped by category) and the DM list. Used by the
// desktop sidebar and the phone Home tab, so both show the same structure.
import { useMemo, useState, type ReactNode } from 'react';
import type { Channel, Profile, Server } from '../../api/types';
import { href, navigate } from '../../app/router';
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Button, Menu, type MenuItem } from '../../ui/kit';
import { ConversationLink, CountBadge } from './ConversationLink';
import { dmChannels, serverSections, type ServerSection } from './model';
import { collapsedSections, openDmPicker, setCollapsed } from './ui-store';
import { useMeId, useOrgRole } from './hooks';
import { canManageChannel } from '../conversation/permissions';
import type { OrgRole } from '../../api/types';

interface Props {
  orgId: string;
  activeChannelId: string | null;
  onOpen: (channelId: string) => void;
  variant: 'sidebar' | 'home';
  dmLimit?: number;
  onAllDms?: () => void;
}

export function ChannelTree({ orgId, activeChannelId, onOpen, variant, dmLimit, onAllDms }: Props) {
  const servers = useDek((s) => s.servers);
  const channels = useDek((s) => s.channels);
  const profiles = useDek((s) => s.profiles);
  const meId = useMeId();
  const orgRole = useOrgRole(orgId);
  const [collapsed, setCollapsedState] = useState<Record<string, boolean>>(() => collapsedSections(meId));
  const sections = useMemo(() => serverSections(orgId, servers, channels), [orgId, servers, channels]);
  const dms = useMemo(() => dmChannels(orgId, channels), [orgId, channels]);
  const size = variant === 'home' ? 'roomy' : 'compact';

  const toggle = (id: string) => {
    const next = !collapsed[id];
    setCollapsedState((c) => ({ ...c, [id]: next }));
    setCollapsed(meId, id, next);
  };

  const shownDms = dmLimit ? dms.slice(0, dmLimit) : dms;

  return (
    <div className={`dk-tree dk-tree--${variant}`}>
      {sections.map((sec) => (
        <ServerBlock key={sec.server.id} section={sec} orgId={orgId} orgAdmin={orgRole === 'owner' || orgRole === 'admin'}
          collapsed={!!collapsed[sec.server.id]} onToggle={() => toggle(sec.server.id)}>
          {sec.groups.map((g) => (
            <div key={g.category ?? '_'} className="dk-tree__group" role="group" aria-label={g.category ?? undefined}>
              {g.category ? <div className="dk-tree__cat" aria-hidden="true">{g.category}</div> : null}
              <ul className="dk-tree__list">
                {g.channels.map((c) => (
                  <ChannelRow key={c.id} channel={c} server={sec.server} orgRole={orgRole} meId={meId} profiles={profiles}
                    active={c.id === activeChannelId} onOpen={onOpen} size={size} />
                ))}
              </ul>
            </div>
          ))}
        </ServerBlock>
      ))}

      <section className="dk-tree__section" aria-labelledby={`dms-${variant}`}>
        <div className="dk-tree__head">
          <button type="button" className="dk-tree__toggle" aria-expanded={!collapsed.dms} onClick={() => toggle('dms')}>
            <Icon name={collapsed.dms ? 'chevronRight' : 'chevronDown'} size={14} />
            <span id={`dms-${variant}`} className="dk-tree__title">Direct messages</span>
          </button>
          <button type="button" className="dk-tree__add" aria-label="New message" title="New message" onClick={openDmPicker}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        {!collapsed.dms ? (
          shownDms.length ? (
            <ul className="dk-tree__list">
              {shownDms.map((c) => (
                <li key={c.id}>
                  <ConversationLink channel={c} profiles={profiles} active={c.id === activeChannelId} onOpen={onOpen} size={size} />
                </li>
              ))}
              {dmLimit && dms.length > dmLimit && onAllDms ? (
                <li><button type="button" className="dk-tree__more" onClick={onAllDms}>All direct messages</button></li>
              ) : null}
            </ul>
          ) : (
            <div className="dk-tree__empty">
              <span>No direct messages yet.</span>
              <Button variant="ghost" icon="plus" onClick={openDmPicker}>Start a conversation</Button>
            </div>
          )
        ) : null}
      </section>
    </div>
  );
}

function ServerBlock({ section, orgId, orgAdmin, collapsed, onToggle, children }: {
  section: ServerSection; orgId: string; orgAdmin: boolean; collapsed: boolean; onToggle: () => void; children: ReactNode;
}) {
  const { server, partial } = section;
  const headId = `srv-${server.id}`;
  const items: MenuItem[] = [];
  items.push({ label: 'Browse servers', icon: 'search', onSelect: () => navigate({ name: 'browse', orgId, serverId: null }) });
  if (!partial) items.push({ label: 'Browse channels', icon: 'search', onSelect: () => navigate({ name: 'browse', orgId, serverId: server.id }) });
  if (server.my_role === 'admin' || orgAdmin) {
    items.push({ label: 'Server settings', icon: 'settings', onSelect: () => navigate({ name: 'serverSettings', orgId, serverId: server.id }) });
  }
  return (
    <section className="dk-tree__section" id={headId} aria-labelledby={`${headId}-t`}>
      <div className="dk-tree__head">
        <button type="button" className="dk-tree__toggle" aria-expanded={!collapsed} onClick={onToggle}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
          {server.icon_emoji ? <span className="dk-tree__emoji" aria-hidden="true">{server.icon_emoji}</span> : null}
          <span id={`${headId}-t`} className="dk-tree__title">{server.name}</span>
          {server.archived ? <span className="dk-tree__tag">Archived</span> : null}
          {collapsed ? <CountBadge count={section.mentions} label="mentions" /> : null}
        </button>
        {items.length ? <Menu label={`${server.name} options`} items={items} /> : null}
      </div>
      {partial && !collapsed ? (
        <p className="dk-tree__note">Shared with you: only the channels you were added to.</p>
      ) : null}
      {!collapsed ? children : null}
    </section>
  );
}

// A channel row with its options: settings for everyone, archive or delete for the
// people who manage it (Fixboard #16: the delete was buried three screens deep).
function ChannelRow({ channel: c, server, orgRole, meId, profiles, active, onOpen, size }: {
  channel: Channel; server: Server; orgRole: OrgRole | null; meId: string | null; profiles: Record<string, Profile>;
  active: boolean; onOpen: (channelId: string) => void; size: 'compact' | 'roomy';
}) {
  const manage = canManageChannel(c, { meId, orgRole, server });
  const settings = href({ name: 'channelSettings', orgId: c.org_id, channelId: c.id });
  const items: MenuItem[] = [
    { label: manage ? 'Channel settings' : 'Channel details', icon: 'settings', onSelect: () => navigate(settings) },
    manage
      ? { label: 'Archive or delete', icon: 'trash', danger: true, onSelect: () => navigate(`${settings}#danger`) }
      : { label: 'Leave channel', icon: 'logout', danger: true, onSelect: () => navigate(`${settings}#danger`) },
  ];
  return (
    <li className={`dk-tree__row${manage ? ' can-manage' : ''}`}>
      <ConversationLink channel={c} profiles={profiles} active={active} onOpen={onOpen} size={size} />
      <span className="dk-tree__rowmenu"><Menu label={`${c.name ?? 'Channel'} options`} items={items} /></span>
    </li>
  );
}
