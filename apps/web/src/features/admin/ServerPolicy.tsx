import {useEffect,useState} from 'react';
import {api} from '../../api/rpc';
import type {ControlledServerMember,OrgRole,Profile,Server,ServerActivityItem,ServerControlAction,ServerPermission,ServerPermissions,ServerRole,ServerRolePolicy} from '../../api/types';
import {hasServerPermission,mayManageServerPolicy,SERVER_PERMISSION_LABELS,serverMuted} from '../../lib/server-permissions';
import {serverNowIso} from '../../sync/runtime';
import {useDek} from '../../store';
import {Avatar,Banner,Button,ConfirmDialog,EmptyState,Modal,Select,TextArea,toast} from '../../ui/kit';
import {refreshShell} from './common/context';
import {formatDateTime,SERVER_ROLE_LABEL} from './common/format';
import {useAction,useLoad,usePaged} from './common/load';
import {Card,Checkbox,FormError,Gate,List,PagedView,Pill,Row,Section} from './common/ui';

const GROUPS:{name:string;keys:ServerPermission[]}[]=[
 {name:'People and access',keys:['add_people','remove_people','invite_people','decide_join_requests','assign_roles']},
 {name:'Channels and messages',keys:['create_channels','edit_channels','delete_channels','delete_messages','pin_messages']},
 {name:'Safety and server',keys:['mute_members','suspend_members','ban_members','edit_server','view_audit']},
];

export function ServerPermissionsTab({server,orgRole}:{server:Server;orgRole:OrgRole}) {
 const load=useLoad(()=>api.getServerRolePolicy(server.id),[server.id],{key:null});
 const [base,setBase]=useState<ServerRolePolicy|null>(null),[role,setRole]=useState<ServerRole>('moderator');
 const [draft,setDraft]=useState<Partial<Record<ServerRole,Partial<ServerPermissions>>>>({}),[resetting,setResetting]=useState(false);
 useEffect(()=>{if(load.data)setBase(load.data);},[load.data]);
 const policy=base,changes=draft[role]??{},dirty=Object.keys(changes).length>0;
 const permitted=mayManageServerPolicy(server,orgRole),editable=permitted&&role!=='admin'&&!server.archived&&!load.refreshing;
 const changedElsewhere=!!policy&&(server.permission_version??0)>policy.version;
 const act=useAction((reset:boolean)=>api.setServerRolePolicy(server.id,role as 'moderator'|'member',reset?{}:changes,policy!.version,reset));
 const save=async(reset=false)=>{
  if(!editable||!policy||changedElsewhere||act.error?.code==='conflict'||(!reset&&!dirty))return;
  const res=await act.run(reset);if(!res.ok)return;
  setBase(res.value);setDraft(p=>({...p,[role]:{}}));setResetting(false);refreshShell();toast({kind:'success',title:reset?'Role defaults restored':'Role permissions saved',body:'Applies to every existing and new channel in this server.'});
 };
 const reload=()=>{setDraft({});setBase(null);setResetting(false);act.reset();load.reload();};
 return <Section title="Roles and permissions" description="One server policy for every existing and new channel. Admin always has full control. Only an Admin can change this policy.">
  <Gate load={load} what="role permissions">{()=>!policy?null:<>
   <Select label="Server role" value={role} onChange={e=>{setRole(e.target.value as ServerRole);act.reset();}} options={(['admin','moderator','member'] as ServerRole[]).map(r=>({value:r,label:SERVER_ROLE_LABEL[r]}))}/>
   {role==='admin'?<Banner icon="lock">Admin permissions are fixed. This role always has all permissions, including editing this policy.</Banner>:null}
   {server.permissions_stale?<Banner tone="warning">Refreshing your access. Your unsaved choices are kept.</Banner>:null}
   {changedElsewhere||act.error?.code==='conflict'?<Banner tone="warning" action={<Button onClick={reload} disabled={act.busy}>Reload latest and discard draft</Button>}>Permissions changed elsewhere. Your unsaved choices are kept. Reload before saving again.</Banner>:null}
   <div className="adm-policy-groups">{GROUPS.map(g=><Card key={g.name}><fieldset className="adm-policy-group" disabled={!editable||act.busy}>
    <legend>{g.name}</legend>{g.keys.map(key=><Checkbox key={key} label={SERVER_PERMISSION_LABELS[key]} checked={changes[key]??policy.roles[role].effective[key]} disabled={!editable||act.busy}
     onChange={value=>setDraft(p=>{const row={...(p[role]??{})};if(value===policy.roles[role].effective[key])delete row[key];else row[key]=value;return {...p,[role]:row};})}/>)}
   </fieldset></Card>)}</div>
   <p className="ap-hint">Private channels still require access. Role assignment cannot grant a higher role or change your own role. Muting stops posting; suspending removes access temporarily.</p>
   <FormError error={act.error}/>
   {role!=='admin'?<div className="ap-form__actions"><Button variant="ghost" disabled={!dirty||act.busy} onClick={()=>{setDraft(p=>({...p,[role]:{}}));act.reset();}}>Undo choices</Button>
    <Button onClick={()=>setResetting(true)} disabled={!editable||act.busy||changedElsewhere||act.error?.code==='conflict'}>Reset role to defaults</Button><Button variant="primary" loading={act.busy} disabled={!editable||!dirty||changedElsewhere||act.error?.code==='conflict'} onClick={()=>void save()}>Save role permissions</Button></div>:null}
   {resetting&&editable&&!changedElsewhere&&act.error?.code!=='conflict'?<ConfirmDialog open title={`Reset ${SERVER_ROLE_LABEL[role]} permissions?`} body={<><p>This replaces this role's overrides with the server defaults across all channels. The other roles stay unchanged.</p><FormError error={act.error}/></>} confirmLabel="Reset to defaults" busy={act.busy} onConfirm={()=>void save(true)} onCancel={()=>setResetting(false)}/>:null}
  </>}</Gate>
 </Section>;
}

export const CONTROL_LABEL:Record<ServerControlAction,string>={mute:'Mute',unmute:'Unmute',suspend:'Suspend access',restore:'Restore access',ban:'Ban from server',unban:'Unban'};
const CAP:Record<ServerControlAction,ServerPermission>={mute:'mute_members',unmute:'mute_members',suspend:'suspend_members',restore:'suspend_members',ban:'ban_members',unban:'ban_members'};
export function controlActions(server:Server,myId:string,target:{id:string;role:ServerRole|null;orgRole?:OrgRole},control?:ControlledServerMember['control'],orgAdmin=false):ServerControlAction[] {
 if(server.archived||target.id===myId||target.role==='admin'||target.orgRole==='admin'||target.orgRole==='owner')return [];
 if(!orgAdmin&&server.my_role!=='admin'&&target.role==='moderator')return [];
 const muted=control?serverMuted({...server,moderation:control}):false;
 const actions:ServerControlAction[]=control?.banned?['unban']:[muted?'unmute':'mute',control?.suspended?'restore':'suspend','ban'];
 return actions.filter(a=>hasServerPermission(server,CAP[a],orgAdmin||server.my_role==='admin'||server.my_role==='moderator'));
}

export function ServerControlDialog({server,myId,orgRole,person,role,control,onClose,onDone}:{server:Server;myId:string;orgRole:OrgRole;person:Profile;role:ServerRole|null;control?:ControlledServerMember['control'];onClose:()=>void;onDone:()=>void}) {
 const actions=controlActions(server,myId,{id:person.id,role},control,orgRole==='owner'||orgRole==='admin');
 const [action,setAction]=useState<ServerControlAction>(actions[0]??'mute'),[hours,setHours]=useState('1'),[reason,setReason]=useState('');
 const act=useAction(()=>api.setServerMemberControl(server.id,person.id,action,action==='mute'?new Date(Date.parse(serverNowIso())+Number(hours)*3_600_000).toISOString():null,reason.trim()||null));
 const allowed=actions.includes(action);
 const submit=async()=>{if(!allowed)return;const res=await act.run();if(!res.ok)return;onDone();onClose();refreshShell();toast({kind:'success',title:`${CONTROL_LABEL[action]}: ${person.display_name}`});};
 const effects:Record<ServerControlAction,string>={
  mute:'Stops posting, edits, reactions, pins, uploads and audio-room participation in this server until the mute ends. Reading remains available.',
  unmute:'Restores posting in this server immediately. Other restrictions stay in place.',
  suspend:'Temporarily removes access to this server. Memberships are kept so access can be restored.',
  restore:'Restores this server access using their retained memberships. An existing mute remains until it expires or is removed.',
  ban:'Removes this person from this server and all its channels, including private ones. Old invites cannot bring them back while banned.',
  unban:'Allows a deliberate rejoin. This does not restore old membership or access to private channels.',
 };
 return <Modal open title={`Server controls: ${person.display_name}`} onClose={onClose} dismissable={!act.busy} footer={<><Button variant="ghost" onClick={onClose} disabled={act.busy}>Cancel</Button><Button variant={action==='ban'||action==='suspend'?'danger':'primary'} disabled={!allowed} loading={act.busy} onClick={()=>void submit()}>Confirm {CONTROL_LABEL[action].toLowerCase()}</Button></>}>
  <div className="ap-form"><Select label="Action" value={action} onChange={e=>{setAction(e.target.value as ServerControlAction);act.reset();}} options={actions.map(a=>({value:a,label:CONTROL_LABEL[a]}))}/>
   {!allowed?<Banner tone="warning">Your permission to perform this action has changed. Close this window and refresh.</Banner>:null}
   <p>{effects[action]}</p><p className="ap-hint">Applies only to {server.name}. Their organization account, other servers and direct messages stay unchanged. Organization and server Admins are protected.</p>
   {action==='mute'?<Select label="Mute for" value={hours} onChange={e=>setHours(e.target.value)} options={[{value:'1',label:'1 hour'},{value:'8',label:'8 hours'},{value:'24',label:'1 day'},{value:'168',label:'7 days'}]}/>:null}
   <TextArea label="Reason (optional)" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} hint="Visible to people with member-control access in this server."/>
   <FormError error={act.error}/>
  </div>
 </Modal>;
}

export function ServerControlsTab({server,myId,orgRole}:{server:Server;myId:string;orgRole:OrgRole}) {
 const revision=useDek(s=>s.serverMemberVersion),load=useLoad(()=>api.listServerMemberControls(server.id),[server.id,revision],{key:null});
 const [selected,setSelected]=useState<ControlledServerMember|null>(null);
 const [clockRevision,setClockRevision]=useState(0);
 useEffect(()=>{
  const now=Date.parse(serverNowIso()),ends=(load.data?.items??[]).map(x=>Date.parse(x.control.muted_until??'')).filter(t=>Number.isFinite(t)&&t>now);
  if(!ends.length)return;
  const end=Math.min(...ends),timer=setTimeout(()=>{setClockRevision(n=>n+1);if(Date.parse(serverNowIso())>=end)load.reload();},Math.min(end-now+100,86_400_000));
  return ()=>clearTimeout(timer);
 },[load.data,load.reload,clockRevision]);
 const active=(load.data?.items??[]).map(x=>({...x,control:{...x.control,muted:serverMuted({...server,moderation:x.control})}})).filter(x=>x.control.banned||x.control.suspended||x.control.muted);
 return <Section title="Member controls" description="Active server restrictions. Add a restriction from a person's menu under Members. Restore access or unban people here, even after they have left the roster." actions={<Button onClick={load.reload}>Refresh member controls</Button>}>
  <Gate load={load} what="member controls">{()=>active.length?<List label="Restricted members">{active.map(x=>{
   const actions=controlActions(server,myId,{id:x.profile.id,role:x.role},x.control,orgRole==='owner'||orgRole==='admin');
   return <Row key={x.profile.id} leading={<Avatar name={x.profile.display_name} seed={x.profile.id} path={x.profile.avatar_path} size={36}/>} title={<><span>{x.profile.display_name}</span><Pill>{x.control.banned?'Banned':x.control.suspended?'Suspended':'Muted'}</Pill></>}
    meta={<>{x.control.muted_until&&x.control.muted?<span>Muted until {formatDateTime(x.control.muted_until)}</span>:null}{x.reason?<span>{x.reason}</span>:null}</>}
    trailing={actions.length?<Button onClick={()=>setSelected(x)}>Manage {x.profile.display_name}</Button>:null}/>;
  })}</List>:<EmptyState icon="shield" title="No active restrictions" body="This server has no muted, suspended or banned members."/>}</Gate>
  {selected&&controlActions(server,myId,{id:selected.profile.id,role:selected.role},selected.control,orgRole==='owner'||orgRole==='admin').length?<ServerControlDialog server={server} myId={myId} orgRole={orgRole} person={selected.profile} role={selected.role} control={selected.control} onClose={()=>setSelected(null)} onDone={load.reload}/>:null}
 </Section>;
}

const ACTIVITY_LABEL:Record<string,string>={
 'server.created':'Created the server','server.updated':'Updated server settings','server.archived':'Archived the server','server.unarchived':'Unarchived the server',
 'server.permissions_updated':'Updated role permissions','server.members_added':'Added members','server.member_removed':'Removed a member','server.role_changed':'Changed a member role',
 'server.member_mute':'Muted a member','server.member_unmute':'Unmuted a member','server.member_suspend':'Suspended server access','server.member_restore':'Restored server access','server.member_ban':'Banned a member','server.member_unban':'Unbanned a member',
 'channel.created':'Created a channel','channel.updated':'Updated a channel','channel.archived':'Archived a channel','channel.unarchived':'Unarchived a channel','channel.deleted':'Deleted a channel',
 'invite.created':'Created an invite link','invite.revoked':'Revoked an invite link','join_request.approved':'Approved a join request','join_request.rejected':'Declined a join request',
};
export function activityDescription(x:ServerActivityItem):string {
 const role=(x.action==='server.permissions_updated'||x.action==='server.role_changed')&&typeof x.details.role==='string'&&['admin','moderator','member'].includes(x.details.role)?` (${SERVER_ROLE_LABEL[x.details.role as ServerRole]})`:'';
 return (ACTIVITY_LABEL[x.action]??'Updated this server')+role;
}
export function ServerActivityTab({server}:{server:Server}) {
 const revision=useDek(s=>s.serverMemberVersion);
 const paged=usePaged<ServerActivityItem,number>(async cursor=>{const p=await api.listServerActivity(server.id,cursor);return {items:p.items,next:p.has_more?p.next_before:null};},[server.id,server.permission_version,revision]);
 return <Section title="Server activity" description="Permission, membership and management changes recorded after this feature was enabled. Private message bodies, private channel details and moderation reasons are excluded." actions={<Button onClick={paged.reload}>Refresh activity</Button>}>
  <PagedView paged={paged} what="server activity" empty={<EmptyState icon="inbox" title="No recorded activity yet"/>}>{items=><List label="Server activity">{items.map(x=><Row key={x.id} leading={<Avatar name={x.actor?.display_name??'Former member'} seed={x.actor?.id??'former'} path={x.actor?.avatar_path??null} size={32}/>}
   title={activityDescription(x)} meta={<><span>{x.actor?.display_name??'Former member'}{x.person?` - ${x.person.display_name}`:''}</span><time dateTime={x.created_at}>{formatDateTime(x.created_at)}</time></>}/>)}</List>}</PagedView>
 </Section>;
}
