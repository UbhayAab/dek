// Per-item triage waits for persistence. Clear does not change read/follow/mute.
import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '../../api/rpc';
import {humanError,toDekError} from '../../api/errors';
import type {ActivityCursor,ActivityItem,ActivityKind,ActivityView} from '../../api/types';
import {useDek} from '../../store';
import {currentAccessGen} from '../../sync/runtime';
import {purgeLocal} from '../../sync/access';
import {newId} from '../../lib/uuid';
import {Icon} from '../../ui/icons';
import {Avatar,Button,EmptyState,IconButton,Tabs,toast,type MenuItem} from '../../ui/kit';
import {ContextMenu} from '../../ui/ContextMenu';
import {useRowGestures,type ContextRequest} from '../../ui/useRowGestures';
import {Markdown} from '../../ui/markdown';
import {useMdContext} from '../conversation/md';
import {channelTitle,personName} from '../conversation/names';
import {openMessage,openThread} from '../conversation/jump';
import {fullTimeLabel,relativeLong} from '../conversation/time';
import type {Layout} from '../shell/layout';
import {isDeeper,ListBody,refreshCounters,useEnsureProfiles,usePagedList,ViewFrame} from './common';
import './activity.css';
type Props={orgId:string;layout:Layout;embedded?:boolean;kind:ActivityKind};
export function ActivityInbox(props:Props) {
 const owner=useDek(s=>s.session.userId);
 const access=useDek(s=>{void s.activityVersion;return currentAccessGen();});
 return <Inbox key={`${owner}:${props.orgId}:${props.kind}:${access}`} {...props}/>;
}
function Inbox({orgId,layout,embedded,kind}:Props) {
 const [view,setView]=useState<ActivityView>('unread');
 const version=useDek(s=>s.activityVersion),online=useDek(s=>s.connection.realtime),seen=useRef(version),wasOnline=useRef(online);
 const {state,reload,loadMore}=usePagedList<ActivityItem&{cursor:ActivityCursor|null},ActivityCursor>({
  resetKey:`activity:${orgId}:${kind}:${view}`,
  fetchPage:async before=>{const owner=useDek.getState().session.userId,access=currentAccessGen();const r=await api.listActivityInbox(orgId,kind,view,before,30);if(useDek.getState().session.userId!==owner||useDek.getState().orgId!==orgId||currentAccessGen()!==access)throw Error('This activity is no longer available.');if(r.has_more&&!r.next_cursor)throw Error('This page is incomplete. Refresh the inbox.');return {items:r.items.map(it=>({...it,cursor:r.next_cursor})),hasMore:r.has_more};},
  idOf:it=>'message' in it?it.message.id:it.root.id,cursorOf:it=>it.cursor!,
 });
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null),liveState=useRef(state);liveState.current=state;
 const queueRefresh=useCallback(()=>{
  if(timer.current)return;
  const run=()=>{if(liveState.current.status==='loading'||liveState.current.more==='loading'){timer.current=setTimeout(run,200);return;}timer.current=null;reload();};
  timer.current=setTimeout(run,200);
 },[reload]);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 useEffect(()=>{if(version!==seen.current){seen.current=version;queueRefresh();}},[version,queueRefresh]);
 useEffect(()=>{if(wasOnline.current!==online&&online==='online')queueRefresh();wasOnline.current=online;},[online,queueRefresh]);
 useEffect(()=>{window.addEventListener('focus',queueRefresh);return()=>window.removeEventListener('focus',queueRefresh);},[queueRefresh]);
 const title=kind==='mention'?'Mentions':'Threads';
 return <ViewFrame title={title} icon={kind==='mention'?'at':'thread'} embedded={embedded}>
  <div className="dk-activity-inbox__intro"><div><h2>{kind==='mention'?'Your mentions':'Followed discussions'}</h2><p>{kind==='mention'?'Messages that need your attention.':'Pick up the conversations you follow.'}</p></div><IconButton icon="refresh" label="Refresh" onClick={reload} disabled={state.status==='loading'}/></div>
  <div className="dk-activity-inbox__filters"><Tabs<ActivityView> label="Show activity" value={view} onChange={setView} tabs={[{value:'unread',label:'Unread'},{value:'all',label:'All'},{value:'cleared',label:'Cleared'}]}/></div>
  <p className="dk-activity-inbox__hint">Swipe right to mark read. Swipe left to clear. <span>Clear keeps messages and unread badges. Restore from Cleared.</span></p>
  <ListBody state={state} loadingLabel={`Loading ${title.toLowerCase()}`} errorTitle={`${title} did not load`} onRetry={reload} onMore={loadMore} empty={<EmptyState icon={kind==='mention'?'at':'thread'} title={view==='cleared'?'Nothing cleared':view==='unread'?'You are caught up':`No ${title.toLowerCase()} yet`} body={view==='cleared'?'Cleared items can be restored here. New thread replies return to your inbox.':view==='unread'?'Choose All to revisit conversations or Cleared to restore an item.':kind==='mention'?'When someone tags you in a conversation, it appears here.':'Threads you start, reply to or follow appear here.'}/>}>
   <ul className="dk-activity-inbox" aria-label={kind==='mention'?'Mentions':'Followed threads'}>{state.items.map(it=><ActivityRow key={'message' in it?it.message.id:it.root.id} item={it} kind={kind} orgId={orgId} deeper={isDeeper(layout)} onChanged={reload}/>)}</ul>
  </ListBody>
 </ViewFrame>;
}
export function ActivityRow({item,kind,orgId,deeper,onChanged}:{item:ActivityItem;kind:ActivityKind;orgId:string;deeper:boolean;onChanged:()=>void}) {
 const m='message' in item?item.message:item.root,unread='read' in item?!item.read:item.unread_replies>0;
 const snapshot='last_reply_seq' in item?item.last_reply_seq:m.seq,meta=item.activity;
 const profiles=useDek(s=>s.profiles),owner=useDek(s=>s.session.userId),name=m.kind==='system'?'Dek':personName(profiles,m.author_id),author=m.author_id?profiles[m.author_id]:undefined;
 useEnsureProfiles([m.author_id,...m.mentions]);
 const md=useMdContext(orgId),[context,setContext]=useState<ContextRequest|null>(null),[pending,setPending]=useState<string|null>(null),[failed,setFailed]=useState<{action:'read'|'clear'|'restore';message:string;operation:string;revision:number;snapshot:number;retryable:boolean}|null>(null),busy=useRef(false);
 const identity=[owner,orgId,kind,m.id,snapshot,meta.revision,item.channel.member,m.deleted_at,pending].join(':');
 useEffect(()=>setContext(null),[identity]);
 const open=()=>{if(busy.current)return;if(kind==='thread')openThread(orgId,item.channel.id,m.id,deeper);else openMessage(orgId,m,deeper);};
 const change=async(action:'read'|'clear'|'restore',revision=meta.revision,operation=newId(),through=snapshot)=>{
  if(busy.current)return;busy.current=true;setPending(action);setFailed(null);
  const access=currentAccessGen(),alive=()=>useDek.getState().session.userId===owner&&useDek.getState().orgId===orgId&&currentAccessGen()===access;
  try {
   const result=await api.setActivityState(kind,m.id,action,revision,operation,through);
   if(!alive())return;
   onChanged();refreshCounters();
   toast({kind:'success',title:action==='read'?'Marked read':action==='restore'?'Restored to inbox':'Cleared from inbox',body:action==='clear'?'Messages, unread state and follow settings stay unchanged.':kind==='thread'&&action==='read'?'Read through the replies shown. Later replies stay unread.':undefined,
    ...(action==='clear'?{duration:8000,action:{label:'Undo',onClick:()=>{
     if(!alive())return;
     void api.setActivityState(kind,m.id,'restore',result.revision,newId()).then(()=>{if(alive()){onChanged();refreshCounters();toast({kind:'success',title:'Restored to inbox'});}}).catch(e=>{if(alive())toast({kind:'error',title:'Could not undo',body:humanError(e)});});
    }}}:{})});
  }catch(e){if(alive()){
    const error=toDekError(e);
    if(['not_found','forbidden','suspended'].includes(error.code)){purgeLocal(new Set(),orgId);refreshCounters();onChanged();}
    else setFailed({action,message:humanError(e),operation,revision,snapshot:through,retryable:error.retryable});
  }}
  finally{busy.current=false;setPending(null);}
 };
 const gestures=useRowGestures({identity,disabled:!!pending,onMenu:setContext,onSwipe:direction=>void change(direction==='right'?'read':'clear'),left:item.channel.member&&!meta.cleared,right:item.channel.member&&unread});
 const items:MenuItem[]=[{label:kind==='thread'?'Open thread':'Open conversation',icon:'chevronRight',onSelect:open}];
 if(unread&&item.channel.member)items.push({label:kind==='thread'?'Mark shown replies read':'Mark this mention read',icon:'check',onSelect:()=>void change('read')});
 if(item.channel.member)items.push({label:meta.cleared?'Restore to inbox':'Clear from inbox',icon:meta.cleared?'inbox':'x',onSelect:()=>void change(meta.cleared?'restore':'clear')});
 const activityAt='activity_at' in item?item.activity_at:m.created_at;
 return <li className={`dk-activity-row${unread?' is-unread':''}${pending?' is-pending':''}`} data-activity-id={`${kind}:${m.id}`}>
  <div className="dk-activity-row__reveal dk-activity-row__reveal--read" aria-hidden="true"><Icon name="check" size={22}/><span>Mark read</span></div>
  <div className="dk-activity-row__reveal dk-activity-row__reveal--clear" aria-hidden="true"><Icon name="x" size={22}/><span>Clear</span></div>
  <article {...gestures.handlers} tabIndex={0} aria-haspopup="menu" aria-expanded={!!context} aria-busy={!!pending} aria-label={`${unread?'Unread ':''}${kind} from ${name} in ${channelTitle(item.channel,profiles)}`} className={`dk-activity-row__surface${gestures.offset?' is-dragging':''}`} style={{transform:`translateX(${gestures.offset}px)`}}
   onClick={e=>{if(e.currentTarget.contains(e.target as Node)&&!(e.target as Element).closest('a,button,input,textarea,video,audio')&&!document.getSelection()?.toString())open();}}
   onKeyDown={e=>{gestures.handlers.onKeyDown?.(e);if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();open();}}}>
   <span data-swipe-handle className="dk-activity-row__grip" title="Drag horizontally for activity actions"><Avatar name={name} path={author?.avatar_path} seed={m.author_id??m.id} size={40}/></span>
   <div className="dk-activity-row__content"><div className="dk-activity-row__heading"><strong dir="auto">{name}</strong><time dateTime={activityAt} title={fullTimeLabel(activityAt)}>{relativeLong(activityAt)}</time></div>
    <div className="dk-activity-row__where"><Icon name={kind==='thread'||m.thread_root_id?'thread':'at'} size={14}/><span>{channelTitle(item.channel,profiles)}{m.thread_root_id?' - Thread reply':''}</span>{unread?<span className="dk-activity-row__dot" aria-label="Unread"/>:null}</div>
    <div className="dk-activity-row__preview">{m.deleted_at?<p>This message was deleted.</p>:<Markdown body={m.body} ctx={md}/>}</div>
    {m.attachments.length?<span className="dk-activity-row__detail">{m.attachments.length} {m.attachments.length===1?'attachment':'attachments'}</span>:null}
    {'unread_replies' in item?<span className="dk-activity-row__detail">{item.unread_replies?`${item.unread_replies} new replies`:`${m.reply_count} replies`}</span>:null}
    <div className="dk-activity-row__actions"><button type="button" className="dk-activity-row__open" onClick={open} disabled={!!pending}>{kind==='thread'?'Open thread':'Open conversation'}<Icon name="chevronRight" size={15}/></button>{unread&&item.channel.member?<button type="button" className="dk-activity-row__open" disabled={!!pending} onClick={()=>void change('read')}>Mark read</button>:null}<button type="button" data-swipe-handle className="dk-activity-row__more" aria-label={`Actions for ${name}'s ${kind}`} aria-haspopup="menu" disabled={!!pending} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setContext({x:r.right,y:r.bottom,sheet:innerWidth<760,restore:e.currentTarget,via:'keyboard'});}}><Icon name="more" size={20}/></button></div>
    {pending?<p className="dk-activity-row__status" role="status">{pending==='read'?'Marking read...':pending==='clear'?'Clearing...':'Restoring...'}</p>:null}
    {failed?<div className="dk-activity-row__failure" role="alert"><p>{failed.message}</p>{failed.retryable?<Button variant="ghost" onClick={()=>void change(failed.action,failed.revision,failed.operation,failed.snapshot)}>Try again</Button>:null}<Button variant="ghost" onClick={onChanged}>Refresh</Button></div>:null}
   </div>
  </article>
  <ContextMenu request={context} label="Activity actions" items={items} onClose={()=>setContext(null)}/>
 </li>;
}
