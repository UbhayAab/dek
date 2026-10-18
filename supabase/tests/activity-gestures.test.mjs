// Real TEST contracts. All synthetic messages, receipts and events roll back.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tx,expectError} from './_harness.mjs';
import {send} from './msg-lib.mjs';
import {device,claim} from './plat-lib.mjs';
const list=(db,u,org,kind='mention',view='unread',cursor=null,limit=30)=>db.call(u,'list_activity_inbox',{p_org:org,p_kind:kind,p_view:view,p_cursor:cursor,p_limit:limit});
const act=(db,u,kind,id,action,revision=0,seq=null,operation=randomUUID())=>db.call(u,'set_activity_state',{p_kind:kind,p_target:id,p_action:action,p_expected_revision:revision,p_operation:operation,p_through_seq:seq});
const channel=(db,u,id)=>db.one('select dek.channel_json(c,$2) j from dek.channels c where id=$1',[id,u]).then(r=>r.j);
test('Activity: exact mention read leaves earlier/later main and thread mentions, follow and channel cursor untouched',()=>tx(async db=>{
 const f=await db.fixture(),first=await send(db,f.bob,f.general,`first <@${f.alice}>`),middle=await send(db,f.bob,f.general,`middle <@${f.alice}> <!channel>`),last=await send(db,f.bob,f.general,`last <@${f.alice}>`);
 const before=await channel(db,f.alice,f.general);assert.equal(before.mentions,3);
 const r=await act(db,f.alice,'mention',middle.id,'read');assert.equal(r.read,true);assert.equal(r.cleared,false);
 const after=await channel(db,f.alice,f.general);assert.equal(after.last_read_seq,before.last_read_seq);assert.equal(after.unread,before.unread);assert.equal(after.mentions,2);
 assert.deepEqual(new Set((await list(db,f.alice,f.org)).items.map(i=>i.message.id)),new Set([first.id,last.id]));
 const legacy=await db.call(f.alice,'list_mentions',{p_org:f.org});assert.equal(legacy.items.find(i=>i.message.id===middle.id).read,true);
 const old=await db.call(f.alice,'list_mention_inbox',{p_org:f.org,p_unread_only:true});assert.equal(old.items.length,2);
}));
test('Activity: Clear is reversible, not Read; idempotent retries and stale/ABA Undo never overwrite a newer action',()=>tx(async db=>{
 const f=await db.fixture(),m=await send(db,f.bob,f.general,`hello <@${f.alice}>`),op=randomUUID(),before=await channel(db,f.alice,f.general);
 const cleared=await act(db,f.alice,'mention',m.id,'clear',0,null,op);assert.equal(cleared.read,false);assert.equal(cleared.cleared,true);
 assert.equal((await list(db,f.alice,f.org)).items.length,0);const hidden=await list(db,f.alice,f.org,'mention','cleared');assert.equal(hidden.items[0].read,false);
 assert.deepEqual(await channel(db,f.alice,f.general),before,'Clear changes no semantic read counter or preference');
 assert.equal((await act(db,f.alice,'mention',m.id,'clear',0,null,op)).revision,cleared.revision);
 const restored=await act(db,f.alice,'mention',m.id,'restore',cleared.revision);assert.equal(restored.cleared,false);assert.equal(restored.read,false);
 await expectError(act(db,f.alice,'mention',m.id,'restore',cleared.revision),'conflict');
 await db.q('delete from dek.activity_states where user_id=$1 and target_id=$2',[f.alice,m.id]);
 const newer=await act(db,f.alice,'mention',m.id,'clear');assert.notEqual(newer.revision,cleared.revision);
 await expectError(act(db,f.alice,'mention',m.id,'restore',cleared.revision),'conflict');
 assert.equal((await list(db,f.alice,f.org,'mention','cleared')).items.length,1);
}));
test('Activity: thread clear/read snapshot excludes later replies, deleted boundary retries remain idempotent',()=>tx(async db=>{
 const f=await db.fixture(),root=await send(db,f.bob,f.general,'thread');await db.call(f.alice,'follow_thread',{p_root:root.id,p_follow:true});
 const a=await send(db,f.bob,f.general,'shown reply',{p_thread_root:root.id}),op=randomUUID();
 const cleared=await act(db,f.alice,'thread',root.id,'clear',0,a.seq,op);assert.equal(cleared.cleared,true);
 const b=await send(db,f.bob,f.general,'new unseen reply',{p_thread_root:root.id});
 assert.equal((await list(db,f.alice,f.org,'thread','unread')).items[0].last_reply_seq,b.seq);
 assert.equal((await list(db,f.alice,f.org,'thread','cleared')).items.length,0);
 await db.q('update dek.messages set deleted_at=now(),body=\'\' where id=$1',[a.id]);
 assert.equal((await act(db,f.alice,'thread',root.id,'clear',0,a.seq,op)).revision,cleared.revision);
 const read=await act(db,f.alice,'thread',root.id,'read',cleared.revision,a.seq);assert.equal(read.read,false,'later unseen reply remains unread');
 assert.equal((await list(db,f.alice,f.org,'thread','unread')).items[0].unread_replies,1);
 const w=await db.call(f.alice,'thread_window',{p_root:root.id});assert.equal(w.following,true);assert.equal(w.last_read_reply_seq,a.seq);
 await expectError(act(db,f.alice,'thread',root.id,'clear',read.revision,b.seq+1),'invalid_input');
}));
test('Activity: active/cleared paging filters before limit and cursor is bound to account, org, kind and view',()=>tx(async db=>{
 const f=await db.fixture(),messages=[];for(let n=0;n<5;n++)messages.push(await send(db,f.bob,f.general,`item${n} <@${f.alice}>`));
 for(const m of messages.slice(0,3))await act(db,f.alice,'mention',m.id,'clear');
 const first=await list(db,f.alice,f.org,'mention','cleared',null,2);assert.equal(first.items.length,2);assert.equal(first.has_more,true);assert.equal(first.next_cursor.v,2);
 const second=await list(db,f.alice,f.org,'mention','cleared',first.next_cursor,2);assert.equal(second.items.length,1);assert.equal(second.has_more,false);
 assert.equal(new Set([...first.items,...second.items].map(i=>i.message.id)).size,3);
 assert.equal((await list(db,f.alice,f.org,'mention','all',null,2)).items.length,2);
 for(const [user,org,kind,view] of [[f.bob,f.org,'mention','cleared'],[f.alice,f.org,'mention','all'],[f.alice,f.org,'thread','cleared']])await expectError(list(db,user,org,kind,view,first.next_cursor),'invalid_input');
 const legacy=await db.call(f.alice,'list_mention_inbox',{p_org:f.org,p_limit:1});assert.equal(legacy.next_cursor.v,1);await db.call(f.alice,'list_mention_inbox',{p_org:f.org,p_limit:1,p_cursor:legacy.next_cursor});
}));
test('Activity: authorization, private state grants and membership removal cannot expose or resurrect receipts',()=>tx(async db=>{
 const f=await db.fixture(),m=await send(db,f.bob,f.general,`hello <@${f.alice}>`);
 for(const u of [f.stranger,f.eve,f.guest,f.suspended])await expectError(act(db,u,'mention',m.id,'read'),'not_found');
 await expectError(act(db,f.bob,'mention',m.id,'read'),'not_found');
 await expectError(act(db,f.alice,'thread',m.id,'read',0,0),'not_found');
 await act(db,f.alice,'mention',m.id,'clear');await db.q('delete from dek.channel_members where user_id=$1 and channel_id=$2',[f.alice,f.general]);
 assert.equal((await db.one('select count(*)::int n from dek.activity_states where user_id=$1',[f.alice])).n,0);
 await expectError(act(db,f.alice,'mention',m.id,'restore',1),'not_found');
 const grants=await db.one("select has_table_privilege('authenticated','dek.activity_states','select') r,has_table_privilege('authenticated','dek.activity_states','insert') w,has_sequence_privilege('authenticated','dek.activity_revision_seq','usage') s");assert.deepEqual(grants,{r:false,w:false,s:false});
}));
test('Activity: exact Read suppresses only its queued ordinary alert; Clear and new targeted edit keep delivery semantics',()=>tx(async db=>{
 const f=await db.fixture();await device(db,f.alice);
 const cleared=await send(db,f.bob,f.general,`clear only <@${f.alice}>`);await act(db,f.alice,'mention',cleared.id,'clear');
 const read=await send(db,f.bob,f.general,`read only <@${f.alice}>`);await act(db,f.alice,'mention',read.id,'read');
 const broadcast=await send(db,f.bob,f.general,'broadcast <!channel>');await act(db,f.alice,'mention',broadcast.id,'read');
 const intent=async id=>Number((await db.one('select id from dek.notification_intents where message_id=$1 and target_user_id is null',[id])).id);
 assert.ok((await claim(db,await intent(cleared.id))).deliveries.some(d=>d.user_id===f.alice));
 assert.ok(!(await claim(db,await intent(read.id))).deliveries.some(d=>d.user_id===f.alice));
 assert.ok(!(await claim(db,await intent(broadcast.id))).deliveries.some(d=>d.user_id===f.alice));
 await db.call(f.bob,'edit_message',{p_message:broadcast.id,p_body:`broadcast <!channel> newly direct <@${f.alice}>`});
 const target=await db.one('select id from dek.notification_intents where message_id=$1 and target_user_id=$2',[broadcast.id,f.alice]);
 assert.ok((await claim(db,Number(target.id))).deliveries.some(d=>d.user_id===f.alice),'targeted new tag on edit retains its established read bypass');
}));
