import{test}from'node:test';import assert from'node:assert/strict';import{tx,expectError}from'./_harness.mjs';
const each=fn=>tx(async db=>fn(db,await db.fixture()));
const set=(db,f,patch,role='member')=>db.call(f.owner,'set_server_role_permissions105',{p_server:f.medical,p_role:role,p_permissions:patch});
const call=(db,f,who,fn,args={})=>db.call(f[who],fn,args);

test('105 add people permission is live for server and every readable channel',()=>each(async(db,f)=>{
 await expectError(call(db,f,'alice','add_server_members',{p_server:f.medical,p_user_ids:[f.carol]}),'forbidden');
 await set(db,f,{add_people:true});const r=await call(db,f,'alice','add_server_members',{p_server:f.medical,p_user_ids:[f.carol]});assert.deepEqual(r.added,[f.carol]);
 await call(db,f,'alice','add_channel_members',{p_channel:f.general,p_user_ids:[f.carol]});
 await set(db,f,{add_people:false});await expectError(call(db,f,'alice','add_channel_members',{p_channel:f.grants,p_user_ids:[f.bob]}),'forbidden');
 assert.equal((await db.one('select role from dek.org_members where org_id=$1 and user_id=$2',[f.org,f.carol])).role,'member');
}));
test('105 remove people independent of editing, and protected admin/self targets',()=>each(async(db,f)=>{
 await db.serverMember(f.medical,f.bob,'moderator');await set(db,f,{remove_people:false},'moderator');
 await expectError(call(db,f,'bob','remove_server_member',{p_server:f.medical,p_user:f.alice}),'forbidden');
 await set(db,f,{remove_people:true},'moderator');
 for(const u of[f.owner,f.admin,f.bob])await expectError(call(db,f,'bob','remove_server_member',{p_server:f.medical,p_user:u}),'forbidden');
 await call(db,f,'bob','remove_server_member',{p_server:f.medical,p_user:f.alice});
 assert.equal((await db.one('select count(*)::int n from dek.channel_members cm join dek.channels c on c.id=cm.channel_id where c.server_id=$1 and cm.user_id=$2',[f.medical,f.alice])).n,0);
 assert.equal((await db.one('select count(*)::int n from dek.org_members where org_id=$1 and user_id=$2',[f.org,f.alice])).n,1);
}));
test('105 channel owners cannot bypass edit/delete capabilities',()=>each(async(db,f)=>{
 for(const [fn,args]of[['update_channel',{p_channel:f.grants,p_patch:{topic:'blocked'}}],['archive_channel',{p_channel:f.grants,p_archived:true}],['delete_channel',{p_channel:f.grants,p_confirm_name:'grants'}]])await expectError(call(db,f,'alice',fn,args),'forbidden');
 await set(db,f,{edit_channels:true,delete_channels:false});await call(db,f,'alice','update_channel',{p_channel:f.grants,p_patch:{topic:'allowed'}});await expectError(call(db,f,'alice','delete_channel',{p_channel:f.grants,p_confirm_name:'grants'}),'forbidden');
 await set(db,f,{edit_channels:false,delete_channels:true});await expectError(call(db,f,'alice','update_channel',{p_channel:f.grants,p_patch:{topic:'no'}}),'forbidden');await call(db,f,'alice','delete_channel',{p_channel:f.grants,p_confirm_name:'grants'});
}));
test('105 creation applies current policy and new channels inherit immediately',()=>each(async(db,f)=>{
 await set(db,f,{create_channels:false});await expectError(call(db,f,'alice','create_channel',{p_server:f.medical,p_name:'first'}),'forbidden');
 await set(db,f,{create_channels:true,edit_channels:false,add_people:false});let c=await call(db,f,'alice','create_channel',{p_server:f.medical,p_name:'new-text'});
 await expectError(call(db,f,'alice','update_channel',{p_channel:c.id,p_patch:{topic:'owner cannot bypass'}}),'forbidden');
 await expectError(call(db,f,'alice','create_channel',{p_server:f.medical,p_name:'with-people',p_member_ids:[f.bob]}),'forbidden');
 await set(db,f,{edit_channels:true,add_people:true});await call(db,f,'alice','update_channel',{p_channel:c.id,p_patch:{topic:'now allowed'}});
 c=await call(db,f,'alice','create_channel',{p_server:f.medical,p_name:'with-people',p_member_ids:[f.bob],p_auto_join:true});assert.equal(c.auto_join,true);
 await set(db,f,{edit_channels:false});await expectError(call(db,f,'alice','update_channel',{p_channel:c.id,p_patch:{topic:'revoked'}}),'forbidden');
}));
test('105 add, remove and edit channel actions are distinct',()=>each(async(db,f)=>{
 await set(db,f,{add_people:true,remove_people:false,edit_channels:false});await call(db,f,'alice','add_channel_members',{p_channel:f.grants,p_user_ids:[f.bob]});
 await expectError(call(db,f,'alice','remove_channel_member',{p_channel:f.grants,p_user:f.bob}),'forbidden');
 await set(db,f,{add_people:false,remove_people:true});await call(db,f,'alice','remove_channel_member',{p_channel:f.grants,p_user:f.bob});
 await expectError(call(db,f,'alice','add_channel_members',{p_channel:f.grants,p_user_ids:[f.bob]}),'forbidden');
}));
test('105 delegated actions never disclose a private channel or change DM/org rights',()=>each(async(db,f)=>{
 await set(db,f,{add_people:true,remove_people:true,edit_channels:true,delete_channels:true,create_channels:true});
 for(const [fn,args]of[['update_channel',{p_channel:f.secret,p_patch:{topic:'secret'}}],['delete_channel',{p_channel:f.secret,p_confirm_name:'leadership'}],['add_channel_members',{p_channel:f.secret,p_user_ids:[f.bob]}]])await expectError(call(db,f,'alice',fn,args),'not_found');
 await expectError(call(db,f,'alice','update_channel',{p_channel:f.dmAliceBob,p_patch:{topic:'DM'}}),'forbidden');
 await expectError(call(db,f,'alice','set_org_role',{p_org:f.org,p_user:f.bob,p_role:'admin'}),'forbidden');
}));
test('105 invite permission independent of org-wide setting and stale links stop granting',()=>each(async(db,f)=>{
 await expectError(call(db,f,'alice','create_invite',{p_org:f.org,p_server:f.medical}),'forbidden');
 await set(db,f,{invite_people:true});const inv=await call(db,f,'alice','create_invite',{p_org:f.org,p_server:f.medical});assert(inv.id);
 assert((await call(db,f,'alice','list_invites',{p_org:f.org,p_server:f.medical})).items.some(x=>x.id===inv.id));
 await expectError(call(db,f,'alice','create_invite',{p_org:f.org}),'forbidden');
 await set(db,f,{invite_people:false});assert.equal((await db.call(null,'preview_invite',{p_code:inv.code})).valid,false);
 await expectError(call(db,f,'alice','create_invite',{p_org:f.org,p_server:f.medical}),'forbidden');
 assert.equal((await db.one('select count(*)::int n from dek.server_members where server_id=$1 and user_id=$2',[f.medical,f.stranger])).n,0);
}));
test('105 role assignment permission cannot confer Admin or self promotion',()=>each(async(db,f)=>{
 await db.serverMember(f.medical,f.bob,'moderator');await set(db,f,{assign_roles:true,add_people:true},'moderator');
 await call(db,f,'bob','set_server_role',{p_server:f.medical,p_user:f.alice,p_role:'moderator'});
 for(const u of[f.owner,f.admin,f.bob])await expectError(call(db,f,'bob','set_server_role',{p_server:f.medical,p_user:u,p_role:'member'}),'forbidden');
 await expectError(call(db,f,'bob','add_server_members',{p_server:f.medical,p_user_ids:[f.carol],p_role:'admin'}),'forbidden');
 await expectError(call(db,f,'bob','set_server_role',{p_server:f.medical,p_user:f.alice,p_role:'admin'}),'forbidden');
 await set(db,f,{assign_roles:false},'moderator');await expectError(call(db,f,'bob','set_server_role',{p_server:f.medical,p_user:f.alice,p_role:'member'}),'forbidden');
}));
test('105 last active server Admin cannot be demoted, removed or leave',()=>each(async(db,f)=>{
 const id=await db.server(f.org,'Single admin',{admins:[f.alice],members:[f.bob]});
 await expectError(call(db,f,'owner','set_server_role',{p_server:id,p_user:f.alice,p_role:'member'}),'conflict');
 await expectError(call(db,f,'owner','remove_server_member',{p_server:id,p_user:f.alice}),'conflict');
 await expectError(call(db,f,'alice','leave_server',{p_server:id}),'conflict');
 await db.serverMember(id,f.bob,'admin');await call(db,f,'owner','set_server_role',{p_server:id,p_user:f.alice,p_role:'member'});
 assert.equal((await db.one('select role from dek.server_members where server_id=$1 and user_id=$2',[id,f.alice])).role,'member');
}));
test('105 server settings capability cannot edit role policies or other servers',()=>each(async(db,f)=>{
 await expectError(call(db,f,'alice','update_server',{p_server:f.medical,p_patch:{description:'no'}}),'forbidden');await set(db,f,{edit_server:true});
 assert.equal((await call(db,f,'alice','update_server',{p_server:f.medical,p_patch:{description:'yes'}})).description,'yes');
 await expectError(call(db,f,'alice','set_server_role_permissions105',{p_server:f.medical,p_role:'member',p_permissions:{assign_roles:true}}),'forbidden');
 await expectError(call(db,f,'alice','update_server',{p_server:f.tech,p_patch:{description:'no'}}),'forbidden');
}));
test('105 delegated server and private-channel join decisions are current and scoped',()=>each(async(db,f)=>{
 await db.serverMember(f.medical,f.carol);const req=(await db.one("insert into dek.join_requests(org_id,server_id,user_id)values($1,$2,$3)returning id",[f.org,f.medical,f.stranger])).id;
 await expectError(call(db,f,'alice','decide_join_request',{p_request:req,p_approve:false}),'forbidden');await set(db,f,{decide_join_requests:true});
 assert((await call(db,f,'alice','list_join_requests',{p_org:f.org})).items.some(x=>x.id===req));await call(db,f,'alice','decide_join_request',{p_request:req,p_approve:false});
 const cr=(await db.one('insert into dek.channel_join_requests(org_id,channel_id,user_id)values($1,$2,$3)returning id',[f.org,f.grants,f.bob])).id;
 await call(db,f,'alice','decide_channel_request',{p_request:cr,p_approve:true});
 await set(db,f,{decide_join_requests:false});const cr2=(await db.one('insert into dek.channel_join_requests(org_id,channel_id,user_id)values($1,$2,$3)returning id',[f.org,f.grants,f.admin])).id;
 await expectError(call(db,f,'alice','decide_channel_request',{p_request:cr2,p_approve:false}),'forbidden');
}));
test('105 every action preserves foreign, guest, suspended and partial boundaries',()=>each(async(db,f)=>{
 await set(db,f,{add_people:true,create_channels:true,edit_channels:true,edit_server:true,assign_roles:true,invite_people:true});
 for(const u of[f.eve,f.stranger])await expectError(db.call(u,'create_channel',{p_server:f.medical,p_name:'no'}),'not_found');
 for(const u of[f.guest,f.carol])await expectError(db.call(u,'create_channel',{p_server:f.medical,p_name:'no'}),'forbidden');
 await expectError(db.call(f.suspended,'create_channel',{p_server:f.medical,p_name:'no'}),'suspended');
 await db.q('update dek.servers set archived_at=now()where id=$1',[f.medical]);await expectError(call(db,f,'alice','create_channel',{p_server:f.medical,p_name:'no'}),'archived');
}));
