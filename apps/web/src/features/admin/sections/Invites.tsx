// Invite links (DEK05): create, see who made each one and its state (active,
// expired, used up, revoked), copy or share it again, revoke it. A revoked or
// expired link stops working at once (the server checks on every use).
import { useEffect, useState } from 'react';
import { api } from '../../../api/rpc';
import type { InviteSummary } from '../../../api/types';
import { Button, ConfirmDialog, EmptyState, IconButton, toast } from '../../../ui/kit';
import type { AdminCtx } from '../AdminScreen';
import { inviteUrl, useServers } from '../common/context';
import { XIcon } from '../common/icons';
import { INVITE_STATUS_LABEL, inviteStatus, relTime, usesText, type InviteStatus } from '../common/format';
import { invalidate, useAction, useLoad } from '../common/load';
import { go, pathWithHash, useHashValue } from '../common/nav';
import { nameOf, useProfiles } from '../common/people';
import { copyText, Dot, FilterTabs, FormError, Gate, List, Pill, Row, Section, TimeText, type PillTone } from '../common/ui';
import { InviteDialog } from './InviteDialog';

type Filter = 'all' | InviteStatus;

const STATUS_TONE: Record<InviteStatus, PillTone> = { active: 'success', expired: 'neutral', used_up: 'warning', revoked: 'danger' };

export function InvitesSection({ ctx }: { ctx: AdminCtx }) {
  const load = useLoad(() => api.listInvites(ctx.orgId), [ctx.orgId], { key: `invites:${ctx.orgId}` });
  const servers = useServers(ctx.orgId);
  const hash = useHashValue();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');
  const [revoking, setRevoking] = useState<InviteSummary | null>(null);
  const who = useProfiles(load.data?.items.map((i) => i.created_by) ?? []);

  useEffect(() => {
    if (hash === 'new') setCreating(true);
  }, [hash]);
  const closeCreate = () => {
    setCreating(false);
    if (hash === 'new') go(pathWithHash(null), 'replace');
  };

  const archived = new Set((servers.data ?? []).filter((s) => s.archived).map((s) => s.id));
  const now = Date.now();
  const all = (load.data?.items ?? []).map((inv) => ({ inv, status: inviteStatus(inv, now, archived) }));
  const count = (f: Filter) => (f === 'all' ? all.length : all.filter((x) => x.status === f).length);
  const shown = filter === 'all' ? all : all.filter((x) => x.status === filter);
  const serverName = (id: string | null) => (id ? servers.data?.find((s) => s.id === id)?.name ?? 'A team server' : null);

  return (
    <Section
      title="Invites"
      description="Invite links bring people into the organization, a team server and chosen channels."
      actions={<Button variant="primary" icon="userPlus" onClick={() => setCreating(true)}>Create invite link</Button>}
    >
      <FilterTabs<Filter>
        label="Show"
        value={filter}
        onChange={setFilter}
        options={(['active', 'all', 'expired', 'used_up', 'revoked'] as Filter[]).map((f) => ({
          value: f,
          label: f === 'all' ? 'All' : INVITE_STATUS_LABEL[f],
          count: load.data ? count(f) : undefined,
        }))}
      />
      <Gate load={load} what="invite list">
        {() => (shown.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={filter === 'active' ? 'No active invite links' : filter === 'all' ? 'No invite links yet' : `No ${INVITE_STATUS_LABEL[filter as InviteStatus].toLowerCase()} links`}
            body={filter === 'active' || filter === 'all' ? 'Create a link and share it with the people you want to bring in.' : undefined}
          />
        ) : (
          <List label="Invite links">
            {shown.map(({ inv, status }) => (
              <InviteRow
                key={inv.id}
                inv={inv}
                status={status}
                target={serverName(inv.server_id)}
                creator={nameOf(who(inv.created_by), 'Someone')}
                orgName={ctx.orgName}
                onRevoke={() => setRevoking(inv)}
              />
            ))}
          </List>
        ))}
      </Gate>
      <p className="ap-hint">Admins see the 200 newest links. Links made before the move to the new Dek keep working but cannot be shown again.</p>

      {creating && servers.data ? (
        <InviteDialog
          orgId={ctx.orgId}
          orgName={ctx.orgName}
          settings={ctx.settings}
          servers={servers.data}
          onClose={closeCreate}
          onCreated={() => { invalidate(`invites:${ctx.orgId}`); load.reload(); setFilter('active'); }}
        />
      ) : null}
      {creating && !servers.data && servers.status === 'error' && servers.error ? (
        <FormError error={servers.error} onRetry={servers.reload} />
      ) : null}
      {revoking ? (
        <RevokeDialog
          inv={revoking}
          onClose={() => setRevoking(null)}
          onDone={(updated) => {
            load.mutate((prev) => (prev ? { items: prev.items.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)) } : prev));
          }}
        />
      ) : null}
    </Section>
  );
}

function InviteRow({ inv, status, target, creator, orgName, onRevoke }: {
  inv: InviteSummary;
  status: InviteStatus;
  target: string | null;
  creator: string;
  orgName: string;
  onRevoke: () => void;
}) {
  const url = inv.code ? inviteUrl(inv.code) : null;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const active = status === 'active';
  const copy = async () => {
    if (!url) return;
    const ok = await copyText(url);
    toast(ok ? { kind: 'success', title: 'Link copied' } : { kind: 'error', title: 'Copy did not work', body: url });
  };
  const share = async () => {
    if (!url) return;
    try {
      await navigator.share({ title: `Join ${orgName} on Dek`, url });
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') toast({ kind: 'error', title: 'Sharing did not work', body: 'Copy the link instead.' });
    }
  };
  return (
    <Row
      testId={`invite-${inv.id}`}
      muted={!active}
      leading={<span className="adm-roundicon" aria-hidden="true"><XIcon name="link" size={18} /></span>}
      title={(
        <>
          <span>{target ?? 'Organization only'}</span>
          {inv.role === 'guest' ? <Pill tone="warning">Guest</Pill> : null}
          {inv.requires_approval ? <Pill tone="accent">Needs approval</Pill> : null}
          <Pill tone={STATUS_TONE[status]}>{INVITE_STATUS_LABEL[status]}</Pill>
        </>
      )}
      meta={(
        <>
          {inv.email ? <><span>For {inv.email}</span><Dot /></> : null}
          <span>{usesText(inv)}</span>
          <Dot />
          <span>
            {status === 'revoked' && inv.revoked_at ? `Revoked ${relTime(inv.revoked_at)}`
              : status === 'expired' ? `Expired ${relTime(inv.expires_at)}`
                : `Expires ${relTime(inv.expires_at)}`}
          </span>
          <Dot />
          <span>By {creator}, <TimeText iso={inv.created_at} /></span>
        </>
      )}
      trailing={(
        <>
          {active && url ? <IconButton icon="copy" label="Copy invite link" onClick={copy} /> : null}
          {active && url && canShare ? <IconButton icon="share" label="Share invite link" onClick={share} /> : null}
          {!inv.revoked_at ? <Button variant="ghost" onClick={onRevoke}>Revoke</Button> : null}
        </>
      )}
    >
      {!inv.code ? <p className="ap-hint">This link was made before the move to the new Dek, so it cannot be shown again.</p> : null}
    </Row>
  );
}

function RevokeDialog({ inv, onClose, onDone }: { inv: InviteSummary; onClose: () => void; onDone: (i: InviteSummary) => void }) {
  const act = useAction(() => api.revokeInvite(inv.id));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    const v = r.value as Partial<InviteSummary> | null;
    onDone({ ...inv, ...(v ?? {}), revoked_at: v?.revoked_at ?? new Date().toISOString() });
    toast({ kind: 'success', title: 'Invite link revoked', body: 'Nobody can use it any more.' });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title="Revoke this invite link?"
      body={(
        <div className="ap-form">
          <p>The link stops working at once, also for people who already have it. People who joined with it stay.</p>
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel="Revoke link"
      danger
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
