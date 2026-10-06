// Requests to join locked channels that this person may decide (owner of the channel,
// admin of its team server): who, which channel, when; Let in or Decline (0916).
import { useEffect, useState } from 'react';
import { api } from '../../api/rpc';
import { humanError } from '../../api/errors';
import type { ChannelRequest } from '../../api/types';
import { setRequestCount, useRequestsRev } from '../../sync/requests';
import { Avatar, Button, EmptyState, ErrorState, Spinner, toast } from '../../ui/kit';
import { relativeShort } from '../conversation/time';

export function RequestsView({ orgId }: { orgId: string }) {
  const rev = useRequestsRev();
  const [items, setItems] = useState<ChannelRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.listChannelRequests(orgId)
      .then((r) => {
        if (!live) return;
        setItems(r.items);
        setError(null);
        setRequestCount(orgId, r.items.length);
      })
      .catch((e: unknown) => { if (live) setError(humanError(e)); });
    return () => { live = false; };
  }, [orgId, rev, attempt]);

  const decide = async (r: ChannelRequest, approve: boolean) => {
    setBusy(r.id);
    try {
      await api.decideChannelRequest(r.id, approve);
      const rest = (items ?? []).filter((x) => x.id !== r.id);
      setItems(rest);
      setRequestCount(orgId, rest.length);
      toast({ kind: 'success', title: approve ? `${r.user.display_name} is in #${r.channel.name ?? 'the channel'} now` : 'Request declined' });
    } catch (e) {
      toast({ kind: 'error', title: 'That did not work', body: humanError(e) });
    } finally {
      setBusy(null);
    }
  };

  if (error && !items) return <ErrorState title="Requests did not load" body={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!items) return <div className="dk-center"><Spinner size={22} label="Loading requests" /></div>;
  if (!items.length) {
    return <EmptyState icon="lock" title="No requests waiting"
      body="When someone asks to join an invite-only channel you look after, the request shows up here and you get a notification." />;
  }
  return (
    <ul className="dk-view__list dk-requests" aria-label="Requests to join">
      {items.map((r) => (
        <li key={r.id} className="dk-request">
          <Avatar name={r.user.display_name} path={r.user.avatar_path} seed={r.user.id} size={36} />
          <div className="dk-request__text">
            <span className="dk-request__who" dir="auto">{r.user.display_name}</span>
            <span className="dk-request__what" dir="auto">{`wants to join ${r.channel.kind === 'audio' ? '' : '#'}${r.channel.name ?? 'a channel'}`}</span>
            {r.note ? <span className="dk-request__note" dir="auto">{r.note}</span> : null}
            <time className="dk-request__time" dateTime={r.created_at}>{relativeShort(r.created_at)}</time>
          </div>
          <div className="dk-request__actions">
            <Button variant="primary" onClick={() => void decide(r, true)} loading={busy === r.id} disabled={!!busy && busy !== r.id}>Let in</Button>
            <Button variant="ghost" onClick={() => void decide(r, false)} disabled={!!busy}>Decline</Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
