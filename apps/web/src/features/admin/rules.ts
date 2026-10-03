// What the caller may do to whom, decided in one place so every screen offers the
// same actions. These mirror the server's own rules ([org] 0100 and 0101); the
// server still enforces them, the client only avoids offering what would fail.
import type { OrgRole, ServerRole } from '../../api/types';

export interface OrgMemberLike {
  id: string;
  role: OrgRole;
  status: string;
}

export interface OrgMemberActions {
  roles: OrgRole[];
  canSuspend: boolean;
  canUnsuspend: boolean;
  canRemove: boolean;
  note: string | null;
}

const ALL_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'guest'];

// Owners act on anyone (their own role too while another active owner remains);
// admins only move members and guests between member and guest; nobody suspends or
// removes themselves; an organization always keeps one active owner.
export function orgMemberActions(
  me: { id: string; role: OrgRole | null },
  target: OrgMemberLike,
  activeOwners: number,
  allowGuests = true,
): OrgMemberActions {
  const none: OrgMemberActions = { roles: [], canSuspend: false, canUnsuspend: false, canRemove: false, note: null };
  const self = me.id === target.id;
  if (me.role !== 'owner' && me.role !== 'admin') return { ...none, note: 'Only organization admins can change members.' };
  const guestOk = (r: OrgRole) => r !== 'guest' || allowGuests;

  if (me.role === 'admin') {
    if (self) return { ...none, note: 'Ask an owner to change your own membership.' };
    if (target.role === 'owner' || target.role === 'admin') return { ...none, note: 'Only an owner can change an admin or an owner.' };
    return {
      roles: (['member', 'guest'] as OrgRole[]).filter((r) => r !== target.role && guestOk(r)),
      canSuspend: target.status === 'active',
      canUnsuspend: target.status === 'suspended',
      canRemove: true,
      note: null,
    };
  }

  const lastOwner = target.role === 'owner' && target.status === 'active' && activeOwners <= 1;
  const roles = lastOwner ? [] : ALL_ROLES.filter((r) => r !== target.role && guestOk(r));
  const note = lastOwner
    ? (self ? 'You are the only owner. Make someone else an owner before changing your own role.' : 'This is the only owner. Make someone else an owner first.')
    : null;
  if (self) return { roles, canSuspend: false, canUnsuspend: false, canRemove: false, note };
  return {
    roles,
    canSuspend: target.status === 'active' && !lastOwner,
    canUnsuspend: target.status === 'suspended',
    canRemove: !lastOwner,
    note,
  };
}

export interface ServerMemberActions {
  roles: ServerRole[];
  canRemove: boolean;
}

// Server admins (and org admins) set roles and remove anyone but themselves (they
// leave instead); moderators remove members and moderators, never admins.
export function serverMemberActions(
  me: { id: string; serverRole: ServerRole | null; orgAdmin: boolean },
  target: { id: string; role: ServerRole },
): ServerMemberActions {
  const admin = me.orgAdmin || me.serverRole === 'admin';
  const mod = admin || me.serverRole === 'moderator';
  const self = me.id === target.id;
  if (admin) {
    return {
      roles: (['admin', 'moderator', 'member'] as ServerRole[]).filter((r) => r !== target.role),
      canRemove: !self,
    };
  }
  if (mod) return { roles: [], canRemove: !self && target.role !== 'admin' };
  return { roles: [], canRemove: false };
}

export interface ChannelPowers {
  canManage: boolean;      // channel owner, server admin or org admin
  canSetAutoJoin: boolean; // server admin or org admin
  canAddPeople: boolean;   // managers; members of a public channel (people of the server)
}

export function channelPowers(input: {
  channelRole: 'owner' | 'member' | null;
  member: boolean;
  visibility: 'public' | 'private';
  serverRole: ServerRole | null;
  orgAdmin: boolean;
  archived: boolean;
}): ChannelPowers {
  const serverAdmin = input.orgAdmin || input.serverRole === 'admin';
  const canManage = serverAdmin || input.channelRole === 'owner';
  return {
    canManage,
    canSetAutoJoin: serverAdmin,
    canAddPeople: !input.archived && (canManage || (input.visibility === 'public' && input.member)),
  };
}
