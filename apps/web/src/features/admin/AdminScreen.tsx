// Organization admin (DEK05, DEK13): overview, members, invites, join requests,
// reports, audit log and team servers. Org owners and admins only; everyone else
// gets a friendly explanation instead of a broken page. The server checks every
// call again (a member calling these functions gets forbidden).
import type { ReactNode } from 'react';
import { api } from '../../api/rpc';
import type { OrgRole, OrgSettings } from '../../api/types';
import type { AdminSection } from '../../app/router';
import { Icon } from '../../ui/icons';
import { Button } from '../../ui/kit';
import { isOrgAdmin, useMyId, useOrg } from './common/context';
import { XIcon } from './common/icons';
import { useLoad } from './common/load';
import { go, goBack, toHref } from './common/nav';
import { Denied, ErrorView, Loading, NavList, Screen, Single, Split, type NavItem, useNarrowRef } from './common/ui';
import { AuditSection } from './sections/Audit';
import { InvitesSection } from './sections/Invites';
import { MembersSection } from './sections/Members';
import { OverviewSection } from './sections/Overview';
import { ReportsSection } from './sections/Reports';
import { RequestsSection } from './sections/Requests';
import { ServersSection } from './sections/Servers';
import './admin.css';

export interface AdminCtx {
  orgId: string;
  orgName: string;
  role: OrgRole;
  settings: OrgSettings;
  myId: string;
  pendingCount: number;
  openReports: number;
  refreshCounts: () => void;
}

export const ADMIN_SECTIONS: readonly { key: AdminSection; label: string; icon: ReactNode; description: string }[] = [
  { key: 'overview', label: 'Overview', icon: <Icon name="home" />, description: 'Members, requests and reports at a glance' },
  { key: 'members', label: 'Members', icon: <Icon name="users" />, description: 'Roles, suspensions and removals' },
  { key: 'invites', label: 'Invites', icon: <XIcon name="link" />, description: 'Invite links and who used them' },
  { key: 'requests', label: 'Join requests', icon: <Icon name="userPlus" />, description: 'People waiting for approval' },
  { key: 'reports', label: 'Reports', icon: <Icon name="flag" />, description: 'Reported messages and people' },
  { key: 'audit', label: 'Audit log', icon: <XIcon name="list" />, description: 'Who changed what, and when' },
  { key: 'servers', label: 'Team servers', icon: <XIcon name="layers" />, description: 'Create, archive and configure' },
];

export function sectionLabel(s: AdminSection): string {
  return ADMIN_SECTIONS.find((x) => x.key === s)?.label ?? 'Admin';
}

export function adminNavItems(orgId: string, counts: { pending: number; reports: number }, includeOverview: boolean): NavItem[] {
  return ADMIN_SECTIONS.filter((s) => includeOverview || s.key !== 'overview').map((s) => ({
    key: s.key,
    label: s.label,
    icon: s.icon,
    description: s.description,
    href: toHref({ name: 'admin', orgId, section: s.key }),
    onSelect: () => go({ name: 'admin', orgId, section: s.key }, 'auto'),
    badge: s.key === 'requests' ? counts.pending : s.key === 'reports' ? counts.reports : undefined,
  }));
}

export function AdminScreen({ orgId, section }: { orgId: string; section: AdminSection }) {
  const org = useOrg(orgId);
  const myId = useMyId();
  const [rootRef, phone] = useNarrowRef();
  const admin = isOrgAdmin(org.role);
  const pending = useLoad(() => api.listJoinRequests(orgId, 'pending'), [orgId], { key: `jr:${orgId}:pending`, enabled: admin });
  const reports = useLoad(() => api.listReports(orgId, 'open', 50, 0), [orgId], { key: `rep:${orgId}:open:0`, enabled: admin });

  const toOrg = () => goBack({ name: 'org', orgId });
  const inSection = section !== 'overview';
  const title = phone && inSection ? sectionLabel(section) : 'Admin';
  const onBack = phone && inSection ? () => goBack({ name: 'admin', orgId, section: 'overview' }) : toOrg;
  const backLabel = phone && inSection ? 'Back to admin' : 'Back to Dek';
  const orgName = org.summary?.name ?? '';

  if (org.status !== 'ready' || !org.summary || !myId) {
    return (
      <Screen rootRef={rootRef} narrow={phone} title="Admin" backLabel="Back to Dek" onBack={toOrg}>
        <Single>
          {org.status === 'error' && org.error
            ? <ErrorView error={org.error} onRetry={org.retry} what="organization" action={<Button onClick={() => go({ name: 'home' }, 'replace')}>Go to Dek</Button>} />
            : <Loading label="Loading admin" />}
        </Single>
      </Screen>
    );
  }

  if (!admin || !org.role) {
    return (
      <Screen rootRef={rootRef} narrow={phone} title="Admin" subtitle={orgName} brand={org.summary.brand_color} backLabel="Back to Dek" onBack={toOrg}>
        <Single>
          <Denied
            title="Admin is for organization admins"
            body={`You are ${org.role === 'guest' ? 'a guest' : 'a member'} of ${orgName}. Owners and admins manage members, invites and reports. If something needs their attention, report it from the message menu or ask an admin.`}
            action={<Button variant="primary" onClick={toOrg}>Back to {orgName}</Button>}
          />
        </Single>
      </Screen>
    );
  }

  const ctx: AdminCtx = {
    orgId,
    orgName,
    role: org.role,
    settings: org.settings,
    myId,
    pendingCount: pending.data?.items.length ?? 0,
    openReports: reports.data?.total ?? reports.data?.items.length ?? 0,
    refreshCounts: () => { pending.reload(); reports.reload(); },
  };
  const counts = { pending: ctx.pendingCount, reports: ctx.openReports };

  let body: ReactNode;
  switch (section) {
    case 'members': body = <MembersSection ctx={ctx} />; break;
    case 'invites': body = <InvitesSection ctx={ctx} />; break;
    case 'requests': body = <RequestsSection ctx={ctx} />; break;
    case 'reports': body = <ReportsSection ctx={ctx} />; break;
    case 'audit': body = <AuditSection ctx={ctx} />; break;
    case 'servers': body = <ServersSection ctx={ctx} />; break;
    default: body = <OverviewSection ctx={ctx} navItems={adminNavItems(orgId, counts, false)} />;
  }

  return (
    <Screen rootRef={rootRef} narrow={phone} title={title} subtitle={orgName} brand={org.summary.brand_color} backLabel={backLabel} onBack={onBack} className="adm">
      <Split navLabel="Admin sections" mode="content" nav={<NavList items={adminNavItems(orgId, counts, true)} current={section} />}>
        {body}
      </Split>
    </Screen>
  );
}
