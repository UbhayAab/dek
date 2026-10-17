import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { OrgSummary, Server } from '../../src/api/types';

vi.mock('../../src/api/rpc',()=>({api:{listServers:vi.fn(),browseChannels:vi.fn(),joinServer:vi.fn(),me:vi.fn()}}));
const {api}=await import('../../src/api/rpc');
const {resetState,setState}=await import('../../src/store');
const {resetFeatureCaches}=await import('../../src/features/admin/common/context');
const {BrowseScreen}=await import('../../src/features/admin/Browse');
const {ServerJoinMethods}=await import('../../src/features/admin/common/ServerJoinMethods');
const org:OrgSummary={id:'org',slug:'qa',name:'Dek QA',short_name:null,brand_color:'#0F766E',logo_path:null,my_role:'member',unread_channels:0,mention_count:0};
const server=(id:string,extra:Partial<Server>={}):Server=>({id,org_id:org.id,name:id,description:null,icon_emoji:null,position:0,join_policy:'invite',archived:false,my_role:null,member_count:2,access:'browse',requested:false,...extra});

beforeEach(()=>{
  resetState();resetFeatureCaches();vi.clearAllMocks();
  setState({orgs:[org]});
  vi.mocked(api.listServers).mockResolvedValue([]);
  vi.mocked(api.browseChannels).mockResolvedValue({channels:[]});
  vi.mocked(api.me).mockResolvedValue({user_id:'qa',email:'qa@dek-test.invalid',profile:{id:'qa',display_name:'QA Member',handle:null,avatar_path:null,title:null,timezone:null,status_text:null,status_emoji:null,status_until:null,last_active_at:null,deleted:false},orgs:[org],prefs:{default_level:'mentions',dm_level:'all',thread_replies:true,quiet_start:null,quiet_end:null,quiet_tz:'Asia/Kolkata',preview:'full'},is_platform_admin:false});
  Element.prototype.scrollIntoView=vi.fn();
});
afterEach(cleanup);

test('invites remain selected and Ask/Open are mutually exclusive, with one or two methods',()=>{
  function Form(){const [value,setValue]=useState<Server['join_policy']>('invite');return <ServerJoinMethods value={value} onChange={setValue}/>;}
  render(<Form/>);
  const invites=screen.getByRole('checkbox',{name:'Invite links'}) as HTMLInputElement;
  const ask=screen.getByRole('checkbox',{name:'Ask to join'}) as HTMLInputElement;
  const open=screen.getByRole('checkbox',{name:'Open'}) as HTMLInputElement;
  expect(invites.checked).toBe(true);expect(invites.disabled).toBe(true);
  fireEvent.click(ask);expect(ask.checked).toBe(true);expect(open.checked).toBe(false);
  fireEvent.click(open);expect(open.checked).toBe(true);expect(ask.checked).toBe(false);
  expect(screen.getAllByRole('checkbox').filter(e=>(e as HTMLInputElement).checked)).toHaveLength(2);
  fireEvent.click(open);expect(open.checked).toBe(false);expect(invites.checked).toBe(true);
});

test('all active server access types appear, even with no channel rows, and can be searched',async()=>{
  vi.mocked(api.listServers).mockResolvedValue([
    server('Joined team',{my_role:'member',access:'member'}),server('Partial team',{access:'partial'}),
    server('Invite team'),server('Approval team',{join_policy:'approval'}),
    server('Open team',{join_policy:'open'}),server('Archived team',{archived:true}),
  ]);
  render(<BrowseScreen orgId={org.id} serverId={null}/>);
  const list=await screen.findByRole('list',{name:'Team servers'});
  expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  expect(within(list).getByText('Partial team')).toBeTruthy();
  expect(within(list).getAllByRole('button',{name:'View channels'})).toHaveLength(2);
  expect(within(list).getByRole('button',{name:'Ask to join'})).toBeTruthy();
  expect(within(list).getByRole('button',{name:'Join'})).toBeTruthy();
  expect(within(list).queryByText('Archived team')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox',{name:'Find a server'}),{target:{value:'Invite team'}});
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  expect(within(list).queryByRole('button')).toBeNull();
});

test('confirmed pending status survives a remount, and a failure does not show a sent request',async()=>{
  vi.mocked(api.listServers).mockResolvedValue([server('Approval team',{join_policy:'approval'})]);
  vi.mocked(api.joinServer).mockRejectedValueOnce(new Error('network'));
  const view=render(<BrowseScreen orgId={org.id} serverId={null}/>);
  const ask=await screen.findByRole('button',{name:'Ask to join'});
  await act(async()=>{fireEvent.click(ask);});
  expect(screen.queryByText('Request sent')).toBeNull();
  expect(screen.getByRole('button',{name:'Ask to join'})).toBeTruthy();
  vi.mocked(api.joinServer).mockResolvedValue({status:'pending'});
  vi.mocked(api.listServers).mockResolvedValue([server('Approval team',{join_policy:'approval',requested:true})]);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Ask to join'}));});
  await waitFor(()=>expect(screen.getAllByText('Request sent').length).toBeGreaterThan(0));
  view.unmount();resetFeatureCaches();
  render(<BrowseScreen orgId={org.id} serverId={null}/>);
  expect(await screen.findByText('Request sent')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Ask to join'})).toBeNull();
});

test('joining immediately refreshes mounted channels, and store changes refetch the directory',async()=>{
  const open=server('Open team',{join_policy:'open'});
  vi.mocked(api.listServers).mockResolvedValue([open]);
  vi.mocked(api.joinServer).mockResolvedValue({status:'joined'});
  render(<BrowseScreen orgId={org.id} serverId={null}/>);
  await screen.findByRole('button',{name:'Join'});
  vi.mocked(api.listServers).mockResolvedValue([{...open,my_role:'member',access:'member'}]);
  vi.mocked(api.browseChannels).mockResolvedValue({channels:[{id:'channel',server_id:open.id,name:'new-channel',kind:'text',visibility:'public',category:null,position:0,posting_policy:'everyone',member:true,locked:false,topic:null,member_count:1,requested:false}]});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Join'}));});
  expect(await screen.findByText('new-channel')).toBeTruthy();
  const before=vi.mocked(api.listServers).mock.calls.length;
  await act(async()=>{setState({servers:{[open.id]:{...open,my_role:'member',access:'member'}}});});
  await waitFor(()=>expect(vi.mocked(api.listServers).mock.calls.length).toBeGreaterThan(before));
});

test('incoming membership changes replace Request sent with Joined without remounting',async()=>{
  const pending=server('Approval team',{join_policy:'approval',requested:true});
  vi.mocked(api.listServers).mockResolvedValue([pending]);
  render(<BrowseScreen orgId={org.id} serverId={null}/>);
  await screen.findByText('Request sent');
  const joined:Server={...pending,requested:false,my_role:'member',access:'member'};
  vi.mocked(api.listServers).mockResolvedValue([joined]);
  await act(async()=>{setState({servers:{[joined.id]:joined}});});
  expect(await screen.findByText('Joined')).toBeTruthy();
  expect(screen.queryByText('Request sent')).toBeNull();
});

test('View channels clears an unrelated channel search before focusing the target group',async()=>{
  vi.mocked(api.listServers).mockResolvedValue([server('Joined team',{my_role:'member',access:'member'})]);
  vi.mocked(api.browseChannels).mockResolvedValue({channels:[{id:'channel',server_id:'Joined team',name:'target-channel',kind:'text',visibility:'public',category:null,position:0,posting_policy:'everyone',member:true,locked:false,topic:null,member_count:1,requested:false}]});
  render(<BrowseScreen orgId={org.id} serverId={null}/>);
  await screen.findByText('target-channel');
  fireEvent.change(screen.getByRole('searchbox',{name:'Find a channel'}),{target:{value:'no match'}});
  expect(screen.queryByText('target-channel')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'View channels'}));
  expect((screen.getByRole('searchbox',{name:'Find a channel'}) as HTMLInputElement).value).toBe('');
  expect(await screen.findByText('target-channel')).toBeTruthy();
});

test.each([['open','Join','joined'],['approval','Ask to join','pending']] as const)('partial access to an %s server still allows %s',async(policy,label,status)=>{
  const partial=server('Partial team',{join_policy:policy,access:'partial'});
  vi.mocked(api.listServers).mockResolvedValue([partial]);
  vi.mocked(api.joinServer).mockResolvedValue({status});
  render(<BrowseScreen orgId={org.id} serverId={null}/>);
  expect(await screen.findByRole('button',{name:'View channels'})).toBeTruthy();
  const join=screen.getByRole('button',{name:label});
  await act(async()=>{fireEvent.click(join);});
  expect(api.joinServer).toHaveBeenCalledWith(partial.id);
});
