# Operating Dek

Everything here is a command in this repo. Credentials come from `.env.local` (gitignored,
read only through `tools/lib/env.mjs`); `Desktop\CREDENTIALS.md` says where each lives.

## Accounts and identifiers (no secrets)

| Thing | Value |
|---|---|
| Supabase project | `nxljuctnauhgzekvmftp` ("dek"), region ap-south-1, Micro |
| Supabase org | "UbhayAab's Org" `qmlenovxatoyxxqlvzlo`, Pro, owner ubhayvatsaanand@gmail.com |
| API | `https://nxljuctnauhgzekvmftp.supabase.co`, exposed schema `api` only |
| Web | Cloudflare Pages project `dek`, `https://dek-7o4.pages.dev`, account 8877b5f78f33e1d55352ed485fb875d1 |
| Legacy (rollback only) | Supabase `ybddogqphinruyunnuwx` (org "Dbbb", free, ubhay.a.vatsa@gmail.com); code at tag `legacy-final` |
| Mail | JCF Mailer transactional API, template `dek-otp`, only for sign-in codes |
| TURN | Cloudflare TURN key (function secrets `TURN_KEY_ID`, `TURN_API_TOKEN`) |

`.env.local` keys: `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_DB_PASSWORD`,
`SUPABASE_ACCESS_TOKEN` (Pro account PAT), `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
`SUPABASE_POOLER_*`, `DEK_INTERNAL_SECRET` (pg_net to push-dispatch, also in Vault),
`DEK_QA_PASSWORD` (synthetic QA accounts only). Function secrets live on the project:
VAPID pair and subject, `DEK_INTERNAL_SECRET`, `MAIL_API_KEY`, TURN and Realtime app keys.

## Everyday commands

| Task | Command |
|---|---|
| Apply database migrations | `npm run db:migrate` (checksummed; an applied file never changes) |
| Migration status and drift | `npm run db:status` |
| Inspect the database | `node tools/db.mjs sql "select ..."` |
| Project configuration (PostgREST, Realtime, Auth, Vault) | `node tools/setup-project.mjs` (`--check` reports drift) |
| Deploy an edge function | `npm run fn:deploy <name>` |
| Database tests (branch "test", rolled back; never production) | `npm run test:db`. The harness refuses production unless `DEK_TESTS_ON_PRODUCTION=1`. New migrations go to the branch too: `DEK_DB_TARGET=test npm run db:migrate` (create it with `node tools/create-test-branch.mjs`) |
| Live media tests (production QA world: Storage, media-finalize, media-sign) | `npm run test:db:live` (explicit; cleans up after itself) |
| Web unit tests and types | `npm run test:web`, `npm run typecheck` |
| Synthetic QA world | `node tools/seed-qa.mjs` (`--wipe` removes it) |
| Build and deploy the web app | `npm run deploy` (tests, build, Pages deploy, live check). `git push` deploys nothing. |

Order for any release: migrations first, then functions, then the web app (a client calling a
function that does not exist yet fails; a new function nobody calls yet is harmless).

## Health checks (run after every release and when something feels wrong)

```
node tools/db.mjs sql "select jobname, status, count(*) from cron.job_run_details d join cron.job j using (jobid) where d.start_time > now() - interval '1 hour' group by 1, 2"
node tools/db.mjs sql "select status, count(*) from dek.notification_intents where created_at > now() - interval '1 day' group by 1"
node tools/db.mjs sql "select status, count(*) from dek.notification_deliveries where created_at > now() - interval '1 day' group by 1"
node tools/db.mjs sql "select inhrelid::regclass from pg_inherits where inhparent = 'realtime.messages'::regclass order by 1"
```

- Cron: every run `succeeded`, none longer than a few seconds.
- Intents: nothing `pending` older than a minute; `failed` explained.
- Realtime partitions: one for tomorrow must exist. Realtime creates them while clients are
  connected; if tomorrow's is missing, broadcasts will fail silently (clients still heal by
  cursor on reconnect, but live delivery stops). Fix: connect any client (open the app).

## Cutover from the legacy Dek (one time)

See `docs/CUTOVER.md`.

## Rollback

1. Web: from `../dek-legacy` (tag `legacy-final`) run its own `npm run deploy` (it deploys the
   legacy client to the same Pages project). People reload into the legacy app.
2. Legacy database: undo the read-only switch from the cutover:
   `alter role authenticated reset default_transaction_read_only;` on the legacy project.
3. Messages written in the new system between cutover and rollback are not copied back
   automatically; export them with `node tools/db.mjs sql` by created_at and post a summary.

## Incidents

Write the evidence first (PRD DEK25): first failure time, deployed commit, migrations, browser
errors, HTTP codes, `pg_stat_activity` by application, cron history, realtime partitions,
connection counts. The 2026-09-30 forensics in `docs/incidents/` is the template.
