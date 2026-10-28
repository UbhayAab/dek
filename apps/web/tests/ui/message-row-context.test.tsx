import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
vi.mock('../../src/features/media',()=>({MessageAttachments:()=>null}));
import {MessageRow,type RowContext} from '../../src/features/conversation/MessageRow';
import {registerActions,resetState,setState} from '../../src/store';
import type {Message} from '../../src/api/types';
import {channel,server,ORG,USER,CHAN} from './collaboration-fixture';
const open=vi.fn(),reaction=vi.fn(async()=>{});
const base:Message={id:'reply',channel_id:CHAN,org_id:ORG,seq:2,thread_root_id:'original-root',author_id:'peer',kind:'user',body:'Pressed reply',mentions:[],mention_all:false,client_id:null,created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-18T00:00:00Z',edited_at:null,deleted_at:null,reply_count:0,last_reply_at:null,reply_user_ids:[],reactions:{},attachments:[],pinned:false,also_in_channel:false,meta:{}};
const ctx:RowContext={orgId:ORG,channel,who:{meId:USER,orgRole:'member',server},settings:null,inThread:true,onOpenThread:open,md:{}};
beforeEach(()=>{resetState();vi.clearAllMocks();registerActions({ensureProfiles:vi.fn(),toggleReaction:reaction});setState({orgId:ORG,session:{status:'signed_in',userId:USER,email:null,setup:null},channels:{[CHAN]:channel},messages:{reply:{...base}}});});afterEach(cleanup);
describe('actual message contextual action model',()=>{
 it.each(['channel','server'])('archived %s keeps safe own-message actions and denies posting/edit/pin/nonmoderator delete',scope=>{
  setState({messages:{reply:{...base,author_id:USER}}});render(<MessageRow id="reply" ctx={{...ctx,channel:{...channel,archived:scope==='channel'},who:{...ctx.who,server:{...server,archived:scope==='server'}}}} grouped={false} highlighted={false}/>);fireEvent.contextMenu(screen.getByRole('article'));
  for(const name of ['Reply in thread','Add reaction','Edit message','Pin to conversation','Delete message'])expect(screen.queryByRole('menuitem',{name})).toBeNull();expect(screen.getByRole('menuitem',{name:'Open thread'})).toBeTruthy();expect(screen.getByRole('menuitem',{name:'Save for later'})).toBeTruthy();
 });
 it('replying to a reply opens its original root through the same menu and emoji applies once to that reply',async()=>{
  render(<MessageRow id="reply" ctx={ctx} grouped={false} highlighted={false}/>);const row=screen.getByRole('article');
  fireEvent.contextMenu(row);fireEvent.click(screen.getByRole('menuitem',{name:'Reply in thread'}),{detail:1});expect(open).toHaveBeenCalledExactlyOnceWith('original-root');
  fireEvent.contextMenu(row);fireEvent.click(screen.getByRole('menuitem',{name:'React with 👍'}),{detail:1});await vi.waitFor(()=>expect(reaction).toHaveBeenCalledExactlyOnceWith('reply','👍'));
 });
 it.each(['archived','deleted','replies-off'])('keeps Open thread while %s forbids posting',state=>{
  const m={...base,deleted_at:state==='deleted'?'2026-10-18T01:00:00Z':null};setState({messages:{reply:m}});
  render(<MessageRow id="reply" ctx={{...ctx,channel:{...channel,archived:state==='archived',allow_replies:state!=='replies-off'}}} grouped={false} highlighted={false}/>);
  fireEvent.contextMenu(screen.getByRole('article'));expect(screen.getByRole('menuitem',{name:'Open thread'})).toBeTruthy();expect(screen.queryByRole('menuitem',{name:'Reply in thread'})).toBeNull();
  if(state!=='replies-off')expect(screen.queryByRole('menuitem',{name:'Add reaction'})).toBeNull();
 });
 it('system context exposes useful copying without user-only actions',()=>{
  setState({messages:{reply:{...base,kind:'system',thread_root_id:null,author_id:null}}});render(<MessageRow id="reply" ctx={ctx} grouped={false} highlighted={false}/>);fireEvent.contextMenu(screen.getByRole('article'));
  expect(screen.getByRole('menuitem',{name:'Copy link'})).toBeTruthy();for(const name of ['Add reaction','Reply in thread','Edit message','Delete message','Save for later'])expect(screen.queryByRole('menuitem',{name})).toBeNull();
 });
});

