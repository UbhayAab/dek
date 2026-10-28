// Organization members (DEK05): search, filter by role, change roles under the
// last-owner rule, suspend and restore with a reason, remove with an optional ban.
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { MemberItem, OrgRole } from '../../../api/types';
import { Avatar, Button, ConfirmDialog, EmptyState, Menu, Modal, Select, TextArea, TextField, toast, type MenuItem } from '../../../ui/kit';
import type { AdminCtx } from '../AdminScreen';
import { refreshMeEverywhere, refreshShell } from '../common/context';
import { formatDate, isRole, ORG_ROLE_LABEL, plural } from '../common/format';
import { offsetPage, useAction, useLoad, usePaged } from '../common/load';
import { Checkbox, Dot, FormError, List, PagedView, Pill, Row, Section, useDebounced } from '../common/ui';
import { validateReason } from '../common/validation';
import { orgMemberActions } from '../rules';

type Dialog =
  | { kind: 'role'; member: MemberItem; role: OrgRole }
  | { kind: 'suspend'; member: MemberItem }
  | { kind: 'unsuspend'; member: MemberItem }
  | { kind: 'remove'; member: MemberItem };

const ROLE_FILTER = [
  { value: '', label: 'All roles' },
  { value: 'owner', label: 'Owners' },
  { value: 'admin', label: 'Admins' },
  { value: 'member', label: 'Members' },
  { value: 'guest', label: 'Guests' },
];

const article = (r: OrgRole) => (r === 'owner' || r === 'admin' ? 'an' : 'a');

function asMember(v: unknown): MemberItem | null {
  return v && typeof v === 'object' && 'profile' in v ? (v as MemberItem) : null;
}

export function MembersSection({ ctx }: { ctx: AdminCtx }) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const [role, setRole] = useState('');
  const paged = usePaged<MemberItem, number>(
    async (cursor) => offsetPage(await api.listOrgMembers(ctx.orgId, q || null, role || null, 50, cursor ?? 0), cursor ?? 0),
    [ctx.orgId, q, role],
  );
  const owners = useLoad(() => api.listOrgMembers(ctx.orgId, null, 'owner', 100, 0), [ctx.orgId], { key: `members:${ctx.orgId}:owners` });
  const activeOwners = owners.data ? owners.data.items.filter((m) => (m.status ?? 'active') === 'active').length : 1;
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const replace = (item: MemberItem | null, id: string) => {
    if (item) paged.update((items) => items.map((m) => (m.profile.id === id ? item : m)));
    else paged.reload();
  };
  const changed = (id: string) => {
    owners.reload();
    if (id === ctx.myId) {
      refreshShell();
      void refreshMeEverywhere();
    }
  };
  const filtered = !!(q || role);

  return (
    <Section
      title="Members"
      description={`Everyone in ${ctx.orgName}. ${ctx.role === 'owner' ? 'As an owner you can change any role.' : 'Admins move people between member and guest; owners change admins and owners.'}`}
    >
      <div className="ap-toolbar">
        <div className="ap-toolbar__grow">
          <TextField label="Search" type="search" placeholder="Name or handle" value={query} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="ap-toolbar__side">
          <Select label="Role" options={ROLE_FILTER} value={role} onChange={(e) => setRole(e.target.value)} />
        </div>
      </div>
      <p className="ap-hint" aria-live="polite">
        {paged.total !== null ? `${plural(paged.total, 'person', 'people')}${filtered ? (paged.total === 1 ? ' matches' : ' match') : ''}` : ''}
      </p>
      <PagedView
        paged={paged}
        what="member list"
        empty={<EmptyState icon="users" title={filtered ? 'Nobody matches' : 'No members yet'} body={filtered ? 'Try another name or role.' : 'Invite people from the Invites section.'} />}
      >
        {(items) => (
          <List label="Members">
            {items.map((m) => (
              <MemberRow key={m.profile.id} m={m} ctx={ctx} activeOwners={activeOwners} onAction={setDialog} />
            ))}
          </List>
        )}
      </PagedView>

      {dialog?.kind === 'role' ? (
        <RoleDialog ctx={ctx} member={dialog.member} role={dialog.role} onClose={() => setDialog(null)}
          onDone={(v) => { replace(asMember(v), dialog.member.profile.id); changed(dialog.member.profile.id); }} />
      ) : null}
      {dialog?.kind === 'suspend' ? (
        <SuspendDialog ctx={ctx} member={dialog.member} onClose={() => setDialog(null)}
          onDone={(v) => { replace(asMember(v), dialog.member.profile.id); changed(dialog.member.profile.id); }} />
      ) : null}
      {dialog?.kind === 'unsuspend' ? (
        <UnsuspendDialog ctx={ctx} member={dialog.member} onClose={() => setDialog(null)}
          onDone={(v) => { replace(asMember(v), dialog.member.profile.id); changed(dialog.member.profile.id); }} />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <RemoveDialog ctx={ctx} member={dialog.member} onClose={() => setDialog(null)}
          onDone={() => { paged.update((items) => items.filter((m) => m.profile.id !== dialog.member.profile.id)); changed(dialog.member.profile.id); }} />
      ) : null}
    </Section>
  );
}

function MemberRow({ m, ctx, activeOwners, onAction }: { m: MemberItem; ctx: AdminCtx; activeOwners: number; onAction: (d: Dialog) => void }) {
  const role: OrgRole = isRole(m.role) ? m.role : 'member';
  const status = m.status ?? 'active';
  const self = m.profile.id === ctx.myId;
  const acts = orgMemberActions({ id: ctx.myId, role: ctx.role }, { id: m.profile.id, role, status }, activeOwners, ctx.settings.allow_guests);
  const items: MenuItem[] = [
    ...acts.roles.map((r): MenuItem => ({ label: `Make ${article(r)} ${ORG_ROLE_LABEL[r].toLowerCase()}`, icon: 'shield', onSelect: () => onAction({ kind: 'role', member: m, role: r }) })),
    ...(acts.canUnsuspend ? [{ label: 'Restore access', icon: 'refresh', onSelect: () => onAction({ kind: 'unsuspend', member: m }) } satisfies MenuItem] : []),
    ...(acts.canSuspend ? [{ label: 'Suspend', icon: 'clock', onSelect: () => onAction({ kind: 'suspend', member: m }) } satisfies MenuItem] : []),
    ...(acts.canRemove ? [{ label: 'Remove from organization', icon: 'trash', danger: true, onSelect: () => onAction({ kind: 'remove', member: m }) } satisfies MenuItem] : []),
  ];
  return (
    <Row
      testId={`member-${m.profile.id}`}
      muted={status === 'suspended'}
      leading={<Avatar name={m.profile.display_name} path={m.profile.avatar_path} seed={m.profile.id} size={36} />}
      title={(
        <>
          <span dir="auto">{m.profile.display_name}</span>
          {self ? <span className="ap-meta">(you)</span> : null}
          <Pill tone={role === 'owner' || role === 'admin' ? 'accent' : 'neutral'}>{ORG_ROLE_LABEL[role]}</Pill>
          {status === 'suspended' ? <Pill tone="danger">Suspended</Pill> : null}
        </>
      )}
      meta={(
        <>
          {m.profile.handle ? <span>@{m.profile.handle}</span> : null}
          {m.profile.handle && m.profile.title ? <Dot /> : null}
          {m.profile.title ? <span dir="auto">{m.profile.title}</span> : null}
          {m.profile.handle || m.profile.title ? <Dot /> : null}
          <span>Joined {formatDate(m.joined_at)}</span>
        </>
      )}
      trailing={items.length ? <Menu label={`Actions for ${m.profile.display_name}`} items={items} /> : null}
    >
      {self && acts.note ? <p className="ap-hint">{acts.note}</p> : null}
    </Row>
  );
}

const ROLE_TEXT: Record<OrgRole, (name: string, org: string) => string> = {
  owner: (n, o) => `${n} will be able to change every setting of ${o}, including who the admins and owners are.`,
  admin: (n, o) => `${n} will manage members, invites, team servers and reports in ${o}.`,
  member: (n, o) => `${n} becomes a regular member of ${o}. Admin rights, if any, end now.`,
  guest: (n, o) => `${n} will leave every team server in ${o} and the channels in them. Guests only see channels someone adds them to afterwards.`,
};

function RoleDialog({ ctx, member, role, onClose, onDone }: { ctx: AdminCtx; member: MemberItem; role: OrgRole; onClose: () => void; onDone: (v: unknown) => void }) {
  const act = useAction(() => api.setOrgRole(ctx.orgId, member.profile.id, role));
  const self = member.profile.id === ctx.myId;
  const name = self ? 'You' : member.profile.display_name;
  const label = ORG_ROLE_LABEL[role].toLowerCase();
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    onDone(r.value);
    toast({ kind: 'success', title: `${self ? 'You are' : `${member.profile.display_name} is`} now ${article(role)} ${label}` });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={self ? `Make yourself ${article(role)} ${label}?` : `Make ${member.profile.display_name} ${article(role)} ${label}?`}
      body={(
        <div className="ap-form">
          <p>{ROLE_TEXT[role](name, ctx.orgName)}</p>
          {self && member.role === 'owner' ? <p>You will no longer be an owner. Another owner can change it back.</p> : null}
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel={`Make ${label}`}
      danger={role === 'guest' || self}
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

function SuspendDialog({ ctx, member, onClose, onDone }: { ctx: AdminCtx; member: MemberItem; onClose: () => void; onDone: (v: unknown) => void }) {
  const [reason, setReason] = useState('');
  const reasonError = validateReason(reason);
  const act = useAction(() => api.suspendOrgMember(ctx.orgId, member.profile.id, true, reason.trim() || null));
  const name = member.profile.display_name;
  const submit = async () => {
    if (reasonError) return;
    const r = await act.run();
    if (!r.ok) return;
    onDone(r.value);
    toast({ kind: 'success', title: `${name} is suspended`, body: 'You can restore access from the member menu.' });
    onClose();
  };
  return (
    <Modal
      open
      size="sm"
      title={`Suspend ${name}?`}
      onClose={onClose}
      dismissable={!act.busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button>
          <Button variant="danger" onClick={submit} loading={act.busy} disabled={!!reasonError}>Suspend</Button>
        </>
      )}
    >
      <div className="ap-form">
        <p className="ap-card__text">
          {name} loses access to everything in {ctx.orgName} at once: channels, direct messages, calls and notifications.
          Their messages stay. You can restore access at any time.
        </p>
        <TextArea label="Reason (optional)" hint="Saved in the audit log." rows={3} value={reason} error={reasonError ?? null}
          onChange={(e) => setReason(e.target.value)} />
        <FormError error={act.error} onRetry={submit} />
      </div>
    </Modal>
  );
}

function UnsuspendDialog({ ctx, member, onClose, onDone }: { ctx: AdminCtx; member: MemberItem; onClose: () => void; onDone: (v: unknown) => void }) {
  const act = useAction(() => api.suspendOrgMember(ctx.orgId, member.profile.id, false, null));
  const name = member.profile.display_name;
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    onDone(r.value);
    toast({ kind: 'success', title: `${name} has access again` });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={`Restore access for ${name}?`}
      body={(
        <div className="ap-form">
          <p>{name} gets back every team server and channel they were in before the suspension.</p>
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel="Restore access"
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

function RemoveDialog({ ctx, member, onClose, onDone }: { ctx: AdminCtx; member: MemberItem; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [ban, setBan] = useState(false);
  const reasonError = validateReason(reason);
  const act = useAction(() => api.removeOrgMember(ctx.orgId, member.profile.id, ban, reason.trim() || null));
  const name = member.profile.display_name;
  const submit = async () => {
    if (reasonError) return;
    const r = await act.run();
    if (!r.ok) return;
    onDone();
    toast({ kind: 'success', title: ban ? `${name} was removed and banned` : `${name} was removed` });
    onClose();
  };
  return (
    <Modal
      open
      size="sm"
      title={`Remove ${name}?`}
      onClose={onClose}
      dismissable={!act.busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button>
          <Button variant="danger" onClick={submit} loading={act.busy} disabled={!!reasonError}>{ban ? 'Remove and ban' : 'Remove'}</Button>
        </>
      )}
    >
      <div className="ap-form">
        <p className="ap-card__text">
          {name} leaves {ctx.orgName} now: every team server, channel and direct message in it, and its notifications.
          Their messages stay in the conversations. Without a ban they can come back with a new invite.
        </p>
        <TextArea label="Reason (optional)" hint="Saved in the audit log." rows={3} value={reason} error={reasonError ?? null}
          onChange={(e) => setReason(e.target.value)} />
        <Checkbox label="Also ban them" description="Invite links will not work for them. Dek has no unban yet, so only use this for abuse." checked={ban} onChange={setBan} />
        <FormError error={act.error} onRetry={submit} />
      </div>
    </Modal>
  );
}
