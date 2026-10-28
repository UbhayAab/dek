# Rules for every builder on the Dek rebuild

You are one of several agents building Dek at the same time in the same working tree
(`C:\Users\abhay\Desktop\claude\dek`, branch `rebuild`) against the same Supabase
project. These rules are what keep you from breaking each other. They are not
optional.

## Read first

1. `docs/ARCHITECTURE.md` (the design) and `docs/CONTRACT.md` (the exact API, with an
   owner tag on every function).
2. The PRD: `C:\Users\abhay\Desktop\NGO_Claude_Code_PRD_Pack\NGO_Claude_Code_PRD_Pack\Dek_Claude_Code_PRD.md`
   (sections for your scope; the requirement ids DEKnn and DEKAnn are what you prove).
3. `supabase/migrations/0001_foundation.sql` and `0002_shared_mechanics.sql`: the
   tables and the helpers you must use. Do not re-implement an access check.
4. `docs/legacy-reuse/LESSONS.md` (client builders) and `docs/migration/LEGACY-MAP.md`
   (migration builder).

## Ownership

- You own ONLY the functions, files and directories named in your brief. Never edit,
  re-create or `create or replace` anything else. Two builders replacing one function
  silently erased each other in another project; a function has exactly one owner.
- Need a change in a file you do not own (foundation, contract, someone else's
  function, a shared client module)? Do not make it. Write it in your final report
  under "Requests for the lead" with the exact change and why. Work around it
  meanwhile if you can.
- Database migrations: only your range (see CONTRACT section 2). One file per
  coherent area, named `NNNN_snake_case.sql`. While building, iterate with
  `node tools/db.mjs dev supabase/migrations/<your file>.sql` (re-applies your file;
  serialized with other builders by an advisory lock). Every object in your file must
  be re-runnable: `create or replace function`, `drop function if exists` before a
  signature change, `create index if not exists`, `insert ... on conflict`.
- Never run `node tools/db.mjs migrate` while other builders are iterating unless
  your brief says so, never touch `dek_meta`, never edit `0000`-`0099`.

## SQL rules (every api function)

- `language plpgsql` (or sql), `security definer`, `set search_path = ''`, every name
  schema-qualified (`dek.messages`, `pg_catalog.now()` is fine as `now()`).
- First statement: `v_uid := dek.require_uid();` (except `preview_invite` and `svc_*`).
- Access through the foundation helpers only: `dek.require_org`, `dek.require_org_admin`,
  `dek.assert_read`, `dek.assert_post`, `dek.can_read_channel`, `dek.can_moderate_channel`,
  `dek.is_server_admin`, `dek.is_server_mod`, `dek.server_role`, `dek.org_role`,
  `dek.shares_org`, `dek.is_platform_admin`.
- Errors only through `perform dek.err('<code>', '<human sentence>')` with the codes in
  CONTRACT section 0. Strangers and other tenants get `not_found`, never `forbidden`
  (existence must not leak across organizations).
- Return shapes exactly as CONTRACT section 1, built with `dek.message_json`,
  `dek.channel_json(c, uid)`, `dek.server_json(s, uid)`, `dek.profile_json`,
  `dek.org_summary_json(o, uid)`, `dek.attachment_json`, `dek.call_json`. If a shape
  needs a field the builder does not provide, request it; do not hand-roll a variant.
- Every state change other people can see emits the CONTRACT section 3 event through
  `dek.emit_channel`, `dek.emit_user`, `dek.emit_users` or `dek.emit_many`, inside the
  same transaction.
- Admin and moderation actions write `dek.audit(...)`.
- Rate limits with `dek.rate_hit(uid, '<key>', limit, window_seconds)` as the CONTRACT says.
- Call `dek.touch_active(v_uid)` in calls that mean "this person is using Dek now"
  (bootstrap, send, mark_read); never more than that.
- Performance is a requirement: the `authenticated` role has an 8 s statement timeout
  and 400 people arrive at 20:00. Every query uses an index, every list has a LIMIT,
  no per-row function call over an unbounded set, no `count(*)` without a bound. Target
  under 50 ms per call on realistic data. No new cron job unless your brief asks for
  one, and any cron job must start with an indexed existence probe and set a
  statement_timeout shorter than its interval.
- No `security invoker` api functions, no grants in your files (`dek_meta.lockdown()`
  sets every grant after each migration: authenticated for api, service_role for
  `svc_*`, anon for `preview_invite` only).

## Tests

- `supabase/tests/<area>-*.test.mjs` with `node:test`, using `tx`, `expectError`,
  `db.fixture()`, `db.call(uid, fn, args)`, `db.safe(...)` from `_harness.mjs`. Every
  test runs in a rolled-back transaction against the real project.
- For every function: the happy path, the denial for a stranger, the other tenant
  (`f.eve`), a guest, a suspended member, and a plain member where admin rights are
  needed; idempotency where the contract promises it; limits; the realtime events it
  must emit (inspect `realtime.messages` inside the transaction).
- Run your own files while iterating: `node --test --test-concurrency=1 "supabase/tests/<area>-*.test.mjs"`.
  At the end, your files must all pass. Do not edit other builders' tests.

## Client rules (web builders)

- TypeScript, React, the scaffold in `apps/web`. Call only `apps/web/src/api` wrappers
  (one per CONTRACT function). Never query a table, never use another schema.
- Keep to your directories. Shared modules (`src/api`, `src/store`, `src/realtime`,
  `src/ui/kit`, `src/app`) belong to the lead unless your brief gives them to you.
- Every primary action renders loading, empty, validation, denied, success, retryable
  failure and terminal failure states (PRD "Interface and completion requirements").
  No success message before the server confirmed. Drafts survive failures.
- Accessible by default: real buttons and labels, focus visible, keyboard paths,
  44 px touch targets, contrast 4.5:1 for text, `dir="auto"` on user text.
- Mobile first: 390 x 844 is the reference phone; one layer at a time on phones.

## Everything

- NEVER write an em dash or an en dash anywhere: code, comments, SQL, UI copy, docs,
  test names, commit text. Plain hyphen only. Restructure the sentence if needed.
- Never print or commit a secret. Credentials are read through `tools/lib/env.mjs` from
  `.env.local` (gitignored). Never put a key in client code except the publishable key.
- Do not commit and do not run git commands that change the index or the working
  tree (`add`, `commit`, `stash`, `checkout`, `reset`, `clean`, `restore`). The lead
  commits. `git diff` and `git status` are fine.
- Do not install new npm packages without listing them in your report; prefer what
  the scaffold already has.
- Silent tests: no sound, no visible windows; headless browsers only.
- The ECC GateGuard hook refuses the FIRST Write or Edit of every file in a session.
  Send a one-line stub first, then the real content, so a large payload is not sent
  twice. The first Bash command of a session is refused the same way: state the facts
  it asks for and retry.
- Your final message is your deliverable: what you built (functions or components with
  file paths), test results with counts, contract deviations (should be none), requests
  for the lead, known limitations. Under 800 words.
