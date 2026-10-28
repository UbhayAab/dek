// "New message": pick one person for a DM or two to eight for a group DM
// (open_dm reuses the existing conversation for the same people).
import { useEffect, useState } from 'react';
import { api } from '../../api/rpc';
import type { Profile } from '../../api/types';
import { humanError, toDekError } from '../../api/errors';
import { channelRoute, navigate, navigateDeeper } from '../../app/router';
import { actions } from '../../store';
import { Icon } from '../../ui/icons';
import { Avatar, Banner, Button, ErrorState, Modal, Skeleton, TextField } from '../../ui/kit';
import { isActive } from '../conversation/time';
import { useMeId } from './hooks';
import { closeDmPicker, useUi } from './ui-store';
import { useLayout } from './layout';
import { run } from '../conversation/safe';

const MAX_OTHERS = 8; // a group DM holds at most 9 people including you (CONTRACT 0)
const DEBOUNCE_MS = 250;
const QUERY_ID = 'dk-dmpick-q';

type Load = { status: 'loading' } | { status: 'ready'; people: Profile[] } | { status: 'error'; message: string };

export function DmPicker({ orgId }: { orgId: string }) {
  const open = useUi((s) => s.dmPickerOpen);
  return open ? <DmPickerDialog orgId={orgId} /> : null;
}

function DmPickerDialog({ orgId }: { orgId: string }) {
  const meId = useMeId();
  const layout = useLayout();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Profile[]>([]);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = { cancelled: false };
    setLoad((l) => (l.status === 'ready' ? l : { status: 'loading' }));
    const t = setTimeout(() => {
      api.listOrgMembers(orgId, query.trim() || null, null, 30)
        .then((res) => {
          if (ctrl.cancelled) return;
          setLoad({ status: 'ready', people: res.items.map((i) => i.profile).filter((p) => p.id !== meId && !p.deleted) });
        })
        .catch((e: unknown) => { if (!ctrl.cancelled) setLoad({ status: 'error', message: humanError(e) }); });
    }, query ? DEBOUNCE_MS : 0);
    return () => { ctrl.cancelled = true; clearTimeout(t); };
  }, [orgId, query, meId, attempt]);

  const toggle = (p: Profile) => {
    setError(null);
    setPicked((cur) => {
      if (cur.some((x) => x.id === p.id)) return cur.filter((x) => x.id !== p.id);
      if (cur.length >= MAX_OTHERS) {
        setError(`A group conversation can include at most ${MAX_OTHERS} other people.`);
        return cur;
      }
      return [...cur, p];
    });
    document.getElementById(QUERY_ID)?.focus();
  };

  const start = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Resolves with the conversation already in the store (and the sidebar).
      const channelId = await run(() => actions.openDm(picked.map((p) => p.id)));
      closeDmPicker();
      const to = channelRoute(orgId, channelId);
      if (layout === 'phone') navigateDeeper(to);
      else navigate(to);
    } catch (e) {
      const err = toDekError(e);
      setError(err.code === 'blocked' ? 'You cannot start a conversation with someone you blocked or who blocked you.' : err.hint);
    } finally {
      setBusy(false);
    }
  };

  const pickedIds = new Set(picked.map((p) => p.id));
  const label = picked.length > 1 ? `Start group conversation (${picked.length + 1} people)` : 'Open conversation';

  return (
    <Modal open onClose={closeDmPicker} title="New message" size="md"
      footer={<>
        <Button variant="ghost" onClick={closeDmPicker} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={() => void start()} loading={busy} disabled={!picked.length}>{label}</Button>
      </>}>
      <div className="dk-dmpick">
        <TextField
          id={QUERY_ID}
          label="To"
          placeholder="Search people by name"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          hint={picked.length ? undefined : 'One person opens a direct message. Two to eight start a group conversation.'}
        />
        {picked.length ? (
          <ul className="dk-dmpick__chips" aria-label="Selected people">
            {picked.map((p) => (
              <li key={p.id}>
                <button type="button" className="dk-chip" onClick={() => toggle(p)} aria-label={`Remove ${p.display_name}`}>
                  <Avatar name={p.display_name} path={p.avatar_path} seed={p.id} size={20} />
                  <span>{p.display_name}</span>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="dk-dmpick__results" aria-live="polite" aria-busy={load.status === 'loading'}>
          {load.status === 'loading' ? (
            <><Skeleton lines={1} /><Skeleton lines={1} /><Skeleton lines={1} /></>
          ) : load.status === 'error' ? (
            <ErrorState title="People did not load" body={load.message} onRetry={() => setAttempt((n) => n + 1)} />
          ) : load.people.length === 0 ? (
            <p className="dk-dmpick__empty">{query ? `Nobody in this organization matches "${query}".` : 'Nobody else is in this organization yet.'}</p>
          ) : (
            <ul className="dk-dmpick__list" aria-label="People">
              {load.people.map((p) => {
                const on = pickedIds.has(p.id);
                return (
                  <li key={p.id}>
                    <button type="button" className={`dk-person${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggle(p)}>
                      <Avatar name={p.display_name} path={p.avatar_path} seed={p.id} size={32} active={isActive(p.last_active_at)} />
                      <span className="dk-person__text">
                        <span className="dk-person__name">{p.display_name}</span>
                        <span className="dk-person__sub">{p.title || (p.handle ? `@${p.handle}` : isActive(p.last_active_at) ? 'Active now' : ' ')}</span>
                      </span>
                      <span className="dk-person__check" aria-hidden="true">{on ? <Icon name="check" size={18} /> : null}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
