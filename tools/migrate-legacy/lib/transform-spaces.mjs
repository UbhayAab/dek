// Workspaces to servers, channels and conversations to channels, and every
// membership. Legacy showed every public channel to every workspace member, so each
// server member becomes a member of each public channel of that server.
import { LIMITS, PERM_ADMINISTRATOR, PERM_MANAGE_MESSAGES } from './config.mjs';
import { tsKey, clip, clipOrNull, maxTs, groupBy } from './util.mjs';

const byCreated = (a, b) => (tsKey(a.created_at) < tsKey(b.created_at) ? -1
  : tsKey(a.created_at) > tsKey(b.created_at) ? 1 : (a.id < b.id ? -1 : 1));

// Unique, case-insensitive names within a scope (names of archived rows never clash).
function dedupe(rows, scopeOf, nameOf, setName, isArchived, ctx, area) {
  const seen = new Map();
  for (const r of rows) {
    if (isArchived(r)) continue;
    const scope = scopeOf(r);
    if (!seen.has(scope)) seen.set(scope, new Set());
    const names = seen.get(scope);
    const base = nameOf(r);
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `${base.slice(0, LIMITS.name - 4)}-${n}`;
    if (name !== base) ctx.plan.decisions.push({ area, text: `${r.id}: duplicate name renamed with suffix -${name.split('-').pop()}.` });
    names.add(name.toLowerCase());
    setName(r, name);
  }
}

export function transformSpaces(ctx) {
  servers(ctx);
  serverChannels(ctx);
  dmChannels(ctx);
}

function servers(ctx) {
  const { d, plan } = ctx;
  const roleBits = new Map();   // ws:user -> bigint of every role they hold
  for (const r of d.memberRoles) {
    const k = `${r.workspace_id}:${r.user_id}`;
    roleBits.set(k, (roleBits.get(k) || 0n) | BigInt(r.permissions));
  }
  const rows = [];
  for (const [orgId, list] of groupBy(d.workspaces, 'org_id')) {
    list.slice().sort(byCreated).forEach((w, position) => {
      const archivedAt = w.archived_at || w.scheduled_delete_at || null;
      rows.push({
        id: w.id, org_id: orgId, name: clip(String(w.name || 'Team').trim() || 'Team', LIMITS.name),
        description: clipOrNull(w.rules_text, LIMITS.description), icon_emoji: null, position,
        join_policy: w.requires_approval ? 'approval' : (w.join_policy === 'open' ? 'open' : 'invite'),
        created_by: ctx.migrated.has(w.created_by) ? w.created_by : null,
        created_at: w.created_at, archived_at: archivedAt, archived_by: null, legacy_id: w.id,
      });
      ctx.orgOfWs.set(w.id, orgId);
    });
  }
  dedupe(rows, (r) => r.org_id, (r) => r.name, (r, n) => { r.name = n; }, (r) => r.archived_at, ctx, 'servers');
  for (const r of rows) { plan.rows.servers.push(r); plan.owned.server.push(r.id); }

  const creator = new Map(d.workspaces.map((w) => [w.id, w.created_by]));
  const roles = { admin: 0, moderator: 0, member: 0, by_rule: { creator: 0, administrator_role: 0,
    member_type_moderator: 0, manage_messages_role: 0 } };
  for (const m of d.wsMembers) {
    if (!ctx.migrated.has(m.user_id) || !ctx.orgOfWs.has(m.workspace_id)) continue;
    const bits = roleBits.get(`${m.workspace_id}:${m.user_id}`) || 0n;
    let role = 'member';
    if (creator.get(m.workspace_id) === m.user_id) { role = 'admin'; roles.by_rule.creator += 1; }
    else if (bits & PERM_ADMINISTRATOR) { role = 'admin'; roles.by_rule.administrator_role += 1; }
    else if (m.member_type === 'moderator') { role = 'moderator'; roles.by_rule.member_type_moderator += 1; }
    else if (bits & PERM_MANAGE_MESSAGES) { role = 'moderator'; roles.by_rule.manage_messages_role += 1; }
    roles[role] += 1;
    plan.rows.server_members.push({ server_id: m.workspace_id, user_id: m.user_id,
      org_id: ctx.orgOfWs.get(m.workspace_id), role, joined_at: m.joined_at });
    plan.owned.server_member.push(`${m.workspace_id}:${m.user_id}`);
    if (!ctx.wsMembers.has(m.workspace_id)) ctx.wsMembers.set(m.workspace_id, []);
    ctx.wsMembers.get(m.workspace_id).push(m);
  }
  plan.stats.server_roles = roles;
}

function serverChannels(ctx) {
  const { d, plan } = ctx;
  const legacyMembers = groupBy(d.channelMembers, 'channel_id');
  const wsById = new Map(d.workspaces.map((w) => [w.id, w]));
  const rows = [];
  for (const [wsId, list] of groupBy(d.channels, 'workspace_id')) {
    const ws = wsById.get(wsId);
    const ordered = list.slice().sort((a, b) => (Number(a.position) - Number(b.position)) || byCreated(a, b));
    // The legacy client opened default_channel_id, else #general, else the first
    // non-voice channel (dek-legacy/js/core/workspace.js); that one gets auto_join.
    const live = ordered.filter((c) => !c.archived_at);
    const landing = live.find((c) => c.id === ws?.default_channel_id)
      || ordered.find((c) => c.name === 'general' && c.kind !== 'voice')
      || live.find((c) => c.kind !== 'voice');
    ordered.forEach((c, position) => {
      const members = (legacyMembers.get(c.id) || []).filter((m) => ctx.migrated.has(m.user_id));
      const soleOwner = c.is_private && members.length === 1 ? members[0].user_id : null;
      const row = {
        id: c.id, org_id: ctx.orgOfWs.get(wsId), server_id: wsId,
        kind: c.kind === 'voice' ? 'audio' : 'text',
        name: clip(String(c.name || 'channel').trim() || 'channel', LIMITS.name),
        topic: clipOrNull(c.topic, LIMITS.topic), description: null,
        visibility: c.is_private ? 'private' : 'public',
        posting_policy: c.kind === 'announcement' || c.readonly ? 'admins' : 'everyone',
        allow_replies: true, allow_reactions: true, auto_join: landing?.id === c.id,
        position, category: clipOrNull(c.category, LIMITS.category), dm_key: null,
        created_by: soleOwner, created_at: c.created_at, archived_at: c.archived_at || null,
        archived_by: null, legacy_id: c.id,
      };
      rows.push(row);
      ctx.channelInfo.set(c.id, { id: c.id, org: row.org_id, server: wsId, kind: row.kind, legacyKind: c.kind,
        visibility: row.visibility, created_at: c.created_at });
      const set = new Set();
      if (row.visibility === 'public') {
        for (const m of ctx.wsMembers.get(wsId) || []) {
          addMember(ctx, row, m.user_id, 'member', maxTs(m.joined_at, c.created_at));
          set.add(m.user_id);
        }
      } else {
        for (const m of members) {
          addMember(ctx, row, m.user_id, m.user_id === soleOwner ? 'owner' : 'member', c.created_at);
          set.add(m.user_id);
        }
      }
      ctx.readers.set(c.id, set);
    });
  }
  dedupe(rows, (r) => r.server_id, (r) => r.name, (r, n) => { r.name = n; }, (r) => r.archived_at, ctx, 'channels');
  for (const r of rows) { plan.rows.channels.push(r); plan.owned.channel.push(r.id); }
  const kinds = groupBy(d.channels, 'kind');
  plan.stats.channel_kinds = Object.fromEntries([...kinds].map(([k, v]) => [k, v.length]));
}

function addMember(ctx, channel, userId, role, joinedAt) {
  const row = { channel_id: channel.id, user_id: userId, org_id: channel.org_id, role,
    joined_at: joinedAt, last_read_seq: 0, last_read_at: null, notify: 'default', muted_until: null, hidden: false };
  ctx.plan.rows.channel_members.push(row);
  ctx.plan.owned.channel_member.push(`${channel.id}:${userId}`);
  ctx.memberRow.set(`${channel.id}:${userId}`, row);
}

// Conversations were per workspace; the new model has one DM per pair per org.
// Pairs with two conversations in one org merge into the older one.
function dmChannels(ctx) {
  const { d, plan } = ctx;
  const members = groupBy(d.convMembers, 'conversation_id');
  const groups = new Map();
  let skippedEmpty = 0;
  for (const cv of d.conversations.slice().sort(byCreated)) {
    const ids = [...new Set((members.get(cv.id) || []).map((m) => m.user_id))].filter((u) => ctx.migrated.has(u));
    if (!ids.length) { skippedEmpty += 1; continue; }
    const key = `${cv.org_id}:${ids.slice().sort().join(':')}`;
    if (!groups.has(key)) groups.set(key, { key, org: cv.org_id, ids, convs: [] });
    groups.get(key).convs.push(cv);
  }
  let merged = 0;
  for (const g of groups.values()) {
    const keep = g.convs[0];
    const kind = g.ids.length > 2 ? 'group_dm' : 'dm';
    const row = { id: keep.id, org_id: g.org, server_id: null, kind, name: null, topic: null, description: null,
      visibility: 'private', posting_policy: 'everyone', allow_replies: true, allow_reactions: true,
      auto_join: false, position: 0, category: null, dm_key: g.key, created_by: null,
      created_at: keep.created_at, archived_at: null, archived_by: null, legacy_id: keep.id };
    plan.rows.channels.push(row);
    plan.owned.channel.push(row.id);
    ctx.channelInfo.set(keep.id, { id: keep.id, org: g.org, server: null, kind, legacyKind: 'dm',
      visibility: 'private', created_at: keep.created_at, convs: g.convs.map((c) => c.id) });
    for (const cv of g.convs) ctx.convChannel.set(cv.id, keep.id);
    for (const cv of g.convs.slice(1)) {
      merged += 1;
      plan.idMap.push({ kind: 'conversation', legacy_key: cv.id, new_id: keep.id,
        note: 'merged into the older DM of the same pair', extra: null });
      plan.decisions.push({ area: 'dms', text: `conversation ${cv.id} merged into ${keep.id} (same pair, same org).` });
    }
    const set = new Set();
    for (const u of g.ids) {
      const firstIn = g.convs.find((cv) => (members.get(cv.id) || []).some((m) => m.user_id === u));
      addMember(ctx, row, u, 'member', firstIn?.created_at || keep.created_at);
      set.add(u);
    }
    ctx.readers.set(keep.id, set);
  }
  plan.stats.dms = { conversations: d.conversations.length, skipped_without_members: skippedEmpty,
    channels: groups.size, merged_conversations: merged };
}
