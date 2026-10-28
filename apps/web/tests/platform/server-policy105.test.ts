import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../src/api/rpc',()=>({api:{bootstrap:vi.fn(),me:vi.fn()}}));
vi.mock('../../src/realtime/hub',()=>({hub:{setTopics:vi.fn(),leaveView:vi.fn()}}));
vi.mock('../../src/sync/channels',()=>({dropCache:vi.fn(),dropCachedOrg:vi.fn(async()=>[]),invalidateChannelLoads:vi.fn(),clearNotificationsFor:vi.fn(),noteGap:vi.fn(),scheduleCacheWrite:vi.fn()}));
vi.mock('../../src/sync/local',()=>({lastOrg:()=>null,rememberOrg:vi.fn(),dropPersistedDrafts:vi.fn(),setDraft:vi.fn()}));
vi.mock('../../src/sync/profiles',()=>({mergeProfiles:vi.fn(),ensureProfiles:vi.fn(),resetProfiles:vi.fn()}));
vi.mock('../../src/sync/saved',()=>({loadSavedIds:vi.fn(),applySavedEvent:vi.fn()}));
vi.mock('../../src/sw/register',()=>({purgeMedia:vi.fn()}));
import {api} from '../../src/api/rpc';
import type {BootstrapResult,Server} from '../../src/api/types';
import type {Outbox} from '../../src/sync/outbox';
import {applyBootstrap,refreshBootstrap,resetOrg} from '../../src/sync/org';
import {getState,initialState,resetState,setState} from '../../src/store/state';
import {currentAccessGen,currentOrgGen,nextOrgGen,noteServerTime,setRuntime} from '../../src/sync/runtime';
import {handleEvent} from '../../src/sync/events';
import {applyServerPatch} from '../../src/sync/reducers';
import {postState} from '../../src/features/conversation/permissions';
import {channel,server,ORG,USER} from '../ui/collaboration-fixture';
const NOW=Date.parse('2026-10-28T00:00:00Z');
const native={...server,permission_version:1,permissions:{pin_messages:true},can_manage_permissions:false} as Server;
function snapshot(s:Server=native):BootstrapResult {return {org:{id:ORG,name:'Fictional QA',slug:'qa',my_role:'member',brand_color:'#0F766E',settings:{}},servers:[s],channels:[channel],profiles:[],topics:[],server_time:new Date(Date.now()).toISOString()} as unknown as BootstrapResult;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(NOW);resetOrg();resetState();nextOrgGen();vi.clearAllMocks();vi.mocked(api.bootstrap).mockReset();noteServerTime(new Date(NOW).toISOString(),NOW,NOW);
 setState({orgId:ORG,session:{status:'signed_in',userId:USER,email:null,setup:null},orgs:[snapshot().org],servers:{[server.id]:native},channels:{[channel.id]:channel},bootstrap:{status:'ready',error:null,at:1}});
 setRuntime({userId:USER,gen:currentOrgGen(),db:Promise.resolve({ok:false} as never),outbox:{dropChannels:vi.fn(),snapshot:()=>[]} as unknown as Outbox});
});
afterEach(()=>{resetOrg();setRuntime(null);noteServerTime(new Date(Date.now()).toISOString(),Date.now(),Date.now());vi.useRealTimers();});
function version(n:number){handleEvent({event:'server.upd',payload:{server:{id:server.id,org_id:ORG,permission_version:n}}},`s:${server.id}`);}

describe('shared realtime payloads never supply another person’s rights',()=>{
 it('masks stale rights without destroying the server name, membership or last native version',()=>{
  const s=initialState();s.orgId=ORG;s.servers={[server.id]:native};
  const patch=applyServerPatch(s,{id:server.id,org_id:ORG,permission_version:2});const next=patch!.servers![server.id]!;
  expect(next).toMatchObject({name:server.name,my_role:'member',permission_version:1,permissions_target_version:2,permissions_stale:true,permissions:{pin_messages:true}});
 });
 it('ignores injected caller fields, unknown organizations and invalid versions',()=>{
  const s=initialState();s.orgId=ORG;s.servers={[server.id]:native};
  expect(applyServerPatch(s,{id:server.id,org_id:'other',name:'wrong'})).toBeNull();
  expect(applyServerPatch(s,{id:server.id,org_id:ORG,permission_version:NaN})).toBeNull();
  expect(applyServerPatch(s,{id:server.id,org_id:ORG,permissions:{pin_messages:false},my_role:'admin',moderation:{banned:true}} as never)).toBeNull();
  expect(applyServerPatch(s,{id:server.id,org_id:ORG,name:'Renamed'})!.servers![server.id]!.permissions).toEqual(native.permissions);
 });
 it('coalesces newer versions and ignores repeated, old and foreign markers',async()=>{
  vi.mocked(api.bootstrap).mockResolvedValue(snapshot({...native,permission_version:3}));
  const gen=currentAccessGen();version(2);expect(getState().servers[server.id]!.permissions_stale).toBe(true);expect(currentAccessGen()).toBe(gen+1);
  version(2);version(1);handleEvent({event:'server.upd',payload:{server:{id:server.id,org_id:'other',permission_version:99}}},'s:other');expect(currentAccessGen()).toBe(gen+1);
  version(3);await vi.advanceTimersByTimeAsync(1001);expect(api.bootstrap).toHaveBeenCalledTimes(1);
  expect(getState().servers[server.id]!).toMatchObject({permission_version:3});expect(getState().servers[server.id]!.permissions_stale).toBeUndefined();
 });
 it('rejects the older in-flight bootstrap after a new policy marker, then fetches the latest one',async()=>{
  const old=deferred<BootstrapResult>();vi.mocked(api.bootstrap).mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot({...native,permission_version:2,permissions:{pin_messages:false} as Server['permissions']}));
  const reading=refreshBootstrap();version(2);old.resolve(snapshot());await reading;
  expect(getState().servers[server.id]!.permissions_stale).toBe(true);
  await vi.advanceTimersByTimeAsync(1001);expect(api.bootstrap).toHaveBeenCalledTimes(2);
  expect(getState().servers[server.id]!.permissions!.pin_messages).toBe(false);expect(getState().servers[server.id]!.permission_version).toBe(2);
 });
 it.each(['role','moderation'] as const)('refreshes my server %s but does not alter unrelated channel counts',async(change)=>{
  vi.mocked(api.bootstrap).mockResolvedValue(snapshot({...native,my_role:'member',moderation:{muted_until:null,muted:false,suspended:true,banned:false}}));
  const count=getState().channels[channel.id]!.member_count;
  handleEvent({event:'member.upd',payload:{scope:'server',id:server.id,user_id:USER,change}},`s:${server.id}`);
  expect(getState().servers[server.id]!.permissions_stale).toBe(true);expect(getState().channels[channel.id]!.member_count).toBe(count);
  await vi.advanceTimersByTimeAsync(1001);expect(api.bootstrap).toHaveBeenCalledTimes(1);expect(getState().servers[server.id]!.moderation?.suspended).toBe(true);
 });
 it('does not invalidate my rights for somebody else’s moderation event',()=>{
  const gen=currentAccessGen(),roster=getState().serverMemberVersion;handleEvent({event:'member.upd',payload:{scope:'server',id:server.id,user_id:'other',change:'moderation'}},`s:${server.id}`);
  expect(currentAccessGen()).toBe(gen);expect(getState().servers[server.id]!.permissions_stale).toBeUndefined();
  expect(getState().serverMemberVersion).toBe(roster+1);
 });
});

describe('mute deadlines are local, bounded and tied to the current session',()=>{
 it('repaints and authoritatively refreshes once at expiry, without interval polling',async()=>{
  const muted={...native,moderation:{muted_until:new Date(NOW+60_000).toISOString(),muted:true,suspended:false,banned:false}};
  vi.mocked(api.bootstrap).mockResolvedValue(snapshot({...native,moderation:{...muted.moderation,muted:false,muted_until:null}}));
  applyBootstrap(snapshot(muted));const before=getState().servers;
  expect(postState(channel,{meId:USER,orgRole:'member',server:getState().servers[server.id]},false).ok).toBe(false);
  await vi.advanceTimersByTimeAsync(59_999);expect(api.bootstrap).not.toHaveBeenCalled();expect(getState().servers).toBe(before);
  await vi.advanceTimersByTimeAsync(102);expect(api.bootstrap).toHaveBeenCalledTimes(1);expect(getState().servers).not.toBe(before);
  expect(postState(channel,{meId:USER,orgRole:'member',server:getState().servers[server.id]},false).ok).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);expect(api.bootstrap).toHaveBeenCalledTimes(1);
 });
 it('does not refresh a different organization when an old deadline fires',async()=>{
  applyBootstrap(snapshot({...native,moderation:{muted_until:new Date(NOW+1_000).toISOString(),muted:true,suspended:false,banned:false}}));
  nextOrgGen();setState({orgId:'another-org'});await vi.advanceTimersByTimeAsync(5_000);expect(api.bootstrap).not.toHaveBeenCalled();
 });
 it('clears its timer on reset, and never asks the backend merely to re-arm a long deadline',async()=>{
  applyBootstrap(snapshot({...native,moderation:{muted_until:new Date(NOW+3*86_400_000).toISOString(),muted:true,suspended:false,banned:false}}));
  await vi.advanceTimersByTimeAsync(86_400_001);expect(api.bootstrap).not.toHaveBeenCalled();resetOrg();await vi.advanceTimersByTimeAsync(4*86_400_000);expect(api.bootstrap).not.toHaveBeenCalled();
 });
});
