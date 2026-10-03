// Admin overview: how many members, who is waiting, what was reported. On phones it
// is also the menu of admin sections (one layer at a time).
import { api } from '../../../api/rpc';
import { Spinner } from '../../../ui/kit';
import type { AdminCtx } from '../AdminScreen';
import { useServers } from '../common/context';
import { plural } from '../common/format';
import { useLoad } from '../common/load';
import { linkProps } from '../common/nav';
import { cx, NavList, Section, useNarrow, type NavItem } from '../common/ui';
import { Button } from '../../../ui/kit';
import { go } from '../common/nav';

interface Tile {
  key: string;
  label: string;
  value: number | null | undefined;
  failed: boolean;
  hint: string;
  attention?: boolean;
  section: 'members' | 'requests' | 'reports' | 'servers';
}

export function OverviewSection({ ctx, navItems }: { ctx: AdminCtx; navItems: NavItem[] }) {
  const phone = useNarrow();
  const members = useLoad(() => api.listOrgMembers(ctx.orgId, null, null, 1, 0), [ctx.orgId], { key: `members:${ctx.orgId}:count` });
  const servers = useServers(ctx.orgId);
  const liveServers = servers.data?.filter((s) => !s.archived).length;
  const archived = servers.data ? servers.data.length - (liveServers ?? 0) : 0;

  const tiles: Tile[] = [
    {
      key: 'members', label: 'Members', value: members.data?.total, failed: members.status === 'error',
      hint: 'Everyone in the organization, guests included', section: 'members',
    },
    {
      key: 'requests', label: 'Join requests', value: ctx.pendingCount, failed: false,
      hint: ctx.pendingCount ? 'Waiting for your decision' : 'Nobody is waiting', attention: ctx.pendingCount > 0, section: 'requests',
    },
    {
      key: 'reports', label: 'Open reports', value: ctx.openReports, failed: false,
      hint: ctx.openReports ? 'Reported content to review' : 'Nothing to review', attention: ctx.openReports > 0, section: 'reports',
    },
    {
      key: 'servers', label: 'Team servers', value: liveServers, failed: servers.status === 'error',
      hint: archived ? `${plural(archived, 'archived server', 'archived servers')} not counted` : 'Active team servers', section: 'servers',
    },
  ];

  return (
    <>
      <Section title="Overview" description={`What needs attention in ${ctx.orgName}.`}>
        <div className="ap-stats">
          {tiles.map((t) => (
            <a key={t.key} className={cx('ap-stat', t.attention && 'is-attention')} {...linkProps({ name: 'admin', orgId: ctx.orgId, section: t.section }, 'auto')}>
              <span className="ap-stat__value">
                {t.failed ? '?' : t.value === null || t.value === undefined ? <Spinner size={18} label={`Loading ${t.label.toLowerCase()}`} /> : t.value}
              </span>
              <span className="ap-stat__label">{t.label}</span>
              <span className="ap-stat__hint">{t.failed ? 'Could not load. Open to try again.' : t.hint}</span>
            </a>
          ))}
        </div>
      </Section>

      <Section title="Quick actions">
        <div className="ap-form__actions ap-form__actions--start">
          <Button variant="primary" icon="userPlus" onClick={() => go(`/o/${ctx.orgId}/admin/invites#new`, 'auto')}>Invite people</Button>
          <Button icon="plus" onClick={() => go(`/o/${ctx.orgId}/admin/servers#new`, 'auto')}>Create a team server</Button>
        </div>
      </Section>

      {phone ? (
        <Section title="Manage">
          <NavList items={navItems} current={null} label="Admin sections" />
        </Section>
      ) : null}
    </>
  );
}
