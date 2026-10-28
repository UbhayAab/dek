// Realtime events from the hub (CONTRACT section 3) applied to the store, plus the
// side effects that go with them: outbox settlement, healing a hole, refreshing
// counters, and revocation (DEK05, DEKA06: access, subscriptions and cached
// content of a removed scope go at once).
import type { Message } from '../api/types';
import { currentRoute, navigate } from '../app/router';
import { hub } from '../realtime/hub';
import type { ServerEvent } from '../realtime/types';
import { getState, setState } from '../store/state';
import { toast } from '../ui/kit';
import { purgeMedia } from '../sw/register';
import { dropCachedOrg, noteGap, scheduleCacheWrite } from './channels';
import { orgGone, refreshMe, scheduleBootstrapRefresh,scheduleSummaryRefresh } from './org';
import { ensureProfiles } from './profiles';
import { applySavedEvent } from './saved';
import { onJoinRequest } from './requests';
import { applyChannelRead, applyThreadReadEvent } from './read';
import { applyBrand } from '../lib/color';
import { healThread } from './threads';
import {purgeLocal} from './access';
import type { OrgPatch } from '../realtime/types';
import {
  applyCall, applyChanSelf, applyChannelUpdate, applyMemberCount, applyNewMessage, applyOrgPatch, applyServerPatch,
  applyUpdatedMessage, channelsOfServer, dropPendingByClientId,
} from './reducers';
import { isOpen, markClosed, nextAccessGen, onScreen, runtime } from './runtime';
import { validPermissionVersion } from '../lib/server-permissions';

export function handleEvent(e: ServerEvent, topic: string): void {
  if((e.event==='activity.upd'&&e.payload.org_id===getState().orgId)||e.event==='read'||e.event==='msg.new'||e.event==='msg.upd')setState({activityVersion:getState().activityVersion+1});
  switch (e.event) {
    case 'activity.upd':if(e.payload.org_id===getState().orgId)scheduleBootstrapRefresh();else scheduleSummaryRefresh();return;
    case 'msg.new':
      onNewMessage(e.payload.message, topic);
      return;
    case 'msg.upd': {
      const patch = applyUpdatedMessage(getState(), e.payload.message);
      if (patch) {
        setState(patch);
        scheduleCacheWrite(e.payload.message.channel_id);
      }
      scheduleBootstrapRefresh();
      return;
    }
    case 'read':
      if (e.payload.channel_id && typeof e.payload.last_read_seq === 'number') {
        applyChannelRead(e.payload.channel_id, e.payload.last_read_seq);
      } else if (e.payload.root_id && typeof e.payload.last_read_reply_seq === 'number') {
        applyThreadReadEvent(e.payload.root_id, e.payload.last_read_reply_seq);
      }
      return;
    case 'chan.upd': {
      const c = e.payload.channel;
      const patch = applyChannelUpdate(getState(), c);
      if (patch) setState(patch);
      else if (c.org_id === getState().orgId && topic.startsWith('u:')) scheduleBootstrapRefresh();
      return;
    }
    case 'member.upd':
      onMemberUpdate(e.payload);
      return;
    case 'access.revoked':
      void revoke(e.payload.scope, e.payload.id);
      return;
    case 'call.ring':
    case 'call.upd':
      {
        const patch = applyCall(getState(), e.payload.call);
        if (patch.calls) setState(patch);   // an older copy changes nothing
      }
      return;
    case 'server.upd': {
      const before = getState();
      const update = e.payload.server;
      if (update.org_id !== before.orgId) return;
      const known = before.servers[update.id];
      const versioned = update.permission_version !== undefined;
      const newer = validPermissionVersion(update.permission_version)
        && update.permission_version > Math.max(known?.permission_version ?? 0, known?.permissions_target_version ?? 0);
      if (newer) nextAccessGen(); // an older in-flight snapshot must not restore old rights
      const patch = applyServerPatch(before, update);
      if (patch) setState(patch);
      if (newer || !known) scheduleBootstrapRefresh();
      else if (!patch && !versioned) scheduleBootstrapRefresh();
      return;
    }
    case 'org.upd':
      onOrgPatch(e.payload.org);
      return;
    case 'saved.upd':
      applySavedEvent(e.payload);
      return;
    case 'join.req':
      onJoinRequest(e.payload);
      return;
    case 'chan.self': {
      const p = e.payload;
      const patch = applyChanSelf(getState(), p, isOpen(p.channel_id));
      if (patch) setState(patch);
      else if (!p.hidden) scheduleBootstrapRefresh();   // unhidden elsewhere: bring it back
      return;
    }
  }
}

function onOrgPatch(o: OrgPatch): void {
  const s = getState();
  if (o.archived) {
    if (s.orgs.some((x) => x.id === o.id)) void revoke('org', o.id, `${o.name} was archived.`);
    return;
  }
  const patch = applyOrgPatch(s, o);
  if (patch) setState(patch);
  if (s.orgId === o.id) applyBrand(o.brand_color);
}

function onNewMessage(msg: Message, topic: string): void {
  const s = getState();
  const me = s.session.userId;
  const mine = !!msg.client_id && msg.author_id === me;
  if (mine) runtime()?.outbox.settle(msg.client_id!);
  if (msg.org_id !== s.orgId) {
    // Another organization: never shown here (DEK01). Only my pending copy settles.
    if (mine) {
      const pending = dropPendingByClientId(s.pending, msg.client_id);
      if (pending !== s.pending) setState({ pending });
    }
    return;
  }
  const known = !!s.channels[msg.channel_id] || !!s.timelines[msg.channel_id];
  const { patch, gap } = applyNewMessage(s, msg, { me, onScreen });
  setState(patch);
  if (msg.thread_root_id) void healThread(msg.thread_root_id);
  if (gap) noteGap(msg.channel_id, msg.seq);
  if (!known && topic.startsWith('u:')) {
    // A new DM or a private channel I was just added to: the sidebar needs it.
    scheduleBootstrapRefresh();
  }
  if (msg.author_id && !getState().profiles[msg.author_id]) ensureProfiles([msg.author_id]);
  if (s.timelines[msg.channel_id]) scheduleCacheWrite(msg.channel_id);
}

function onMemberUpdate(p: { scope: 'org' | 'server' | 'channel'; id: string; user_id: string; change: 'added' | 'removed' | 'role' | 'moderation' }): void {
  if (p.scope === 'server' && getState().servers[p.id]) setState({ serverMemberVersion: getState().serverMemberVersion + 1 });
  const me = getState().session.userId;
  if (p.user_id === me) {
    if (p.scope === 'server' || (p.scope === 'org' && p.change === 'role')) {
      nextAccessGen();
      const servers = { ...getState().servers };
      for (const [id, server] of Object.entries(servers)) {
        if (p.scope === 'org' || id === p.id) servers[id] = { ...server, permissions_stale: true };
      }
      setState({ servers });
    }
    if (p.scope === 'org') void refreshMe().catch(() => undefined);
    scheduleBootstrapRefresh();
    return;
  }
  if (p.scope === 'channel' && (p.change === 'added' || p.change === 'removed')) {
    const patch = applyMemberCount(getState(), p.id, p.change === 'added' ? 1 : -1);
    if (patch) setState(patch);
  }
}

// ---------------------------------------------------------------- revocation

// Channels this person just deleted: their own access.revoked needs no "you no longer
// have access" notice, the delete already said so.
const deletedHere = new Set<string>();
export function expectRevoke(channelId: string): void {
  deletedHere.add(channelId);
  setTimeout(() => deletedHere.delete(channelId), 60_000);
}

export async function revoke(scope: 'org' | 'server' | 'channel', id: string, notice?: string): Promise<void> {
  const s = getState();
  if (scope === 'org') {
    await orgGone(id, notice);
    return;
  }
  let ids: Set<string>;
  let label: string;
  if (scope === 'server') {
    ids = channelsOfServer(s, id);
    label = s.servers[id]?.name ? `the ${s.servers[id]!.name} team` : 'that team';
    const servers = { ...s.servers };
    delete servers[id];
    const topics = s.topics.filter((t) => t !== `s:${id}`);
    setState({ servers, topics });
    hub.setTopics(topics);
  } else {
    ids = new Set([id]);
    const ch = s.channels[id];
    label = ch?.name ? `#${ch.name}` : 'that conversation';
  }
  const looking = lookingAt(ids, scope === 'server' ? id : null);
  purgeLocal(ids, s.orgId);
  if (looking && s.orgId) {
    navigate({ name: 'org', orgId: s.orgId }, { replace: true });
    if (!(scope === 'channel' && deletedHere.has(id))) {
      toast({ kind: 'info', title: `You no longer have access to ${label}.`, duration: 8_000 });
    }
  }
}

function lookingAt(channelIds: ReadonlySet<string>, serverId: string | null): boolean {
  const r = currentRoute();
  if ((r.name === 'channel' || r.name === 'channelSettings') && channelIds.has(r.channelId)) return true;
  if (serverId && (r.name === 'serverSettings' || r.name === 'browse') && r.serverId === serverId) return true;
  return false;
}

// Memory, outbox, page cache, drafts, view topics and media cache for these
// channels, all at once.
