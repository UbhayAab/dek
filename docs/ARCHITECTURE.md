# Dek architecture (rebuild of 2026-10-03)

Owner: Ubhay. Authority: `Desktop/NGO_Claude_Code_PRD_Pack/.../Dek_Claude_Code_PRD.md` (v1.0, 2026-10-03).
This file records the design that the code implements. `docs/CONTRACT.md` is the exact API.
`docs/LEDGER.md` maps every PRD requirement to code and evidence.

## 1. What changed and why

The legacy Dek (tag `legacy-final` on `dek` and `dek-backend`) was a Discord and Slack
super-set: 127 tables (forums, polls, canvases, events, forms, bots, slash commands,
webhooks, reaction roles, tasks, leave, an app platform, an embed SDK), about 1 MB of
hand-rolled JavaScript with patch layers (`uxfix.js`, `polish.css`, `reskin.css`),
140 migrations split across two repositories, and 15 pg_cron jobs. On 2026-09-30 at
20:00 IST, 387 people opened it at once and it stopped loading for everyone: cron jobs
scheduled faster than they could run held the 60 connections of a free nano instance
(`docs/incidents/2026-09-30-outage-forensics.md`).

The PRD authorises a complete rebuild of Dek as a communication product only. Removed
from Dek by that brief: task planning, tickets, the Later board, KPI panels,
scoreboards, HR decisions, leave, timesheets, marketplace apps, forms, workflow
builders, public communities. The full removal record is `docs/REMOVALS.md`.

## 2. Topology

```
 Browser / installed PWA / Capacitor app (Android, iOS)
        |  HTTPS (static)                 |  HTTPS RPC + WSS realtime
        v                                 v
 Cloudflare Pages "dek"            Supabase project "dek" (nxljuctnauhgzekvmftp)
 dek-7o4.pages.dev                 org "UbhayAab's Org" (Pro), ap-south-1, Micro
  - hashed assets, immutable        - Postgres 17: schema `dek` (tables, private)
  - index.html, sw.js no-cache        schema `api` (the only exposed surface)
  - _headers: CSP, HSTS             - Auth (GoTrue): email+password, email code
                                    - Realtime: private broadcast + presence
                                    - Storage: private bucket `media`
                                    - Edge Functions: push-dispatch, media-finalize,
                                      turn, auth-email, account-delete
                                       |                 |                  |
                                       v                 v                  v
                               Web Push services   JCF Mailer (SES)   Cloudflare TURN
                               (FCM, APNs native)  OTP mail only      (calls relay)
```

One owner per job: Cloudflare serves bytes; Supabase holds data, auth, realtime,
files and server code; the mailer only delivers sign-in codes; TURN only relays call
media when a direct path fails. Arc is not on any path (PRD DEK31, DEK32).

## 3. Data model

Hierarchy is organization, team server, channel (DEK01). JCF and Safalta Setu are
separate `dek.orgs` rows. Every row that belongs to a tenant carries `org_id`, and
every API function checks it.

| table | purpose |
|---|---|
| `orgs`, `org_members` | tenant and membership (`owner`, `admin`, `member`, `guest`; `active`, `suspended`) |
| `servers`, `server_members` | team servers inside an org (`admin`, `moderator`, `member`) |
| `channels`, `channel_state`, `channel_members` | text and audio channels, 1:1 DMs, group DMs; hot counters live in `channel_state` |
| `messages` | every message, channel or DM, top level or thread reply, one per-channel `seq` |
| `reactions`, `mentions`, `thread_follows`, `pins`, `saved_messages` | message satellites |
| `thread_reads`, `activity_states` | caller-private thread read floors, exact mention receipts and reversible Activity clearing; independent of follow/mute/channel reads |
| `attachments` | file metadata; bytes live in Storage bucket `media` |
| `invites`, `invite_uses`, `join_requests`, `org_bans` | membership lifecycle |
| `reports`, `user_blocks`, `audit_log` | moderation and accountability |
| `notification_prefs`, `push_devices`, `notification_intents`, `notification_deliveries` | notifications pipeline |
| `calls`, `call_participants` | direct calls and audio rooms |
| `profiles`, `platform_admins`, `rate_buckets` | identity and guard rails |

Access rule, implemented once in `dek.can_read_channel(uid, channel)`:

- the caller is an `active` member of the channel's org, and
- the caller is in `channel_members` for that channel, or the channel is `public`,
  in a server the caller is a member of, and the caller is not a `guest`.

So a cross-team contributor added to one private channel (Grants) sees that channel
and nothing else in the host server (DEK02, DEKA04). Posting additionally needs an
unarchived channel, the channel's posting policy (announcement channels are admin
only), and no block between DM members.

## 4. API surface

PostgREST exposes exactly one schema, `api`. Tables live in `dek`, which is not
exposed, so there is no table API to forget a policy on. Every `api` function is
`security definer`, `set search_path = ''`, starts with `dek.require_uid()` and one
of the audited access helpers, and is granted to `authenticated` only (never
`public`, never `anon` unless listed in the contract). RLS is enabled with no
policies on every `dek` table as a second wall. A generated test calls every `api`
function as a stranger and as a member of the other org and expects a denial
(DEKA05).

## 5. Messages: durable, ordered, idempotent (DEK06 to DEK08)

1. The client makes a `client_id` (UUID), shows the message as `pending`, and keeps
   it in an IndexedDB outbox, so a reload or a dropped connection cannot lose it.
2. `api.send_message` inserts under a row lock on `channel_state` (an UPDATE, which
   takes FOR NO KEY UPDATE and so does not fight foreign-key share locks), assigns
   the next per-channel `seq`, writes mentions, thread counters and one
   `notification_intents` row, and broadcasts, all in one transaction.
3. A retry with the same `client_id` returns the same row (unique
   `(author_id, client_id)`), so a reconnect cannot duplicate (DEKA03).
4. The client marks it `accepted` only when the RPC returns. `failed` keeps the text
   and offers retry; `retrying` backs off 1, 2, 4, 8, 16, 30 s.
5. On reconnect the client calls `api.sync_channel(channel, after_seq, changed_since)`
   for open channels and `api.bootstrap` for counters. Nothing reloads whole histories
   (DEK07). History pages are 50 messages (DEK08).

## 6. Realtime

Supabase Realtime, private channels, authorised by RLS on `realtime.messages`
through `dek.can_use_topic(topic, mode)`. One WebSocket per browser: tabs elect a
leader with the Web Locks API and relay events over `BroadcastChannel`, so two tabs
and a phone are two sockets, not three (DEK07, DEKA10).

| topic | who joins | carries |
|---|---|---|
| `u:<user>` | that user | DM and private channel events, read sync, membership changes, call ringing |
| `s:<server>` | server members | public channel events of that server, presence |
| `t:<channel>` | anyone who can read the channel, while viewing it | typing (client to client) |
| `call:<call>` | call participants | WebRTC signaling, call presence |

The database broadcasts with `realtime.send` inside the writing transaction, so a
rolled-back write never announces itself. Public channel events go once to `s:`;
private channel and DM events fan out per member to `u:`. Measured median membership
is one server and six channels per person, so a client holds 2 to 4 topics.

Revocation: removing someone deletes the membership rows (every RPC, file URL mint
and search stops at once), sends `access.revoked` to `u:<user>`, and the client drops
the topic and purges cached content. Realtime re-checks policy on join and on token
refresh; a hostile client that ignores the event keeps an already-open server topic
until its access token expires (30 minutes). That bound is documented, not hidden.

Presence and typing never touch the database (DEK12). Presence is Realtime Presence
on `s:` topics with a 60 s idle state; typing is a broadcast on `t:` throttled to one
event per 3 s per person.

## 7. Notifications (DEK14 to DEK20)

```
send_message ──(same txn)──> notification_intents (one row)
                    AFTER INSERT trigger: net.http_post (queued, sent after commit)
                                              v
                                   Edge Function push-dispatch
   recipients = channel members minus author, minus blocked, minus revoked
   per recipient: prefs (all / mentions / none, DM rule, thread follow), channel mute,
   quiet hours, preview privacy  ->  devices (webpush, fcm, apns)
   send, record notification_deliveries, drop 404/410 subscriptions
```

A one-minute sweeper re-dispatches anything still pending after 30 s; its first
statement is an indexed existence probe, so an idle minute costs one index lookup.
The service worker suppresses the OS notification when a focused window already
shows that conversation (DEK17), uses one tag per conversation so devices replace
rather than stack, and deep-links the tap to org, channel, thread and message
(DEK18). The VAPID key pair is the one the legacy app used, so existing browser
subscriptions keep working across the move.

## 8. Files (DEK10, DEK11)

`api.begin_upload` authorises and reserves `media/<org>/<channel>/<attachment>/<name>`.
The browser uploads straight to Storage (insert policy: only a pending attachment
row the caller owns), then `media-finalize` reads the first bytes, checks the real
type against the allow-list and the size limit, and marks it `ready` or deletes it.
Downloads and thumbnails use signed URLs (15 minutes) minted only by the `media-sign`
function after `dek.can_read_object_as` (0900); the bucket has no select policy at all
(0909), so nobody can mint a link of their own choosing. Each uploader may hold at most
20 unfinished reservations and 2 GB a day (0910). Bytes never sit in a table row and
never go through Realtime. Malware scanning is not available on this stack; the
policy blocks executable and script types and is recorded as a limitation.

Image uploads preserve the original bytes, dimensions and format (Fixboard #29).
Only the separate channel preview is resized to 640 px; the photo viewer and
Download use the original object. The composer confirms "original quality" when
the upload is ready. Browsers unable to display a format still offer Download.
The 25 MB image/file limit applies to the original file before processing.

## 9. Calls (DEK21 to DEK24)

WebRTC with signaling on `call:<id>`. Direct voice and video calls are peer to peer;
audio rooms are a mesh capped at 8 (the PRD's first validation size). ICE servers
come from the `turn` function (Cloudflare TURN when its key is configured, STUN
otherwise, with the status visible in the call screen). Supabase carries signaling
only, never media. Group video and rooms above 8 need an SFU and are a later
decision (D18).

## 10. Failure independence

| failure | what still works |
|---|---|
| Push provider or mailer down | messaging, unread, calls; pushes retry, sign-in falls back to password |
| TURN not configured or down | calls on open networks, chat everywhere; call screen says relay unavailable |
| Realtime socket drops | sends still go over HTTPS; pending sends retry; reconnect syncs by cursor |
| Arc down | everything (no dependency) |
| LLM anything | not used by Dek |

## 11. Operations

- Deploy web: `npm run deploy` (build, test, Pages deploy, live check). `git push`
  deploys nothing.
- Database: `npm run db:migrate` applies `supabase/migrations` in order and records
  checksums in `dek_meta.migrations`; an applied file may never change.
- Functions: `npm run fn:deploy <name>`.
- Backups: Pro daily backups (7 days) plus a weekly logical dump (RPO 1 day). The
  PRD's proposed 1 hour RPO needs PITR (USD 100 a month), recorded in `docs/COSTS.md`.
- Cron: exactly three jobs, each bounded by a statement timeout shorter than its
  interval (the invariant that the 2026-09-30 outage taught).
