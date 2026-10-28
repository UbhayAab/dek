import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Message,Server,ServerPermissions} from '../../src/api/types';
import {channel,server} from './collaboration-fixture';
import {canDelete,canDeleteOthers,canManageChannel,canPin,canReact,editState,postState,type Who} from '../../src/features/conversation/permissions';
import {channelPowers,serverMemberActions} from '../../src/features/admin/rules';
import {hasServerPermission,mayManageServerPolicy,SERVER_PERMISSION_LABELS,serverMuted} from '../../src/lib/server-permissions';
import {noteServerTime} from '../../src/sync/runtime';

const NOW=Date.parse('2026-10-28T00:00:00Z');
function policy(p:Partial<ServerPermissions>={}):ServerPermissions {
 return {...Object.fromEntries(Object.keys(SERVER_PERMISSION_LABELS).map(k=>[k,false])),...p} as ServerPermissions;
}
function scope(p:Partial<Server>={}):Server {return {...server,permissions:policy(),permission_version:2,can_manage_permissions:false,...p};}
function who(s=scope()):Who {return {meId:'me',orgRole:'member',server:s};}
const message={id:'m',org_id:channel.org_id,channel_id:channel.id,author_id:'me',kind:'user',body:'Hi',created_at:new Date(NOW).toISOString(),deleted_at:null} as Message;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);noteServerTime(new Date(NOW).toISOString(),NOW,NOW);});
afterEach(()=>{noteServerTime(new Date(Date.now()).toISOString(),Date.now(),Date.now());vi.useRealTimers();});

describe('native server policy shapes real actions',()=>{
 it('a false native grant defeats old server-admin, org-admin and channel-owner guesses',()=>{
  const s=scope({my_role:'admin'}),w={...who(s),orgRole:'admin' as const},c={...channel,my_role:'owner' as const};
  expect(hasServerPermission(s,'edit_channels',true)).toBe(false);
  expect(canManageChannel(c,w)).toBe(false);expect(canDeleteOthers(c,w)).toBe(false);expect(canPin(c,w)).toBe(false);
  expect(mayManageServerPolicy(s,'admin')).toBe(false);
 });
 it('independently grants editing, deleting and pinning instead of a coarse moderator flag',()=>{
  const w=who(scope({permissions:policy({edit_channels:true,pin_messages:true})}));
  expect(canManageChannel(channel,w)).toBe(true);expect(canPin(channel,w)).toBe(true);
  expect(canDeleteOthers(channel,w)).toBe(false);
  expect(canDeleteOthers(channel,who(scope({permissions:policy({delete_messages:true})})))).toBe(true);
 });
 it('does not convert management rights into private-channel access',()=>{
  const w=who(scope({permissions:policy({edit_channels:true})}));
  expect(canManageChannel({...channel,member:false},w)).toBe(false);
  expect(canManageChannel({...channel,member:false,visibility:'public'},w)).toBe(true);
 });
 it('retains channel announcement, membership, archive and reaction restrictions',()=>{
  const w=who(scope({permissions:policy({pin_messages:true})}));
  expect(canPin({...channel,posting_policy:'admins'},w)).toBe(false);
  expect(canPin({...channel,member:false},w)).toBe(false);
  expect(canPin({...channel,archived:true},w)).toBe(false);
  expect(canReact({...channel,allow_reactions:false},w)).toBe(false);
  expect(canReact(channel,who(scope({archived:true})))).toBe(false);
 });
 it('keeps moderator pinning in public, unjoined channels without giving that power to members',()=>{
  const c={...channel,visibility:'public' as const,member:false};
  expect(canPin(c,who(scope({my_role:'moderator',permissions:policy({pin_messages:true})})))).toBe(true);
  expect(canPin(c,who(scope({permissions:policy({pin_messages:true})})))).toBe(false);
 });
 it('never borrows another server or organization context',()=>{
  const s=scope({id:'different',permissions:policy({pin_messages:true,edit_channels:true,delete_messages:true})});
  expect(canManageChannel(channel,who(s))).toBe(false);expect(canPin(channel,who(s))).toBe(false);
  expect(canReact(channel,who(s))).toBe(false);expect(canDeleteOthers(channel,who(s))).toBe(false);
  expect(postState(channel,who(s),false).ok).toBe(false);
  expect(canManageChannel(channel,who({...s,id:channel.server_id!,org_id:'other'}))).toBe(false);
 });
 it('leaves unrelated DMs usable while a server is muted or suspended',()=>{
  const w=who(scope({moderation:{muted_until:new Date(NOW+60_000).toISOString(),muted:true,suspended:true,banned:false}}));
  const dm={...channel,server_id:null,kind:'dm' as const};
  expect(postState(dm,w,false)).toEqual({ok:true});expect(canReact(dm,w)).toBe(true);expect(canPin(dm,w)).toBe(true);
  expect(canDeleteOthers(dm,w)).toBe(false);
  expect(postState(dm,who(scope({archived:true})),false)).toEqual({ok:true});
 });
 it.each(['permissions_stale','suspended','banned'] as const)('fails closed during %s and preserves own deletion',state=>{
  const s=scope({permissions:policy({pin_messages:true,edit_channels:true,delete_messages:true}),
   ...(state==='permissions_stale'?{permissions_stale:true}:{moderation:{muted_until:null,muted:false,suspended:state==='suspended',banned:state==='banned'}})});
  const w=who(s);expect(postState(channel,w,false).ok).toBe(false);expect(canReact(channel,w)).toBe(false);
  expect(canPin(channel,w)).toBe(false);expect(canManageChannel(channel,w)).toBe(false);expect(canDeleteOthers(channel,w)).toBe(false);
  expect(editState(message,'me',null,NOW,w).ok).toBe(false);expect(canDelete(message,'me',false)).toBe(true);
 });
 it('uses a posting mute, with time expiry, without revoking separate management grants',()=>{
  const s=scope({permissions:policy({edit_channels:true,delete_messages:true,pin_messages:true}),moderation:{muted_until:new Date(NOW+60_000).toISOString(),muted:true,suspended:false,banned:false}}),w=who(s);
  expect(postState(channel,w,false).ok).toBe(false);expect(canReact(channel,w)).toBe(false);expect(canPin(channel,w)).toBe(false);
  expect(editState(message,'me',null,NOW,w).ok).toBe(false);expect(canManageChannel(channel,w)).toBe(true);expect(canDeleteOthers(channel,w)).toBe(true);
  vi.advanceTimersByTime(60_001);expect(serverMuted(s)).toBe(false);expect(postState(channel,w,false)).toEqual({ok:true});expect(canReact(channel,w)).toBe(true);
 });
 it('uses the measured server clock when the device clock is wrong',()=>{
  const s=scope({moderation:{muted_until:new Date(NOW+60_000).toISOString(),muted:true,suspended:false,banned:false}});
  vi.setSystemTime(NOW-3_600_000);noteServerTime(new Date(NOW+60_001).toISOString(),Date.now(),Date.now());expect(serverMuted(s)).toBe(false);
 });
 it('exposes policy management only to an authoritative full Admin',()=>{
  expect(mayManageServerPolicy(scope({can_manage_permissions:true}),'member')).toBe(true);
  expect(mayManageServerPolicy(scope({can_manage_permissions:true}),'guest')).toBe(false);
  expect(mayManageServerPolicy(scope({can_manage_permissions:true,permissions_stale:true}),'owner')).toBe(false);
  expect(Object.keys(SERVER_PERMISSION_LABELS)).toHaveLength(15);
 });
});

describe('server member and channel action boundaries',()=>{
 it('does not couple removing a member to assigning their role',()=>{
  const s=scope({my_role:'moderator',permissions:policy({remove_people:true})});
  const me={id:'me',serverRole:s.my_role,orgAdmin:false,server:s};
  expect(serverMemberActions(me,{id:'other',role:'member'})).toEqual({roles:[],canRemove:true});
  const granting={...me,server:{...s,permissions:policy({assign_roles:true})}};
  expect(serverMemberActions(granting,{id:'other',role:'member'})).toEqual({roles:['moderator'],canRemove:false});
 });
 it('prevents self-actions, moderator peer actions, org-admin changes and member escalation',()=>{
  const s=scope({my_role:'moderator',permissions:policy({assign_roles:true,remove_people:true})});
  const me={id:'me',serverRole:s.my_role,orgAdmin:false,server:s};
  for(const target of [{id:'me',role:'member' as const},{id:'other',role:'moderator' as const},{id:'other',role:'admin' as const},{id:'other',role:'member' as const,orgRole:'owner' as const}])
   expect(serverMemberActions(me,target)).toEqual({roles:[],canRemove:false});
  const memberMe={...me,serverRole:'member' as const,server:{...s,my_role:'member' as const}};
  expect(serverMemberActions(memberMe,{id:'other',role:'member'}).roles).toEqual([]);
 });
 it('does not restore old channel-owner powers when a capability is removed',()=>{
  const input={channelRole:'owner' as const,member:true,visibility:'private' as const,serverRole:'member' as const,orgAdmin:false,archived:false,server:scope()};
  expect(channelPowers(input)).toEqual({canManage:false,canSetAutoJoin:false,canAddPeople:false});
  expect(channelPowers({...input,server:scope({permissions:policy({add_people:true})})})).toEqual({canManage:false,canSetAutoJoin:false,canAddPeople:true});
 });
});
