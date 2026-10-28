import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../src/api/rpc',()=>({api:{bootstrap:vi.fn(),threadWindow:vi.fn(),me:vi.fn()}}));
vi.mock('../../src/realtime/hub',()=>({hub:{setTopics:vi.fn(),leaveView:vi.fn()}}));
vi.mock('../../src/sync/channels',()=>({dropCache:vi.fn(),dropCachedOrg:vi.fn(async()=>['cached-only']),invalidateChannelLoads:vi.fn(),clearNotificationsFor:vi.fn()}));
vi.mock('../../src/sync/local',()=>({lastOrg:()=>null,rememberOrg:vi.fn(),dropPersistedDrafts:vi.fn(),setDraft:vi.fn()}));
vi.mock('../../src/sync/profiles',()=>({mergeProfiles:vi.fn(),ensureProfiles:vi.fn(),resetProfiles:vi.fn()}));
vi.mock('../../src/sync/saved',()=>({loadSavedIds:vi.fn()}));
vi.mock('../../src/sw/register',()=>({purgeMedia:vi.fn()}));
import {api} from '../../src/api/rpc';
import type {BootstrapResult,MeResult,ThreadWindow} from '../../src/api/types';
import type {Outbox} from '../../src/sync/outbox';
import {applyBootstrap,refreshBootstrap,refreshMe,resetOrg,scheduleBootstrapRefresh,scheduleSummaryRefresh} from '../../src/sync/org';
import {getState,resetState,setState} from '../../src/store/state';
import {clearOpen,currentOrgGen,isOpen,markOpen,nextAccessGen,nextOrgGen,setRuntime} from '../../src/sync/runtime';
import {openThread,resetThreads} from '../../src/sync/threads';
import {dropCache} from '../../src/sync/channels';
import {dropPersistedDrafts} from '../../src/sync/local';
import {purgeMedia} from '../../src/sw/register';
import {hub} from '../../src/realtime/hub';
import {channel,server,ORG,USER,CHAN} from '../ui/collaboration-fixture';
function snapshot(count:number,channels=[{...channel,mentions:count}]):BootstrapResult{return {
 org:{id:ORG,name:'QA',slug:'qa',short_name:'QA',logo_path:null,brand_color:'#0F766E',my_role:'member',unread_channels:1,mention_count:count,settings:{}},
 servers:[server],channels,profiles:[],topics:[],server_time:'2026-10-18T00:00:00Z',
} as unknown as BootstrapResult;}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
const drop=vi.fn();
beforeEach(()=>{vi.useFakeTimers();resetOrg();resetThreads();resetState();clearOpen();nextOrgGen();vi.clearAllMocks();vi.mocked(api.bootstrap).mockReset();
setState({orgId:ORG,session:{status:'signed_in',userId:USER,email:null,setup:null},orgs:[snapshot(1).org],channels:{[CHAN]:channel},bootstrap:{status:'ready',error:null,at:1}});
setRuntime({userId:USER,gen:currentOrgGen(),db:Promise.resolve({ok:false} as never),outbox:{dropChannels:drop,snapshot:()=>[]} as unknown as Outbox});});
afterEach(()=>{resetOrg();resetThreads();setRuntime(null);clearOpen();vi.useRealTimers();});
describe('authoritative bootstrap convergence',()=>{
it('refreshes background-org counters with bounded recovery after a failed summary request',async()=>{
 const other='other-org',fresh={orgs:[{id:other,mention_count:0},snapshot(1).org],profile:{id:USER}} as unknown as MeResult;
 setState({orgs:[{...snapshot(1).org,id:other,mention_count:3},snapshot(1).org]});
 vi.mocked(api.bootstrap).mockResolvedValue(snapshot(1));vi.mocked(api.me).mockReset().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(fresh);
 scheduleSummaryRefresh();await vi.advanceTimersByTimeAsync(1100);expect(api.me).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(2100);expect(api.me).toHaveBeenCalledTimes(2);expect(getState().orgs.find(o=>o.id===other)?.mention_count).toBe(0);expect(getState().channels[CHAN]!.mentions).toBe(1);
});
it('invalidates Activity for missed server scope loss even with no loaded channels',()=>{
 const accessBefore=getState().activityVersion;setState({channels:{},servers:{[server.id]:server}});
 applyBootstrap({...snapshot(0,[]),servers:[{...server,my_role:null,access:'browse'}]} as unknown as BootstrapResult);
 expect(getState().activityVersion).toBeGreaterThan(accessBefore);
});
it('refetches a stale me snapshot rather than restoring a revoked organization',async()=>{
 const old=deferred<MeResult>(),fresh={orgs:[],profile:{id:USER}} as unknown as MeResult;
 vi.mocked(api.me).mockReturnValueOnce(old.promise).mockResolvedValueOnce(fresh);
 const reading=refreshMe();nextAccessGen();old.resolve({orgs:[snapshot(1).org],profile:{id:USER}} as unknown as MeResult);
 await reading;expect(api.me).toHaveBeenCalledTimes(2);expect(getState().orgs).toEqual([]);
});
it.each(['not_found','forbidden','suspended'])('purges an authoritative organization %s and cached-only channels',async(code)=>{
 const {DekError}=await import('../../src/api/errors');vi.mocked(api.bootstrap).mockRejectedValueOnce(new DekError(code as never));
 markOpen(CHAN);await refreshBootstrap();expect(getState().orgId).toBeNull();expect(getState().channels).toEqual({});
 expect(drop).toHaveBeenCalledWith(new Set([CHAN,'cached-only']));expect(dropPersistedDrafts).toHaveBeenCalledWith(USER,new Set([CHAN,'cached-only']));
 expect(purgeMedia).toHaveBeenCalledWith([`${ORG}/`]);
});
it('does not lose a confirmed-read refresh behind an older in-flight snapshot',async()=>{
 const old=deferred<BootstrapResult>();vi.mocked(api.bootstrap).mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot(0));
 const initial=refreshBootstrap();scheduleBootstrapRefresh();await vi.advanceTimersByTimeAsync(1100);
 expect(api.bootstrap).toHaveBeenCalledTimes(1);old.resolve(snapshot(1));await initial;
 await vi.advanceTimersByTimeAsync(1000);
 expect(api.bootstrap).toHaveBeenCalledTimes(2);expect(getState().channels[CHAN]!.mentions).toBe(0);expect(getState().orgs[0]!.mention_count).toBe(0);
});
it('an old generation cannot clear or repeat a newer refresh',async()=>{
 const old=deferred<BootstrapResult>(),fresh=deferred<BootstrapResult>();vi.mocked(api.bootstrap).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 const initial=refreshBootstrap();scheduleBootstrapRefresh();nextOrgGen();const newer=refreshBootstrap();old.resolve(snapshot(9));await initial;
 fresh.resolve(snapshot(0));await newer;await vi.advanceTimersByTimeAsync(2000);
 expect(api.bootstrap).toHaveBeenCalledTimes(2);expect(getState().orgs[0]!.mention_count).toBe(0);
});
it('heals missed realtime revocation by purging durable artifacts and rejecting a delayed private thread',async()=>{
 const page=deferred<ThreadWindow>();vi.mocked(api.threadWindow).mockReturnValueOnce(page.promise);
 markOpen(CHAN);setState({drafts:{[CHAN]:'private draft'}});
 const opening=openThread('root',{channelId:CHAN});applyBootstrap(snapshot(0,[]));
 expect(getState().channels[CHAN]).toBeUndefined();expect(getState().drafts).toEqual({});expect(isOpen(CHAN)).toBe(false);
 expect(drop).toHaveBeenCalledWith(new Set([CHAN]));expect(dropCache).toHaveBeenCalledWith(CHAN);
 expect(dropPersistedDrafts).toHaveBeenCalledWith(USER,new Set([CHAN]));expect(purgeMedia).toHaveBeenCalledWith([`${ORG}/${CHAN}/`]);
 expect(hub.leaveView).toHaveBeenCalledWith(CHAN);
 page.resolve({root:{id:'root',org_id:ORG,channel_id:CHAN},replies:[]} as unknown as ThreadWindow);await opening;
 expect(getState().messages.root).toBeUndefined();expect(getState().threads.root).toBeUndefined();
});
});
