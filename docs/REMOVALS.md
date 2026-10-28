# What was removed from Dek, and where it went (PRD DEK30)

Authority: the Dek PRD of 2026-10-03 ("Remove task planning, tickets, KPI panels,
scoreboards, HR decisions, and standalone timesheets from active routes and APIs ...
Marketplace apps, task boards, HR forms, complex workflow builders, public communities, and
project planning are excluded unless later approved") and Ubhay's words the same day: "delete
everything extra ... if it doesn't match the final vision, it's wrong."

Nothing below exists in the rebuilt app: no route, no screen, no API function, no table, no
cron job, no edge function. The legacy code is preserved at tag `legacy-final` of `dek` and
`dek-backend` (reference checkout `../dek-legacy`), and the legacy database stays untouched
until the retention window after cutover ends. Off-scope records that held real data were
exported, not migrated: `C:\Users\abhay\Desktop\claude\dek-legacy\_archive_2026-10-03\`
(outside the public repo because it holds personal data).

| Legacy feature | Legacy footprint | Real data (two real orgs) | Disposition | Replacement |
|---|---|---|---|---|
| Tasks and the Later board (Mine, Team, Up for grabs; 8 task states, nags, reviewer, blocker notes, quick tasks, task progress) | `tasks`, `saved_items.state`, `create_task_in_channel`, `nag-tasks` cron, `js/features/tasks.js`, `later.js`, `quicktask.js`, `taskprogress.js` | 12 tasks on 12 messages | Removed. Task rows exported for the Arc owner; the messages they hung off are migrated as ordinary messages | Arc owns project work (PRD "What each product owns") |
| Leave and away days (apply, decide, balance, who is away, leave team) | `away_days`, `leave_policies`, `apply_leave` etc. (0129 to 0131), `sync-leave-statuses` cron, `leave.js` | 1 away day | Removed and exported | Arc owns leave; Dek may later show approved availability only if D07 says so |
| App platform (create_app, install_app, app tokens, app_post_message, app_create_task) | `apps`, `app_installs`, `app_tokens`, `private.app_secrets`, `dek-app` function, `apps.js` | 1 test app ("Probe Dispatch", 2026-09-02) | Removed | None. Arc's Dek connection was saved disabled; a future Arc bridge is decision D07 |
| Forms and org form templates | `form_defs`, `form_submissions`, `form_templates`, `forms.js` | 3 forms, 1 linked message, 0 submissions | Removed; the linked message becomes text "Form: <title> (forms were retired)" | None |
| Polls | `polls`, `poll_votes`, `polls.js` | 0 | Removed | None |
| Events and RSVPs | `events`, `event_rsvps`, `events.js` | 0 | Removed | None |
| Canvases (documents in channels) | `canvases`, `canvas_blocks`, `canvases.js` | 1 canvas | Removed and exported | Pinned messages and saved messages |
| Forums and forum tags | `forum_posts`, `forum_tags`, `forum.js` | 0 | Removed; forum channels became ordinary text channels | Threads |
| Ack-required messages and escalation | `message_acks`, `message_ack_targets`, `escalate-acks` cron, `ackloop.js` | 8 targets | Removed | Mentions and the notification pipeline |
| Message labels, priorities, topics (Zulip-style) | `message_labels`, `messages.priority`, `messages.topic`, `topic_read_state`, `labels.js`, `topics.js` | 0 | Removed | Threads, pins |
| Snippets, bookmarks, channel guides | `snippets`, `channel_bookmarks`, `channel_guides`, `snippets.js`, `bookmarks.js`, `orientation.js` | 0 | Removed | Channel topic and description, pins |
| Scheduled messages and reminders | `scheduled_messages`, `reminders`, `dispatch_scheduled`, `fire_reminders` | 1 scheduled message | Removed (decision recorded: not in the PRD's messaging scope) | None |
| Custom roles and permission bitmasks, reaction roles, self roles, channel overwrites | `roles`, `member_roles`, `reaction_roles`, `self_roles`, `channel_overwrites`, `policy_*` tables, `roles.js` | 196 roles (mostly the default set) | Replaced by a fixed, auditable model: org owner/admin/member/guest, server admin/moderator/member, channel owner | `dek.can_read_channel` and friends in `0001_foundation.sql` |
| Bots, incoming webhooks, slash commands | `bots`, `incoming_webhooks`, `slash_commands`, `integrations.js` | 0 | Removed | None (marketplace apps are excluded by the PRD) |
| Jira and handoff integrations, Google Sheets links | `soop-jira`, `soop-handoff` functions, `sheets.js`, `sheeturl.js` | n/a | Removed | None |
| Embed SDK (Dek inside other dashboards) | `embed.js`, `embed-demo.html`, `0100_embed_registry.sql` | n/a | Removed | None |
| Digests and the channel viewer counter | `run_digest_monitor`, `channel_viewers`, `reap-channel-viewers` and `fanout-tick` crons | n/a | Removed (it caused 5 million sequential scans of channels) | Unread counts computed on demand, capped |
| Activity report, forecast, version nag | `activityReport.js`, `forecast.js`, `version.js` | n/a | Removed | Notification health screen, service worker update banner |
| Nicknames you give other people | `user_nicknames` | 7 | Removed and exported | Display names |
| Server-side drafts | `drafts` | 24 | Removed (drafts are per device now) | Client drafts in local storage |
| The password latch pre-request hook | `enforce_password_latch` on every request (6.4% of all database time) | 43 latched accounts | Removed | An optional "set a password" step after a code sign-in |
| Cloudflare Durable Object realtime transport | `realtime/` worker `dek-realtime` (never cut over) | n/a | Removed from the tree; the deployed worker is deleted at cutover | Supabase Realtime private broadcast on the paid plan |
| 15 pg_cron jobs | drain every 15 s, fanout, tick, nag, escalate, statuses, digests | n/a | Removed | Two jobs: intent sweeper (probe first) and daily prune, each bounded below its interval |

## Kept, because the PRD requires them

Channels, DMs, group DMs, threads, mentions, reactions, edit and delete, read state, search,
pins, saved messages, media, calls and audio rooms, notifications (in app, web push, native
push), moderation (reports, blocks, removal, audit), presence and typing as transient
signals, invites and membership lifecycle, organizations and team servers.
