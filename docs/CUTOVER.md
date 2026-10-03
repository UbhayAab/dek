# Cutover: legacy Dek to the rebuilt Dek (PRD DEK29, OPS20)

Same URL (`https://dek-7o4.pages.dev`), new backend (`nxljuctnauhgzekvmftp`), new client.
Done at a quiet hour (05:00 to 06:00 IST), never near the 20:00 arrival.

**Deadline: before 2026-10-07 04:20 UTC (09:50 IST).** The legacy retention cron hard-deletes
the archived Carcinome server then; every migration pass after that would copy the deletion.

## Gates before starting (all must be true, evidence linked in docs/LEDGER.md)

1. Database tests green: `npm run test:db`.
2. Web types, unit tests and the end-to-end suites green: `npm run typecheck`, `npm run test:web`,
   the Playwright suites under `apps/web/e2e`.
3. Load test passed on the new project (docs/LOAD.md): 60 concurrent sign-ins, 300 sustained,
   500 reconnect burst, no lost accepted message; synthetic load data wiped afterwards.
   Passed 2026-10-04 01:24 to 02:33 IST, load world wiped.
4. Staging migration reconciled (docs/migration/RECONCILIATION.md) and a delta re-run changed
   nothing.
5. The production build has been exercised on a Pages preview URL
   (`npx wrangler pages deploy apps/web/dist --project-name dek --branch rebuild`) by the QA
   accounts.
6. Security review findings at CRITICAL and HIGH are fixed and re-verified.

## Steps

| # | Step | Command | Proof |
|---|---|---|---|
| 1 | Snapshot legacy function grants, then make the legacy API refuse every call from browsers (old tabs stop writing to the old database; reloads land on the new app) | `node tools/cutover/legacy-freeze.mjs --freeze` | the script prints the saved grant count and a test call answering 401/403 |
| 2a | Read the exact deltas of the final pass without writing | `node tools/migrate-legacy/index.mjs --apply --dry-run` | counts per table; nothing unexpected (only what legacy users wrote since staging) |
| 2b | Final migration pass (everything written since staging, latest sessions and refresh tokens so nobody has to sign in again) | `node tools/migrate-legacy/index.mjs --apply` | run row in `dek_migration.runs` |
| 3a | Reconcile | `node tools/migrate-legacy/index.mjs --verify` | docs/migration/RECONCILIATION.md, zero unexplained differences |
| 3b | Re-apply lead data decisions a pass may not carry (platform admin, Ubhay's main account as Jarurat Care owner, 60-day cap on old invites) | `node tools/db.mjs sql "$(cat tools/cutover/post-migration.sql)"` | prints `platform_admins 1`, `ubhay_jcf_role owner`, `long_invites 0` |
| 4 | Turn on push for migrated devices (lead only) | `node tools/migrate-legacy/index.mjs --enable-push --confirm-cutover` | count of enabled devices |
| 5 | Deploy the new client to production | `npm run deploy` | live check prints the new build id |
| 6 | Smoke as QA users on production; one real account (Ubhay's) signs in and sees his channels | Playwright `e2e/smoke.prod.spec.ts` | screenshots |
| 7 | Sessions pass 10 minutes later: refresh tokens that legacy rotated after step 2b (old tabs still open) become known here, so those people are not signed out | `node tools/migrate-legacy/index.mjs --apply --sessions-only` | run row shows the delta |
| 8 | Freeze migrations in the new project (from now on every change is a new file) | `node tools/db.mjs sql "insert into dek.settings values ('migrations_frozen','true') on conflict (key) do update set value = 'true'"` | |
| 9 | Watch the first 20:00 arrival | health checks in docs/OPERATIONS.md, realtime peak connections | numbers in LOG |

A full `--apply` after step 5 refuses, because migrated people now use the new app and a
full pass would overwrite what they changed. Only `--sessions-only` runs after go-live.

## Rollback (any time before step 9 is signed off)

1. `node tools/cutover/legacy-freeze.mjs --unfreeze` (restores every saved grant exactly).
2. Deploy the legacy client: in `../dek-legacy` run `npm run deploy`.
3. Messages written in the new app during the window are listed by
   `node tools/db.mjs sql "select ... where created_at > '<cutover time>'"` and posted back by
   hand if needed; there is no automatic reverse copy.

## After

- Day 1: delete the unused legacy Cloudflare worker `dek-realtime`.
- Day 1: move the legacy project `ybddogqphinruyunnuwx` (hearth) back out of the paid
  organization with the claim-transfer API, so it stops counting against paid compute.
- Day 30: export a final logical copy of the legacy project to `E:\backups\dek-legacy\`, then
  let it pause (free projects pause after a week idle; restorable for 90 days).
