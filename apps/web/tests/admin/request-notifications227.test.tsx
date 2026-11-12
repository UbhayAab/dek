import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../src/api/rpc',()=>({api:{me:vi.fn(),listServers:vi.fn(),listJoinRequests:vi.fn(),decideJoinRequest:vi.fn()}}));
vi.mock('../../src/ui/kit',async original=>({...await original<typeof import('../../src/ui/kit')>(),toast:vi.fn()}));
import {api} from '../../src/api/rpc';
import type {JoinRequest,MeResult,OrgSummary,Profile,Server,ServerPermissions} from '../../src/api/types';
import {parse} from '../../src/app/router';
import {ServerSettingsScreen} from '../../src/features/admin/ServerSettings';
import {RequestsSection} from '../../src/features/admin/sections/Requests';
import {DEFAULT_ORG_SETTINGS,resetFeatureCaches} from '../../src/features/admin/common/context';
import {SERVER_PERMISSION_LABELS} from '../../src/lib/server-permissions';
import {getState,resetState,setState} from '../../src/store';
import {onJoinRequest,onServerJoinRequest,serverRequestPath} from '../../src/sync/requests';
import {toast} from '../../src/ui/kit';
import {ORG,USER,SERVER,server} from '../ui/collaboration-fixture';

let serial=0;
const person:Profile={id:USER,display_name:'Fictional Approver',handle:null,avatar_path:null,title:null,timezone:'UTC',status_text:null,status_emoji:null,status_until:null,last_active_at:null,deleted:false};
const summary=(role:OrgSummary['my_role']='member'):OrgSummary=>({id:ORG,slug:'fictional-approval',name:'Fictional approval organization',short_name:null,brand_color:'#0F766E',logo_path:null,my_role:role,unread_channels:0,mention_count:0});
const caps=(allowed=true):ServerPermissions=>Object.fromEntries(Object.keys(SERVER_PERMISSION_LABELS).map(k=>[k,k==='decide_join_requests'&&allowed])) as ServerPermissions;
const notice=(patch:Partial<Parameters<typeof onServerJoinRequest>[0]>={})=>({org_id:ORG,server_id:SERVER,request_id:`fictional-request-${++serial}`,user_id:'fictional-requester',change:'new' as const,...patch});
function signIn(role:OrgSummary['my_role']='member',team:Server={...server,my_role:'moderator',permissions:caps(),permission_version:1}){
 const org=summary(role);
 const me:MeResult={user_id:USER,email:'owned@dek-test.invalid',profile:person,orgs:[org],is_platform_admin:false,
  prefs:{default_level:'mentions',dm_level:'all',thread_replies:true,quiet_start:null,quiet_end:null,quiet_tz:'UTC',preview:'full'}};
 setState({orgId:ORG,org:{...org,settings:DEFAULT_ORG_SETTINGS},orgs:[org],me,
  session:{status:'signed_in',userId:USER,email:me.email,setup:null},servers:{[SERVER]:team},bootstrap:{status:'ready',error:null,at:1}});
 vi.mocked(api.listServers).mockResolvedValue([team]);vi.mocked(api.me).mockResolvedValue(me);
}
const requestRow=(id='pending-row'):JoinRequest=>({id,user:{...person,id:'fictional-requester',display_name:'Fictional Request Sender'},email:null,server_id:SERVER,invite_id:null,note:null,status:'pending',created_at:'2026-11-12T00:00:00Z'});
beforeAll(()=>{
 window.matchMedia=(q:string)=>({matches:false,media:q,onchange:null,dispatchEvent:()=>false,
  addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
});
beforeEach(()=>{
 resetState();resetFeatureCaches();vi.clearAllMocks();window.history.replaceState(null,'','/');
 vi.mocked(api.listJoinRequests).mockReset().mockResolvedValue({items:[]});signIn();
});
afterEach(()=>{cleanup();resetFeatureCaches();});

describe('actual request notices and review destinations',()=>{
 it.each(['owner','admin'] as const)('opens organization Join requests for an organization %s',role=>{
  signIn(role);onServerJoinRequest(notice());
  const n=vi.mocked(toast).mock.calls[0]![0];expect(n.title).toBe('Someone asked to join a team server');n.action!.onClick();
  expect(parse(window.location.href)).toEqual({name:'admin',orgId:ORG,section:'requests'});
 });
 it('opens the granted server request tab for a Moderator, retaining the hash',()=>{
  onServerJoinRequest(notice());vi.mocked(toast).mock.calls[0]![0].action!.onClick();
  expect(parse(window.location.href)).toEqual({name:'serverSettings',orgId:ORG,serverId:SERVER});expect(window.location.hash).toBe('#requests');
 });
 it('handles organization-only and cross-organization requests without using the current org role',()=>{
  expect(serverRequestPath(ORG,null,'member')).toBe(`/o/${ORG}/admin/requests`);
  const other='0f000000-0000-4000-8000-000000000099';
  signIn('admin');onServerJoinRequest(notice({org_id:other}));vi.mocked(toast).mock.calls[0]![0].action!.onClick();
  expect(window.location.pathname).toBe(`/o/${other}/s/${SERVER}/settings`);expect(window.location.hash).toBe('#requests');
 });
 it('coalesces a duplicate new request but lets another signed-in approver receive it',()=>{
  const p=notice();onServerJoinRequest(p);onServerJoinRequest(p);expect(toast).toHaveBeenCalledTimes(1);
  setState({session:{...getState().session,userId:'fictional-other-approver'}});onServerJoinRequest(p);expect(toast).toHaveBeenCalledTimes(2);
 });
 it('never shows a new-request notice to the requester or a signed-out session',()=>{
  onServerJoinRequest(notice({user_id:USER}));expect(toast).not.toHaveBeenCalled();
  setState({session:{...getState().session,userId:null,status:'signed_out'}});onServerJoinRequest(notice());expect(toast).not.toHaveBeenCalled();
 });
 it('retains the channel0916 review destination and wording',()=>{
  onJoinRequest({org_id:ORG,channel_id:'fictional-channel',user_id:'fictional-requester',change:'new'});
  const n=vi.mocked(toast).mock.calls[0]![0];expect(n.title).toBe('Someone asked to join a channel');n.action!.onClick();
  expect(window.location.pathname+window.location.search).toBe(`/o/${ORG}/activity?tab=requests`);
 });
});

describe('open request lists respond to real notice revisions',()=>{
 it('refreshes the granted Moderator server list after both a new request and a remote decision',async()=>{
  window.history.replaceState(null,'',`/o/${ORG}/s/${SERVER}/settings#requests`);
  render(<ServerSettingsScreen orgId={ORG} serverId={SERVER}/>);await screen.findByText('Nobody is waiting');
  vi.mocked(api.listJoinRequests).mockResolvedValue({items:[requestRow()]});
  act(()=>onServerJoinRequest(notice()));await screen.findByText('Fictional Request Sender');
  vi.mocked(api.listJoinRequests).mockResolvedValue({items:[]});
  act(()=>onServerJoinRequest(notice({request_id:'pending-row',change:'approved'})));
  await waitFor(()=>expect(screen.queryByText('Fictional Request Sender')).toBeNull());
  expect(api.listJoinRequests).toHaveBeenCalledTimes(3);
 });
 it('refreshes organization requests without changing the selected status',async()=>{
  signIn('admin');render(<RequestsSection ctx={{orgId:ORG,orgName:summary().name,myId:USER,role:'admin',settings:DEFAULT_ORG_SETTINGS,pendingCount:0,openReports:0,refreshCounts:vi.fn()}}/>);
  await screen.findByText('Nobody is waiting');vi.mocked(api.listJoinRequests).mockResolvedValue({items:[requestRow()]});
  act(()=>onServerJoinRequest(notice()));await screen.findByText('Fictional Request Sender');
  expect(api.listJoinRequests).toHaveBeenLastCalledWith(ORG,'pending');
 });
});
