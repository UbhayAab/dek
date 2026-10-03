// Membership and my channel settings as store actions: each resolves after the
// server answered and puts the server's reply in the store, so screens never need a
// bootstrap refresh for them.
import { api } from '../api/rpc';
import { DekError } from '../api/errors';
import type { Channel, NotifyLevel } from '../api/types';
import { getState, setState } from '../store/state';
import { ensureProfiles } from './profiles';

function upsert(ch: Channel): void {
  const s = getState();
  if (ch.org_id !== s.orgId) return;   // answered after an organization switch
  const prev = s.channels[ch.id];
  setState({ channels: { ...s.channels, [ch.id]: prev ? { ...prev, ...ch } : ch } });
}

export async function setChannelNotify(channelId: string, level: NotifyLevel, mutedUntil: string | null = null): Promise<void> {
  const r = await api.setChannelNotify(channelId, level, mutedUntil);
  const s = getState();
  const ch = s.channels[r.channel_id ?? channelId];
  if (ch) setState({ channels: { ...s.channels, [ch.id]: { ...ch, notify: r.notify, muted_until: r.muted_until } } });
}

export async function joinChannel(channelId: string): Promise<void> {
  upsert(await api.joinChannel(channelId));
}

// Leaving takes the channel out of the sidebar. If I may no longer read it at all
// (a private channel), access.revoked follows and clears what is cached.
export async function leaveChannel(channelId: string): Promise<void> {
  await api.leaveChannel(channelId);
  const s = getState();
  if (!s.channels[channelId]) return;
  const channels = { ...s.channels };
  delete channels[channelId];
  setState({ channels });
}

export async function openDm(userIds: string[]): Promise<string> {
  const orgId = getState().orgId;
  if (!orgId) throw new DekError('not_found', 'Open an organization first.');
  const ids = Array.from(new Set(userIds.filter((u) => typeof u === 'string' && u.length > 0)));
  if (ids.length === 0) throw new DekError('invalid_input', 'Choose at least one person.');
  const ch = await api.openDm(orgId, ids);
  upsert({ ...ch, hidden: false });
  ensureProfiles(ch.dm_user_ids ?? ids);
  return ch.id;
}
