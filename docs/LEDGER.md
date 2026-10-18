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

## 2026-10-10: Fixboard #29, original picture quality

- Cause reproduced on production with synthetic 2400 x 1600 JPEG, PNG and WebP files.
  The former 400 KB threshold resized all three to 1600 x 1067; each downloaded
  SHA-256 differed from its source. The reporter's full report and its one attachment
  were read and inspected before the change.
- Code commit `200813c`: image preparation keeps original bytes, dimensions, name
  and format; only the separate 640 px preview is resized. Ready rows say
  "original quality". No migration or function deployment was needed.
- Deployed with `npm run deploy` to `https://2dd500c9.dek-7o4.pages.dev` and the
  production alias `https://dek-7o4.pages.dev`. Both confirmed version `155f4f307c22`
  (build `200813c-20261009T1831`). The service-worker version is content-derived.
- Validation: types passed; 641 web tests passed; the real-backend media test passed;
  all 6 live smoke tests passed (phone and desktop). Source and stored sizes for each
  device: JPEG 2,427,849 bytes, PNG 5,476,246 bytes, WebP 2,209,512 bytes. All six
  actual Download button results had identical SHA-256 to their source; the viewer
  loaded 2400 x 1600 originals and channel previews stayed at 640 px.
- Live health: 120 successful minute cron runs in the prior hour, no pending intents,
  upcoming Realtime partitions present. Synthetic messages were removed after testing.
- Privacy-checked phone proof: `E:/claude/jcf-fixboard/shots/29-uploads-phone.png`
  and `29-viewer-phone.png`; numbered steps in `29-howto.md`. No personal data was
  present in these synthetic artwork screenshots. Issue closed as Done differently:
  original quality is automatic, so an HD switch or document workaround is unnecessary.
- Limits: older compressed posts need the original file reattached; the existing
  25 MB file limit remains. HEIC/HEIF stay original and are downloadable where the
  browser cannot display them. A real Android handset was not used; phone verification
  ran Chromium with the Pixel 7 profile against production.

## 2026-10-12: Fixboard #29 follow-up across web and Android

- Live code `528bceb`, Pages `ce0e1295`, version `cf5f2d6e7068`; finalizer v7.
  JPEG EXIF display dimensions fixed; viewer shows size and Download text and
  signs previews for photos beyond the first four tiles. Originals stay untouched.
- 641 web tests, 4 focused checks, 13 parser tests, 7 independent range cases,
  12 live API checks and 6 production smoke cases passed. DB suite 264/265 first
  pass; unchanged timing case passed on one focused rerun, no threshold changes.
- All 12 actual desktop/390 px downloads matched source hashes, including a
  4579 x 4579 real photograph and EXIF portrait rotations. Previews stayed 640 px,
  overflow checks passed; screenshot and toolbar details were inspected.
- Old local Android APK still compressed. Fresh signed 2.0.1/code 2 APK and AAB
  built, packaged sources and same upload certificate verified, prior files backed
  up. Artifacts and report are in the chief-of-staff dispatch codex-dek folder.
- Real handset unavailable (`adb devices` empty); reporter's installed version and
  actual Chrome/app behavior remain unknown. Fixboard is In progress with proof
  update 99, not resolved. Runbook: incidents/2026-10-12-picture-quality-29.md.

## 2026-10-18: Fixboard #53, server directory and joining methods

- Fixed and deployed all-active server discovery for ordinary organization members,
  including invitation-only and empty servers. Metadata visibility grants no content,
  roster, invitation authority or additional Realtime access. Guest and tenant bounds
  remain. Pending requests persist after reload and refresh after UI approval.
- Settings use Invite links plus either Ask to join or Open, at most two methods,
  mapped to the existing enum. Existing policies and invitation approval rules remain.
- Migration 0917; code `a0f06ce`, final deployed/test HEAD `ab0212c`; deployment
  `c2426318`, build `ab0212c-20261017T2129`, live version `961b306265f5`.
- Full DB 268/268, web 650/650, focused DB 34/34, focused UI 19/19, live smoke 8/8.
  Independent review 0 critical/high/medium. All 12 original-image downloads retain
  exact source hashes. First DB run's transport outage and corrected review findings
  are retained in the evidence; no failed attempt is counted as a passing run.
- Board #53 Fixed with 4 inspected live QA screenshots and numbered usage steps.
  Phone proof is Chromium browser emulation, not a physical handset. All 8 temporary
  QA servers archived; 2 synthetic messages backed up then removed via API.
- No GitHub push/history rewrite; deployed rebuild and intern source-publication gap
  preserved. Existing 200-server list bound remains. Rollback preimages and release
  evidence: chief-of-staff dispatch/2026-10-17/fixboard-sweep/codex-dek/REPORT.md.
  Runbook: incidents/2026-10-18-server-directory-53.md.

## 2026-10-18: Conversation, tagging and Activity

- Final live responsive correction `cda0e42129630ef1940df5f3a22ab277e037b465`,
  build `cda0e42-20261018T1059`, version `5060292b655f`, Pages `5046751c`.
  Final artifact review caught a 39px Read width at 320px. CSS-only minimum width,
  nonshrinking buttons and wrapping rows fix it; independently reviewed and actual
  final live 320/390/430/390x420/1280 controls all measure at least 44x44, without
  overflow. Reachable 320px actions end at y544.4 within 640px; actual Read persisted
  with channel cursor unchanged. All 16 checked final public files match local bytes.
  Final cleanup totals are PROD 10 / TEST 8, zero live and 18 purged bodies; three
  servers archived, final devserver stopped. The two added layout fixtures were
  listed/backed up/author-deleted with own archive state restored. Final source
  manifest `2149861f2aed3223f4335b52af00cb0dbef78de2c343cf81bdfad7371189787e`
  differs from the first snapshot only in Activity CSS; TS/SQL and the 291/799
  passing behavior are unchanged, and final normal build/typecheck passed.
- Initial functional source `9c4164e1d3d857b688c8ce7724d84bac7df62eaa`, build
  `9c4164e-20261018T1038`, version `406065b17d51`, Pages `4971f478`.
  Normal production migrations 0920-0926 and `npm run deploy` completed.
  All 16 checked HTML/SW/manifest/version/runtime JS/CSS files match local SHA256
  on the unique deployment and public alias.
- Visible Start thread and reply summaries, dedicated narrow thread screen/composer,
  persistent parent/destination and explicit channel-post exit. Bounded exact reply
  windows, separate drafts and account/access fences. Stable tag IDs across duplicate
  people/channel names, selection, real reload, render and edit. Literal syntax and
  direct/broadcast/edit notification dedup agree between renderer and PostgreSQL.
- Shared authorized message actions via right-click, touch/pen hold, keyboard and
  buttons. Responsive real Activity cards support right Read / left Clear, explicit
  row actions, Undo and Cleared restoration. Exact mention/thread snapshot receipts,
  personal Clear, follow, mute and deletion stay separate; CAS/retries and private
  cache cleanup preserve current-device and other-client state.
- Final TEST 291/291, web 799/799, standalone typecheck clean. Independent frozen
  75-file review: zero Critical/High/Medium. Actual live two-person thread/tag/Activity
  flow persisted two replies under one new root and no accidental main duplicate.
  Actual 320/390/430/short 390x420/1280 layouts, 584-character resize draft, context
  menu/reaction/focus, per-item read/Clear/restore/partial and cross-client receipts.
  Synthetic 2000-row/reply plans measured; no performance threshold relaxed.
- Initial PROD 9 / TEST 7 messages listed/backed up then API-softdeleted, zero live and
  all 16 bodies purged; three servers archived. Owned test server stopped. Real
  staff/patient content, notification preferences, OS permissions and schedules untouched.
  No Git push or history publication. Existing fixed #53, original-media implementation,
  accepted first collaboration batch and older remote-source gap remain preserved.
- Browser evidence uses approved fine-pointer mouse/keyboard and viewport sizing.
  Touch/pen hold/swipe arbitration has regression coverage, not physical device proof.
  Physical software keyboard/native push/tray/200% zoom/reduced-motion emulation were
  unavailable. Existing #29 handset gate stays open. No complete vendor parity claim.
- Report, HOWTO, feature inventory, failed/corrected attempts, independent review,
  exact migrations/assets/cleanup and rollback function preimages:
  `C:/Users/abhay/.claude/chief-of-staff/dispatch/2026-10-18/dek-conversation-revamp/codex-dek/`.
  Prior web rollback is Pages `3f7d3ae1` / version `1a5142ea2848`; database corrections
  require a reviewed forward migration. Do not edit applied migrations or drop
  personal read/Clear state blindly.
