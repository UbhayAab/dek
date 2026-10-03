// Audit log (DEK13): who changed what and when, newest first, in sentences rather
// than codes. Pages by time (list_audit's p_before cursor).
import { api } from '../../../api/rpc';
import type { AuditItem } from '../../../api/types';
import { useDek } from '../../../store';
import { Avatar, EmptyState } from '../../../ui/kit';
import type { AdminCtx } from '../AdminScreen';
import { useServers } from '../common/context';
import { auditExtras, auditSentence, formatDateTime, type AuditNames } from '../common/format';
import { usePaged } from '../common/load';
import { useProfiles } from '../common/people';
import { List, PagedView, Row, Section, TimeText } from '../common/ui';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function AuditSection({ ctx }: { ctx: AdminCtx }) {
  const paged = usePaged<AuditItem, string>(async (cursor) => {
    const res = await api.listAudit(ctx.orgId, cursor, 50);
    const last = res.items[res.items.length - 1];
    return { items: res.items, next: res.has_more && last ? last.created_at : null };
  }, [ctx.orgId]);
  const servers = useServers(ctx.orgId);
  const channels = useDek((s) => s.channels);
  const who = useProfiles(paged.items.flatMap((a) => [
    a.target_type === 'user' ? a.target_id : null,
    str(a.details?.user_id),
    str(a.details?.author_id),
  ]));
  const names: AuditNames = {
    user: (id) => (id ? who(id)?.display_name ?? 'someone' : 'someone'),
    server: (id) => (id ? servers.data?.find((s) => s.id === id)?.name ?? 'a team server' : 'a team server'),
    channel: (id) => {
      const c = id ? channels[id] : undefined;
      return c?.name ? `#${c.name}` : 'a channel';
    },
  };

  return (
    <Section title="Audit log" description="Every admin and moderation action in this organization: roles, suspensions, removals, invites, servers, channels and reports.">
      <PagedView
        paged={paged}
        what="audit log"
        moreLabel="Show older entries"
        empty={<EmptyState icon="shield" title="Nothing recorded yet" body="Admin actions appear here as they happen." />}
      >
        {(items) => (
          <List label="Audit entries">
            {items.map((a) => {
              const actor = a.actor;
              const extras = auditExtras(a);
              return (
                <Row
                  key={a.id}
                  leading={actor
                    ? <Avatar name={actor.display_name} path={actor.avatar_path} seed={actor.id} size={32} />
                    : <Avatar name="Dek" seed="system" size={32} />}
                  title={(
                    <span className="adm-audit__sentence">
                      <span className="ap-strong" dir="auto">{actor?.display_name ?? 'Dek'}</span>{' '}
                      <span className="adm-audit__what">{auditSentence(a, names)}</span>
                    </span>
                  )}
                  meta={<><TimeText iso={a.created_at} /><span className="ap-meta" title={formatDateTime(a.created_at)}>{a.action}</span></>}
                >
                  {extras.length ? (
                    <dl className="adm-audit__extras">
                      {extras.map((x) => (
                        <div key={x.label} className="adm-audit__extra">
                          <dt>{x.label}</dt>
                          <dd dir="auto">{x.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </Row>
              );
            })}
          </List>
        )}
      </PagedView>
    </Section>
  );
}
