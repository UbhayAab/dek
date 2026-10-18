import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {tx} from './_harness.mjs';
test('Activity performance: sparse old cleared and many exact receipts remain correct with history',()=>tx(async db=>{
 const f=await db.fixture();
 await db.q(`insert into dek.messages(org_id,channel_id,seq,author_id,body,mention_all,created_at)
  select $1,$2,n,$3,'synthetic activity history',true,now()-interval '1 day'+n*interval '1 second' from generate_series(1,2000)n`,[f.org,f.general,f.bob]);
 await db.q(`insert into dek.mentions(message_id,user_id,channel_id,org_id,seq,created_at) select id,$2,channel_id,org_id,seq,created_at from dek.messages where channel_id=$1`,[f.general,f.alice]);
 await db.q(`insert into dek.activity_states(user_id,kind,target_id,channel_id,org_id,read_at,cleared_at,revision)
  select $2,'mention',id,channel_id,org_id,case when seq<=1990 then now() end,case when seq=1 then now() end,nextval('dek.activity_revision_seq') from dek.messages where channel_id=$1`,[f.general,f.alice]);
 for(const table of ['messages','mentions','channel_members','activity_states'])await db.q(`analyze dek.${table}`);
 const receipts=[];
 for(const view of ['cleared','unread','all']){
  const page=await db.call(f.alice,'list_activity_inbox',{p_org:f.org,p_kind:'mention',p_view:view,p_limit:30});
  assert.equal(page.items.length,view==='cleared'?1:view==='unread'?10:30);
  if(view==='cleared')assert.equal(page.items[0].message.seq,1);
  const p=(await db.as(f.alice,`explain(analyze,buffers,format json) select api.list_activity_inbox($1::uuid,'mention',$2::text,null,30)`,[f.org,view]))[0]['QUERY PLAN'][0];
  receipts.push({view,executionMs:p['Execution Time'],plan:p});
 }
 assert.equal((await db.one('select dek.mention_unread_count($1,$2,$3) n',[f.alice,f.org,f.general])).n,10);
 const result={at:new Date().toISOString(),synthetic:true,rolledBack:true,messages:2000,exactRead:1990,sparseClearedSeq:1,receipts};
 console.log(JSON.stringify(receipts.map(({view,executionMs})=>({view,executionMs}))));
 if(process.env.DEK_ACTIVITY_PERF_OUT)writeFileSync(process.env.DEK_ACTIVITY_PERF_OUT,JSON.stringify(result,null,2));
}));
test('Activity performance: reply-heavy receipts and cleared followed roots filter before paging',()=>tx(async db=>{
 const f=await db.fixture();
 await db.q(`insert into dek.messages(org_id,channel_id,seq,author_id,body,reply_count) select $1,$2,n,$3,'synthetic root',100 from generate_series(1,20)n`,[f.org,f.general,f.bob]);
 await db.q(`insert into dek.messages(org_id,channel_id,seq,author_id,body,mention_all,thread_root_id,in_timeline)
 select $1,$2,n,$3,'synthetic tagged reply',true,(select id from dek.messages where channel_id=$2 and seq=((n-21)/100)+1),false from generate_series(21,2020)n`,[f.org,f.general,f.bob]);
 await db.q(`insert into dek.mentions(message_id,user_id,channel_id,org_id,seq,created_at) select id,$2,channel_id,org_id,seq,created_at from dek.messages where channel_id=$1 and thread_root_id is not null`,[f.general,f.alice]);
 await db.q(`insert into dek.thread_follows(root_id,user_id,channel_id,org_id,following) select id,$2,channel_id,org_id,true from dek.messages where channel_id=$1 and thread_root_id is null`,[f.general,f.alice]);
 await db.q(`insert into dek.activity_states(user_id,kind,target_id,channel_id,org_id,read_at,revision)
 select $2,'mention',id,channel_id,org_id,now(),nextval('dek.activity_revision_seq') from dek.messages where channel_id=$1 and thread_root_id is not null and seq<=2010`,[f.general,f.alice]);
 await db.q(`insert into dek.activity_states(user_id,kind,target_id,channel_id,org_id,cleared_at,cleared_through_seq,revision)
 select $2,'thread',r.id,r.channel_id,r.org_id,now(),(select max(seq) from dek.messages where thread_root_id=r.id),nextval('dek.activity_revision_seq') from dek.messages r where r.channel_id=$1 and r.thread_root_id is null and r.seq<20`,[f.general,f.alice]);
 for(const t of ['messages','mentions','channel_members','thread_follows','activity_states'])await db.q(`analyze dek.${t}`);
 const receipts=[];
 for(const [kind,view,expected] of [['mention','unread',10],['thread','cleared',19],['thread','unread',1],['thread','all',1]]){
  const page=await db.call(f.alice,'list_activity_inbox',{p_org:f.org,p_kind:kind,p_view:view,p_limit:30});assert.equal(page.items.length,expected);
  const p=(await db.as(f.alice,`explain(analyze,buffers,format json) select api.list_activity_inbox($1::uuid,$2::text,$3::text,null,30)`,[f.org,kind,view]))[0]['QUERY PLAN'][0];receipts.push({kind,view,executionMs:p['Execution Time'],plan:p});
 }
 console.log(JSON.stringify({replyHeavy:receipts.map(({kind,view,executionMs})=>({kind,view,executionMs}))}));
 if(process.env.DEK_ACTIVITY_PERF_OUT)writeFileSync(process.env.DEK_ACTIVITY_PERF_OUT.replace('.json','-replies.json'),JSON.stringify({synthetic:true,rolledBack:true,replies:2000,roots:20,exactRead:1990,clearedRoots:19,receipts},null,2));
}));
