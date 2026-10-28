// One authoritative access-loss cleanup for realtime and fresh bootstrap healing.
import {hub} from '../realtime/hub';
import {getState,setState} from '../store/state';
import {purgeMedia} from '../sw/register';
import {dropCache,dropCachedOrg,invalidateChannelLoads} from './channels';
import {dropPersistedDrafts} from './local';
import {purgeChannels} from './reducers';
import {isOpen,markClosed,nextAccessGen,runtime} from './runtime';
import {invalidateThreadChannels} from './threads';
import {resetProfiles} from './profiles';

export function purgeLocal(ids:ReadonlySet<string>,orgId:string|null,forgetSnapshot=true):void {
  nextAccessGen();invalidateChannelLoads(ids);
  invalidateThreadChannels(ids);
  for(const id of ids)while(isOpen(id))if(markClosed(id)===0)hub.leaveView(id);
  setState({...purgeChannels(getState(),ids),activityVersion:getState().activityVersion+1});
  const rt=runtime();rt?.outbox.dropChannels(ids);
  for(const id of ids)void dropCache(id);
  if(rt)dropPersistedDrafts(rt.userId,ids);
  if(rt&&orgId&&forgetSnapshot)void rt.db.then(db=>db.ok?db.delete('meta',`bootstrap:${orgId}`):undefined);
  if(orgId)purgeMedia(Array.from(ids,c=>`${orgId}/${c}/`));
}

export async function purgeOrgLocal(orgId:string):Promise<void> {
  nextAccessGen();
  setState({activityVersion:getState().activityVersion+1});
  const state=getState(),rt=runtime();
  const ids=new Set(Object.values(state.channels).filter(c=>c.org_id===orgId).map(c=>c.id));
  for(const p of [...Object.values(state.pending),...(rt?.outbox.snapshot()??[])])if(p.orgId===orgId)ids.add(p.channelId);
  purgeLocal(ids,orgId,false);purgeMedia([`${orgId}/`]);
  const cachedIds=await dropCachedOrg(orgId);
  if(runtime()!==rt)return;
  for(const id of cachedIds)ids.add(id);
  purgeLocal(ids,orgId);
  resetProfiles();
  const current=getState(),mine=current.me?.profile;
  setState({profiles:mine?{[mine.id]:mine}:{}});
  if(rt) {const db=await rt.db;if(db.ok)await db.clear('profiles');}
}
