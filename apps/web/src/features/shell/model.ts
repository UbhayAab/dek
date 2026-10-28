// The sidebar's view: one flat text-first channel list per server, DMs by
// recency, and unchanged unread badges. Category metadata never hides a channel.
import type { Channel, Server } from '../../api/types';
import { isMuted } from '../conversation/names';

export type ServerAccess = Server['access'];

// server_json carries "access" (0900): member, partial (cross-team: only the
// channels you were added to), or browse (listed, not joined). A page cached
// before that field existed falls back to my_role.
export function serverAccess(s: Server): ServerAccess {
  const a: string | undefined = s.access;
  if (a === 'member' || a === 'partial' || a === 'browse') return a;
  return s.my_role ? 'member' : 'partial';
}

export interface CategoryGroup {
  category: string | null;
  channels: Channel[];
}

export interface ServerSection {
  server: Server;
  // Cross-team access (DEK02): the person is not a server member and sees only
  // the channels they were added to.
  partial: boolean;
  groups: CategoryGroup[];
  unread: boolean;
  mentions: number;
}

function byPosition(a: Channel, b: Channel): number {
  return (a.kind==='audio'?1:0)-(b.kind==='audio'?1:0) || a.position - b.position || (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id);
}

export function serverSections(orgId: string | null, servers: Record<string, Server>, channels: Record<string, Channel>, now = Date.now()): ServerSection[] {
  if (!orgId) return [];
  const all = Object.values(channels);
  return Object.values(servers)
    .filter((s) => s.org_id === orgId && serverAccess(s) !== 'browse')
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((server) => {
      const partial = serverAccess(server) === 'partial';
      // The sidebar lists conversations the person is IN; public channels they
      // have not joined are found through Browse. Archived ones leave the list.
      const mine = all.filter((c) => c.org_id===orgId && c.server_id === server.id && c.member && !c.archived && (c.kind === 'text' || c.kind === 'audio'));
      // Keep the group shape for Home consumers, with exactly one flat list.
      const groups:CategoryGroup[]=mine.length?[{category:null,channels:[...mine].sort(byPosition)}]:[];
      return {
        server,
        partial,
        groups,
        unread: mine.some((c) => c.unread > 0 && !isMuted(c, now)),
        mentions: mine.reduce((n, c) => n + c.mentions, 0),
      };
    })
    // A partial server with nothing the person can open is not shown at all.
    .filter((s) => !s.partial || s.groups.length > 0);
}

export function dmChannels(orgId: string | null, channels: Record<string, Channel>): Channel[] {
  if (!orgId) return [];
  return Object.values(channels)
    .filter((c) => c.org_id === orgId && (c.kind === 'dm' || c.kind === 'group_dm') && c.member && !c.hidden)
    .sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at));
}

export interface OrgCounts {
  unreadChannels: number;
  mentions: number;
  dmUnread: number;
}

export function orgCounts(orgId: string | null, channels: Record<string, Channel>, now = Date.now()): OrgCounts {
  let unreadChannels = 0;
  let mentions = 0;
  let dmUnread = 0;
  if (!orgId) return { unreadChannels, mentions, dmUnread };
  for (const c of Object.values(channels)) {
    if (c.org_id !== orgId || !c.member) continue;
    const dm = c.kind === 'dm' || c.kind === 'group_dm';
    if (dm) {
      if (!c.hidden && c.unread > 0) dmUnread += c.unread;
      continue;
    }
    if (c.archived) continue;
    mentions += c.mentions;
    if (c.unread > 0 && !isMuted(c, now)) unreadChannels += 1;
  }
  return { unreadChannels, mentions, dmUnread };
}

// What a conversation row shows as its badge: DMs count every unread message
// (each one is addressed to you), channels count mentions only.
export function badgeCount(c: Channel): number {
  if (c.kind === 'dm' || c.kind === 'group_dm') return c.unread;
  return c.mentions;
}
