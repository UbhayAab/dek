// Explicit local-only component fixture. Not imported by the app entry and never
// part of its production build. No authentication, remote API or staff data.
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import '../../src/ui/tokens.css';
import '../../src/ui/base.css';
import '../../src/features/shell/shell.css';
import {api} from '../../src/api/rpc';
import type {BootstrapResult,Channel,ControlledServerMember,MeResult,Profile,Server,ServerPermissions,ServerRolePolicy} from '../../src/api/types';
import {setState,registerActions} from '../../src/store';
import {ServerSettingsScreen,ChannelSettingsScreen} from '../../src/features/admin';
import {ChannelTree} from '../../src/features/shell/ChannelTree';
import {SERVER_PERMISSION_LABELS} from '../../src/lib/server-permissions';
import {Menu,Modal,Button,Toaster} from '../../src/ui/kit';
import {noteServerTime} from '../../src/sync/runtime';
const org='0f000000-0000-4000-8000-000000000105',uid='0a000000-0000-4000-8000-000000000105',sid='0b000000-0000-4000-8000-000000000105';
const mode=new URLSearchParams(location.search).get('view')??'roles';
const person={id:'0a000000-0000-4000-8000-000000000106',display_name:'Fictional Member',handle:'fictional',avatar_path:null,deleted:false} as Profile;
const me={...person,id:uid,display_name:'Fictional Admin',handle:'qa-admin'};
const caps=(value:boolean)=>Object.fromEntries(Object.keys(SERVER_PERMISSION_LABELS).map(k=>[k,value])) as ServerPermissions;
let server:Server={id:sid,org_id:org,name:'Care Team',description:'Fictional browser QA only',icon_emoji:null,position:0,join_policy:'approval',archived:false,my_role:'admin',member_count:2,access:'member',permissions:caps(true),permission_version:1,can_manage_permissions:true};
const summary={id:org,name:'Fictional QA',slug:'fictional-qa',short_name:'QA',brand_color:'#0F766E',logo_path:null,my_role:'member' as const,unread_channels:0,mention_count:0,settings:{allow_guests:true,default_invite_hours:168,member_can_create_channels:true,member_can_invite:false}};
const channel=(id:string,name:string,kind:'text'|'audio',position:number):Channel=>({id,org_id:org,server_id:sid,name,kind,position,category:'General',topic:null,description:null,visibility:'public',posting_policy:'everyone',allow_replies:true,allow_reactions:true,auto_join:false,archived:false,created_by:uid,created_at:new Date().toISOString(),member:true,my_role:'owner',notify:'default',muted_until:null,last_seq:0,last_read_seq:0,unread:0,mentions:0,last_message_at:null,member_count:2,dm_user_ids:null});
let channels=[channel('0c000000-0000-4000-8000-000000000105','General','text',0),channel('0c000000-0000-4000-8000-000000000106','New text','text',999),channel('0c000000-0000-4000-8000-000000000107','Voice room','audio',-99)];
let policy:ServerRolePolicy={server_id:sid,version:1,can_manage:true,actions:Object.keys(SERVER_PERMISSION_LABELS) as ServerRolePolicy['actions'],roles:{admin:{defaults:caps(true),effective:caps(true),overrides:{},locked:true},moderator:{defaults:caps(false),effective:{...caps(false),delete_messages:true,pin_messages:true},overrides:{delete_messages:true,pin_messages:true},locked:false},member:{defaults:caps(false),effective:{...caps(false),pin_messages:true},overrides:{pin_messages:true},locked:false}}};
let controlled:ControlledServerMember[]=mode==='controls'?[{profile:person,role:'member',control:{muted:false,muted_until:null,suspended:false,banned:true},reason:'Fictional demonstration',updated_at:new Date().toISOString()}]:[];
const calls:{fn:string;args:unknown[]}[]=[];
// Fail closed for every action this finite fixture does not explicitly mock.
for(const key of Object.keys(api)) (api as unknown as Record<string,unknown>)[key]=async()=>{throw Error('Unconfigured fictional fixture action: '+key);};
const snapshot=()=>({org:summary,servers:[server],channels,profiles:[me,person],topics:[],server_time:new Date().toISOString()}) as BootstrapResult;
const repaint=()=>{const b=snapshot();setState({org:b.org,servers:{[sid]:server},channels:Object.fromEntries(channels.map(c=>[c.id,c]))});return Promise.resolve();};
api.me=async()=>({user_id:uid,profile:me,orgs:[summary]}) as MeResult;
api.bootstrap=async()=>snapshot();api.listServers=async()=>[server];api.listChannels=async()=>channels;api.getProfiles=async()=>[me,person];
api.getServerRolePolicy=async()=>structuredClone(policy);
api.setServerRolePolicy=async(...args)=>{calls.push({fn:'setServerRolePolicy',args});const [,role,patch,expected,reset]=args;if(expected!==policy.version)throw Error('Unexpected fixture version');policy=structuredClone(policy);policy.version++;policy.roles[role].effective=reset?policy.roles[role].defaults:{...policy.roles[role].effective,...patch};server={...server,permission_version:policy.version};return structuredClone(policy);};
api.listServerMembers=async()=>({items:[{profile:me,role:'admin',joined_at:new Date().toISOString()},{profile:person,role:'member',joined_at:new Date().toISOString()}],total:2});
api.listServerMemberControls=async()=>({items:controlled});api.setServerMemberControl=async(...args)=>{calls.push({fn:'setServerMemberControl',args});controlled=[];return {server_id:sid,user_id:person.id,changed:true,control:{muted:false,muted_until:null,suspended:false,banned:false}};};
api.listServerActivity=async()=>({items:[{id:1,actor:me,person:null,action:'server.permissions_updated',target_type:'server',details:{role:'moderator',version:1},created_at:new Date().toISOString()}],has_more:false,next_before:null});
api.listInvites=async()=>({items:[]});api.listJoinRequests=async()=>({items:[]});api.createChannel=async a=>{const c=channel('0c000000-0000-4000-8000-000000000108',a.name,a.kind??'text',1000);channels=[...channels,c];return c;};
setState({session:{status:'signed_in',userId:uid,email:null,setup:null},me:await api.me(),orgId:org,org:summary as BootstrapResult['org'],orgs:[summary],servers:{[sid]:server},channels:Object.fromEntries(channels.map(c=>[c.id,c])),profiles:{[uid]:me,[person.id]:person},bootstrap:{status:'ready',error:null,at:Date.now()}});
registerActions({refreshBootstrap:repaint});noteServerTime(new Date(Date.now()).toISOString(),Date.now(),Date.now());
if(['roles','members','controls','activity'].includes(mode))history.replaceState(null,'',location.pathname+location.search+'#'+mode);
if(mode==='channel')history.replaceState(null,'',location.pathname+location.search+'#danger');
function Fixture(){
 const [nested,setNested]=useState(false);
 if(mode==='nested')return <><Button onClick={()=>setNested(true)}>Open parent dialog</Button>{nested?<Modal open title="Parent dialog" onClose={()=>setNested(false)}><Menu label="Nested options" items={[{label:'Choose action',onSelect:()=>calls.push({fn:'nested',args:[]})}]}/></Modal>:null}</>;
 if(mode==='tree')return <main style={{padding:20}}><h1>Fictional navigation test</h1><div data-testid="clip" style={{width:260,height:70,overflow:'hidden',border:'1px solid var(--border)',marginTop:180}}><ChannelTree orgId={org} activeChannelId={channels[0]!.id} onOpen={()=>{}} variant="sidebar"/></div></main>;
 return mode==='channel'?<ChannelSettingsScreen orgId={org} channelId={channels[0]!.id}/>:<ServerSettingsScreen orgId={org} serverId={sid}/>;
}
Object.assign(window,{fb105:{calls,org,uid,sid,ready:true}});createRoot(document.getElementById('root')!).render(<><Fixture/><Toaster/></>);
