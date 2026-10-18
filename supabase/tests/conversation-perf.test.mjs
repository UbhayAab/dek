import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {tx} from './_harness.mjs';
test('conversation count: capped distinct unread probes skip read history on the indexed channel range',()=>tx(async db=>{
 const f=await db.fixture();
 await db.q(`insert into dek.messages(org_id,channel_id,seq,author_id,body,mention_all)
 select $1,$2,n,$3,'synthetic historical mention',true from generate_series(1,2000)n`,[f.org,f.general,f.bob]);
 await db.q(`insert into dek.mentions(message_id,user_id,channel_id,org_id,seq,created_at)
 select id,$2,channel_id,org_id,seq,created_at from dek.messages where channel_id=$1`,[f.general,f.alice]);
 await db.q('update dek.channel_members set last_read_seq=1990 where channel_id=$1 and user_id=$2',[f.general,f.alice]);
 for(const table of ['messages','mentions','channel_members'])await db.q(`analyze dek.${table}`);
 const source=(await db.one("select prosrc from pg_proc where oid='dek.mention_unread_count(uuid,uuid,uuid)'::regprocedure")).prosrc;
 const sql=source.replace(/\bp_uid\b/g,'($1::uuid)').replace(/\bp_org\b/g,'($2::uuid)').replace(/\bp_channel\b/g,'($3::uuid)');
 const plan=(await db.q(`explain(analyze,buffers,format json) ${sql}`,[f.alice,f.org,f.general]))[0]['QUERY PLAN'][0];
 assert.equal((await db.one('select dek.mention_unread_count($1,$2,$3) n',[f.alice,f.org,f.general])).n,10);
 assert.ok(JSON.stringify(plan).includes('Index'),'indexed access remains available');
 const result={at:new Date().toISOString(),synthetic:true,rolledBack:true,messages:2000,directAndBroadcast:true,alreadyRead:1990,distinctUnread:10,plan};
 if(process.env.DEK_CONVERSATION_PERF_OUT)writeFileSync(process.env.DEK_CONVERSATION_PERF_OUT,JSON.stringify(result,null,2));
 console.log(JSON.stringify({distinctUnread:10,executionMs:plan['Execution Time']}));
}));
