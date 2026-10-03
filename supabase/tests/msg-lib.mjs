// Shared helpers for the [msg] tests (not a test file itself).
import { randomUUID } from 'node:crypto';

// api.send_message with a fresh client_id unless one is given.
export function send(db, uid, channel, body = 'hello', extra = {}) {
  return db.call(uid, 'send_message', { p_channel: channel, p_client_id: randomUUID(), p_body: body, ...extra });
}

// Realtime rows written by THIS transaction: realtime.messages.inserted_at defaults
// to now(), which is the transaction start time, so no other session's rows match.
// Emission order: every dek.emit_many call runs in its own subtransaction, whose
// xid is assigned when it writes, so xmin orders the broadcasts as they were sent.
export async function events(db, event = null) {
  const rows = await db.q(
    `select topic, event, payload from realtime.messages
      where inserted_at = now()::timestamp and ($1::text is null or event = $1)
      order by (xmin::text)::bigint, topic`, [event]);
  return rows;
}

// An attachment row as begin_upload and media-finalize would leave it.
export async function attachment(db, { org, channel, uploader, name = 'report.pdf', status = 'ready',
                                       mime = 'application/pdf', createdAt = null }) {
  const id = randomUUID();
  await db.q(
    `insert into dek.attachments (id, org_id, channel_id, uploader_id, object_path, file_name, declared_mime,
                                  mime_type, size_bytes, status, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7, 1234, $8, coalesce($9::timestamptz, now()))`,
    [id, org, channel, uploader, `${org}/${channel}/${id}/${name}`, name, mime, status, createdAt]);
  return id;
}

// Fill a rate bucket up to its limit for the current window (now() is fixed for the
// whole test transaction, so the next call in this test is the one over the limit).
export async function fillRate(db, uid, key, limit, windowSeconds) {
  await db.q(
    `insert into dek.rate_buckets (user_id, key, window_start, hits)
     values ($1, $2, to_timestamp(floor(extract(epoch from now()) / $3) * $3), $4)
     on conflict (user_id, key, window_start) do update set hits = excluded.hits`,
    [uid, key, windowSeconds, limit]);
}

// Anonymous callers never reach the function body: anon has no EXECUTE grant on
// api functions (dek_meta.lockdown), so PostgreSQL refuses before auth_required.
export async function expectAnonDenied(promise) {
  try {
    await promise;
  } catch (e) {
    if (e.code === 'auth_required' || e.sqlstate === '42501') return e;
    throw new Error(`expected an anonymous denial, got "${e.code}"`);
  }
  throw new Error('expected an anonymous denial, but the call succeeded');
}

export async function messageRow(db, id) {
  return db.one('select * from dek.messages where id = $1', [id]);
}

export const ids = (list) => list.map((m) => m.id);
export const seqs = (list) => list.map((m) => Number(m.seq));
