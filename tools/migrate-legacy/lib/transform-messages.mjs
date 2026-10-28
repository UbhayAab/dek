// Channel messages and DM messages into dek.messages: per-channel seq renumbered
// from 1, threads as thread_root_id, bodies with <@uuid> mentions, quote lines for
// legacy reply_to_id, reactions, mentions, pins, and the attachment plan.
import { ID_NAMESPACE, LIMITS, MEDIA_BUCKET } from './config.mjs';
import { tsKey, maxTs, groupBy, uuidv5, clip, baseName, safeFileName, extOf, baseMime } from './util.mjs';
import { convertMentions, convertScope, cardText, quoteLine } from './text.mjs';

const cmp = (...pairs) => {
  for (const [a, b] of pairs) { if (a < b) return -1; if (a > b) return 1; }
  return 0;
};

export function transformMessages(ctx) {
  const { d, plan } = ctx;
  const sources = new Map();   // new channel id -> [{ m, src, conv }]
  for (const m of d.messages) {
    if (!ctx.channelInfo.has(m.channel_id)) continue;
    if (!sources.has(m.channel_id)) sources.set(m.channel_id, []);
    sources.get(m.channel_id).push({ m, src: 'messages', conv: m.channel_id });
  }
  for (const m of d.dmMessages) {
    const ch = ctx.convChannel.get(m.conversation_id);
    if (!ch) { ctx.skipped.dm_messages_without_channel += 1; continue; }
    if (!sources.has(ch)) sources.set(ch, []);
    sources.get(ch).push({ m, src: 'dm_messages', conv: m.conversation_id });
  }

  const threadRoot = new Map();
  const byId = new Map(d.messages.map((m) => [m.id, m]));
  for (const t of d.threads) {
    const root = byId.get(t.root_message_id);
    if (root && root.channel_id === t.channel_id) threadRoot.set(t.id, root.id);
  }
  const dmById = new Map(d.dmMessages.map((m) => [m.id, m]));
  const reactions = groupBy([...d.reactions, ...d.dmReactions], 'message_id');
  const pins = new Map(d.pins.map((p) => [p.message_id, p]));
  ctx.messageRow = new Map();

  for (const [channelId, list] of sources) {
    const info = ctx.channelInfo.get(channelId);
    const multi = new Set(list.map((x) => x.conv)).size > 1;
    const convIndex = new Map((info.convs || []).map((c, i) => [c, i]));
    list.sort((a, b) => (multi
      ? cmp([tsKey(a.m.created_at), tsKey(b.m.created_at)], [convIndex.get(a.conv), convIndex.get(b.conv)],
        [Number(a.m.seq), Number(b.m.seq)], [a.m.id, b.m.id])
      : cmp([Number(a.m.seq), Number(b.m.seq)], [tsKey(a.m.created_at), tsKey(b.m.created_at)], [a.m.id, b.m.id])));
    const order = [];
    list.forEach((x, i) => {
      const seq = i + 1;
      ctx.seqOf.set(x.m.id, seq);
      order.push({ src: x.conv, legacySeq: Number(x.m.seq), seq });
      const row = messageRow(ctx, info, x, seq, threadRoot, byId, dmById, reactions, pins);
      plan.rows.messages.push(row);
      plan.owned.message.push(row.id);
      ctx.messageRow.set(row.id, row);
    });
    ctx.order.set(channelId, order);
  }
  rootCounters(ctx);
  channelState(ctx);
}

function messageRow(ctx, info, x, seq, threadRoot, byId, dmById, reactions, pins) {
  const { plan } = ctx;
  const m = x.m;
  const deleted = !!m.deleted_at;
  const root = x.src === 'messages' && m.thread_id ? threadRoot.get(m.thread_id) : null;
  if (x.src === 'messages' && m.thread_id && !root) ctx.skipped.thread_without_root += 1;
  const threadRootId = root && root !== m.id ? root : null;
  const also = !!threadRootId && !!m.also_send_to_channel;
  const authorId = m.author_id && ctx.migrated.has(m.author_id) ? m.author_id : null;
  const readers = ctx.readers.get(info.id) || new Set();
  const legacyIds = (m.mention_user_ids || []).filter(Boolean);
  const meta = { legacy: { seq: Number(m.seq) } };

  let body = '';
  let mentions = [];
  let mentionAll = false;
  if (!deleted) {
    const card = cardText(m.body, m.body_text);
    if (card) { meta.legacy.card = card.kind; ctx.counts.cards += 1; }
    const convertible = legacyIds.filter((id) => ctx.migrated.has(id));
    const conv = convertMentions(card ? card.text : (m.body_text || ''), convertible, ctx.people);
    body = conv.text;
    ctx.counts.mention_ids += legacyIds.length;
    ctx.counts.mention_tokens_converted += conv.matched.size;
    const scope = x.src === 'messages' ? m.mention_scope : 'none';
    if (scope === 'here' || scope === 'channel') { mentionAll = true; body = convertScope(body); }
    mentions = [...new Set(legacyIds)].filter((id) => readers.has(id));
    ctx.counts.mentions_dropped_not_reader += new Set(legacyIds).size - mentions.length;
    if (m.reply_to_id) {
      const parent = (x.src === 'messages' ? byId : dmById).get(m.reply_to_id);
      const name = parent ? ctx.people.get(parent.author_id)?.display_name : null;
      body = `${quoteLine(parent, name)}\n${body}`;
      meta.legacy.reply_to = parent && ctx.messageIdKnown(parent.id) ? parent.id : null;
      ctx.counts.quotes += 1;
    }
    if (body.length > LIMITS.body) { body = body.slice(0, LIMITS.body); ctx.counts.truncated += 1; }
  }

  const rx = deleted ? [] : (reactions.get(m.id) || []).filter((r) => ctx.migrated.has(r.user_id))
    .sort((a, b) => cmp([tsKey(a.created_at), tsKey(b.created_at)], [a.user_id, b.user_id]));
  const summary = {};
  for (const r of rx) {
    const emoji = clip(r.emoji, LIMITS.emoji);
    (summary[emoji] ||= []).push(r.user_id);
    plan.rows.reactions.push({ message_id: m.id, emoji, user_id: r.user_id, channel_id: info.id,
      org_id: info.org, created_at: r.created_at });
    plan.owned.reaction.push(`${m.id}:${emoji}:${r.user_id}`);
  }
  if (deleted) ctx.counts.reactions_on_deleted += (reactions.get(m.id) || []).length;

  const pin = !deleted && x.src === 'messages' ? pins.get(m.id) : null;
  const attachments = deleted ? [] : planAttachments(ctx, info, m, authorId);

  if (!deleted) {
    for (const uid of mentions) {
      if (uid === authorId) continue;
      plan.rows.mentions.push({ message_id: m.id, user_id: uid, channel_id: info.id, org_id: info.org,
        seq, created_at: m.created_at });
      plan.owned.mention.push(`${m.id}:${uid}`);
    }
  }

  return {
    id: m.id, org_id: info.org, channel_id: info.id, seq, thread_root_id: threadRootId,
    in_timeline: !threadRootId || also, also_in_channel: also,
    author_id: authorId, kind: m.author_id ? 'user' : 'system', body, mentions, mention_all: mentionAll,
    client_id: m.client_msg_id || null, created_at: m.created_at, edited_at: m.edited_at || null,
    deleted_at: m.deleted_at || null, deleted_by: null,
    updated_at: maxTs(m.created_at, m.edited_at, m.deleted_at, pin?.pinned_at, ...rx.map((r) => r.created_at)),
    reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: summary,
    attachment_count: attachments.length,
    pinned_at: pin ? pin.pinned_at : null,
    pinned_by: pin && ctx.migrated.has(pin.pinned_by) ? pin.pinned_by : null,
    meta, legacy_id: m.id,
  };
}

// One dek.attachments row per element of the legacy attachments json. The first
// reference to a stored file keeps the legacy attachment id; later references (a
// forward) and elements without a legacy row get uuid v5 ids.
function planAttachments(ctx, info, m, authorId) {
  const { plan } = ctx;
  const list = Array.isArray(m.attachments) ? m.attachments : [];
  const out = [];
  list.forEach((a, index) => {
    if (!a?.object_key) { ctx.counts.attachments_without_key += 1; return; }
    const obj = ctx.objects.get(a.object_key);
    if (!obj) { plan.warnings.push(`attachment object missing for message ${m.id} element ${index}`); return; }
    const legacyRow = ctx.attachmentByKey.get(a.object_key);
    let id;
    let legacyId = null;
    if (legacyRow && !ctx.usedLegacyAttachment.has(legacyRow.id)) {
      id = legacyRow.id;
      legacyId = legacyRow.id;
      ctx.usedLegacyAttachment.add(legacyRow.id);
    } else {
      id = uuidv5(`attachment:${m.id}:${index}`, ID_NAMESPACE);
      plan.idMap.push({ kind: 'attachment', legacy_key: legacyRow ? `${legacyRow.id}:${m.id}` : `message:${m.id}:${index}`,
        new_id: id, note: legacyRow ? 'second reference to one stored file' : 'element without a legacy attachment row',
        extra: { message_id: m.id, index } });
    }
    const name = clip(String(a.name || baseName(a.object_key)).trim() || baseName(a.object_key), LIMITS.fileName);
    const safe = safeFileName(a.name || baseName(a.object_key), extOf(a.object_key));
    const dir = `${info.org}/${info.id}/${id}`;
    const path = `${dir}/${safe}`;
    let thumbPath = null;
    const thumb = a.thumb_key ? ctx.objects.get(a.thumb_key) : null;
    if (thumb) {
      const ext = extOf(a.thumb_key) || 'jpg';
      thumbPath = `${dir}/thumb.${ext === 'webp' ? 'webp' : ext}`;
      plan.objects.push({ kind: 'thumb', bucket: MEDIA_BUCKET, path: thumbPath, legacyKey: a.thumb_key,
        contentType: baseMime(thumb.mimetype) || 'image/jpeg', size: Number(thumb.size), legacySha: null });
    } else if (a.thumb_key) {
      plan.warnings.push(`thumbnail object missing for message ${m.id} element ${index}`);
    }
    plan.objects.push({ kind: 'attachment', bucket: MEDIA_BUCKET, path, legacyKey: a.object_key,
      contentType: baseMime(obj.mimetype) || baseMime(a.mime) || 'application/octet-stream',
      size: Number(obj.size), legacySha: legacyRow?.sha256 || null });
    const declared = String(a.mime || legacyRow?.mime || obj.mimetype || 'application/octet-stream').slice(0, 120);
    const created = legacyRow?.created_at || m.created_at;
    plan.rows.attachments.push({
      id, org_id: info.org, channel_id: info.id, message_id: m.id, uploader_id: authorId, bucket: MEDIA_BUCKET,
      object_path: path, thumb_path: thumbPath, file_name: name, declared_mime: declared,
      mime_type: (baseMime(obj.mimetype) || baseMime(declared)).slice(0, 120), size_bytes: Number(obj.size),
      width: intOrNull(a.width ?? legacyRow?.width), height: intOrNull(a.height ?? legacyRow?.height),
      duration_ms: intOrNull(a.duration_ms ?? legacyRow?.duration_ms), status: 'ready', reject_reason: null,
      created_at: created, ready_at: created, deleted_at: null, purged_at: null, legacy_id: legacyId,
    });
    plan.owned.attachment.push(id);
    out.push(id);
  });
  return out;
}

const intOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

// reply_count counts live replies (a delete decrements it in the new model);
// last_reply_at and reply_user_ids keep every reply, as sending would have.
function rootCounters(ctx) {
  const replies = groupBy(ctx.plan.rows.messages.filter((r) => r.thread_root_id), 'thread_root_id');
  for (const [rootId, list] of replies) {
    const root = ctx.messageRow.get(rootId);
    if (!root) continue;
    const ordered = list.slice().sort((a, b) => a.seq - b.seq);
    root.reply_count = ordered.filter((r) => !r.deleted_at).length;
    root.last_reply_at = ordered.reduce((acc, r) => maxTs(acc, r.created_at), null);
    root.reply_user_ids = [...new Set(ordered.map((r) => r.author_id).filter(Boolean))];
    root.updated_at = maxTs(root.updated_at, root.last_reply_at);
  }
}

function channelState(ctx) {
  for (const ch of ctx.plan.rows.channels) {
    const rows = ctx.plan.rows.messages.filter((m) => m.channel_id === ch.id);
    ctx.plan.rows.channel_state.push({
      channel_id: ch.id,
      last_seq: rows.length,
      last_top_seq: rows.filter((m) => m.in_timeline).reduce((a, m) => Math.max(a, m.seq), 0),
      last_message_at: rows.reduce((acc, m) => maxTs(acc, m.created_at), null),
    });
  }
}
