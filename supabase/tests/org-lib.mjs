// Shared helpers for the [org] tests (not a test file itself). Owner: org.

// Every api function the [org] builder owns (CONTRACT 2.3, 2.4, 2.5).
export const ORG_FUNCTIONS = [
  'create_org', 'update_org', 'list_org_members', 'set_org_role', 'suspend_org_member', 'remove_org_member',
  'leave_org', 'list_servers', 'create_server', 'update_server', 'archive_server', 'join_server', 'leave_server',
  'list_server_members', 'add_server_members', 'remove_server_member', 'set_server_role', 'list_channels',
  'create_channel', 'update_channel', 'archive_channel', 'join_channel', 'leave_channel', 'add_channel_members',
  'remove_channel_member', 'list_channel_members', 'set_channel_notify', 'open_dm', 'hide_dm',
  'create_invite', 'preview_invite', 'accept_invite', 'list_invites', 'revoke_invite', 'list_join_requests',
  'decide_join_request', 'report', 'list_reports', 'resolve_report', 'block_user', 'list_blocks', 'list_audit',
];

// Realtime rows written by THIS transaction: realtime.messages.inserted_at defaults to
// now(), the transaction start, so rows from other sessions never match.
export async function events(db, { event = null, topic = null } = {}) {
  return db.q(
    `select id, topic, event, payload from realtime.messages
      where inserted_at = now()::timestamp and ($1::text is null or event = $1) and ($2::text is null or topic = $2)`,
    [event, topic]);
}

// The event ids seen so far, so a later since() returns only what came after.
export async function mark(db) {
  return new Set((await events(db)).map((r) => r.id));
}

export async function since(db, before, filter = {}) {
  return (await events(db, filter)).filter((r) => !before.has(r.id));
}

export async function platformAdmin(db, uid) {
  await db.q('insert into dek.platform_admins (user_id) values ($1) on conflict do nothing', [uid]);
}

export async function setSettings(db, org, settings) {
  await db.q("update dek.orgs set settings = coalesce(settings, '{}'::jsonb) || $2::jsonb where id = $1",
    [org, JSON.stringify(settings)]);
}

export async function canRead(db, uid, channel) {
  return (await db.one('select dek.can_read_channel($1, $2) as ok', [uid, channel])).ok;
}

export async function orgMember(db, org, uid) {
  return db.one('select role, status, suspended_reason from dek.org_members where org_id = $1 and user_id = $2',
    [org, uid]);
}

export async function serverRole(db, server, uid) {
  return (await db.one('select role from dek.server_members where server_id = $1 and user_id = $2',
    [server, uid]))?.role ?? null;
}

export async function channelRow(db, channel, uid) {
  return db.one('select * from dek.channel_members where channel_id = $1 and user_id = $2', [channel, uid]);
}

export async function auditRows(db, org, action) {
  return db.q('select actor_id, target_type, target_id, details from dek.audit_log where org_id = $1 and action = $2',
    [org, action]);
}

export const ids = (list) => list.map((x) => x.id).sort();
export const sorted = (list) => [...list].sort();
