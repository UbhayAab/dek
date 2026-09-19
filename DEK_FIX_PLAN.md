# Dek fix plan - Ritika's two issues + rename + tests + push

Date: 2026-09-19. Product name from here on: **Dek**.
Client repo: `Desktop\claude\dek` (to become `dek`). Backend repo: `Desktop\claude\dek-backend` (to become `dek-backend`).
Live: client Cloudflare Pages project `dek` (`https://dek-7o4.pages.dev`), backend Supabase `ybddogqphinruyunnuwx`.
Rule that governs everything: **`git push` deploys nothing.** Client ships via `npm run deploy`, SQL via `node scripts/db-query.mjs -f <file>`.

## 0. Starting state (measured, not assumed)

- `dek` git: `main`, PUBLIC repo `UbhayAab/dek`, 7 uncommitted files (auth OTP rework: six-digit code copy, `CODE_SIGNIN=true`, forced-password order, `sw.js` `dek-v54`). Unrelated to Ritika's issues. Keep, commit separately.
- `dek-backend` git: on branch `org-console-add-people` (2 commits ahead of `master`: add-somebody UI in the vendored `web/` copy + onboarding docs). Default branch is `master`. PRIVATE repo `UbhayAab/dek-backend`. 3 untracked probe scripts.
- `dek-backend/web/js` is a second copy of the client. Fixes must land in `dek/js` (the deployed client) and be mirrored or deleted in `dek-backend/web/js` deliberately, never by accident.
- Migrations: dek-backend `0001-0076`, dek overlay `0100-0131`. Next dek-backend migration: `0077`.
- `DEPLOY.md:17` says the GitHub repo is private. It is PUBLIC (verified `gh repo view`). Fix the line.

## 1. Issue 1 - "Ask to join" never reaches the admin

### Root causes (all four verified in code)

1. **The button asks a question the server cannot answer.** `servers.js:row()` shows "Ask to join" for every `join_policy != 'open'`, but `request_join` (0037) throws `not_gated` unless `requires_approval = true`. Worse, `list_org_spaces` (0064) does not return `requires_approval`, so the client cannot know which locked servers take requests (comment admits it at `servers.js:257-262`). Measured live state: all three Jarurat Care servers are invite-only with approval OFF, so every tap fails and no row is ever written.
2. **Even when a row IS written, nobody is told.** Backend emits `ws:<id> join_request` (0037:178) but `workspace.js:subscribeWorkspace` has no `join_request` handler, `main.js:subscribeUser` has none, `countJoinRequests` (`api.js:232`) has zero callers, and the admin panel reads `joinreqs` through a cache (`admin.js:185`) that nothing invalidates.
3. **Silent empty list for some admins.** `list_join_requests` (0068) needs workspace KICK; an org-admin-not-in-server gets zero rows, not an error. `onboarding.js:247` reads the table directly with a different perm set (KICK or MANAGE_WORKSPACE). Inconsistent.
4. **`redeem_invite` bypasses approval entirely** while `onboarding.js:256-258` copy says invite-link arrivals wait for approval. Users get two different truths.

### Fixes (in order)

- [ ] F1.1 SQL `0077_list_spaces_gated.sql` (dek-backend): add `requires_approval boolean` to `list_org_spaces` return + select `w.requires_approval`. Backward compatible (new column at end). Apply to live BEFORE client deploy.
- [ ] F1.2 `dek/js/features/servers.js:row()`: use `s.requires_approval` - approval ON shows "Ask to join", approval OFF + locked shows "Invite only" label with no dead button. `explain()` copy stays. Keep org-admin "Join (admin)" + "Let everyone in" paths.
- [ ] F1.3 `dek/js/core/workspace.js:subscribeWorkspace`: add `join_request` handler - delete `joinreqs` cache for the workspace, `bus.emit('join-requests', {workspace})`, toast for anyone viewing admin/onboarding panels.
- [ ] F1.4 Pending-request badge: call `countJoinRequests` for the current workspace on `workspace`/`join-requests` events and on admin panel open; show the count on the admin nav ("Waiting to join - N"). Mirror the count into `onboarding.js:requestsSection` refresh.
- [ ] F1.5 Perm consistency: make `onboarding.js` use `api.listJoinRequests` (one perm path) instead of a direct table read; document that org-admins must be workspace members or hold KICK to see requests.
- [ ] F1.6 Copy fix in `onboarding.js:256-258`: invite-link redeem admits immediately (no approval queue); only "Ask to join" queues. Say exactly that.
- [ ] F1.7 Regression tests: dek-backend vitest - `list_org_spaces` returns `requires_approval`; `request_join` on non-gated throws `not_gated`; gated request appears in `list_join_requests` for a KICK holder; approve adds membership. Client: `node scripts/check-syntax.mjs` + a DOM-free unit check of the row-state function if extractable, else probe script.
- [ ] F1.8 Mirror F1.2-F1.4 into `dek-backend/web/js` OR record the decision to delete the vendored copy. No silent drift.

## 2. Issue 2 - private channel invite link; add direct admin-add

### Root causes (verified)

1. **There is no private-channel link to fix.** All invite mint/redeem RPCs are workspace-scoped (`create_invite(p_workspace...)`, `redeem_invite` inserts `workspace_members` only, never `channel_members`). A workspace link gets an outsider through the front door; `can_view_channel` still hides private channels. Any "private channel link" the admin shared was a workspace link that could never grant the channel.
2. **The working path exists but is single-add and hard to find.** `add_channel_member(p_channel, p_user)` RPC (0004, still current) + `uxfix.js:addPeopleToCurrentChannel` picker. Limits: searches only loaded `store.profiles` (max 30), one RPC per tap, `MANAGE_CHANNELS` only, rejects non-workspace-members with `not_a_member`, nothing at channel-create time.
3. **Two misleading copies.** `servers.js:openToEveryone` and `orgadmin.js` both say "private channels stay private" - true, but nowhere does the UI say a workspace invite does not grant a private channel.

### Fixes (Ritika's ask: admin directly adds specific server members, no link)

- [ ] F2.1 Keep `add_channel_member` as the primitive. No new invite-token RPC (rejected alternative: a channel-scoped token reintroduces the link confusion and needs a second grant path to audit).
- [ ] F2.2 Upgrade `addPeopleToCurrentChannel` (`uxfix.js:1361`): search full workspace membership (not just loaded profiles), multi-select with checkboxes, one "Add N people" button firing N RPCs with per-row state, friendly `not_a_member` message ("X is not in this server yet - invite them to the server first"), `Added`/`Already in` row states kept.
- [ ] F2.3 Add-at-create: `createChannelDialog` (`channels.js:474`) gets an optional member picker for private channels (same multi-select), adding chosen members right after create. Private channel no longer born with exactly one member.
- [ ] F2.4 Copy: invite dialog + members-panel empty state say "A server invite does not open private channels - a coordinator adds you to each one." One line, in both places.
- [ ] F2.5 Tests: `add_channel_member` by MANAGE_CHANNELS holder succeeds; non-member target gets `not_a_member`; non-privileged caller gets `forbidden`; duplicate is idempotent. Client syntax + probe run.
- [ ] F2.6 Mirror into `dek-backend/web/js` per F1.8 decision.

## 3. Rename: dek/dek/dek-backend to Dek (user-visible), frozen technical IDs

156 files contain a match. Blind replace would break live systems and touch secrets, so three tiers:

- Tier A - rename: UI strings, titles, comments, READMEs, `*.md` docs, `package.json` name/description (NOT repo URLs until after `gh repo rename`), `index.html` title, CSS identifiers only if user-visible, `DEPLOY.md:17` visibility line, folder names (`dek` -> `dek`, `dek-backend` -> `dek-backend`), `PROJECTS.md`, this plan's follow-ups.
- Tier B - frozen (never rename): Supabase project ref `ybddogqphinruyunnuwx`, Cloudflare Pages project `dek`, DB function/table names, `sb_publishable_*` key, migration contents that already applied (only new migrations carry new names), Wrangler state in `.wrangler/`.
- Tier C - excluded from replace: `onboarding/credentials-*.csv`, `onboarding/resets.csv`, any `*.pem`/`*.key`, `node_modules/`, `.git/`, `package-lock.json`, `shots/` binaries, `E:\github-archive-*`.
- [ ] R1 Count + list per tier before touching anything.
- [ ] R2 GitHub repo renames via `gh repo rename` (`dek` -> `dek`, `dek-backend` -> `dek-backend`): keeps redirects, then update `package.json` repository/homepage/bugs URLs + remotes (`git remote set-url`).
- [ ] R3 File-content pass Tier A only, then `grep -ri "dek|dek|dek-backend"` must return Tier B/C only. Review the diff file by file.
- [ ] R4 Folder renames last (after commit+push, so nothing is mid-flight): `Desktop\claude\dek` -> `Desktop\claude\dek`, `dek-backend` -> `dek-backend`; update `PROJECTS.md` paths; keep no stale junctions.
- [ ] R5 Re-run `npm test` in both repos after rename; redeploy NOT needed for rename-only docs changes, but `sw.js VERSION` bump rides with the functional fixes anyway.

## 4. Test like crazy

- [ ] T1 `npm test` in `dek` (syntax, encoding, shell audit). Must be green.
- [ ] T2 `npx vitest run` in `dek-backend` (needs `VITE_SUPABASE_URL`, publishable key, `SUPABASE_SECRET_KEY` from `Desktop\CREDENTIALS.md` index - read index first, values never in chat). Note: hits LIVE project, creates test orgs/users, GoTrue rate-limits on full runs. Run targeted files first (`manage-servers`, new `0077` test), then full suite once.
- [ ] T3 `npm run probe` in `dek` (Playwright, minutes). At least the auth + servers + channels probes.
- [ ] T4 Manual realtime check with two sessions: B asks to join gated server, A sees toast + badge + row within seconds, approves, B lands in. Private channel: admin adds 3 members at create + 2 later; outsider with server link still cannot see the channel.
- [ ] T5 Rename gate: case-insensitive grep for `dek|dek|dek-backend` excluding Tier B/C returns nothing.
- [ ] T6 `git status` clean, no `.env`/keys staged (`git diff --cached --name-only` inspected), no AI byline in messages.

## 5. Push (github, as ubhayvatsaanand@gmail.com)

Git identity already `Ubhay <ubhayvatsaanand@gmail.com>` in both repos. Keep it; never add AI trailers.

- [ ] P1 Commit `dek` uncommitted OTP work FIRST as its own commit (do not mix with Dek fixes).
- [ ] P2 Commit Dek fixes (F1+F2) + tests. Bump `sw.js VERSION dek-v54` -> `dek-v55` in the same commit (js changed).
- [ ] P3 Commit rename (R2 content, not folders) separately so it is revertable.
- [ ] P4 `dek-backend`: merge or rebase `org-console-add-people` onto `master` deliberately (it touches the vendored web copy - decide mirror-vs-delete first), commit `0077` + tests, push branch + `master`.
- [ ] P5 `git push` both, verify on GitHub (file list + commit SHAs). Then SQL-first + `npm run deploy` for the client ONLY when Ubhay confirms - push deploys nothing and the team reads the live site.
- [ ] P6 Update `PROJECTS.md` (A7 paths/state) + append `LOG.md`. Report in Did/Why/Failure points/What we failed at/Needs you.

## 6. Explicitly NOT doing

- No channel-scoped invite-token RPC. No auto-adding private-channel members on workspace-invite redeem (would silently expose private rooms). No `redeem_invite` approval gate (would strand existing link flows). No Supabase/Cloudflare project renames. No touching `CREDENTIALS.md` values. No sending mail to the team (needs Ubhay's one-line flag per SES rule; the "tell the team" message is his to send).
