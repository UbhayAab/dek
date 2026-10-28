import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../src/api/rpc',()=>({api:{me:vi.fn(),listServers:vi.fn(),listChannels:vi.fn(),createChannel:vi.fn(),getServerRolePolicy:vi.fn(),setServerRolePolicy:vi.fn(),setServerMemberControl:vi.fn(),listServerMemberControls:vi.fn(),listServerActivity:vi.fn(),listInvites:vi.fn(),createInvite:vi.fn(),listServerMembers:vi.fn(),getProfiles:vi.fn()}}));
import {api} from '../../src/api/rpc';
import {DekError} from '../../src/api/errors';
import type {ControlledServerMember,MeResult,Profile,Server,ServerActivityItem,ServerPermissions,ServerRolePolicy} from '../../src/api/types';
import {ServerControlDialog,ServerControlsTab,ServerPermissionsTab,ServerActivityTab,controlActions} from '../../src/features/admin/ServerPolicy';
import {ServerSettingsScreen} from '../../src/features/admin/ServerSettings';
import {ChannelSettingsScreen} from '../../src/features/admin/ChannelSettings';
import {SERVER_PERMISSION_LABELS} from '../../src/lib/server-permissions';
import {getState,resetState,setState} from '../../src/store';
import {noteServerTime} from '../../src/sync/runtime';
import {channel,server,USER,ORG} from '../ui/collaboration-fixture';
const PERSON={id:'member-id',display_name:'Fictional Member',handle:'fictional',avatar_path:null} as Profile;
function caps(p:Partial<ServerPermissions>={}):ServerPermissions{return {...Object.fromEntries(Object.keys(SERVER_PERMISSION_LABELS).map(k=>[k,false])),...p} as ServerPermissions;}
const ADMIN:Server={...server,my_role:'admin',permission_version:1,permissions:caps(Object.fromEntries(Object.keys(SERVER_PERMISSION_LABELS).map(k=>[k,true]))),can_manage_permissions:true};
function policy(version=1):ServerRolePolicy{return {server_id:server.id,version,can_manage:true,actions:Object.keys(SERVER_PERMISSION_LABELS) as ServerRolePolicy['actions'],roles:{admin:{defaults:ADMIN.permissions!,effective:ADMIN.permissions!,overrides:{},locked:true},moderator:{defaults:caps({pin_messages:true}),effective:caps({pin_messages:true}),overrides:{},locked:false},member:{defaults:caps(),effective:caps(),overrides:{},locked:false}}};}
function signIn(s:Server=ADMIN){
 const summary={id:ORG,name:'Fictional QA',slug:'fictional-qa',my_role:'member' as const,brand_color:'#0F766E',settings:{allow_guests:true,default_invite_hours:168,member_can_create_channels:true,member_can_invite:false}};
 setState({orgId:ORG,org:summary as never,session:{status:'signed_in',userId:USER,email:null,setup:null},me:{user_id:USER,profile:{id:USER,display_name:'Fictional Admin'},orgs:[summary]} as unknown as MeResult,orgs:[summary] as never,servers:{[s.id]:s},channels:{[channel.id]:channel},bootstrap:{status:'ready',error:null,at:1}});
 vi.mocked(api.listServers).mockResolvedValue([s]);
}
beforeAll(()=>{
 HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 window.matchMedia=((q:string)=>({matches:false,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}})) as unknown as typeof window.matchMedia;
});
beforeEach(()=>{
 resetState();vi.clearAllMocks();window.history.replaceState(null,'','/');noteServerTime(new Date(Date.now()).toISOString(),Date.now(),Date.now());
 vi.mocked(api.getServerRolePolicy).mockReset().mockResolvedValue(policy());vi.mocked(api.setServerRolePolicy).mockReset().mockImplementation(async(_s,role,patch)=>{const p=policy(2);p.roles[role].effective={...p.roles[role].effective,...patch};return p;});
 vi.mocked(api.listServerMemberControls).mockReset().mockResolvedValue({items:[]});vi.mocked(api.listServerActivity).mockReset().mockResolvedValue({items:[],has_more:false,next_before:null});
 vi.mocked(api.listServerMembers).mockReset().mockResolvedValue({items:[{profile:PERSON,role:'member',joined_at:'2026-10-28T00:00:00Z'}],total:1});
 vi.mocked(api.listInvites).mockResolvedValue({items:[]});vi.mocked(api.getProfiles).mockResolvedValue([]);vi.mocked(api.listChannels).mockResolvedValue([channel]);
 vi.mocked(api.setServerMemberControl).mockResolvedValue({server_id:server.id,user_id:PERSON.id,changed:true,control:{muted:false,muted_until:null,suspended:false,banned:false}});
 signIn();
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

describe('rendered role policy editor',()=>{
 it('saves only changed keys with the displayed native version',async()=>{
  render(<ServerPermissionsTab server={ADMIN} orgRole="member"/>);
  const create=await screen.findByRole('checkbox',{name:'Create channels'});fireEvent.click(create);
  fireEvent.click(screen.getByRole('button',{name:'Save role permissions'}));
  await waitFor(()=>expect(api.setServerRolePolicy).toHaveBeenCalledWith(server.id,'moderator',{create_channels:true},1,false));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Save role permissions'}) as HTMLButtonElement).disabled).toBe(true));expect((screen.getByRole('checkbox',{name:'Create channels'}) as HTMLInputElement).checked).toBe(true);
 });
 it('keeps separate unsaved choices while switching roles and shows fixed Admin rights',async()=>{
  render(<ServerPermissionsTab server={ADMIN} orgRole="member"/>);fireEvent.click(await screen.findByRole('checkbox',{name:'Create channels'}));
  fireEvent.change(screen.getByLabelText('Server role'),{target:{value:'member'}});expect((screen.getByRole('checkbox',{name:'Create channels'}) as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText('Server role'),{target:{value:'moderator'}});expect((screen.getByRole('checkbox',{name:'Create channels'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('Server role'),{target:{value:'admin'}});expect(screen.getAllByRole('checkbox')).toHaveLength(15);expect(screen.getAllByRole('checkbox').every(x=>(x as HTMLInputElement).disabled)).toBe(true);
  expect(screen.queryByRole('button',{name:'Save role permissions'})).toBeNull();expect(screen.queryByRole('checkbox',{name:'Manage permissions'})).toBeNull();
 });
 it('keeps the draft after a conflict until deliberate reload',async()=>{
  vi.mocked(api.setServerRolePolicy).mockRejectedValueOnce(new DekError('conflict','Role permissions changed elsewhere. Reload them before saving.'));
  const latest=policy(3);latest.roles.moderator.effective.create_channels=false;vi.mocked(api.getServerRolePolicy).mockResolvedValueOnce(policy()).mockResolvedValueOnce(latest);
  render(<ServerPermissionsTab server={ADMIN} orgRole="member"/>);fireEvent.click(await screen.findByRole('checkbox',{name:'Create channels'}));fireEvent.click(screen.getByRole('button',{name:'Save role permissions'}));
  const reload=await screen.findByRole('button',{name:'Reload latest and discard draft'});expect((screen.getByRole('checkbox',{name:'Create channels'}) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('button',{name:'Save role permissions'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(reload);
  await waitFor(()=>expect(api.getServerRolePolicy).toHaveBeenCalledTimes(2));await waitFor(()=>expect((screen.getByRole('checkbox',{name:'Create channels'}) as HTMLInputElement).checked).toBe(false));
 });
 it('preserves choices while current access is masked and requires reload after a newer version',async()=>{
  const view=render(<ServerPermissionsTab server={ADMIN} orgRole="member"/>);fireEvent.click(await screen.findByRole('checkbox',{name:'Create channels'}));
  view.rerender(<ServerPermissionsTab server={{...ADMIN,permissions_stale:true}} orgRole="member"/>);
  expect((screen.getByRole('checkbox',{name:'Create channels'}) as HTMLInputElement).checked).toBe(true);expect((screen.getByRole('button',{name:'Save role permissions'}) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<ServerPermissionsTab server={{...ADMIN,permission_version:2}} orgRole="member"/>);
  expect(screen.getByRole('button',{name:'Reload latest and discard draft'})).toBeTruthy();expect((screen.getByRole('button',{name:'Save role permissions'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('requires confirmation for reset and sends an empty map',async()=>{
  render(<ServerPermissionsTab server={ADMIN} orgRole="member"/>);await screen.findByRole('checkbox',{name:'Create channels'});
  fireEvent.click(screen.getByRole('button',{name:'Reset role to defaults'}));expect(api.setServerRolePolicy).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Reset to defaults'}));
  await waitFor(()=>expect(api.setServerRolePolicy).toHaveBeenCalledWith(server.id,'moderator',{},1,true));
 });
});

describe('server-only member controls and safe activity',()=>{
 it('offers only the independent granted action, with protected self/Admin/peer boundaries',()=>{
  const s={...server,permissions:caps({ban_members:true})};
  expect(controlActions(s,USER,{id:PERSON.id,role:'member'})).toEqual(['ban']);
  for(const target of [{id:USER,role:'member' as const},{id:PERSON.id,role:'admin' as const},{id:PERSON.id,role:'moderator' as const},{id:PERSON.id,role:'member' as const,orgRole:'owner' as const}])expect(controlActions(s,USER,target)).toEqual([]);
  expect(controlActions(ADMIN,USER,{id:PERSON.id,role:'member'},{muted:true,muted_until:'2020-01-01T00:00:00Z',suspended:false,banned:false})).toContain('mute');
 });
 it('confirms a bounded mute using server time without touching organization membership',async()=>{
  const clock=Date.parse('2026-10-28T00:00:00Z');vi.spyOn(Date,'now').mockReturnValue(clock);noteServerTime(new Date(clock).toISOString(),clock,clock);
  render(<ServerControlDialog server={ADMIN} myId={USER} orgRole="member" person={PERSON} role="member" onClose={()=>{}} onDone={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('Mute for'),{target:{value:'24'}});fireEvent.change(screen.getByLabelText('Reason (optional)'),{target:{value:'Fictional test'}});
  expect(api.setServerMemberControl).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Confirm mute'}));
  await waitFor(()=>expect(api.setServerMemberControl).toHaveBeenCalledWith(server.id,PERSON.id,'mute','2026-10-29T00:00:00.000Z','Fictional test'));
 });
 it('disables confirmation if a permission is revoked while the dialog is open',()=>{
  const view=render(<ServerControlDialog server={ADMIN} myId={USER} orgRole="member" person={PERSON} role="member" onClose={()=>{}} onDone={()=>{}}/>);
  view.rerender(<ServerControlDialog server={{...ADMIN,permissions:caps()}} myId={USER} orgRole="member" person={PERSON} role="member" onClose={()=>{}} onDone={()=>{}}/>);
  expect((screen.getByRole('button',{name:'Confirm mute'}) as HTMLButtonElement).disabled).toBe(true);expect(api.setServerMemberControl).not.toHaveBeenCalled();
 });
 it('unbans a former member from the controls list and explains that private channels are not restored',async()=>{
  const x:ControlledServerMember={profile:PERSON,role:'member',control:{muted:false,muted_until:null,suspended:false,banned:true},reason:null,updated_at:'2026-10-28T00:00:00Z'};
  vi.mocked(api.listServerMemberControls).mockResolvedValueOnce({items:[x]}).mockResolvedValue({items:[]});
  render(<ServerControlsTab server={ADMIN} myId={USER} orgRole="member"/>);fireEvent.click(await screen.findByRole('button',{name:`Manage ${PERSON.display_name}`}));
  expect(screen.getByText(/does not restore old membership/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Confirm unban'}));
  await waitFor(()=>expect(api.setServerMemberControl).toHaveBeenCalledWith(server.id,PERSON.id,'unban',null,null));await screen.findByText('No active restrictions');
 });
 it('renders only the safe activity view and paginates with the native cursor',async()=>{
  const row={id:90,actor:PERSON,person:null,action:'server.permissions_updated',details:{role:'member',body:'PRIVATE BODY'},created_at:'2026-10-28T00:00:00Z'} as unknown as ServerActivityItem;
  vi.mocked(api.listServerActivity).mockResolvedValueOnce({items:[row],has_more:true,next_before:90}).mockResolvedValueOnce({items:[{...row,id:89,action:'unknown.internal'}],has_more:false,next_before:null});
  render(<ServerActivityTab server={ADMIN}/>);await screen.findByText('Updated role permissions (Member)');expect(screen.queryByText('PRIVATE BODY')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Show more'}));await waitFor(()=>expect(api.listServerActivity).toHaveBeenLastCalledWith(server.id,90));await screen.findByText('Updated this server');expect(screen.queryByText('unknown.internal')).toBeNull();
 });
});

describe('actual settings screens consume current capabilities',()=>{
 it('removes server actions when the authoritative store changes despite a stale feature-cache response',async()=>{
  const s={...ADMIN,permissions:caps({edit_server:true})};signIn(s);render(<ServerSettingsScreen orgId={ORG} serverId={server.id}/>);await screen.findByRole('button',{name:'Save changes'});
  act(()=>setState({servers:{[server.id]:{...s,permissions:caps()}}}));await waitFor(()=>expect(screen.queryByRole('button',{name:'Save changes'})).toBeNull());
  expect(screen.getByRole('heading',{name:'About this team server'})).toBeTruthy();
 });
 it('gives delegated invite managers only a fixed server Member invite',async()=>{
  const s={...server,permissions:caps({invite_people:true}),permission_version:1,can_manage_permissions:false};signIn(s);
  vi.mocked(api.listChannels).mockResolvedValue([channel,{...channel,id:'foreign',server_id:'other',name:'Foreign channel'}]);
  window.history.replaceState(null,'',`/o/${ORG}/s/${server.id}/settings#invites`);render(<ServerSettingsScreen orgId={ORG} serverId={server.id}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Create invite link'}));const modal=screen.getByRole('dialog',{name:'Create an invite link'});
  expect(within(modal).queryByText('Invite as')).toBeNull();expect(within(modal).queryByLabelText('Team server (optional)')).toBeNull();expect(within(modal).queryByText('#Foreign channel')).toBeNull();
  expect(within(modal).getByText(/Organization and guest invitations require/)).toBeTruthy();
 });
 it('splits channel deletion from editing even for a channel owner',async()=>{
  signIn({...server,permissions:caps({delete_channels:true}),permission_version:1,can_manage_permissions:false});
  vi.mocked(api.listChannels).mockResolvedValue([{...channel,my_role:'owner'}]);window.history.replaceState(null,'',`/o/${ORG}/c/${channel.id}/settings#danger`);
  render(<ChannelSettingsScreen orgId={ORG} channelId={channel.id}/>);await screen.findByRole('button',{name:'Delete channel'});expect(screen.queryByRole('button',{name:'Archive channel'})).toBeNull();
 });
 it('refreshes an open roster after a membership event revision',async()=>{
  window.history.replaceState(null,'',`/o/${ORG}/s/${server.id}/settings#members`);render(<ServerSettingsScreen orgId={ORG} serverId={server.id}/>);await screen.findByText(PERSON.display_name);
  const before=vi.mocked(api.listServerMembers).mock.calls.length;act(()=>setState({serverMemberVersion:getState().serverMemberVersion+1}));await waitFor(()=>expect(vi.mocked(api.listServerMembers).mock.calls.length).toBeGreaterThan(before));
 });
 it('does not offer channel creation from an old organization setting when the native grant is false',async()=>{
  signIn({...server,permissions:caps(),permission_version:1,can_manage_permissions:false});window.history.replaceState(null,'',`/o/${ORG}/s/${server.id}/settings#channels`);
  render(<ServerSettingsScreen orgId={ORG} serverId={server.id}/>);await screen.findByRole('heading',{name:'Channels'});expect(screen.queryByRole('button',{name:'New channel'})).toBeNull();
 });
 it('creates a channel with only Create channels, without silently adding people or automatic membership',async()=>{
  signIn({...server,permissions:caps({create_channels:true}),permission_version:1,can_manage_permissions:false});vi.mocked(api.createChannel).mockResolvedValue({...channel,id:'new-channel',name:'fictional-room'});
  window.history.replaceState(null,'',`/o/${ORG}/s/${server.id}/settings#channels`);render(<ServerSettingsScreen orgId={ORG} serverId={server.id}/>);fireEvent.click(await screen.findByRole('button',{name:'New channel'}));
  const modal=screen.getByRole('dialog',{name:`New channel in ${server.name}`});expect(within(modal).queryByRole('switch',{name:'Everyone joins automatically'})).toBeNull();expect(within(modal).queryByText('Add people now (optional)')).toBeNull();
  fireEvent.change(within(modal).getByLabelText('Name'),{target:{value:'fictional-room'}});fireEvent.click(within(modal).getByRole('button',{name:'Create channel'}));
  await waitFor(()=>expect(api.createChannel).toHaveBeenCalledWith(expect.objectContaining({server:server.id,name:'fictional-room',memberIds:[],autoJoin:false})));
 });
});
