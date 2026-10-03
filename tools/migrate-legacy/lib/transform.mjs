// Legacy extract -> the complete desired state of the migrated data. Pure: the
// same extract always yields the same plan, which is what makes --apply re-runnable.
import { transformIdentity } from './transform-identity.mjs';
import { transformSpaces } from './transform-spaces.mjs';
import { transformMessages } from './transform-messages.mjs';
import { transformState } from './transform-state.mjs';

export const TABLES = ['auth_users', 'identities', 'sessions', 'refresh_tokens', 'amr_claims', 'profiles',
  'notification_prefs', 'platform_admins', 'orgs', 'org_members', 'servers', 'server_members', 'channels',
  'channel_state', 'channel_members', 'messages', 'attachments', 'reactions', 'mentions', 'thread_follows',
  'saved_messages', 'invites', 'join_requests', 'push_devices', 'audit_notes'];

export const OWNED_KINDS = ['auth_user', 'identity', 'session', 'refresh_token', 'amr_claim', 'profile',
  'platform_admin', 'org_member', 'server', 'server_member', 'channel', 'channel_member', 'message',
  'attachment', 'reaction', 'mention', 'thread_follow', 'saved', 'invite', 'join_request', 'push_device',
  'audit_note'];

export function transform(d) {
  const plan = {
    rows: Object.fromEntries(TABLES.map((t) => [t, []])),
    owned: Object.fromEntries(OWNED_KINDS.map((k) => [k, []])),
    objects: [], idMap: [], decisions: [], warnings: [], stats: {},
  };
  const migratedMessageIds = new Set();
  const ctx = {
    d, plan,
    migrated: new Set(d.users.map((u) => u.auth.id)),
    people: new Map(d.users.map((u) => [u.auth.id, {
      username: u.profile?.username || null, display_name: u.profile?.display_name || null }])),
    objects: new Map(d.objects.map((o) => [o.name, o])),
    attachmentByKey: new Map(d.attachmentRows.map((a) => [a.object_key, a])),
    usedLegacyAttachment: new Set(),
    orgOfWs: new Map(), wsMembers: new Map(), channelInfo: new Map(), convChannel: new Map(),
    readers: new Map(), memberRow: new Map(), seqOf: new Map(), order: new Map(),
    messageIdKnown: (id) => migratedMessageIds.has(id),
    skipped: { dm_messages_without_channel: 0, thread_without_root: 0 },
    counts: { cards: 0, quotes: 0, truncated: 0, mention_ids: 0, mention_tokens_converted: 0,
      mentions_dropped_not_reader: 0, reactions_on_deleted: 0, attachments_without_key: 0 },
  };
  transformIdentity(ctx);
  transformSpaces(ctx);
  for (const m of d.messages) if (ctx.channelInfo.has(m.channel_id)) migratedMessageIds.add(m.id);
  for (const m of d.dmMessages) if (ctx.convChannel.has(m.conversation_id)) migratedMessageIds.add(m.id);
  transformMessages(ctx);
  transformState(ctx);
  idMap(ctx);
  plan.stats.messages = { ...ctx.counts, ...ctx.skipped,
    channel_messages: d.messages.length, dm_messages: d.dmMessages.length,
    deleted: plan.rows.messages.filter((m) => m.deleted_at).length,
    thread_roots: new Set(plan.rows.messages.filter((m) => m.thread_root_id).map((m) => m.thread_root_id)).size,
    thread_replies: plan.rows.messages.filter((m) => m.thread_root_id).length,
    also_in_channel: plan.rows.messages.filter((m) => m.also_in_channel).length };
  plan.ctx = ctx;
  return plan;
}

// The stable old-to-new id map (DEK29). Most ids are kept as they were; the map
// records them anyway so one table answers every old link, plus the legacy seq of
// every message (old #/m/<channel>/<seq> links).
function idMap(ctx) {
  const { d, plan } = ctx;
  const same = (kind, id, extra = null) => plan.idMap.push({ kind, legacy_key: id, new_id: id, note: null, extra });
  for (const o of plan.rows.orgs) same('organization', o.id);
  for (const s of plan.rows.servers) same('workspace', s.id);
  for (const c of plan.rows.channels) same(c.server_id ? 'channel' : 'conversation', c.id);
  for (const u of plan.rows.auth_users) same('user', u.id);
  for (const i of plan.rows.invites) same(i.server_id ? 'invite' : 'org_invite', i.id);
  const src = new Map([...d.messages.map((m) => [m.id, 'message']), ...d.dmMessages.map((m) => [m.id, 'dm_message'])]);
  for (const m of plan.rows.messages) {
    same(src.get(m.id), m.id, { channel_id: m.channel_id, legacy_seq: m.meta.legacy.seq, seq: m.seq });
  }
  for (const a of plan.rows.attachments) if (a.legacy_id) same('attachment', a.legacy_id);
}
