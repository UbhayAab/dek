// #105 replaces category nesting. Retain storage, isolation and current-location coverage at server scope.
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {resetState,setState} from '../../src/store';
import {ChannelTree} from '../../src/features/shell/ChannelTree';
import {categoryPreferenceId,collapsedSections,setCollapsed} from '../../src/features/shell/ui-store';
import {ORG,USER,CHAN,SERVER,server,channel} from './collaboration-fixture';
const props={orgId:ORG,activeChannelId:null,onOpen:vi.fn(),variant:'sidebar' as const};
beforeEach(()=>{window.localStorage.clear();resetState();window.history.replaceState(null,'','/');window.matchMedia=((q:string)=>({matches:false,media:q,addEventListener(){},removeEventListener(){}})) as unknown as typeof window.matchMedia;
 setState({session:{status:'signed_in',userId:USER,email:null,setup:null},servers:{[SERVER]:server},channels:{[CHAN]:channel}});});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('flat server channel navigation',()=>{
 it('renders one flat list and no category disclosure',()=>{
  render(<ChannelTree {...props}/>);expect(screen.queryByRole('button',{name:'Projects'})).toBeNull();
  const list=screen.getByRole('list',{name:server.name+' channels'});expect(within(list).getByRole('link',{name:/coordination/})).toBeTruthy();expect(list.querySelector('ul')).toBeNull();
 });
 it('treats General as an ordinary channel and puts new text above existing voice',()=>{
  const general={...channel,id:'general',name:'General',category:'General',position:0},voice={...channel,id:'voice',name:'Voice room',kind:'audio' as const,category:'General',position:-100};
  setState({channels:{[CHAN]:channel,general,voice}});render(<ChannelTree {...props}/>);
  expect(screen.queryByRole('button',{name:'General'})).toBeNull();expect(screen.getByRole('link',{name:/General/})).toBeTruthy();
  act(()=>setState(s=>({channels:{...s.channels,newtext:{...channel,id:'newtext',name:'New text',category:'Z last',position:999}}})));
  const rows=[...screen.getByRole('list',{name:server.name+' channels'}).querySelectorAll('a')].map(x=>x.textContent);
  expect(rows.findIndex(x=>x?.includes('New text'))).toBeLessThan(rows.findIndex(x=>x?.includes('Voice room')));
 });
 it('preserves server collapse, current-location hint and per-user persistence',()=>{
  const view=render(<ChannelTree {...props} activeChannelId={CHAN}/>);fireEvent.click(screen.getByRole('button',{name:server.name}));
  expect(screen.getByText('Current: #coordination')).toBeTruthy();expect(collapsedSections(USER)[SERVER]).toBe(true);expect(screen.queryByRole('link',{name:/coordination/})).toBeNull();
  view.unmount();render(<ChannelTree {...props} variant="home"/>);expect(screen.getByRole('button',{name:new RegExp('^'+server.name+'(?! options)')}).getAttribute('aria-expanded')).toBe('false');
  act(()=>setState({session:{status:'signed_in',userId:'other-user',email:null,setup:null}}));expect(screen.getByRole('button',{name:server.name}).getAttribute('aria-expanded')).toBe('true');
 });
 it('ignores old category collapse preferences and retains renamed channels',()=>{
  setCollapsed(USER,categoryPreferenceId(ORG,SERVER,'Projects'),true);setCollapsed(USER,categoryPreferenceId('other-org',SERVER,'General'),true);
  render(<ChannelTree {...props}/>);expect(screen.getByRole('link',{name:/coordination/})).toBeTruthy();
  act(()=>setState({channels:{[CHAN]:{...channel,category:'Renamed'}}}));expect(screen.getByRole('link',{name:/coordination/})).toBeTruthy();
 });
 it('keeps inaccessible, archived and foreign-organization channels out',()=>{
  setState({channels:{[CHAN]:channel,hidden:{...channel,id:'hidden',name:'Not joined',member:false},old:{...channel,id:'old',name:'Archived',archived:true},foreign:{...channel,id:'foreign',name:'Foreign',org_id:'other'}}});
  render(<ChannelTree {...props}/>);expect(screen.getByRole('list',{name:server.name+' channels'}).querySelectorAll('a')).toHaveLength(1);
 });
 it('makes server settings reachable for delegated Members without making them Admin',()=>{
  render(<ChannelTree {...props}/>);fireEvent.click(screen.getByRole('button',{name:server.name+' options'}));expect(screen.getByRole('menuitem',{name:'Server settings'})).toBeTruthy();expect(screen.queryByText('Admin')).toBeNull();
 });
 it('offers only delete when the effective role can delete but cannot edit',()=>{
  setState({servers:{[SERVER]:{...server,permissions:{delete_channels:true,edit_channels:false} as never}}});render(<ChannelTree {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:channel.name+' options'}));expect(screen.getByRole('menuitem',{name:'Delete channel'})).toBeTruthy();expect(screen.queryByRole('menuitem',{name:'Archive or delete'})).toBeNull();
 });
 it('still collapses a server with unavailable local storage',()=>{
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('Unavailable');});render(<ChannelTree {...props}/>);fireEvent.click(screen.getByRole('button',{name:server.name}));expect(screen.queryByRole('link',{name:/coordination/})).toBeNull();
 });
});
