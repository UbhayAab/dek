// Team server settings (DEK01 to DEK05): name, description, icon and join policy;
// members (add from the organization, roles, removal: moderators cannot remove
// admins); channels with their settings and a new-channel dialog (public, private
// with cross-team people, audio, announcement); archive and leave. Server admins
// change things; moderators remove members; members see a read only view.
import { useState, type ReactNode } from 'react';
import { api } from '../../api/rpc';
import type { Channel, MemberItem, OrgRole, Profile, Server, ServerRole } from '../../api/types';
import { channelRoute } from '../../app/router';
import { Icon } from '../../ui/icons';
import { Avatar, Banner, Button, ConfirmDialog, EmptyState, Menu, Modal, Select, TextArea, TextField, toast, type MenuItem } from '../../ui/kit';
import { isOrgAdmin, refreshShell, useMyId, useOrg, useServers } from './common/context';
import { formatDate, isServerRole, JOIN_POLICY, plural, SERVER_ROLE_HELP, SERVER_ROLE_LABEL } from './common/format';
import { fieldFromHint, invalidate, offsetPage, useAction, useLoad, usePaged } from './common/load';
import { go, goBack, linkProps, pathWithHash, toHref, useHashValue } from './common/nav';
import { PeoplePicker } from './common/PeoplePicker';
import { Card, Dot, ErrorView, FormError, Gate, List, Loading, NavList, PagedView, Pill, RadioGroup, Row, Screen, Section, Single, Split, useDebounced, type NavItem, useNarrowRef } from './common/ui';
import { hasErrors, validateServer } from './common/validation';
import { CreateChannelDialog } from './CreateChannelDialog';
import { serverMemberActions } from './rules';
import { ArchiveServerDialog, ServerMark } from './sections/Servers';
import { InviteDialog } from './sections/InviteDialog';
import { RequestList } from './sections/Requests';
import './admin.css';

type Tab = 'general' | 'members' | 'channels' | 'requests' | 'danger';
const TABS: readonly Tab[] = ['general', 'members', 'channels', 'requests', 'danger'];
const TAB_LABEL: Record<Tab, string> = { general: 'General', members: 'Members', channels: 'Channels', requests: 'Join requests', danger: 'Archive and leave' };

interface Ctx {
  orgId: string;
  orgRole: OrgRole;
  myId: string;
  server: Server;
  admin: boolean;
  mod: boolean;
  replaceServer: (s: Server) => void;
}

export function ServerSettingsScreen({ orgId, serverId }: { orgId: string; serverId: string }) {
  const org = useOrg(orgId);
  const myId = useMyId();
  const [rootRef, phone] = useNarrowRef();
  const servers = useServers(orgId);
  const hash = useHashValue();
  const tab = (TABS as readonly string[]).includes(hash) ? (hash as Tab) : null;
  const current: Tab | null = tab ?? (phone ? null : 'general');
  const server = servers.data?.find((s) => s.id === serverId) ?? null;

  const leave = () => goBack({ name: 'org', orgId });
  const toMenu = () => goBack(pathWithHash(null));
  const inLayer = phone && tab !== null;

  if (!server || !org.role || !myId) {
    const failure = org.status === 'error' ? org.error : servers.status === 'error' ? servers.error : null;
    const missing = servers.data && !server;
    return (
      <Screen rootRef={rootRef} narrow={phone} title="Team server" subtitle={org.summary?.name} backLabel="Back" onBack={leave}>
        <Single>
          {failure ? <ErrorView error={failure} onRetry={() => { org.retry(); servers.reload(); }} what="team server" />
            : missing ? <EmptyState icon="search" title="This team server is not available" body="It does not exist, or you are not in it. Ask one of its admins to add you." action={<Button onClick={() => go({ name: 'browse', orgId, serverId: null })}>Browse team servers</Button>} />
              : <Loading label="Loading team server" />}
        </Single>
      </Screen>
    );
  }

  const admin = isOrgAdmin(org.role) || server.my_role === 'admin';
  const ctx: Ctx = {
    orgId, orgRole: org.role, myId, server, admin,
    mod: admin || server.my_role === 'moderator',
    replaceServer: (s) => servers.mutate((prev) => (prev ? prev.map((x) => (x.id === s.id ? s : x)) : prev)),
  };

  const ICONS: Record<Tab, ReactNode> = {
    general: <Icon name="settings" />, members: <Icon name="users" />, channels: <Icon name="hash" />, requests: <Icon name="userPlus" />, danger: <Icon name="archive" />,
  };
  const DESCRIPTIONS: Record<Tab, string> = {
    general: admin ? 'Name, icon, description, who can join' : 'About this team server',
    members: plural(server.member_count, 'member', 'members'),
    channels: 'Channels and their settings',
    requests: 'People asking to join',
    danger: admin ? 'Archive the server, or leave it' : 'Leave this team server',
  };
  const items: NavItem[] = TABS.filter((t) => (t !== 'danger' || admin || server.my_role) && (t !== 'requests' || admin)).map((t) => ({
    key: t,
    label: TAB_LABEL[t],
    icon: ICONS[t],
    description: DESCRIPTIONS[t],
    href: toHref(pathWithHash(t)),
    onSelect: () => go(pathWithHash(t), 'auto'),
  }));

  let body: ReactNode = null;
  if (current === 'general') body = <GeneralTab ctx={ctx} />;
  else if (current === 'members') body = <MembersTab ctx={ctx} />;
  else if (current === 'channels') body = <ChannelsTab ctx={ctx} />;
  else if (current === 'requests') body = admin ? <RequestsTab ctx={ctx} /> : <EmptyState icon="lock" title="Only server admins decide join requests" />;
  else if (current === 'danger') body = <DangerTab ctx={ctx} />;

  return (
    <Screen
      rootRef={rootRef}
      narrow={phone}
      title={inLayer && tab ? TAB_LABEL[tab] : server.name}
      subtitle={inLayer ? server.name : org.summary?.name}
      brand={org.summary?.brand_color}
      backLabel={inLayer ? `Back to ${server.name}` : 'Back'}
      onBack={inLayer ? toMenu : leave}
      className="adm"
    >
      <Split
        navLabel="Team server settings"
        mode={phone && current === null ? 'nav' : 'content'}
        nav={(
          <>
            {phone ? <Hero server={server} /> : null}
            <NavList items={items} current={current} />
          </>
        )}
      >
        {server.archived ? <Banner tone="warning" icon="archive">This team server is archived. It is read only until an admin unarchives it.</Banner> : null}
        {body}
      </Split>
    </Screen>
  );
}

function Hero({ server }: { server: Server }) {
  return (
    <div className="adm-hero ap-card ap-card--muted adm-hero--menu">
      <ServerMark server={server} size={48} />
      <div className="adm-hero__text">
        <span className="adm-hero__name" dir="auto">{server.name}</span>
        <span className="adm-hero__meta">{JOIN_POLICY[server.join_policy].label}<span aria-hidden="true"> · </span>{plural(server.member_count, 'member', 'members')}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ general

function GeneralTab({ ctx }: { ctx: Ctx }) {
  const s = ctx.server;
  const [name, setName] = useState(s.name);
  const [description, setDescription] = useState(s.description ?? '');
  const [icon, setIcon] = useState(s.icon_emoji ?? '');
  const [policy, setPolicy] = useState<Server['join_policy']>(s.join_policy);
  const [touched, setTouched] = useState(false);
  const errors = validateServer({ name, description, icon_emoji: icon });
  const patch: Partial<{ name: string; description: string; icon_emoji: string; join_policy: Server['join_policy'] }> = {};
  if (name.trim() !== s.name) patch.name = name.trim();
  if (description.trim() !== (s.description ?? '')) patch.description = description.trim();
  if (icon.trim() !== (s.icon_emoji ?? '')) patch.icon_emoji = icon.trim();
  if (policy !== s.join_policy) patch.join_policy = policy;
  const dirty = Object.keys(patch).length > 0;
  const act = useAction(() => api.updateServer(s.id, patch));
  const field = fieldFromHint(act.error, ['name', 'description', 'icon_emoji', 'join_policy']);
  const show = (k: keyof typeof errors): string | null => {
    const local = touched ? errors[k] : undefined;
    if (local) return local;
    return field === k ? act.error?.hint ?? null : null;
  };

  if (!ctx.admin) {
    return (
      <Section title="About this team server" description="Only server admins change these.">
        <Card>
          <div className="adm-hero">
            <ServerMark server={s} size={48} />
            <div className="adm-hero__text">
              <span className="adm-hero__name" dir="auto">{s.name}</span>
              <span className="adm-hero__meta">{s.my_role ? `You are ${SERVER_ROLE_LABEL[s.my_role].toLowerCase()} here` : 'You are in some of its channels'}</span>
            </div>
          </div>
          <dl className="adm-facts">
            <dt>Description</dt><dd dir="auto">{s.description || 'None'}</dd>
            <dt>Who can join</dt><dd>{JOIN_POLICY[s.join_policy].label}: {JOIN_POLICY[s.join_policy].description}</dd>
            <dt>Members</dt><dd>{s.member_count}</dd>
          </dl>
        </Card>
      </Section>
    );
  }

  const submit = async () => {
    setTouched(true);
    if (hasErrors(errors) || !dirty) return;
    const r = await act.run();
    if (!r.ok) return;
    ctx.replaceServer(r.value);
    refreshShell();
    setTouched(false);
    toast({ kind: 'success', title: 'Saved' });
  };

  return (
    <Section title="General" description="What people see in the server list and in Browse.">
      <form className="ap-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <fieldset className="ap-radios" disabled={s.archived}>
          <legend className="sr-only">Server details</legend>
          <div className="ap-form">
            <div className="adm-namegrid">
              <TextField label="Icon" hint="One emoji" value={icon} maxLength={16} error={show('icon_emoji')} onChange={(e) => setIcon(e.target.value)} />
              <TextField label="Name" value={name} maxLength={100} error={show('name')} onChange={(e) => setName(e.target.value)} />
            </div>
            <TextArea label="Description" rows={3} value={description} error={show('description')} onChange={(e) => setDescription(e.target.value)} />
            <RadioGroup
              legend="Who can join"
              value={policy}
              onChange={setPolicy}
              options={(['invite', 'approval', 'open'] as const).map((p) => ({ value: p, label: JOIN_POLICY[p].label, description: JOIN_POLICY[p].description }))}
            />
          </div>
        </fieldset>
        <FormError error={act.error} onRetry={submit} hidden={!!field} />
        <div className="ap-form__actions">
          <Button variant="ghost" disabled={!dirty || act.busy} onClick={() => { setName(s.name); setDescription(s.description ?? ''); setIcon(s.icon_emoji ?? ''); setPolicy(s.join_policy); setTouched(false); act.reset(); }}>Undo changes</Button>
          <Button type="submit" variant="primary" loading={act.busy} disabled={!dirty || s.archived}>Save changes</Button>
        </div>
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------ members

type MemberDialog = { kind: 'role'; m: MemberItem; role: ServerRole } | { kind: 'remove'; m: MemberItem };

function MembersTab({ ctx }: { ctx: Ctx }) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const paged = usePaged<MemberItem, number>(
    async (cursor) => offsetPage(await api.listServerMembers(ctx.server.id, q || null, 50, cursor ?? 0), cursor ?? 0),
    [ctx.server.id, q],
  );
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [dialog, setDialog] = useState<MemberDialog | null>(null);
  const org = useOrg(ctx.orgId);
  const canAdd = ctx.admin && !ctx.server.archived;

  return (
    <Section
      title="Members"
      description={ctx.admin ? 'Add people who are already in the organization, or send an invite link to bring new people into this server.' : ctx.mod ? 'As a moderator you can remove members. Admins stay.' : 'People in this team server.'}
      actions={canAdd ? (
        <>
          <Button icon="share" onClick={() => setInviting(true)}>Invite link</Button>
          <Button variant="primary" icon="userPlus" onClick={() => setAdding(true)}>Add people</Button>
        </>
      ) : null}
    >
      <TextField label="Search" type="search" placeholder="Name or handle" value={query} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
      <p className="ap-hint" aria-live="polite">{paged.total !== null ? plural(paged.total, 'person', 'people') : ''}</p>
      <PagedView paged={paged} what="member list" empty={<EmptyState icon="users" title={q ? 'Nobody matches' : 'Nobody here yet'} />}>
        {(items) => (
          <List label="Server members">
            {items.map((m) => {
              const role: ServerRole = isServerRole(m.role) ? m.role : 'member';
              const acts = serverMemberActions({ id: ctx.myId, serverRole: ctx.server.my_role, orgAdmin: isOrgAdmin(ctx.orgRole) }, { id: m.profile.id, role });
              const menu: MenuItem[] = ctx.server.archived ? [] : [
                ...acts.roles.map((r): MenuItem => ({ label: `Make ${SERVER_ROLE_LABEL[r].toLowerCase()}`, icon: 'shield', onSelect: () => setDialog({ kind: 'role', m, role: r }) })),
                ...(acts.canRemove ? [{ label: 'Remove from server', icon: 'trash', danger: true, onSelect: () => setDialog({ kind: 'remove', m }) } satisfies MenuItem] : []),
              ];
              return (
                <Row
                  key={m.profile.id}
                  leading={<Avatar name={m.profile.display_name} path={m.profile.avatar_path} seed={m.profile.id} size={36} />}
                  title={(
                    <>
                      <span dir="auto">{m.profile.display_name}</span>
                      {m.profile.id === ctx.myId ? <span className="ap-meta">(you)</span> : null}
                      <Pill tone={role === 'member' ? 'neutral' : 'accent'}>{SERVER_ROLE_LABEL[role]}</Pill>
                    </>
                  )}
                  meta={<>{m.profile.handle ? <><span>@{m.profile.handle}</span><Dot /></> : null}<span>Joined {formatDate(m.joined_at)}</span></>}
                  trailing={menu.length ? <Menu label={`Actions for ${m.profile.display_name}`} items={menu} /> : null}
                />
              );
            })}
          </List>
        )}
      </PagedView>
      {inviting ? (
        <InviteDialog
          orgId={ctx.orgId}
          orgName={org.summary?.name ?? ''}
          settings={org.settings}
          servers={[ctx.server]}
          initialServerId={ctx.server.id}
          onClose={() => setInviting(false)}
          onCreated={() => invalidate(`invites:${ctx.orgId}`)}
        />
      ) : null}
      {adding ? (
        <AddServerMembersDialog
          ctx={ctx}
          existing={new Set(paged.items.map((m) => m.profile.id))}
          onClose={() => setAdding(false)}
          onDone={() => { paged.reload(); invalidate(`servers:${ctx.orgId}`); refreshShell(); }}
        />
      ) : null}
      {dialog?.kind === 'role' ? (
        <ServerRoleDialog ctx={ctx} m={dialog.m} role={dialog.role} onClose={() => setDialog(null)}
          onDone={(item) => paged.update((list) => list.map((x) => (x.profile.id === dialog.m.profile.id ? (item ?? { ...x, role: dialog.role }) : x)))} />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <RemoveServerMemberDialog ctx={ctx} m={dialog.m} onClose={() => setDialog(null)}
          onDone={() => { paged.update((list) => list.filter((x) => x.profile.id !== dialog.m.profile.id)); invalidate(`servers:${ctx.orgId}`); }} />
      ) : null}
    </Section>
  );
}

function AddServerMembersDialog({ ctx, existing, onClose, onDone }: { ctx: Ctx; existing: ReadonlySet<string>; onClose: () => void; onDone: () => void }) {
  const [people, setPeople] = useState<Profile[]>([]);
  const [role, setRole] = useState<ServerRole>('member');
  const [touched, setTouched] = useState(false);
  const act = useAction(() => api.addServerMembers(ctx.server.id, people.map((p) => p.id), role));
  const submit = async () => {
    setTouched(true);
    if (!people.length) return;
    const r = await act.run();
    if (!r.ok) return;
    const res = (r.value ?? {}) as { added?: string[]; already_members?: string[] };
    const added = res.added?.length ?? people.length;
    const already = res.already_members?.length ?? 0;
    toast({ kind: 'success', title: `Added ${plural(added, 'person', 'people')} to ${ctx.server.name}`, body: already ? `${plural(already, 'person was', 'people were')} already in it.` : 'They also joined its automatic channels.' });
    onDone();
    onClose();
  };
  return (
    <Modal open size="md" title={`Add people to ${ctx.server.name}`} onClose={onClose} dismissable={!act.busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={act.busy}>{people.length ? `Add ${plural(people.length, 'person', 'people')}` : 'Add people'}</Button>
        </>
      )}>
      <div className="ap-form">
        <PeoplePicker orgId={ctx.orgId} selected={people} onChange={setPeople} label="People" excludeGuests excludeIds={existing} max={100}
          hint="Guests cannot join team servers; add them to single channels instead." />
        {touched && !people.length ? <p className="ap-error-text" role="alert">Choose at least one person.</p> : null}
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as ServerRole)} hint={SERVER_ROLE_HELP[role]}
          options={(['member', 'moderator', 'admin'] as ServerRole[]).map((r) => ({ value: r, label: SERVER_ROLE_LABEL[r] }))} />
        <FormError error={act.error} onRetry={submit} />
      </div>
    </Modal>
  );
}

function ServerRoleDialog({ ctx, m, role, onClose, onDone }: { ctx: Ctx; m: MemberItem; role: ServerRole; onClose: () => void; onDone: (item: MemberItem | null) => void }) {
  const act = useAction(() => api.setServerRole(ctx.server.id, m.profile.id, role));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    const v = r.value as MemberItem | null;
    onDone(v && typeof v === 'object' && 'profile' in v ? v : null);
    toast({ kind: 'success', title: `${m.profile.display_name} is now ${SERVER_ROLE_LABEL[role].toLowerCase()}` });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={`Make ${m.profile.display_name} ${SERVER_ROLE_LABEL[role].toLowerCase()}?`}
      body={<div className="ap-form"><p>{SERVER_ROLE_HELP[role]}</p><FormError error={act.error} onRetry={confirm} /></div>}
      confirmLabel={`Make ${SERVER_ROLE_LABEL[role].toLowerCase()}`}
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

function RemoveServerMemberDialog({ ctx, m, onClose, onDone }: { ctx: Ctx; m: MemberItem; onClose: () => void; onDone: () => void }) {
  const act = useAction(() => api.removeServerMember(ctx.server.id, m.profile.id));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    onDone();
    toast({ kind: 'success', title: `${m.profile.display_name} was removed from ${ctx.server.name}` });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={`Remove ${m.profile.display_name} from ${ctx.server.name}?`}
      body={(
        <div className="ap-form">
          <p>They lose every channel of this server at once, private ones included, and stop getting its notifications. They stay in the organization and keep their other servers.</p>
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel="Remove"
      danger
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

// ------------------------------------------------------------------ channels

function ChannelsTab({ ctx }: { ctx: Ctx }) {
  const load = useLoad(() => api.listChannels(ctx.server.id), [ctx.server.id], { key: `channels:${ctx.server.id}` });
  const org = useOrg(ctx.orgId);
  const [creating, setCreating] = useState(false);
  const canCreate = !ctx.server.archived && (ctx.admin || (ctx.server.my_role !== null && ctx.orgRole !== 'guest' && org.settings.member_can_create_channels));
  return (
    <Section
      title="Channels"
      description={ctx.admin ? 'Public channels and the private channels you are in. Private channels you are not in stay hidden, even from admins.' : 'Public channels of this server and the private ones you are in.'}
      actions={canCreate ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New channel</Button> : null}
    >
      <Gate load={load} what="channel list" isEmpty={(d) => d.length === 0} empty={<EmptyState icon="hash" title="No channels yet" body={canCreate ? 'Create the first one.' : undefined} />}>
        {(list) => (
          <List label="Channels">
            {list.map((c) => (
              <Row
                key={c.id}
                muted={c.archived}
                leading={<span className="adm-roundicon" aria-hidden="true"><Icon name={c.kind === 'audio' ? 'volume' : c.visibility === 'private' ? 'lock' : c.posting_policy === 'admins' ? 'megaphone' : 'hash'} size={18} /></span>}
                title={(
                  <>
                    <span dir="auto">{c.name}</span>
                    {c.visibility === 'private' ? <Pill>Private</Pill> : null}
                    {c.kind === 'audio' ? <Pill>Audio</Pill> : null}
                    {c.posting_policy === 'admins' ? <Pill tone="accent">Announcements</Pill> : null}
                    {c.auto_join ? <Pill>Everyone joins</Pill> : null}
                    {c.archived ? <Pill tone="warning">Archived</Pill> : null}
                  </>
                )}
                meta={<><span>{plural(c.member_count, 'member', 'members')}</span>{c.member ? <><Dot /><span>Joined</span></> : null}{c.topic ? <><Dot /><span dir="auto">{c.topic}</span></> : null}</>}
                trailing={(
                  <>
                    {c.member ? <a className="dk-btn dk-btn--ghost dk-btn--md" {...linkProps(channelRoute(ctx.orgId, c.id))}>Open</a> : null}
                    <a className="dk-btn dk-btn--secondary dk-btn--md" {...linkProps({ name: 'channelSettings', orgId: ctx.orgId, channelId: c.id })}>Settings</a>
                  </>
                )}
              />
            ))}
          </List>
        )}
      </Gate>
      {creating ? (
        <CreateChannelDialog
          orgId={ctx.orgId}
          server={ctx.server}
          serverAdmin={ctx.admin}
          onClose={() => setCreating(false)}
          onCreated={(c: Channel) => {
            load.mutate((prev) => (prev ? [...prev, c] : [c]));
            refreshShell();
            toast({ kind: 'success', title: `Created ${c.kind === 'audio' ? c.name : `#${c.name}`}`, action: { label: 'Open', onClick: () => go(channelRoute(ctx.orgId, c.id)) } });
          }}
        />
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------------ join requests

function RequestsTab({ ctx }: { ctx: Ctx }) {
  const org = useOrg(ctx.orgId);
  const load = useLoad(() => api.listJoinRequests(ctx.orgId, 'pending'), [ctx.orgId], { key: `jr:${ctx.orgId}:pending` });
  const mine = (load.data?.items ?? []).filter((r) => r.server_id === ctx.server.id);
  return (
    <Section
      title="Join requests"
      description={ctx.server.join_policy === 'approval'
        ? 'Members ask to join this server from Browse; invite links can need approval too. Approving adds them at once.'
        : 'Invite links that need approval send their requests here.'}
    >
      <Gate load={load} what="request list">
        {() => (mine.length === 0
          ? <EmptyState icon="userPlus" title="Nobody is waiting" body={`Requests to join ${ctx.server.name} appear here.`} />
          : (
            <RequestList
              items={mine}
              orgName={org.summary?.name ?? ''}
              serverName={() => ctx.server.name}
              onSettled={(r) => {
                load.mutate((prev) => (prev ? { items: prev.items.filter((x) => x.id !== r.id) } : prev));
                invalidate(`jr:${ctx.orgId}:`);
                invalidate(`servers:${ctx.orgId}`);
              }}
              onStale={load.reload}
            />
          ))}
      </Gate>
    </Section>
  );
}

// ------------------------------------------------------------------ archive, leave

function DangerTab({ ctx }: { ctx: Ctx }) {
  const [archiving, setArchiving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const unarchive = useAction(() => api.archiveServer(ctx.server.id, false));
  const leave = useAction(() => api.leaveServer(ctx.server.id));
  const onUnarchive = async () => {
    const r = await unarchive.run();
    if (!r.ok) return;
    ctx.replaceServer(r.value);
    refreshShell();
    toast({ kind: 'success', title: `${ctx.server.name} is active again` });
  };
  const onLeave = async () => {
    const r = await leave.run();
    if (!r.ok) return;
    invalidate(`servers:${ctx.orgId}`);
    refreshShell();
    toast({ kind: 'success', title: `You left ${ctx.server.name}` });
    setLeaving(false);
    go({ name: 'org', orgId: ctx.orgId }, 'replace');
  };
  return (
    <>
      {ctx.admin ? (
        <Section title={ctx.server.archived ? 'Unarchive' : 'Archive'}>
          <Card tone={ctx.server.archived ? undefined : 'danger'}>
            <p className="ap-card__text">
              {ctx.server.archived
                ? 'Unarchiving makes the server and its channels writable again. Invite links to it start working again if they have not expired.'
                : 'Archiving makes the whole server read only: nobody can post, join or be added, and its invite links stop working. Nothing is deleted.'}
            </p>
            <FormError error={unarchive.error} onRetry={onUnarchive} />
            <div className="ap-form__actions ap-form__actions--start">
              {ctx.server.archived
                ? <Button variant="primary" onClick={onUnarchive} loading={unarchive.busy}>Unarchive server</Button>
                : <Button variant="danger" icon="archive" onClick={() => setArchiving(true)}>Archive server</Button>}
            </div>
          </Card>
        </Section>
      ) : null}
      {ctx.server.my_role ? (
        <Section title="Leave">
          <Card>
            <p className="ap-card__text">You leave this team server and every channel in it, private ones included. To come back you need an invite{ctx.server.join_policy === 'open' ? ', or join it again from Browse' : ''}.</p>
            <div className="ap-form__actions ap-form__actions--start">
              <Button variant="danger" icon="logout" onClick={() => setLeaving(true)}>Leave {ctx.server.name}</Button>
            </div>
          </Card>
        </Section>
      ) : null}
      {archiving ? <ArchiveServerDialog server={ctx.server} onClose={() => setArchiving(false)} onDone={(s) => { ctx.replaceServer(s); refreshShell(); }} /> : null}
      {leaving ? (
        <ConfirmDialog
          open
          title={`Leave ${ctx.server.name}?`}
          body={<div className="ap-form"><p>You stop seeing its channels and getting its notifications right away.</p><FormError error={leave.error} onRetry={onLeave} /></div>}
          confirmLabel="Leave server"
          danger
          busy={leave.busy}
          onConfirm={onLeave}
          onCancel={() => setLeaving(false)}
        />
      ) : null}
    </>
  );
}

