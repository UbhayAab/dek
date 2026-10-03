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
import { dropCache, dropCachedOrg, noteGap, scheduleCacheWrite } from './channels';
import { dropPersistedDrafts } from './local';
import { orgGone, refreshMe, scheduleBootstrapRefresh } from './org';
import { ensureProfiles } from './profiles';
import { applyChannelRead, applyThreadReadEvent } from './read';
import {
  applyCall, applyChannelUpdate, applyMemberCount, applyNewMessage, applyUpdatedMessage, channelsOfServer,
  dropPendingByClientId, purgeChannels,
} from './reducers';
import { isOpen, markClosed, onScreen, runtime } from './runtime';

export function handleEvent(e: ServerEvent, topic: string): void {
  switch (e.event) {
    case 'msg.new':
      onNewMessage(e.payload.message, topic);
      return;
    case 'msg.upd': {
      const patch = applyUpdatedMessage(getState(), e.payload.message);
      if (patch) {
        setState(patch);
        scheduleCacheWrite(e.payload.message.channel_id);
      }
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
      setState(applyCall(getState(), e.payload.call));
      return;
  }
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
  if (gap) noteGap(msg.channel_id, msg.seq);
  if (!known && topic.startsWith('u:')) {
    // A new DM or a private channel I was just added to: the sidebar needs it.
    scheduleBootstrapRefresh();
  }
  if (msg.author_id && !getState().profiles[msg.author_id]) ensureProfiles([msg.author_id]);
  if (s.timelines[msg.channel_id]) scheduleCacheWrite(msg.channel_id);
}

function onMemberUpdate(p: { scope: 'org' | 'server' | 'channel'; id: string; user_id: string; change: 'added' | 'removed' | 'role' }): void {
  const me = getState().session.userId;
  if (p.user_id === me) {
    if (p.scope === 'org') void refreshMe().catch(() => undefined);
    scheduleBootstrapRefresh();
    return;
  }
  if (p.scope === 'channel' && p.change !== 'role') {
    const patch = applyMemberCount(getState(), p.id, p.change === 'added' ? 1 : -1);
    if (patch) setState(patch);
  }
}

// ---------------------------------------------------------------- revocation

export async function revoke(scope: 'org' | 'server' | 'channel', id: string): Promise<void> {
  const s = getState();
  if (scope === 'org') {
    await dropCachedOrg(id);
    if (s.orgId === id) {
      const ids = new Set(Object.keys(s.channels));
      purgeLocal(ids, id);
    }
    purgeMedia([`${id}/`]);
    await orgGone(id);
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
    toast({ kind: 'info', title: `You no longer have access to ${label}.`, duration: 8_000 });
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
function purgeLocal(ids: ReadonlySet<string>, orgId: string | null): void {
  if (ids.size === 0) return;
  for (const id of ids) {
    while (isOpen(id)) {
      if (markClosed(id) === 0) hub.leaveView(id);
    }
  }
  setState(purgeChannels(getState(), ids));
  const rt = runtime();
  rt?.outbox.dropChannels(ids);
  for (const id of ids) void dropCache(id);
  if (rt) dropPersistedDrafts(rt.userId, ids);
  if (orgId) purgeMedia(Array.from(ids, (c) => `${orgId}/${c}/`));
}
