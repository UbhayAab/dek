// The [msg] denial matrix (DEKA05): every function, called by a stranger, by the
// other tenant guessing real ids, by a guest against a public channel, by a
// suspended member and by a cross-team member outside her channel, is refused
// without leaking existence; nothing is written. Owner: msg builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tx, expectError } from './_harness.mjs';
import { send, expectAnonDenied } from './msg-lib.mjs';

const MSG_FUNCTIONS = [
  'me', 'bootstrap', 'get_profiles', 'send_message', 'edit_message', 'delete_message', 'toggle_reaction',
  'list_messages', 'list_messages_around', 'get_message_context', 'list_thread', 'sync_channel', 'mark_read',
  'mark_unread', 'mark_all_read', 'follow_thread', 'mark_thread_read', 'list_threads', 'list_mentions',
  'unread_feed', 'pin_message', 'list_pins', 'save_message', 'list_saved', 'search', 'search_files',
  'list_channel_files',
];

const channelCalls = (ch) => [
  ['send_message', { p_channel: ch, p_client_id: randomUUID(), p_body: 'intrusion' }],
  ['list_messages', { p_channel: ch }],
  ['list_messages_around', { p_channel: ch, p_seq: 1 }],
  ['sync_channel', { p_channel: ch, p_after_seq: 0, p_changed_since: null }],
  ['mark_read', { p_channel: ch, p_seq: 1 }],
  ['mark_unread', { p_channel: ch, p_seq: 1 }],
  ['list_pins', { p_channel: ch }],
  ['list_channel_files', { p_channel: ch }],
];

const messageCalls = (m) => [
  ['edit_message', { p_message: m, p_body: 'intrusion' }],
  ['delete_message', { p_message: m, p_reason: 'intrusion' }],
  ['toggle_reaction', { p_message: m, p_emoji: '👀', p_on: true }],
  ['get_message_context', { p_message: m }],
  ['list_thread', { p_root: m }],
  ['follow_thread', { p_root: m, p_follow: true }],
  ['mark_thread_read', { p_root: m, p_seq: 1 }],
  ['pin_message', { p_message: m, p_pinned: true }],
  ['save_message', { p_message: m, p_saved: true }],
];

const orgCalls = (org) => [
  ['bootstrap', { p_org: org }],
  ['mark_all_read', { p_org: org }],
  ['list_threads', { p_org: org }],
  ['list_mentions', { p_org: org }],
  ['unread_feed', { p_org: org }],
  ['list_saved', { p_org: org }],
  ['search', { p_org: org, p_query: 'confidential' }],
  ['search_files', { p_org: org, p_query: 'confidential' }],
];

const snapshot = (db, f) => db.one(
  `select (select count(*) from dek.messages where org_id = $1)::int as messages,
          (select count(*) from dek.reactions where org_id = $1)::int as reactions,
          (select count(*) from dek.saved_messages where org_id = $1)::int as saved,
          (select count(*) from dek.thread_follows where org_id = $1)::int as follows,
          (select count(*) from dek.messages where org_id = $1 and (pinned_at is not null or deleted_at is not null
                                                                    or edited_at is not null))::int as changed,
          (select coalesce(sum(last_read_seq), 0) from dek.channel_members where org_id = $1)::int as reads`,
  [f.org]);

test('access: the [msg] contract functions all exist in schema api', () => tx(async (db) => {
  const rows = await db.q("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api'");
  const have = new Set(rows.map((r) => r.proname));
  assert.deepEqual(MSG_FUNCTIONS.filter((fn) => !have.has(fn)), []);
}));

test('access: strangers, the other tenant, guests, suspended and cross-team members are refused everywhere (DEKA05)', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, 'confidential medical note');
  await send(db, f.bob, f.general, 'reply', { p_thread_root: m.id });
  const before = await snapshot(db, f);
  const outsiders = { stranger: f.stranger, eve: f.eve, guest: f.guest, suspended: f.suspended, carol: f.carol };
  for (const [who, uid] of Object.entries(outsiders)) {
    for (const [fn, args] of [...channelCalls(f.general), ...messageCalls(m.id)]) {
      await expectError(db.call(uid, fn, args), 'not_found').catch((e) => {
        throw new Error(`${who} ${fn}: ${e.message}`);
      });
    }
  }
  for (const [fn, args] of orgCalls(f.org)) {
    await expectError(db.call(f.stranger, fn, args), 'not_found');
    await expectError(db.call(f.eve, fn, args), 'not_found');
    await expectError(db.call(f.suspended, fn, args), 'suspended');
  }
  // the guest and carol are org members: org-wide calls work but show nothing of general
  for (const uid of [f.guest, f.carol]) {
    const hits = await db.call(uid, 'search', { p_org: f.org, p_query: 'confidential' });
    assert.deepEqual(hits.items, []);
    const b = await db.call(uid, 'bootstrap', { p_org: f.org });
    assert.ok(!b.channels.some((c) => c.id === f.general));
  }
  assert.deepEqual(await snapshot(db, f), before, 'no denied call wrote anything');
}));

test('access: a member of one tenant guessing the other tenant\'s ids is refused the same way (DEKA05)', () => tx(async (db) => {
  const f = await db.fixture();
  const theirs = await send(db, f.eve, f.otherChannel, 'safalta private');
  for (const [fn, args] of [...channelCalls(f.otherChannel), ...messageCalls(theirs.id)]) {
    await expectError(db.call(f.alice, fn, args), 'not_found').catch((e) => { throw new Error(`${fn}: ${e.message}`); });
    await expectError(db.call(f.owner, fn, args), 'not_found').catch((e) => { throw new Error(`${fn}: ${e.message}`); });
  }
  for (const [fn, args] of orgCalls(f.otherOrg)) {
    await expectError(db.call(f.alice, fn, args), 'not_found');
  }
  // made-up ids look exactly like real ones the caller cannot see
  for (const [fn, args] of [...channelCalls(randomUUID()), ...messageCalls(randomUUID())]) {
    await expectError(db.call(f.alice, fn, args), 'not_found');
  }
  for (const [fn, args] of orgCalls(randomUUID())) {
    await expectError(db.call(f.alice, fn, args), 'not_found');
  }
  const row = await db.one('select body, deleted_at, pinned_at, reactions from dek.messages where id = $1', [theirs.id]);
  assert.deepEqual(row, { body: 'safalta private', deleted_at: null, pinned_at: null, reactions: {} });
}));

// PostgREST runs STABLE functions in a read-only transaction; a write slipped into
// one would pass these read-write test transactions and fail in production.
test('access: the read functions are STABLE and work inside a read-only transaction', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, 'read only please');
  const reads = [
    ['get_profiles', { p_ids: [f.bob] }],
    ['list_messages', { p_channel: f.general }],
    ['list_messages_around', { p_channel: f.general, p_seq: 1 }],
    ['get_message_context', { p_message: m.id }],
    ['list_thread', { p_root: m.id }],
    ['sync_channel', { p_channel: f.general, p_after_seq: 0, p_changed_since: null }],
    ['list_threads', { p_org: f.org }],
    ['list_mentions', { p_org: f.org }],
    ['unread_feed', { p_org: f.org }],
    ['list_pins', { p_channel: f.general }],
    ['list_saved', { p_org: f.org }],
    ['search_files', { p_org: f.org, p_query: 'plan' }],
    ['list_channel_files', { p_channel: f.general }],
  ];
  const vol = await db.q(
    `select p.proname, p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and p.proname = any($1)`, [reads.map(([fn]) => fn)]);
  assert.deepEqual(vol.filter((r) => r.provolatile !== 's').map((r) => r.proname), []);
  assert.equal(vol.length, reads.length);
  await db.q('savepoint read_only');
  try {
    await db.q('set local transaction_read_only = on');
    for (const [fn, args] of reads) await db.call(f.bob, fn, args);
    const write = await db.call(f.bob, 'mark_read', { p_channel: f.general, p_seq: 1 }).catch((e) => e);
    assert.equal(write.sqlstate, '25006', 'the guard is real: a writing function fails here');
  } finally {
    await db.q('rollback to savepoint read_only');
  }
}));

test('access: anonymous callers are refused by every [msg] function', () => tx(async (db) => {
  const f = await db.fixture();
  const m = await send(db, f.alice, f.general, 'x');
  const calls = [
    ['me', {}], ['get_profiles', { p_ids: [f.alice] }],
    ...channelCalls(f.general), ...messageCalls(m.id), ...orgCalls(f.org),
  ];
  assert.equal(new Set(calls.map(([fn]) => fn)).size, MSG_FUNCTIONS.length, 'every function is in the matrix');
  for (const [fn, args] of calls) await expectAnonDenied(db.call(null, fn, args));
}));
