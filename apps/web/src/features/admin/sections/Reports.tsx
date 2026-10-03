// Reports (DEK13): what members reported, with the reported message, its channel
// and the people involved; resolve by dismissing, removing the message, suspending
// or removing the person, with a note for the audit log.
import { useState } from 'react';
import { api } from '../../../api/rpc';
import type { Report } from '../../../api/types';
import { channelRoute } from '../../../app/router';
import { Avatar, Button, EmptyState, Modal, TextArea, toast } from '../../../ui/kit';
import { Icon } from '../../../ui/icons';
import type { AdminCtx } from '../AdminScreen';
import { readableBody, REPORT_REASON_LABEL, resolutionText } from '../common/format';
import { invalidate, offsetPage, useAction, usePaged } from '../common/load';
import { linkProps } from '../common/nav';
import { nameOf, useProfiles } from '../common/people';
import { Dot, FilterTabs, FormError, List, PagedView, Pill, RadioGroup, Row, Section, TimeText, type Choice } from '../common/ui';
import { validateReason } from '../common/validation';

type Status = 'open' | 'actioned' | 'dismissed';
type Action = 'dismiss' | 'remove_message' | 'suspend_user' | 'remove_user';

const STATUS_LABEL: Record<Status, string> = { open: 'Open', actioned: 'Acted on', dismissed: 'Dismissed' };

function mentionIds(body: string): string[] {
  return Array.from(body.matchAll(/<@([0-9a-f-]{36})>/gi), (m) => m[1] as string);
}

export function ReportsSection({ ctx }: { ctx: AdminCtx }) {
  const [status, setStatus] = useState<Status>('open');
  const paged = usePaged<Report, number>(
    async (cursor) => offsetPage(await api.listReports(ctx.orgId, status, 50, cursor ?? 0), cursor ?? 0),
    [ctx.orgId, status],
  );
  const [resolving, setResolving] = useState<Report | null>(null);
  const ids = paged.items.flatMap((r) => [r.resolved_by, r.message?.author_id ?? null, ...mentionIds(r.message?.body ?? '')]);
  const who = useProfiles(ids);

  return (
    <Section title="Reports" description="Members report messages and people that break the rules. Review each one; every decision is kept in the audit log.">
      <FilterTabs<Status>
        label="Show"
        value={status}
        onChange={setStatus}
        options={(['open', 'actioned', 'dismissed'] as Status[]).map((s) => ({
          value: s,
          label: STATUS_LABEL[s],
          count: s === 'open' ? ctx.openReports : undefined,
        }))}
      />
      <PagedView
        paged={paged}
        what="report list"
        empty={<EmptyState icon="flag" title={status === 'open' ? 'Nothing to review' : `No ${STATUS_LABEL[status].toLowerCase()} reports`} body={status === 'open' ? 'When someone reports a message or a person, it shows up here.' : undefined} />}
      >
        {(items) => (
          <List label="Reports">
            {items.map((r) => (
              <ReportRow key={r.id} r={r} ctx={ctx} nameOf={(id) => nameOf(who(id), 'someone')} onReview={() => setResolving(r)} />
            ))}
          </List>
        )}
      </PagedView>
      {resolving ? (
        <ResolveDialog
          report={resolving}
          onClose={() => setResolving(null)}
          onDone={() => {
            paged.update((items) => items.filter((x) => x.id !== resolving.id && !(resolving.message && x.message?.id === resolving.message.id && status === 'open')));
            invalidate(`rep:${ctx.orgId}:`);
            ctx.refreshCounts();
          }}
        />
      ) : null}
    </Section>
  );
}

function ReportRow({ r, ctx, nameOf: name, onReview }: { r: Report; ctx: AdminCtx; nameOf: (id: string) => string; onReview: () => void }) {
  const msg = r.message;
  const deleted = !!msg?.deleted_at;
  return (
    <Row
      leading={<span className="adm-roundicon adm-roundicon--warning" aria-hidden="true"><Icon name="flag" size={18} /></span>}
      title={(
        <>
          <span>{r.kind === 'message' ? 'Reported message' : 'Reported person'}</span>
          <Pill tone="warning">{REPORT_REASON_LABEL[r.reason] ?? r.reason}</Pill>
          {r.status !== 'open' ? <Pill tone={r.status === 'actioned' ? 'success' : 'neutral'}>{STATUS_LABEL[r.status as Status] ?? r.status}</Pill> : null}
        </>
      )}
      meta={(
        <>
          <span>By {r.reporter.display_name}</span>
          <Dot />
          <TimeText iso={r.created_at} />
        </>
      )}
      trailing={r.status === 'open' ? <Button variant="primary" onClick={onReview}>Review</Button> : null}
    >
      <div className="adm-report">
        {r.target_user ? (
          <p className="adm-report__line">
            <Avatar name={r.target_user.display_name} path={r.target_user.avatar_path} seed={r.target_user.id} size={20} />
            <span>About <span className="ap-strong" dir="auto">{r.target_user.display_name}</span></span>
          </p>
        ) : null}
        {r.kind === 'message' ? (
          msg && !deleted ? (
            <>
              <blockquote className="ap-quote" dir="auto">{readableBody(msg.body, name) || '(attachment only)'}</blockquote>
              {r.channel ? (
                <p className="adm-report__line ap-meta">
                  <span>In {r.channel.name ? `#${r.channel.name}` : 'a direct message'}</span>
                  <Dot />
                  <TimeText iso={msg.created_at} prefix="posted" />
                  {r.channel.kind !== 'dm' && r.channel.kind !== 'group_dm' ? (
                    <>
                      <Dot />
                      <a {...linkProps(channelRoute(ctx.orgId, r.channel.id, { messageId: msg.id }))}>Open in channel</a>
                    </>
                  ) : null}
                </p>
              ) : null}
            </>
          ) : <p className="ap-hint">The message was deleted.</p>
        ) : null}
        {r.details ? <p className="adm-report__details" dir="auto"><span className="ap-strong">Details: </span>{r.details}</p> : null}
        {r.status !== 'open' ? (
          <p className="ap-hint">
            {r.resolved_by ? `${name(r.resolved_by)}: ` : ''}{resolutionText(r.resolution)}{r.resolved_at ? ' ' : ''}<TimeText iso={r.resolved_at} />
          </p>
        ) : null}
      </div>
    </Row>
  );
}

function ResolveDialog({ report, onClose, onDone }: { report: Report; onClose: () => void; onDone: () => void }) {
  const msgAlive = report.kind === 'message' && !!report.message && !report.message.deleted_at;
  const person = report.target_user?.display_name ?? 'the person';
  const [action, setAction] = useState<Action>(msgAlive ? 'remove_message' : 'dismiss');
  const [note, setNote] = useState('');
  const noteError = validateReason(note, 900);
  const act = useAction(() => api.resolveReport(report.id, action, note.trim() || null));
  const options: Choice<Action>[] = [
    { value: 'dismiss', label: 'Dismiss', description: 'Nothing here breaks the rules. The report closes.' },
    ...(msgAlive ? [{ value: 'remove_message' as const, label: 'Remove the message', description: 'Everyone sees "message removed". The text stays in the audit log for review.' }] : []),
    ...(report.target_user ? [
      { value: 'suspend_user' as const, label: `Suspend ${person}`, description: 'They lose access to the organization until an admin restores it.' },
      { value: 'remove_user' as const, label: `Remove ${person}`, description: 'They leave the organization. Their messages stay.' },
    ] : []),
  ];
  const label: Record<Action, string> = {
    dismiss: 'Dismiss report',
    remove_message: 'Remove message',
    suspend_user: `Suspend ${person}`,
    remove_user: `Remove ${person}`,
  };
  const submit = async () => {
    if (noteError) return;
    const r = await act.run();
    if (!r.ok) return;
    onDone();
    toast({ kind: 'success', title: action === 'dismiss' ? 'Report dismissed' : 'Report resolved', body: action === 'dismiss' ? undefined : label[action] });
    onClose();
  };
  return (
    <Modal open size="md" title="Review report" onClose={onClose} dismissable={!act.busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button>
          <Button variant={action === 'dismiss' ? 'primary' : 'danger'} onClick={submit} loading={act.busy} disabled={!!noteError}>{label[action]}</Button>
        </>
      )}>
      <div className="ap-form">
        <RadioGroup legend="What should happen?" value={action} options={options} onChange={setAction} />
        <TextArea label="Note (optional)" hint="Saved with the decision in the audit log." rows={3} value={note} error={noteError ?? null}
          onChange={(e) => setNote(e.target.value)} />
        <FormError error={act.error} onRetry={submit} />
      </div>
    </Modal>
  );
}
