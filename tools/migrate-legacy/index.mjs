#!/usr/bin/env node
// Legacy Dek -> new Dek. Re-runnable and idempotent (DEK29, DEKA16).
//
//   node tools/migrate-legacy/index.mjs --plan           read legacy, write docs/migration/PLAN-RUN.md; no data writes
//   node tools/migrate-legacy/index.mjs --apply          copy files, then upsert everything in one transaction
//   node tools/migrate-legacy/index.mjs --apply --dry-run   the same transaction, rolled back: exact deltas, no writes
//   node tools/migrate-legacy/index.mjs --apply --sessions-only   after go-live: insert new legacy sessions, tokens, accounts
//       (a full --apply refuses once migrated people use the new app; --overwrite-new-app-changes forces it and
//        overwrites what they changed there: only for known test sessions before cutover)
//   node tools/migrate-legacy/index.mjs --verify         reconcile and write docs/migration/RECONCILIATION.md
//   node tools/migrate-legacy/index.mjs --prove-auth     throwaway-user proof that copied passwords and sessions work
//   node tools/migrate-legacy/index.mjs --enable-push --confirm-cutover   LEAD ONLY, at cutover
//
// The legacy project (ybddogqphinruyunnuwx) is production and is only ever read:
// one connection, one READ ONLY snapshot, one query at a time. Output is counts and
// ids; no email, body, file name, endpoint, token or key is ever printed. Every run
// is recorded in dek_migration.runs.
import { parseArgs } from 'node:util';
import { connectLegacy, connectTarget, legacyStorage, targetClients } from './lib/connect.mjs';
import { extract } from './lib/extract.mjs';
import { transform, OWNED_KINDS } from './lib/transform.mjs';
import { ensureSchema, startRun, finishRun, load, loadSessionsOnly, preflight } from './lib/load.mjs';
import { copyObjects, removeObsoleteObjects } from './lib/storage.mjs';
import { writeArchive } from './lib/archive.mjs';
import { writePlanDoc, writeReconciliationDoc, orgCounts } from './lib/report.mjs';
import { verify, readLegacyChecks } from './lib/verify.mjs';
import { proveAuth } from './lib/authproof.mjs';
import { RUN_LOCK } from './lib/config.mjs';
import { safeError } from './lib/util.mjs';

// Strict: an unknown or misspelt flag (--dryrun) stops the run instead of turning a
// dry run into a real one, and exactly one mode must be given.
const USAGE = 'usage: node tools/migrate-legacy/index.mjs --plan | --apply [--dry-run] [--sessions-only] | --verify | --prove-auth | --enable-push --confirm-cutover';
const FLAGS = ['plan', 'apply', 'verify', 'prove-auth', 'enable-push', 'dry-run', 'sessions-only',
  'overwrite-new-app-changes', 'confirm-cutover'];
let parsed;
try {
  parsed = parseArgs({ options: Object.fromEntries(FLAGS.map((f) => [f, { type: 'boolean' }])), strict: true }).values;
} catch (e) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(2);
}
const args = new Set(Object.keys(parsed).filter((k) => parsed[k]).map((k) => `--${k}`));
const MODES = ['--plan', '--apply', '--verify', '--prove-auth', '--enable-push'];
const chosen = MODES.filter((m) => args.has(m));
const mode = chosen.length === 1 ? chosen[0] : null;
const OPTION_OF = { '--dry-run': '--apply', '--sessions-only': '--apply', '--overwrite-new-app-changes': '--apply',
  '--confirm-cutover': '--enable-push' };
const stray = [...args].filter((a) => OPTION_OF[a] && OPTION_OF[a] !== mode);
const log = (s) => console.log(s);

async function readLegacy() {
  log('reading legacy (read only, one snapshot)');
  const db = await connectLegacy();
  try {
    return await extract(db, log);
  } finally {
    await db.close();
  }
}

async function withRun(name, fn) {
  const db = await connectTarget();
  let runId = null;
  try {
    await ensureSchema(db);
    await db.query('select pg_advisory_lock($1)', [RUN_LOCK]);
    runId = await startRun(db, name, null);
    const summary = await fn(db, runId);
    await finishRun(db, runId, summary?.ok !== false, summary, null);
    return summary;
  } catch (e) {
    const msg = e?.code ? safeError(e) : (e?.message || String(e));
    try { await db.query('rollback'); } catch { /* not in a transaction */ }
    if (runId) await finishRun(db, runId, false, {}, msg).catch(() => {});
    throw new Error(msg);
  } finally {
    await db.query('select pg_advisory_unlock_all()').catch(() => {});
    await db.end();
  }
}

async function plan() {
  const d = await readLegacy();
  const p = transform(d);
  await withRun('plan', async (db, runId) => {
    await db.query('update dek_migration.runs set legacy_snapshot_at = $2 where id = $1', [runId, d.snapshot.at]);
    // The delta a run would apply now: keys planned but not yet written, and keys
    // written earlier that legacy no longer has (DEK29 "capture deltas").
    const owned = new Map();
    for (const r of (await db.query('select kind, key from dek_migration.owned')).rows) {
      if (!owned.has(r.kind)) owned.set(r.kind, new Set());
      owned.get(r.kind).add(r.key);
    }
    const target = OWNED_KINDS.map((k) => {
      const have = owned.get(k) || new Set();
      const want = new Set(p.owned[k]);
      return { name: k, present: have.size, planned: want.size,
        add: [...want].filter((x) => !have.has(x)).length, remove: [...have].filter((x) => !want.has(x)).length };
    });
    writePlanDoc(p, d, target);
    return { rows: Object.fromEntries(Object.entries(p.rows).map(([k, v]) => [k, v.length])),
      objects: p.objects.length, warnings: p.warnings.length, per_org: summarizeOrgs(p) };
  });
  log(`wrote docs/migration/PLAN-RUN.md (${p.warnings.length} warnings)`);
}

const summarizeOrgs = (p) => orgCounts(p).map(({ org, ...c }) => ({ org: org.short_name, ...c }));

async function apply() {
  const dry = args.has('--dry-run');
  const sessionsOnly = args.has('--sessions-only');
  const d = await readLegacy();
  const p = transform(d);
  log(`plan: ${p.rows.auth_users.length} users, ${p.rows.messages.length} messages, ${p.objects.length} files`);
  const name = `apply${sessionsOnly ? '-sessions-only' : ''}${dry ? '-dry-run' : ''}`;
  const summary = await withRun(name, async (db, runId) => {
    await db.query('update dek_migration.runs set legacy_snapshot_at = $2 where id = $1', [runId, d.snapshot.at]);
    const out = { dry_run: dry, sessions_only: sessionsOnly };
    // Refuse before touching anything (files included) if a full run is unsafe.
    if (!sessionsOnly) await preflight(db, p, { overwriteLive: args.has('--overwrite-new-app-changes') });
    if (!dry && !sessionsOnly) {
      out.archive = writeArchive(d.archive, d.snapshot);
      log(`archive: ${Object.values(out.archive).reduce((a, b) => a + b, 0)} off-scope rows exported outside the repo`);
      log('copying files (each one read back and checked)');
      out.files = await copyObjects(db, legacyStorage(), targetClients().admin.storage, p.objects, log);
      log(`files: ${out.files.copied} copied, ${out.files.skipped_verified} already present, ${out.files.obsolete.length} obsolete`);
    }
    log(`loading (one transaction${sessionsOnly ? ', sessions and accounts only, insert only' : ''})`);
    await db.query('begin');
    try {
      out.load = sessionsOnly ? await loadSessionsOnly(db, p, log)
        : await load(db, p, log, { overwriteLive: args.has('--overwrite-new-app-changes') });
      await db.query(dry ? 'rollback' : 'commit');
    } catch (e) {
      await db.query('rollback');
      throw e;
    }
    // Only now, with the rows that pointed at them gone for good.
    if (out.files?.obsolete.length) {
      out.files.removed_obsolete = await removeObsoleteObjects(db, targetClients().admin.storage, out.files.obsolete, log);
    }
    const t = Object.values(out.load.tables);
    out.totals = { inserted: t.reduce((a, x) => a + x.inserted, 0), updated: t.reduce((a, x) => a + x.updated, 0),
      deleted: Object.values(out.load.deleted).reduce((a, b) => a + b, 0), seq_moves: out.load.seq_moves };
    out.per_org = summarizeOrgs(p);
    out.warnings = p.warnings;
    return out;
  });
  log(`${dry ? 'dry run (rolled back)' : 'applied'}: inserted ${summary.totals.inserted}, updated ${summary.totals.updated}, deleted ${summary.totals.deleted}, seq moves ${summary.totals.seq_moves}`);
}

async function verifyMode() {
  const seed = Number(process.env.DEK_VERIFY_SEED || Date.now() % 1000000);
  log('reading legacy (read only, one snapshot)');
  const legacy = await connectLegacy();
  let d;
  let legacyChecks;
  try {
    d = await extract(legacy, () => {});
    legacyChecks = await readLegacyChecks(legacy, d);
  } finally {
    await legacy.close();
  }
  const result = await withRun('verify', async (db, runId) => {
    await db.query('update dek_migration.runs set legacy_snapshot_at = $2 where id = $1', [runId, d.snapshot.at]);
    const r = await verify({ legacyChecks, target: db, d, targetStorage: targetClients().admin.storage, log, seed });
    writeReconciliationDoc(r);
    return { ok: r.ok, seed, failed_checks: r.checks.filter((c) => !c.ok).map((c) => `${c.org}: ${c.name}${c.info ? ' (live data)' : ''}`),
      samples_ok: r.samples.filter((s) => s.ok).length, users_ok: r.users.filter((u) => u.ok).length,
      files: { ok: r.files.ok, objects: r.files.objects, bytes: r.files.bytes },
      invariants_failed: r.invariants.filter((i) => !i.ok).map((i) => i.name) };
  });
  log(`wrote docs/migration/RECONCILIATION.md: ${result.ok ? 'RECONCILED' : 'NOT RECONCILED'}`);
  if (!result.ok) log(JSON.stringify(result, null, 1));
  if (!result.ok) process.exitCode = 1;
}

async function proveAuthMode() {
  const summary = await withRun('prove-auth', async (db) => proveAuth(db, targetClients(), log));
  log(`auth proof: ${summary.ok ? 'PASS' : 'FAIL'}`);
  if (!summary.ok) process.exitCode = 1;
}

// LEAD ONLY, at cutover, after the final --apply: lets the migrated browser
// subscriptions receive pushes from the new project.
async function enablePush() {
  if (!args.has('--confirm-cutover')) {
    throw new Error('--enable-push turns on push to real people. It is run by the lead at cutover with --confirm-cutover.');
  }
  const summary = await withRun('enable-push', async (db) => {
    const res = await db.query(`update dek.push_devices d set enabled = true
       where not d.enabled and d.revoked_at is null
         and encode(sha256(convert_to(d.endpoint, 'UTF8')), 'hex') in
             (select key from dek_migration.owned where kind = 'push_device')`);
    return { enabled: res.rowCount };
  });
  log(`enabled ${summary.enabled} migrated push devices`);
}

const RUN = { '--plan': plan, '--apply': apply, '--verify': verifyMode, '--prove-auth': proveAuthMode,
  '--enable-push': enablePush };
if (!mode || stray.length) {
  console.error(`${!mode ? 'give exactly one mode' : `${stray.join(', ')} does not apply to ${mode}`}\n${USAGE}`);
  process.exit(2);
}
RUN[mode]().catch((e) => {
  console.error(`failed: ${e.message}`);
  process.exit(1);
});
