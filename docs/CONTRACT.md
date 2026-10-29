# Dek API contract (v1)

This is the only interface between the client and the database. The database
implements exactly these functions in schema `api`; the client calls nothing else
(no table reads, no other schemas). Changing a signature means changing this file,
the function, the client wrapper in `apps/web/src/api/`, and the tests, together.

## 0. Conventions

- Call: `supabase.schema('api').rpc(name, args)`. Argument names are exactly as listed
  (all start with `p_`). Every function is `security definer`, `set search_path = ''`,
  granted to `authenticated` only unless marked `anon` or `service`.
- Ids are UUID strings. Times are ISO 8601 UTC strings (`timestamptz` serialised by
  PostgREST). `seq` is a per-channel bigint, serialised as a JSON number.
- Errors: `raise exception using errcode = 'P0001', message = '<code>', hint = '<text>'`.
  The client reads `error.message` as the machine code and `error.hint` as the human
  sentence. Codes:

| code | meaning |
|---|---|
| `auth_required` | no signed-in user |
| `not_found` | does not exist OR the caller may not know it exists (never leak existence across tenants) |
| `forbidden` | the caller can see it but may not do this |
| `invalid_input` | validation failed; hint says which field |
| `rate_limited` | too many calls; hint says when to retry |
| `conflict` | state changed underneath (already decided, already ended) |
| `archived` | channel or server is archived (read only) |
| `blocked` | a block between the two people prevents this |
| `suspended` | the caller's membership in this org is suspended |

- Limits: message body 1 to 8000 chars after trim (empty allowed only with attachments);
  names 1 to 80; topics 250; descriptions 1000; group DM at most 9 people in total;
  page size default 50, max 100; search max 50 per page.
- Mentions are encoded in message bodies as `<@USER_UUID>`; `<!channel>` and
  `<!here>` mention everyone in the channel (allowed for channel admins, server
  admins and moderators, org admins, and in channels with 50 or fewer members for
  anyone). Channel links are `<#CHANNEL_UUID>`. Everything else is plain text with a
  CommonMark-style subset rendered by the client, because that is what 1,300 real
  legacy messages use (lists, line breaks, `**bold**`, `*italic*`): `**bold**`,
  `*italic*` and `_italic_`, `~~strike~~`, `` `code` ``, fenced code blocks, `> quote`,
  `- ` and `1. ` lists, line breaks kept, bare URLs and `[label](https://...)` links
  (http, https and mailto only). No images, no HTML.
- Tags inside escaped text, inline/fenced code, or a complete Markdown link
  (label, destination or title) are literal and do not address anyone. Put an
  addressed person outside the link. Backtick fences and nested quotes/lists use
  the same depth-8 rendering boundary in the client and notification scanner.
- Presence is `Profile.last_active_at` (touched by normal calls, at most every 4
  minutes). The client shows "active" within 10 minutes. There is no Realtime Presence.

## 1. Shapes

```ts
type UUID = string; type ISO = string;

type Profile = {
  id: UUID; display_name: string; handle: string | null; avatar_path: string | null; // public bucket `avatars`
  title: string | null; timezone: string | null;
  status_text: string | null; status_emoji: string | null; status_until: ISO | null;
  last_active_at: ISO | null;
  deleted: boolean;
};

type OrgSummary = {
  id: UUID; slug: string; name: string; short_name: string | null;
  brand_color: string; logo_path: string | null;
  my_role: 'owner' | 'admin' | 'member' | 'guest';
  unread_channels: number; mention_count: number;
};

type OrgSettings = {
  edit_window_minutes: number | null;   // null = no limit
  allow_guests: boolean;
  member_can_create_channels: boolean;
  member_can_invite: boolean;
  default_invite_hours: number;
};

type Server = {
  id: UUID; org_id: UUID; name: string; description: string | null; icon_emoji: string | null;
  position: number; join_policy: 'open' | 'approval' | 'invite'; archived: boolean;
  requested?: boolean;   // caller's pending server request (0917); discovery grants no content access
  my_role: 'admin' | 'moderator' | 'member' | null;   // null = partial view through channel membership only
  member_count: number;
  access: 'member' | 'partial' | 'browse';  // 0900: member = joined; partial = shared channels only (DEK02); browse = can see, not joined
  permissions: Record<string, boolean>; //105: closed server capability keys, derived for this caller
  permission_version: number; //105: reload caller capabilities when this changes
  can_manage_permissions: boolean; //105: actual server Admin/org admin only
};

type Channel = {
  id: UUID; org_id: UUID; server_id: UUID | null;
  kind: 'text' | 'audio' | 'dm' | 'group_dm';
  name: string | null; topic: string | null; description: string | null;
  visibility: 'public' | 'private';
  posting_policy: 'everyone' | 'admins';
  allow_replies: boolean; allow_reactions: boolean; auto_join: boolean;
  archived: boolean; position: number; category: string | null;
  created_by: UUID | null; created_at: ISO;
  member: boolean; my_role: 'owner' | 'member' | null;
  notify: 'default' | 'all' | 'mentions' | 'none'; muted_until: ISO | null;
  last_seq: number; last_read_seq: number;
  unread: number;          // top-level, not mine, not deleted, after last_read_seq, capped at 100
  mentions: number;        // unread mentions of me (incl. <!channel>/<!here>), capped at 100
  last_message_at: ISO | null;
  member_count: number;
  dm_user_ids: UUID[] | null;   // dm / group_dm: the OTHER members
};

type Attachment = {
  id: UUID; file_name: string; mime_type: string; size_bytes: number;
  width: number | null; height: number | null; duration_ms: number | null;
  path: string; thumb_path: string | null; status: 'pending' | 'ready' | 'rejected';
};

type Message = {
  id: UUID; org_id: UUID; channel_id: UUID; seq: number;
  thread_root_id: UUID | null;
  author_id: UUID | null; kind: 'user' | 'system';
  body: string;                 // '' when deleted
  mentions: UUID[]; mention_all: boolean;
  client_id: UUID | null;
  created_at: ISO; edited_at: ISO | null; deleted_at: ISO | null; updated_at: ISO;
  reply_count: number; last_reply_at: ISO | null; reply_user_ids: UUID[];
  reactions: Record<string, UUID[]>;   // emoji -> user ids, insertion order
  attachments: Attachment[];
  pinned: boolean;
  also_in_channel: boolean;     // a thread reply also shown in the channel
  meta: Record<string, unknown>;      // system message details, legacy import marker
};

type Call = {
  id: UUID; org_id: UUID; channel_id: UUID; kind: 'direct' | 'room'; media: 'audio' | 'video';
  started_by: UUID; created_at: ISO; ended_at: ISO | null; end_reason: string | null;
  participants: { user_id: UUID; state: 'ringing' | 'joined' | 'left' | 'declined' | 'missed';
                  session_id: UUID | null; joined_at: ISO | null }[];
};

type Device = {
  id: UUID; kind: 'webpush' | 'fcm' | 'apns'; label: string | null; platform: string | null;
  created_at: ISO; last_seen_at: ISO | null; last_attempt_at: ISO | null;
  last_success_at: ISO | null; last_status: string | null; failure_count: number; enabled: boolean;
};

type NotificationPrefs = {
  default_level: 'all' | 'mentions' | 'none';     // channels, default 'mentions'
  dm_level: 'all' | 'none';                      // default 'all'
  thread_replies: boolean;                       // followed threads notify, default true
  quiet_start: string | null; quiet_end: string | null;  // 'HH:MM' local
  quiet_tz: string;                              // default 'Asia/Kolkata'
  preview: 'full' | 'name_only' | 'none';        // lock screen privacy, default 'full'
};
```

## 2. Functions

Server-scoped actions use the current #105 capability policy, replacing older coarse role labels in the original function rows. `edit_server` governs server editing/archiving; `add_people`, `remove_people` and `assign_roles` are separate membership actions; `create_channels`, `edit_channels` and `delete_channels` are separate channel actions. Server invite links and join decisions use `invite_people` and `decide_join_requests`. Deleting others' server messages and pinning use independent `delete_messages` and `pin_messages` grants. Mute, suspend, ban and safe server activity have their own grants below. Actual Admin alone edits the policy. Organization and DM permissions, private visibility, protected targets and announcement/joined-channel constraints remain separate.

Owner tags say which builder writes each function. Nobody edits a function they do
not own; ask the lead instead (this is how the Arc build lost three functions).
`[lead]` = `0000`-`0099` (foundation and shared mechanics in `0002`),
`[org]` = migrations 0100-0199, `[msg]` = 0200-0299, `[plat]` = 0300-0399,
`[media]` = 0400-0499 (sections 2.7 and 2.8 plus the `media-finalize` and `turn`
functions). Private helpers a builder needs only for itself live in schema `dek`
with the owner as prefix (`dek.org_*`, `dek.msg_*`, `dek.plat_*`, `dek.media_*`).
Shared helpers a builder must call (never re-create): everything in `0001` and
`dek.soft_delete_message`, `dek.revoke_channel_membership`,
`dek.revoke_server_membership`, `dek.revoke_org_membership` in `0002`.

### 2.1 Session and bootstrap  [msg]

| function | returns |
|---|---|
| `me()` | `{ user_id, email, profile: Profile, orgs: OrgSummary[], prefs: NotificationPrefs, is_platform_admin }` |
| `bootstrap(p_org)` | `{ org: OrgSummary & { settings: OrgSettings }, servers: Server[], channels: Channel[] /* joined channels + all my DMs (not hidden) + channels of partial servers */, profiles: Profile[] /* DM partners and server admins */, topics: string[] /* realtime topics to join */, server_time: ISO }` |
| `get_profiles(p_ids uuid[])` | `Profile[]` (only people sharing an org with the caller; max 200 ids) |

### 2.2 Messages  [msg]

| function | returns / notes |
|---|---|
| `send_message(p_channel, p_client_id, p_body, p_thread_root default null, p_attachment_ids uuid[] default '{}', p_also_in_channel boolean default false)` | `Message`. Idempotent on `(author, client_id)`: a retry returns the original. Needs post permission; replies need `allow_replies`; attachments must be `ready`, uploaded by the caller to this channel and unattached. Rate limit 30 per 10 s. |
| `edit_message(p_message, p_body)` | `Message`. Author only, inside the org's edit window. Mentions re-parsed; new mentions notify. |
| `delete_message(p_message, p_reason default null)` | `Message` (tombstone). Author, or a moderator of the channel's scope. A moderator delete writes `audit_log` with the original body (kept for review); a self delete purges the body. Attachments are marked deleted and their objects removed. |
| `toggle_reaction(p_message, p_emoji text, p_on boolean)` | `{ message_id, reactions }`. Max 20 distinct emoji per message, emoji text max 64 chars. Rate limit 60 per minute. |
| `list_messages(p_channel, p_before_seq bigint default null, p_limit int default 50)` | `{ messages: Message[] /* top level (and also_in_channel replies), ascending by seq */, has_more: boolean, last_seq: number }` |
| `list_messages_around(p_channel, p_seq bigint, p_limit int default 50)` | `{ messages, has_more_before, has_more_after, last_seq }` |
| `get_message_context(p_message)` | `{ channel: Channel, message: Message, thread_root: Message \| null }` or `not_found`. Used by deep links and search jumps. |
| `list_thread(p_root, p_after_seq bigint default 0, p_limit int default 100)` | `{ root: Message, replies: Message[] /* ascending */, has_more, following: boolean, last_read_reply_seq }` |
| `thread_window(p_root, p_target uuid default null, p_before_seq bigint default null, p_after_seq bigint default null, p_limit int default 50)` | `{ root, replies /* ascending, at most100 */, has_before, has_after, first_seq, last_seq, target_id, following, last_read_reply_seq }`. Default latest window. Choose one exact target or page direction; wrong-root/unreadable targets fail without fallback. |
| `sync_channel(p_channel, p_after_seq bigint, p_changed_since timestamptz, p_min_seq bigint default 0)` | `{ new: Message[] /* seq > after_seq, top level and replies, ascending, max 200 */, changed: Message[] /* updated_at > changed_since and min_seq <= seq <= after_seq, max 200 */, last_seq, truncated: boolean }`. When `truncated`, the client drops its cache for the channel and reloads the newest page. |
| `mark_read(p_channel, p_seq bigint)` | `{ channel_id, last_read_seq }`. Monotonic (never moves back). Broadcasts `read` to the caller's `u:` topic. |
| `mark_unread(p_channel, p_seq bigint)` | `{ channel_id, last_read_seq }`. Sets last_read_seq to p_seq - 1 (user chose "mark unread from here"). |
| `mark_all_read(p_org)` | `{ count }` |
| `follow_thread(p_root, p_follow boolean)` | `{ root_id, following }` |
| `mark_thread_read(p_root, p_seq bigint)` | `{ root_id, last_read_reply_seq }` |
| `list_threads(p_org, p_limit int default 30)` | `{ threads: { root: Message, channel: Channel, unread_replies: number, last_reply_at: ISO }[] }` followed threads, newest activity first |
| `list_mentions(p_org, p_before timestamptz default null, p_limit int default 30)` | `{ items: { message: Message, channel: Channel, read: boolean }[], has_more }` |
| `list_thread_inbox(p_org, p_cursor jsonb default null, p_unread_only boolean default false, p_limit int default 30)` | `{ items: { root: Message, channel: Channel, unread_replies, last_reply_at, activity_at: ISO, last_reply_seq }[], has_more, next_cursor }` |
| `list_mention_inbox(p_org, p_cursor jsonb default null, p_unread_only boolean default false, p_limit int default 30)` | `{ items: { message: Message, channel: Channel, read }[], has_more, next_cursor }` |
| `list_activity_inbox(p_org, p_kind text, p_view text default 'unread', p_cursor jsonb default null, p_limit int default 30)` | `p_kind = mention / thread`, `p_view = unread / all / cleared`. Mention/thread inbox shapes plus `activity: { revision, cleared, through_seq }`, `has_more`, v2 `next_cursor`. |
| `set_activity_state(p_kind text, p_target uuid, p_action text, p_expected_revision bigint, p_operation uuid, p_through_seq bigint default null)` | `p_action = read / clear / restore`. Returns canonical `{ revision, cleared, through_seq, read, operation_id }`. Derives scope and eligibility from target; actor is always authenticated caller. |
| `unread_feed(p_org, p_limit_per_channel int default 20)` | `{ channels: { channel: Channel, messages: Message[] }[] }` |
| `pin_message(p_message, p_pinned boolean)` | `{ message_id, pinned }`. Channel members; announcement channels: admins only. Max 100 pins per channel. |
| `list_pins(p_channel)` | `{ messages: Message[] }` newest pin first |
| `save_message(p_message, p_saved boolean)` | `{ message_id, saved }` |
| `list_saved(p_org, p_before timestamptz default null, p_limit int default 30)` | `{ items: { message: Message, channel: Channel, saved_at: ISO }[], has_more }` |
| `search(p_org, p_query text, p_channel uuid default null, p_author uuid default null, p_after timestamptz default null, p_before timestamptz default null, p_has text default null /* 'file' \| 'link' \| 'pin' */, p_limit int default 20, p_offset int default 0)` | `{ items: { message: Message, channel: Channel }[], has_more }`. Only channels the caller can read, only in `p_org`. Rate limit 30 per minute. |
| `search_files(p_org, p_query text default null, p_channel uuid default null, p_limit int default 30, p_offset int default 0)` | `{ items: { attachment: Attachment, message: Message, channel: Channel }[], has_more }` |
| `list_channel_files(p_channel, p_before timestamptz default null, p_limit int default 30)` | `{ items: { attachment: Attachment, message_id: UUID, author_id: UUID, created_at: ISO }[], has_more }` |

The additive inbox APIs cap pages at 100 and return an opaque JSON `next_cursor`
only when another page exists. Send it unchanged as `p_cursor`; it is bound to the
caller, organization, inbox, unread choice and descending activity/id order.
Malformed or mismatched cursors return `invalid_input`. Every call rechecks current
channel access; a cursor is pagination state, never an authorization token. Equal
timestamps use the message/root UUID tie-breaker. Activity can move between pages
when replies arrive; Refresh starts over. No snapshot-pagination guarantee.

Threads include followed readable roots, including deleted roots with surviving
replies. Unread ignores own and deleted replies and is capped at 100. The returned
`last_reply_seq` is the exact visible snapshot boundary for `mark_thread_read`;
the UI reloads the inbox after confirmation so later replies stay visible. Activity
mention Read now uses `set_activity_state('mention', message.id, 'read', ...)`:
only that mention becomes read, including a tagged thread reply. It advances no
channel or thread cursor. The explicit `mark_read` channel command remains a
read-through operation for older clients and conversation reading. Unjoined
public-channel mentions remain read, matching the existing contract. Released
`list_threads` and `list_mentions` signatures and behavior remain available.

Activity v2 cursors bind the caller, organization, singular kind, view and the
same descending activity/id order. Legacy v1 inbox cursors keep their released
meaning and signatures; their lists are active items. Filtering precedes each
bounded branch limit, with direct/broadcast overlap deduplicated by message ID.

Private `activity_states` stores exact mention read receipts separately from
clear state. Clear hides a personal item from active All/Unread, leaves read
projections and semantic channel/org unread badges unchanged, and never deletes
the message or changes follow, mute, quiet hours or push preferences. Cleared
items can be restored. A thread clear records the displayed reply boundary;
newer nondeleted replies make it active again. Thread Read reuses the exact
`mark_thread_read` boundary and never reads later replies or main-channel posts.

Commands use a desired action, a caller-generated operation UUID and the server
revision shown in the row. Retry a failed request with the same tuple. Replaying
the latest operation returns its receipt; an intervening action returns conflict.
Revisions come from a private nonreusing sequence, so stale Undo cannot overwrite
a later clear even after membership removal/rejoin. Undo applies only to Clear;
it restores visibility, not unread state. Membership removal/account deletion
forgets private receipts. No direct API-role table or sequence grants exist.

An exact mention Read suppresses an ordinary queued push only for that message.
Clear is never a delivery suppression rule. An edit newly addressing a person
retains the established targeted-intent read bypass. Native/grouped notification
tray removal remains context scoped; per-item Activity Read does not clear other
notifications merely because their messages share a channel or thread.

### 2.3 Organizations, servers, channels, membership  [org]

| function | returns / notes |
|---|---|
| `create_org(p_name, p_slug, p_short_name default null, p_brand_color default '#4F46E5')` | `OrgSummary`. Platform admins only. Caller becomes owner. |
| `update_org(p_org, p_patch jsonb)` | `OrgSummary & { settings }`. Keys: name, short_name, brand_color, logo_path, settings (partial). Org admins. |
| `list_org_members(p_org, p_query text default null, p_role text default null, p_limit int default 50, p_offset int default 0)` | `{ items: { profile: Profile, role, status, joined_at }[], total }` |
| `set_org_role(p_org, p_user, p_role)` | Org owner (owner/admin), admins (member/guest). The last owner cannot be demoted. |
| `suspend_org_member(p_org, p_user, p_suspended boolean, p_reason text default null)` | Suspended members lose all access in that org at once (every helper checks `status = 'active'`). |
| `remove_org_member(p_org, p_user, p_ban boolean default false, p_reason text default null)` | Deletes org, server and channel memberships in that org, disables their push routing for the org, broadcasts `access.revoked`, optional ban. |
| `leave_org(p_org)` | Same cleanup for the caller. The last owner cannot leave. |
| `list_servers(p_org)` | `Server[]` member and partial access plus every active server for ordinary org members to discover (including invite-only). Guests see only explicit channel access. No content or roster grant. Additive `requested` boolean is the caller's pending server request. |
| `create_server(p_org, p_name, p_description default null, p_join_policy default 'invite', p_icon_emoji default null)` | `Server`. Org admins (or members when `member_can_create_channels`). Creates `#general` and one public default audio lounge (auto_join). Room membership does not start a media call. |
| `update_server(p_server, p_patch jsonb)` | name, description, icon_emoji, join_policy, position. Server admins. |
| `archive_server(p_server, p_archived boolean)` | Server admins or org admins. Archived = read only. |
| `join_server(p_server)` | `{ status: 'joined' \| 'pending' }` for open (joined) or approval (pending request) servers |
| `leave_server(p_server)` | `dek.revoke_server_membership`: the server membership and every channel membership inside that server go. Broadcasts `access.revoked`. People who were only channel members of that server (cross-team) are removed per channel instead. |
| `list_server_members(p_server, p_query default null, p_limit default 50, p_offset default 0)` | `{ items: { profile, role, joined_at }[], total }` |
| `add_server_members(p_server, p_user_ids uuid[], p_role default 'member')` | Server admins. Users must be active org members. Auto-joins `auto_join` channels. |
| `remove_server_member(p_server, p_user)` | Server admins/moderators (moderators cannot remove admins). |
| `set_server_role(p_server, p_user, p_role)` | Server admins. |
| `list_channels(p_server, p_manage boolean default false)` | `Channel[]` public channels (joined or not) plus private channels the caller is in. `p_manage => true` (0906, server admins and org admins only, else `forbidden`): every channel of the server, private ones the caller is not in included, for Server settings. |
| `create_channel(p_server, p_name, p_kind default 'text', p_visibility default 'public', p_topic default null, p_description default null, p_posting_policy default 'everyone', p_member_ids uuid[] default '{}', p_auto_join default false, p_category default null)` | `Channel`. Server members (or admins only, per org setting). `p_member_ids` may include org members who are not server members (cross-team, DEK02). |
| `update_channel(p_channel, p_patch jsonb)` | name, topic, description, posting_policy, allow_replies, allow_reactions, auto_join, position, category, visibility (public to private only). Channel owner, server admins. |
| `archive_channel(p_channel, p_archived boolean)` | Channel owner, server admins. |
| `join_channel(p_channel)` | public channels of the caller's servers |
| `leave_channel(p_channel)` | |
| `add_channel_members(p_channel, p_user_ids uuid[])` | Channel members may add to public; private: channel owner or server admins. Users must be active org members (guests allowed). |
| `remove_channel_member(p_channel, p_user)` | Channel owner, server admins. |
| `list_channel_members(p_channel, p_query default null, p_limit default 100, p_offset default 0)` | `{ items: { profile, role, joined_at }[], total }` |
| `set_channel_notify(p_channel, p_level, p_muted_until timestamptz default null)` | `{ channel_id, notify, muted_until }` |
| `open_dm(p_org, p_user_ids uuid[])` | `Channel`. 1 other person = `dm` (one per pair per org), 2 to 8 = `group_dm` (one per exact set). All must be active org members; blocked pairs refused. Unhides. |
| `hide_dm(p_channel)` | Hides from the sidebar until the next message. |

#### 105 server-role policy

`get_server_role_permissions105(p_server)` is Admin-only and returns `{ server_id, version, actions: string[], can_manage: true, roles: { admin, moderator, member } }`. Each role contains `{ defaults, overrides, effective, locked }`; these maps have only the fifteen keys documented in `docs/SERVER-ROLE-POLICY.md`. Admin is full and locked. `set_server_role_permissions105(p_server, p_role, p_permissions jsonb, p_expected_version bigint default null, p_reset boolean default false)` changes only Moderator/Member boolean overrides; stale versions conflict. Reset requires an empty map. Empty or identical writes are no-ops. Writes audit actor/old/new maps and emit a `server.upd` version marker; clients reload their own rights. No caller-specific map is broadcast to other users.

Server adds `permissions`, `permission_version` and `can_manage_permissions`; partial access and guests receive no delegated server-wide powers. Native action endpoints and current clients consume this map. Ordinary org/DM permissions are unchanged.

### 2.4 Invites and join requests  [org]

| function | returns / notes |
|---|---|
| `create_invite(p_org, p_server default null, p_channel_ids uuid[] default '{}', p_role default 'member', p_email default null, p_expires_hours int default null, p_max_uses int default null, p_requires_approval boolean default false)` | `{ id, code, expires_at, url_path: '/invite/<code>' }`. Org admins; server admins for their server; members when `member_can_invite`. Code is 22 chars base62 from `gen_random_bytes`; stored with `code_sha256 = sha256(convert_to(code, 'UTF8'))`, and every lookup is by that hash (migrated legacy invites have only the hash, and their old links keep working). Expiry max 30 days. |
| `preview_invite(p_code)` [anon] | `{ valid: boolean, reason: null \| 'expired' \| 'revoked' \| 'used_up' \| 'not_found', org_name, org_brand_color, server_name, inviter_name, requires_approval }` |
| `accept_invite(p_code)` | `{ status: 'joined' \| 'pending' \| 'already_member', org_id, server_id }`. Banned users refused; targeted invites must match the caller's verified email. |
| `list_invites(p_org, p_server default null)` | `{ items: { id, code, server_id, role, email, created_by, created_at, expires_at, max_uses, use_count, revoked_at, requires_approval }[] }` org admins see all, others their own. With `p_server` (0908): every invite of that server, for its server admins. |
| `revoke_invite(p_invite)` | |
| `list_join_requests(p_org, p_status default 'pending')` | `{ items: { id, user: Profile, email, server_id, invite_id, note, status, created_at }[] }` |
| `decide_join_request(p_request, p_approve boolean)` | Approving adds the memberships the request targeted. |

### 2.5 Moderation and audit  [org]

| function | returns / notes |
|---|---|
| `report(p_kind 'message' \| 'user', p_org, p_message default null, p_user default null, p_reason, p_details default null)` | `{ id }`. Rate limit 20 per hour. Reasons: spam, harassment, inappropriate, other. |
| `list_reports(p_org, p_status default 'open', p_limit default 50, p_offset default 0)` | org admins: `{ items: { id, kind, reason, details, status, reporter: Profile, target_user: Profile \| null, message: Message \| null, channel: Channel \| null, created_at, resolved_by, resolved_at, resolution }[], total }` |
| `resolve_report(p_report, p_action 'dismiss' \| 'remove_message' \| 'suspend_user' \| 'remove_user', p_note default null)` | org admins; writes `audit_log` |
| `block_user(p_user, p_blocked boolean)` | Blocked person cannot open or post in a DM with the caller; their mentions do not notify the caller. |
| `list_blocks()` | `{ items: Profile[] }` |
| `list_audit(p_org, p_before timestamptz default null, p_limit default 50)` | org admins: `{ items: { id, actor: Profile \| null, action, target_type, target_id, details, created_at }[], has_more }` |

### 2.6 Profile, notifications, devices  [plat]

| function | returns / notes |
|---|---|
| `update_profile(p_patch jsonb)` | `Profile`. display_name, handle, title, timezone, avatar_path. |
| `set_status(p_text default null, p_emoji default null, p_until timestamptz default null)` | `Profile` |
| `get_notification_prefs()` | `NotificationPrefs` |
| `set_notification_prefs(p_patch jsonb)` | `NotificationPrefs` |
| `register_push_device(p_kind, p_endpoint, p_p256dh default null, p_auth default null, p_label default null, p_platform default null)` | `Device`. Upsert by `(kind, endpoint)`; an endpoint moving to another account is re-owned (logout then login as someone else). |
| `unregister_push_device(p_device default null, p_endpoint default null)` | `{ removed: number }`. Called at sign-out. |
| `list_my_devices()` | `Device[]` |
| `send_test_notification(p_device default null)` | `{ intent_id }` user initiated (DEK19); rate limit 5 per 10 minutes |
| `notification_health()` | `{ devices: Device[], recent: { created_at, status, reason, device_id, kind }[] /* last 20 deliveries */ }` |
| `request_account_deletion()` | `{ status: 'scheduled' }`. Leaves every org (last-owner orgs refused with `conflict`), anonymises the profile, removes devices. The `account-delete` function then deletes the auth user. |

### 2.7 Media  [media]

| function | returns / notes |
|---|---|
| `begin_upload(p_channel, p_file_name, p_mime, p_size bigint, p_with_thumb boolean default false)` | `{ attachment_id, bucket: 'media', path, thumb_path \| null, max_bytes, mime }`. Upload with exactly `mime` as Content-Type: the bucket enforces an allow-list (0900). Post permission required. Limit 100 MB video, 25 MB everything else. Allow-list: images (jpeg, png, gif, webp, heic), video (mp4, webm, quicktime), audio (mpeg, mp4, ogg, webm, wav, aac), pdf, plain text, csv, office documents, zip. Rate limit 60 per 10 minutes. |
| `abort_upload(p_attachment)` | `{ aborted: true }` |
| `svc_finalize_upload(p_attachment, p_ok boolean, p_mime text, p_size bigint, p_width int, p_height int, p_duration_ms int, p_reason text)` [service] | called by `media-finalize` only |

### 2.8 Calls  [media]

| function | returns / notes |
|---|---|
| `start_call(p_channel, p_media 'audio' \| 'video' default 'audio')` | `Call`. `dm`/`group_dm`: rings the others (`call.ring` on their `u:` topics plus a push). `audio` channel: joins the active room or opens it. One active call per channel. |
| `answer_call(p_call, p_session_id uuid)` | `Call` |
| `decline_call(p_call)` | `Call` |
| `join_room(p_channel, p_session_id uuid)` | `Call` (audio channels; cap 8 joined) |
| `leave_call(p_call)` | `Call`. The last person leaving ends it. |
| `call_heartbeat(p_call, p_session_id uuid)` | `{ ok: true }` every 30 s while joined; 90 s silence = left |
| `get_call(p_call)` | `Call` |
| `active_calls(p_org)` | `Call[]` rooms with people in them, calls ringing the caller, and calls the caller is still joined to |

Rate limits: `start_call` 30 per 10 minutes, `answer_call` and `join_room` 60 per minute, the `turn` function 30 per 10 minutes. `answer_call` re-attaches an already joined person (a new session after a reload); `leave_call` while ringing counts as a decline; a 1:1 call ends when either side leaves.

Group calls through the SFU (0914): a call opens with `sfu` stamped when `dek.settings` `sfu_enabled` is `true` or its organization's slug is listed in `sfu_orgs` (default: `dek-qa` only). It then runs through the Cloudflare Realtime SFU while it is a room, or a direct call with 3 or more participants; 1:1 calls are always direct. `Call` gains `version` (grows with every `call.upd`; keep the newest copy) and `sfu` (the current answer for this call); each participant gains `sfu_session` and `sfu_tracks` (`mic-N`, `cam-N`, `screen-N`). Limits: 120 SFU actions a minute and 20 new SFU sessions per 10 minutes per person.

### 2.9 Service functions  [plat] (granted to `service_role` only)

| function | used by |
|---|---|
| `svc_claim_intent(p_intent bigint)` | push-dispatch: locks the intent, returns `{ intent, deliveries: { user_id, device: Device & { endpoint, p256dh, auth }, title, body, url, tag, org_id, preview }[] }` with every routing rule already applied |
| `svc_record_deliveries(p_intent bigint, p_results jsonb)` | push-dispatch: `[{ user_id, device_id, status, reason, http_status }]`; expired devices revoked |
| `svc_complete_account_deletion(p_user uuid)` | account-delete |
| `svc_media_sign_check(p_user uuid, p_paths text[])` | media-sign: the subset of paths (max 100) the user may open (0900) |
| `svc_sfu_gate(p_user, p_call, p_session, p_action, p_wanted jsonb default null)` | sfu: `{ sfu_session, sfu_tracks, allowed }`; only a joined participant of an SFU call gets through (0914) |
| `svc_sfu_publish(p_user, p_call, p_session, p_sfu_session, p_add text[], p_remove text[], p_new_session boolean, p_epoch bigint)` | sfu: records the person's SFU session and tracks from Cloudflare's answers; returns `Call` (0914) |
| `svc_auth_code_issue(p_email, p_code_hash, p_request_hash, p_invite_code default null, p_ip default null)` | auth-code: `{ ok, mail }` (mail false: no account and no usable invite, a decoy row, nothing sent) or `{ ok: false, reason: invalid_email \| invalid_request \| too_soon (retry_after) \| too_many \| busy }` (0902, 0910) |
| `svc_auth_code_verify(p_email, p_code_hash, p_request_hash)` | auth-code: `{ ok, existing }` or `{ ok: false, reason: expired \| too_many_attempts \| wrong_code (attempts_left) }`; only the request token from send can try a code (0910) |
| `svc_auth_code_release(p_email, p_request_hash)` | auth-code: puts back a code consumed in the last 2 minutes when the session could not be created (0910) |

### 2.10 Lead additions (0905, 0907, 0915, 0916)

| function | returns / notes |
|---|---|
| `resolve_legacy_message(p_channel, p_legacy_seq bigint)` | `{ org_id, channel_id, message_id, thread_root_id \| null, deleted }` for an old `#/m/<channel>/<seq>` link (the old seq is in `meta.legacy.seq`). `not_found` when the message does not exist or the caller cannot read the channel. |
| `list_saved_ids(p_org)` | `UUID[]` the caller's saved message ids in that org, newest first, at most 2000. Kept current by `saved.upd`. |
| `delete_channel(p_channel, p_confirm_name text)` | `{ channel_id, deleted: true }`. Same people as `archive_channel` (owner, server admin, org admin); `p_confirm_name` must equal the channel name (case and outer spaces ignored) or `invalid_input`. Every member gets `access.revoked` (scope channel) first; messages, files and calls cascade; audited `channel.deleted`. 20 per hour (0915, Fixboard #16). |
| `browse_channels(p_org)` | `{ channels: BrowseChannel[] }`: every live text and audio channel of the servers the caller is a member of (not as a guest), public and private, plus channels the caller was added to elsewhere; max 1000. `BrowseChannel { id, server_id, name, kind, visibility, category, position, posting_policy, member, locked, topic, member_count, requested }`; `locked` = private and not a member, and then `topic` is null (0916, Fixboard #19). |
| `request_channel_join(p_channel, p_note text default null)` | `{ status: 'joined' \| 'pending', channel_id, request_id? }`. Public channel: joins. Private: one pending request per person (asking again returns it); `join.req` to `dek.channel_approvers` (channel owners and server admins, else org owners and admins) and a push (intent kind `request`). Server members only (`not_found` otherwise), 20 new requests per hour (0916). |
| `withdraw_channel_request(p_channel)` | `{ status: 'none', channel_id }`; idempotent (0916). |
| `list_channel_requests(p_org)` | `{ items: [{ id, note, created_at, user: Profile, channel: { id, name, kind, server_id, member_count } }] }` pending requests the caller may decide (org admins: all), newest 300 (0916). |
| `decide_channel_request(p_request, p_approve)` | `{ id, status, channel_id, user_id }`. Approvers only; approving adds the person (member.upd) and pushes them; `conflict` when already decided or withdrawn (0916). |

## 3. Realtime

Private channels only (`config: { private: true }`). Authorised by RLS on
`realtime.messages` through `dek.can_use_topic(topic, mode)`.

| topic | join (read) | client may send | server sends |
|---|---|---|---|
| `u:<user_id>` | that user | nothing | everything personal |
| `s:<server_id>` | server members (not guests) | presence only | public channel events |
| `t:<channel_id>` | can read channel | broadcast `typing`, presence | nothing |
| `call:<call_id>` | participants (ringing ones too), or room channel readers | broadcast `signal`: only participants whose state is `joined` (0900) | `call.upd` |

Server events (`event` name, then `payload`; every payload has `v: 1` and `eid`, the event id. One event reaches a client on several topics, so clients de-duplicate by `eid`; `payload.id` is never the event id):

| event | payload | topics |
|---|---|---|
| `msg.new` | `{ message: Message }` | `s:` for public channels, `u:` per member otherwise; also `u:` of non-server members of a public channel |
| `msg.upd` | `{ message: Message }` (edit, delete, reactions, reply counters, pin) | same as `msg.new` |
| `read` | `{ channel_id, last_read_seq }` / `{ root_id, last_read_reply_seq }` | caller's `u:` |
| `activity.upd` | `{ org_id, kind, target_id, revision }` | caller's `u:`; refresh personal inbox and confirmed counters, including background-org summaries |
| `chan.upd` | `{ channel: Channel (without per-user fields) }` created, updated, archived | `s:` or member `u:` |
| `member.upd` | `{ scope: 'org' \| 'server' \| 'channel', id, user_id, change: 'added' \| 'removed' \| 'role' }` | `u:` of the user, and `s:` for server scope |
| `access.revoked` | `{ scope: 'org' \| 'server' \| 'channel', id }` | that user's `u:` |
| `call.ring` | `{ call: Call, from: UUID }` | callee `u:` |
| `call.upd` | `{ call: Call }` | `call:<id>`, participants' `u:`, and for rooms the room channel's audience |
| `server.upd` | `{ server: Server }` renamed, archived, settings changed | `s:` and members' `u:` |
| `org.upd` | `{ org: OrgSummary }` name, brand color, settings | every active org member's `u:` |
| `chan.self` | `{ channel_id, notify, muted_until, hidden }` the caller's own channel settings changed on another device | caller's `u:` |
| `saved.upd` | `{ org_id, message_id, saved }` after every save or unsave (0907) | caller's `u:` |
| `join.req` | `{ org_id, channel_id, request_id, user_id, change: 'new' \| 'withdrawn' \| 'approved' \| 'rejected' }` a request to join a locked channel (0916) | approvers' `u:`, and the asker's `u:` for a decision |

Client broadcasts: `typing` `{ user_id, thread_root_id \| null }` on `t:` (max one per 3 s);
`signal` `{ from_session, to_session, kind: 'hello' \| 'offer' \| 'answer' \| 'ice' \| 'bye', data }`
on `call:` (`ice` carries an array of candidates; `hello` announces a session that just joined).
A callee joins `call:<id>` only after `answer_call` or `join_room` returns: realtime checks
the topic rule when a client joins, so a client that joined while ringing must rejoin to
send. Signals are matched to people by session id from the server's roster, never by a
client-supplied user id. Clients never trust message content from a client-sent event.

## 4. Storage

| bucket | public | path | read | write |
|---|---|---|---|---|
| `media` | no | `<org>/<channel>/<attachment>/<file name>`, thumbnail `<org>/<channel>/<attachment>/thumb.webp` | only through `media-sign` (15 minute links after `dek.can_read_object_as`). There is no storage select policy (0909): API roles cannot read or sign media directly. Upload quota per person: 20 unfinished reservations, 2 GB a day (0910, `rate_limited`). | insert only for a `pending` attachment the caller reserved, with an allowed Content-Type |
| `avatars` | yes | `<user>/<random>.webp` (`.jpg` from Safari) | public URL; API select only for the caller's own folder (0906, needed for delete) | the caller's own folder |

## 5. Edge functions

| function | auth | purpose |
|---|---|---|
| `push-dispatch` | header `x-dek-internal` (Vault secret) | deliver one intent (web push now; FCM and APNs adapters report `not_configured` until keys exist) |
| `media-finalize` | user JWT | sniff bytes, enforce type and size, mark ready or reject |
| `turn` | user JWT | ICE servers (Cloudflare TURN when configured, otherwise STUN plus `relay: false`) |
| `auth-email` | Supabase Auth Send Email Hook (signed) | deliver sign-in codes through the JCF Mailer transactional API |
| `account-delete` | user JWT | finish account deletion (auth user removal); 401 without a token, 409 for the last owner |
| `media-sign` | user JWT | `POST { paths }` (max 100) -> `{ urls: { [path]: url }, expires_at }`; paths the caller may not open are absent (0900, 0907) |
| `sfu` | user JWT | `POST { action: session \| push \| pull \| renegotiate \| close, call_id, session_id, ... }`: proxies the Cloudflare Realtime SFU for joined participants of an SFU call; holds RTC_APP_ID and RTC_APP_TOKEN (0914). An internal `revoke` (header `x-dek-internal`) stops the tracks of a session whose person left. |
| `auth-code` | none (sign-in) | `POST { action: 'send', email, invite_code? }` -> `{ ok, request }`; `POST { action: 'verify', email, code, request }` -> `{ session, new_user }`. Errors `{ error, message, retry_after?, attempts_left? }`. Dek's own email codes through the JCF Mailer (0902, 0903, 0910): 8 digits, 3 tries each, 5 codes an hour and 30 wrong tries a day per address, 10 minutes. The same 200 answer for addresses without an account (no enumeration; nothing is mailed). Codes go only to existing accounts or holders of an invite that accept_invite would honor; public sign-up is disabled, so verify creates an invited newcomer's account. Supabase Auth's own code emails are refused by auth-email. |

Every function allows the headers `authorization, apikey, content-type, x-client-info, x-dek-build, x-supabase-api-version` (the shared client sends `x-dek-build`). `media-finalize` refusals are 422 `{ status: 'rejected', reason, message }`; show `message`.


## 105 server member controls and activity

Server adds caller-only `moderation:{muted_until,muted,suspended,banned}`. Server member and policy events require reloading caller capability/control state. A suspension retains memberships but removes server content from bootstrap, Browse, unread/search/thread projections and native reads; restoration resumes retained access. Ban removes memberships and blocks invitations/grants until explicit unban. Unban does not restore old private-channel memberships. Mute retains read access but blocks posting, edits, reactions, pins, uploads and room participation until expiry or unmute. Separate management grants remain distinct. Safe own-message deletion remains available. Organization memberships, other servers and DMs are unchanged.

- `set_server_member_control105(p_server,p_user,p_action,p_until=null,p_reason=null)` accepts mute/unmute/suspend/restore/ban/unban. The current corresponding mute_members/suspend_members/ban_members permission is mandatory on every call. Only mute accepts an optional end time, in the future within28 days (default1 hour). Reason is optional, at most500 characters. Returns `{server_id,user_id,control,changed}`. Only actual server members or partial channel members, or existing recorded moderation targets, may be targeted. Self, organization administrators, server Admins and peers of delegated Moderators are protected. An already banned person must be unbanned before other controls are changed. No-op state writes return changed:false and do not duplicate audit/events.
- `list_server_member_controls105(p_server)` requires one of the three current moderation capabilities and returns `{items:[{profile,role,control,reason,updated_at}]}` for at most200 control rows in that server. No email or unrelated organization records are returned. This is how administrators restore suspended people and unban former members.
- `list_server_activity105(p_server,p_before=null,p_limit=50)` requires view_audit and returns `{items:[{id,actor,action,target_type,person,details,created_at}],has_more,next_before}`. Limit is clamped1..100; the optional id cursor is positive. New normal audit writes are projected to a private indexed server table beginning at installation. No historical backfill is claimed. Safe metadata is limited to role/policy changes and control flags; private message bodies, channel names/topics, reasons and organization-wide audit rows are omitted. Native `list_audit` remains organization-admin-only.

All new helpers and private tables are inaccessible directly to authenticated/anonymous clients after normal lockdown. Only the three authenticated API functions above are exposed. Existing delete_message and pin_message now independently use delete_messages and pin_messages for server moderation. Native guards and the standard access.revoked/member.upd/call state paths enforce controls; existing cached socket admission and already issued signed URLs retain their documented limits.

Pin permission is checked in addition to existing channel membership and announcement-channel constraints. A channel owner cannot bypass a disabled server-role permission. Native Storage write predicates also recheck current readable access and server moderation for a previously reserved upload.
