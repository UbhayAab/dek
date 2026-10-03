// How each planned table is written. Order = upsert order (parent before child).
//   key      conflict target
//   owned    dek_migration.owned kind; keyExpr renders the same key from a target row
//   update   columns updated on conflict (default: every non-key column given)
//   compare  columns compared for "is distinct from" (default: update)
const cat = (...cols) => cols.map((c) => `t.${c}::text`).join(` || ':' || `);

const rootsFirst = (rows) => rows.slice().sort((a, b) => (a.thread_root_id ? 1 : 0) - (b.thread_root_id ? 1 : 0));

export const SPECS = [
  { name: 'auth_users', table: 'auth.users', key: ['id'], owned: 'auth_user', keyExpr: cat('id') },
  { name: 'identities', table: 'auth.identities', key: ['id'], owned: 'identity', keyExpr: cat('id') },
  { name: 'sessions', table: 'auth.sessions', key: ['id'], owned: 'session', keyExpr: cat('id') },
  // Insert only: a token the new project has already rotated (revoked) must never be
  // made usable again by a later run. Tokens legacy rotated leave through the registry.
  { name: 'refresh_tokens', table: 'auth.refresh_tokens', key: ['token'], exclude: ['id'], owned: 'refresh_token',
    keyExpr: "encode(sha256(convert_to(t.token, 'UTF8')), 'hex')", update: [] },
  { name: 'amr_claims', table: 'auth.mfa_amr_claims', key: ['session_id', 'authentication_method'],
    owned: 'amr_claim', keyExpr: cat('session_id', 'authentication_method') },
  // Profiles are created by the auth trigger and then filled; never deleted.
  { name: 'profiles', table: 'dek.profiles', key: ['id'], owned: 'profile' },
  { name: 'notification_prefs', table: 'dek.notification_prefs', key: ['user_id'],
    update: ['quiet_start', 'quiet_end', 'quiet_tz', 'updated_at'], compare: ['quiet_start', 'quiet_end', 'quiet_tz'],
    selectExpr: { updated_at: 'coalesce(x."updated_at", now())' } },
  { name: 'platform_admins', table: 'dek.platform_admins', key: ['user_id'], owned: 'platform_admin',
    keyExpr: cat('user_id') },
  // Branding (slug, short name, color) is set once; the lead may change it later.
  { name: 'orgs', table: 'dek.orgs', key: ['id'], update: ['name', 'created_at', 'legacy_id'] },
  { name: 'org_members', table: 'dek.org_members', key: ['org_id', 'user_id'], owned: 'org_member',
    keyExpr: cat('org_id', 'user_id') },
  { name: 'servers', table: 'dek.servers', key: ['id'], owned: 'server', keyExpr: cat('id') },
  { name: 'server_members', table: 'dek.server_members', key: ['server_id', 'user_id'], owned: 'server_member',
    keyExpr: cat('server_id', 'user_id') },
  { name: 'channels', table: 'dek.channels', key: ['id'], owned: 'channel', keyExpr: cat('id') },
  { name: 'channel_state', table: 'dek.channel_state', key: ['channel_id'] },
  { name: 'channel_members', table: 'dek.channel_members', key: ['channel_id', 'user_id'], owned: 'channel_member',
    keyExpr: cat('channel_id', 'user_id') },
  { name: 'messages', table: 'dek.messages', key: ['id'], owned: 'message', keyExpr: cat('id'), sort: rootsFirst },
  { name: 'attachments', table: 'dek.attachments', key: ['id'], owned: 'attachment', keyExpr: cat('id') },
  { name: 'reactions', table: 'dek.reactions', key: ['message_id', 'emoji', 'user_id'], owned: 'reaction',
    keyExpr: cat('message_id', 'emoji', 'user_id') },
  { name: 'mentions', table: 'dek.mentions', key: ['message_id', 'user_id'], owned: 'mention',
    keyExpr: cat('message_id', 'user_id') },
  { name: 'thread_follows', table: 'dek.thread_follows', key: ['root_id', 'user_id'], owned: 'thread_follow',
    keyExpr: cat('root_id', 'user_id') },
  { name: 'saved_messages', table: 'dek.saved_messages', key: ['user_id', 'message_id'], owned: 'saved',
    keyExpr: cat('user_id', 'message_id') },
  { name: 'invites', table: 'dek.invites', key: ['id'], owned: 'invite', keyExpr: cat('id') },
  { name: 'join_requests', table: 'dek.join_requests', key: ['id'], owned: 'join_request', keyExpr: cat('id') },
  // enabled is written false on insert and never touched again: turning devices on
  // is --enable-push, at cutover, by the lead.
  { name: 'push_devices', table: 'dek.push_devices', key: ['kind', 'endpoint'], owned: 'push_device',
    keyExpr: "encode(sha256(convert_to(t.endpoint, 'UTF8')), 'hex')",
    update: ['user_id', 'p256dh', 'auth', 'label', 'platform', 'created_at', 'last_seen_at', 'last_success_at',
      'failure_count'] },
  { name: 'audit_notes', table: 'dek.audit_log', owned: 'audit_note', keyExpr: "(t.details->>'migration_key')",
    custom: auditNotes },
];

export const DELETE_ORDER = ['mention', 'reaction', 'saved', 'thread_follow', 'attachment', 'message',
  'channel_member', 'channel', 'server_member', 'server', 'org_member', 'platform_admin', 'invite',
  'join_request', 'push_device', 'audit_note', 'amr_claim', 'refresh_token', 'session', 'identity', 'auth_user'];

// Legacy facts with no table of their own (the workspace ban) are audit notes.
async function auditNotes(db, rows) {
  const out = { rows: rows.length, inserted: 0, updated: 0 };
  for (const r of rows) {
    const details = JSON.stringify({ ...r.details, migration_key: r.key });
    const upd = await db.query(`update dek.audit_log set org_id = $2, actor_id = $3, action = $4, target_type = $5,
        target_id = $6, details = $7::jsonb, created_at = $8
      where details->>'migration_key' = $1
        and (org_id, actor_id, action, target_type, target_id, details, created_at)
            is distinct from ($2::uuid, $3::uuid, $4, $5, $6::uuid, $7::jsonb, $8::timestamptz)`,
    [r.key, r.org_id, r.actor_id, r.action, r.target_type, r.target_id, details, r.created_at]);
    if (upd.rowCount) { out.updated += 1; continue; }
    const ins = await db.query(`insert into dek.audit_log (org_id, actor_id, action, target_type, target_id, details, created_at)
      select $2, $3, $4, $5, $6, $7::jsonb, $8
       where not exists (select 1 from dek.audit_log where details->>'migration_key' = $1)`,
    [r.key, r.org_id, r.actor_id, r.action, r.target_type, r.target_id, details, r.created_at]);
    out.inserted += ins.rowCount;
  }
  return out;
}
