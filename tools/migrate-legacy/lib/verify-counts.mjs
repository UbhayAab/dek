// Independent counts for the reconciliation: plain SQL against each database, not
// the transform's output. Expected values apply the mapping rules in SQL on legacy.

// The migrated user set, restated in legacy SQL ($2 = org ids, $3 = test domains).
const MIG = `select u.id from auth.users u left join public.profiles p on p.id = u.id
  where (exists (select 1 from public.org_members om where om.user_id = u.id and om.org_id = any($2::uuid[]))
         or not exists (select 1 from public.org_members om where om.user_id = u.id))
    and lower(split_part(coalesce(u.email, ''), '@', 2)) <> all ($3::text[])
    and not coalesce(p.is_app, false)`;

export const LEGACY_COUNTS = `
with mig as (${MIG}),
ws as (select id from public.workspaces where org_id = $1),
ch as (select id, workspace_id, kind, is_private from public.channels where workspace_id in (select id from ws)),
cv as (select c.id, c.created_at,
              array(select m.user_id::text from public.conversation_members m
                     where m.conversation_id = c.id and m.user_id in (select id from mig) order by 1) as ids
         from public.conversations c where c.workspace_id in (select id from ws)),
pairs as (select distinct ids from cv where cardinality(ids) > 0),
msg as (select m.* from public.messages m where m.channel_id in (select id from ch)),
dm as (select d.* from public.dm_messages d where d.conversation_id in (select id from cv where cardinality(ids) > 0)),
roots as (select t.id, t.root_message_id from public.threads t join msg r on r.id = t.root_message_id and r.channel_id = t.channel_id),
readers as (
  select c.id as channel_id, wm.user_id from ch c join public.workspace_members wm on wm.workspace_id = c.workspace_id
   where not c.is_private and wm.user_id in (select id from mig)
  union
  select cm.channel_id, cm.user_id from public.channel_members cm join ch c on c.id = cm.channel_id
   where c.is_private and cm.user_id in (select id from mig)),
els as (select x.id, x.deleted_at, e from (select id, deleted_at, attachments from msg union all
                                             select id, deleted_at, attachments from dm) x,
         jsonb_array_elements(case when jsonb_typeof(x.attachments) = 'array' then x.attachments else '[]'::jsonb end) e)
select
  (select count(*) from ws)::int as servers,
  (select count(*) from public.workspaces where org_id = $1 and (archived_at is not null or scheduled_delete_at is not null))::int as servers_archived,
  (select count(*) from ch where kind <> 'voice')::int as text_channels,
  (select count(*) from ch where kind = 'voice')::int as audio_channels,
  (select count(*) from ch where is_private)::int as private_channels,
  (select count(*) from cv where cardinality(ids) > 0)::int as conversations,
  (select count(*) from pairs)::int as dm_channels,
  (select count(*) from public.org_members where org_id = $1)::int as org_members_raw,
  (select count(*) from public.org_members where org_id = $1 and user_id in (select id from mig))::int as org_members,
  (select count(*) from public.org_members where org_id = $1 and org_role = 'admin' and user_id in (select id from mig))::int as org_admins,
  (select count(*) from public.workspace_members where workspace_id in (select id from ws) and user_id in (select id from mig))::int as server_members,
  (select count(*) from public.channel_members where channel_id in (select id from ch))::int as channel_members_raw,
  ((select count(*) from readers) + (select coalesce(sum(cardinality(ids)), 0) from pairs))::int as channel_members,
  (select count(*) from msg)::int as messages_channel,
  (select count(*) from dm)::int as messages_dm,
  ((select count(*) from msg where deleted_at is not null) + (select count(*) from dm where deleted_at is not null))::int as deleted,
  (select count(*) from public.messages where edited_at is not null and channel_id in (select id from ch))::int
    + (select count(*) from dm where edited_at is not null)::int as edited,
  (select count(*) from public.threads where channel_id in (select id from ch))::int as threads_raw,
  (select count(*) from roots r where exists (select 1 from msg m where m.thread_id = r.id and m.id <> r.root_message_id))::int as thread_roots,
  (select count(*) from msg m join roots r on r.id = m.thread_id where m.id <> r.root_message_id)::int as thread_replies,
  ((select count(*) from public.message_reactions x join msg m on m.id = x.message_id where m.deleted_at is null and x.user_id in (select id from mig))
   + (select count(*) from public.dm_message_reactions x join dm m on m.id = x.message_id where m.deleted_at is null and x.user_id in (select id from mig)))::int as reactions,
  ((select count(*) from public.message_reactions x join msg m on m.id = x.message_id)
   + (select count(*) from public.dm_message_reactions x join dm m on m.id = x.message_id))::int as reactions_raw,
  ((select count(*) from (select distinct m.id, u from msg m, unnest(m.mention_user_ids) u
      where m.deleted_at is null and u is distinct from m.author_id
        and exists (select 1 from readers r where r.channel_id = m.channel_id and r.user_id = u)) a)
   + (select count(*) from (select distinct d.id, u from dm d join cv on cv.id = d.conversation_id, unnest(d.mention_user_ids) u
      where d.deleted_at is null and u is distinct from d.author_id and u::text = any(cv.ids)) b))::int as mentions,
  (select count(*) from els where deleted_at is null)::int as attachments,
  (select coalesce(sum((o.metadata->>'size')::bigint), 0) from els
     join storage.objects o on o.bucket_id = 'attachments' and o.name = els.e->>'object_key'
    where els.deleted_at is null)::bigint as attachment_bytes,
  (select count(*) from public.pins p join msg m on m.id = p.message_id where m.deleted_at is null)::int as pins,
  (select count(*) from public.saved_items s where s.user_id in (select id from mig)
      and (s.message_id in (select id from msg where deleted_at is null) or s.message_id in (select id from dm where deleted_at is null)))::int as saved,
  ((select count(*) from public.invites where workspace_id in (select id from ws))
   + (select count(*) from public.org_invites where org_id = $1))::int as invites,
  ((select count(*) from public.invites i where workspace_id in (select id from ws) and i.revoked_at is null
      and (i.expires_at is null or i.expires_at > now()) and (i.max_uses is null or i.uses < i.max_uses))
   + (select count(*) from public.org_invites i where org_id = $1 and i.revoked_at is null
      and (i.expires_at is null or i.expires_at > now()) and (i.max_uses is null or i.uses < i.max_uses)))::int as invites_usable,
  (select count(*) from public.workspace_join_requests where workspace_id in (select id from ws) and user_id in (select id from mig))::int as join_requests,
  (select count(*) from public.bans where workspace_id in (select id from ws))::int as ban_notes,
  (select count(distinct ps.endpoint) from public.push_subscriptions ps
     where ps.user_id in (select user_id from public.org_members where org_id = $1) and ps.user_id in (select id from mig))::int as devices,
  (select coalesce(sum((select count(*) from msg m where m.channel_id = rs.scope_id and m.seq > rs.last_read_seq)), 0)
     from public.read_state rs join readers r on r.channel_id = rs.scope_id and r.user_id = rs.user_id
    where rs.scope_type = 'channel' and rs.last_read_seq > 0)::int as unread_after_cursor,
  (select coalesce(sum((select count(*) from public.dm_messages d
                         where d.conversation_id = cm.conversation_id and d.seq > cm.last_read_seq)), 0)
     from public.conversation_members cm join cv on cv.id = cm.conversation_id
    where cardinality(cv.ids) > 0 and cm.user_id in (select id from mig)
      and (select count(*) from cv c2 where c2.ids = cv.ids) = 1)::int as dm_unread_after_cursor`;

export const NEW_COUNTS = `
with ch as (select * from dek.channels where org_id = $1),
msg as (select m.* from dek.messages m where m.org_id = $1 and m.legacy_id is not null),
dms as (select id from ch where server_id is null),
att as (select a.* from dek.attachments a where a.org_id = $1 and a.status = 'ready')
select
  (select count(*) from dek.servers where org_id = $1)::int as servers,
  (select count(*) from dek.servers where org_id = $1 and archived_at is not null)::int as servers_archived,
  (select count(*) from ch where kind = 'text')::int as text_channels,
  (select count(*) from ch where kind = 'audio')::int as audio_channels,
  (select count(*) from ch where server_id is not null and visibility = 'private')::int as private_channels,
  (select count(*) from dms)::int as dm_channels,
  (select count(*) from dek.org_members where org_id = $1)::int as org_members,
  (select count(*) from dek.org_members where org_id = $1 and role = 'admin')::int as org_admins,
  (select count(*) from dek.org_members where org_id = $1 and role = 'owner')::int as org_owners,
  (select count(*) from dek.server_members where org_id = $1)::int as server_members,
  (select count(*) from dek.channel_members where org_id = $1)::int as channel_members,
  (select count(*) from msg where channel_id not in (select id from dms))::int as messages_channel,
  (select count(*) from msg where channel_id in (select id from dms))::int as messages_dm,
  (select count(*) from msg where deleted_at is not null)::int as deleted,
  (select count(*) from msg where edited_at is not null)::int as edited,
  (select count(distinct thread_root_id) from msg where thread_root_id is not null)::int as thread_roots,
  (select count(*) from msg where thread_root_id is not null)::int as thread_replies,
  (select count(*) from dek.reactions where org_id = $1)::int as reactions,
  (select coalesce(sum((select coalesce(sum(jsonb_array_length(v)), 0) from jsonb_each(m.reactions) e(k, v))), 0) from msg m)::int as reaction_summary,
  (select count(*) from dek.mentions where org_id = $1)::int as mentions,
  (select count(*) from att)::int as attachments,
  (select coalesce(sum(size_bytes), 0) from att)::bigint as attachment_bytes,
  (select coalesce(sum((o.metadata->>'size')::bigint), 0) from att join storage.objects o
     on o.bucket_id = 'media' and o.name = att.object_path)::bigint as stored_bytes,
  (select count(*) from msg where pinned_at is not null)::int as pins,
  (select count(*) from dek.saved_messages where org_id = $1)::int as saved,
  (select count(*) from dek.invites where org_id = $1 and legacy_id is not null)::int as invites,
  (select count(*) from dek.invites where org_id = $1 and legacy_id is not null and revoked_at is null
      and expires_at > now() and (max_uses is null or use_count < max_uses))::int as invites_usable,
  (select count(*) from dek.join_requests where org_id = $1)::int as join_requests,
  (select count(*) from dek.audit_log where org_id = $1 and action = 'legacy.server_ban')::int as ban_notes,
  (select count(*) from dek.push_devices d where d.user_id in (select user_id from dek.org_members where org_id = $1))::int as devices,
  (select count(*) from dek.push_devices d where d.enabled and d.user_id in (select user_id from dek.org_members where org_id = $1))::int as devices_enabled,
  (select coalesce(sum((select count(*) from dek.messages m where m.channel_id = cm.channel_id and m.seq > cm.last_read_seq)), 0)
     from dek.channel_members cm join ch on ch.id = cm.channel_id
    where ch.server_id is not null and cm.last_read_at is not null)::int as unread_after_cursor,
  (select coalesce(sum((select count(*) from dek.messages m where m.channel_id = cm.channel_id and m.seq > cm.last_read_seq)), 0)
     from dek.channel_members cm join ch on ch.id = cm.channel_id
    where ch.server_id is null and not exists (select 1 from dek_migration.id_map x
            where x.kind = 'conversation' and x.new_id = ch.id and x.legacy_key <> ch.id::text))::int as dm_unread_after_cursor`;

// Global invariants of the migrated data in the new project.
export async function invariants(db, orgIds) {
  const one = async (sql, params = [orgIds]) => (await db.query(sql, params)).rows[0];
  const out = [];
  const seq = await one(`select count(*)::int as bad from (
      select c.id from dek.channels c join dek.channel_state s on s.channel_id = c.id
        left join dek.messages m on m.channel_id = c.id
       where c.org_id = any($1::uuid[])
       group by c.id, s.last_seq, s.last_top_seq
      having count(m.id) <> s.last_seq or coalesce(max(m.seq), 0) <> s.last_seq or coalesce(min(m.seq), 1) <> 1
          or coalesce(max(m.seq) filter (where m.in_timeline), 0) <> s.last_top_seq) x`);
  out.push({ name: 'every channel has seq 1..n with channel_state.last_seq = n and last_top_seq = the last timeline seq', ok: seq.bad === 0, detail: `${seq.bad} channels off` });
  const rc = await one(`select count(*)::int as bad from dek.messages r
     where r.org_id = any($1::uuid[]) and r.reply_count <> (select count(*) from dek.messages x
       where x.thread_root_id = r.id and x.deleted_at is null)`);
  out.push({ name: 'reply_count equals the live replies of every root', ok: rc.bad === 0, detail: `${rc.bad} roots off` });
  const tomb = await one(`select count(*)::int as bad from dek.messages m where m.org_id = any($1::uuid[])
     and m.deleted_at is not null and (m.body <> '' or cardinality(m.mentions) > 0 or m.reactions <> '{}'::jsonb
       or m.attachment_count > 0 or m.pinned_at is not null)`);
  out.push({ name: 'deleted messages are empty tombstones', ok: tomb.bad === 0, detail: `${tomb.bad} off` });
  const intents = await one(`select count(*)::int as n from dek.notification_intents i
     where i.org_id = any($1::uuid[])`);
  out.push({ name: 'no notification intents exist for the migrated orgs (nothing was sent)', ok: intents.n === 0, detail: `${intents.n} intents` });
  const dev = await one('select count(*)::int as n from dek.push_devices where enabled', []);
  out.push({ name: 'every push device is disabled until --enable-push at cutover', ok: dev.n === 0, detail: `${dev.n} enabled` });
  const hashes = await one(`select count(*)::int as bad from dek.invites where org_id = any($1::uuid[])
     and octet_length(code_sha256) <> 32`);
  out.push({ name: 'every invite hash is 32 bytes (sha256)', ok: hashes.bad === 0, detail: `${hashes.bad} off` });
  const att = await one(`select count(*)::int as bad from dek.attachments a where a.org_id = any($1::uuid[])
     and a.status = 'ready' and not exists (select 1 from storage.objects o where o.bucket_id = a.bucket
       and o.name = a.object_path and (o.metadata->>'size')::bigint = a.size_bytes)`);
  out.push({ name: 'every ready attachment has its object in media with the recorded size', ok: att.bad === 0, detail: `${att.bad} missing` });
  const thumbs = await one(`select count(*)::int as bad from dek.attachments a where a.org_id = any($1::uuid[])
     and a.thumb_path is not null and not exists (select 1 from storage.objects o where o.bucket_id = a.bucket and o.name = a.thumb_path)`);
  out.push({ name: 'every thumbnail path exists in media', ok: thumbs.bad === 0, detail: `${thumbs.bad} missing` });
  const avatars = await one(`select count(*)::int as bad from dek.profiles p where p.legacy_id is not null
     and p.avatar_path is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'avatars' and o.name = p.avatar_path)`, []);
  out.push({ name: 'every migrated avatar path exists in the public avatars bucket', ok: avatars.bad === 0, detail: `${avatars.bad} missing` });
  const dmKeys = await one(`select count(*)::int as bad from dek.channels c
     where c.org_id = any($1::uuid[]) and c.kind in ('dm', 'group_dm')
       and c.dm_key is distinct from (c.org_id::text || ':' || (select array_to_string(array_agg(cm.user_id order by cm.user_id), ':')
                                        from dek.channel_members cm where cm.channel_id = c.id))`);
  out.push({ name: 'every DM key equals the key api.open_dm computes for its members (reopening finds it)', ok: dmKeys.bad === 0, detail: `${dmKeys.bad} off` });
  const lock = await one(`select bool_or(has_schema_privilege(r, 'dek_migration', 'USAGE')) as open
     from unnest(array['anon', 'authenticated', 'service_role']) r`, []);
  out.push({ name: 'dek_migration is not reachable by anon, authenticated or service_role', ok: lock.open === false });
  const prof = await one(`select count(*)::int as bad from dek.profiles p join auth.users u on u.id = p.id
     where p.legacy_id is not null and p.deleted_at is not null`, []);
  out.push({ name: 'no migrated profile is marked deleted', ok: prof.bad === 0, detail: `${prof.bad}` });
  return out;
}

// Same digest on both sides proves the password hashes were copied exactly,
// without either hash leaving its database.
export const PASSWORD_DIGEST = (ids) => ({
  sql: `select count(*)::int as n, encode(sha256(convert_to(coalesce(string_agg(id::text || ':' || coalesce(encrypted_password, ''), ',' order by id), ''), 'UTF8')), 'hex') as digest
          from auth.users where id = any($1::uuid[])`,
  params: [ids],
});
