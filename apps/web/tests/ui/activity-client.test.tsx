import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
vi.mock('../../src/api/rpc',()=>({api:{listActivityInbox:vi.fn(),setActivityState:vi.fn()}}));
vi.mock('../../src/realtime/hub',()=>({hub:{leaveView:vi.fn()}}));
vi.mock('../../src/sw/register',()=>({purgeMedia:vi.fn()}));
import {api} from '../../src/api/rpc';
import {DekError} from '../../src/api/errors';
import {ActivityInbox,ActivityRow} from '../../src/features/views/ActivityInbox';
import {registerActions,resetState,setState,useDek} from '../../src/store';
import {Toaster} from '../../src/ui/kit';
import {purgeLocal} from '../../src/sync/access';
import type {ActivityItem} from '../../src/api/types';
import {channel,ORG,USER,CHAN} from './collaboration-fixture';
function deferred<T>(){let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
const item={message:{id:'tagged',org_id:ORG,channel_id:CHAN,author_id:USER,seq:4,thread_root_id:'root',kind:'user',body:'private tagged reply',mentions:[],mention_all:false,created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-18T00:00:00Z',deleted_at:null,client_id:null,edited_at:null,last_reply_at:null,reply_user_ids:[],pinned:false,also_in_channel:false,meta:{},reply_count:0,reactions:{},attachments:[]},channel,read:false,activity:{revision:0,cleared:false,through_seq:4}} as ActivityItem;
const page={items:[item],has_more:false,next_cursor:null};
beforeEach(()=>{resetState();vi.clearAllMocks();vi.mocked(api.listActivityInbox).mockReset().mockResolvedValue(page);vi.mocked(api.setActivityState).mockReset();setState({orgId:ORG,session:{status:'signed_in',userId:USER,email:null,setup:null},channels:{[CHAN]:channel},connection:{online:true,realtime:'online',leader:true}});registerActions({refreshBootstrap:vi.fn(async()=>{}),ensureProfiles:vi.fn()});});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('Activity persistence and lifetime',()=>{
 it('refreshes authoritative state after conflict rather than replaying a stale new intent',async()=>{
  vi.mocked(api.setActivityState).mockRejectedValueOnce(new DekError('conflict'));
  render(<ActivityRow item={item} kind="mention" orgId={ORG} deeper onChanged={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Mark read'}));await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Try again'})).toBeNull();expect(screen.getByRole('button',{name:'Refresh'})).toBeTruthy();
 });
 it('terminal denied action immediately invalidates private inbox snapshots',async()=>{
  vi.mocked(api.setActivityState).mockRejectedValueOnce(new DekError('not_found'));vi.mocked(api.listActivityInbox).mockResolvedValueOnce(page).mockResolvedValue({items:[],has_more:false,next_cursor:null});
  render(<ActivityInbox orgId={ORG} layout="phone" kind="mention"/>);await screen.findByText('private tagged reply');fireEvent.click(screen.getByRole('button',{name:'Mark read'}));await screen.findByText('You are caught up');expect(screen.queryByText('private tagged reply')).toBeNull();
 });
 it('makes one initial fetch and keeps exactly the shown notification while read confirmation is pending',async()=>{
  const confirmation=deferred<Awaited<ReturnType<typeof api.setActivityState>>>();vi.mocked(api.setActivityState).mockReturnValueOnce(confirmation.promise);vi.mocked(api.listActivityInbox).mockResolvedValueOnce(page).mockResolvedValue({items:[],has_more:false,next_cursor:null});
  render(<ActivityInbox orgId={ORG} layout="phone" kind="mention"/>);await screen.findByText('private tagged reply');expect(api.listActivityInbox).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Mark read'}));expect(screen.getByText('private tagged reply')).toBeTruthy();expect(screen.getByText('Marking read...')).toBeTruthy();
  expect(api.setActivityState).toHaveBeenCalledWith('mention','tagged','read',0,expect.any(String),4);
  confirmation.resolve({revision:1,cleared:false,through_seq:4,read:true,operation_id:'op'});await screen.findByText('You are caught up');
 });
 it('keeps failed row and retries the same operation, revision and snapshot after a lost response',async()=>{
  vi.mocked(api.setActivityState).mockRejectedValueOnce(Error('Failed to fetch')).mockResolvedValueOnce({revision:1,cleared:false,through_seq:4,read:true,operation_id:'op'});
  render(<ActivityRow item={item} kind="mention" orgId={ORG} deeper onChanged={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Mark read'}));await screen.findByRole('alert');
  const request=vi.mocked(api.setActivityState).mock.calls[0];fireEvent.click(screen.getByRole('button',{name:'Try again'}));await vi.waitFor(()=>expect(api.setActivityState).toHaveBeenCalledTimes(2));expect(vi.mocked(api.setActivityState).mock.calls[1]).toEqual(request);
 });
 it('purges visible private snapshots immediately on revoke and fences a deferred pre-revoke response',async()=>{
  const old=deferred<typeof page>();vi.mocked(api.listActivityInbox).mockResolvedValueOnce(page).mockReturnValueOnce(old.promise).mockResolvedValue({items:[],has_more:false,next_cursor:null});
  render(<ActivityInbox orgId={ORG} layout="phone" kind="mention"/>);await screen.findByText('private tagged reply');fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  act(()=>purgeLocal(new Set([CHAN]),ORG));expect(screen.queryByText('private tagged reply')).toBeNull();old.resolve(page);await screen.findByText('You are caught up');expect(screen.queryByText('private tagged reply')).toBeNull();
 });
 it('also invalidates snapshots for an empty known-channel server revoke',async()=>{
  render(<ActivityInbox orgId={ORG} layout="phone" kind="mention"/>);await screen.findByText('private tagged reply');vi.mocked(api.listActivityInbox).mockResolvedValue({items:[],has_more:false,next_cursor:null});
  act(()=>purgeLocal(new Set(),ORG));expect(screen.queryByText('private tagged reply')).toBeNull();await screen.findByText('You are caught up');
 });
 it('does not starve a refresh during continuous events',async()=>{
  vi.useFakeTimers();render(<ActivityInbox orgId={ORG} layout="phone" kind="mention"/>);await act(async()=>{await Promise.resolve();});expect(api.listActivityInbox).toHaveBeenCalledTimes(1);
  for(let n=0;n<6;n++){act(()=>setState({activityVersion:useDek.getState().activityVersion+1}));await act(async()=>vi.advanceTimersByTimeAsync(80));}
  expect(api.listActivityInbox).toHaveBeenCalledTimes(3);
 });
 it('Clear offers revision-bound Undo; a clear menu click never opens the conversation',async()=>{
  const changed=vi.fn();vi.mocked(api.setActivityState).mockResolvedValue({revision:19,cleared:true,through_seq:4,read:false,operation_id:'clear'});
  render(<><ActivityRow item={item} kind="mention" orgId={ORG} deeper onChanged={changed}/><Toaster/></>);const row=screen.getByRole('article');fireEvent.contextMenu(row);fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem',{name:'Clear from inbox'}));
  await vi.waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));expect(api.setActivityState).toHaveBeenCalledWith('mention','tagged','clear',0,expect.any(String),4);
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));await vi.waitFor(()=>expect(api.setActivityState).toHaveBeenCalledTimes(2));expect(api.setActivityState).toHaveBeenLastCalledWith('mention','tagged','restore',19,expect.any(String));
 });
});
