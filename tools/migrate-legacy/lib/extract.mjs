// Reads everything the migration needs from the legacy database: one SELECT at a
// time, inside one REPEATABLE READ READ ONLY transaction (a single snapshot), on
// one connection. Only the two real organizations and the accounts that belong to
// them (plus no-org accounts on real domains) are read in full.
import { ORG_IDS, TEST_DOMAINS } from './config.mjs';

// Organization scoping, reused by every query below.
const CH = `select c.id from public.channels c join public.workspaces w on w.id = c.workspace_id
             where w.org_id = any($1::uuid[])`;
const CONV = `select cv.id from public.conversations cv join public.workspaces w on w.id = cv.workspace_id
               where w.org_id = any($1::uuid[])`;

const USERS_INCLUDED = `
  (exists (select 1 from public.org_members om where om.user_id = u.id and om.org_id = any($1::uuid[]))
   or not exists (select 1 from public.org_members om where om.user_id = u.id))
  and lower(split_part(coalesce(u.email, ''), '@', 2)) <> all ($2::text[])
  and not coalesce(p.is_app, false)`;

export async function extract(db, log = () => {}) {
  const t0 = Date.now();
  const P = [ORG_IDS];
  const q = async (name, sql, params = P) => {
    const rows = await db.rows(sql, params);
    log(`  read ${name}: ${rows.length}`);
    return rows;
  };
  const d = {};
  const snap = await db.rows(`select now() as at, txid_current_snapshot()::text as snapshot,
    pg_encoding_to_char((select encoding from pg_database where datname = current_database())) as encoding,
    (select extensions.digest('Ab-_9z', 'sha256') = sha256(convert_to('Ab-_9z', 'UTF8'))) as digest_is_sha256_utf8`);
  d.snapshot = snap[0];

  d.orgs = await q('organizations', `select id, slug::text as slug, name, created_at, scheduled_delete_at
    from public.organizations where id = any($1::uuid[])`);

  d.users = await q('users', `
    select to_jsonb(u) - 'confirmed_at' as auth, to_jsonb(p) as profile,
           exists (select 1 from public.org_members om where om.user_id = u.id and om.org_id = any($1::uuid[])) as real_member
      from auth.users u left join public.profiles p on p.id = u.id
     where ${USERS_INCLUDED}
     order by u.id`, [ORG_IDS, TEST_DOMAINS]);
  d.excludedUsers = await q('excluded user counts', `
    select case when lower(split_part(coalesce(u.email, ''), '@', 2)) = any ($2::text[]) then 'test_domain'
                when coalesce(p.is_app, false) then 'app_identity'
                else 'only_in_synthetic_orgs' end as reason, count(*)::int as n
      from auth.users u left join public.profiles p on p.id = u.id
     where not (${USERS_INCLUDED}) group by 1 order by 1`, [ORG_IDS, TEST_DOMAINS]);
  const uids = d.users.map((u) => u.auth.id);
  const U = [uids];

  d.identities = await q('identities', `select to_jsonb(i) - 'email' as row from auth.identities i
    where i.user_id = any($1::uuid[]) order by i.id`, U);
  d.sessions = await q('sessions', `select to_jsonb(s) as row from auth.sessions s
    where s.user_id = any($1::uuid[]) and (s.not_after is null or s.not_after > now())
      and exists (select 1 from auth.refresh_tokens r where r.session_id = s.id and not coalesce(r.revoked, false))
    order by s.id`, U);
  d.refreshTokens = await q('refresh tokens', `select to_jsonb(r) - 'id' as row from auth.refresh_tokens r
    join auth.sessions s on s.id = r.session_id
    where s.user_id = any($1::uuid[]) and (s.not_after is null or s.not_after > now())
      and not coalesce(r.revoked, false) order by r.id`, U);
  d.amrClaims = await q('amr claims', `select to_jsonb(a) as row from auth.mfa_amr_claims a
    join auth.sessions s on s.id = a.session_id
    where s.user_id = any($1::uuid[]) and (s.not_after is null or s.not_after > now())
      and exists (select 1 from auth.refresh_tokens r where r.session_id = s.id and not coalesce(r.revoked, false))
    order by a.id`, U);
  d.sessionCounts = (await q('session totals', `select count(*)::int as sessions,
      count(*) filter (where s.not_after is not null and s.not_after <= now())::int as expired,
      count(*) filter (where not exists (select 1 from auth.refresh_tokens r
                       where r.session_id = s.id and not coalesce(r.revoked, false)))::int as without_live_token
    from auth.sessions s where s.user_id = any($1::uuid[])`, U))[0];

  d.orgMembers = await q('org members', `select org_id, user_id, org_role, joined_at
    from public.org_members where org_id = any($1::uuid[]) order by org_id, user_id`);
  d.platformAdmins = await q('platform admins', 'select user_id, org_id, created_at from public.platform_admins', []);
  d.workspaces = await q('workspaces', `select id, org_id, slug::text as slug, name, created_by, created_at,
      archived_at, scheduled_delete_at, requires_approval, join_policy, default_channel_id, rules_text, icon_key
    from public.workspaces where org_id = any($1::uuid[]) order by created_at, id`);
  d.wsMembers = await q('workspace members', `select wm.workspace_id, wm.user_id, wm.member_type, wm.joined_at
    from public.workspace_members wm join public.workspaces w on w.id = wm.workspace_id
    where w.org_id = any($1::uuid[]) order by wm.workspace_id, wm.user_id`);
  d.memberRoles = await q('member roles', `select mr.workspace_id, mr.user_id, r.id as role_id, r.name,
      r.permissions::text as permissions
    from public.member_roles mr join public.roles r on r.id = mr.role_id and r.workspace_id = mr.workspace_id
    join public.workspaces w on w.id = mr.workspace_id where w.org_id = any($1::uuid[])`);
  d.channels = await q('channels', `select c.id, c.workspace_id, c.kind, c.name::text as name, c.topic,
      c.position::text as position, c.is_private, c.readonly, c.created_at, c.archived_at, k.name as category
    from public.channels c join public.workspaces w on w.id = c.workspace_id
    left join public.categories k on k.id = c.category_id
    where w.org_id = any($1::uuid[]) order by c.workspace_id, c.position, c.created_at, c.id`);
  d.channelMembers = await q('channel members', `select cm.channel_id, cm.user_id from public.channel_members cm
    where cm.channel_id in (${CH}) order by cm.channel_id, cm.user_id`);
  d.channelOverwrites = (await q('channel overwrites', `select count(*)::int as n from public.channel_overwrites o
    where o.channel_id in (${CH})`))[0].n;

  d.messages = await q('messages', `select m.id, m.channel_id, m.thread_id, m.author_id, m.seq, m.client_msg_id,
      m.body, m.body_text, m.attachments, m.mention_user_ids, m.mention_scope, m.reply_to_id,
      m.created_at, m.edited_at, m.deleted_at, m.also_send_to_channel
    from public.messages m where m.channel_id in (${CH}) order by m.channel_id, m.seq`);
  d.threads = await q('threads', `select t.id, t.channel_id, t.root_message_id, t.reply_count, t.created_at
    from public.threads t where t.channel_id in (${CH})`);
  d.threadFollowers = await q('thread followers', `select f.thread_id, f.user_id, f.created_at
    from public.thread_followers f join public.threads t on t.id = f.thread_id where t.channel_id in (${CH})`);
  d.conversations = await q('conversations', `select cv.id, cv.workspace_id, w.org_id, cv.kind, cv.created_at,
      cv.last_message_at, cv.last_seq
    from public.conversations cv join public.workspaces w on w.id = cv.workspace_id
    where w.org_id = any($1::uuid[]) order by cv.created_at, cv.id`);
  d.convMembers = await q('conversation members', `select cm.conversation_id, cm.user_id, cm.last_read_seq,
      cm.last_read_at from public.conversation_members cm where cm.conversation_id in (${CONV})`);
  d.dmMessages = await q('dm messages', `select d.id, d.conversation_id, d.author_id, d.seq, d.client_msg_id,
      d.body, d.body_text, d.attachments, d.reply_to_id, d.created_at, d.edited_at, d.deleted_at,
      d.mention_user_ids from public.dm_messages d where d.conversation_id in (${CONV})
    order by d.conversation_id, d.seq`);
  d.reactions = await q('reactions', `select r.message_id, r.user_id, r.emoji, r.created_at
    from public.message_reactions r join public.messages m on m.id = r.message_id
    where m.channel_id in (${CH})`);
  d.dmReactions = await q('dm reactions', `select r.message_id, r.user_id, r.emoji, r.created_at
    from public.dm_message_reactions r join public.dm_messages d on d.id = r.message_id
    where d.conversation_id in (${CONV})`);
  d.pins = await q('pins', `select p.channel_id, p.message_id, p.pinned_by, p.pinned_at from public.pins p
    where p.channel_id in (${CH})`);
  d.saved = await q('saved items', `select s.user_id, s.message_id, s.created_at, s.state, s.remind_at
    from public.saved_items s
    where s.message_id in (select m.id from public.messages m where m.channel_id in (${CH}))
       or s.message_id in (select d.id from public.dm_messages d where d.conversation_id in (${CONV}))`);
  d.readState = await q('read state', `select rs.user_id, rs.scope_type, rs.scope_id, rs.last_read_seq,
      rs.notify_level, rs.muted_until, rs.updated_at
    from public.read_state rs
    where (rs.scope_type = 'channel' and rs.scope_id in (${CH}))
       or (rs.scope_type = 'thread' and rs.scope_id in (select t.id from public.threads t where t.channel_id in (${CH})))`);

  const keys = collectObjectKeys(d);
  d.attachmentRows = await q('attachment rows', `select a.id, a.workspace_id, a.uploader_id, a.object_key,
      encode(a.sha256, 'hex') as sha256, a.mime, a.byte_size, a.width, a.height, a.duration_ms, a.status, a.created_at
    from public.attachments a where a.object_key = any($1::text[])`, [keys]);
  d.objects = await q('storage objects', `select o.name, (o.metadata->>'size')::bigint as size,
      o.metadata->>'mimetype' as mimetype from storage.objects o
    where o.bucket_id = 'attachments' and o.name = any($1::text[])`, [keys]);

  d.invites = await q('invites', `select i.id, w.org_id, i.workspace_id, encode(i.token_sha256, 'hex') as token_sha256,
      i.grant_role_id, i.max_uses, i.uses, i.created_by, i.expires_at, i.revoked_at, i.created_at
    from public.invites i join public.workspaces w on w.id = i.workspace_id where w.org_id = any($1::uuid[])
    order by i.created_at, i.id`);
  d.orgInvites = await q('org invites', `select o.id, o.org_id, encode(o.token_sha256, 'hex') as token_sha256,
      o.grant_role, o.max_uses, o.uses, o.created_by, o.expires_at, o.revoked_at, o.created_at
    from public.org_invites o where o.org_id = any($1::uuid[]) order by o.created_at, o.id`);
  d.notificationPrefs = await q('notification prefs', `select user_id, dnd_until, quiet_start, quiet_end, digest,
      updated_at from public.notification_prefs where user_id = any($1::uuid[])`, U);
  d.pushSubs = await q('push subscriptions', `select user_id, endpoint, p256dh, auth, ua, created_at, last_ok_at,
      fail_count from public.push_subscriptions where user_id = any($1::uuid[]) order by created_at, user_id`, U);
  d.joinRequests = await q('join requests', `select jr.id, w.org_id, jr.workspace_id, jr.user_id, jr.status,
      jr.decided_by, jr.decided_at, jr.created_at
    from public.workspace_join_requests jr join public.workspaces w on w.id = jr.workspace_id
    where w.org_id = any($1::uuid[])`);
  d.bans = await q('bans', `select b.workspace_id, w.org_id, b.user_id, b.banned_by, b.reason is not null as has_reason,
      b.created_at from public.bans b join public.workspaces w on w.id = b.workspace_id
    where w.org_id = any($1::uuid[])`);

  d.archive = await extractArchive(q, uids);
  log(`  extract finished in ${Date.now() - t0} ms`);
  return d;
}

export function collectObjectKeys(d) {
  const keys = new Set();
  for (const m of [...d.messages, ...d.dmMessages]) {
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
      if (a?.object_key) keys.add(a.object_key);
      if (a?.thumb_key) keys.add(a.thumb_key);
    }
  }
  for (const u of d.users) if (u.profile?.avatar_key) keys.add(u.profile.avatar_key);
  return [...keys].sort();
}

// Off-scope features, exported as JSON for the archive and never loaded into the
// new database (tasks, polls, events, forms, canvases, away days, nicknames,
// drafts, the workspace roles table, and fields the new profile does not keep).
async function extractArchive(q, uids) {
  const WS = `select w.id from public.workspaces w where w.org_id = any($1::uuid[])`;
  const tables = {
    tasks: `select to_jsonb(t) as row from public.tasks t where t.workspace_id in (${WS})`,
    polls: `select to_jsonb(p) as row from public.polls p where p.workspace_id in (${WS})`,
    poll_votes: `select to_jsonb(v) as row from public.poll_votes v join public.polls p on p.id = v.poll_id
                  where p.workspace_id in (${WS})`,
    events: `select to_jsonb(e) as row from public.events e where e.workspace_id in (${WS})`,
    event_rsvps: `select to_jsonb(r) as row from public.event_rsvps r where r.workspace_id in (${WS})`,
    form_defs: `select to_jsonb(f) as row from public.form_defs f where f.workspace_id in (${WS})`,
    form_submissions: `select to_jsonb(s) as row from public.form_submissions s where s.workspace_id in (${WS})`,
    form_templates: `select to_jsonb(t) as row from public.form_templates t where t.org_id = any($1::uuid[])`,
    canvases: `select to_jsonb(c) as row from public.canvases c where c.workspace_id in (${WS})`,
    canvas_blocks: `select to_jsonb(b) as row from public.canvas_blocks b where b.workspace_id in (${WS})`,
    away_days: `select to_jsonb(a) as row from public.away_days a where a.org_id = any($1::uuid[])`,
    leave_policies: `select to_jsonb(l) as row from public.leave_policies l where l.org_id = any($1::uuid[])`,
    roles: `select to_jsonb(r) || jsonb_build_object('permissions', r.permissions::text) as row
              from public.roles r where r.workspace_id in (${WS})`,
    member_roles: `select to_jsonb(m) as row from public.member_roles m where m.workspace_id in (${WS})`,
    scheduled_messages: `select to_jsonb(s) as row from public.scheduled_messages s where s.workspace_id in (${WS})`,
  };
  const userTables = {
    drafts: `select to_jsonb(d) as row from public.drafts d where d.user_id = any($1::uuid[])`,
    user_nicknames: `select to_jsonb(n) as row from public.user_nicknames n where n.viewer_id = any($1::uuid[])`,
    saved_items: `select to_jsonb(s) as row from public.saved_items s where s.user_id = any($1::uuid[])`,
    profiles_extra: `select jsonb_build_object('id', p.id, 'pronouns', p.pronouns, 'bio', p.bio, 'phone', p.phone,
                       'department', p.department, 'location', p.location, 'start_date', p.start_date,
                       'manager_id', p.manager_id, 'must_set_password', p.must_set_password,
                       'password_set_at', p.password_set_at, 'quiet_hours', p.quiet_hours::text) as row
                     from public.profiles p where p.id = any($1::uuid[])`,
  };
  const out = {};
  for (const [name, sql] of Object.entries(tables)) out[name] = (await q(`archive ${name}`, sql)).map((r) => r.row);
  for (const [name, sql] of Object.entries(userTables)) {
    out[name] = (await q(`archive ${name}`, sql, [uids])).map((r) => r.row);
  }
  return out;
}
