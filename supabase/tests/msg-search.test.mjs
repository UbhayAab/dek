// Search and files: api.search, search_files, list_channel_files (DEK11, DEKA04,
// DEKA05). Owner: msg builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tx, expectError } from './_harness.mjs';
import { send, attachment, fillRate, expectAnonDenied } from './msg-lib.mjs';

const search = (db, uid, org, query, extra = {}) => db.call(uid, 'search', { p_org: org, p_query: query, ...extra });
const bodies = (r) => r.items.map((i) => i.message.body);

// Messages sent in one test transaction share created_at (now() is the transaction
// start), so tests that check order spread them out explicitly.
async function age(db, id, minutes) {
  await db.q('update dek.messages set created_at = now() - make_interval(mins => $2) where id = $1', [id, minutes]);
}

test('search: prefix terms combined with AND, case-insensitive, newest first, paged (DEK11)', () => tx(async (db) => {
  const f = await db.fixture();
  const a = await send(db, f.alice, f.general, 'Quarterly grant report draft');
  const b = await send(db, f.alice, f.general, 'grant meeting tomorrow');
  const c = await send(db, f.bob, f.general, 'Report for the donors');
  await send(db, f.bob, f.general, 'lunch plans');
  await age(db, a.id, 30);
  await age(db, b.id, 20);
  await age(db, c.id, 10);
  assert.deepEqual(bodies(await search(db, f.alice, f.org, 'gra')), ['grant meeting tomorrow', 'Quarterly grant report draft']);
  assert.deepEqual(bodies(await search(db, f.alice, f.org, 'grant rep')), ['Quarterly grant report draft']);
  assert.deepEqual(bodies(await search(db, f.alice, f.org, 'REPORT')), ['Report for the donors', 'Quarterly grant report draft']);
  const r = await search(db, f.alice, f.org, 'grant');
  assert.equal(r.items[0].channel.id, f.general);
  assert.equal(r.items[0].message.id, b.id);
  const p1 = await search(db, f.alice, f.org, 'grant', { p_limit: 1 });
  assert.deepEqual(bodies(p1), ['grant meeting tomorrow']);
  assert.equal(p1.has_more, true);
  const p2 = await search(db, f.alice, f.org, 'grant', { p_limit: 1, p_offset: 1 });
  assert.deepEqual(bodies(p2), ['Quarterly grant report draft']);
  assert.equal(p2.has_more, false);
  assert.deepEqual(await search(db, f.alice, f.org, '   '), { items: [], has_more: false });
  assert.deepEqual(await search(db, f.alice, f.org, '!!! ...'), { items: [], has_more: false });
  // deleted messages are gone from search
  await db.call(f.alice, 'delete_message', { p_message: a.id });
  assert.deepEqual(bodies(await search(db, f.alice, f.org, 'quarterly')), []);
}));

test('search: never another tenant or an unreadable channel; guests and cross-team see only their channels (DEKA04, DEKA05)', () => tx(async (db) => {
  const f = await db.fixture();
  await send(db, f.alice, f.general, 'budget general');
  await send(db, f.alice, f.grants, 'budget grants');
  await send(db, f.owner, f.secret, 'budget leadership');
  await send(db, f.carol, f.techGeneral, 'budget tech');
  await send(db, f.alice, f.dmAliceBob, 'budget dm');
  await send(db, f.eve, f.otherChannel, 'budget safalta');
  const sorted = async (uid, org = f.org) => bodies(await search(db, uid, org, 'budget')).sort();
  assert.deepEqual(await sorted(f.alice), ['budget dm', 'budget general', 'budget grants']);
  assert.deepEqual(await sorted(f.bob), ['budget dm', 'budget general']);
  assert.deepEqual(await sorted(f.carol), ['budget grants', 'budget tech'], 'cross-team: Grants, not Medical general');
  assert.deepEqual(await sorted(f.guest), ['budget grants'], 'guest: only the channel she was added to');
  assert.deepEqual(await sorted(f.owner), ['budget general', 'budget leadership']);
  assert.deepEqual(await sorted(f.eve, f.otherOrg), ['budget safalta']);
  await expectError(search(db, f.eve, f.org, 'budget'), 'not_found');
  await expectError(search(db, f.stranger, f.org, 'budget'), 'not_found');
  await expectError(search(db, f.suspended, f.org, 'budget'), 'suspended');
  await expectError(search(db, f.alice, f.org, 'budget', { p_channel: f.secret }), 'not_found');
  await expectError(search(db, f.alice, f.org, 'budget', { p_channel: f.otherChannel }), 'not_found');
  await expectAnonDenied(search(db, null, f.org, 'budget'));
  // a person in both organizations sees each one only inside it
  await db.member(f.otherOrg, f.alice);
  await db.channelMember(f.otherChannel, f.alice);
  assert.deepEqual(await sorted(f.alice), ['budget dm', 'budget general', 'budget grants']);
  assert.deepEqual(await sorted(f.alice, f.otherOrg), ['budget safalta']);
  // leaving the server takes its channels out of search at once (DEKA06)
  await db.q('delete from dek.server_members where server_id = $1 and user_id = $2', [f.medical, f.bob]);
  await db.q('delete from dek.channel_members where channel_id = $1 and user_id = $2', [f.general, f.bob]);
  assert.deepEqual(await sorted(f.bob), ['budget dm']);
}));

test('search: filters for channel, author, time, files, links and pins; filter-only searches', () => tx(async (db) => {
  const f = await db.fixture();
  const file = await attachment(db, { org: f.org, channel: f.general, uploader: f.alice, name: 'plan.pdf' });
  const withFile = await send(db, f.alice, f.general, 'plan attached', { p_attachment_ids: [file] });
  const withLink = await send(db, f.bob, f.general, 'plan at https://example.org/plan');
  const pinned = await send(db, f.bob, f.general, 'plan pinned');
  await db.call(f.bob, 'pin_message', { p_message: pinned.id, p_pinned: true });
  const old = await send(db, f.alice, f.general, 'plan from last year');
  const inGrants = await send(db, f.alice, f.grants, 'plan in grants');
  await age(db, old.id, 60 * 24 * 400);
  await age(db, withFile.id, 4);
  await age(db, withLink.id, 3);
  await age(db, pinned.id, 2);
  await age(db, inGrants.id, 1);
  const q = (extra) => search(db, f.alice, f.org, 'plan', extra).then((r) => r.items.map((i) => i.message.id));
  assert.deepEqual(await q({ p_has: 'file' }), [withFile.id]);
  assert.deepEqual(await q({ p_has: 'link' }), [withLink.id]);
  assert.deepEqual(await q({ p_has: 'pin' }), [pinned.id]);
  assert.deepEqual(await q({ p_author: f.bob }), [pinned.id, withLink.id]);
  assert.deepEqual(await q({ p_channel: f.grants }), [inGrants.id]);
  const yearAgo = new Date(Date.now() - 300 * 864e5).toISOString();
  assert.deepEqual(await q({ p_before: yearAgo }), [old.id]);
  assert.equal((await q({ p_after: yearAgo })).length, 4);
  await expectError(search(db, f.alice, f.org, 'plan', { p_has: 'video' }), 'invalid_input');
  // without terms: a channel or an author filter walks its own index
  const inGeneral = await search(db, f.alice, f.org, '', { p_channel: f.general, p_has: 'pin' });
  assert.deepEqual(inGeneral.items.map((i) => i.message.id), [pinned.id]);
  const byBob = await search(db, f.alice, f.org, null, { p_author: f.bob });
  assert.deepEqual(byBob.items.map((i) => i.message.id).sort(), [pinned.id, withLink.id].sort());
  const nothing = await search(db, f.alice, f.org, '', { p_has: 'file' });
  assert.deepEqual(nothing, { items: [], has_more: false }, 'org-wide filter-only search returns nothing');
}));

test('search: Hindi and mixed scripts; query text never becomes tsquery syntax', () => tx(async (db) => {
  const f = await db.fixture();
  const hi = await send(db, f.alice, f.general, 'नमस्ते दुनिया, आज की बैठक 4 बजे है');
  const mail = await send(db, f.alice, f.general, 'write to priya.sharma@example.org about it');
  const ids = async (query) => (await search(db, f.bob, f.org, query)).items.map((i) => i.message.id);
  assert.deepEqual(await ids('नमस'), [hi.id], 'prefix of a Devanagari word');
  assert.deepEqual(await ids('दुनिया'), [hi.id]);
  assert.deepEqual(await ids('बैठक नमस्ते'), [hi.id], 'AND across Hindi words');
  assert.deepEqual(await ids('बैठक lunch'), []);
  assert.deepEqual(await ids('priya.sharma@example.org'), [mail.id], 'an email address finds its message');
  const money = await send(db, f.alice, f.general, 'the camp cost 4250.75 rupees');
  assert.deepEqual(await ids('4250.75'), [money.id], 'a decimal finds its message by its whole part');
  for (const nasty of ["it's & | ! ( ) <-> :* \\ '", "'; drop table dek.messages; --", ':*', '&&&', '\\', "a:* | b"]) {
    const r = await search(db, f.bob, f.org, nasty);
    assert.ok(Array.isArray(r.items), `query ${JSON.stringify(nasty)} is plain text`);
  }
  assert.equal((await db.one('select count(*)::int as n from dek.messages where channel_id = $1', [f.general])).n, 3);
}));

test('search: rate limit is 30 per minute', () => tx(async (db) => {
  const f = await db.fixture();
  await search(db, f.alice, f.org, 'anything');
  await fillRate(db, f.alice, 'search', 30, 60);
  await expectError(search(db, f.alice, f.org, 'anything'), 'rate_limited');
}));

test('files: search_files by name in readable channels only; list_channel_files pages newest first', () => tx(async (db) => {
  const f = await db.fixture();
  const put = async (uid, channel, name, minutesAgo) => {
    const id = await attachment(db, { org: channel === f.otherChannel ? f.otherOrg : f.org, channel, uploader: uid, name,
                                      createdAt: new Date(Date.now() - minutesAgo * 60e3).toISOString() });
    const m = await send(db, uid, channel, '', { p_attachment_ids: [id] });
    return { id, message: m.id };
  };
  const xlsx = await put(f.alice, f.general, 'Budget-2026.xlsx', 5);
  const minutes = await put(f.bob, f.general, 'minutes.pdf', 4);
  const docx = await put(f.carol, f.grants, 'grant-budget.docx', 3);
  await put(f.owner, f.secret, 'budget-secret.pdf', 2);
  await put(f.eve, f.otherChannel, 'budget.pdf', 1);
  await attachment(db, { org: f.org, channel: f.general, uploader: f.alice, name: 'budget-unsent.pdf' });
  await attachment(db, { org: f.org, channel: f.general, uploader: f.alice, name: 'budget-pending.pdf', status: 'pending' });

  const names = (r) => r.items.map((i) => i.attachment.file_name);
  const r = await db.call(f.alice, 'search_files', { p_org: f.org, p_query: 'budget' });
  assert.deepEqual(names(r), ['grant-budget.docx', 'Budget-2026.xlsx'], 'readable, sent, ready; newest first');
  assert.equal(r.items[0].message.id, docx.message);
  assert.equal(r.items[0].channel.id, f.grants);
  assert.deepEqual(names(await db.call(f.alice, 'search_files', { p_org: f.org, p_query: 'min' })), ['minutes.pdf']);
  assert.deepEqual(names(await db.call(f.alice, 'search_files', { p_org: f.org, p_query: 'mi' })), [],
    'one or two characters are too short to search names');
  assert.deepEqual(names(await db.call(f.alice, 'search_files', { p_org: f.org })),
    ['grant-budget.docx', 'minutes.pdf', 'Budget-2026.xlsx']);
  assert.deepEqual(names(await db.call(f.alice, 'search_files', { p_org: f.org, p_channel: f.general, p_limit: 1 })),
    ['minutes.pdf']);
  assert.deepEqual(names(await db.call(f.alice, 'search_files', { p_org: f.org, p_query: '100%_' })), []);
  assert.deepEqual(names(await db.call(f.guest, 'search_files', { p_org: f.org, p_query: 'budget' })), ['grant-budget.docx']);
  await expectError(db.call(f.alice, 'search_files', { p_org: f.org, p_channel: f.secret }), 'not_found');
  await expectError(db.call(f.eve, 'search_files', { p_org: f.org }), 'not_found');
  await expectError(db.call(f.suspended, 'search_files', { p_org: f.org }), 'suspended');

  const l1 = await db.call(f.alice, 'list_channel_files', { p_channel: f.general, p_limit: 1 });
  assert.equal(l1.items.length, 1);
  assert.equal(l1.items[0].attachment.id, minutes.id);
  assert.equal(l1.items[0].message_id, minutes.message);
  assert.equal(l1.items[0].author_id, f.bob);
  assert.equal(l1.has_more, true);
  const l2 = await db.call(f.alice, 'list_channel_files', { p_channel: f.general, p_before: l1.items[0].created_at });
  assert.deepEqual(l2.items.map((i) => i.attachment.id), [xlsx.id]);
  assert.equal(l2.has_more, false);
  for (const u of [f.stranger, f.eve, f.guest, f.suspended, f.carol]) {
    await expectError(db.call(u, 'list_channel_files', { p_channel: f.general }), 'not_found');
  }
}));
