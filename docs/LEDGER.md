# Requirement ledger (PRD: Dek_Claude_Code_PRD.md)

Status as of 2026-10-04, before the production cutover. **Done** = built and proven by the
named evidence. **Partial** = built, with a stated gap. **Owner** = blocked on an action only
Ubhay or the organization can take. Test counts: backend `npm run test:db` 241/241, web unit
548/548, Playwright suites under `apps/web/e2e` (ui 97, admin 29, media 10, platform 22,
smoke 2 on the deployed preview).

## Product (DEK)

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| DEK01 | Tenant hierarchy org, server, channel; deliberate switching | Done | 0001, 0100-0102; org switcher in the shell; `org-*.test.mjs` |
| DEK02 | Cross-team channels without server-wide access | Done | `Server.access` partial; DEKA04 Playwright (carol sees only #grants); 0900 |
| DEK03 | Text channels and audio rooms; privacy, topic, owner, archive, posting policy | Done | 0102; ServerSettings and ChannelSettings screens |
| DEK04 | Switcher, servers, channels, DMs, unread, mentions, search, back; one layer on phones | Done | `features/shell`, `features/views`, `features/search`; screenshots at 390 and 1280 |
| DEK05 | Invites, approvals, add, remove, archive; revoked invites stop; leaving removes access | Done | 0110, 0002 revoke helpers; DEKA06 in `org-*.test.mjs`; admin Playwright |
| DEK06 | Durable messages, client request id, pending vs confirmed | Done | `allocate_seq`, `client_id` idempotency; DEKA03 Playwright (exactly one row) |
| DEK07 | Reconnect from the last cursor | Done | `sync_channel`; reconnect 500 in docs/LOAD.md (0 lost) |
| DEK08 | Bounded pages; reply links and anchors kept after migration | Done | pages of 50; `resolve_legacy_message` (0905); docs/migration/LEGACY-URLS.md |
| DEK09 | Composer: formatting, safe links, attachments, mentions, drafts, progress, status | Done | `features/conversation`, `ui/markdown` (77 tests incl. XSS) |
| DEK10 | Media: direct authorized upload, real type and size checks, scanning policy, thumbnails | Partial | byte sniffing, allow-list, executable refusal (`media-finalize`, DEKA11). No antivirus engine on this stack: policy is block by type and bytes |
| DEK11 | Access checked on every path; private links expire | Done | `media-sign` 15 minute links, 0909 (no direct reads), DEKA05 tests |
| DEK12 | Presence and typing transient and throttled | Done | `last_active_at` throttled, typing broadcast only, presence disabled in Realtime |
| DEK13 | Report, block, remove, admin review, audit | Done | 0120; admin Reports and Audit screens |
| DEK14 | Notification levels, mute, thread follows, quiet hours, preview privacy, per device | Done | 0300, 0310; settings Notifications screen |
| DEK15 | Web push done properly | Done | manifest, `sw.js`, permission from a user action, `push-dispatch` (VAPID) |
| DEK16 | iPhone Home Screen flow, no false success | Done | DEKA08 component and e2e tests |
| DEK17 | Commit, intent, route, recheck, send | Done | `notification_intents` outbox, `plat_route_message`, `push-dispatch` |
| DEK18 | Deep links to org, channel, thread, message; safe unavailable state | Done | `app/router.ts` (22 router tests), legacy redirects, smoke on preview |
| DEK19 | Notification health screen and test notification | Done | `features/notifications/Health.tsx` |
| DEK20 | Native push on Android and iOS | Owner | adapters in `push-dispatch` (fcm.ts, apns.ts) and the native hand-off are built; needs a Firebase project and an APNs key |
| DEK21 | Direct voice and video calls, audio rooms, all states | Done | `features/calls`; calls Playwright (4) |
| DEK22 | WebRTC signaling, TURN validated, SFU for multiparty | Partial | Cloudflare TURN proven with a relay-only call; rooms are mesh, capped at 8 (decision D18); no SFU yet |
| DEK23 | Room capacity, reconnection, no duplicate participants | Done | DEKA13 Playwright (leave, rejoin, second device) |
| DEK24 | Mic and camera only when needed; no recording | Done | calls module; denial leaves chat usable |
| DEK25 | Incident evidence | Done | docs/incidents/2026-09-30-outage-forensics.md |
| DEK26 | Hypotheses tested | Done | same document |
| DEK27 | Reversible recovery first | Done | legacy 0139, reindex, bounded cron; 20:00 arrival held (LOG 2026-10-03) |
| DEK28 | Lean replacement architecture | Done | docs/ARCHITECTURE.md; docs/LOAD.md |
| DEK29 | Migration with reconciliation | Done (staging) | docs/migration/RECONCILIATION.md 71/71; final pass at cutover (docs/CUTOVER.md) |
| DEK30 | Remove tasks, tickets, KPI, HR, timesheets | Done | docs/REMOVALS.md; archive in `dek-legacy-archive`; no such API in schema `api` |
| DEK31 | No Arc dependency for login, chat, calls | Done | no Arc calls anywhere |
| DEK32 | Arc outage cannot lock anyone out | Done | follows from DEK31; suspension and removal are Dek's own |

## Acceptance (DEKA)

| ID | Status | Evidence |
|---|---|---|
| DEKA01 60 sign-ins | Done | docs/LOAD.md |
| DEKA02 300 sustained, 500 reconnect | Done | docs/LOAD.md (0 lost of 3,482 and of 112) |
| DEKA03 send while the connection drops | Done | platform and UI Playwright (one durable row) |
| DEKA04 cross-team contributor | Done | UI Playwright |
| DEKA05 guessed ids from the other org | Done | `media-live`, foundation and org tests; `media-sign` gives the other tenant nothing |
| DEKA06 leaving a server | Done | org tests (access, subscriptions, search, notifications) |
| DEKA07 phone push tap opens the message | Partial | web push and tag routing tested in a browser; real phone needs Firebase (DEK20) |
| DEKA08 iPhone tab without push | Done | component and e2e tests |
| DEKA09 permission denied | Done | platform tests (no prompt loop) |
| DEKA10 two tabs and a phone | Done | platform Playwright: one socket, read reconciles in about 1.6 s |
| DEKA11 failed upload keeps the draft | Done | media Playwright |
| DEKA12 restrictive network call | Partial | relay-only call proven; a physical Jio or Airtel test is still due |
| DEKA13 eight-person room loses one | Done | media Playwright (three people) and server tests |
| DEKA14 Arc or LLM down | Done | no dependency |
| DEKA15 old planning URL | Done | legacy routes for removed features open home |
| DEKA16 migration reconciled | Done (staging) | final reconciliation at cutover step 3a |

## Operations (OPS)

| ID | Status | Evidence |
|---|---|---|
| OPS01 paid org verified | Done | org `qmlenovxatoyxxqlvzlo` (Pro); docs/COSTS.md |
| OPS02 transfer before copying | Done | claim-transfer API used for the moved projects; Dek got a clean project because its schema was rebuilt (DECISIONS) |
| OPS03 transfer vs migration | Done | DECISIONS, docs/migration/PLAN-RUN.md |
| OPS04 isolation | Done | one project per product; Dek data only in private schema `dek` |
| OPS05 logging quality | Done | functions log codes and counts, never bodies, emails or tokens |
| OPS06 one owner per job | Done | Supabase (data, auth, realtime, functions), Pages (web), Mailer (mail) |
| OPS07 storage ownership | Done | `dek.attachments` with sha256 and owner; bytes in Storage |
| OPS08 credentials | Done | `.env.local` only, `tools/lib/env.mjs`; HS256 legacy secret revoked |
| OPS09 repository discipline | Done | branch `rebuild`, commits recorded in LOG |
| OPS10 one owner per fact | Done | Dek owns chat only |
| OPS11 event envelope | Partial | realtime events carry `v` and `eid`; Dek emits no cross-service events yet, so no full envelope |
| OPS12 durable effects | Done | notification outbox, sweeper cron |
| OPS13 failure independence | Done | mail down: password sign-in still works; push down: chat works |
| OPS14 permission enforcement | Done | every read and write in `api` functions, Storage and Realtime policies; security review |
| OPS15 cost scenarios | Done | docs/COSTS.md |
| OPS16 compare alternatives | Done | docs/COSTS.md (RDS comparison) |
| OPS17 backup realism | Done | COSTS: Pro daily backups give a 24 hour RPO; the 1 hour target needs PITR (USD 100 a month), not bought |
| OPS18 monitoring | Partial | health checks in docs/OPERATIONS.md, notification health per device; no alerting dashboard yet |
| OPS19 security checks | Done | security reviews 2026-10-04, tests above |
| OPS20 release gates | In progress | docs/CUTOVER.md |

## Native apps (APP)

| ID | Status | Evidence |
|---|---|---|
| APP01 client architecture | Done | Capacitor 8 shell over the web app; docs/NATIVE.md |
| APP02 shared backend | Done | same `api` schema |
| APP03 native quality | Partial | secure session, logout, deep links, back, keyboard proven on an API 36 emulator; push, camera and calls untested on devices |
| APP04 Play account | Owner | D-U-N-S number and organization account |
| APP05 app entry | Owner | docs/store/listing.md drafted |
| APP06 build and sign | Done | signed release AAB; upload key in `E:\secrets\dek` |
| APP07 target API 36 | Done | targetSdk 36 |
| APP08 declarations | Partial | docs/store/privacy-declarations.md drafted; filing needs the account |
| APP09 internal and closed testing | Owner | needs the account and named testers |
| APP10 submit | Owner | after APP09 |
| APP11 Apple enrollment | Owner | Apple Developer Program or fee waiver |
| APP12 build environment | Owner | a Mac with Xcode 26 |
| APP13 toolchain | Owner | same |
| APP14 App Store Connect | Owner | after APP11 |
| APP15 TestFlight | Owner | after APP14 |
| APP16 review readiness | Done | review accounts `qa-review@` and `qa-review-delete@` in a separate Review Team (seed-qa) |
| APP17 submit | Owner | after APP15 |
