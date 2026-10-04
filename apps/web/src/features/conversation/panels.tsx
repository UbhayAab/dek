// The conversation's side panels: members, pinned messages, and details with
// notification level, settings and leave. Desktop: right pane; tablet: overlay;
// phone: a full-screen layer (the URL carries ?pane= so back closes it).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api/rpc';
import type { Channel, MemberItem, Message } from '../../api/types';
import { humanError } from '../../api/errors';
import { channelRoute, navigate, navigateDeeper } from '../../app/router';
import { actions, useDek } from '../../store';
import { Icon, type IconName } from '../../ui/icons';
import { Avatar, Button, ConfirmDialog, EmptyState, ErrorState, IconButton, Skeleton, TextField, toast } from '../../ui/kit';
import { ScreenHeader } from '../shell/ScreenHeader';
import { closePane, type Pane } from '../shell/layout';
import { MessageCard } from './MessageCard';
import { messageRoute } from './jump';
import { channelKindLabel, channelLabel, isDm, isMuted } from './names';
import { LEVELS, MUTES, levelLabel, muteUntil, setNotify } from './notify';
import { setBlocked } from './blocks';
import { canManageChannel, canPin, type Who } from './permissions';
import { run } from './safe';
import { fullTimeLabel, isActive, relativeLong } from './time';

const PAGE = 100;

function PanelFrame({ title, icon, variant, children }: { title: string; icon: IconName; variant: 'pane' | 'screen'; children: ReactNode }) {
  return (
    <section className={`dk-panel dk-panel--${variant}`} aria-label={title}>
      {variant === 'screen' ? (
        <ScreenHeader title={title} icon={icon} onBack={closePane} backLabel="Back to the conversation" />
      ) : (
        <header className="dk-panehead">
          <div className="dk-panehead__titles">
            <h2 className="dk-panehead__title"><Icon name={icon} size={18} />{title}</h2>
          </div>
          <IconButton icon="x" label={`Close ${title.toLowerCase()}`} onClick={closePane} />
        </header>
      )}
      <div className="dk-panel__body scroll-y">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- members

function MembersPanel({ channel, orgId, variant, meId }: { channel: Channel; orgId: string; variant: 'pane' | 'screen'; meId: string | null }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MemberItem[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setStatus('loading');
    const t = setTimeout(() => {
      api.listChannelMembers(channel.id, query.trim() || null, PAGE, 0)
        .then((r) => { if (!live) return; setItems(r.items); setTotal(r.total ?? r.items.length); setStatus('ready'); })
        .catch((e: unknown) => { if (!live) return; setError(humanError(e)); setStatus('error'); });
    }, query ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [channel.id, query, attempt]);

  const loadMore = async () => {
    setMore(true);
    try {
      const r = await api.listChannelMembers(channel.id, query.trim() || null, PAGE, items.length);
      setItems((cur) => [...cur, ...r.items.filter((x) => !cur.some((c) => c.profile.id === x.profile.id))]);
      setTotal(r.total ?? total);
    } catch (e) {
      toast({ kind: 'error', title: 'More members did not load', body: humanError(e) });
    } finally {
      setMore(false);
    }
  };

  const message = async (userId: string) => {
    setOpening(userId);
    try {
      const id = await run(() => actions.openDm([userId]));
      navigate(channelRoute(orgId, id));
    } catch (e) {
      toast({ kind: 'error', title: 'Could not open the conversation', body: humanError(e) });
    } finally {
      setOpening(null);
    }
  };

  // Block (DEK13): they can no longer start a direct conversation with you; shared
  // channels are unchanged. Unblock in Settings, Blocked people.
  const [blocking, setBlocking] = useState<{ id: string; name: string } | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const block = async () => {
    if (!blocking) return;
    setBlockBusy(true);
    try {
      await setBlocked(blocking.id, true);
      toast({ kind: 'success', title: `${blocking.name} is blocked`, body: 'Unblock them any time in Settings, Blocked people.' });
      setBlocking(null);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not block', body: humanError(e) });
    } finally {
      setBlockBusy(false);
    }
  };

  return (
    <PanelFrame title={`Members${status === 'ready' ? ` (${total})` : ''}`} icon="users" variant={variant}>
      <div className="dk-panel__search">
        <TextField label="Find a member" hideLabel placeholder="Find a member" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {status === 'loading' && !items.length ? (
        <><Skeleton lines={1} /><Skeleton lines={1} /><Skeleton lines={1} /></>
      ) : status === 'error' ? (
        <ErrorState title="Members did not load" body={error ?? undefined} onRetry={() => setAttempt((n) => n + 1)} />
      ) : items.length === 0 ? (
        <EmptyState icon="users" title={query ? 'Nobody matches' : 'No members'} body={query ? `No member of this conversation matches "${query}".` : undefined} />
      ) : (
        <ul className="dk-members">
          {items.map((it) => {
            const p = it.profile;
            const me = p.id === meId;
            return (
              <li key={p.id} className="dk-member">
                <Avatar name={p.display_name} path={p.avatar_path} seed={p.id} size={32} active={isActive(p.last_active_at)} />
                <span className="dk-member__text">
                  <span className="dk-member__name" dir="auto">{p.display_name}{me ? ' (you)' : ''}</span>
                  <span className="dk-member__sub">
                    {it.role === 'owner' ? 'Channel owner' : p.title || (isActive(p.last_active_at) ? 'Active now' : p.last_active_at ? `Active ${relativeLong(p.last_active_at)}` : 'Member')}
                  </span>
                </span>
                {!me && !p.deleted && channel.kind !== 'dm' ? (
                  <IconButton icon="message" label={`Message ${p.display_name}`} onClick={() => void message(p.id)} disabled={opening === p.id} />
                ) : null}
                {!me && !p.deleted ? (
                  <IconButton icon="shield" label={`Block ${p.display_name}`} onClick={() => setBlocking({ id: p.id, name: p.display_name })} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog open={blocking !== null} title={`Block ${blocking?.name ?? ''}?`}
        body="They will not be able to start a direct conversation with you, and you will not get their direct messages. Messages in shared channels stay visible. You can unblock them in Settings."
        confirmLabel="Block" danger busy={blockBusy}
        onConfirm={() => void block()} onCancel={() => setBlocking(null)} />

      {status === 'ready' && items.length < total ? (
        <div className="dk-panel__more"><Button variant="secondary" loading={more} onClick={() => void loadMore()}>Show more members</Button></div>
      ) : null}
    </PanelFrame>
  );
}

// ---------------------------------------------------------------- pins

function PinsPanel({ channel, orgId, variant, who, deeper }: { channel: Channel; orgId: string; variant: 'pane' | 'screen'; who: Who; deeper: boolean }) {
  const [items, setItems] = useState<Message[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const mayPin = canPin(channel, who);

  useEffect(() => {
    let live = true;
    setStatus('loading');
    api.listPins(channel.id)
      .then((r) => { if (live) { setItems(r.messages); setStatus('ready'); } })
      .catch((e: unknown) => { if (live) { setError(humanError(e)); setStatus('error'); } });
    return () => { live = false; };
  }, [channel.id, attempt]);

  const unpin = async (id: string) => {
    setBusy(id);
    try {
      await run(() => actions.pinMessage(id, false));
      setItems((cur) => cur.filter((m) => m.id !== id));
      toast({ kind: 'success', title: 'Unpinned' });
    } catch (e) {
      toast({ kind: 'error', title: 'Not unpinned', body: humanError(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <PanelFrame title="Pinned messages" icon="pin" variant={variant}>
      {status === 'loading' ? (
        <><Skeleton lines={2} /><Skeleton lines={2} /></>
      ) : status === 'error' ? (
        <ErrorState title="Pinned messages did not load" body={error ?? undefined} onRetry={() => setAttempt((n) => n + 1)} />
      ) : items.length === 0 ? (
        <EmptyState icon="pin" title="Nothing pinned yet"
          body={mayPin ? 'Pin important messages from their actions menu so everyone can find them here.' : 'Admins pin important messages here.'} />
      ) : (
        <ul className="dk-cardlist">
          {items.map((m) => (
            <li key={m.id}>
              <MessageCard message={m} channel={channel} orgId={orgId} showChannel={false}
                onJump={() => { const to = messageRoute(orgId, m); if (deeper) navigateDeeper(to); else navigate(to); }}
                extra={mayPin ? <Button variant="ghost" icon="pin" loading={busy === m.id} onClick={() => void unpin(m.id)}>Unpin</Button> : undefined} />
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

// ---------------------------------------------------------------- info

export function useLeaveChannel(channel: Channel, orgId: string) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const leave = useCallback(async () => {
    setBusy(true);
    try {
      await run(() => actions.leaveChannel(channel.id));
      setConfirm(false);
      toast({ kind: 'success', title: `You left #${channel.name ?? 'the channel'}` });
      navigate({ name: 'org', orgId }, { replace: true });
    } catch (e) {
      toast({ kind: 'error', title: 'You are still in the channel', body: humanError(e) });
    } finally {
      setBusy(false);
    }
  }, [channel.id, channel.name, orgId]);
  const dialog = confirm ? (
    <ConfirmDialog open title={`Leave #${channel.name ?? 'channel'}?`}
      body={channel.visibility === 'private'
        ? 'This is a private channel. You will need to be added again to come back.'
        : 'You can join again from Browse channels.'}
      confirmLabel="Leave" danger busy={busy} onConfirm={() => void leave()} onCancel={() => { if (!busy) setConfirm(false); }} />
  ) : null;
  return { ask: () => setConfirm(true), dialog };
}

function InfoPanel({ channel, orgId, variant, who }: { channel: Channel; orgId: string; variant: 'pane' | 'screen'; who: Who }) {
  const profiles = useDek((s) => s.profiles);
  const [busy, setBusy] = useState(false);
  const manage = canManageChannel(channel, who);
  const dm = isDm(channel);
  const leave = useLeaveChannel(channel, orgId);
  const muted = isMuted(channel);
  const creator = channel.created_by ? profiles[channel.created_by]?.display_name : null;
  const defaultLevel = useDek((s) => s.me?.prefs?.default_level ?? 'mentions');

  const set = async (level: Channel['notify'], until: string | null, msg: string) => {
    setBusy(true);
    await setNotify(channel, level, until, msg);
    setBusy(false);
  };

  return (
    <PanelFrame title="Details" icon="info" variant={variant}>
      <dl className="dk-info">
        <div className="dk-info__row"><dt>Name</dt><dd dir="auto">{channelLabel(channel, profiles)}</dd></div>
        <div className="dk-info__row"><dt>Type</dt><dd>{channelKindLabel(channel)}{channel.archived ? ' (archived)' : ''}</dd></div>
        {channel.topic ? <div className="dk-info__row"><dt>Topic</dt><dd dir="auto">{channel.topic}</dd></div> : null}
        {channel.description ? <div className="dk-info__row"><dt>Description</dt><dd dir="auto">{channel.description}</dd></div> : null}
        <div className="dk-info__row"><dt>Members</dt><dd>{channel.member_count}</dd></div>
        {!dm ? (
          <div className="dk-info__row"><dt>Created</dt><dd>{`${fullTimeLabel(channel.created_at)}${creator ? ` by ${creator}` : ''}`}</dd></div>
        ) : null}
      </dl>
      {channel.member ? (
        <section className="dk-info__section" aria-labelledby="dk-notify-h">
          <h3 id="dk-notify-h" className="dk-info__h">Notifications</h3>
          <p className="dk-info__note">
            {muted && channel.muted_until && channel.notify !== 'none'
              ? `Muted until ${fullTimeLabel(channel.muted_until)}.`
              : channel.notify === 'default'
                ? `Currently: your default (${levelLabel(defaultLevel).toLowerCase()}).`
                : `Currently: ${levelLabel(channel.notify).toLowerCase()}.`}
          </p>
          <div className="dk-info__choices" role="group" aria-label="Notification level">
            {LEVELS.map((l) => (
              <button key={l.level} type="button" className={`dk-choice${channel.notify === l.level ? ' is-on' : ''}`} aria-pressed={channel.notify === l.level}
                disabled={busy} onClick={() => void set(l.level, channel.muted_until, `Notifications: ${l.label.toLowerCase()}`)}>
                <span className="dk-choice__label">{l.label}</span>
                <span className="dk-choice__hint">{l.hint}</span>
              </button>
            ))}
          </div>
          <div className="dk-info__mutes">
            {muted && channel.muted_until ? (
              <Button variant="secondary" icon="bell" disabled={busy} onClick={() => void set(channel.notify === 'none' ? 'default' : channel.notify, null, 'Unmuted')}>Unmute</Button>
            ) : MUTES.map((m) => (
              <Button key={m.minutes} variant="ghost" icon="bellOff" disabled={busy} onClick={() => void set(channel.notify, muteUntil(m.minutes), m.label.replace('Mute for', 'Muted for'))}>{m.label}</Button>
            ))}
          </div>
        </section>
      ) : null}
      <div className="dk-info__actions">
        {manage ? <Button variant="secondary" icon="settings" onClick={() => navigate({ name: 'channelSettings', orgId, channelId: channel.id })}>Channel settings</Button> : null}
        {!dm && channel.member ? <Button variant="danger" icon="logout" onClick={leave.ask}>Leave channel</Button> : null}
      </div>
      {leave.dialog}
    </PanelFrame>
  );
}

export function SidePanel({ pane, channel, orgId, variant, who, deeper }: { pane: Pane; channel: Channel; orgId: string; variant: 'pane' | 'screen'; who: Who; deeper: boolean }) {
  const key = useMemo(() => `${pane}:${channel.id}`, [pane, channel.id]);
  if (pane === 'members') return <MembersPanel key={key} channel={channel} orgId={orgId} variant={variant} meId={who.meId} />;
  if (pane === 'pins') return <PinsPanel key={key} channel={channel} orgId={orgId} variant={variant} who={who} deeper={deeper} />;
  return <InfoPanel key={key} channel={channel} orgId={orgId} variant={variant} who={who} />;
}
