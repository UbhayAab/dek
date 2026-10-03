// Channel settings (DEK02, DEK03, DEK05, DEK14): name, topic, description,
// category, announcement posting, replies, reactions, auto join, public to private;
// members (cross-team people included); this channel's notifications; archive,
// unarchive, join and leave. The channel owner and server admins edit; members see
// a read only view of the same facts.
import { useState, type ReactNode } from 'react';
import { DekError } from '../../api/errors';
import { api } from '../../api/rpc';
import type { Channel, MemberItem, NotifyLevel, OrgRole, Profile, Server } from '../../api/types';
import { channelRoute } from '../../app/router';
import { setState, useDek } from '../../store';
import { Icon } from '../../ui/icons';
import { Avatar, Banner, Button, ConfirmDialog, EmptyState, Menu, Modal, Select, Switch, TextArea, TextField, toast, type MenuItem } from '../../ui/kit';
import { isOrgAdmin, refreshShell, useMyId, useOrg, useServers } from './common/context';
import { formatDate, formatDateTime, plural } from './common/format';
import { fieldFromHint, invalidate, offsetPage, useAction, useLoad, usePaged } from './common/load';
import { go, goBack, pathWithHash, toHref, useHashValue } from './common/nav';
import { PeoplePicker } from './common/PeoplePicker';
import { Card, Dot, ErrorView, FormError, List, Loading, NavList, PagedView, Pill, RadioGroup, Row, Screen, Section, Single, Split, useDebounced, type NavItem, useNarrowRef } from './common/ui';
import { clean, hasErrors, validateChannel } from './common/validation';
import { channelIcon } from './CreateChannelDialog';
import { channelPowers, type ChannelPowers } from './rules';
import './admin.css';

type Tab = 'about' | 'members' | 'notifications' | 'danger';
const TABS: readonly Tab[] = ['about', 'members', 'notifications', 'danger'];
const TAB_LABEL: Record<Tab, string> = { about: 'About', members: 'Members', notifications: 'Notifications', danger: 'Archive and leave' };

// The channel in its per-caller shape. The store has the ones in the sidebar; a
// channel opened from elsewhere (an admin managing a channel they are not in) is
// found through its team server.
// Server admins (and org admins) ask for every channel of a server they manage, so a
// private channel they administer without being in it opens here too.
async function findChannel(orgId: string, channelId: string, hintServer: string | null, orgAdmin: boolean): Promise<Channel> {
  const servers = await api.listServers(orgId);
  const ordered = hintServer ? [...servers.filter((s) => s.id === hintServer), ...servers.filter((s) => s.id !== hintServer)] : servers;
  for (const s of ordered) {
    let list: Channel[] = [];
    try {
      list = await api.listChannels(s.id, orgAdmin || s.my_role === 'admin');
    } catch (e) {
      if (e instanceof DekError && e.retryable) throw e;
    }
    const c = list.find((x) => x.id === channelId);
    if (c) return c;
  }
  throw new DekError('not_found', 'This channel does not exist, or you do not have access to it.');
}

function patchStoreChannel(c: Channel): void {
  setState((s) => (s.channels[c.id] ? { channels: { ...s.channels, [c.id]: { ...s.channels[c.id]!, ...c } } } : {}));
}

interface Ctx {
  orgId: string;
  orgRole: OrgRole;
  myId: string;
  channel: Channel;
  server: Server | null;
  powers: ChannelPowers;
  replace: (c: Channel) => void;
}

export function ChannelSettingsScreen({ orgId, channelId }: { orgId: string; channelId: string }) {
  const org = useOrg(orgId);
  const myId = useMyId();
  const [rootRef, phone] = useNarrowRef();
  const hash = useHashValue();
  const storeChannel = useDek((s) => s.channels[channelId] ?? null);
  const isDm = !!storeChannel && (storeChannel.kind === 'dm' || storeChannel.kind === 'group_dm');
  const orgAdmin = isOrgAdmin(org.role);
  const load = useLoad(
    () => findChannel(orgId, channelId, storeChannel?.server_id ?? null, orgAdmin),
    [orgId, channelId, orgAdmin],
    { key: `channel:${channelId}`, enabled: !isDm && org.role !== null },
  );
  const servers = useServers(orgId);
  const channel = load.data ?? (storeChannel && !isDm ? storeChannel : null);
  const server = channel?.server_id ? servers.data?.find((s) => s.id === channel.server_id) ?? null : null;

  const tab = (TABS as readonly string[]).includes(hash) ? (hash as Tab) : null;
  const current: Tab | null = tab ?? (phone ? null : 'about');
  const inLayer = phone && tab !== null;
  const toChannel = () => goBack(channelRoute(orgId, channelId));
  const toMenu = () => goBack(pathWithHash(null));

  if (isDm) {
    return (
      <Screen rootRef={rootRef} narrow={phone} title="Conversation" backLabel="Back to the conversation" onBack={toChannel}>
        <Single>
          <EmptyState icon="message" title="Direct messages have no settings" body="Only team channels have a topic, members to manage and archiving. You can hide this conversation from the sidebar instead." />
        </Single>
      </Screen>
    );
  }

  if (!channel || !org.role || !myId) {
    const failure = org.status === 'error' ? org.error : load.status === 'error' ? load.error : null;
    return (
      <Screen rootRef={rootRef} narrow={phone} title="Channel settings" subtitle={org.summary?.name} backLabel="Back" onBack={toChannel}>
        <Single>
          {failure ? <ErrorView error={failure} onRetry={() => { org.retry(); load.reload(); }} what="channel" action={<Button onClick={() => go({ name: 'org', orgId }, 'replace')}>Go to {org.summary?.name ?? 'Dek'}</Button>} />
            : <Loading label="Loading channel" />}
        </Single>
      </Screen>
    );
  }

  const powers = channelPowers({
    channelRole: channel.my_role,
    member: channel.member,
    visibility: channel.visibility,
    serverRole: server?.my_role ?? null,
    orgAdmin: isOrgAdmin(org.role),
    archived: channel.archived,
  });
  const ctx: Ctx = {
    orgId, orgRole: org.role, myId, channel, server, powers,
    replace: (c) => {
      load.mutate(() => c);
      patchStoreChannel(c);
      invalidate(`channels:${c.server_id ?? ''}`);
    },
  };
  const title = `${channel.kind === 'audio' ? '' : '#'}${channel.name ?? 'channel'}`;

  const items: NavItem[] = TABS.filter((t) => t !== 'notifications' || channel.member).map((t) => ({
    key: t,
    label: TAB_LABEL[t],
    icon: t === 'about' ? <Icon name="info" /> : t === 'members' ? <Icon name="users" /> : t === 'notifications' ? <Icon name="bell" /> : <Icon name="archive" />,
    description: t === 'about' ? (powers.canManage ? 'Name, topic, posting and replies' : 'What this channel is for')
      : t === 'members' ? plural(channel.member_count, 'member', 'members')
        : t === 'notifications' ? 'When this channel alerts you'
          : powers.canManage ? 'Archive, or leave the channel' : channel.member ? 'Leave the channel' : 'Join the channel',
    href: toHref(pathWithHash(t)),
    onSelect: () => go(pathWithHash(t), 'auto'),
  }));

  let body: ReactNode = null;
  if (current === 'about') body = <AboutTab key={channel.id} ctx={ctx} />;
  else if (current === 'members') body = <MembersTab ctx={ctx} />;
  else if (current === 'notifications') body = channel.member ? <NotifyTab ctx={ctx} /> : <EmptyState icon="bell" title="Join the channel first" body="Notification settings are for channels you are in." />;
  else if (current === 'danger') body = <DangerTab ctx={ctx} />;

  return (
    <Screen
      rootRef={rootRef}
      narrow={phone}
      title={inLayer && tab ? TAB_LABEL[tab] : title}
      subtitle={inLayer ? title : server?.name ?? org.summary?.name}
      brand={org.summary?.brand_color}
      backLabel={inLayer ? `Back to ${title} settings` : 'Back to the channel'}
      onBack={inLayer ? toMenu : toChannel}
      className="adm"
    >
      <Split
        navLabel="Channel settings"
        mode={phone && current === null ? 'nav' : 'content'}
        nav={(
          <>
            {phone ? (
              <div className="adm-hero ap-card ap-card--muted adm-hero--menu">
                <span className="adm-roundicon" aria-hidden="true"><Icon name={channelIcon(channel)} size={20} /></span>
                <div className="adm-hero__text">
                  <span className="adm-hero__name" dir="auto">{title}</span>
                  <span className="adm-hero__meta" dir="auto">{channel.topic || (channel.visibility === 'private' ? 'Private channel' : `Public in ${server?.name ?? 'its team server'}`)}</span>
                </div>
              </div>
            ) : null}
            <NavList items={items} current={current} />
          </>
        )}
      >
        {channel.archived ? <Banner tone="warning" icon="archive">This channel is archived and read only.{powers.canManage ? ' Unarchive it under Archive and leave.' : ''}</Banner> : null}
        {body}
      </Split>
    </Screen>
  );
}

// ------------------------------------------------------------------ about

function AboutTab({ ctx }: { ctx: Ctx }) {
  const c = ctx.channel;
  const [name, setName] = useState(c.name ?? '');
  const [topic, setTopic] = useState(c.topic ?? '');
  const [description, setDescription] = useState(c.description ?? '');
  const [category, setCategory] = useState(c.category ?? '');
  const [announcement, setAnnouncement] = useState(c.posting_policy === 'admins');
  const [replies, setReplies] = useState(c.allow_replies);
  const [reactions, setReactions] = useState(c.allow_reactions);
  const [autoJoin, setAutoJoin] = useState(c.auto_join);
  const [touched, setTouched] = useState(false);
  const [makingPrivate, setMakingPrivate] = useState(false);
  const errors = validateChannel({ name, topic, description, category });

  const patch: Parameters<typeof api.updateChannel>[1] = {};
  if (clean(name) !== (c.name ?? '')) patch.name = clean(name);
  if (clean(topic) !== (c.topic ?? '')) patch.topic = clean(topic);
  if (clean(description) !== (c.description ?? '')) patch.description = clean(description);
  if (clean(category) !== (c.category ?? '')) patch.category = clean(category) || null;
  if ((announcement ? 'admins' : 'everyone') !== c.posting_policy) patch.posting_policy = announcement ? 'admins' : 'everyone';
  if (replies !== c.allow_replies) patch.allow_replies = replies;
  if (reactions !== c.allow_reactions) patch.allow_reactions = reactions;
  if (ctx.powers.canSetAutoJoin && autoJoin !== c.auto_join) patch.auto_join = autoJoin;
  const dirty = Object.keys(patch).length > 0;
  const act = useAction(() => api.updateChannel(c.id, patch));
  const field = fieldFromHint(act.error, ['name', 'topic', 'description', 'category']);
  const show = (k: keyof typeof errors): string | null => {
    const local = touched ? errors[k] : undefined;
    if (local) return local;
    return field === k ? act.error?.hint ?? null : null;
  };

  const facts = (
    <dl className="adm-facts">
      <dt>Topic</dt><dd dir="auto">{c.topic || 'None'}</dd>
      <dt>Description</dt><dd dir="auto">{c.description || 'None'}</dd>
      <dt>Who can see it</dt><dd>{c.visibility === 'private' ? 'Only its members' : `Everyone in ${ctx.server?.name ?? 'its team server'}`}</dd>
      <dt>Who can post</dt><dd>{c.posting_policy === 'admins' ? 'Admins only (announcements)' : 'Every member'}</dd>
      <dt>Replies</dt><dd>{c.allow_replies ? 'Allowed' : 'Off'}</dd>
      <dt>Reactions</dt><dd>{c.allow_reactions ? 'Allowed' : 'Off'}</dd>
      {c.category ? <><dt>Category</dt><dd dir="auto">{c.category}</dd></> : null}
      <dt>Members</dt><dd>{c.member_count}</dd>
      <dt>Created</dt><dd>{formatDate(c.created_at)}</dd>
    </dl>
  );

  if (!ctx.powers.canManage) {
    return (
      <Section title="About this channel" description="Only the channel owner or a server admin can change these.">
        <Card>{facts}</Card>
      </Section>
    );
  }

  const reset = () => {
    setName(c.name ?? ''); setTopic(c.topic ?? ''); setDescription(c.description ?? ''); setCategory(c.category ?? '');
    setAnnouncement(c.posting_policy === 'admins'); setReplies(c.allow_replies); setReactions(c.allow_reactions); setAutoJoin(c.auto_join);
    setTouched(false); act.reset();
  };
  const submit = async () => {
    setTouched(true);
    if (hasErrors(errors) || !dirty) return;
    const r = await act.run();
    if (!r.ok) return;
    ctx.replace(r.value);
    setTouched(false);
    toast({ kind: 'success', title: 'Channel saved' });
  };

  return (
    <>
      <Section title="About" description="Shown at the top of the channel and in Browse.">
        <form className="ap-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <fieldset className="ap-radios" disabled={c.archived}>
            <legend className="sr-only">Channel details</legend>
            <div className="ap-form">
              <TextField label="Name" value={name} maxLength={100} error={show('name')} onChange={(e) => setName(e.target.value)} />
              <TextField label="Topic" value={topic} maxLength={300} error={show('topic')} hint="One line under the channel name." onChange={(e) => setTopic(e.target.value)} />
              <TextArea label="Description" rows={3} value={description} error={show('description')} onChange={(e) => setDescription(e.target.value)} />
              <TextField label="Category" value={category} maxLength={60} error={show('category')} hint="Groups channels in the sidebar. Empty for none." onChange={(e) => setCategory(e.target.value)} />
              <div className="adm-switches">
                <Switch label="Announcement channel" description="Only admins post. Members still read, and react or reply when those are on." checked={announcement} onChange={setAnnouncement} disabled={c.archived} />
                <Switch label="Allow replies in threads" checked={replies} onChange={setReplies} disabled={c.archived} />
                <Switch label="Allow reactions" checked={reactions} onChange={setReactions} disabled={c.archived} />
                {c.visibility === 'public' ? (
                  <Switch
                    label="Everyone in the server joins"
                    description={ctx.powers.canSetAutoJoin ? 'New members of the team server join this channel automatically.' : 'Only server admins change this.'}
                    checked={autoJoin}
                    onChange={setAutoJoin}
                    disabled={c.archived || !ctx.powers.canSetAutoJoin}
                  />
                ) : null}
              </div>
            </div>
          </fieldset>
          <FormError error={act.error} onRetry={submit} hidden={!!field} />
          <div className="ap-form__actions">
            <Button variant="ghost" disabled={!dirty || act.busy} onClick={reset}>Undo changes</Button>
            <Button type="submit" variant="primary" loading={act.busy} disabled={!dirty || c.archived}>Save changes</Button>
          </div>
        </form>
      </Section>

      <Section title="Visibility">
        <Card>
          {c.visibility === 'private' ? (
            <p className="ap-card__text"><span className="ap-strong">Private.</span> Only its members see it, also when they are from other team servers. A private channel cannot become public again.</p>
          ) : (
            <>
              <p className="ap-card__text"><span className="ap-strong">Public in {ctx.server?.name ?? 'its team server'}.</span> Everyone in the server can find it, read it and join it.</p>
              <div className="ap-form__actions ap-form__actions--start">
                <Button icon="lock" onClick={() => setMakingPrivate(true)} disabled={c.archived}>Make private</Button>
              </div>
            </>
          )}
        </Card>
      </Section>
      {makingPrivate ? <MakePrivateDialog ctx={ctx} onClose={() => setMakingPrivate(false)} /> : null}
    </>
  );
}

function MakePrivateDialog({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const act = useAction(() => api.updateChannel(ctx.channel.id, { visibility: 'private' }));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    ctx.replace(r.value);
    refreshShell();
    toast({ kind: 'success', title: 'The channel is private now' });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title="Make this channel private?"
      body={(
        <div className="ap-form">
          <p>People of the server who never joined it lose sight of it at once. Its {plural(ctx.channel.member_count, 'member keeps', 'members keep')} access. This cannot be undone.</p>
          <FormError error={act.error} onRetry={confirm} />
        </div>
      )}
      confirmLabel="Make private"
      danger
      busy={act.busy}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

// ------------------------------------------------------------------ members

function MembersTab({ ctx }: { ctx: Ctx }) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const paged = usePaged<MemberItem, number>(
    async (cursor) => offsetPage(await api.listChannelMembers(ctx.channel.id, q || null, 50, cursor ?? 0), cursor ?? 0),
    [ctx.channel.id, q],
  );
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<MemberItem | null>(null);
  return (
    <Section
      title="Members"
      description={ctx.channel.visibility === 'private' ? 'Only these people see this channel. They can be from any team server.' : 'People who joined this channel.'}
      actions={ctx.powers.canAddPeople ? <Button variant="primary" icon="userPlus" onClick={() => setAdding(true)}>Add people</Button> : null}
    >
      <TextField label="Search" type="search" placeholder="Name or handle" value={query} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
      <p className="ap-hint" aria-live="polite">{paged.total !== null ? plural(paged.total, 'person', 'people') : ''}</p>
      <PagedView paged={paged} what="member list" empty={<EmptyState icon="users" title={q ? 'Nobody matches' : 'Nobody here yet'} />}>
        {(items) => (
          <List label="Channel members">
            {items.map((m) => {
              const self = m.profile.id === ctx.myId;
              const menu: MenuItem[] = ctx.powers.canManage && !self && !ctx.channel.archived
                ? [{ label: 'Remove from channel', icon: 'trash', danger: true, onSelect: () => setRemoving(m) }]
                : [];
              return (
                <Row
                  key={m.profile.id}
                  leading={<Avatar name={m.profile.display_name} path={m.profile.avatar_path} seed={m.profile.id} size={36} />}
                  title={(
                    <>
                      <span dir="auto">{m.profile.display_name}</span>
                      {self ? <span className="ap-meta">(you)</span> : null}
                      {m.role === 'owner' ? <Pill tone="accent">Channel owner</Pill> : null}
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
      {adding ? (
        <AddChannelMembersDialog ctx={ctx} existing={new Set(paged.items.map((m) => m.profile.id))} onClose={() => setAdding(false)}
          onDone={() => { paged.reload(); }} />
      ) : null}
      {removing ? (
        <RemoveChannelMemberDialog ctx={ctx} m={removing} onClose={() => setRemoving(null)}
          onDone={() => paged.update((list) => list.filter((x) => x.profile.id !== removing.profile.id))} />
      ) : null}
    </Section>
  );
}

function AddChannelMembersDialog({ ctx, existing, onClose, onDone }: { ctx: Ctx; existing: ReadonlySet<string>; onClose: () => void; onDone: () => void }) {
  const [people, setPeople] = useState<Profile[]>([]);
  const [touched, setTouched] = useState(false);
  const act = useAction(() => api.addChannelMembers(ctx.channel.id, people.map((p) => p.id)));
  const submit = async () => {
    setTouched(true);
    if (!people.length) return;
    const r = await act.run();
    if (!r.ok) return;
    const res = (r.value ?? {}) as { added?: string[]; already_members?: string[] };
    const added = res.added?.length ?? people.length;
    toast({ kind: 'success', title: `Added ${plural(added, 'person', 'people')}`, body: res.already_members?.length ? `${plural(res.already_members.length, 'person was', 'people were')} already in it.` : undefined });
    onDone();
    onClose();
  };
  return (
    <Modal open size="md" title={`Add people to ${ctx.channel.kind === 'audio' ? '' : '#'}${ctx.channel.name ?? ''}`} onClose={onClose} dismissable={!act.busy}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={act.busy}>{people.length ? `Add ${plural(people.length, 'person', 'people')}` : 'Add people'}</Button>
        </>
      )}>
      <div className="ap-form">
        <PeoplePicker
          orgId={ctx.orgId}
          selected={people}
          onChange={setPeople}
          label="People"
          excludeIds={existing}
          max={100}
          hint={ctx.powers.canManage
            ? 'Anyone in the organization, guests and people from other team servers too. They see this channel and nothing else of its server.'
            : `People already in ${ctx.server?.name ?? 'this team server'}. The channel owner or a server admin can add guests and people from other teams.`}
        />
        {touched && !people.length ? <p className="ap-error-text" role="alert">Choose at least one person.</p> : null}
        <FormError error={act.error} onRetry={submit} />
      </div>
    </Modal>
  );
}

function RemoveChannelMemberDialog({ ctx, m, onClose, onDone }: { ctx: Ctx; m: MemberItem; onClose: () => void; onDone: () => void }) {
  const act = useAction(() => api.removeChannelMember(ctx.channel.id, m.profile.id));
  const confirm = async () => {
    const r = await act.run();
    if (!r.ok) return;
    onDone();
    toast({ kind: 'success', title: `${m.profile.display_name} was removed` });
    onClose();
  };
  return (
    <ConfirmDialog
      open
      title={`Remove ${m.profile.display_name}?`}
      body={(
        <div className="ap-form">
          <p>
            {ctx.channel.visibility === 'private'
              ? 'They lose this channel at once: its messages, files, search results and notifications.'
              : 'They leave the channel. As a member of the team server they can still find it and join again.'}
          </p>
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

// ------------------------------------------------------------------ notifications

const MUTE_CHOICES = [
  { value: '0', label: 'Not muted' },
  { value: '1', label: 'For 1 hour' },
  { value: '8', label: 'For 8 hours' },
  { value: '24', label: 'For 1 day' },
  { value: '168', label: 'For 1 week' },
];

function NotifyTab({ ctx }: { ctx: Ctx }) {
  const c = ctx.channel;
  const mutedNow = !!c.muted_until && Date.parse(c.muted_until) > Date.now();
  const [level, setLevel] = useState<NotifyLevel>(c.notify);
  const [mute, setMute] = useState(mutedNow ? 'keep' : '0');
  const until = mute === 'keep' ? c.muted_until : mute === '0' ? null : new Date(Date.now() + Number(mute) * 3_600_000).toISOString();
  const act = useAction(() => api.setChannelNotify(c.id, level, until));
  const dirty = level !== c.notify || mute !== (mutedNow ? 'keep' : '0');
  const submit = async () => {
    const r = await act.run();
    if (!r.ok) return;
    const next = { ...c, notify: r.value.notify, muted_until: r.value.muted_until };
    ctx.replace(next);
    setMute(r.value.muted_until && Date.parse(r.value.muted_until) > Date.now() ? 'keep' : '0');
    toast({ kind: 'success', title: 'Saved', body: r.value.muted_until ? `Muted until ${formatDateTime(r.value.muted_until)}.` : undefined });
  };
  return (
    <Section title="Notifications" description="Unread counts in Dek always show. These choose when this channel also sends a notification to your phone or computer.">
      <form className="ap-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <RadioGroup
          legend="Notify me about"
          value={level}
          onChange={setLevel}
          options={[
            { value: 'default', label: 'My usual setting', description: 'Whatever you chose in Settings, Notifications.' },
            { value: 'all', label: 'Every new message' },
            { value: 'mentions', label: 'Only mentions of me' },
            { value: 'none', label: 'Nothing', description: 'The channel still shows unread messages inside Dek.' },
          ]}
        />
        <Select
          label="Mute"
          value={mute}
          onChange={(e) => setMute(e.target.value)}
          hint={mutedNow ? `Muted until ${formatDateTime(c.muted_until as string)}.` : 'Muting pauses notifications for a while, then they come back.'}
          options={[...(mutedNow ? [{ value: 'keep', label: 'Keep the current mute' }] : []), ...MUTE_CHOICES]}
        />
        <FormError error={act.error} onRetry={submit} />
        <div className="ap-form__actions">
          <Button type="submit" variant="primary" loading={act.busy} disabled={!dirty}>Save</Button>
        </div>
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------ archive, join, leave

function DangerTab({ ctx }: { ctx: Ctx }) {
  const c = ctx.channel;
  const [confirming, setConfirming] = useState<'archive' | 'leave' | null>(null);
  const unarchive = useAction(() => api.archiveChannel(c.id, false));
  const archive = useAction(() => api.archiveChannel(c.id, true));
  const join = useAction(() => api.joinChannel(c.id));
  const leave = useAction(() => api.leaveChannel(c.id));

  const onUnarchive = async () => {
    const r = await unarchive.run();
    if (!r.ok) return;
    ctx.replace(r.value);
    refreshShell();
    toast({ kind: 'success', title: 'The channel is active again' });
  };
  const onArchive = async () => {
    const r = await archive.run();
    if (!r.ok) return;
    ctx.replace(r.value);
    refreshShell();
    setConfirming(null);
    toast({ kind: 'success', title: 'Channel archived', body: 'It is read only now.' });
  };
  const onJoin = async () => {
    const r = await join.run();
    if (!r.ok) return;
    ctx.replace(r.value);
    refreshShell();
    toast({ kind: 'success', title: 'You joined the channel', action: { label: 'Open', onClick: () => go(channelRoute(ctx.orgId, c.id)) } });
  };
  const onLeave = async () => {
    const r = await leave.run();
    if (!r.ok) return;
    refreshShell();
    setConfirming(null);
    invalidate(`channel:${c.id}`);
    toast({ kind: 'success', title: `You left ${c.kind === 'audio' ? '' : '#'}${c.name ?? 'the channel'}` });
    go({ name: 'org', orgId: ctx.orgId }, 'replace');
  };

  return (
    <>
      {ctx.powers.canManage ? (
        <Section title={c.archived ? 'Unarchive' : 'Archive'}>
          <Card tone={c.archived ? undefined : 'danger'}>
            <p className="ap-card__text">
              {c.archived
                ? 'Unarchiving lets members post, react and add people again.'
                : 'Archiving makes the channel read only for everyone. Its history and files stay and can still be searched.'}
            </p>
            <FormError error={unarchive.error} onRetry={onUnarchive} />
            <div className="ap-form__actions ap-form__actions--start">
              {c.archived
                ? <Button variant="primary" onClick={onUnarchive} loading={unarchive.busy}>Unarchive channel</Button>
                : <Button variant="danger" icon="archive" onClick={() => setConfirming('archive')}>Archive channel</Button>}
            </div>
          </Card>
        </Section>
      ) : null}
      <Section title={c.member ? 'Leave' : 'Join'}>
        <Card>
          {c.member ? (
            <>
              <p className="ap-card__text">
                {c.visibility === 'private'
                  ? 'You lose this private channel. Someone has to add you again to come back.'
                  : 'The channel leaves your sidebar. You can join it again from Browse.'}
              </p>
              <div className="ap-form__actions ap-form__actions--start">
                <Button variant="danger" icon="logout" onClick={() => setConfirming('leave')}>Leave channel</Button>
              </div>
            </>
          ) : (
            <>
              <p className="ap-card__text">{c.visibility === 'public' && !c.archived ? 'You are not in this channel. Join it to post and to get its notifications.' : 'You are not in this channel.'}</p>
              {c.visibility === 'public' && !c.archived ? (
                <>
                  <FormError error={join.error} onRetry={onJoin} />
                  <div className="ap-form__actions ap-form__actions--start">
                    <Button variant="primary" icon="plus" onClick={onJoin} loading={join.busy}>Join channel</Button>
                  </div>
                </>
              ) : null}
            </>
          )}
        </Card>
      </Section>
      {confirming === 'archive' ? (
        <ConfirmDialog
          open
          title="Archive this channel?"
          body={<div className="ap-form"><p>Nobody can post, react or be added until it is unarchived. Nothing is deleted.</p><FormError error={archive.error} onRetry={onArchive} /></div>}
          confirmLabel="Archive channel"
          danger
          busy={archive.busy}
          onConfirm={onArchive}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
      {confirming === 'leave' ? (
        <ConfirmDialog
          open
          title="Leave this channel?"
          body={<div className="ap-form"><p>{c.visibility === 'private' ? 'You will need to be added again to come back.' : 'You can join it again from Browse.'}</p><FormError error={leave.error} onRetry={onLeave} /></div>}
          confirmLabel="Leave channel"
          danger
          busy={leave.busy}
          onConfirm={onLeave}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </>
  );
}
