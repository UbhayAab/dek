// Browse (DEK04, DEK05): the organization's team servers with join (open servers
// join at once, approval servers file a request), and a server's public channels
// with join and open. On phones the server list and a server's channels are two
// layers; on desktop they sit side by side.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/rpc';
import type { Channel, Server } from '../../api/types';
import { channelRoute } from '../../app/router';
import { Icon } from '../../ui/icons';
import { Button, EmptyState, IconButton, toast } from '../../ui/kit';
import { isOrgAdmin, refreshShell, useOrg, useServers } from './common/context';
import { JOIN_POLICY, plural, SERVER_ROLE_LABEL } from './common/format';
import { invalidate, useAction, useLoad } from './common/load';
import { go, goBack, linkProps } from './common/nav';
import { cx, Dot, ErrorView, FormError, Gate, List, Loading, Pill, Row, Screen, Section, Single, Split, useNarrowRef } from './common/ui';
import { channelIcon } from './CreateChannelDialog';
import { ServerMark } from './sections/Servers';
import './admin.css';

export function BrowseScreen({ orgId, serverId }: { orgId: string; serverId: string | null }) {
  const org = useOrg(orgId);
  const [rootRef, phone] = useNarrowRef();
  const servers = useServers(orgId);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const selected = serverId ? servers.data?.find((s) => s.id === serverId) ?? null : null;
  const orgName = org.summary?.name ?? '';
  const inServer = phone && serverId !== null;

  // Side by side there is room for channels at once: open the first team server.
  const firstId = servers.data?.find((s) => !s.archived && s.my_role !== null)?.id ?? servers.data?.find((s) => !s.archived)?.id ?? null;
  useEffect(() => {
    if (!phone && serverId === null && firstId) go({ name: 'browse', orgId, serverId: firstId }, 'replace');
  }, [phone, serverId, firstId, orgId]);

  const onBack = inServer ? () => goBack({ name: 'browse', orgId, serverId: null }) : () => goBack({ name: 'org', orgId });
  const title = inServer ? selected?.name ?? 'Team server' : 'Browse';

  if (!org.role) {
    return (
      <Screen rootRef={rootRef} narrow={phone} title="Browse" backLabel="Back" onBack={onBack}>
        <Single>{org.status === 'error' && org.error ? <ErrorView error={org.error} onRetry={org.retry} what="organization" /> : <Loading label="Loading" />}</Single>
      </Screen>
    );
  }

  const serverList = (
    <ServerList
      orgId={orgId}
      admin={isOrgAdmin(org.role)}
      guest={org.role === 'guest'}
      servers={servers}
      selectedId={serverId}
      pending={pending}
      onPending={(id) => setPending((prev) => new Set([...prev, id]))}
    />
  );

  return (
    <Screen rootRef={rootRef} narrow={phone} title={title} subtitle={inServer ? orgName : `Team servers and channels in ${orgName}`} brand={org.summary?.brand_color}
      backLabel={inServer ? 'Back to all team servers' : 'Back'} onBack={onBack} className="adm">
      <Split navLabel="Team servers" className="adm-browse-split" mode={phone && serverId === null ? 'nav' : 'content'} nav={serverList}>
        {serverId === null ? (
          <EmptyState icon="hash" title="Pick a team server" body="Its public channels show here, ready to join." />
        ) : servers.data && !selected ? (
          <EmptyState icon="search" title="This team server is not available" body="It does not exist, or it is invite only. Ask one of its admins to add you." />
        ) : selected ? (
          <ChannelList key={selected.id} orgId={orgId} server={selected} />
        ) : servers.status === 'error' && servers.error ? (
          <ErrorView error={servers.error} onRetry={servers.reload} what="team server" />
        ) : <Loading />}
      </Split>
    </Screen>
  );
}

function ServerList({ orgId, admin, guest, servers, selectedId, pending, onPending }: {
  orgId: string;
  admin: boolean;
  guest: boolean;
  servers: ReturnType<typeof useServers>;
  selectedId: string | null;
  pending: ReadonlySet<string>;
  onPending: (id: string) => void;
}) {
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const join = useAction((s: Server) => api.joinServer(s.id));
  const onJoin = async (s: Server) => {
    setJoiningId(s.id);
    const r = await join.run(s);
    setJoiningId(null);
    if (!r.ok) return;
    if (r.value.status === 'joined') {
      invalidate(`servers:${orgId}`);
      servers.reload();
      refreshShell();
      toast({ kind: 'success', title: `You joined ${s.name}`, body: 'Its automatic channels are in your sidebar now.' });
      go({ name: 'browse', orgId, serverId: s.id }, 'auto');
    } else {
      onPending(s.id);
      toast({ kind: 'success', title: 'Request sent', body: `An admin of ${s.name} decides. You will see it in your sidebar once approved.` });
    }
  };

  return (
    <div className="adm-browse">
      {guest ? <p className="ap-hint adm-browse__note">As a guest you see only the channels people add you to.</p> : null}
      <FormError error={join.error} onRetry={() => undefined} />
      <Gate load={servers} what="server list" isEmpty={(d) => d.filter((s) => !s.archived).length === 0}
        empty={<EmptyState icon="users" title="No team servers to show" body={admin ? 'Create one in Admin, Team servers.' : 'Ask an admin to add you to your team server.'} />}>
        {(list) => {
          const live = list.filter((s) => !s.archived);
          const mine = live.filter((s) => s.my_role !== null);
          const others = live.filter((s) => s.my_role === null);
          const row = (s: Server) => {
            const isPending = pending.has(s.id);
            let action: ReactNode = null;
            if (s.my_role === null && !guest) {
              if (isPending) action = <Pill tone="warning">Request sent</Pill>;
              else if (s.join_policy === 'open' || admin) action = <Button variant="primary" onClick={() => onJoin(s)} loading={joiningId === s.id}>Join</Button>;
              else if (s.join_policy === 'approval') action = <Button onClick={() => onJoin(s)} loading={joiningId === s.id}>Ask to join</Button>;
              else action = <Pill>Invite only</Pill>;
            }
            return (
              <Row
                key={s.id}
                testId={`server-${s.id}`}
                className={cx('adm-browse__row', selectedId === s.id && 'is-selected')}
                leading={<ServerMark server={s} />}
                title={(
                  <a className="adm-browse__link" {...linkProps({ name: 'browse', orgId, serverId: s.id }, 'auto')} aria-current={selectedId === s.id ? 'page' : undefined}>
                    <span dir="auto">{s.name}</span>
                  </a>
                )}
                meta={(
                  <>
                    <span>{plural(s.member_count, 'member', 'members')}</span>
                    <Dot />
                    <span>{s.my_role ? SERVER_ROLE_LABEL[s.my_role] : JOIN_POLICY[s.join_policy].label}</span>
                    {s.description ? <><Dot /><span className="adm-clamp" dir="auto">{s.description}</span></> : null}
                  </>
                )}
                trailing={action}
              />
            );
          };
          return (
            <>
              {mine.length ? (
                <>
                  <h2 className="adm-subhead">Your team servers</h2>
                  <List label="Your team servers">{mine.map(row)}</List>
                </>
              ) : null}
              {others.length ? (
                <>
                  <h2 className="adm-subhead">Other team servers</h2>
                  <List label="Other team servers">{others.map(row)}</List>
                </>
              ) : null}
            </>
          );
        }}
      </Gate>
    </div>
  );
}

function ChannelList({ orgId, server }: { orgId: string; server: Server }) {
  const load = useLoad(() => api.listChannels(server.id), [server.id], { key: `channels:${server.id}` });
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const join = useAction((c: Channel) => api.joinChannel(c.id));
  const onJoin = async (c: Channel) => {
    setJoiningId(c.id);
    const r = await join.run(c);
    setJoiningId(null);
    if (!r.ok) return;
    load.mutate((prev) => (prev ? prev.map((x) => (x.id === c.id ? { ...x, ...r.value } : x)) : prev));
    refreshShell();
    toast({ kind: 'success', title: `You joined ${c.kind === 'audio' ? c.name : `#${c.name}`}`, action: { label: 'Open', onClick: () => go(channelRoute(orgId, c.id)) } });
  };
  const member = server.my_role !== null;
  return (
    <Section
      title={`Channels in ${server.name}`}
      description={member ? 'Public channels of this server and the private ones you are in.' : 'You are not in this server. You see the channels you were added to.'}
    >
      <FormError error={join.error} />
      <Gate
        load={load}
        what="channel list"
        isEmpty={(d) => d.length === 0}
        empty={<EmptyState icon="hash" title={member ? 'No channels yet' : `Join ${server.name} to see its channels`} body={member ? undefined : 'Its public channels appear once you are in.'} />}
      >
        {(list) => (
          <List label={`Channels in ${server.name}`}>
            {list.map((c) => (
              <Row
                key={c.id}
                testId={`channel-${c.id}`}
                muted={c.archived}
                leading={<span className="adm-roundicon" aria-hidden="true"><Icon name={channelIcon(c)} size={18} /></span>}
                title={(
                  <>
                    <span dir="auto">{c.name}</span>
                    {c.visibility === 'private' ? <Pill>Private</Pill> : null}
                    {c.posting_policy === 'admins' ? <Pill tone="accent">Announcements</Pill> : null}
                    {c.archived ? <Pill tone="warning">Archived</Pill> : null}
                    {c.member ? <Pill tone="success">Joined</Pill> : null}
                  </>
                )}
                meta={<><span>{plural(c.member_count, 'member', 'members')}</span>{c.topic ? <><Dot /><span dir="auto">{c.topic}</span></> : null}</>}
                trailing={(
                  <>
                    <IconButton icon="info" label={`About ${c.name ?? 'this channel'}`} onClick={() => go({ name: 'channelSettings', orgId, channelId: c.id })} />
                    {c.member ? (
                      <a className="dk-btn dk-btn--secondary dk-btn--md" {...linkProps(channelRoute(orgId, c.id))}>Open</a>
                    ) : c.visibility === 'public' && !c.archived ? (
                      <Button variant="primary" onClick={() => onJoin(c)} loading={joiningId === c.id}>Join</Button>
                    ) : null}
                  </>
                )}
              />
            ))}
          </List>
        )}
      </Gate>
    </Section>
  );
}
