import { describe, expect, test } from 'vitest';
import { channelPowers, orgMemberActions, serverMemberActions } from '../../src/features/admin/rules';
import { fieldFromHint, isMissingFunction, offsetPage } from '../../src/features/admin/common/load';
import { DekError } from '../../src/api/errors';

const owner = { id: 'me', role: 'owner' as const };
const admin = { id: 'me', role: 'admin' as const };

describe('organization member actions', () => {
  test('members and guests get nothing', () => {
    const a = orgMemberActions({ id: 'me', role: 'member' }, { id: 'x', role: 'member', status: 'active' }, 1);
    expect(a.roles).toEqual([]);
    expect(a.canRemove || a.canSuspend).toBe(false);
  });

  test('an owner can set any other role, suspend and remove', () => {
    const a = orgMemberActions(owner, { id: 'x', role: 'member', status: 'active' }, 1);
    expect(a.roles).toEqual(['owner', 'admin', 'guest']);
    expect(a.canSuspend && a.canRemove).toBe(true);
    expect(a.canUnsuspend).toBe(false);
  });

  test('admins only move members and guests between member and guest', () => {
    expect(orgMemberActions(admin, { id: 'x', role: 'member', status: 'active' }, 1).roles).toEqual(['guest']);
    expect(orgMemberActions(admin, { id: 'x', role: 'guest', status: 'active' }, 1).roles).toEqual(['member']);
    const onAdmin = orgMemberActions(admin, { id: 'x', role: 'admin', status: 'active' }, 1);
    expect(onAdmin.roles).toEqual([]);
    expect(onAdmin.canRemove).toBe(false);
    expect(onAdmin.note).toMatch(/Only an owner/);
  });

  test('the last active owner cannot be demoted, suspended or removed', () => {
    const a = orgMemberActions(owner, { id: 'other', role: 'owner', status: 'active' }, 1);
    expect(a.roles).toEqual([]);
    expect(a.canSuspend || a.canRemove).toBe(false);
    expect(a.note).toMatch(/only owner/);
    const two = orgMemberActions(owner, { id: 'other', role: 'owner', status: 'active' }, 2);
    expect(two.roles).toContain('admin');
    expect(two.canRemove).toBe(true);
  });

  test('nobody suspends or removes themselves; an owner changes their own role only with another owner', () => {
    const alone = orgMemberActions(owner, { id: 'me', role: 'owner', status: 'active' }, 1);
    expect(alone.roles).toEqual([]);
    expect(alone.note).toMatch(/You are the only owner/);
    const withOther = orgMemberActions(owner, { id: 'me', role: 'owner', status: 'active' }, 2);
    expect(withOther.roles).toEqual(['admin', 'member', 'guest']);
    expect(withOther.canSuspend || withOther.canRemove).toBe(false);
    expect(orgMemberActions(admin, { id: 'me', role: 'admin', status: 'active' }, 1).roles).toEqual([]);
  });

  test('a suspended member can be restored, not suspended again', () => {
    const a = orgMemberActions(owner, { id: 'x', role: 'member', status: 'suspended' }, 1);
    expect(a.canUnsuspend).toBe(true);
    expect(a.canSuspend).toBe(false);
  });

  test('guest roles disappear when the organization turns guests off', () => {
    expect(orgMemberActions(owner, { id: 'x', role: 'member', status: 'active' }, 1, false).roles).toEqual(['owner', 'admin']);
  });
});

describe('team server member actions', () => {
  test('server admins set roles and remove anyone but themselves', () => {
    const me = { id: 'me', serverRole: 'admin' as const, orgAdmin: false };
    expect(serverMemberActions(me, { id: 'x', role: 'member' })).toEqual({ roles: ['admin', 'moderator'], canRemove: true });
    expect(serverMemberActions(me, { id: 'me', role: 'admin' }).canRemove).toBe(false);
  });

  test('moderators cannot remove admins and set no roles', () => {
    const me = { id: 'me', serverRole: 'moderator' as const, orgAdmin: false };
    expect(serverMemberActions(me, { id: 'x', role: 'member' })).toEqual({ roles: [], canRemove: true });
    expect(serverMemberActions(me, { id: 'x', role: 'admin' }).canRemove).toBe(false);
  });

  test('org admins administer every server', () => {
    expect(serverMemberActions({ id: 'me', serverRole: null, orgAdmin: true }, { id: 'x', role: 'admin' }).canRemove).toBe(true);
    expect(serverMemberActions({ id: 'me', serverRole: 'member', orgAdmin: false }, { id: 'x', role: 'member' })).toEqual({ roles: [], canRemove: false });
  });
});

describe('channel powers', () => {
  const base = { channelRole: null, member: true, visibility: 'public' as const, serverRole: 'member' as const, orgAdmin: false, archived: false };
  test('members of a public channel can add people but not manage', () => {
    expect(channelPowers(base)).toEqual({ canManage: false, canSetAutoJoin: false, canAddPeople: true });
  });
  test('private channels: only managers add people', () => {
    expect(channelPowers({ ...base, visibility: 'private' }).canAddPeople).toBe(false);
    expect(channelPowers({ ...base, visibility: 'private', channelRole: 'owner' }).canAddPeople).toBe(true);
  });
  test('the channel owner manages but only server admins set auto join', () => {
    expect(channelPowers({ ...base, channelRole: 'owner' })).toMatchObject({ canManage: true, canSetAutoJoin: false });
    expect(channelPowers({ ...base, serverRole: 'admin' })).toMatchObject({ canManage: true, canSetAutoJoin: true });
    expect(channelPowers({ ...base, serverRole: null, orgAdmin: true })).toMatchObject({ canManage: true, canSetAutoJoin: true });
  });
  test('archived channels take no new people', () => {
    expect(channelPowers({ ...base, serverRole: 'admin', archived: true }).canAddPeople).toBe(false);
  });
});

describe('server refusals land under the right field', () => {
  test('field names first, as the server words them', () => {
    expect(fieldFromHint(new DekError('invalid_input', 'name is required.'), ['name', 'topic'])).toBe('name');
    expect(fieldFromHint(new DekError('invalid_input', 'display_name: use 1 to 80 characters on one line.'), ['name', 'display_name'])).toBe('display_name');
    expect(fieldFromHint(new DekError('conflict', 'handle: that handle is already taken.'), ['handle'])).toBe('handle');
    expect(fieldFromHint(new DekError('conflict', 'A channel with that name already exists in this team server.'), ['name'])).toBe('name');
    expect(fieldFromHint(new DekError('invalid_input', 'quiet hours: set both a start and an end, or neither.'), ['quiet_start'], { 'quiet hours': 'quiet_end' })).toBe('quiet_end');
  });
  test('other refusals stay general', () => {
    expect(fieldFromHint(new DekError('forbidden', 'name is required.'), ['name'])).toBeNull();
    expect(fieldFromHint(new DekError('invalid_input', 'Choose at least one person to add.'), ['name'])).toBeNull();
    expect(fieldFromHint(null, ['name'])).toBeNull();
  });
  test('a function missing on the server is recognised', () => {
    expect(isMissingFunction(new DekError('unknown', null, 404))).toBe(true);
    expect(isMissingFunction(new DekError('not_found', null, 404))).toBe(false);
  });
});

describe('offset pages', () => {
  test('next offset until the total is reached', () => {
    expect(offsetPage({ items: [1, 2], total: 5 }, 0)).toEqual({ items: [1, 2], next: 2, total: 5 });
    expect(offsetPage({ items: [5], total: 5 }, 4)).toEqual({ items: [5], next: null, total: 5 });
    expect(offsetPage({ items: [], total: 9 }, 9).next).toBeNull();
    expect(offsetPage({ items: [1] }, 0)).toEqual({ items: [1], next: null, total: null });
  });
});
