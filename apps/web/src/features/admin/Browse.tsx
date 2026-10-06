// Browse (DEK04, DEK05; Fixboard #19): every channel of the team servers you are in, in
// one list with a filter, from one call (browse_channels, 0916). Public channels open or
// join at once; locked (private) ones show their name and size and take a one-tap
// request that the channel owner and the server admins are told about. Team servers you
// are not in follow, with Join or Ask to join.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/rpc';
import type { BrowseChannel, Server } from '../../api/types';
import { channelRoute } from '../../app/router';
import { useRequestsRev } from '../../sync/requests';
import { Icon } from '../../ui/icons';
import { Button, EmptyState, TextField, toast } from '../../ui/kit';
import { isOrgAdmin, refreshShell, useOrg, useServers } from './common/context';
import { JOIN_POLICY, plural } from './common/format';
import { invalidate, useAction, useLoad } from './common/load';
import { go, goBack, linkProps } from './common/nav';
import { cx, Dot, ErrorView, FormError, Gate, List, Loading, Pill, Row, Screen, Section, Single, useNarrowRef } from './common/ui';
import { ServerMark } from './sections/Servers';
import './admin.css';

// How the caller sees a server (server_json "access"): member, partial (only some
// channels: cross-team), or browse (may look in order to join). Older answers
// without the field fall back to the role.
export type ServerAccess = 'member' | 'partial' | 'browse';

export function accessOf(s: Server): ServerAccess {
  const a: unknown = s.access;
  if (a === 'member' || a === 'partial' || a === 'browse') return a;
  return s.my_role ? 'member' : 'browse';
}

function label(c: BrowseChannel): string {
  return `${c.kind === 'audio' ? '' : '#'}${c.name ?? 'channel'}`;
}

export function BrowseScreen({ orgId, serverId }: { orgId: string; serverId: string | null }) {
  const org = useOrg(orgId);
  const [rootRef, phone] = useNarrowRef();
  const servers = useServers(orgId);
  const rev = useRequestsRev();
  const load = useLoad(() => api.browseChannels(orgId).then((r) => r.channels), [orgId, rev], { key: `browse:${orgId}` });
  const [q, setQ] = useState('');
  const onBack = () => goBack({ name: 'org', orgId });

  if (!org.role) {
    return (
      <Screen rootRef={rootRef} narrow={phone} title="Browse channels" backLabel="Back" onBack={onBack}>
        <Single>{org.status === 'error' && org.error ? <ErrorView error={org.error} onRetry={org.retry} what="organization" /> : <Loading label="Loading" />}</Single>
      </Screen>
    );
  }

  return (
    <Screen rootRef={rootRef} narrow={phone} title="Browse channels" subtitle={org.summary?.name} brand={org.summary?.brand_color}
      backLabel="Back" onBack={onBack} className="adm">
      <Single>
        <div className="adm-browse__filter">
          <TextField label="Find a channel" hideLabel placeholder="Find a channel" type="search" value={q}
            onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </div>
        {org.role === 'guest' ? <p className="ap-hint">As a guest you see only the channels people add you to.</p> : null}
        <Gate load={load} what="channel list">
          {(list) => (
            <ChannelSections orgId={orgId} channels={list} servers={servers.data ?? []} query={q} focusServer={serverId}
              onChanged={(id, patch) => load.mutate((prev) => prev?.map((c) => (c.id === id ? { ...c, ...patch } : c)) ?? prev)} />
          )}
        </Gate>
        <OtherServers orgId={orgId} admin={isOrgAdmin(org.role)} guest={org.role === 'guest'} servers={servers} />
      </Single>
    </Screen>
  );
}

function ChannelSections({ orgId, channels, servers, query, focusServer, onChanged }: {
  orgId: string;
  channels: BrowseChannel[];
  servers: Server[];
  query: string;
  focusServer: string | null;
  onChanged: (id: string, patch: Partial<BrowseChannel>) => void;
}) {
  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const order = new Map(servers.map((s, i) => [s.id, i]));
    const byServer = new Map<string, BrowseChannel[]>();
    for (const c of channels) {
      if (needle && !(c.name ?? '').toLowerCase().includes(needle) && !(c.topic ?? '').toLowerCase().includes(needle)) continue;
      const k = c.server_id ?? '';
      byServer.set(k, [...(byServer.get(k) ?? []), c]);
    }
    return [...byServer.entries()].sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999));
  }, [channels, servers, needle]);

  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'start' });
  }, [focusServer]);

  if (!channels.length) {
    return <EmptyState icon="hash" title="No channels to show" body="Join a team server below to see its channels." />;
  }
  if (!groups.length) {
    return <p className="ap-hint" role="status">{`No channel matches "${query.trim()}".`}</p>;
  }
  return (
    <>
      {groups.map(([sid, list]) => {
        const server = servers.find((s) => s.id === sid);
        return (
          <div key={sid} ref={sid === focusServer ? focusRef : undefined}>
            <Section title={server?.name ?? 'Team server'} description={plural(list.length, 'channel', 'channels')}>
              <List label={`Channels in ${server?.name ?? 'this team server'}`}>
                {list.map((c) => <ChannelRow key={c.id} orgId={orgId} channel={c} onChanged={onChanged} />)}
              </List>
            </Section>
          </div>
        );
      })}
    </>
  );
}

function ChannelRow({ orgId, channel: c, onChanged }: { orgId: string; channel: BrowseChannel; onChanged: (id: string, patch: Partial<BrowseChannel>) => void }) {
  const join = useAction(() => api.joinChannel(c.id));
  const ask = useAction(() => api.requestChannelJoin(c.id));
  const cancel = useAction(() => api.withdrawChannelRequest(c.id));
  const open = channelRoute(orgId, c.id);

  const onJoin = async () => {
    const r = await join.run();
    if (!r.ok) return;
    onChanged(c.id, { member: true, member_count: c.member_count + 1 });
    invalidate(`browse:${orgId}`);
    refreshShell();
    toast({ kind: 'success', title: `You joined ${label(c)}`, action: { label: 'Open', onClick: () => go(open) } });
  };
  const onAsk = async () => {
    const r = await ask.run();
    if (!r.ok) return;
    invalidate(`browse:${orgId}`);
    if (r.value.status === 'joined') {
      onChanged(c.id, { member: true, locked: false });
      refreshShell();
      return;
    }
    onChanged(c.id, { requested: true });
    toast({ kind: 'success', title: 'Request sent', body: `The admins of ${label(c)} were told. You get a notification when they let you in.` });
  };
  const onCancel = async () => {
    const r = await cancel.run();
    if (!r.ok) return;
    invalidate(`browse:${orgId}`);
    onChanged(c.id, { requested: false });
  };

  let action: ReactNode;
  if (c.member) action = <a className="dk-btn dk-btn--secondary dk-btn--md" {...linkProps(open)}>Open</a>;
  else if (c.locked && c.requested) action = <><Pill tone="warning">Requested</Pill><Button variant="ghost" onClick={onCancel} loading={cancel.busy}>Cancel</Button></>;
  else if (c.locked) action = <Button icon="lock" onClick={onAsk} loading={ask.busy}>Ask to join</Button>;
  else action = <Button variant="primary" onClick={onJoin} loading={join.busy}>Join</Button>;

  const readable = !c.locked;
  return (
    <Row
      testId={`channel-${c.id}`}
      className={cx('adm-chanrow', c.locked && 'is-locked')}
      leading={<span className="adm-roundicon" aria-hidden="true"><Icon name={c.locked || c.visibility === 'private' ? 'lock' : c.kind === 'audio' ? 'volume' : 'hash'} size={18} /></span>}
      title={(
        <>
          {readable
            ? <a className="adm-chanrow__link" {...linkProps(open)}><span dir="auto">{c.name}</span></a>
            : <span className="adm-chanrow__link" dir="auto">{c.name}</span>}
          {c.locked ? <Pill>Invite only</Pill> : c.visibility === 'private' ? <Pill>Private</Pill> : null}
          {c.posting_policy === 'admins' ? <Pill tone="accent">Announcements</Pill> : null}
          {c.member ? <Pill tone="success">Joined</Pill> : null}
        </>
      )}
      meta={(
        <>
          <span>{plural(c.member_count, 'member', 'members')}</span>
          {c.topic ? <><Dot /><span className="adm-clamp" dir="auto">{c.topic}</span></> : null}
          {c.locked && !c.requested ? <><Dot /><span>Ask, and its admins decide</span></> : null}
        </>
      )}
      trailing={(
        <>
          {action}
          <FormError error={join.error ?? ask.error ?? cancel.error} />
        </>
      )}
    />
  );
}

// Team servers you are not in: join an open one, ask to join an approval one.
function OtherServers({ orgId, admin, guest, servers }: { orgId: string; admin: boolean; guest: boolean; servers: ReturnType<typeof useServers> }) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const join = useAction((s: Server) => api.joinServer(s.id));
  const others = (servers.data ?? []).filter((s) => !s.archived && accessOf(s) === 'browse');
  if (guest || !others.length) return null;

  const onJoin = async (s: Server) => {
    setJoiningId(s.id);
    const r = await join.run(s);
    setJoiningId(null);
    if (!r.ok) return;
    if (r.value.status === 'joined') {
      invalidate(`servers:${orgId}`);
      invalidate(`browse:${orgId}`);
      servers.reload();
      refreshShell();
      toast({ kind: 'success', title: `You joined ${s.name}`, body: 'Its channels are listed above now.' });
    } else {
      setPending((prev) => new Set([...prev, s.id]));
      toast({ kind: 'success', title: 'Request sent', body: `An admin of ${s.name} decides. You will see it in your sidebar once approved.` });
    }
  };

  return (
    <Section title="Other team servers" description="Join one to see all of its channels.">
      <FormError error={join.error} />
      <List label="Other team servers">
        {others.map((s) => {
          let action: ReactNode;
          if (pending.has(s.id)) action = <Pill tone="warning">Request sent</Pill>;
          else if (s.join_policy === 'open' || admin) action = <Button variant="primary" onClick={() => onJoin(s)} loading={joiningId === s.id}>Join</Button>;
          else if (s.join_policy === 'approval') action = <Button onClick={() => onJoin(s)} loading={joiningId === s.id}>Ask to join</Button>;
          else action = <Pill>Invite only</Pill>;
          return (
            <Row key={s.id} testId={`server-${s.id}`} leading={<ServerMark server={s} />}
              title={<span dir="auto">{s.name}</span>}
              meta={<><span>{plural(s.member_count, 'member', 'members')}</span><Dot /><span>{JOIN_POLICY[s.join_policy].label}</span>{s.description ? <><Dot /><span className="adm-clamp" dir="auto">{s.description}</span></> : null}</>}
              trailing={action} />
          );
        })}
      </List>
    </Section>
  );
}
