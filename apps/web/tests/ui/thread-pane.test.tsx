import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
vi.mock('../../src/features/conversation/MessageRow',()=>({MessageRow:({id}:{id:string})=><div data-message-id={id}>{id}</div>,PendingRow:()=>null}));
vi.mock('../../src/features/conversation/Composer',()=>({Composer:()=> <textarea aria-label="Reply in thread"/>}));
vi.mock('../../src/features/conversation/TypingLine',()=>({TypingLine:()=>null}));
import {ThreadPane} from '../../src/features/conversation/ThreadPane';
import type {RowContext} from '../../src/features/conversation/MessageRow';
import type {Message} from '../../src/api/types';
import {registerActions,resetState,setState} from '../../src/store';
import {channel,server,ORG,USER,CHAN} from './collaboration-fixture';
const opened=vi.fn(async()=>{}),read=vi.fn(),nav=vi.fn();
const ctx:RowContext={orgId:ORG,channel,who:{meId:USER,orgRole:'member',server},settings:{} as RowContext['settings'],inThread:false,onOpenThread:nav,md:{}};
function msg(id:string,seq:number,root:string|null):Message{return {id,seq,thread_root_id:root,channel_id:CHAN,org_id:ORG,author_id:USER,kind:'user',body:id,mentions:[],mention_all:false,client_id:null,created_at:'2026-10-18T00:00:00Z',updated_at:'2026-10-18T00:00:00Z',edited_at:null,deleted_at:null,reply_count:2,last_reply_at:null,reply_user_ids:[],reactions:{},attachments:[],pinned:false,also_in_channel:false,meta:{}};}
beforeEach(()=>{resetState();opened.mockClear();read.mockClear();nav.mockClear();
registerActions({openThread:opened,closeThread:vi.fn(),markThreadRead:read});
setState({orgId:ORG,channels:{[CHAN]:channel},messages:{root:msg('root',1,null),m2:msg('m2',2,'root'),m3:msg('m3',3,'root')},threads:{root:{rootId:'root',channelId:CHAN,replyIds:['m2','m3'],status:'ready',error:null,hasMore:true,hasAfter:true,following:false,lastReadReplySeq:0,targetId:null,newReplies:true}}});
vi.spyOn(document,'hasFocus').mockReturnValue(true);
HTMLElement.prototype.scrollIntoView=vi.fn();
vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
const id=this.getAttribute('data-message-id');const top=id==='m3'?200:20,bottom=id==='m3'?240:80;
return {x:0,y:top,top:this.classList.contains('dk-thread__scroll')?0:top,bottom:this.classList.contains('dk-thread__scroll')?100:bottom,left:0,right:390,width:390,height:60,toJSON:()=>({})};});
});afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('thread read and latest controls',()=>{
it('refetches latest on an already-default root URL rather than navigating to itself',async()=>{
render(<ThreadPane rootId="root" messageId={null} ctx={ctx} variant="screen" onClose={()=>{}}/>);
expect(opened).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole('button',{name:'New replies - show latest'}));
expect(opened).toHaveBeenCalledTimes(2);expect(nav).not.toHaveBeenCalled();
});
it('confirms an older visible tagged reply while later pages and offscreen replies remain unread',()=>{
setState({threads:{root:{rootId:'root',channelId:CHAN,replyIds:['m2','m3'],status:'ready',error:null,hasMore:true,hasAfter:true,following:false,lastReadReplySeq:0,targetId:'m2'}}});
render(<ThreadPane rootId="root" messageId="m2" ctx={ctx} variant="screen" onClose={()=>{}}/>);
expect(read).toHaveBeenCalledWith('root',2);expect(read).not.toHaveBeenCalledWith('root',3);
});
});
