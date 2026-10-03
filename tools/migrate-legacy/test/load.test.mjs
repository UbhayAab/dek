// The write path without a database: generated SQL, key formats, the archive guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertSql } from '../lib/load.mjs';
import { SPECS, DELETE_ORDER } from '../lib/tables.mjs';
import { assertOutsideRepos } from '../lib/archive.mjs';
import { OWNED_KINDS } from '../lib/transform.mjs';
import { ROOT } from '../../lib/env.mjs';

const spec = (name) => SPECS.find((s) => s.name === name);
const squash = (s) => s.replace(/\s+/g, ' ');

test('an upsert only updates a row when a value differs', () => {
  const sql = squash(upsertSql(spec('server_members'), ['server_id', 'user_id', 'org_id', 'role', 'joined_at']));
  assert.match(sql, /on conflict \("server_id", "user_id"\) do update set "org_id" = excluded."org_id"/);
  assert.match(sql, /where \(t."org_id", t."role", t."joined_at"\) is distinct from \(excluded."org_id", excluded."role", excluded."joined_at"\)/);
  assert.match(sql, /returning \(xmax = 0\) as inserted/);
});

test('copied refresh tokens are insert only (a rotated token is never revived)', () => {
  const sql = squash(upsertSql(spec('refresh_tokens'), ['token', 'user_id', 'revoked', 'session_id']));
  assert.match(sql, /on conflict \("token"\) do nothing/);
});

test('push devices never get enabled by an update', () => {
  const s = spec('push_devices');
  assert.ok(!s.update.includes('enabled'));
  const sql = squash(upsertSql(s, ['user_id', 'kind', 'endpoint', 'label', 'enabled']));
  assert.ok(!/"enabled" = excluded/.test(sql));
});

test('notification preferences compare quiet hours only and keep a timestamp', () => {
  const sql = squash(upsertSql(spec('notification_prefs'), ['user_id', 'quiet_start', 'quiet_end', 'quiet_tz', 'updated_at']));
  assert.match(sql, /coalesce\(x."updated_at", now\(\)\)/);
  assert.match(sql, /where \(t."quiet_start", t."quiet_end", t."quiet_tz"\) is distinct from/);
});

test('every deletable kind has a spec with a key expression, and every owned kind is known', () => {
  for (const kind of DELETE_ORDER) {
    const s = SPECS.find((x) => x.owned === kind);
    assert.ok(s, `no spec for ${kind}`);
    assert.ok(s.keyExpr, `no key expression for ${kind}`);
    assert.ok(OWNED_KINDS.includes(kind), `${kind} is not an owned kind`);
  }
  // Profiles are anonymised, never deleted.
  assert.ok(!DELETE_ORDER.includes('profile'));
  // Children before parents.
  assert.ok(DELETE_ORDER.indexOf('message') < DELETE_ORDER.indexOf('channel'));
  assert.ok(DELETE_ORDER.indexOf('channel') < DELETE_ORDER.indexOf('server'));
  assert.ok(DELETE_ORDER.indexOf('refresh_token') < DELETE_ORDER.indexOf('session'));
  assert.ok(DELETE_ORDER.indexOf('session') < DELETE_ORDER.indexOf('auth_user'));
});

test('the personal-data archive refuses a folder inside a git work tree', () => {
  assert.throws(() => assertOutsideRepos(join(ROOT, 'tmp-archive')), /inside the git work tree/);
  assert.doesNotThrow(() => assertOutsideRepos(join(tmpdir(), 'dek-archive-test')));
});
