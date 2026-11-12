# Join request notification native checks

`node tools/test-native227.mjs` prints an inert inventory. This runner uses an existing local PostgreSQL17 installation at the explicit path in the source. It loads no credentials and has no remote target or production fallback.

`node tools/test-native227.mjs --freeze` writes an immutable SHA256 manifest of57source files and3PostgreSQL executables under `.local/fb227-g08/native/`. Source or binary changes require a new manifest; old manifests remain evidence.

An actual run requires the shared `qa:fixboard-heavy-local` claim and `port:55397`, owned by `codex-dek`, plus the current coordinator's QA ordering. Check unread messages first. Fresh free physical RAM must be at least4GiB. During execution a3.5GiB floor, individual query timeout and three-minute ceiling abort only the owned connection/run. Never lower another retained job's gate. The command is:

```
node --max-old-space-size=192 tools/test-native227.mjs --run <absolute-freeze-path> <exact-freeze-sha256>
```

The runner creates a new nonce-bound cluster on loopback127.0.0.1:55397. `native227-host.sql` supplies host interfaces only: JWT `auth.uid`, synthetic Auth table, Realtime capture table/policies, Storage schema interfaces, inactive cron rows, an empty Vault and a non-network HTTP capture table. It removes only the two unavailable hosted extension declarations for pg_net and pg_cron. Every Dek application migration is loaded from its exact frozen source, with normal grants lockdown and normal ledger hashes. No business permission or request function is replaced by a fake.

Before the candidate migration, `native227-baseline.sql` exercises current normal join_server twice, then rolls back. The expected failing feature baseline is one pending approval request and zero events/intents for its eligible owner. This local baseline does not stand in for the separate guarded live baseline receipt.

After the candidate migration, seven cases invoke actual authenticated decision APIs inside rolled-back savepoints to derive an approval oracle. They check actual role changes, foreign/requester/deleted/inactive/blocked negatives, open/repeat/invite joins, channel regressions and broad fanout, real service-role grants, privacy/quiet/device eligibility and retry/final-delivery dedup. All test data rolls back. The runner checks that no Auth users, organizations, intents, queued HTTP or active cron jobs remain.

Each run retains its full receipt and Postgres log. Cleanup verifies the postmaster's binary, data path, PID creation time and nonce-bound owner record before requesting fast stop for that exact data directory. Path arguments are resolved before comparing Windows slash/case formats; extra arguments, prefix-sharing foreign paths and a reused PID are refused. Eleven pure ownership controls exercise this boundary. A final exclusive port bind proves the listener is gone. No data directory is deleted and no foreign process is killed. Release the QA/port claims promptly after the actual terminal proof, including on failure.

These checks prove native SQL/RLS/API behavior in ordinary PostgreSQL. They do not prove hosted Auth, real Realtime transport, browser layout, push-provider acceptance or an actual device receipt. Those remain normal release acceptance checks.
