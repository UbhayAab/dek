// How conversations and people are named and iconed everywhere in the UI.
import type { Channel, Profile } from '../../api/types';
import type { IconName } from '../../ui/icons';

export function personName(profiles: Record<string, Profile>, id: string | null | undefined): string {
  if (!id) return 'Dek';
  const p = profiles[id];
  if (!p) return 'Someone';
  return p.display_name || p.handle || 'Someone';
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

// "Alice", "Alice and Bob", "Alice, Bob and Carol", "Alice, Bob and 3 others".
export function joinNames(names: string[]): string {
  if (names.length === 0) return 'Only you';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

export function channelTitle(c: Channel | undefined, profiles: Record<string, Profile>): string {
  if (!c) return 'Conversation';
  if (c.kind === 'dm') {
    const other = c.dm_user_ids?.[0];
    return other ? personName(profiles, other) : 'Just you';
  }
  if (c.kind === 'group_dm') {
    const ids = c.dm_user_ids ?? [];
    return joinNames(ids.map((id) => firstName(personName(profiles, id))));
  }
  return c.name ?? 'channel';
}

// Title with the # prefix channels get in running text ("#general", "Alice").
export function channelLabel(c: Channel | undefined, profiles: Record<string, Profile>): string {
  if (!c) return 'Conversation';
  return c.kind === 'text' || c.kind === 'audio' ? `#${c.name ?? 'channel'}` : channelTitle(c, profiles);
}

export function isAnnouncement(c: Pick<Channel, 'posting_policy' | 'kind'>): boolean {
  return (c.kind === 'text' || c.kind === 'audio') && c.posting_policy === 'admins';
}

export function channelIcon(c: Pick<Channel, 'kind' | 'visibility' | 'posting_policy'>): IconName {
  if (c.kind === 'dm') return 'user';
  if (c.kind === 'group_dm') return 'users';
  if (c.kind === 'audio') return 'volume';
  if (c.posting_policy === 'admins') return 'megaphone';
  if (c.visibility === 'private') return 'lock';
  return 'hash';
}

export function channelKindLabel(c: Pick<Channel, 'kind' | 'visibility' | 'posting_policy'>): string {
  if (c.kind === 'dm') return 'Direct message';
  if (c.kind === 'group_dm') return 'Group message';
  if (c.kind === 'audio') return 'Audio room';
  if (c.posting_policy === 'admins') return 'Announcement channel';
  return c.visibility === 'private' ? 'Private channel' : 'Channel';
}

export function isMuted(c: Pick<Channel, 'notify' | 'muted_until'>, now: number = Date.now()): boolean {
  if (c.notify === 'none') return true;
  return !!c.muted_until && Date.parse(c.muted_until) > now;
}

export function isDm(c: Pick<Channel, 'kind'> | undefined): boolean {
  return !!c && (c.kind === 'dm' || c.kind === 'group_dm');
}
