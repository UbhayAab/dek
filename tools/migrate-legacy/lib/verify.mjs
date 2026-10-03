// --verify: DEKA16 reconciliation. Per org counts read independently from both
// databases, 30 random messages compared field by field (text by hash), 15 random
// users' readable channel sets compared, every copied file re-hashed, invariants.
import { ORGS, ORG_IDS, TEST_DOMAINS } from './config.mjs';
import { sha256, tsKey, rng, sample } from './util.mjs';
import { normalizeLegacy, normalizeNew, cardInner } from './text.mjs';
import { LEGACY_COUNTS, NEW_COUNTS, invariants, PASSWORD_DIGEST } from './verify-counts.mjs';
import { verifyObjects } from './storage.mjs';

const CHECKS = [
  // [key, label, expected(legacy row, ctx) or null for legacy[key], note]
  ['servers', 'servers'],
  ['servers_archived', 'servers archived'],
  ['text_channels', 'text channels (text, announcement, forum)'],
  ['audio_channels', 'audio channels (voice)'],
  ['private_channels', 'private server channels'],
  ['dm_channels', 'DM channels', null, 'conversations with members, a pair per org merged once'],
  ['org_members', 'org members', null, 'migrated users only'],
  ['org_owners', 'org owners', () => 1, 'Ubhay rule'],
  ['org_admins', 'org admins', (l, x) => l.org_admins - x.ownerWasAdmin, 'legacy admins minus the admin made owner'],
  ['server_members', 'server members'],
  ['channel_members', 'channel memberships', null, 'public: every server member; private: legacy rows; DMs: the pair'],
  ['messages_channel', 'channel messages'],
  ['messages_dm', 'DM messages'],
  ['deleted', 'deleted messages (tombstones)'],
  ['edited', 'edited messages'],
  ['thread_roots', 'thread roots with replies'],
  ['thread_replies', 'thread replies'],
  ['reactions', 'reactions', null, 'on live messages'],
  ['reaction_summary', 'reaction summary entries', (l) => l.reactions, 'messages.reactions arrays add up to the rows'],
  ['mentions', 'mention rows', null, 'mentioned readers other than the author, live messages'],
  ['attachments', 'attachments'],
  ['attachment_bytes', 'attachment bytes'],
  ['stored_bytes', 'bytes stored in media', (l) => l.attachment_bytes],
  ['pins', 'pins'],
  ['saved', 'saved messages'],
  ['invites', 'invites (server and org)'],
  ['invites_usable', 'invites still usable'],
  ['join_requests', 'join requests'],
  ['ban_notes', 'ban notes'],
  ['devices', 'push devices of members'],
  ['devices_enabled', 'push devices enabled', () => 0, 'enabled only at cutover'],
  ['unread_after_cursor', 'messages after each read cursor', null, 'same messages unread for every person with a legacy cursor'],
  ['dm_unread_after_cursor', 'DM messages after each read cursor', null, 'DMs that were not merged; a merged DM uses the read-prefix rule'],
];

const RAW = { channel_members: 'channel_members_raw', reactions: 'reactions_raw', org_members: 'org_members_raw',
  thread_roots: 'threads_raw' };

// Everything verify needs from legacy, read up front so the legacy snapshot is
// released before the long part (downloading every file from the new project).
export async function readLegacyChecks(legacy, d) {
  const counts = {};
  for (const o of ORGS) counts[o.id] = (await legacy.rows(LEGACY_COUNTS, [o.id, ORG_IDS, TEST_DOMAINS]))[0];
  const pd = PASSWORD_DIGEST(d.users.map((u) => u.auth.id));
  return { counts, password: (await legacy.rows(pd.sql, pd.params))[0] };
}

export async function verify({ legacyChecks, target, d, targetStorage, log = () => {}, seed }) {
  const result = { snapshot: d.snapshot.at, seed, checks: [], samples: [], users: [], invariants: [], explained: [] };
  const people = new Map(d.users.map((u) => [u.auth.id, { username: u.profile?.username, display_name: u.profile?.display_name }]));
  const migrated = d.users.map((u) => u.auth.id);

  for (const o of ORGS) {
    const l = legacyChecks.counts[o.id];
    const n = (await target.query(NEW_COUNTS, [o.id])).rows[0];
    const owner = n.org_owners === 1 ? (await target.query(`select user_id from dek.org_members where org_id = $1 and role = 'owner'`, [o.id])).rows[0].user_id : null;
    const ownerWasAdmin = owner && d.orgMembers.some((m) => m.org_id === o.id && m.user_id === owner && m.org_role === 'admin') ? 1 : 0;
    for (const [key, label, fn, note] of CHECKS) {
      const expected = fn ? fn(l, { ownerWasAdmin }) : l[key];
      const actual = n[key];
      result.checks.push({ org: o.short_name, name: label, legacy: RAW[key] ? l[RAW[key]] : (fn ? '' : l[key]),
        expected: Number(expected), actual: Number(actual), ok: Number(expected) === Number(actual), note: note || '' });
    }
    log(`  ${o.short_name}: ${result.checks.filter((c) => c.org === o.short_name && c.ok).length}/${CHECKS.length} counts match`);
  }

  // Auth: same users, identities and password hashes on both sides.
  const pd = PASSWORD_DIGEST(migrated);
  const lp = legacyChecks.password;
  const np = (await target.query(pd.sql, pd.params)).rows[0];
  result.checks.push({ org: 'all', name: 'auth users with identical password hashes (digest)', legacy: lp.n, expected: lp.n,
    actual: lp.digest === np.digest ? np.n : `${np.n} (digest differs)`, ok: lp.n === np.n && lp.digest === np.digest,
    note: 'sha256 over id:hash of every migrated user, computed in each database' });
  const ids = (await target.query(`select (select count(*) from auth.identities where user_id = any($1::uuid[]))::int as identities,
      (select count(*) from auth.sessions where user_id = any($1::uuid[]))::int as sessions,
      (select count(*) from auth.refresh_tokens r join auth.sessions s on s.id = r.session_id where s.user_id = any($1::uuid[]) and not coalesce(r.revoked, false))::int as tokens,
      (select count(*) from dek.profiles where id = any($1::uuid[]) and legacy_id is not null)::int as profiles`, [migrated])).rows[0];
  for (const [k, label, exp] of [['identities', 'auth identities', d.identities.length], ['sessions', 'live auth sessions', d.sessions.length],
    ['tokens', 'live refresh tokens', d.refreshTokens.length], ['profiles', 'profiles', migrated.length]]) {
    const moving = k === 'sessions' || k === 'tokens';
    result.checks.push({ org: 'all', name: label, legacy: exp, expected: exp, actual: ids[k], ok: exp === ids[k],
      info: moving, note: moving ? 'live data: people sign in, refresh and sign out in legacy until cutover; the final --apply takes the latest' : '' });
  }

  await samples(result, d, target, people, seed);
  await permissions(result, d, target, seed);
  const legacySha = new Map(d.attachmentRows.filter((a) => a.sha256).map((a) => [a.object_key, a.sha256]));
  result.files = await verifyObjects(target, targetStorage, legacySha);
  result.invariants = await invariants(target, ORG_IDS);
  result.ok = result.checks.every((c) => c.ok || c.info) && result.samples.every((s) => s.ok) && result.users.every((u) => u.ok)
    && result.files.mismatched.length === 0 && result.files.ok === result.files.objects
    && result.files.legacy_row_sha_mismatch.length === 0 && result.invariants.every((i) => i.ok);
  result.explained = explain(d);
  return result;
}

// Expected channel of a legacy message: its channel, or for a DM the oldest
// conversation of the same pair in the same org.
function dmChannelOf(d) {
  const members = new Map();
  for (const m of d.convMembers) {
    if (!members.has(m.conversation_id)) members.set(m.conversation_id, []);
    members.get(m.conversation_id).push(m.user_id);
  }
  const first = new Map();
  const out = new Map();
  const ordered = d.conversations.slice().sort((a, b) => (tsKey(a.created_at) < tsKey(b.created_at) ? -1 : 1));
  for (const cv of ordered) {
    const key = `${cv.org_id}:${(members.get(cv.id) || []).slice().sort().join(':')}`;
    if (!first.has(key)) first.set(key, cv.id);
    out.set(cv.id, first.get(key));
  }
  return out;
}

async function samples(result, d, target, people, seed) {
  const dmChannel = dmChannelOf(d);
  const all = [...d.messages.map((m) => ({ m, channel: m.channel_id })),
    ...d.dmMessages.map((m) => ({ m, channel: dmChannel.get(m.conversation_id) }))];
  const picks = sample(all, 30, rng(seed));
  const rows = new Map((await target.query(`select id, author_id, channel_id, created_at, body, meta from dek.messages
      where id = any($1::uuid[])`, [picks.map((p) => p.m.id)])).rows.map((r) => [r.id, r]));
  for (const { m, channel } of picks) {
    const n = rows.get(m.id);
    const legacyText = m.deleted_at ? '' : normalizeLegacy(cardInner(m.body, m.body_text) ?? m.body_text, m.mention_user_ids, people);
    const newText = n ? normalizeNew(n.body, n.meta) : null;
    const s = {
      id: m.id,
      author: !!n && n.author_id === m.author_id,
      channel: !!n && n.channel_id === channel,
      created: !!n && tsKey(n.created_at) === tsKey(m.created_at),
      text: !!n && sha256(newText) === sha256(legacyText),
    };
    s.ok = s.author && s.channel && s.created && s.text;
    result.samples.push(s);
  }
}

// Legacy visibility (private.can_view_channel): a workspace member sees its public
// channels and the private ones they were added to; a conversation member sees it.
function legacyReadable(d) {
  const dmChannel = dmChannelOf(d);
  const chByWs = new Map();
  for (const c of d.channels) {
    if (!chByWs.has(c.workspace_id)) chByWs.set(c.workspace_id, []);
    chByWs.get(c.workspace_id).push(c);
  }
  const privateMember = new Set(d.channelMembers.map((m) => `${m.channel_id}:${m.user_id}`));
  const out = new Map();
  const add = (uid, ch) => { if (!out.has(uid)) out.set(uid, new Set()); out.get(uid).add(ch); };
  for (const wm of d.wsMembers) {
    for (const c of chByWs.get(wm.workspace_id) || []) {
      if (!c.is_private || privateMember.has(`${c.id}:${wm.user_id}`)) add(wm.user_id, c.id);
    }
  }
  for (const cm of d.convMembers) add(cm.user_id, dmChannel.get(cm.conversation_id));
  return out;
}

async function permissions(result, d, target, seed) {
  const legacy = legacyReadable(d);
  const everyone = d.users.map((u) => u.auth.id).sort();
  // Everyone, in one statement: dek.can_read_channel for every person and channel.
  const rows = (await target.query(`select u.id::text as uid, c.id::text as cid
      from unnest($2::uuid[]) as u(id) cross join dek.channels c
     where c.org_id = any($1::uuid[]) and dek.can_read_channel(u.id, c.id)`, [ORG_IDS, everyone])).rows;
  const now = new Map();
  for (const r of rows) { if (!now.has(r.uid)) now.set(r.uid, new Set()); now.get(r.uid).add(r.cid); }
  // The one intended difference: legacy let a person read a DM of an org they had
  // left; the new access rule requires an active membership of the DM's org.
  const dmOrg = new Map(d.conversations.map((c) => [c.id, c.org_id]));
  const inOrg = new Set(d.orgMembers.map((m) => `${m.org_id}:${m.user_id}`));
  const leftOrgDm = (uid, ch) => dmOrg.has(ch) && !inOrg.has(`${dmOrg.get(ch)}:${uid}`);
  const explainedPairs = [];
  const compare = (uid) => {
    const a = legacy.get(uid) || new Set();
    const b = now.get(uid) || new Set();
    const missingAll = [...a].filter((x) => !b.has(x));
    const missing = missingAll.filter((ch) => !leftOrgDm(uid, ch)).length;
    for (const ch of missingAll.filter((x) => leftOrgDm(uid, x))) explainedPairs.push(`${uid} / DM ${ch}`);
    const extra = [...b].filter((x) => !a.has(x)).length;
    return { id: uid, legacy: a.size, actual: b.size, missing, extra, ok: missing === 0 && extra === 0 };
  };
  const all = everyone.map(compare);
  result.allUsers = { members: all.length, ok: all.filter((x) => x.ok).length,
    pairs: all.reduce((n, x) => n + x.legacy, 0), with_nothing: all.filter((x) => x.legacy === 0).length,
    explained: explainedPairs };
  // The sample shown in the report: people who can read something in legacy.
  const readers = everyone.filter((uid) => (legacy.get(uid)?.size || 0) > 0);
  for (const uid of sample(readers, 15, rng(seed + 1))) result.users.push(compare(uid));
  if (result.allUsers.ok !== result.allUsers.members) {
    result.users.push({ id: 'everyone', legacy: result.allUsers.pairs, actual: '', missing: '', extra: '', ok: false });
  }
}

function explain(d) {
  const out = [];
  out.push('channel memberships exceed the raw legacy channel_members rows by design: legacy showed every public channel to every workspace member (computed), the new model stores that as rows.');
  out.push(`legacy threads without any reply (${d.threads.length} threads in total) are ordinary messages in the new model; "thread roots" counts roots that have replies.`);
  out.push('reactions on deleted legacy messages are dropped with the message body (the new tombstone keeps none).');
  out.push('auth sessions and refresh tokens change in legacy whenever someone refreshes; their counts are compared against the snapshot this verify run read.');
  out.push('the two merged DMs are left out of the DM unread check: one cursor cannot hold two legacy cursors, so the merged history counts as read up to the first message unread in either conversation (never hides an unread message).');
  return out;
}
