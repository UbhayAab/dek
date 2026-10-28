// Writes the plan into the new project as postgres, in ONE transaction: obsolete
// migrated rows are removed (child to parent), then every table is upserted
// (parent to child) with "update only when something differs", so a second run
// with unchanged legacy data inserts, updates and deletes nothing.
//
// What the migration wrote is tracked in dek_migration.owned (kind, key): a row the
// app created itself is never touched, and a legacy row that disappeared (someone
// left a server, a subscription expired) is removed at the next run.
import { chunk, safeError, sha256 } from './util.mjs';
import { SPECS, DELETE_ORDER } from './tables.mjs';

const qi = (c) => `"${c}"`;

export async function ensureSchema(db) {
  await db.query(`
    create schema if not exists dek_migration;
    create table if not exists dek_migration.runs (
      id          bigint generated always as identity primary key,
      mode        text not null,
      started_at  timestamptz not null default now(),
      finished_at timestamptz,
      ok          boolean,
      legacy_snapshot_at timestamptz,
      summary     jsonb not null default '{}',
      error       text
    );
    create table if not exists dek_migration.owned (
      kind text not null,
      key  text not null,
      primary key (kind, key)
    );
    create table if not exists dek_migration.id_map (
      kind       text not null,
      legacy_key text not null,
      new_id     uuid,
      note       text,
      extra      jsonb,
      primary key (kind, legacy_key)
    );
    create table if not exists dek_migration.objects (
      bucket     text not null,
      path       text not null,
      legacy_key text not null,
      sha256     text not null,
      size_bytes bigint not null,
      kind       text not null,
      copied_at  timestamptz not null default now(),
      verified_at timestamptz,
      primary key (bucket, path)
    );
    revoke all on schema dek_migration from public, anon, authenticated, service_role;
    revoke all on all tables in schema dek_migration from public, anon, authenticated, service_role;
    revoke all on all sequences in schema dek_migration from public, anon, authenticated, service_role;`);
}

export async function startRun(db, mode, snapshotAt) {
  const { rows } = await db.query(
    'insert into dek_migration.runs (mode, legacy_snapshot_at) values ($1, $2) returning id', [mode, snapshotAt || null]);
  return rows[0].id;
}

export async function finishRun(db, id, ok, summary, error) {
  await db.query(
    'update dek_migration.runs set finished_at = now(), ok = $2, summary = $3, error = $4 where id = $1',
    [id, ok, JSON.stringify(summary || {}), error ? String(error).slice(0, 2000) : null]);
}

// Columns of a table that can be written (not generated, not identity).
async function writableColumns(db, schema, table) {
  const { rows } = await db.query(`select column_name from information_schema.columns
     where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' and is_identity = 'NO'
     order by ordinal_position`, [schema, table]);
  return rows.map((r) => r.column_name);
}

export function upsertSql(spec, cols) {
  const sel = cols.map((c) => spec.selectExpr?.[c] ?? `x.${qi(c)}`).join(', ');
  const update = (spec.update ?? cols.filter((c) => !spec.key.includes(c))).filter((c) => cols.includes(c));
  const compare = spec.compare ?? update;
  const action = !update.length ? 'do nothing'
    : `do update set ${update.map((c) => `${qi(c)} = ${spec.updateExpr?.[c] ?? `excluded.${qi(c)}`}`).join(', ')}
       where (${compare.map((c) => `t.${qi(c)}`).join(', ')}) is distinct from (${compare.map((c) => `excluded.${qi(c)}`).join(', ')})`;
  return `insert into ${spec.table} as t (${cols.map(qi).join(', ')})
          select ${sel} from jsonb_populate_recordset(null::${spec.table}, $1::jsonb) as x
          on conflict (${spec.key.map(qi).join(', ')}) ${action}
          returning (xmax = 0) as inserted`;
}

export async function upsertRows(db, spec, rows) {
  const out = { rows: rows.length, inserted: 0, updated: 0 };
  if (!rows.length) return out;
  const [schema, table] = spec.table.split('.');
  let cols = await writableColumns(db, schema, table);
  const present = new Set(Object.keys(rows[0]));
  cols = cols.filter((c) => present.has(c) && !(spec.exclude || []).includes(c));
  const sql = upsertSql(spec, cols);
  for (const part of chunk(spec.sort ? spec.sort(rows) : rows, spec.chunk || 400)) {
    try {
      const res = await db.query(sql, [JSON.stringify(part)]);
      for (const r of res.rows) { if (r.inserted) out.inserted += 1; else out.updated += 1; }
    } catch (e) {
      throw new Error(`upsert into ${spec.table} failed: ${safeError(e)}`);
    }
  }
  return out;
}

async function deleteObsolete(db, kind, spec, keys) {
  if (!spec.keyExpr) return 0;
  const sql = `with gone as (select o.key from dek_migration.owned o
                              where o.kind = $1 and not (o.key = any($2::text[])))
               delete from ${spec.table} t using gone where ${spec.keyExpr} = gone.key`;
  try {
    const res = await db.query(sql, [kind, keys]);
    return res.rowCount;
  } catch (e) {
    throw new Error(`removing obsolete ${kind} rows failed: ${safeError(e)}`);
  }
}

async function replaceOwned(db, kind, keys) {
  await db.query('delete from dek_migration.owned where kind = $1 and not (key = any($2::text[]))', [kind, keys]);
  for (const part of chunk(keys, 5000)) {
    await db.query(`insert into dek_migration.owned (kind, key) select $1, k from unnest($2::text[]) k
                    on conflict do nothing`, [kind, part]);
  }
}

// A full run makes the new project equal to legacy. Once the new app is in use that
// would overwrite people's new changes (a password, a cursor, a reaction) and app
// messages would collide with renumbered seqs, so it stops instead. The straggler
// pass after go-live is --sessions-only.
export async function preflight(db, plan, { overwriteLive = false } = {}) {
  const frozen = await db.query(`select value from dek.settings where key = 'migrations_frozen'`);
  if (frozen.rows[0]?.value === 'true') {
    throw new Error('dek.settings.migrations_frozen is true (post-cutover): the legacy copy must not overwrite live data');
  }
  const channelIds = plan.rows.channels.map((c) => c.id);
  const foreign = await db.query(`select channel_id, count(*)::int as n from dek.messages
     where channel_id = any($1::uuid[]) and legacy_id is null group by 1`, [channelIds]);
  if (foreign.rows.length) {
    throw new Error(`messages written by the app exist in ${foreign.rows.length} migrated channels `
      + `(${foreign.rows.map((r) => `${r.channel_id}: ${r.n}`).join(', ')}); clear them before re-running`);
  }
  const keys = plan.rows.channels.filter((c) => c.dm_key).map((c) => c.dm_key);
  const dm = await db.query(`select id from dek.channels where dm_key = any($1::text[]) and legacy_id is null`, [keys]);
  if (dm.rows.length) throw new Error(`${dm.rows.length} DMs created by the app collide with migrated DMs (dm_key)`);
  // Signs that migrated people already use the new app: sessions or refresh tokens
  // the new project issued to them (any sign-in or token exchange makes one), and
  // reactions or saves they made there.
  const live = (await db.query(`select
      (select count(*)::int from auth.sessions s where s.user_id = any($1::uuid[])
         and not exists (select 1 from dek_migration.owned o where o.kind = 'session' and o.key = s.id::text)) as sessions,
      (select count(*)::int from auth.refresh_tokens r where r.user_id = any($1::text[])
         and not exists (select 1 from dek_migration.owned o where o.kind = 'refresh_token'
                          and o.key = encode(sha256(convert_to(r.token, 'UTF8')), 'hex'))) as tokens,
      (select count(*)::int from dek.reactions x where x.org_id = any($2::uuid[])
         and not exists (select 1 from dek_migration.owned o where o.kind = 'reaction'
                          and o.key = x.message_id::text || ':' || x.emoji || ':' || x.user_id::text)) as reactions,
      (select count(*)::int from dek.saved_messages s where s.org_id = any($2::uuid[])
         and not exists (select 1 from dek_migration.owned o where o.kind = 'saved'
                          and o.key = s.user_id::text || ':' || s.message_id::text)) as saved`,
  [plan.rows.auth_users.map((u) => u.id), plan.rows.orgs.map((o) => o.id)])).rows[0];
  if ((live.sessions || live.tokens || live.reactions || live.saved) && !overwriteLive) {
    throw new Error(`the new app is in use by migrated people (${live.sessions} sessions and ${live.tokens} refresh tokens `
      + `issued by the new project, ${live.reactions} reactions and ${live.saved} saves made there): a full --apply would `
      + 'overwrite their changes. After go-live the straggler pass is --apply --sessions-only.');
  }
  const triggers = await db.query(`select event_object_schema || '.' || event_object_table || ':' || trigger_name as t
     from information_schema.triggers where event_object_schema in ('dek', 'auth')`);
  const known = new Set(['auth.users:dek_on_auth_user_created', 'dek.channels:dek_channel_state_row',
    'dek.notification_intents:dek_intent_dispatch']);
  return triggers.rows.map((r) => r.t).filter((t) => !known.has(t));
}

export async function load(db, plan, log = () => {}, options = {}) {
  const report = { tables: {}, deleted: {}, unknownTriggers: [] };
  report.unknownTriggers = await preflight(db, plan, options);
  if (report.unknownTriggers.length) {
    log(`  note: triggers added by other builders will fire: ${report.unknownTriggers.join(', ')}`);
  }
  const intentsSql = 'select count(*)::int as n from dek.notification_intents where org_id = any($1::uuid[])';
  const orgIds = plan.rows.orgs.map((o) => o.id);
  const intentsBefore = (await db.query(intentsSql, [orgIds])).rows[0].n;

  for (const kind of DELETE_ORDER) {
    const spec = SPECS.find((s) => s.owned === kind);
    const n = await deleteObsolete(db, kind, spec, plan.owned[kind]);
    if (n) report.deleted[kind] = n;
  }
  // Profiles of users who are gone are anonymised, never deleted (authorship stays).
  const gone = await db.query(`update dek.profiles p set deleted_at = now()
     where p.deleted_at is null and p.id::text in (select key from dek_migration.owned where kind = 'profile')
       and not (p.id::text = any($1::text[]))`, [plan.owned.profile]);
  if (gone.rowCount) report.deleted.profile_anonymised = gone.rowCount;

  // Seq two-phase: rows whose (channel, seq) changes park on unique negative values
  // first, so the upsert below never trips unique (channel_id, seq) mid-statement.
  const moves = plan.rows.messages.map((m, i) => ({ id: m.id, channel_id: m.channel_id, seq: m.seq, tmp: i + 1 }));
  const parked = await db.query(`update dek.messages m set seq = -x.tmp
      from jsonb_to_recordset($1::jsonb) as x(id uuid, channel_id uuid, seq bigint, tmp bigint)
     where m.id = x.id and (m.seq <> x.seq or m.channel_id <> x.channel_id)`, [JSON.stringify(moves)]);
  report.seq_moves = parked.rowCount;

  for (const spec of SPECS) {
    if (spec.custom) {
      report.tables[spec.name] = await spec.custom(db, plan.rows[spec.name]);
    } else {
      report.tables[spec.name] = await upsertRows(db, spec, plan.rows[spec.name]);
    }
    const t = report.tables[spec.name];
    log(`  ${spec.name.padEnd(20)} rows ${String(t.rows).padStart(5)}  inserted ${t.inserted}  updated ${t.updated}`);
  }
  for (const kind of Object.keys(plan.owned)) await replaceOwned(db, kind, plan.owned[kind]);
  await writeIdMap(db, plan.idMap);

  const intentsAfter = (await db.query(intentsSql, [orgIds])).rows[0].n;
  report.notification_intents_created = intentsAfter - intentsBefore;
  if (intentsAfter !== intentsBefore) {
    throw new Error(`${intentsAfter - intentsBefore} notification intents appeared during the load; rolled back so nothing is sent`);
  }
  return report;
}

// --apply --sessions-only: the straggler pass AFTER the new client is live. Legacy
// GoTrue keeps rotating refresh tokens (and can sign people in) after the legacy API
// is frozen, so this adds the sessions, refresh tokens and accounts that appeared in
// legacy since the final pass. Insert only: nothing the new app changed is updated,
// nothing is deleted, no message or membership is touched.
const AUTH_ONLY = ['auth_users', 'identities', 'sessions', 'refresh_tokens', 'amr_claims'];

export async function loadSessionsOnly(db, plan, log = () => {}) {
  const report = { tables: {}, deleted: {}, seq_moves: 0 };
  // Never bring back what the new app ended: an account deleted there, or a session
  // signed out there (both were copied before and are gone now).
  const goneOf = async (kind, table) => new Set((await db.query(`select o.key from dek_migration.owned o
      where o.kind = $1 and not exists (select 1 from ${table} t where t.id::text = o.key)`, [kind])).rows.map((r) => r.key));
  const goneUsers = await goneOf('auth_user', 'auth.users');
  const goneSessions = await goneOf('session', 'auth.sessions');
  // Someone who changed their password, or signed out a copied session, in the new
  // app gets no legacy session imported at all: those were made with the old
  // password or outlive the sign-out. They sign in again.
  const planHash = new Map(plan.rows.auth_users.map((u) => [u.id, u.encrypted_password || '']));
  const rotated = new Set((await db.query(`select id::text as id, coalesce(encrypted_password, '') as h
      from auth.users where id = any($1::uuid[])`, [[...planHash.keys()]])).rows
    .filter((r) => r.h !== planHash.get(r.id)).map((r) => r.id));
  const endedBy = new Set(plan.rows.sessions.filter((s) => goneSessions.has(s.id)).map((s) => s.user_id));
  const blocked = (uid) => goneUsers.has(uid) || rotated.has(uid) || endedBy.has(uid);
  const rows = {
    auth_users: plan.rows.auth_users.filter((u) => !goneUsers.has(u.id)),
    identities: plan.rows.identities.filter((i) => !goneUsers.has(i.user_id)),
    sessions: plan.rows.sessions.filter((s) => !blocked(s.user_id) && !goneSessions.has(s.id)),
  };
  const sessionIds = new Set(rows.sessions.map((s) => s.id));
  rows.refresh_tokens = plan.rows.refresh_tokens.filter((t) => sessionIds.has(t.session_id));
  rows.amr_claims = plan.rows.amr_claims.filter((a) => sessionIds.has(a.session_id));
  report.skipped = { users_deleted_in_new: goneUsers.size, sessions_ended_in_new: goneSessions.size,
    users_with_new_password: rotated.size, users_who_signed_out_in_new: endedBy.size };

  const ids = rows.auth_users.map((u) => u.id);
  const existing = new Set((await db.query('select id::text as id from auth.users where id = any($1::uuid[])', [ids]))
    .rows.map((r) => r.id));
  for (const name of AUTH_ONLY) {
    const spec = { ...SPECS.find((s) => s.name === name), update: [] };
    report.tables[name] = await upsertRows(db, spec, rows[name]);
    const t = report.tables[name];
    log(`  ${name.padEnd(20)} rows ${String(t.rows).padStart(5)}  inserted ${t.inserted}  (insert only)`);
  }
  // Accounts new since the final pass get their profile fields like everyone else.
  const fresh = new Set(ids.filter((id) => !existing.has(id)));
  if (fresh.size) {
    const spec = SPECS.find((s) => s.name === 'profiles');
    report.tables.profiles = await upsertRows(db, spec, plan.rows.profiles.filter((p) => fresh.has(p.id)));
    log(`  profiles             filled for ${fresh.size} new accounts`);
  }
  const keys = {
    auth_user: rows.auth_users.map((u) => u.id),
    identity: rows.identities.map((i) => i.id),
    session: rows.sessions.map((s) => s.id),
    refresh_token: rows.refresh_tokens.map((t) => sha256(String(t.token))),
    amr_claim: rows.amr_claims.map((a) => `${a.session_id}:${a.authentication_method}`),
    profile: [...fresh],
  };
  for (const [kind, list] of Object.entries(keys)) {
    for (const part of chunk(list, 5000)) {
      await db.query(`insert into dek_migration.owned (kind, key) select $1, k from unnest($2::text[]) k
                      on conflict do nothing`, [kind, part]);
    }
  }
  return report;
}

async function writeIdMap(db, entries) {
  const keys = entries.map((e) => `${e.kind}\u0001${e.legacy_key}`);
  await db.query(`delete from dek_migration.id_map where not ((kind || chr(1) || legacy_key) = any($1::text[]))`, [keys]);
  for (const part of chunk(entries, 1000)) {
    await db.query(`insert into dek_migration.id_map (kind, legacy_key, new_id, note, extra)
        select x.kind, x.legacy_key, x.new_id, x.note, x.extra
          from jsonb_to_recordset($1::jsonb) as x(kind text, legacy_key text, new_id uuid, note text, extra jsonb)
        on conflict (kind, legacy_key) do update set new_id = excluded.new_id, note = excluded.note, extra = excluded.extra
        where (dek_migration.id_map.new_id, dek_migration.id_map.note, dek_migration.id_map.extra)
              is distinct from (excluded.new_id, excluded.note, excluded.extra)`, [JSON.stringify(part)]);
  }
}
