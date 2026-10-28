// Helpers for the plat test files (not a test file itself). Owner: plat.
//
// The harness's db.call() runs as authenticated or anon; the svc_* functions are
// granted to service_role only, so svc() calls them as service_role inside the same
// rolled-back transaction (which also proves the grant).
import { randomUUID, randomBytes } from 'node:crypto';
import { DekError } from './_harness.mjs';

export async function svc(db, fn, args = {}) {
  if (!/^svc_[a-z0-9_]+$/.test(fn)) throw new Error(`bad service function ${fn}`);
  const keys = Object.keys(args);
  for (const k of keys) if (!/^p_[a-z0-9_]+$/.test(k)) throw new Error(`bad argument name ${k}`);
  const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const values = keys.map((k) => {
    const v = args[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  const sp = `plat_svc_${++db.n}`;
  await db.c.query(`savepoint ${sp}`);
  try {
    await db.c.query('set local role service_role');
    const res = await db.c.query(`select api.${fn}(${named}) as result`, values);
    await db.c.query('reset role');
    await db.c.query(`release savepoint ${sp}`);
    return res.rows[0]?.result;
  } catch (e) {
    await db.c.query(`rollback to savepoint ${sp}`);
    await db.c.query('reset role');
    throw new DekError(e.message, e.hint, e.code);
  }
}

// A real-looking subscription: base64url P-256 point (65 bytes) and auth secret (16).
export function webpushKeys() {
  const point = Buffer.concat([Buffer.from([4]), randomBytes(64)]);
  return { p256dh: point.toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

export async function device(db, user, { kind = 'webpush', enabled = true, revoked = false, endpoint = null } = {}) {
  const keys = webpushKeys();
  const ep = endpoint ?? (kind === 'webpush'
    ? `https://fcm.googleapis.com/fcm/send/t-${randomUUID()}`
    : kind === 'apns' ? randomBytes(32).toString('hex') : `t-${randomUUID()}:${randomBytes(24).toString('base64url')}`);
  const row = await db.one(
    `insert into dek.push_devices (user_id, kind, endpoint, p256dh, auth, enabled, revoked_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, case when $7 then now() end, now()) returning id`,
    [user, kind, ep, kind === 'webpush' ? keys.p256dh : null, kind === 'webpush' ? keys.auth : null, enabled, revoked]);
  return row.id;
}

export async function message(db, channel, author, body = 'hello',
                              { root = null, mentions = [], all = false, alsoInChannel = false, attachments = 0 } = {}) {
  const inTimeline = root === null || alsoInChannel;
  return db.one(
    `insert into dek.messages (org_id, channel_id, seq, author_id, body, thread_root_id, in_timeline,
                               also_in_channel, mentions, mention_all, attachment_count)
     select c.org_id, c.id, dek.allocate_seq(c.id, $5), $2, $3, $4, $5, $6, $7::uuid[], $8, $9
       from dek.channels c where c.id = $1
     returning id, seq, org_id, channel_id`,
    [channel, author, body, root, inTimeline, alsoInChannel, mentions, all, attachments]);
}

export async function intent(db, kind, { org = null, msg = null, channel = null, call = null, actor = null,
                                         user = null, device: dev = null } = {}) {
  const row = await db.one('select dek.enqueue_intent($1, $2, $3, $4, $5, $6, $7, $8) as id',
    [kind, org, msg, channel, call, actor, user, dev]);
  return Number(row.id);
}

// Message intent the way send_message writes it.
export async function msgIntent(db, m, author) {
  return intent(db, 'message', { org: m.org_id, msg: m.id, channel: m.channel_id, actor: author });
}

export const claim = (db, id, dry = false) => svc(db, 'svc_claim_intent', { p_intent: id, p_dry_run: dry });
export const record = (db, id, results) => svc(db, 'svc_record_deliveries', { p_intent: id, p_results: results });

export const users = (claimed) => [...new Set(claimed.deliveries.map((d) => d.user_id))].sort();
export const sorted = (...ids) => [...ids].sort();

export async function prefs(db, user, patch) {
  const sets = Object.keys(patch).map((k, i) => `${k} = $${i + 2}`).join(', ');
  await db.q(`update dek.notification_prefs set ${sets} where user_id = $1`, [user, ...Object.values(patch)]);
}

export async function notify(db, channel, user, level, mutedUntil = null) {
  await db.q('update dek.channel_members set notify = $3, muted_until = $4 where channel_id = $1 and user_id = $2',
    [channel, user, level, mutedUntil]);
}

export async function intentRow(db, id) {
  return db.one('select status, attempts, locked_until, last_error from dek.notification_intents where id = $1', [id]);
}

// Puts an intent back to "pending, unlocked" the way svc_record_deliveries does for a
// retry, so the next claim runs the routing again.
export async function release(db, id) {
  await db.q("update dek.notification_intents set status = 'pending', locked_until = null where id = $1", [id]);
}
