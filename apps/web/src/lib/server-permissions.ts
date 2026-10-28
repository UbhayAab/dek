import type { OrgRole, Server, ServerPermission } from '../api/types';
import { serverNowIso } from '../sync/runtime';

export const SERVER_PERMISSION_LABELS: Record<ServerPermission, string> = {
  add_people: 'Add people', remove_people: 'Remove people', invite_people: 'Manage invite links',
  decide_join_requests: 'Review join requests', create_channels: 'Create channels', edit_channels: 'Edit channels',
  delete_channels: 'Delete channels', assign_roles: 'Assign roles', delete_messages: 'Delete others’ messages',
  pin_messages: 'Pin messages', mute_members: 'Mute members', suspend_members: 'Suspend members',
  ban_members: 'Ban members', edit_server: 'Edit and archive server', view_audit: 'View server activity',
};

export function serverContentBlocked(server: Server | undefined): boolean {
  return !!server?.moderation?.suspended || !!server?.moderation?.banned;
}

export function serverMuted(server: Server | undefined, now = Date.parse(serverNowIso())): boolean {
  const control = server?.moderation;
  if (!control) return false;
  const until = control.muted_until === null ? NaN : Date.parse(control.muted_until);
  return Number.isFinite(until) ? until > now : control.muted === true;
}

export function serverAccessMessage(server: Server | undefined, includeMute = true): string | null {
  if (server?.permissions_stale) return 'Refreshing your server permissions. Please wait.';
  if (server?.moderation?.banned) return 'You are banned from this server. Ask a server Admin for help.';
  if (server?.moderation?.suspended) return 'Your access to this server is suspended. Ask a server Admin to restore it.';
  if (includeMute && serverMuted(server)) return 'You are muted in this server. You can read messages. Posting resumes when the mute ends.';
  return null;
}

// Native capability data is authoritative when present. Legacy callers may pass
// their existing fallback only for snapshots that predate the additive contract.
export function hasServerPermission(server: Server | undefined, action: ServerPermission, legacy = false): boolean {
  if (server?.permissions_stale || serverContentBlocked(server)) return false;
  if (server?.permissions !== undefined) return server.permissions[action] === true;
  return legacy;
}

export function mayManageServerPolicy(server: Server, orgRole: OrgRole | null): boolean {
  if (server.permissions_stale || serverContentBlocked(server) || orgRole === 'guest') return false;
  if (server.can_manage_permissions !== undefined) return server.can_manage_permissions === true;
  return orgRole === 'owner' || orgRole === 'admin' || server.my_role === 'admin';
}

export function validPermissionVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
