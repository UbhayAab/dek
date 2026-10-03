// Join requests (DEK05): people who asked to join an approval server, or used an
// invite link that needs approval. Approving grants exactly what the request
// targeted; turning one down only records the decision. Org admins see them all
// here; server admins see their server's in its settings (RequestList).
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { DekError } from '../../../api/errors';
import type { JoinRequest } from '../../../api/types';
import { Avatar, Button, ConfirmDialog, EmptyState, toast } from '../../../ui/kit';
import type { AdminCtx } from '../AdminScreen';
import { useServers } from '../common/context';
import { relTime } from '../common/format';
import { invalidate, useAction, useLoad } from '../common/load';
import { Dot, FilterTabs, FormError, Gate, List, Pill, Row, Section, TimeText } from '../common/ui';

type Status = JoinRequest['status'];

const STATUS_LABEL: Record<Status, string> = { pending: 'Waiting', approved: 'Approved', rejected: 'Turned down', withdrawn: 'Withdrawn' };

export function RequestsSection({ ctx }: { ctx: AdminCtx }) {
  const [status, setStatus] = useState<Status>('pending');
  const load = useLoad(() => api.listJoinRequests(ctx.orgId, status), [ctx.orgId, status], { key: `jr:${ctx.orgId}:${status}` });
  const servers = useServers(ctx.orgId);
  const serverName = (id: string | null) => (id ? servers.data?.find((s) => s.id === id)?.name ?? 'a team server' : null);

  return (
    <Section title="Join requests" description="Decide who joins. Approving gives the person what they asked for: the organization, a team server, or the channels on their invite link.">
      <FilterTabs<Status>
        label="Show"
        value={status}
        onChange={setStatus}
        options={(['pending', 'approved', 'rejected', 'withdrawn'] as Status[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
      />
      <Gate
        load={load}
        what="request list"
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState icon="userPlus" title={status === 'pending' ? 'Nobody is waiting' : `No ${STATUS_LABEL[status].toLowerCase()} requests`} body={status === 'pending' ? 'New requests appear here and in the overview.' : undefined} />}
      >
        {(d) => (
          <RequestList
            items={d.items}
            orgName={ctx.orgName}
            serverName={serverName}
            onSettled={(r) => {
              load.mutate((prev) => (prev ? { items: prev.items.filter((x) => x.id !== r.id) } : prev));
              invalidate(`jr:${ctx.orgId}:`);
              ctx.refreshCounts();
            }}
            onStale={load.reload}
          />
        )}
      </Gate>
    </Section>
  );
}

export function RequestList({ items, orgName, serverName, onSettled, onStale }: {
  items: JoinRequest[];
  orgName: string;
  serverName: (id: string | null) => string | null;
  onSettled: (r: JoinRequest) => void;
  onStale: () => void;
}) {
  const [rejecting, setRejecting] = useState<JoinRequest | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: DekError } | null>(null);
  const approve = useAction((r: JoinRequest) => api.decideJoinRequest(r.id, true));

  const onApprove = async (r: JoinRequest) => {
    setBusyId(r.id);
    setRowError(null);
    const res = await approve.run(r);
    setBusyId(null);
    if (res.ok) {
      onSettled(r);
      toast({ kind: 'success', title: `${r.user.display_name} is in`, body: serverName(r.server_id) ? `They joined ${serverName(r.server_id)}.` : `They joined ${orgName}.` });
    } else if (res.error) {
      setRowError({ id: r.id, error: res.error });
      if (res.error.code === 'conflict') onStale();
    }
  };

  return (
    <>
      <List label="Join requests">
        {items.map((r) => (
          <Row
            key={r.id}
            testId={`request-${r.id}`}
            leading={<Avatar name={r.user.display_name} path={r.user.avatar_path} seed={r.user.id} size={36} />}
            title={(
              <>
                <span dir="auto">{r.user.display_name}</span>
                <Pill tone={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'neutral'}>{STATUS_LABEL[r.status]}</Pill>
              </>
            )}
            meta={(
              <>
                {r.email ? <><span>{r.email}</span><Dot /></> : null}
                <span>{serverName(r.server_id) ? `Wants to join ${serverName(r.server_id)}` : `Wants to join ${orgName}`}</span>
                {r.invite_id ? <><Dot /><span>Used an invite link</span></> : null}
                <Dot />
                <TimeText iso={r.created_at} />
              </>
            )}
            trailing={r.status === 'pending' ? (
              <>
                <Button variant="ghost" onClick={() => setRejecting(r)} disabled={busyId === r.id}>Turn down</Button>
                <Button variant="primary" icon="check" onClick={() => onApprove(r)} loading={busyId === r.id}>Approve</Button>
              </>
            ) : null}
          >
            {r.note ? <p className="ap-row__extra" dir="auto">{r.note}</p> : null}
            {rowError?.id === r.id ? <FormError error={rowError.error} onRetry={() => onApprove(r)} /> : null}
          </Row>
        ))}
      </List>
      {rejecting ? (
        <RejectDialog
          request={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            onSettled(rejecting);
            toast({ kind: 'success', title: `Turned down ${rejecting.user.display_name}`, body: `Asked ${relTime(rejecting.created_at)}.` });
          }}
        />
      ) : null}
    </>
  );
}

function RejectDialog({ request, onClose, onDone }: { request: JoinRequest; onClose: () => void; onDone: () => void }) {
  const act = useAction(() => api.decideJoinRequest(request.id, false));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    onDone();
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={`Turn down ${request.user.display_name}?`}
      body={(
        <div className="ap-form">
          <p>They are not told why. They can ask again later with a new invite link.</p>
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel="Turn down"
      danger
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
