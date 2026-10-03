# Cutover: legacy Dek to the rebuilt Dek (PRD DEK29, OPS20)

Same URL (`https://dek-7o4.pages.dev`), new backend (`nxljuctnauhgzekvmftp`), new client.
Done at a quiet hour (05:00 to 06:00 IST), never near the 20:00 arrival.

## Gates before starting (all must be true, evidence linked in docs/LEDGER.md)

1. Database tests green: `npm run test:db`.
2. Web types, unit tests and the end-to-end suite green: `npm run typecheck`, `npm run test:web`,
   the Playwright suites under `apps/web/e2e`.
3. Load test passed on the new project (docs/LOAD.md): 60 concurrent sign-ins, 300 sustained,
   500 reconnect burst, no lost accepted message; synthetic load data wiped afterwards.
4. Staging migration reconciled (docs/migration/RECONCILIATION.md) and a delta re-run changed
   nothing.
5. The production build has been exercised on a Pages preview URL
   (`npx wrangler pages deploy apps/web/dist --project-name dek --branch rebuild`) by the QA
   accounts.

## Steps

| # | Step | Command | Proof |
|---|---|---|---|
| 1 | Snapshot legacy function grants, then make the legacy API refuse every call from browsers (old tabs stop writing to the old database; reloads land on the new app) | `node tools/cutover/legacy-freeze.mjs --freeze` | the script prints the saved grant count and a test call answering 401/403 |
| 2 | Final migration pass (picks up everything written since staging, latest sessions and refresh tokens so nobody has to sign in again) | `node tools/migrate-legacy/index.mjs --apply` | run row in `dek_migration.runs` |
| 3 | Reconcile | `node tools/migrate-legacy/index.mjs --verify` | docs/migration/RECONCILIATION.md, zero unexplained differences |
| 4 | Turn on push for migrated devices | `node tools/migrate-legacy/index.mjs --enable-push` | count of enabled devices |
| 5 | Deploy the new client to production | `npm run deploy` | live check prints the new build id |
| 6 | Smoke as QA users on production; one real account (Ubhay's) signs in and sees his channels | Playwright `e2e/smoke.prod.spec.ts` | screenshots |
| 7 | Second migration pass 10 minutes later (stragglers) | step 2 again | run row shows the delta |
| 8 | Freeze migrations in the new project (from now on every change is a new file) | `node tools/db.mjs sql "insert into dek.settings values ('migrations_frozen','true') on conflict (key) do update set value = 'true'"` | |
| 9 | Watch the first 20:00 arrival | health checks in docs/OPERATIONS.md, realtime peak connections | numbers in LOG |

## Rollback (any time before step 9 is signed off)

1. `node tools/cutover/legacy-freeze.mjs --unfreeze` (restores every saved grant exactly).
2. Deploy the legacy client: in `../dek-legacy` run `npm run deploy`.
3. Messages written in the new app during the window are listed by
   `node tools/db.mjs sql "select ... where created_at > '<cutover time>'"` and posted back by
   hand if needed; there is no automatic reverse copy.

## After

- Day 1: delete the unused legacy Cloudflare worker `dek-realtime`.
- Day 30: export a final logical copy of the legacy project to `E:\backups\dek-legacy\`, then
  let it pause (free projects pause after a week idle; restorable for 90 days).
