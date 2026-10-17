// Browse (DEK04, DEK05; Fixboard #19/#53): all active servers in the organization and
// every channel of the team servers you are in, in
// one list with a filter, from one call (browse_channels, 0916). Public channels open or
// join at once; locked (private) ones show their name and size and take a one-tap
// request that the channel owner and the server admins are told about. Team servers you
// are not in follow, with Join or Ask to join.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/rpc';
import type { BrowseChannel, Server } from '../../api/types';
import { channelRoute } from '../../app/router';
import { useRequestsRev } from '../../sync/requests';
import { useDek } from '../../store';
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
  const [focusRev, setFocusRev] = useState(0);
  const shellServers = useDek((s) => s.servers);
  const lastShellServers = useRef(shellServers);
  useEffect(() => {
    if (lastShellServers.current === shellServers) return;
    lastShellServers.current = shellServers;
    servers.reload();
    load.reload();
  }, [shellServers, servers.reload, load.reload]);
  useEffect(() => {
    setQ('');
    if (!serverId) rootRef.current?.querySelector('.ap-single')?.scrollTo?.({ top: 0 });
  }, [serverId, rootRef]);
  const onView = (id: string) => {
    setQ('');
    setFocusRev((n) => n + 1);
    go({ name: 'browse', orgId, serverId: id });
  };
  const onBack = () => goBack({ name: 'org', orgId });

  if (!org.role) {
    return (
      <Screen rootRef={rootRef} narrow={phone} title="Browse" backLabel="Back" onBack={onBack}>
        <Single>{org.status === 'error' && org.error ? <ErrorView error={org.error} onRetry={org.retry} what="organization" /> : <Loading label="Loading" />}</Single>
      </Screen>
    );
  }

  return (
    <Screen rootRef={rootRef} narrow={phone} title="Browse" subtitle={org.summary?.name} brand={org.summary?.brand_color}
      backLabel="Back" onBack={onBack} className="adm">
      <Single>
        <ServerDirectory orgId={orgId} admin={isOrgAdmin(org.role)} guest={org.role === 'guest'} servers={servers}
          onJoined={load.reload} onView={onView} onRefresh={() => { servers.reload(); load.reload(); }} />
        <div className="adm-browse__filter">
          <TextField label="Find a channel" hideLabel placeholder="Find a channel" type="search" value={q}
            onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </div>
        {org.role === 'guest' ? <p className="ap-hint">As a guest you see only the channels people add you to.</p> : null}
        <Gate load={load} what="channel list">
          {(list) => (
            <ChannelSections orgId={orgId} channels={list} servers={servers.data ?? []} query={q} focusServer={serverId} focusRev={focusRev}
              onChanged={(id, patch) => load.mutate((prev) => prev?.map((c) => (c.id === id ? { ...c, ...patch } : c)) ?? prev)} />
          )}
        </Gate>
      </Single>
    </Screen>
  );
}

function ChannelSections({ orgId, channels, servers, query, focusServer, focusRev, onChanged }: {
  orgId: string;
  channels: BrowseChannel[];
  servers: Server[];
  query: string;
  focusServer: string | null;
  focusRev: number;
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
  const pendingFocus = useRef(!!focusServer);
  useEffect(() => {
    pendingFocus.current = !!focusServer;
  }, [focusServer, focusRev]);
  useEffect(() => {
    if (pendingFocus.current && focusRef.current) {
      focusRef.current.scrollIntoView({ block: 'start' });
      pendingFocus.current = false;
    }
  }, [focusServer, focusRev, groups]);

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

// Listing a server does not reveal its channels or make the caller a member.
function ServerDirectory({ orgId, admin, guest, servers, onJoined, onView, onRefresh }: {
  orgId: string; admin: boolean; guest: boolean; servers: ReturnType<typeof useServers>;
  onJoined: () => void; onView: (id: string) => void; onRefresh: () => void;
}) {
  const [query, setQuery] = useState('');
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const join = useAction((s: Server) => api.joinServer(s.id));
  const active = (servers.data ?? []).filter((s) => !s.archived);
  const needle = query.trim().toLowerCase();
  const listed = active.filter((s) => !needle || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(needle));
  if (guest) return null;

  const onJoin = async (s: Server) => {
    setJoiningId(s.id);
    const r = await join.run(s);
    setJoiningId(null);
    if (!r.ok) return;
    if (r.value.status === 'joined') {
      invalidate(`servers:${orgId}`);
      invalidate(`browse:${orgId}`);
      servers.reload();
      onJoined();
      refreshShell();
      toast({ kind: 'success', title: `You joined ${s.name}`, body: 'Its channels are listed below now.' });
    } else {
      servers.mutate((prev) => prev?.map((server) => server.id === s.id ? { ...server, requested: true } : server) ?? prev);
      invalidate(`servers:${orgId}`);
      servers.reload();
      toast({ kind: 'success', title: 'Request sent', body: `An admin of ${s.name} decides. You will see it in your sidebar once approved.` });
    }
  };

  return (
    <Section title="Team servers" description="All active servers in this organization. Joining is required to see their channels.">
      <TextField label="Find a server" placeholder="Find a server" type="search" value={query}
        onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      <Button variant="ghost" icon="refresh" onClick={onRefresh} loading={servers.refreshing}>Refresh servers</Button>
      <FormError error={join.error} />
      <Gate load={servers} what="server list">
        {() => !active.length ? <EmptyState icon="hash" title="No active team servers" body="An organization admin can create one." />
          : !listed.length ? <p className="ap-hint" role="status">No server matches your search.</p>
          : <List label="Team servers">
        {listed.map((s) => {
          const access = accessOf(s);
          let action: ReactNode;
          if (access === 'member') action = <Button onClick={() => onView(s.id)}>View channels</Button>;
          else if (s.requested) action = <Pill tone="warning">Request sent</Pill>;
          else if (s.join_policy === 'open' || admin) action = <Button variant="primary" onClick={() => onJoin(s)} loading={joiningId === s.id}>Join</Button>;
          else if (s.join_policy === 'approval') action = <Button onClick={() => onJoin(s)} loading={joiningId === s.id}>Ask to join</Button>;
          else action = <Pill>Invite only</Pill>;
          if (access === 'partial') action = <><Button onClick={() => onView(s.id)}>View channels</Button>{action}</>;
          return (
            <Row key={s.id} testId={`server-${s.id}`} leading={<ServerMark server={s} />}
              title={<><span dir="auto">{s.name}</span>{access === 'member' ? <Pill tone="success">Joined</Pill>
                : access === 'partial' ? <Pill>Selected channels</Pill> : null}</>}
              meta={<><span>{plural(s.member_count, 'member', 'members')}</span><Dot /><span>{JOIN_POLICY[s.join_policy].label}</span>{s.description ? <><Dot /><span className="adm-clamp" dir="auto">{s.description}</span></> : null}</>}
              trailing={action} />
          );
        })}
      </List>}
      </Gate>
    </Section>
  );
}
