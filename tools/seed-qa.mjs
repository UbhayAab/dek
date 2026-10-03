#!/usr/bin/env node
// Synthetic QA world for browser tests, agent checks and load tests. Idempotent.
// Two tenants so isolation can be proven: "Dek QA" and "QA Other". Every account is
// @dek-test.invalid (no mail can ever reach anyone), password from .env.local
// DEK_QA_PASSWORD (generated on first run). Never touches the migrated real orgs.
//
//   node tools/seed-qa.mjs            create or refresh the world, print the logins
//   node tools/seed-qa.mjs --wipe     delete the QA orgs and QA users
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { ROOT, env, need, pgConfig } from './lib/env.mjs';

const WIPE = process.argv.includes('--wipe');
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = need('SUPABASE_URL', 'SUPABASE_SECRET_KEY');
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let password = env().DEK_QA_PASSWORD;
if (!password) {
  password = `Qa-${randomBytes(12).toString('base64url')}`;
  const file = join(ROOT, '.env.local');
  writeFileSync(file, `${readFileSync(file, 'utf8').replace(/\n?$/, '\n')}DEK_QA_PASSWORD=${password}\n`);
}

const PEOPLE = [
  { key: 'owner', name: 'Asha Owner', org: 'qa', role: 'owner' },
  { key: 'admin', name: 'Ravi Admin', org: 'qa', role: 'admin' },
  { key: 'alice', name: 'Alice Member', org: 'qa', role: 'member' },
  { key: 'bob', name: 'Bob Member', org: 'qa', role: 'member' },
  { key: 'carol', name: 'Carol Crossteam', org: 'qa', role: 'member' },
  { key: 'guest', name: 'Gita Guest', org: 'qa', role: 'guest' },
  { key: 'eve', name: 'Eve Othertenant', org: 'other', role: 'owner' },
];
const email = (k) => `qa-${k}@dek-test.invalid`;

async function users() {
  const out = {};
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  for (const p of PEOPLE) {
    const found = data.users.find((u) => u.email === email(p.key));
    if (found) {
      await admin.auth.admin.updateUserById(found.id, { password });
      out[p.key] = found.id;
    } else {
      const { data: c, error: e } = await admin.auth.admin.createUser({
        email: email(p.key), password, email_confirm: true, user_metadata: { display_name: p.name },
      });
      if (e) throw e;
      out[p.key] = c.user.id;
    }
  }
  return out;
}

async function wipe(db) {
  await db.query("delete from dek.orgs where slug in ('dek-qa', 'qa-other')");
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const u of data.users.filter((x) => x.email?.startsWith('qa-') && x.email.endsWith('@dek-test.invalid'))) {
    await admin.auth.admin.deleteUser(u.id);
    await db.query('delete from dek.notification_prefs where user_id = $1', [u.id]);
    await db.query('delete from dek.profiles where id = $1', [u.id]);
  }
  console.log('QA world wiped');
}

async function seed(db, ids) {
  const org = async (slug, name, color) => {
    const found = await db.query('select id from dek.orgs where lower(slug) = $1', [slug]);
    if (found.rows[0]) return found.rows[0].id;
    return (await db.query('insert into dek.orgs (slug, name, short_name, brand_color) values ($1, $2, $2, $3) returning id',
      [slug, name, color])).rows[0].id;
  };
  const qa = await org('dek-qa', 'Dek QA', '#0F766E');
  const other = await org('qa-other', 'QA Other', '#7C3AED');
  for (const p of PEOPLE) {
    await db.query(
      `insert into dek.org_members (org_id, user_id, role) values ($1, $2, $3)
       on conflict (org_id, user_id) do update set role = excluded.role, status = 'active'`,
      [p.org === 'qa' ? qa : other, ids[p.key], p.role]);
  }
  const server = async (o, name, members) => {
    const found = await db.query('select id from dek.servers where org_id = $1 and lower(name) = lower($2) and archived_at is null', [o, name]);
    const s = found.rows[0]?.id ?? (await db.query("insert into dek.servers (org_id, name, join_policy) values ($1, $2, 'invite') returning id", [o, name])).rows[0].id;
    for (const [k, role] of members) {
      await db.query(
        `insert into dek.server_members (server_id, user_id, org_id, role) values ($1, $2, $3, $4)
         on conflict (server_id, user_id) do update set role = excluded.role`, [s, ids[k], o, role]);
    }
    return s;
  };
  const channel = async (s, o, name, opts = {}) => {
    const found = await db.query('select id from dek.channels where server_id = $1 and lower(name) = lower($2) and archived_at is null', [s, name]);
    const c = found.rows[0]?.id ?? (await db.query(
      `insert into dek.channels (org_id, server_id, kind, name, visibility, posting_policy, auto_join, topic)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [o, s, opts.kind ?? 'text', name, opts.visibility ?? 'public', opts.posting ?? 'everyone', opts.autoJoin ?? false, opts.topic ?? null])).rows[0].id;
    for (const [k, role] of opts.members ?? []) {
      await db.query(
        `insert into dek.channel_members (channel_id, user_id, org_id, role) values ($1, $2, $3, $4)
         on conflict (channel_id, user_id) do nothing`, [c, ids[k], o, role]);
    }
    return c;
  };
  const med = await server(qa, 'Medical Partnerships', [['owner', 'admin'], ['admin', 'member'], ['alice', 'member'], ['bob', 'moderator']]);
  const tech = await server(qa, 'Tech', [['owner', 'admin'], ['carol', 'member']]);
  const all = [['owner', 'member'], ['admin', 'member'], ['alice', 'member'], ['bob', 'member']];
  const general = await channel(med, qa, 'general', { autoJoin: true, topic: 'Everything for the medical partnerships team', members: all });
  const announcements = await channel(med, qa, 'announcements', { posting: 'admins', autoJoin: true, members: all });
  const grants = await channel(med, qa, 'grants', { visibility: 'private', topic: 'Grant applications, cross-team', members: [['alice', 'owner'], ['carol', 'member'], ['guest', 'member']] });
  await channel(med, qa, 'leadership', { visibility: 'private', members: [['owner', 'owner'], ['admin', 'member']] });
  await channel(med, qa, 'huddle', { kind: 'audio', members: all });
  await channel(tech, qa, 'general', { autoJoin: true, members: [['owner', 'member'], ['carol', 'member']] });
  const os = await server(other, 'Other Team', [['eve', 'admin']]);
  await channel(os, other, 'general', { autoJoin: true, members: [['eve', 'member']] });

  const dmKey = `${qa}:${[ids.alice, ids.bob].sort().join(':')}`;
  const foundDm = await db.query('select id from dek.channels where dm_key = $1', [dmKey]);
  const dm = foundDm.rows[0]?.id ?? (await db.query(
    "insert into dek.channels (org_id, kind, visibility, dm_key) values ($1, 'dm', 'private', $2) returning id", [qa, dmKey])).rows[0].id;
  for (const k of ['alice', 'bob']) {
    await db.query('insert into dek.channel_members (channel_id, user_id, org_id) values ($1, $2, $3) on conflict do nothing', [dm, ids[k], qa]);
  }

  // History only on the first run.
  const have = (await db.query('select count(*)::int n from dek.messages where channel_id = $1', [general])).rows[0].n;
  if (!have) {
    const post = async (c, k, body, root = null, mentions = []) => (await db.query(
      `insert into dek.messages (org_id, channel_id, seq, author_id, body, thread_root_id, in_timeline, mentions)
       select ch.org_id, ch.id, dek.allocate_seq(ch.id, $4::uuid is null), $2, $3, $4, $4::uuid is null, $5::uuid[]
         from dek.channels ch where ch.id = $1 returning id, seq`, [c, ids[k], body, root, mentions])).rows[0];
    const first = await post(general, 'owner', 'Welcome to **Dek QA**. This is the general channel for the medical partnerships team.');
    await post(general, 'alice', 'Morning everyone. Here is the list for today:\n- call the hospital desk\n- send the consent forms\n- update the grants tracker');
    await post(general, 'bob', `<@${ids.alice}> I can take the consent forms.`, null, [ids.alice]);
    await post(general, 'admin', 'Reminder: the review is at *4 pm* today.');
    await post(general, 'alice', 'Hindi works too: नमस्ते, आज की मीटिंग चार बजे है।');
    for (let i = 0; i < 120; i += 1) {
      await post(general, ['alice', 'bob', 'admin', 'owner'][i % 4], `History line ${i + 1} for scrolling and pagination tests.`);
    }
    await post(general, 'bob', 'Thread reply: I will join the review.', first.id);
    await post(general, 'alice', 'Thread reply: great, see you there.', first.id);
    await db.query(
      'update dek.messages set reply_count = 2, last_reply_at = now(), reply_user_ids = array[$2::uuid, $3::uuid] where id = $1',
      [first.id, ids.alice, ids.bob]);
    await db.query(
      "insert into dek.reactions (message_id, emoji, user_id, channel_id, org_id) values ($1, '👍', $2, $3, $4), ($1, '👍', $5, $3, $4) on conflict do nothing",
      [first.id, ids.alice, general, qa, ids.bob]);
    await db.query(
      "update dek.messages set reactions = jsonb_build_object('👍', jsonb_build_array($2::text, $3::text)) where id = $1",
      [first.id, ids.alice, ids.bob]);
    await post(announcements, 'owner', 'Office closed on Friday for the festival.');
    await post(grants, 'alice', `<@${ids.carol}> can you review the budget section of the grant draft?`, null, [ids.carol]);
    await post(dm, 'alice', 'Hey Bob, quick question about the Friday plan.');
  }
  return { qa, other };
}

const db = new pg.Client(pgConfig());
await db.connect();
try {
  if (WIPE) {
    await wipe(db);
  } else {
    const ids = await users();
    const orgs = await seed(db, ids);
    console.log(`QA world ready. Orgs: Dek QA ${orgs.qa}, QA Other ${orgs.other}`);
    console.log('Logins (password is DEK_QA_PASSWORD in .env.local):');
    for (const p of PEOPLE) console.log(`  ${p.key.padEnd(6)} ${email(p.key)}  ${p.role} in ${p.org === 'qa' ? 'Dek QA' : 'QA Other'}`);
  }
} finally {
  await db.end();
}
