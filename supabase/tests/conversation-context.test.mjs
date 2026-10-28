// Real TEST-branch RLS/RPC contracts; every fixture and notification intent rolls back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { send } from './msg-lib.mjs';
import { device, claim, release, users } from './plat-lib.mjs';
import { readFileSync } from 'node:fs';
const channelFor=async(db,user,channel)=>(await db.one('select dek.channel_json(c,$2) j from dek.channels c where id=$1',[channel,user])).j;

test('tags: authoritative scanner agrees with renderer syntax fixtures, including nested code and complete links',()=>tx(async db=>{
  const cases=JSON.parse(readFileSync(new URL('./mention-syntax-cases.json',import.meta.url),'utf8'));
  const token='<@304ca758-4908-41e8-ba54-a4a0428b0e0e>';
  for(const c of cases) {
    const {clean}=await db.one('select dek.mention_source($1) clean',[c.body.replaceAll('TOKEN',token)]);
    assert.equal([...clean.matchAll(/<@[^>]+>|<!(?:channel|here)>/g)].length,c.active,c.name);
  }
  const long='`'.repeat(3000)+' <@304ca758-4908-41e8-ba54-a4a0428b0e0e> '+'`'.repeat(3000);
  assert.equal((await db.one('select dek.mention_source($1) clean',[long])).clean,'');
  if(process.env.DEK_MENTION_ORACLE_OUT) {
    const oracle=JSON.parse(readFileSync(process.env.DEK_MENTION_ORACLE_OUT,'utf8'));
    const rows=await db.q(`select x->>'name' name,(x->>'expected')::int expected,
      (select count(*)::int from regexp_matches(dek.mention_source(x->>'body'),'<(@[^>]+|!(channel|here))>','g')) actual
      from jsonb_array_elements($1::jsonb) x`,[JSON.stringify(oracle)]);
    for(const r of rows)assert.equal(r.actual,r.expected,r.name);
    console.log(`paired renderer/PostgreSQL oracle cases: ${rows.length}`);
  }
}));

test('thread context: exact reply beyond100, bounded latest and bidirectional windows, no wrong-root fallback',()=>tx(async db=>{
  const f=await db.fixture(), root=await send(db,f.bob,f.general,'discussion');
  await db.q(`insert into dek.messages(org_id,channel_id,seq,thread_root_id,in_timeline,author_id,body)
    select $1,$2,n,$3,false,$4,'synthetic reply '||n from generate_series(2,151) n`,[f.org,f.general,root.id,f.bob]);
  const target=await db.one('select id from dek.messages where channel_id=$1 and seq=120',[f.general]);
  const latest=await db.call(f.alice,'thread_window',{p_root:root.id});
  assert.equal(latest.replies.length,50); assert.equal(latest.first_seq,102); assert.equal(latest.last_seq,151);
  assert.equal(latest.has_before,true); assert.equal(latest.has_after,false);
  const around=await db.call(f.alice,'thread_window',{p_root:root.id,p_target:target.id,p_limit:20});
  assert.equal(around.replies.length,20); assert.ok(around.replies.some(m=>m.id===target.id));
  assert.equal(around.target_id,target.id); assert.equal(around.has_before,true); assert.equal(around.has_after,true);
  const before=await db.call(f.alice,'thread_window',{p_root:root.id,p_before_seq:around.first_seq,p_limit:20});
  assert.ok(before.replies.every(m=>m.seq<around.first_seq));
  const after=await db.call(f.alice,'thread_window',{p_root:root.id,p_after_seq:around.last_seq,p_limit:20});
  assert.ok(after.replies.every(m=>m.seq>around.last_seq));
  const other=await send(db,f.carol,f.grants,'other discussion');
  await expectError(db.call(f.alice,'thread_window',{p_root:root.id,p_target:other.id}),'not_found');
  for(const uid of [f.stranger,f.eve,f.guest,f.suspended]) await expectError(db.call(uid,'thread_window',{p_root:root.id}),'not_found');
  await expectError(db.call(f.alice,'thread_window',{p_root:root.id,p_target:target.id,p_after_seq:1}),'invalid_input');
  await db.q('update dek.messages set deleted_at=now(),body=\'\' where id=$1',[target.id]);
  const deleted=await db.call(f.alice,'thread_window',{p_root:root.id,p_target:target.id});
  assert.ok(deleted.replies.find(m=>m.id===target.id).deleted_at,'exact tombstone remains in context');
}));

test('thread context: viewing an older tag reads only visible thread replies, preserves main/later unread and follow preference',()=>tx(async db=>{
  const f=await db.fixture(), root=await send(db,f.bob,f.general,'discussion');
  const tagged=await send(db,f.bob,f.general,`hello <@${f.alice}>`,{p_thread_root:root.id});
  const later=await send(db,f.owner,f.general,'later unseen reply',{p_thread_root:root.id});
  const main=await send(db,f.bob,f.general,`separate <@${f.alice}> main message`);
  // Explicitly unfollow, then prove reading does not re-enable reply alerts.
  await db.call(f.alice,'follow_thread',{p_root:root.id,p_follow:false});
  const before=await channelFor(db,f.alice,f.general);
  assert.equal(before.mentions,2);
  const read=await db.call(f.alice,'mark_thread_read',{p_root:root.id,p_seq:tagged.seq});
  assert.equal(read.last_read_reply_seq,tagged.seq);
  const after=await channelFor(db,f.alice,f.general);
  assert.equal(after.last_read_seq,before.last_read_seq); assert.equal(after.unread,before.unread);
  assert.equal(after.mentions,1);
  const mentions=await db.call(f.alice,'list_mention_inbox',{p_org:f.org,p_unread_only:true});
  assert.deepEqual(mentions.items.map(i=>i.message.id),[main.id]);
  const window=await db.call(f.alice,'thread_window',{p_root:root.id,p_target:tagged.id});
  assert.equal(window.following,false); assert.ok(window.last_read_reply_seq<later.seq);
  await db.call(f.alice,'mark_thread_read',{p_root:root.id,p_seq:0});
  assert.equal((await db.call(f.alice,'thread_window',{p_root:root.id})).last_read_reply_seq,tagged.seq);
  const second=await send(db,f.carol,f.grants,'another discussion');
  const reply=await send(db,f.carol,f.grants,'reply',{p_thread_root:second.id});
  await db.call(f.alice,'mark_thread_read',{p_root:second.id,p_seq:reply.seq});
  assert.equal((await db.q('select 1 from dek.thread_follows where root_id=$1 and user_id=$2',[second.id,f.alice])).length,0,'passive read does not create follow preference');
}));

test('tags: direct plus broadcast is one badge; escaped and code tokens do not address anyone; broadcast edit is once',()=>tx(async db=>{
  const f=await db.fixture();
  const m=await send(db,f.owner,f.general,`hello <@${f.alice}> <!channel>`);
  assert.equal((await channelFor(db,f.alice,f.general)).mentions,1);
  const org=(await db.one('select dek.org_summary_json(o,$2) j from dek.orgs o where id=$1',[f.org,f.alice])).j;
  assert.equal(org.mention_count,1);
  const literal=await send(db,f.owner,f.general,`\\<@${f.alice}> \\<!here> \`<@${f.alice}> <!channel>\``);
  assert.deepEqual(literal.mentions,[]); assert.equal(literal.mention_all,false);
  const initial=await db.one('select count(*)::int n from dek.notification_intents where message_id=$1',[m.id]);
  await db.call(f.owner,'edit_message',{p_message:m.id,p_body:'tag removed'});
  await db.call(f.owner,'edit_message',{p_message:m.id,p_body:`tag restored <@${f.alice}> <!channel>`});
  assert.equal((await db.one('select count(*)::int n from dek.notification_intents where message_id=$1',[m.id])).n,initial.n);
}));

test('tags: edit adding direct and broadcast routes one event per device, retry stays one, follow read suppresses only viewed replies',()=>tx(async db=>{
  const f=await db.fixture(); await device(db,f.alice);
  const root=await send(db,f.bob,f.general,'discussion');
  const reply=await send(db,f.owner,f.general,'initial reply',{p_thread_root:root.id});
  await db.call(f.owner,'edit_message',{p_message:reply.id,p_body:`reply <@${f.alice}> <!channel>`});
  const intents=await db.q('select id from dek.notification_intents where message_id=$1 order by id',[reply.id]);
  const deliveries=[];
  for(const i of intents) { const routed=await claim(db,Number(i.id)); deliveries.push(...routed.deliveries); }
  assert.equal(deliveries.filter(d=>d.user_id===f.alice).length,1,'one targeted route owns this simultaneous tag and broadcast');
  assert.ok(deliveries.every(d=>d.url.includes(`/t/${root.id}/m/${reply.id}`)),'deep link includes exact root and reply');
  const once=intents.at(-1); await release(db,Number(once.id));
  // A claim retry cannot create an additional inbox tag row, even before provider recording.
  await claim(db,Number(once.id));
  assert.equal((await db.q('select 1 from dek.mentions where message_id=$1 and user_id=$2',[reply.id,f.alice])).length,1);
  await db.call(f.alice,'mark_thread_read',{p_root:root.id,p_seq:reply.seq});
  assert.equal((await channelFor(db,f.alice,f.general)).mentions,0);
  const later=await send(db,f.owner,f.general,`later <@${f.alice}>`,{p_thread_root:root.id});
  assert.equal((await channelFor(db,f.alice,f.general)).mentions,1);
  assert.ok(later.seq>reply.seq);
}));
