import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
vi.mock('../../src/features/media',()=>({AttachmentButton:()=>null,PendingUploads:()=>null,
  useUploads:()=>({readyIds:[],busy:false,clear:vi.fn(),add:vi.fn()})}));
vi.mock('../../src/features/shell/layout',()=>({useCoarsePointer:()=>true}));
vi.mock('../../src/api/rpc',()=>({api:{listChannelMembers:vi.fn(async()=>({items:[]}))}}));
import { Composer } from '../../src/features/conversation/Composer';
import { api } from '../../src/api/rpc';
import { draftKey, getState, registerActions, resetState, setState } from '../../src/store';
import { ORG, CHAN, USER, channel, server } from './collaboration-fixture';
const send=vi.fn();
const props={orgId:ORG,channel,who:{meId:USER,orgRole:'member' as const,server},placeholder:'Reply in thread',autoFocus:true};
beforeEach(()=>{vi.useFakeTimers();resetState();send.mockReset();setState({orgId:ORG,session:{status:'signed_in',userId:USER,email:null,setup:null},channels:{[CHAN]:channel},threads:Object.fromEntries(['a','b','root-a'].map(rootId=>[rootId,{rootId,channelId:CHAN,replyIds:[],status:'ready',error:null,hasMore:false,following:false,lastReadReplySeq:0}]))});
  registerActions({sendMessage:send,notifyTyping:vi.fn(),setDraft:(key,text)=>setState({drafts:{...getState().drafts,[key]:text}})});});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('phone reply destination',()=>{
  it('stops claiming a selected person is tagged when their name becomes literal code or link text',()=>{
    const id='304ca758-4908-41e8-ba54-a4a0428b0e0e';
    setState({profiles:{[id]:{id,display_name:'Alice Member'} as never},drafts:{[draftKey(CHAN,'a')]:`hello <@${id}>`}});
    render(<Composer {...props} threadRootId="a"/>);expect(screen.getByRole('list',{name:'People tagged'})).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'`@Alice Member`'}});expect(screen.queryByRole('list',{name:'People tagged'})).toBeNull();
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'[@Alice Member](https://example.com)'}});expect(screen.queryByRole('list',{name:'People tagged'})).toBeNull();
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'@Alice Member'}});expect(screen.getByRole('list',{name:'People tagged'})).toBeTruthy();
  });
  it('focuses the dedicated thread composer, preserves a channel draft and sends the stable root',()=>{
    setState({drafts:{[draftKey(CHAN)]:'main announcement',[draftKey(CHAN,'root-a')]:'thread draft'}});
    render(<Composer key="root-a" {...props} threadRootId="root-a" />);
    const input=screen.getByRole('textbox',{name:'Reply in thread'});
    expect(document.activeElement).toBe(input); expect((input as HTMLTextAreaElement).value).toBe('thread draft');
    expect(screen.getByText('Replying in this thread')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Send reply'}));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({channelId:CHAN,threadRootId:'root-a',body:'thread draft',alsoInChannel:false}));
    expect(getState().drafts[draftKey(CHAN)]).toBe('main announcement');
  });
  it('keeps each root draft separate across unmount/reopen and does not send on a phone newline',()=>{
    const view=render(<Composer key="a" {...props} threadRootId="a" />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'reply A'}});
    expect(getState().drafts[draftKey(CHAN,'a')]).toBe('reply A');
    fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'}); expect(send).not.toHaveBeenCalled();
    view.rerender(<Composer key="b" {...props} threadRootId="b" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'reply B'}});
    view.rerender(<Composer key="a" {...props} threadRootId="a" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('reply A');
    expect(getState().drafts[draftKey(CHAN,'b')]).toBe('reply B');
  });
  it('does not restore a private draft while unmounting after terminal access loss',()=>{
    const view=render(<Composer {...props} threadRootId="a" />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'private draft'}});
    setState({drafts:{},threads:{a:{rootId:'a',channelId:CHAN,replyIds:[],status:'error',error:'Unavailable',hasMore:false,following:false,lastReadReplySeq:0,unavailable:true}}});
    view.unmount();expect(getState().drafts[draftKey(CHAN,'a')]).toBeUndefined();
  });
  it('does not recreate purged drafts on revoke or persist old text under a different account',()=>{
    const view=render(<Composer {...props} threadRootId="a" />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'private draft'}});
    setState({channels:{},threads:{},drafts:{},session:{status:'signed_in',userId:'other-person',email:null,setup:null}});
    fireEvent.blur(screen.getByRole('textbox'));view.unmount();expect(getState().drafts).toEqual({});
  });
  it('keeps text in the same thread when enqueue fails and only queries channel members',async()=>{
    send.mockImplementationOnce(()=>{throw new Error('offline storage unavailable');});
    render(<Composer {...props} threadRootId="a" />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'keep me'}});
    fireEvent.click(screen.getByRole('button',{name:'Send reply'}));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('keep me');
    fireEvent.blur(screen.getByRole('textbox'));
    fireEvent.click(screen.getByRole('button',{name:'Tag someone in this conversation'}));
    await act(()=>vi.advanceTimersByTimeAsync(151));
    expect(api.listChannelMembers).toHaveBeenCalledWith(CHAN,null,20);
    fireEvent.click(screen.getByRole('button',{name:'Send reply'}));
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({threadRootId:'a',alsoInChannel:false}));
  });
});
