// What the person may do, as far as the client can tell. The server decides for
// real (every call re-checks); these only shape the interface so people are not
// offered actions that will be refused, and see WHY something is unavailable.
import type { Channel, Message, OrgRole, OrgSettings, Server } from '../../api/types';
import { hasServerPermission, serverAccessMessage, serverContentBlocked } from '../../lib/server-permissions';

export interface Who {
  meId: string | null;
  orgRole: OrgRole | null;
  server: Server | undefined;
}

export function isOrgAdmin(role: OrgRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

// Mirrors dek.can_moderate_channel: org admins, server admins and moderators,
// and the owner of a text or audio channel. DMs: org admins only.
export function canModerate(c: Channel | undefined, who: Who): boolean {
  if (!c) return false;
  if (c.server_id && who.server && (who.server.id !== c.server_id || who.server.org_id !== c.org_id
    || who.server.permissions_stale || serverContentBlocked(who.server))) return false;
  if (isOrgAdmin(who.orgRole)) return true;
  if (c.kind === 'dm' || c.kind === 'group_dm') return false;
  if (who.server && (who.server.my_role === 'admin' || who.server.my_role === 'moderator')) return true;
  return c.my_role === 'owner';
}

// Channel settings: the channel owner, server admins, org admins.
export function canManageChannel(c: Channel | undefined, who: Who): boolean {
  if (!c || c.kind === 'dm' || c.kind === 'group_dm') return false;
  if (who.server && (who.server.id !== c.server_id || who.server.org_id !== c.org_id)) return false;
  const legacy = isOrgAdmin(who.orgRole) || who.server?.my_role === 'admin' || c.my_role === 'owner';
  const visible = c.visibility === 'public' || c.member || isOrgAdmin(who.orgRole) || who.server?.my_role === 'admin';
  return visible && hasServerPermission(who.server, 'edit_channels', legacy);
}

export function canDeleteOthers(c: Channel | undefined, who: Who): boolean {
  if (!c) return false;
  if (!c.server_id) return canModerate(c, who);
  if (who.server && (who.server.id !== c.server_id || who.server.org_id !== c.org_id)) return false;
  return hasServerPermission(who.server, 'delete_messages', canModerate(c, who));
}

export type PostState =
  | { ok: true }
  | { ok: false; reason: string; action?: 'join' };

// Mirrors dek.assert_post for what the client knows. Blocks and suspension are
// only known from the server's answer and are handled where sends fail.
export function postState(c: Channel | undefined, who: Who, isReply: boolean): PostState {
  if (!c) return { ok: false, reason: 'This conversation is not available.' };
  if (c.server_id) {
    if (who.server && (who.server.id !== c.server_id || who.server.org_id !== c.org_id)) return { ok: false, reason: 'This server is not available.' };
    const problem = serverAccessMessage(who.server);
    if (problem) return { ok: false, reason: problem };
  }
  if (c.archived || (c.server_id && who.server?.archived)) return { ok: false, reason: 'This conversation is archived and read only.' };
  if (!c.member) {
    if (c.visibility === 'public' && c.server_id) return { ok: false, reason: 'Join this channel to post in it.', action: 'join' };
    return { ok: false, reason: 'You are not a member of this conversation.' };
  }
  if (isReply && !c.allow_replies) return { ok: false, reason: 'Replies are turned off in this channel.' };
  if (c.posting_policy === 'admins' && !(isReply && c.allow_replies) && !canModerate(c, who)) {
    return { ok: false, reason: 'Only admins can post in this announcement channel.' };
  }
  if (who.orgRole === null) return { ok: false, reason: 'You are no longer in this organization.' };
  return { ok: true };
}

// <!channel> and <!here>: channel admins, server admins and moderators, org admins,
// and anyone in channels of 50 or fewer members (CONTRACT 0).
export function canMentionAll(c: Channel | undefined, who: Who): boolean {
  if (!c || c.kind === 'dm') return false;
  return canModerate(c, who) || c.member_count <= 50;
}

export function canPin(c: Channel | undefined, who: Who): boolean {
  if (!c || c.archived || (c.server_id && who.server?.archived)) return false;
  if (c.server_id && who.server && (who.server.id !== c.server_id || who.server.org_id !== c.org_id)) return false;
  if (c.server_id && (serverAccessMessage(who.server) || !hasServerPermission(who.server, 'pin_messages', true))) return false;
  if (!c.member && ((c.kind === 'dm' || c.kind === 'group_dm') || !canModerate(c, who))) return false;
  if (c.posting_policy === 'admins') return canModerate(c, who);
  return true;
}

export function canReact(c: Channel | undefined, who?: Who): boolean {
  if (c?.server_id && who?.server && (who.server.id !== c.server_id || who.server.org_id !== c.org_id)) return false;
  return !!c && c.member && c.allow_reactions && !c.archived
    && (!c.server_id || !who || (!who.server?.archived && !serverAccessMessage(who.server)));
}

export function canReply(c: Channel | undefined): boolean {
  return !!c && c.allow_replies && (c.member || c.visibility === 'public');
}

export type EditState = { ok: true } | { ok: false; reason: string };

export function editState(m: Message, meId: string | null, settings: OrgSettings | null | undefined, now: number = Date.now(), who?: Who): EditState {
  if (!meId || m.author_id !== meId || m.kind !== 'user') return { ok: false, reason: 'You can only edit your own messages.' };
  if (who?.server) {
    const problem = serverAccessMessage(who.server);
    if (problem) return { ok: false, reason: problem };
    if (serverContentBlocked(who.server)) return { ok: false, reason: 'This server is not available.' };
  }
  if (m.deleted_at) return { ok: false, reason: 'This message was deleted.' };
  const minutes = settings?.edit_window_minutes ?? null;
  if (minutes !== null && now - Date.parse(m.created_at) > minutes * 60_000) {
    return { ok: false, reason: `Messages can be edited for ${minutes} minutes after sending.` };
  }
  return { ok: true };
}

export function canDelete(m: Message, meId: string | null, moderator: boolean): boolean {
  if (m.deleted_at || m.kind !== 'user') return false;
  return (!!meId && m.author_id === meId) || moderator;
}
