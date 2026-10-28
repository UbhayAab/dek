// Per-person state and membership lifecycle: read cursors, notify levels, thread
// follows, saved messages, invites, join requests, push devices, the ban note.
import { NO_EXPIRY } from './config.mjs';
import { tsKey, maxTs, sha256 } from './util.mjs';
import { deviceLabel } from './ua.mjs';

const NOTIFY = { inherit: 'default', all: 'all', mentions: 'mentions', nothing: 'none' };

// A legacy cursor per source (channel, or each merged conversation) becomes the
// largest new seq n such that every message with seq <= n was read in its source.
// For a single source this is "the highest new seq whose legacy seq <= cursor".
export function mapCursor(order, cursorOf) {
  let n = 0;
  for (const o of order) {
    if (o.legacySeq > (cursorOf(o.src) ?? 0)) break;
    n = o.seq;
  }
  return n;
}

export function transformState(ctx) {
  readCursors(ctx);
  threadFollows(ctx);
  saved(ctx);
  invites(ctx);
  joinRequests(ctx);
  devices(ctx);
  banNotes(ctx);
}

function readCursors(ctx) {
  const { d, plan } = ctx;
  let applied = 0;
  let invalid = 0;
  let notifySet = 0;
  for (const rs of d.readState) {
    if (rs.scope_type !== 'channel') continue;
    const row = ctx.memberRow.get(`${rs.scope_id}:${rs.user_id}`);
    if (!row) { invalid += 1; continue; }
    const order = ctx.order.get(rs.scope_id) || [];
    row.last_read_seq = mapCursor(order, () => Number(rs.last_read_seq));
    row.last_read_at = Number(rs.last_read_seq) > 0 ? rs.updated_at : null;
    row.notify = NOTIFY[rs.notify_level] || 'default';
    row.muted_until = rs.muted_until || null;
    if (row.notify !== 'default') notifySet += 1;
    applied += 1;
  }
  // DMs: conversation_members.last_read_seq per conversation.
  const cursors = new Map();
  for (const cm of d.convMembers) cursors.set(`${cm.conversation_id}:${cm.user_id}`, cm);
  let dm = 0;
  for (const ch of plan.rows.channels.filter((c) => c.kind === 'dm' || c.kind === 'group_dm')) {
    const info = ctx.channelInfo.get(ch.id);
    const order = ctx.order.get(ch.id) || [];
    for (const row of plan.rows.channel_members.filter((r) => r.channel_id === ch.id)) {
      const per = (conv) => {
        const cm = cursors.get(`${conv}:${row.user_id}`);
        return cm ? Number(cm.last_read_seq) : 0;
      };
      row.last_read_seq = mapCursor(order, per);
      row.last_read_at = (info.convs || []).map((c) => cursors.get(`${c}:${row.user_id}`)?.last_read_at)
        .reduce((a, b) => maxTs(a, b), null);
      dm += 1;
    }
  }
  plan.stats.read_state = { channel_cursors_applied: applied, channel_rows_invalid_or_not_member: invalid,
    notify_levels_set: notifySet, dm_cursors: dm };
}

function threadFollows(ctx) {
  const { d, plan } = ctx;
  const threads = new Map(d.threads.map((t) => [t.id, t]));
  const rows = new Map();
  const get = (t, userId) => {
    const root = ctx.messageRow.get(t.root_message_id);
    if (!root || root.thread_root_id) return null;
    if (!ctx.memberRow.has(`${t.channel_id}:${userId}`)) return null;
    const k = `${root.id}:${userId}`;
    if (!rows.has(k)) {
      rows.set(k, { root_id: root.id, user_id: userId, channel_id: t.channel_id, org_id: root.org_id,
        following: false, last_read_reply_seq: 0, updated_at: null });
    }
    return rows.get(k);
  };
  let skipped = 0;
  for (const f of d.threadFollowers) {
    const t = threads.get(f.thread_id);
    const row = t ? get(t, f.user_id) : null;
    if (!row) { skipped += 1; continue; }
    row.following = true;
    row.updated_at = maxTs(row.updated_at, f.created_at);
  }
  for (const rs of d.readState) {
    if (rs.scope_type !== 'thread') continue;
    const t = threads.get(rs.scope_id);
    const row = t ? get(t, rs.user_id) : null;
    if (!row) { skipped += 1; continue; }
    row.last_read_reply_seq = mapCursor(ctx.order.get(t.channel_id) || [], () => Number(rs.last_read_seq));
    row.updated_at = maxTs(row.updated_at, rs.updated_at);
  }
  for (const r of rows.values()) {
    r.updated_at = r.updated_at || ctx.messageRow.get(r.root_id).created_at;
    plan.rows.thread_follows.push(r);
    plan.owned.thread_follow.push(`${r.root_id}:${r.user_id}`);
  }
  plan.stats.thread_follows = { rows: rows.size, following: [...rows.values()].filter((r) => r.following).length,
    skipped_not_member_or_missing: skipped };
}

function saved(ctx) {
  const { d, plan } = ctx;
  let skipped = 0;
  const states = {};
  for (const s of d.saved) {
    const m = ctx.messageRow.get(s.message_id);
    if (!m || m.deleted_at || !ctx.migrated.has(s.user_id)) { skipped += 1; continue; }
    states[s.state] = (states[s.state] || 0) + 1;
    plan.rows.saved_messages.push({ user_id: s.user_id, message_id: m.id, org_id: m.org_id, created_at: s.created_at });
    plan.owned.saved.push(`${s.user_id}:${m.id}`);
  }
  plan.stats.saved = { migrated: plan.rows.saved_messages.length, skipped, legacy_states: states };
}

function invites(ctx) {
  const { d, plan } = ctx;
  const now = tsKey(d.snapshot.at);
  const usable = (r) => !r.revoked_at && (!r.expires_at || tsKey(r.expires_at) > now)
    && (r.max_uses == null || Number(r.uses) < Number(r.max_uses));
  const stats = { server: 0, org: 0, usable: 0, no_expiry: 0, admin_role_downgraded: 0, role_grant_dropped: 0 };
  const push = (r, serverId, kind) => {
    if (r.expires_at == null) stats.no_expiry += 1;
    if (usable(r)) stats.usable += 1;
    plan.rows.invites.push({
      id: r.id, org_id: r.org_id, server_id: serverId, channel_ids: [], role: 'member', code: null,
      code_sha256: `\\x${r.token_sha256}`, email: null, requires_approval: false,
      created_by: ctx.migrated.has(r.created_by) ? r.created_by : null, created_at: r.created_at,
      expires_at: r.expires_at || NO_EXPIRY,
      max_uses: r.max_uses != null && Number(r.max_uses) > 0 ? Number(r.max_uses) : null,
      use_count: Number(r.uses) || 0, revoked_at: r.revoked_at || null, revoked_by: null, legacy_id: r.id,
    });
    plan.owned.invite.push(r.id);
    stats[kind] += 1;
  };
  for (const r of d.invites) {
    if (r.grant_role_id) stats.role_grant_dropped += 1;
    push(r, r.workspace_id, 'server');
  }
  for (const r of d.orgInvites) {
    if (r.grant_role === 'admin') stats.admin_role_downgraded += 1;
    push(r, null, 'org');
  }
  const ids = plan.rows.invites.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error('invite id collision between workspace and org invites');
  plan.stats.invites = stats;
}

function joinRequests(ctx) {
  const { d, plan } = ctx;
  const map = { pending: 'pending', approved: 'approved', accepted: 'approved', rejected: 'rejected',
    denied: 'rejected', declined: 'rejected', withdrawn: 'withdrawn', cancelled: 'withdrawn', canceled: 'withdrawn' };
  for (const r of d.joinRequests) {
    if (!ctx.migrated.has(r.user_id)) continue;
    plan.rows.join_requests.push({ id: r.id, org_id: r.org_id, server_id: r.workspace_id, user_id: r.user_id,
      invite_id: null, note: null, status: map[r.status] || 'withdrawn',
      decided_by: ctx.migrated.has(r.decided_by) ? r.decided_by : null, decided_at: r.decided_at || null,
      created_at: r.created_at });
    plan.owned.join_request.push(r.id);
    const member = ctx.wsMembers.get(r.workspace_id)?.some((m) => m.user_id === r.user_id);
    if (r.status === 'pending' && member) {
      plan.warnings.push(`join request ${r.id} is pending although the user is already a member of server ${r.workspace_id}; migrated as pending for an admin to close`);
    }
  }
}

// One device per endpoint (the newest subscription wins). Disabled until the lead
// runs --enable-push at cutover: nothing may notify a real person before that.
function devices(ctx) {
  const { d, plan } = ctx;
  const byEndpoint = new Map();
  for (const s of d.pushSubs) {
    const prev = byEndpoint.get(s.endpoint);
    if (!prev || tsKey(s.created_at) > tsKey(prev.created_at)) byEndpoint.set(s.endpoint, s);
  }
  const labels = {};
  for (const s of byEndpoint.values()) {
    const { label, platform } = deviceLabel(s.ua, s.endpoint);
    labels[label] = (labels[label] || 0) + 1;
    plan.rows.push_devices.push({ user_id: s.user_id, kind: 'webpush', endpoint: s.endpoint,
      p256dh: s.p256dh, auth: s.auth, label, platform, created_at: s.created_at,
      last_seen_at: s.last_ok_at || null, last_success_at: s.last_ok_at || null,
      failure_count: Number(s.fail_count) || 0, enabled: false });
    plan.owned.push_device.push(sha256(s.endpoint));
  }
  plan.stats.push_devices = { legacy_subscriptions: d.pushSubs.length, devices: byEndpoint.size,
    users: new Set([...byEndpoint.values()].map((s) => s.user_id)).size, labels };
}

// The new model has no server bans; each legacy workspace ban becomes an audit note
// in its org, visible to org admins in list_audit.
function banNotes(ctx) {
  const { d, plan } = ctx;
  for (const b of d.bans) {
    plan.rows.audit_notes.push({
      key: `ban:${b.workspace_id}:${b.user_id}`, org_id: b.org_id,
      actor_id: ctx.migrated.has(b.banned_by) ? b.banned_by : null, action: 'legacy.server_ban',
      target_type: 'user', target_id: b.user_id, created_at: b.created_at,
      details: { server_id: b.workspace_id, banned_at: b.created_at, source: 'legacy Dek',
        note: 'Banned from this server in legacy Dek. The new model has no server bans, so this is a record only.' },
    });
    plan.owned.audit_note.push(`ban:${b.workspace_id}:${b.user_id}`);
  }
}
