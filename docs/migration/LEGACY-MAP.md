# Legacy Dek database map (project ybddogqphinruyunnuwx, read only, 2026-10-03)

Measured live, one SELECT at a time. No secrets, emails, endpoints or codes recorded.
`B` = `dek-backend/supabase/migrations/`, `L` = `dek-legacy/supabase/migrations/`.
Client code: `dek-legacy/js/`. Query tool: `node C:/Users/abhay/Desktop/claude/dek-legacy/scripts/db-query.mjs "<sql>"`
(read only, one query at a time, this database fell over under concurrent load on 2026-09-30).

## 0. Decisions for the migration (lead)

- Migrate the two real organizations only: Jarurat Care `019f993c-604d-7129-af26-e406dd9da295`
  and Safalta Setu `019f993c-6130-7f49-8406-bc9424bb0248`. The other 49 are test fixtures
  (section 8). The legacy project stays untouched as the archive.
- Users: everyone who is a member of either real org, plus accounts in no org whose email is
  not a test domain (`hearth.test`, `dek.app`, `dek-backend.test`, `apps.invalid`).
- Keep legacy UUIDs as the new primary keys wherever the entity maps one to one (orgs,
  workspaces to servers, channels, messages, users). Conversations become channels with the
  conversation UUID. Store the legacy id in `legacy_id` too.
- Renumber `seq` per channel in (legacy seq, created_at) order: legacy seq has gaps and DM
  seq is a separate space. Convert read cursors through the old-to-new seq map.

## 1. Tables (live schema is authoritative)

Notation: `?` nullable, U = auth.users, c = on delete cascade, n = set null. Real = the two real orgs.

| Table | Columns | Keys / FKs | Rows (real) |
|---|---|---|---|
| organizations | id, slug citext, name, created_at, identity_policy jsonb, scheduled_delete_at? | PK id; UQ slug | 51 (2) |
| org_members | org_id, user_id, org_role{admin,member}, joined_at | PK(org,user); org c, U c | 370 (327) |
| workspaces | id, org_id, slug, name, icon_key?, everyone_role_id?, retention_days?, created_by?, created_at, archived_at?, scheduled_delete_at?, verification_level, rules_text?, requires_approval, join_policy{open,invite}, default_channel_id? | PK id | 87 (19) |
| workspace_members | workspace_id, user_id, member_type{member,moderator,guest}, timeout_until?, joined_at | PK(ws,user) | 677 (625) |
| categories | id, workspace_id, name, position numeric | PK id | 86 |
| channels | id, workspace_id, category_id?, kind{text,announcement,voice,forum}, name citext?, topic?, position, is_private, last_seq, last_broadcast_seq, broadcast_mode, viewer_count, last_message_at?, created_at, archived_at?, slowmode_seconds, readonly, ... | PK id; UQ(ws,name) | 250 (97) |
| channel_members | channel_id, user_id, workspace_id | PK(channel,user) | 9 |
| messages | id, channel_id, workspace_id, thread_id?, author_id?, seq, client_msg_id, body jsonb, body_text, attachments jsonb, mention_user_ids uuid[], mention_scope{none,here,channel}, reply_to_id?, created_at, edited_at?, deleted_at?, topic?, priority, also_send_to_channel, ack_required | PK id; UQ(channel,seq), (channel,author,client_msg_id) | 4,484 (1,349) |
| threads | id, channel_id, workspace_id, root_message_id? (no FK), title?, state, reply_count, last_message_at?, created_by?, created_at | PK id | 312 (34) |
| thread_followers | thread_id, user_id, workspace_id, created_at | PK(thread,user) | 30 (25) |
| conversations | id, workspace_id, kind{dm,group_dm}, last_seq, last_message_at?, created_at | PK id | 78 (43) |
| conversation_members | conversation_id, user_id, last_read_seq, last_read_at? | PK(conv,user) | 88 (86) |
| dm_messages | id, conversation_id, author_id?, seq, client_msg_id, body, body_text, attachments, reply_to_id?, created_at, edited_at?, deleted_at?, mention_user_ids | PK id | 326 (183) |
| message_reactions | message_id, user_id, emoji, channel_id (no FK), created_at | PK(msg,user,emoji) | 437 (433) |
| dm_message_reactions | message_id, user_id, emoji, conversation_id, created_at | PK(msg,user,emoji) | 7 (7) |
| attachments | id, workspace_id, uploader_id, object_key, sha256?, mime?, byte_size?, width?, height?, duration_ms?, status{pending,ready,failed}, created_at | PK id; UQ object_key | 53 (52) |
| pins | channel_id, message_id, pinned_by?, pinned_at | PK(channel,msg) | 1 (0) |
| saved_items | user_id, message_id, created_at, state{todo,in_progress,done,archived}, remind_at? | PK(user,msg) | 14 (13) |
| read_state | user_id, scope_type{channel,thread,dm}, scope_id, last_read_seq, last_read_broadcast_seq, mention_count, notify_level{inherit,all,mentions,nothing}, notify_cursor_seq, muted_until | PK(user,type,id); NO FKs | 4,084 (1,112 valid) |
| push_subscriptions | user_id, endpoint, p256dh, auth, ua?, created_at, last_ok_at?, fail_count | PK(user,endpoint) | 135 (110 users) |
| profiles | id, username citext?, display_name?, avatar_key?, pronouns?, status_text?, status_emoji?, timezone, quiet_hours int4range?, is_ghost, created_at, updated_at, status_expires_at?, must_set_password, password_set_at?, title?, bio?, phone?, department?, location?, start_date?, manager_id?, is_app, app_id? | PK id; UQ username | 391 |
| roles / member_roles | per workspace permission bitmasks; ADMINISTRATOR = 1<<40 | | 196 / 229 (39 orphans) |
| invites | id, workspace_id, token_sha256, grant_role_id?, max_uses?, uses, created_by?, expires_at?, revoked_at?, created_at | unique token hash | 585 (555, 238 usable) |
| org_invites | id, org_id, token_sha256, grant_role{admin,member}, max_uses?, uses, created_by, expires_at?, revoked_at?, created_at | unique token hash | 100 (24) |
| notification_prefs | user_id, dnd_until?, quiet_start?, quiet_end?, digest, updated_at | | 6 |
| bans | workspace_id, user_id, banned_by?, reason?, created_at | | 1 |
| drafts, user_nicknames, notification_overrides, custom_emoji, reports, user_blocks | | | 24, 7, 0, 0, 0, 0 |
| polls, events, forms, tasks, canvases, away_days, apps | off scope (section 10) | | |

Live differs from migrations: `profiles.id` is on delete cascade to auth.users (B0016:30);
`otp_codes` is in `public`.

## 2. Threads and seq

- A thread is a `threads` row plus messages pointing at it. `create_thread` sets `thread_id`
  on the ROOT message too (B0004:204-215). Root = the row where `m.id = t.root_message_id`;
  replies are the other messages with that `thread_id`, in the same channel.
- 696 messages carry a thread_id: 312 roots, 384 replies (real: 34 roots, 27 replies). Every
  root exists. `reply_count` is wrong on 4 threads: recompute.
- `also_send_to_channel` (58 rows, 4 real) maps to `also_in_channel`.
- DMs have no threads, only `reply_to_id` quote replies (4 rows): render as a quote line.
- seq is per channel and shared by replies; edits and deletes also bumped `last_seq`, so seq
  has gaps (22 of 46 channels). DM seq is per conversation, no gaps.
- `messages.topic` is unused (0 rows).

## 3. DMs

- Separate from channels: `conversations` (scoped to a WORKSPACE), `conversation_members`,
  `dm_messages`. All 78 are 1:1; no group DMs exist.
- Real orgs: 43 DMs, 183 messages; 15 have no messages.
- Because DMs were per workspace, 2 user pairs have two DMs in different workspaces of the same
  org. The new model has one DM per pair per org: MERGE them (renumber seq by created_at).
- Hearth Demo has 34 DMs with zero members: synthetic, skipped.

## 4. Attachments

- Bucket `attachments` (private): 73 objects, 117 MB. `avatars`, `public-assets`: empty.
- Object key `ws/{workspace_id}/{uuidv7}.{ext}`. The 11 `profiles.avatar_key` values also point
  into the `attachments` bucket.
- A message references files ONLY through its `attachments` jsonb array (no join table).
  Element keys: `object_key, thumb_key?, name, mime, size, width, height, duration_ms`
  (`js/core/media.js:177-180`). Join to the `attachments` row by unique `object_key`.
- Thumbnails (700px) are separate objects referenced only by `thumb_key` in the message json.
- Mime mix: 27 jpeg, 20 png, 4 mp4, 2 audio/webm (voice notes).
- Real orgs: 22 references to 22 distinct objects, all present (thumbnails included).

## 5. Read state

| column | meaning |
|---|---|
| scope_type, scope_id | one cursor per channel or thread (`dm` unused: DMs use `conversation_members.last_read_seq`) |
| last_read_seq | highest seq read; only moves forward |
| notify_level | inherit/all/mentions/nothing per channel (23 valid rows not inherit) |
| muted_until, notify_cursor_seq | unused |

No FKs: only 1,112 of 4,084 rows are valid (1,041 channel, 71 thread). Filter to existing
users, channels and threads.

## 6. Push subscriptions

135 subscriptions from 110 users, all in real orgs. FCM/Chrome Android 68, FCM/Windows 25,
Apple iOS Safari 12, WNS Edge 8, FCM macOS 6, Samsung 7, Linux 5, Firefox 2, macOS Safari 2.
They keep working only with the same VAPID key pair (dek-backend/.env.local VAPID_* matches
the live function secrets by sha256) and the same origin (dek-7o4.pages.dev).

## 7. Roles

- Platform: `platform_admins` 9 rows, global.
- Org: `org_role` admin/member. Real orgs: 7 admins, 320 members. No owner column.
- Workspace: permission bitmasks; ADMINISTRATOR (1<<40). `member_type` member/moderator/guest is
  a label only. Real: 42 moderators, 583 members, 0 guests. Workspace owner = `created_by`.
- Mapping: org admin -> admin; the org creator or Ubhay -> owner. Server role: holder of an
  ADMINISTRATOR role or creator -> admin; member_type moderator or a Moderator role (2007) ->
  moderator; otherwise member.

## 8. Real versus synthetic organizations

| Org | id | members | workspaces | channels | messages (ch+dm) | last message | verdict |
|---|---|---|---|---|---|---|---|
| Jarurat Care | 019f993c-604d-7129-af26-e406dd9da295 | 215 | 12 | 69 | 834+181 | 10-03 | REAL |
| Safalta Setu | 019f993c-6130-7f49-8406-bc9424bb0248 | 112 | 7 | 28 | 515+2 | 10-02 | REAL |
| Hearth Demo | 019f9528-d3cc-7fba-842e-02ae0be987e4 | 2 | 1 | 4 | 3,095+139 | 07-31 | synthetic |
| Misho Demo | 01a0330b-9cdd-7dd3-a9cd-ee4944158f40 | 3 | 1 | 4 | 21+4 | 09-22 | synthetic |
| Nashik Traders Co, test-org | | 1 | 1 | 3 | 0-1 | | synthetic |
| "Org Test" x9, "Org Test 2" x9, "Acme Corp" x8, "Private Team" x8, "testorg_*" x11 | | 0-5 | 1-2 | 1-4 | 0-4 | | test fixtures from dek-backend/tests |

Real workspaces with zero messages but real members: Jarurat Care: Tech (25), UI/UX (15),
Grants & Fundings (11), Carcinome (12, archived and scheduled for deletion); Safalta Setu:
Design (21), PM (17). Migrate them (members are real); Carcinome stays archived.

## 9. Users

391 auth users, all with profiles. 188 ever posted (180 in real orgs). 34 in no org (25 with
gmail or jarurat.care addresses). 1 app identity (`apps.invalid`). 390 of 391 have a password
hash; 43 have `must_set_password`. 364 ever signed in, 294 in the last 30 days. Every identity
is the `email` provider. Domains: gmail.com 327, hearth.test 33, jarurat.care 14, dek.app 7,
dek-backend.test 2, other 8.

## 10. Off-scope features referenced from message history

| Feature | link to a message | real orgs | migrate as |
|---|---|---|---|
| Polls | `polls.message_id`; body `{type:'poll',...}`, body_text = question | 0 | n/a |
| Events | body `{kind:'event_announcement',...}`, body_text "Event scheduled: ..." | 0 | n/a |
| Forms | `form_defs.message_id`; body_text = title | 3 forms, 1 live message | text "Form: title (form retired)" |
| Tasks | `tasks.message_id` on an ordinary message; quick tasks have body_text "Task: ..." | 12 on 12 messages (10 done) | keep the message text; export task rows to `docs/migration/archive/` for the Arc owner |
| Canvases, away days, apps, ack, forwards | no message link / unused | 1, 1, 0 | export rows, no message |

## 11. Message bodies

- `body_text` is canonical. Card messages (poll, event, form) carry typed keys in `body`.
- Markdown was rendered by markdown-it (`html:false, linkify:true, breaks:true`): real data has
  638 multiline, 270 bullet lists, 90 numbered lists, 22 `**bold**`, 213 `*emphasis*`, 88 URLs,
  0 code, 0 HTML. The new renderer must render these the same way (CommonMark style:
  `**bold**`, `*italic*`, lists, line breaks).
- Mentions are plain `@username` text (fallback `@Display Name`) with ids in `mention_user_ids`;
  `@here`/`@channel` set `mention_scope`. Convert to `<@uuid>` tokens by longest match against
  the mentioned users' username and display name, only for ids in `mention_user_ids`; leave
  unmatched text alone and keep the ids in `mentions`. Map `mention_scope` here/channel to
  `mention_all = true` and the tokens `<!here>` / `<!channel>`.
- Channel links are plain `#name` (0 in real data). Emoji are native Unicode.

## Hazards

- Copy only the two real orgs; the 3,095 author-less messages are all synthetic.
- No FKs on `read_state`, `member_roles`, `notification_overrides`, `threads.root_message_id`:
  filter orphans.
- Recompute counters (reply_count, last_seq, last_top_seq).
- Attachment json is the only message-to-file link; copy by `object_key` and `thumb_key`.
- Invite tokens are stored as sha256 only: migrate the HASH so old invite links keep working.
