// The organization and server rail (desktop and tablet). Organizations switch
// context deliberately (DEK01); server tiles jump to that server in the sidebar.
import { useMemo } from 'react';
import { navigate } from '../../app/router';
import { useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { brandVars, orgInitials } from './branding';
import { CountBadge } from './ConversationLink';
import { orgCounts } from './model';
import { MeButton } from './Sidebar';

function jumpToServer(serverId: string): void {
  const el = document.getElementById(`srv-${serverId}`);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.querySelector<HTMLButtonElement>('.dk-tree__toggle')?.focus({ preventScroll: true });
}

export function Rail({ orgId }: { orgId: string }) {
  const orgs = useDek((s) => s.orgs);
  const servers = useDek((s) => s.servers);
  const channels = useDek((s) => s.channels);
  const current = useMemo(() => orgCounts(orgId, channels), [orgId, channels]);
  const myServers = useMemo(
    () => Object.values(servers).filter((s) => s.org_id === orgId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [servers, orgId],
  );

  return (
    <nav className="dk-rail" aria-label="Organizations and servers">
      <ul className="dk-rail__list" aria-label="Organizations">
        {orgs.map((o) => {
          const active = o.id === orgId;
          const mentions = active ? current.mentions + current.dmUnread : o.mention_count;
          return (
            <li key={o.id} className="dk-rail__item">
              <button
                type="button"
                className={`dk-railtile dk-railtile--org${active ? ' is-active' : ''}`}
                style={brandVars(o.brand_color)}
                aria-current={active ? 'true' : undefined}
                aria-label={`${o.name}${active ? ' (current organization)' : ''}`}
                title={o.name}
                onClick={() => { if (!active) navigate({ name: 'org', orgId: o.id }); }}
              >
                <span className="dk-railtile__mark">{orgInitials(o.name, o.short_name)}</span>
                <CountBadge count={mentions} label="mentions and direct messages" />
              </button>
            </li>
          );
        })}
      </ul>
      {myServers.length ? <hr className="dk-rail__sep" /> : null}
      <ul className="dk-rail__list dk-rail__list--servers" aria-label="Servers">
        {myServers.map((s) => (
          <li key={s.id} className="dk-rail__item">
            <button type="button" className="dk-railtile dk-railtile--server" title={s.name} aria-label={`Jump to ${s.name}`} onClick={() => jumpToServer(s.id)}>
              <span className="dk-railtile__mark" aria-hidden="true">{s.icon_emoji || orgInitials(s.name)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="dk-rail__foot">
        <button type="button" className="dk-railtile dk-railtile--ghost" title="Browse channels" aria-label="Browse channels"
          onClick={() => navigate({ name: 'browse', orgId, serverId: null })}>
          <Icon name="plus" size={20} />
        </button>
        <MeButton compact />
      </div>
    </nav>
  );
}
