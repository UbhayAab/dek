// Performance evidence for the [msg] hot paths (BUILDER-RULES "Performance is a
// requirement"). Builds a realistic world inside the rolled-back transaction:
// Alice in 62 channels across 3 servers and 30 DMs, about 4,600 messages in her
// conversations, 300 thread replies, mentions, follows and files, plus 21,000
// messages she cannot see (another JCF server and the other tenant). ANALYZE runs
// inside the transaction so the planner sees real statistics (pg_statistic rolls
// back with everything else).
//
// Each call is timed server side (EXPLAIN ANALYZE "Execution Time", median of 7),
// and its nested statements are captured once through auto_explain to prove that
// no statement scans a large table sequentially.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx } from './_harness.mjs';

const WORDS = [
  'budget', 'grant', 'report', 'meeting', 'patient', 'visit', 'hospital', 'camp', 'volunteer', 'donor',
  'schedule', 'review', 'draft', 'approval', 'travel', 'invoice', 'training', 'screening', 'oncology', 'follow',
  'update', 'call', 'notes', 'plan', 'field', 'district', 'partner', 'proposal', 'deadline', 'agenda',
  'minutes', 'photo', 'consent', 'referral', 'pharmacy', 'transport', 'ward', 'doctor', 'nurse', 'counselling',
  'नमस्ते', 'बैठक', 'रिपोर्ट', 'मरीज़', 'अस्पताल', 'धन्यवाद', 'कल', 'आज', 'समय', 'योजना',
];
const BIG_TABLES = new Set(['messages', 'mentions', 'reactions', 'attachments', 'channel_members',
  'thread_follows', 'saved_messages', 'server_members', 'org_members', 'notification_intents']);

// Eight words picked by hash from WORDS, then a unique tail.
const BODY = (salt) => `array_to_string(array(
     select ($W::text[])[1 + (abs(hashtext(${salt} || ':' || k)) % 50)] from generate_series(1, 8) k), ' ')`;

async function world(db) {
  const f = await db.fixture();
  const people = (await db.q(`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
           'perf-' || g || '-' || substr(md5(random()::text), 1, 10) || '@dek-test.invalid', '', now(),
           '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('display_name', 'Person ' || g),
           now(), now()
      from generate_series(1, 200) g
    returning id`)).map((r) => r.id);
  await db.q('insert into dek.org_members (org_id, user_id) select $1::uuid, unnest($2::uuid[])', [f.org, people]);

  const servers = [f.medical];
  for (const name of ['Operations', 'Field Work']) servers.push(await db.server(f.org, name, { members: [f.alice] }));
  const hidden = await db.server(f.org, 'Admin Office', {});
  // about a quarter of the people in each server (median membership is one or two)
  const joinServers = (ids) => db.q(`
    insert into dek.server_members (server_id, user_id, org_id)
    select s, p, $1::uuid from unnest($2::uuid[]) s, unnest($3::uuid[]) p
     where abs(hashtext(s::text || p::text)) % 4 = 0
    on conflict do nothing`, [f.org, ids, people]);
  await joinServers([...servers, hidden]);

  const newChannels = async (serverIds, perServer) => (await db.q(`
    insert into dek.channels (org_id, server_id, kind, name, visibility, position)
    select s.org_id, s.id, 'text', 'chan-' || substr(s.id::text, 1, 6) || '-' || g,
           case when g % 4 = 0 then 'private' else 'public' end, g
      from dek.servers s, generate_series(1, $2::int) g
     where s.id = any($1::uuid[])
    returning id`, [serverIds, perServer])).map((r) => r.id);
  const mine = [...await newChannels(servers, 20), f.general, f.grants];
  const notMine = await newChannels([hidden], 20);
  await db.q(`insert into dek.channel_members (channel_id, user_id, org_id)
              select c, $3::uuid, $1::uuid from unnest($2::uuid[]) c
              union all
              select c, ($4::uuid[])[1 + (abs(hashtext(c::text || ':' || k)) % 200)], $1::uuid
                from unnest($2::uuid[]) c, generate_series(1, 20) k
              on conflict do nothing`, [f.org, mine, f.alice, people]);

  const dms = (await db.q(`
    with d as (
      insert into dek.channels (org_id, kind, visibility, dm_key)
      select $1::uuid, 'dm', 'private', $1::text || ':' || least($2::text, p::text) || ':' || greatest($2::text, p::text)
        from unnest(($3::uuid[])[1:30]) p
      returning id, dm_key),
    m as (
      insert into dek.channel_members (channel_id, user_id, org_id)
      select d.id, x::uuid, $1::uuid from d cross join lateral unnest(string_to_array(substr(d.dm_key, 38), ':')) x
      returning channel_id)
    select distinct channel_id as id from m`, [f.org, f.alice, people])).map((r) => r.id);

  // everybody else's conversations, so channels, channel_state and channel_members
  // have production-like sizes: 2,000 DMs between other people, and 10 more servers
  // of 20 channels with 10 members each that Alice is not in
  await db.q(`
    with pairs as (
      select ($2::uuid[])[i] as a, ($2::uuid[])[1 + ((i - 1 + k) % 200)] as b
        from generate_series(1, 200) i, generate_series(1, 10) k),
    d as (
      insert into dek.channels (org_id, kind, visibility, dm_key)
      select $1::uuid, 'dm', 'private', $1::text || ':' || least(a::text, b::text) || ':' || greatest(a::text, b::text)
        from pairs
      returning id, dm_key)
    insert into dek.channel_members (channel_id, user_id, org_id)
    select d.id, x::uuid, $1::uuid from d cross join lateral unnest(string_to_array(substr(d.dm_key, 38), ':')) x`,
  [f.org, people]);
  const others = [];
  for (let i = 0; i < 10; i += 1) others.push(await db.server(f.org, `Team ${i}`, {}));
  await joinServers(others);
  const otherChannels = await newChannels(others, 20);
  await db.q(`insert into dek.channel_members (channel_id, user_id, org_id)
              select c, ($3::uuid[])[1 + (abs(hashtext(c::text || ':' || k)) % 200)], $1::uuid
                from unnest($2::uuid[]) c, generate_series(1, 10) k
              on conflict do nothing`, [f.org, otherChannels, people]);

  // messages: 60 per channel of Alice's, 20 per DM, 300 per hidden channel
  const fill = (channels, n, authorSql) => db.q(
    `insert into dek.messages (org_id, channel_id, seq, author_id, body, created_at, updated_at)
     select c.org_id, c.id, g, ${authorSql}, ${BODY("c.id::text || g")} || ' #' || g,
            now() - make_interval(secs => ($5::int - g) * 37), now() - make_interval(secs => ($5::int - g) * 37)
       from dek.channels c, generate_series(1, $2::int) g
      where c.id = any($1::uuid[])`.replace(/\$W/g, '$4'),
    [channels, n, people, WORDS, n]);
  const randomAuthor = '($3::uuid[])[1 + (abs(hashtext(c.id::text || g)) % 200)]';
  await fill(mine, 60, randomAuthor);
  await fill(dms, 20, randomAuthor);
  await fill(notMine, 300, randomAuthor);
  await db.q('update dek.messages set author_id = $1 where channel_id = any($2::uuid[]) and seq % 7 = 0',
    [f.alice, [...mine, ...dms]]);

  // the other tenant: 10 channels with 1,500 messages each
  const evePeople = people.slice(150);
  const theirs = (await db.q(`
    insert into dek.channels (org_id, server_id, kind, name, position)
    select $1, $2, 'text', 'ss-' || g, g from generate_series(1, 10) g returning id`,
  [f.otherOrg, f.otherServer])).map((r) => r.id);
  await db.q('insert into dek.org_members (org_id, user_id) select $1::uuid, unnest($2::uuid[]) on conflict do nothing',
    [f.otherOrg, evePeople]);
  await fill(theirs, 1500, randomAuthor);

  // threads: 10 roots in each of 10 channels with 3 replies each
  await db.q(`
    insert into dek.messages (org_id, channel_id, seq, thread_root_id, in_timeline, author_id, body, created_at, updated_at)
    select r.org_id, r.channel_id, 60 + (r.seq - 1) * 3 + k, r.id, false, ($2::uuid[])[1 + k], 'reply ' || k,
           r.created_at + make_interval(secs => k), r.created_at + make_interval(secs => k)
      from dek.messages r, generate_series(1, 3) k
     where r.channel_id = any($1::uuid[]) and r.seq <= 10`, [mine.slice(0, 10), people]);
  await db.q(`
    update dek.messages r set reply_count = 3, last_reply_at = r.created_at + interval '3 seconds',
           reply_user_ids = array[($2::uuid[])[4], ($2::uuid[])[3], ($2::uuid[])[2]]
     where r.channel_id = any($1::uuid[]) and r.seq <= 10 and r.thread_root_id is null`, [mine.slice(0, 10), people]);
  await db.q(`
    insert into dek.thread_follows (root_id, user_id, channel_id, org_id, last_read_reply_seq)
    select r.id, $2, r.channel_id, r.org_id, 60 + (r.seq - 1) * 3 + 1
      from dek.messages r where r.channel_id = any($1::uuid[]) and r.seq <= 10 and r.thread_root_id is null`,
  [mine.slice(0, 10), f.alice]);
  // other people follow threads too: 30 followers on each of 100 roots
  await db.q(`
    insert into dek.thread_follows (root_id, user_id, channel_id, org_id)
    select r.id, ($2::uuid[])[1 + (abs(hashtext(r.id::text || ':' || k)) % 200)], r.channel_id, r.org_id
      from dek.messages r, generate_series(1, 30) k
     where r.channel_id = any($1::uuid[]) and r.seq <= 10 and r.thread_root_id is null
    on conflict do nothing`, [mine.slice(0, 10), people]);

  // files on every tenth message of Alice's channels
  await db.q(`
    with a as (
      insert into dek.attachments (org_id, channel_id, message_id, uploader_id, object_path, file_name,
                                   declared_mime, mime_type, size_bytes, status, created_at)
      select m.org_id, m.channel_id, m.id, m.author_id,
             m.org_id || '/' || m.channel_id || '/' || gen_random_uuid() || '/f.pdf',
             ($2::text[])[1 + (abs(hashtext(m.id::text)) % 40)] || '-' || m.seq || '.pdf',
             'application/pdf', 'application/pdf', 1000, 'ready', m.created_at
        from dek.messages m where m.channel_id = any($1::uuid[]) and m.seq % 10 = 0 and m.thread_root_id is null
      returning message_id)
    update dek.messages m set attachment_count = 1 from a where a.message_id = m.id`, [mine, WORDS]);

  // everybody else's files too (about 7,000), so attachments has a production-like size
  await db.q(`
    with a as (
      insert into dek.attachments (org_id, channel_id, message_id, uploader_id, object_path, file_name,
                                   declared_mime, mime_type, size_bytes, status, created_at)
      select m.org_id, m.channel_id, m.id, m.author_id,
             m.org_id || '/' || m.channel_id || '/' || gen_random_uuid() || '/f.pdf',
             ($2::text[])[1 + (abs(hashtext(m.id::text)) % 40)] || '-' || m.seq || '.pdf',
             'application/pdf', 'application/pdf', 1000, 'ready', m.created_at
        from dek.messages m where m.channel_id = any($1::uuid[]) and m.seq % 3 = 0
      returning message_id)
    update dek.messages m set attachment_count = 1 from a where a.message_id = m.id`,
  [[...notMine, ...theirs], WORDS]);
  // one word that appears exactly once, in one of Alice's channels
  await db.q(`update dek.messages set body = body || ' zebracrossing' where channel_id = $1 and seq = 33`, [mine[5]]);

  // mentions of Alice on every ninth message
  await db.q(`
    insert into dek.mentions (message_id, user_id, channel_id, org_id, seq, created_at)
    select m.id, $2, m.channel_id, m.org_id, m.seq, m.created_at
      from dek.messages m where m.channel_id = any($1::uuid[]) and m.seq % 9 = 0 and m.author_id <> $2`,
  [[...mine, ...dms], f.alice]);
  // and everyone else gets mentioned as well (about 5,000 rows)
  await db.q(`
    insert into dek.mentions (message_id, user_id, channel_id, org_id, seq, created_at)
    select m.id, ($2::uuid[])[1 + (abs(hashtext(m.id::text)) % 200)], m.channel_id, m.org_id, m.seq, m.created_at
      from dek.messages m where m.org_id = $1 and m.seq % 5 = 0
    on conflict do nothing`, [f.org, people]);

  // channel cursors, and Alice's read positions (20 unread per channel, 5 per DM)
  await db.q(`
    update dek.channel_state st
       set last_seq = x.n, last_top_seq = x.t, last_message_at = x.at
      from (select channel_id, max(seq) as n, max(seq) filter (where in_timeline) as t, max(created_at) as at
              from dek.messages group by channel_id) x
     where st.channel_id = x.channel_id`);
  await db.q('update dek.channel_members set last_read_seq = 40 where user_id = $1 and channel_id = any($2::uuid[])',
    [f.alice, mine]);
  await db.q('update dek.channel_members set last_read_seq = 15 where user_id = $1 and channel_id = any($2::uuid[])',
    [f.alice, dms]);

  for (const t of ['messages', 'channels', 'channel_state', 'channel_members', 'mentions', 'thread_follows',
    'attachments', 'server_members', 'org_members', 'servers', 'profiles']) {
    await db.q(`analyze dek.${t}`);
  }
  const counts = await db.one(`
    select (select count(*) from dek.messages where channel_id = any($1::uuid[]))::int as alice_messages,
           (select count(*) from dek.messages)::int as all_messages,
           (select count(*) from dek.channel_members where user_id = $2)::int as alice_memberships,
           (select count(*) from dek.channels)::int as channels,
           (select count(*) from dek.channel_members)::int as channel_members,
           (select count(*) from dek.mentions)::int as mentions,
           (select count(*) from dek.thread_follows)::int as thread_follows,
           (select count(*) from dek.attachments)::int as attachments`,
  [[...mine, ...dms], f.alice]);
  return { f, mine, dms, notMine, theirs, people, counts };
}

async function asUser(db, uid, fn) {
  await db.c.query('savepoint perf_call');
  try {
    await db.c.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: uid, role: 'authenticated', aud: 'authenticated' })]);
    await db.c.query('set local role authenticated');
    const out = await fn();
    await db.c.query('reset role');
    await db.c.query('release savepoint perf_call');
    return out;
  } catch (e) {
    await db.c.query('rollback to savepoint perf_call');
    await db.c.query('reset role');
    throw e;
  }
}

// Server-side execution time in ms, median of n runs.
async function median(db, uid, sql, n = 7) {
  const times = [];
  for (let i = 0; i < n; i += 1) {
    const plan = await asUser(db, uid, () =>
      db.c.query(`explain (analyze, timing off, summary on, format json) ${sql}`));
    times.push(plan.rows[0]['QUERY PLAN'][0]['Execution Time']);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(n / 2)], min: times[0], max: times[n - 1] };
}

// Every statement the call runs, with its plan (auto_explain, nested statements).
async function nestedPlans(db, uid, sql) {
  const notices = [];
  const onNotice = (n) => { if (n.message?.includes('plan:')) notices.push(n.message); };
  db.c.on('notice', onNotice);
  await db.c.query('savepoint perf_plans');
  try {
    await db.c.query('set local auto_explain.log_min_duration = 0');
    await db.c.query('set local auto_explain.log_nested_statements = on');
    await db.c.query('set local auto_explain.log_analyze = off');
    await db.c.query('set local client_min_messages = log');
    await asUser(db, uid, () => db.c.query(sql));
  } finally {
    await db.c.query('rollback to savepoint perf_plans');
    db.c.off('notice', onNotice);
  }
  const seqScans = new Set();
  const indexes = new Set();
  const where = [];
  for (const text of notices) {
    const query = (text.split('Query Text:')[1] ?? '').trim().split('\n')[0].slice(0, 140);
    for (const m of text.matchAll(/Seq Scan on (\w+)/g)) {
      if (!seqScans.has(m[1])) where.push(`${m[1]} <- ${query}`);
      seqScans.add(m[1]);
    }
    for (const m of text.matchAll(/(?:Index Scan|Index Only Scan|Bitmap Index Scan)(?: Backward)? (?:using|on) (\w+)/g)) indexes.add(m[1]);
  }
  return { statements: notices.length, seqScans: [...seqScans], indexes: [...indexes].sort(), where };
}

test('perf: bootstrap, list_messages, sync_channel and search stay fast and indexed on a realistic world', { timeout: 600e3 }, (t) => tx(async (db) => {
  await db.q("set local statement_timeout = '300s'");
  const started = Date.now();
  const w = await world(db);
  const { f } = w;
  const busy = w.mine[0];
  t.diagnostic(`world built in ${Date.now() - started} ms: ${JSON.stringify(w.counts)}`);
  assert.ok(w.counts.alice_memberships >= 90, '60+ joined channels and 30 DMs');
  assert.ok(w.counts.alice_messages >= 3000);

  const since = new Date(Date.now() - 5 * 60e3).toISOString();
  const cases = [
    ['bootstrap', `select api.bootstrap('${f.org}'::uuid)`],
    ['list_messages (newest page)', `select api.list_messages('${busy}'::uuid)`],
    ['list_messages (older page)', `select api.list_messages('${busy}'::uuid, 40)`],
    ['sync_channel (reconnect)', `select api.sync_channel('${busy}'::uuid, 40, '${since}'::timestamptz, 1)`],
    ['search (common word)', `select api.search('${f.org}'::uuid, 'budget')`],
    ['search (prefix, 2 terms)', `select api.search('${f.org}'::uuid, 'bud pat')`],
    ['search (Hindi)', `select api.search('${f.org}'::uuid, 'बैठक')`],
    ['search (rare word)', `select api.search('${f.org}'::uuid, 'zebracrossing')`],
    ['search_files', `select api.search_files('${f.org}'::uuid, 'budget')`],
    ['me', 'select api.me()'],
    ['list_mentions', `select api.list_mentions('${f.org}'::uuid)`],
    ['list_threads', `select api.list_threads('${f.org}'::uuid)`],
    ['unread_feed', `select api.unread_feed('${f.org}'::uuid)`],
  ];
  const results = {};
  for (const [name, sql] of cases) {
    const runs = name.startsWith('search (') ? 5 : 7;   // search is rate limited at 30 a minute
    const time = await median(db, f.alice, sql, runs);
    const plans = await nestedPlans(db, f.alice, sql);
    results[name] = { ...time, ...plans };
    t.diagnostic(`${name}: median ${time.median.toFixed(1)} ms (min ${time.min.toFixed(1)}, max ${time.max.toFixed(1)}), `
      + `${plans.statements} statements, seq scans: [${plans.seqScans.join(', ')}], indexes: ${plans.indexes.join(', ')}`);
    for (const w of plans.where) t.diagnostic(`    seq scan ${w}`);
  }
  const send = await median(db, f.bob, `select api.send_message('${f.general}'::uuid, gen_random_uuid(), 'perf <@${f.alice}> budget')`);
  t.diagnostic(`send_message: median ${send.median.toFixed(1)} ms (min ${send.min.toFixed(1)}, max ${send.max.toFixed(1)})`);

  // A sequential scan of a few-page table (orgs, servers, a few hundred server
  // memberships) is the planner's right call. None is allowed on a table with
  // 1,000 or more rows, or on the tables that grow with traffic, whatever their size.
  const sizes = await db.q(`select c.relname, c.reltuples from pg_class c
                             where c.relnamespace = 'dek'::regnamespace and c.relkind = 'r'`);
  const big = new Set([...BIG_TABLES].filter((n) => n !== 'server_members' && n !== 'org_members'));
  for (const s of sizes) if (s.reltuples >= 1000) big.add(s.relname);
  t.diagnostic(`tables held to index access: ${[...big].sort().join(', ')}`);
  for (const [name, r] of Object.entries(results)) {
    const bad = r.seqScans.filter((s) => big.has(s));
    assert.deepEqual(bad, [], `${name} scans a large table sequentially`);
  }
  for (const name of ['bootstrap', 'list_messages (newest page)', 'list_messages (older page)',
    'sync_channel (reconnect)', 'search (common word)', 'search (prefix, 2 terms)', 'search (rare word)']) {
    assert.ok(results[name].median < 150, `${name} median ${results[name].median} ms is over 150 ms`);
  }
  for (const name of Object.keys(results)) {
    assert.ok(results[name].median < 150, `${name} median ${results[name].median} ms is over 150 ms`);
  }
  assert.ok(send.median < 150, `send_message median ${send.median} ms`);
}));
