// File bytes: legacy private bucket `attachments` -> new private bucket `media`
// (and avatars -> public bucket `avatars`). Every copy is read back from the new
// project and must match the legacy bytes in size and sha256; the digest is kept in
// dek_migration.objects so --verify can check every object again later.
import { sha256, safeError } from './util.mjs';

// Messages name an object by its owning id, never by its file name (personal data).
const label = (bucket, path) => `${bucket}:${bucket === 'attachments' ? path : path.split('/').slice(-2, -1)[0]}`;

async function download(storage, bucket, path) {
  const { data, error } = await storage.from(bucket).download(path);
  if (error) throw new Error(`download ${label(bucket, path)} failed: ${error.message || error.name || 'error'}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function copyObjects(db, legacyStorage, targetStorage, objects, log = () => {}) {
  const stats = { planned: objects.length, copied: 0, skipped_verified: 0, bytes_copied: 0, bytes_total: 0,
    obsolete: [] };
  const recorded = new Map((await db.query('select bucket, path, legacy_key, sha256, size_bytes from dek_migration.objects'))
    .rows.map((r) => [`${r.bucket}/${r.path}`, r]));
  const present = new Map((await db.query(`select bucket_id, name, (metadata->>'size')::bigint as size
      from storage.objects where bucket_id = any($1::text[])`, [[...new Set(objects.map((o) => o.bucket))]]))
    .rows.map((r) => [`${r.bucket_id}/${r.name}`, Number(r.size)]));

  for (const o of objects) {
    stats.bytes_total += o.size;
    const k = `${o.bucket}/${o.path}`;
    const rec = recorded.get(k);
    if (rec && rec.legacy_key === o.legacyKey && Number(rec.size_bytes) === o.size && present.get(k) === o.size) {
      stats.skipped_verified += 1;
      continue;
    }
    const bytes = await download(legacyStorage, 'attachments', o.legacyKey);
    const digest = sha256(bytes);
    if (bytes.length !== o.size) throw new Error(`legacy object ${o.legacyKey} is ${bytes.length} bytes, metadata says ${o.size}`);
    // Legacy recorded a sha256 at upload: bytes that no longer match it are not the
    // file people sent, and copying them silently would hide that.
    if (o.legacySha && o.legacySha !== digest) {
      throw new Error(`legacy object ${o.legacyKey} does not match the sha256 legacy recorded for it`);
    }
    const { error } = await targetStorage.from(o.bucket).upload(o.path, bytes,
      { contentType: o.contentType, upsert: true, cacheControl: o.bucket === 'avatars' ? '86400' : '3600' });
    if (error) throw new Error(`upload ${label(o.bucket, o.path)} failed: ${error.message || 'error'}`);
    const back = await download(targetStorage, o.bucket, o.path);
    if (back.length !== bytes.length || sha256(back) !== digest) {
      throw new Error(`copy of ${o.legacyKey} to ${label(o.bucket, o.path)} does not match after upload`);
    }
    try {
      await db.query(`insert into dek_migration.objects (bucket, path, legacy_key, sha256, size_bytes, kind, copied_at, verified_at)
          values ($1, $2, $3, $4, $5, $6, now(), now())
          on conflict (bucket, path) do update set legacy_key = excluded.legacy_key, sha256 = excluded.sha256,
            size_bytes = excluded.size_bytes, kind = excluded.kind, copied_at = now(), verified_at = now()`,
      [o.bucket, o.path, o.legacyKey, digest, bytes.length, o.kind]);
    } catch (e) {
      throw new Error(`recording ${label(o.bucket, o.path)} failed: ${safeError(e)}`);
    }
    stats.copied += 1;
    stats.bytes_copied += bytes.length;
    // The owning id only: file names can carry personal data.
    log(`  copied ${o.kind} of ${o.path.split('/').slice(-2, -1)[0]} (${bytes.length} bytes, sha256 ok)`);
  }

  // Objects copied by an earlier run that the plan no longer wants (message deleted
  // in legacy since). Removed by removeObsoleteObjects only after the database
  // transaction committed, so a rolled-back load never leaves a row without its file.
  const wanted = new Set(objects.map((o) => `${o.bucket}/${o.path}`));
  for (const [k, r] of recorded) {
    if (!wanted.has(k)) stats.obsolete.push({ bucket: r.bucket, path: r.path, kind: r.kind });
  }
  return stats;
}

export async function removeObsoleteObjects(db, targetStorage, obsolete, log = () => {}) {
  for (const { bucket, path, kind } of obsolete) {
    const { error } = await targetStorage.from(bucket).remove([path]);
    if (error) throw new Error(`removing obsolete ${label(bucket, path)} failed: ${error.message || 'error'}`);
    await db.query('delete from dek_migration.objects where bucket = $1 and path = $2', [bucket, path]);
    log(`  removed obsolete ${kind} of ${path.split('/').slice(-2, -1)[0]}`);
  }
  return obsolete.length;
}

// --verify: every recorded object downloaded again from the new project; size and
// sha256 must equal the digest taken from the legacy bytes at copy time.
export async function verifyObjects(db, targetStorage, legacyShaByKey) {
  const rows = (await db.query('select bucket, path, legacy_key, sha256, size_bytes, kind from dek_migration.objects order by bucket, path')).rows;
  const out = { objects: rows.length, bytes: 0, ok: 0, mismatched: [], legacy_row_sha_checked: 0, legacy_row_sha_mismatch: [] };
  for (const r of rows) {
    const bytes = await download(targetStorage, r.bucket, r.path);
    out.bytes += bytes.length;
    const digest = sha256(bytes);
    if (bytes.length !== Number(r.size_bytes) || digest !== r.sha256) {
      out.mismatched.push(`${r.kind} of ${r.path.split('/').slice(-2, -1)[0]}`);
      continue;
    }
    const legacySha = legacyShaByKey.get(r.legacy_key);
    if (legacySha) {
      out.legacy_row_sha_checked += 1;
      if (legacySha !== digest) out.legacy_row_sha_mismatch.push(r.legacy_key);
    }
    out.ok += 1;
    await db.query('update dek_migration.objects set verified_at = now() where bucket = $1 and path = $2', [r.bucket, r.path]);
  }
  return out;
}
