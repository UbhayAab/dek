import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../src/api/rpc',()=>({api:{toggleReaction:vi.fn(),openDm:vi.fn()}}));
vi.mock('../../src/sync/channels',()=>({scheduleCacheWrite:vi.fn()}));
vi.mock('../../src/sync/profiles',()=>({ensureProfiles:vi.fn()}));
import {api} from '../../src/api/rpc';
import {toggleReaction} from '../../src/sync/messages';
import {openDm} from '../../src/sync/membership';
import {getState,resetState,setState} from '../../src/store/state';
import {nextAccessGen,nextSessionGen} from '../../src/sync/runtime';
import {ensureProfiles} from '../../src/sync/profiles';
import type {Message} from '../../src/api/types';
import {channel,ORG,USER,CHAN} from '../ui/collaboration-fixture';
function deferred<T>(){let resolve!:(x:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};}
const base={id:'message',channel_id:CHAN,org_id:ORG,reactions:{},body:'QA'} as Message;
beforeEach(()=>{resetState();vi.clearAllMocks();vi.mocked(api.toggleReaction).mockReset();vi.mocked(api.openDm).mockReset();setState({orgId:ORG,session:{status:'signed_in',userId:USER,email:null,setup:null},channels:{[CHAN]:channel},messages:{message:{...base}}});});
describe('reaction operation ownership',()=>{
 it('serializes valid different emoji intents and failed second choice preserves first confirmation',async()=>{
  const a=deferred<{message_id:string;reactions:Record<string,string[]>}>(),b=deferred<{message_id:string;reactions:Record<string,string[]>}>();vi.mocked(api.toggleReaction).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first=toggleReaction('message','👍'),second=toggleReaction('message','❤️');const failed=second.catch(e=>e);
  await vi.waitFor(()=>expect(api.toggleReaction).toHaveBeenCalledTimes(1));
  a.resolve({message_id:'message',reactions:{'👍':[USER]}});await first;
  await vi.waitFor(()=>expect(api.toggleReaction).toHaveBeenCalledTimes(2));b.reject(Error('offline'));await failed;
  expect(getState().messages.message!.reactions).toEqual({'👍':[USER]});
 });
 it.each(['success','failure'])('preserves newer authoritative same-account reactions on old %s',async mode=>{
  const request=deferred<{message_id:string;reactions:Record<string,string[]>}>();vi.mocked(api.toggleReaction).mockReturnValueOnce(request.promise);
  const pending=toggleReaction('message','👍').catch(e=>e);await vi.waitFor(()=>expect(api.toggleReaction).toHaveBeenCalled());
  const newer={'❤️':['other-device'],...(mode==='failure'?{'👍':[USER]}:{})};setState({messages:{message:{...base,reactions:newer}}});
  if(mode==='success')request.resolve({message_id:'message',reactions:{'👍':[USER]}});else request.reject(Error('response lost'));
  await pending;expect(getState().messages.message!.reactions).toBe(newer);
 });
 it('never merges a previous account reaction into the next account',async()=>{
  const request=deferred<{message_id:string;reactions:Record<string,string[]>}>();vi.mocked(api.toggleReaction).mockReturnValueOnce(request.promise);const pending=toggleReaction('message','👍');await vi.waitFor(()=>expect(api.toggleReaction).toHaveBeenCalled());
  setState({session:{status:'signed_in',userId:'next-account',email:null,setup:null},messages:{message:{...base,reactions:{'🎉':['next-account']}}}});nextSessionGen();request.resolve({message_id:'message',reactions:{'👍':[USER]}});await pending;expect(getState().messages.message!.reactions).toEqual({'🎉':['next-account']});
 });
});
describe('person-tag DM access boundary',()=>{
 it.each(['account','access'])('fences delayed DM metadata before upsert after %s change',async mode=>{
  const request=deferred<typeof channel>();vi.mocked(api.openDm).mockReturnValueOnce(request.promise);const pending=openDm(['peer']).catch(e=>e);
  if(mode==='account'){nextSessionGen();setState({session:{status:'signed_in',userId:'next-account',email:null,setup:null}});}else nextAccessGen();
  request.resolve({...channel,id:'private-dm',kind:'dm',dm_user_ids:['peer']});expect((await pending).code).toBe('not_found');expect(getState().channels['private-dm']).toBeUndefined();expect(ensureProfiles).not.toHaveBeenCalled();
 });
});
