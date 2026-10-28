// Synthetic, rolled-back query-plan evidence. No production load or private data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tx } from './_harness.mjs';

test('inbox plans: 2000 followed discussions and mentions use indexed bounded pages', () => tx(async db => {
  const f = await db.fixture();
  await db.q(`insert into dek.messages (org_id, channel_id, seq, author_id, body, reply_count, last_reply_at, mention_all)
    select $1, $2, n, $3, 'synthetic inbox root', 1, now(), n%5=0 from generate_series(1,2000) n`, [f.org, f.general, f.bob]);
  await db.q(`insert into dek.messages (org_id, channel_id, seq, thread_root_id, in_timeline, author_id, body)
    select m.org_id, m.channel_id, m.seq+2000, m.id, false, $2, 'synthetic inbox reply'
    from dek.messages m where m.channel_id=$1 and m.thread_root_id is null`, [f.general, f.bob]);
  await db.q(`insert into dek.thread_follows (root_id,user_id,channel_id,org_id,last_read_reply_seq)
    select id,$2,channel_id,org_id,case when seq%10=0 then 0 else seq+2000 end
    from dek.messages where channel_id=$1 and thread_root_id is null`, [f.general, f.alice]);
  await db.q(`insert into dek.mentions (message_id,user_id,channel_id,org_id,seq,created_at)
    select id,$2,channel_id,org_id,seq,created_at from dek.messages where channel_id=$1 and thread_root_id is null`, [f.general, f.alice]);
  await db.q('update dek.channel_state set last_seq=4000,last_top_seq=2000,last_message_at=now() where channel_id=$1', [f.general]);
  for (const table of ['messages','mentions','thread_follows','channel_state','channel_members']) await db.q(`analyze dek.${table}`);
  const raw = (await db.q(`explain (analyze,buffers,format json)
    select m.id from dek.mentions mn join dek.messages m on m.id=mn.message_id
    where mn.user_id=$1 and mn.org_id=$2 and mn.channel_id=$3 and m.deleted_at is null
    order by mn.created_at desc,mn.message_id desc limit 31`, [f.alice, f.org, f.general]))[0]['QUERY PLAN'][0];
  assert.match(JSON.stringify(raw.Plan), /mentions_inbox_idx/);
  assert.equal(raw.Plan['Actual Rows'], 31);
  const timing = {};
  for (const fn of ['list_thread_inbox','list_mention_inbox']) {
    const times = [];
    for (let i=0;i<3;i++) {
      await db.q('savepoint inbox_plan');
      try {
        await db.q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:f.alice,role:'authenticated',aud:'authenticated'})]);
        await db.q('set local role authenticated');
        const plan = (await db.q(`explain (analyze,timing off,summary on,format json)
          select api.${fn}($1::uuid,null::jsonb,true,30)`, [f.org]))[0]['QUERY PLAN'][0];
        times.push(plan['Execution Time']);
        await db.q('reset role');
        await db.q('release savepoint inbox_plan');
      } catch(e) { await db.q('rollback to savepoint inbox_plan'); await db.q('reset role'); throw e; }
    }
    timing[fn]={samplesMs:times,medianMs:[...times].sort((a,b)=>a-b)[1]};
    const res=await db.call(f.alice,fn,{p_org:f.org,p_cursor:null,p_unread_only:true,p_limit:30});
    assert.equal(res.items.length,30); assert.equal(res.has_more,true); assert.ok(res.next_cursor);
  }
  const result={at:new Date().toISOString(),synthetic:true,rolledBack:true,followedThreads:2000,mentions:2000,messages:4000,
    directMentionPlan:raw,timing,note:'Output is bounded to 30+1; ordering still visits the caller-specific candidate set. This is a test-branch sample, not production load or a fixed performance guarantee.'};
  if(process.env.DEK_INBOX_PERF_OUT) writeFileSync(process.env.DEK_INBOX_PERF_OUT,JSON.stringify(result,null,2));
  console.log(JSON.stringify({followedThreads:2000,mentions:2000,timing,directMentionMs:raw['Execution Time']}));
}));
