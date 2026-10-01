# Dek outage, 2026-09-30 20:00 IST - database forensics

Incident: roughly 387 registered users opened Dek at 20:00 IST (14:30 UTC) on
2026-09-30. The app stopped loading for everyone and was still degraded 5+ hours
later.

This document is read-only forensics. Every number below was measured against the
live project through the Supabase Management API between 00:10 and 01:00 UTC on
2026-10-01, roughly 10 to 10.5 hours after the incident began. No DDL, INSERT,
UPDATE, DELETE or ALTER was issued. The remediation section proposes; a human
applies.

Environment: Supabase free plan, no compute addon, ap-south-1, Postgres 17.6,
`max_connections=60`, `shared_buffers=224MB`, `work_mem=2184kB`,
`effective_cache_size=384MB`.

Two measurement windows matter throughout:

| Counter source | Reset at | Span |
|---|---|---|
| `pg_stat_database` | 2026-07-15 13:16:47 UTC | 77.5 days |
| `pg_stat_statements` | 2026-07-23 16:54:24 UTC | 69.3 days |

The 8.15-day gap between them is load-bearing and is discussed under question 1.

---

## The one-sentence answer

pg_cron is running six jobs faster than they can complete, 82% of its runs are
failing, and because a statement that fails is never recorded by
`pg_stat_statements`, that failure traffic is simultaneously the 43% rollback
rate, the 560 GB of temp spill, and the connection pressure that made every user
request time out at its 8-second ceiling. The database is not short of CPU or
disk. It is short of connections, and its own maintenance is eating them.

---

## 1. The 560 GB of temp spill

### What the numbers are

`pg_stat_database` for this database:

| Metric | Value |
|---|---|
| `temp_files` | 166,850 |
| `temp_bytes` | 560,290,076,188 (521.8 GiB) |
| Average temp file | 3.36 MB |
| `work_mem` | 2,184 kB |

`pg_stat_statements`, ordered by `temp_blks_written desc`, top entries:

| calls | mean ms | max ms | rows | temp written | statement |
|---|---|---|---|---|---|
| 1 | 46,882.8 | 46,882.8 | 1 | **27 MB** | ad-hoc `delete from cron.job_run_details where end_time < now() - $1`, run through the Management API on 2026-09-21 |
| 6 | 8,026.0 | 10,937.9 | 150,000 | **13 MB** | the `with chans ... lex(s) as (values ...)` bulk message seeder |
| 1 | 200.7 | 200.7 | 1 | 8,944 kB | ad-hoc `cache_hit_pct / db_size / unused_idx` dashboard query |
| 1 | 43,711.8 | 43,711.8 | 1 | 4,616 kB | my own `A0 connectivity` forensic query |
| 1 | 2,647.7 | 2,647.7 | 1 | 4,616 kB | my own `sum(temp_blks_written)` forensic query |

And the totals:

| `pg_stat_statements` aggregate | Value |
|---|---|
| entries | 4,768 |
| calls | 23,665,960 |
| `temp_blks_written` | 13,224 blocks = **103 MB** |
| of which: 937 one-shot Management API queries | **90 MB** |
| of which: everything else, i.e. real application traffic | **13 MB** |
| `local_blks_written` (temp table churn) | 1,984 blocks = 15.5 MB |
| `pg_stat_statements_info.dealloc` | **2** |

### What it means

**The hypothesis that a named application statement is spilling 560 GB did not
survive the data. State that plainly.**

`pg_stat_statements` accounts for 103 MB of the 521.8 GiB. That is **0.019%**.
And it is not an eviction artefact: `pg_stat_statements_info.dealloc = 2` means
exactly two entries have ever been evicted from the hash table since 2026-07-23.
The view is essentially complete for its window. It simply does not contain the
spill.

Of the 103 MB it does contain, 90 MB was written by 937 one-shot Management API
queries, which is to say by this and earlier forensic sessions. Real application
traffic in 69.3 days wrote **13 MB** of temp files according to
`pg_stat_statements`.

The second-largest temp writer, and the largest that is not an operator query, is
`dek-backend/scripts/seed.mjs`: 6 calls, 150,000 rows, 13 MB of temp,
**1,190 MB of WAL**, 8,026 ms mean. That is the load-test seeder, not production.
Its consequences are real (see question 6) but it is not a production query.

So where is the spill coming from? I measured the current rate rather than
guessing. Two snapshots of `pg_stat_database`, 302.8 seconds apart, taken at
~00:30 UTC with essentially no user traffic:

| Delta over 302.8 s | Value | Rate | Extrapolated per day |
|---|---|---|---|
| `temp_files` | 5 | 0.0165/s | 1,427 |
| `temp_bytes` | 21,470,176 (20.5 MB) | 0.07 MB/s | **6.13 GB** |
| average temp file in that window | **4.10 MB** | | |
| `blks_read` | **0** | | |

Compare with the lifetime average: 166,850 files / 77.5 days = 2,153 files/day,
and 521.8 GiB / 77.5 days = 7.23 GB/day.

**The current rate is the same order as the lifetime average: 66% of it on file
count, 85% on bytes.** The 560 GB is therefore not a historical burst left over
from seeding runs in the 8-day pre-`pg_stat_statements` gap. It is a steady
background process that has been spilling a ~4 MB temp file roughly once a minute
for 77.5 days, and is still doing it right now. `blks_read = 0` over the window
confirms it is sorting and hashing cached data, not reading from disk.

### Why it spills, and why it is invisible

`pg_stat_statements` records a statement in `pgss_ExecutorEnd`. A statement that
is cancelled or that raises an error never reaches `ExecutorEnd`, so it is never
recorded - but its temp files were already written and already counted by
`pg_stat_database`, and its transaction already counted as a rollback.

Two settings make this worse and are worth writing down:

| setting | value | consequence |
|---|---|---|
| `log_temp_files` | **-1** | temp file logging is **off**, so there is no log record of any spill |
| `pg_stat_statements.track` | **top** | statements nested inside a PL/pgSQL body are not tracked individually |
| `temp_file_limit` | -1 | unlimited; nothing stops a runaway spill |
| `hash_mem_multiplier` | 2 | hash nodes get 4,368 kB before spilling; sorts get 2,184 kB |
| `pg_stat_statements.max` | 5000 | and the view holds **4,768** entries, i.e. **95% full** |

Two candidates were checked and eliminated:

- **Logical decoding spill: ruled out.** `pg_stat_replication_slots` for the
  realtime slot reports `spill_txns = 0`, `spill_count = 0`,
  `spill_bytes = 0 bytes`, `total_txns = 124`, `total_bytes = 147 kB`.
- **Temp table churn: ruled out as the bulk.** `local_blks_written` across all
  4,768 entries is 1,984 blocks (15.5 MB), and `temp_buffers` is 8 MB. The two
  `create temporary table` calls in `app.drain_notifications` are catalog churn,
  not a 560 GB spill.

That single mechanism explains the 0.019% attribution gap, and it ties this
question to questions 2 and 3. The measured rates line up:

- ~1 temp file per 60.6 seconds.
- Three pg_cron jobs run on a `* * * * *` schedule, i.e. exactly once a minute.
- 82% of all pg_cron runs are currently failing (question 3).

The most likely single spiller is `app.escalate_acks()`, on the `escalate-acks`
job, every 60 seconds. Its driving query is:

```sql
select t.message_id, t.user_id, t.channel_id, t.workspace_id
  from public.message_ack_targets t
  join public.messages m on m.id = t.message_id
 where t.reminded_at is null
   and t.created_at <= now() - interval '6 hours'
   and m.deleted_at is null
   and m.ack_required
   and not exists (select 1 from public.message_acks a
                    where a.message_id = t.message_id and a.user_id = t.user_id)
 order by t.created_at
 for update of t skip locked
 limit 500
```

`dek-backend/supabase/migrations/0055_coordination.sql:250`

There is no index supporting `m.ack_required`, and `public.messages` is a 139 MB
heap holding 4,452 live rows (question 6). Joining an 8-row table to a 139 MB
heap with `work_mem = 2184kB` and then sorting by `t.created_at` is exactly the
shape that spills. The supporting evidence is in the table stats:
`public.message_ack_targets` has **8 live rows** and has been sequentially
scanned **12,005 times for 37,890,585 tuples read**.

### A second candidate, which fits the cadence even better

`pg_stat_activity` at 00:55 UTC shows a backend belonging to Supabase's own
metrics scraper:

```
pid 2732513  usename supabase_admin  application_name postgres_exporter
  state idle  wait_event Client/ClientRead
  query: SELECT sum(calls) as total_queries, sum(total_exec_time / 1000) as
         total_time_seconds FROM ...
```

That is an aggregate over `pg_stat_statements`. Measured fact from this very
investigation: **every `select ... from pg_stat_statements` on this database
spills a temp file of about 4.5 MB.** Several of my own forensic queries recorded
exactly 577, 571, 559 and 557 `temp_blks_written`, which is 4,616 / 4,568 /
4,472 / 4,456 kB. The one live temp file observed during the delta window was
4,621 kB, and the average temp file created in that window was **4.10 MB**.

The reason is structural: the view materialises 4,768 rows each carrying a long
`query` text, and `work_mem` is 2,184 kB. It cannot be done in memory.

If `postgres_exporter` scrapes on a 60-second interval, that is 111,600 scrapes
over 77.5 days at ~4.5 MB each = **~502 GB**, against the 521.8 GiB observed. The
cadence matches (1 file per 60.6 s measured), the size matches (4.10 MB measured),
and the timeline matches (`pg_stat_database` was reset 2026-07-15, which is when
this project's monitoring would have started).

**There is one logical objection to this, and resolving it strengthens the
overall diagnosis rather than weakening it.** If the exporter's query *completed*,
it would be recorded in `pg_stat_statements` with an enormous
`temp_blks_written` - and it would have been number one in the top-15 list above,
not absent from it. The top entry there is 3,452 blocks.

So the exporter hypothesis requires that its query does **not** complete. That is
exactly what one would expect: `postgres_exporter` runs with a scrape timeout,
typically 5 to 10 seconds. My own aggregates over `pg_stat_statements` on this box
took **32 to 230 seconds**, and several timed out entirely. An exporter with a
10-second scrape timeout would be cancelling **every single scrape** - writing its
4.5 MB temp file each time and never being recorded.

Which means both candidates route through the same mechanism: a statement that
spills and then dies before `ExecutorEnd`. That is the same mechanism as the
rollback rate. It is one fault, not three.

**I could not confirm which candidate it is.** The deciding query -
`select calls, temp_blks_written from pg_stat_statements where query ilike
'%pg_stat_statements%'` - timed out after five retries on three separate
attempts as the database degraded further during this session. If it shows a
six-figure `calls` count with ~570 `temp_blks_written`, the exporter is the answer
and `escalate_acks` is not. **Run it first when the box is calmer.** It costs
nothing and it decides between the two.

That the deciding query cannot itself complete is corroboration, not just an
inconvenience. Four attempts, each five retries at ~55 s, all returned
`Connection terminated due to connection timeout`. A query over
`pg_stat_statements` on this database currently cannot finish inside a
connection's patience - which is exactly the condition under which
`postgres_exporter` would be spilling 4.5 MB per minute and recording nothing.

Note the irony, which is also a genuine operational finding: if this is the
cause, then the act of monitoring this database is 96% of its temp file I/O, and
every forensic query run against `pg_stat_statements` (including all of mine) adds
to it.

**What I could not measure:** I cannot prove either attribution from SQL alone.
The measurement that settles it definitively is `log_temp_files = 0` - currently
**-1**, i.e. off - plus reading the Postgres log through Supabase's Logs Explorer,
which is not a SQL surface. Treat both the `escalate_acks` and the
`postgres_exporter` identifications as circumstantial. What *is* proven is the
negative result: no statement tracked by `pg_stat_statements` is responsible, and
the cause must be a statement class that view cannot see.

---

## 2. The 43% rollback rate

### What the numbers are

`pg_stat_database`:

| Metric | Value |
|---|---|
| `xact_commit` | 11,241,464 |
| `xact_rollback` | **8,338,627** |
| rollback share | **42.59%** |
| total transactions | 19,580,091 over 77.5 days = 2.92/s |
| `deadlocks` | **0** |
| `conflicts` | **0** |
| `sessions` | **2,776,764** |
| `sessions_abandoned` | 1,115 |
| `sessions_fatal` | 58 |
| `sessions_killed` | 4 |
| `blks_hit` / `blks_read` | 2,448,474,280 / 311,930 (99.99%) |

Measured live rate, same 302.8-second window as above, with near-zero user
traffic:

| Delta | Value | Rate |
|---|---|---|
| commits | 197 | 0.65/s |
| **rollbacks** | **57** | **0.19/s** |
| rollback share *right now* | | **22.4%** |
| new sessions | 48 | 0.16/s |

### What it means

It is not benign, and it is not a read pattern that rolls back by design.
`deadlocks = 0` and `conflicts = 0` rule out lock contention and recovery
conflicts as the source.

The live delta attributes it. In 302.8 seconds with almost nobody using the app:

- 48 new sessions were created. pg_cron runs with
  `cron.use_background_workers = off`, which means **every job execution opens a
  fresh libpq connection**, i.e. one session per run.
- Expected cron runs in 302.8 s from the live schedule: `drain-notifications`
  4/min + `fanout-tick` 4/min + `tick-30s` 2/min + three `* * * * *` jobs 3/min
  = 13/min = **65.6 runs**.
- Measured cron failure rate over the newest 300 runs: **82%** (question 3).
- 0.82 x 65.6 = **53.8 expected failed runs**. Measured rollbacks: **57**.

That is a tight match. **The rollbacks are failing pg_cron runs.** Each failed
run is one rolled-back transaction that `pg_stat_statements` never records, for
the same reason the temp spill is invisible.

The lifetime total is only partly explained by that. 2,456,689 cron executions
have occurred (counted from the `insert into cron.job_run_details` call count),
against 8,338,627 rollbacks - a ratio of 3.4 rollbacks per cron execution. The
current-rate attribution is solid; the lifetime figure implies either additional
rollback sources or per-run bookkeeping transactions that also roll back under
contention. **I could not resolve that gap.**

### The second mechanism, which is what users actually saw

`pg_db_role_setting` shows the per-role limits:

| role | setconfig |
|---|---|
| `anon` | `statement_timeout=3s` |
| `authenticated` | `statement_timeout=8s` |
| `authenticator` | `statement_timeout=8s`, `lock_timeout=8s`, `pgrst.db_pre_request=public.enforce_password_latch` |
| `postgres` | `search_path` only - **no statement_timeout** |

Now look at `max_exec_time` across the busiest PostgREST RPCs in
`pg_stat_statements`:

7,865.8 / 7,932.8 / 7,805.4 / 7,700.7 / 7,689.5 / 7,612.8 ms.

Six independent statements approach 8,000 ms and not one crosses it. That is not
coincidence, it is the `authenticated` role's `statement_timeout=8s` acting as a
ceiling.

The whole distribution of `max_exec_time` across all 4,768 entries confirms it:

| band | entries | calls |
|---|---|---|
| < 1 s | 4,536 | 3,088,512 |
| 1 - 3 s | 101 | 5,201,213 |
| 3 - 7 s | 84 | 1,137,763 |
| **7 - 8.1 s (the ceiling)** | **24** | **2,209,994** |
| **> 8.1 s** | **36** | 12,029,491 |

24 entries pile up in the 7 to 8.1 s band and account for 2,209,994 calls. Only
**36** entries have ever exceeded 8.1 s, and they are the statements run as
`postgres`, `supabase_admin` and pg_cron - the roles with **no**
`statement_timeout`. Nothing running as `authenticated` or `authenticator` ever
got past ~7.94 s, because it was killed there.

Twenty distinct user-facing PostgREST RPCs have `max_exec_time` between 7,240.7
and 7,932.8 ms. Not one exceeds 8,000 ms.

Every request that overran the ceiling was **cancelled**, which means:

1. The user saw a failure.
2. The transaction rolled back (`xact_rollback++`).
3. The statement vanished from `pg_stat_statements`.

So the RPC latencies recorded in `pg_stat_statements` are *survivorship-biased*.
The 216 ms mean on the busiest bootstrap RPC is the mean of the calls that
finished inside 8 seconds. The ones that did not finish are not in the average.

Note also that `postgres` has **no** `statement_timeout`, which is why cron jobs
were able to run for 350 seconds (question 3) while user requests were being
killed at 8.

### The pre-request hook

`public.enforce_password_latch()` is wired as PostgREST's `db_pre_request` hook
and therefore runs on **every single API request**:

`dek-backend/supabase/migrations/0060_password_latch_enforcement.sql:216` (body),
`:245` (the `alter role authenticator set pgrst.db_pre_request` wiring).

Measured cost: **1,501,706 calls, 5,552.0 s total, 3.70 ms mean, 6.40% of all
recorded database execution time**, for a hook whose fast path is documented as
"one primary-key lookup on profiles". Its slow path does
`raise exception 'password_setup_required'` with errcode 42501 for any latched
account outside a three-path allowlist, and every such raise is another
rolled-back, unrecorded transaction.

I did not measure how many accounts are actually latched, so I cannot size this
contribution. It is a candidate, not a confirmed contributor.

---

## 3. pg_cron pile-up

### The schedule

15 active jobs. Relevant settings:

| setting | value |
|---|---|
| `cron.use_background_workers` | **off** |
| `cron.max_running_jobs` | **32** |
| `cron.log_run` | **on** |
| `cron.log_statement` | **on** |
| `cron.database_name` | postgres |

`cron.use_background_workers = off` with `cron.max_running_jobs = 32` on a box
with `max_connections = 60` means **pg_cron alone can claim 53% of every
connection the database has**, each as a full libpq session.

### Duration and failure, measured

The user's specific question: the live job is `tick-30s` running
`select app.tick_30s();` - not `app.tick_30()`, which does not exist on this
database. Repo definition at
`dek/supabase/migrations/0136_stop_paying_for_nothing.sql:140`, scheduled at
`:157`.

Newest 300 runs, window 2026-09-30 18:20:31 to 19:02:05 UTC (a 41.5-minute
window about 4 hours into the degradation):

| job | schedule | runs | failed | **avg s** | **max s** | overlap factor |
|---|---|---|---|---|---|---|
| `drain-notifications` | 15 seconds | 59 | 48 (81%) | **36.44** | **350.02** | **2.4x** |
| `fanout-tick` | 15 seconds | 70 | 55 (79%) | **28.08** | **349.57** | **1.9x** |
| `tick-30s` | 30 seconds | 41 | 33 (80%) | **35.12** | **347.09** | **1.2x** |
| `clear-expired-statuses` | `* * * * *` | 43 | 37 (86%) | 29.94 | 343.63 | 0.5x |
| `nag-tasks` | `* * * * *` | 43 | 37 (86%) | 30.52 | 277.96 | 0.5x |
| `escalate-acks` | `* * * * *` | 43 | 35 (81%) | 27.31 | 242.74 | 0.5x |
| `sync-leave-statuses` | `40 18 * * *` | 1 | 1 | 13.86 | 13.86 | - |
| **total** | | **300** | **246 (82%)** | | | |

**Direct answer to the question asked: yes.** `app.tick_30s()` averages
**35.12 seconds** on a **30-second** schedule, so its runs overlap and compound.
It is not the worst offender though - `drain-notifications` averages 36.44 s on a
**15-second** schedule, a 2.4x overlap, and `fanout-tick` averages 28.08 s on a
15-second schedule, 1.9x.

Three different jobs share a maximum of ~350 seconds (350.02 / 349.57 / 347.09).
Jobs with unrelated bodies do not independently converge on the same 350-second
duration; they were all blocked on the same thing for the same ~6 minutes.

None were in `running` state at measurement time, so there is no single stuck run
to kill. The pile-up is churn, not a hang.

Throughput check: 300 runs in 41.5 minutes is 7.2 runs/min against an expected
13/min. **pg_cron is only achieving 55% of its own schedule.**

### Lifetime maxima from pg_stat_statements

| statement | calls | mean ms | **max ms** |
|---|---|---|---|
| `select app.drain_notifications()` | 395,581 | 20.16 | **107,655.4** (107.7 s) |
| `select app.clear_expired_statuses()` | 97,675 | 14.27 | 46,759.8 |
| `select app.escalate_acks()` | 96,593 | 18.56 | 45,363.2 |
| `select app.run_fanout_tick()` | 1,050,220 | 8.26 | 30,607.9 |
| `insert into cron.job_run_details (...)` | 2,456,699 | 0.58 | **93,479.0** |
| `update cron.job_run_details set status,return_message,start_time,end_time where runid` | 1,726 | 702.46 | **145,365.8** |

A single-row INSERT into the cron history table taking **93.5 seconds**, and a
single-row UPDATE taking **145.4 seconds**, is the clearest possible statement
that this box is not CPU-bound. It is blocked.

### What pg_cron costs to bookkeep itself

`cron.log_run = on` makes pg_cron write **five rows per job execution** - one
INSERT and four separate UPDATEs, each visible as its own `pg_stat_statements`
entry at ~2.455 million calls:

| statement | calls | WAL | WAL records |
|---|---|---|---|
| `insert into cron.job_run_details (jobid, runid, database, username, command, status)` | 2,456,699 | 568 MB | 4,943,488 |
| `update ... set status=$1, return_message=$2, end_time=$3 where runid=$4` | 2,454,958 | 428 MB | 2,862,900 |
| `update ... set status=$1, start_time=$2 where runid=$3` | 2,454,958 | 403 MB | 2,767,628 |
| `update ... set status=$1 where runid=$2` | 2,456,698 | 385 MB | 2,910,633 |
| `update ... set job_pid=$1, status=$2 where runid=$3` | 2,455,008 | 380 MB | 2,814,865 |
| **total** | **12,278,321** | **2,164 MB** | **16,299,514** |

12.28 million row writes and 2.1 GB of WAL, purely to record that maintenance
jobs ran. At autocommit that is 12.28 million of the database's 19.58 million
lifetime transactions - **63% of every transaction this database has ever run is
pg_cron writing its own logbook.**

`cron.job_run_details` state: 47 MB, 130,929 live rows, 20,113 dead,
`n_tup_del = 2,314,115`, `last_vacuum = null` (never manually vacuumed),
`last_autovacuum = 2026-09-29 02:11:46`.

### Failures in the last 3 hours

**Could not measure as asked.** Every time-filtered aggregate over
`cron.job_run_details` (`where start_time > now() - interval '3 hours'`, and the
24-hour variant) timed out after 5 retries at ~55 s each. There is no index on
`start_time` - the only index in the `cron` schema on that table is its primary
key - so any time filter is a sequential scan of a 47 MB, 151k-row, bloated table
on a blocked box. The 300-newest-runs sample above is the substitute, and it
covers 18:20-19:02 UTC, which is inside the degraded period but about 4 hours
after onset rather than the 3-hour window requested.

Likewise the whole-table `group by status` count did not return.

### What app.tick_30s does

```sql
create or replace function app.tick_30s()
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  begin perform app.reap_presence();      exception when others then
    raise warning 'tick_30s: reap_presence: %', sqlerrm; end;
  begin perform app.dispatch_scheduled(); exception when others then
    raise warning 'tick_30s: dispatch_scheduled: %', sqlerrm; end;
  begin perform app.fire_reminders();     exception when others then
    raise warning 'tick_30s: fire_reminders: %', sqlerrm; end;
  begin perform app.reap_voice();         exception when others then
    raise warning 'tick_30s: reap_voice: %', sqlerrm; end;
end;
$fn$;
```

`dek/supabase/migrations/0136_stop_paying_for_nothing.sql:140`

It is four unrelated maintenance calls merged into one job by migration 0136,
specifically to save connections - four 30-second jobs were costing four libpq
connections every 30 seconds. Each call is wrapped in its own exception block so
one failure does not abandon the other three. **It has no overlap guard.** If the
previous run is still going, this one starts anyway and does all four again.

### Live backend census, 00:55 UTC

For the record, 10.5 hours after onset and with essentially no user traffic:

| backend | user | state | wait | note |
|---|---|---|---|---|
| `pg_cron` client backend | postgres | **active** | - | `select app.drain_notifications();`, **xact_age 00:00:14** on a 15-second schedule |
| PostgREST 14.5 | authenticator | active | - | role-setting introspection |
| PostgREST 14.5 | authenticator | idle | Client/ClientRead | `LISTEN "pgrst"` |
| realtime_connect x2 | supabase_admin | idle | Client/ClientRead | `COMMIT` |
| walsender | supabase_admin | active | Client/**WalSenderWaitForWal** | caught up, waiting for WAL |
| `pg_net 0.20.4 worker` | postgres | idle | Extension | queue is empty |
| pg_cron launcher, autovacuum launcher, logical replication launcher, checkpointer, bgwriter (hibernating), walwriter, archiver | - | - | - | idle |
| `postgres_exporter` | supabase_admin | idle | Client/ClientRead | aggregating `pg_stat_statements` - see question 1 |

Only **two** PostgREST backends are connected. Queue depths are both zero
(`net.http_request_queue` = 0, `pgmq.q_notifications` = 0), so nothing is backed
up in the application queues. The one thing still working hard is a cron job that
has already been running for 14 of its 15 available seconds.

---

## 4. Realtime write amplification

### What the numbers are

Every relation in the `realtime` schema, by size:

| relation | size | rows |
|---|---|---|
| `messages_2026_09_30` (today) | **568 kB** | **438** (exact count) |
| `messages_2026_09_28` | 472 kB | 424 |
| `messages_2026_09_29` | 448 kB | 369 |
| `messages_2026_09_27` | 96 kB | 9 |
| `messages_2026_10_01` / `_10_02` / `_10_03` | 24 kB each | 0 (pre-created) |
| `subscription` | 32 kB | - |
| all indexes combined | ~450 kB | - |
| **entire `realtime` schema** | **2,200 kB** | |

Against the app's own `public.messages`: **139 MB**, 4,452 live rows.

Replication slot:

| field | value |
|---|---|
| `slot_name` | `supabase_realtime_messages_replication_slot_2_139_0_3e6fc57` |
| `plugin` / `slot_type` | pgoutput / logical |
| `active` | **true** |
| `wal_status` | **reserved** |
| retained WAL | **52 kB** |

WAL generation, ordered by `wal_bytes desc`:

| statement | calls | **WAL** | WAL records | FPI |
|---|---|---|---|---|
| `select app.drain_notifications()` | 395,581 | **3,257 MB** | 27,038,948 | 655,079 |
| the `seed.mjs` bulk inserter | 6 | 1,190 MB | 3,257,234 | 2,744 |
| cron bookkeeping (5 statements) | 12,278,321 | 2,164 MB | 16,299,514 | 72,104 |
| `DELETE FROM "users" WHERE users.id = $1` (GoTrue) | 13,876 | 345 MB | 3,639,046 | 16,321 |
| `INSERT INTO "realtime"."messages" (...)` | 261,079 | **117 MB** | 525,722 | 29,093 |

### What it means

**The realtime write amplification hypothesis did not survive. State that
plainly.**

- Today's partition is 568 kB holding 438 rows. The app's own `public.messages`
  is 139 MB. `public.messages` is **63x larger than the entire realtime schema**.
- The replication slot is healthy: active, `wal_status = 'reserved'`, and
  retaining **52 kB** of WAL. It is not lagging and it is not pinning WAL.
- Realtime generates **117 MB** of WAL. `app.drain_notifications()` generates
  **3,257 MB** - 28x more. Realtime is 3.5% of what the push drain produces.

`app.drain_notifications()` is the single largest WAL producer in this database:
**8.44 kB of WAL and 68.4 WAL records per call**, 395,581 times. 655,079 full
page images means it is repeatedly dirtying the same pages just after
checkpoints. Its body is at
`dek/supabase/migrations/0135_fanout_outside_the_lock.sql:151`, and it creates
**two temporary tables on every single invocation**
(`0135_...sql:172` and `:182`, both `create temporary table if not exists ... on
commit drop`), which is catalog churn 4 times a minute forever.

The `autovacuum: VACUUM realtime.messages_2026_09_30` seen in `pg_stat_activity`
during the incident was vacuuming a **568 kB** table. It was a symptom of
autovacuum being unable to finish on a blocked box, not a cause of anything.

One realtime cost is real but is not ours to fix: Supabase Realtime's own
bookkeeping query `SELECT m0."id" FROM "realtime"."messages" AS m0 WHERE
(m0."id" = ANY($1))` runs **231,074 times for 1,597.7 s (1.84% of all database
time)**. It targets the partitioned *parent*, so every call touches every
partition. The only lever we control is emitting fewer events.

---

## 5. Where the database actually spends itself

`pg_stat_statements` ordered by `total_exec_time desc`, top 20. Total across all
4,768 entries is **86,728 s (24.1 hours)** over 69.3 days.

| # | total s | % | calls | mean ms | max ms | statement |
|---|---|---|---|---|---|---|
| 1 | 8,672.8 | **10.00** | 1,050,220 | 8.26 | 30,607.9 | `select app.run_fanout_tick()` |
| 2 | 8,200.7 | **9.45** | 37,929 | **216.21** | 7,865.8 | RPC, scalar, takes `p_workspace` (the cold-start bootstrap read) |
| 3 | 7,973.0 | **9.19** | 395,581 | 20.16 | **107,655.4** | `select app.drain_notifications()` |
| 4 | 5,552.0 | **6.40** | 1,501,706 | 3.70 | 7,936.2 | `select "public"."enforce_password_latch"()` |
| 5 | 3,885.6 | 4.48 | 219,453 | 17.71 | 7,932.8 | RPC `p_status, p_channel` = `public.heartbeat` |
| 6 | 3,011.7 | 3.47 | 122,364 | 24.61 | 7,805.4 | RPC `p_workspace, p_filter, p_channel, p_include_done` (task list) |
| 7 | 2,396.6 | 2.76 | 15,795 | **151.73** | 7,689.5 | RPC, scalar, `p_workspace` |
| 8 | 2,312.1 | 2.67 | 63,482 | 36.42 | 7,700.7 | direct table read of `public.user_presence` where `status <> $1` |
| 9 | 2,040.9 | 2.35 | 62,379 | 32.72 | 6,999.3 | RPC `p_workspace` -> `public.get_unread` |
| 10 | 1,995.1 | 2.30 | 99,647 | 20.02 | 7,612.8 | RPC `p_channel, p_seq, p_limit` (resume) |
| 11 | 1,792.9 | 2.07 | 96,593 | 18.56 | 45,363.2 | `select app.escalate_acks()` |
| 12 | 1,694.3 | 1.95 | 2,434 | **696.10** | 6,453.0 | `SELECT name FROM pg_timezone_names` (2,911,064 rows) |
| 13 | 1,597.7 | 1.84 | 231,074 | 6.91 | 6,856.2 | `SELECT m0."id" FROM "realtime"."messages" WHERE id = ANY($1)` |
| 14 | 1,423.4 | 1.64 | 2,456,689 | 0.58 | **93,479.0** | `insert into cron.job_run_details (...)` |
| 15 | 1,393.3 | 1.61 | 97,675 | 14.27 | 46,759.8 | `select app.clear_expired_statuses()` |
| 16 | 1,306.7 | 1.51 | 110,266 | 11.85 | 5,279.6 | RPC `p_channel` -> `public.list_topics` |
| 17 | 1,285.8 | 1.48 | 261,067 | 4.93 | 16,236.5 | `INSERT INTO "realtime"."messages" (...)` |
| 18 | 1,220.6 | 1.41 | 70,732 | 17.26 | 6,576.2 | RPC -> `public.get_later` |
| 19 | 1,212.5 | 1.40 | 1,726 | **702.46** | **145,365.8** | `update cron.job_run_details set status, return_message, start_time, end_time` |
| 20 | 1,200.3 | 1.38 | 8,556 | **140.29** | 6,508.7 | RPC, scalar, `p_workspace` |

### Roll-ups

| Category | total s | % of all DB time |
|---|---|---|
| pg_cron job bodies (#1, #3, #11, #15) | 19,832.0 | **22.87** |
| pg_cron self-bookkeeping (6 statements incl. #14, #19) | 4,387.4 | **5.06** |
| **pg_cron, total** | **24,219.4** | **27.93** |
| `enforce_password_latch` pre-request hook | 5,552.0 | 6.40 |
| `pg_timezone_names` (GoTrue/PostgREST introspection) | 1,694.3 | 1.95 |
| Supabase Realtime's own two statements (#13, #17) | 2,883.5 | 3.32 |

**28% of everything this database does is its own cron.** Migration 0136 measured
this at 40% on a 61-day window and reduced it; it is still 28%.

Remember the survivorship bias from question 2: every `max ms` in the 7,600 to
7,940 ms band is a statement that finished just inside the 8-second
`statement_timeout`. The ones that did not finish are absent from this table
entirely, so the real cost of the user-facing RPCs is higher than shown.

---

## 6. Total database size, and the biggest relations

| | |
|---|---|
| Database size | **245 MB** (256,797,843 bytes) |
| Free plan allowance | 500 MB |
| **Used** | **49.0%** |

**Size is not the binding constraint.** But the composition is the problem:

| relation | total | live rows | dead | seq_scan | seq_tup_read | last_vacuum | last_autovacuum |
|---|---|---|---|---|---|---|---|
| `public.messages` | **139 MB** | **4,452** | 151 | 552 | 17,196,297 | **null** | 2026-09-21 20:57 |
| `cron.job_run_details` | **47 MB** | 130,929 | 20,113 | - | - | **null** | 2026-09-29 02:11 |
| `public.channel_events` | 11 MB | 2,000 | 231 | 10,353 | 5,143,554 | **null** | 2026-09-21 20:57 |
| `auth.refresh_tokens` | 3,568 kB | 7,039 | - | - | - | - | - |
| `pg_catalog.pg_proc` | 3,440 kB | 4,006 | - | - | - | - | - |
| `public.audit_log` | 2,928 kB | 6,282 | 1,134 | 61 | 2,891 | **null** | 2026-08-02 06:51 |
| `private.rate_counters` | 2,584 kB | 380 | - | - | - | - | - |
| `public.message_ack_targets` | 1,880 kB | **8** | 0 | **12,005** | **37,890,585** | **null** | 2026-09-19 10:00 |
| `public.read_state` | 1,384 kB | 4,070 | 768 | 3,637 | 7,803,856 | **null** | 2026-07-31 09:24 |
| `public.profiles` | 872 kB | 387 | 79 | 105,019 | 44,789,361 | **null** | 2026-09-28 15:33 |
| `public.channels` | 368 kB | 236 | 48 | **5,076,849** | **600,831,431** | **null** | **2026-09-30 14:16** |
| `public.user_presence` | 352 kB | 313 | 0 | 270,255 | 80,322,299 | **null** | 2026-09-30 15:00 |

### What this means

**`public.messages` is 139 MB holding 4,452 live rows and only 151 dead ones.**
That is 32 kB of relation per live row. It is not dead-tuple bloat that a plain
VACUUM would fix - autovacuum already reclaimed those tuples as free space
*inside* the files and cannot return the pages to the OS. The provenance is
recorded in the counters: `n_tup_ins = 179,719`, `n_tup_del = 301,079`. The
150,000-row `seed.mjs` load test (question 1, question 4) inserted it, something
deleted it, and 139 MB of empty pages remain.

**And it splits 63 MB heap / 77 MB indexes, which changes the fix.** The majority
of the bloat is in nine indexes over 4,452 rows:

| index | size | definition |
|---|---|---|
| `messages_nonce_uidx` | **24 MB** | `(channel_id, author_id, client_msg_id)` unique |
| `messages_channel_recent_idx` | **14 MB** | `(channel_id, id DESC) where deleted_at is null` |
| `messages_channel_seq_uidx` | **11 MB** | `(channel_id, seq)` unique |
| `messages_search_gin` | 9,528 kB | GIN `(search_tsv, workspace_id, channel_id, author_id)` |
| `messages_pkey` | 8,440 kB | `(id)` unique |
| `messages_channel_topic_seq_idx` | 7,944 kB | `(channel_id, topic, seq)` |
| `messages_ws_author_idx` | 2,544 kB | `(workspace_id, author_id) where deleted_at is null` |
| `messages_thread_idx` | 80 kB | `(thread_id, seq) where thread_id is not null` |
| `messages_also_send_idx` | 16 kB | `(channel_id, seq) where also_send_to_channel` |

77 MB of index for 4,452 rows is about 17 kB of index per row. That 77 MB can be
reclaimed with `REINDEX ... CONCURRENTLY`, which takes only a
`SHARE UPDATE EXCLUSIVE` lock and needs **no downtime** - a much better trade
than `VACUUM FULL`. See A7.

`public.messages` + `cron.job_run_details` = **186 MB of the 245 MB database
(76%)**, and both are overwhelmingly empty space.

`shared_buffers` is **224 MB**. A 139 MB table that contains 4,452 useful rows
means any scan of it evicts most of the cache for nothing. That is the mechanism
behind the reported 29-second `select count(*) from public.profiles` on a 387-row,
872 kB table: `profiles` is not slow, the box is starved.

**`public.channels` has been sequentially scanned 5,076,849 times for
600,831,431 tuples read** on a table with 236 rows. Migration 0136 measured
4,888,720 of those scans and added a guard to stop them. The counter has risen by
**188,129 since**, so the guard is reducing but not eliminating the full
recompute in `app.run_digest_monitor`
(`dek/supabase/migrations/0136_stop_paying_for_nothing.sql:42`).

**`public.message_ack_targets`: 8 live rows, 1,880 kB, 12,005 sequential scans,
37,890,585 tuples read.** This is `app.escalate_acks()` every 60 seconds and is
the prime temp-spill suspect from question 1.

**`last_vacuum` is `null` for every single table.** No manual VACUUM has ever run
on this database. Several tables last saw autovacuum months ago:
`read_state` 2026-07-31, `audit_log` and `canvas_blocks` 2026-08-02.

Timing worth noting: `public.channels` was last autovacuumed at
**2026-09-30 14:16:46 UTC, fourteen minutes before the outage**, and
`public.user_presence` at **15:00:46 UTC, during it**.

---

## Ranked causes, with evidence

**1. pg_cron is scheduled faster than it can run, with no overlap guard, on
libpq connections rather than background workers.** `drain-notifications`
averages 36.44 s on a 15-second schedule; `fanout-tick` 28.08 s on 15 s;
`tick-30s` 35.12 s on 30 s. 246 of the newest 300 runs failed (82%). pg_cron can
hold 32 of 60 connections (`cron.max_running_jobs=32`,
`cron.use_background_workers=off`). 28% of all database execution time is cron.
This is the root cause: it consumed the connections and the write bandwidth that
387 arriving users needed.

**2. Every failing statement is invisible, which is why the counters looked
inexplicable.** `pg_stat_statements` records at `ExecutorEnd`, which a cancelled
or erroring statement never reaches. That single fact explains both the 43%
rollback rate (measured live at 0.19 rollbacks/s against 53.8 expected failed
cron runs per 302.8 s - a tight match) and the 560 GB of temp spill (0.019%
attributable to any tracked statement, with `dealloc=2` ruling out eviction).
The spill's specific producer is still open between `postgres_exporter`'s
cancelled `pg_stat_statements` scrapes and `app.escalate_acks()`; both die before
`ExecutorEnd`, which is why neither shows up. One query decides it and it is
named in "What could not be measured" item 1.

**3. 139 MB in `public.messages`, against 224 MB of `shared_buffers`.** 4,452
live rows in 63 MB of heap plus **77 MB of indexes**, left behind by the
150,000-row `seed.mjs` load test (`n_tup_ins = 179,719`,
`n_tup_del = 301,079`). Together with `cron.job_run_details` at 47 MB that is
186 MB of the 245 MB database, nearly all of it empty space, competing for a
224 MB buffer cache. `last_vacuum` is null on **every** table in the database.
This is why unrelated trivial queries took 29 seconds. The 77 MB index half is
reclaimable with no downtime (A7).

**4. An 8-second `statement_timeout` on `authenticated`/`authenticator` turned
slowness into failure, and the client's retries turned failure into more load.**
Six independent RPC entries have `max_exec_time` between 7,612 and 7,940 ms and
none exceeds 8,000. `postgres` has no `statement_timeout` at all, so cron jobs
ran for 350 seconds while user requests were being killed at 8.

**5. `app.drain_notifications()` is the largest WAL producer in the database:
3,257 MB, 27,038,948 WAL records, 655,079 FPI across 395,581 calls (8.44 kB of
WAL per call).** It also creates two temporary tables per invocation, four times
a minute. This is the source of the `LWLock:WALInsert` contention on five
backends.

**6. pg_cron's own logbook is 63% of all transactions this database has ever
run.** `cron.log_run=on` writes 5 rows per execution: 12,278,321 row writes,
2,164 MB of WAL, 16,299,514 WAL records, and a 47 MB `job_run_details` table with
2.3 million deleted rows.

**7. `enforce_password_latch` costs 6.40% of all database time (1,501,706 calls,
5,552 s) as a pre-request hook on every API call.** Unquantified additional cost
in rolled-back transactions when it raises.

### Hypotheses that did not survive

- **Realtime write amplification: dead.** The entire `realtime` schema is
  2,200 kB. Today's partition is 568 kB with 438 rows, against `public.messages`
  at 139 MB. Realtime generates 117 MB of WAL against `drain_notifications`'
  3,257 MB.
- **WAL retention by the replication slot: dead.** The slot is active,
  `wal_status='reserved'`, retaining **52 kB**.
- **A missing index causing a 560 GB spill in a named production query: dead as
  stated.** No tracked statement accounts for the spill at all. The two largest
  temp writers on record are an operator's ad-hoc
  `delete from cron.job_run_details` (27 MB) and the `seed.mjs` load tester
  (13 MB). Real application traffic wrote 13 MB of temp files in 69.3 days. A
  missing index may still be *a* contributor via `escalate_acks`, but it cannot
  be the 560 GB in a query anyone would find by sorting `pg_stat_statements`.
- **A historical burst from the seeding runs in the 8-day pre-`pg_stat_statements`
  window: dead.** The measured current rate (1,427 files/day, 6.13 GB/day) is the
  same order as the lifetime average (2,153 files/day, 7.23 GB/day). The spill is
  ongoing, not a leftover.
- **Logical decoding spilling to disk: dead.** `pg_stat_replication_slots` reports
  `spill_txns = 0`, `spill_count = 0`, `spill_bytes = 0 bytes`.
- **The temporary tables in `app.drain_notifications` being the spill: dead as the
  bulk.** `local_blks_written` across all 4,768 entries is 1,984 blocks (15.5 MB).
  They are real catalog churn, four times a minute, but not 560 GB.
- **Application queues backing up: dead.** `net.http_request_queue` = 0 rows,
  `pgmq.q_notifications` = 0 rows.
- **Running out of the 500 MB free-plan allowance: dead.** 245 MB, 49.0%.
- **Deadlocks or lock/recovery conflicts driving the rollbacks: dead.**
  `deadlocks = 0`, `conflicts = 0`.
- **The autovacuum on `realtime.messages_2026_09_30` being a cause: dead.** It
  was vacuuming a 568 kB table. Symptom, not cause.

---

## Remediation

### (a) Free: query, schedule and function changes

Ordered by measured value. Nothing here needs a bigger instance.

**Suggested order of work:** A9 first (one free query, and it decides whether A4
is needed at all), then A1 + A3 together as one migration (they are the actual
outage fix), then A7's `REINDEX CONCURRENTLY` (no downtime, reclaims ~70 MB),
then B1 as a platform request, then A2, A6, A5, A8, A10, and A7's `VACUUM FULL`
in a window.

**A1. Give every tick an overlap guard. Highest value, smallest diff.**

`app.drain_notifications` already does this correctly at
`dek/supabase/migrations/0135_fanout_outside_the_lock.sql:157`:

```sql
if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('hearth_notif_drain')) then
  return;
end if;
```

The following have **no such guard** and therefore pile up. Add the same two
lines, with a distinct lock name, as the first statement of each body:

| function | file:line |
|---|---|
| `app.tick_30s()` | `dek/supabase/migrations/0136_stop_paying_for_nothing.sql:140` |
| `app.run_fanout_tick()` | `dek-backend/supabase/migrations/0057_fanout.sql:276` |
| `app.escalate_acks()` | `dek-backend/supabase/migrations/0055_coordination.sql:250` |
| `app.clear_expired_statuses()` | `dek-backend/supabase/migrations/0034_status_dnd.sql` (body above the `:163` schedule) |
| `app.nag_tasks()` | `dek-backend/supabase/migrations/0055_coordination.sql` (body above the `:1148` schedule) |

Measured justification: `tick-30s` at 35.12 s average on a 30-second schedule,
`fanout-tick` at 28.08 s on 15 s, `drain-notifications` at 36.44 s on 15 s.

**A2. Bound every cron job with its own `statement_timeout`.** `postgres` has no
`statement_timeout`, which is how single runs reached 347-350 s. Add to each
function definition:

```sql
... language plpgsql security definer set search_path = '' set statement_timeout = '10s' as $fn$
```

Same five files as A1. A job that cannot finish in 10 s should die rather than
hold a connection for 6 minutes.

**A3. Slow the two 15-second jobs down to at least their own runtime.**

```
dek/supabase/migrations/0136_stop_paying_for_nothing.sql:126
  select cron.schedule('fanout-tick', '15 seconds', 'select app.run_fanout_tick();');
  -> '1 minute'   (measured avg 28.08 s)

dek-backend/supabase/migrations/0014_notification_drain.sql:25
  select cron.schedule('drain-notifications', '15 seconds', $$select app.drain_notifications();$$);
  -> '1 minute'   (measured avg 36.44 s)

dek/supabase/migrations/0136_stop_paying_for_nothing.sql:157
  select cron.schedule('tick-30s', '30 seconds', 'select app.tick_30s();');
  -> '1 minute'   (measured avg 35.12 s)
```

This alone takes cron from 13 runs/min to 6/min, i.e. from 18,700/day to
8,640/day, and with A1 in place an overlapping run costs one indexed probe
instead of a 350-second connection hold.

**A4. Index the `escalate_acks` driving query.** This is the prime temp-spill
suspect: `message_ack_targets` has 8 live rows and 12,005 sequential scans
reading 37,890,585 tuples, and its join partner `public.messages` is a 139 MB
heap with no index on `ack_required`.

```sql
create index if not exists message_ack_targets_pending_idx
  on public.message_ack_targets (created_at)
  where reminded_at is null;

create index if not exists messages_ack_required_idx
  on public.messages (id)
  where ack_required and deleted_at is null;
```

Function to re-check after applying:
`dek-backend/supabase/migrations/0055_coordination.sql:250`.

**A5. Index the live-presence read.** The direct PostgREST table read
`FROM public.user_presence WHERE status <> $1 AND last_seen_at > ...` runs 63,482
times for 2,312.1 s (36.42 ms mean, 2.67% of all database time) against a table
whose only index is its `user_id` primary key. 270,255 sequential scans,
80,322,299 tuples read.

```sql
create index if not exists user_presence_live_idx
  on public.user_presence (last_seen_at)
  where status <> 'offline';
```

**Honest caveat:** `user_presence` holds 313 rows in 352 kB. Most of the 36 ms is
not the scan - it is the `presence_select` RLS policy re-evaluating a
`workspace_members` EXISTS subquery per row
(`dek-backend/supabase/migrations/0003_authz_rls.sql:181`). The index is cheap
and will help, but rewriting that policy to a set-returning subquery is the real
fix. I did not run EXPLAIN to confirm the plan, so treat the index as likely
rather than certain.

**A6. Turn pg_cron's logbook off, or prune it hourly.** `cron.log_run = on` costs
12,278,321 row writes, 2,164 MB of WAL and 63% of all transactions. Setting
`cron.log_run = off` removes all of it. If the history is wanted, the retention
is currently daily-at-02:11 keeping 7 days:

```
dek/supabase/migrations/0136_stop_paying_for_nothing.sql:163
  select cron.schedule('prune-cron-history', '11 2 * * *',
    $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
  -> '17 * * * *' with interval '1 day'
```

Also worth adding, because every time-filtered query against this table timed out
during this investigation:

```sql
create index if not exists job_run_details_start_time_idx
  on cron.job_run_details (start_time desc);
```

**A7. Reclaim the 139 MB. Do the no-downtime half first.**

`public.messages` is 63 MB heap + **77 MB of indexes**. The index half needs no
exclusive lock at all:

```sql
-- SHARE UPDATE EXCLUSIVE only: reads and writes continue. Reclaims ~70 of 77 MB.
reindex table concurrently public.messages;
reindex table concurrently public.channel_events;
reindex table concurrently public.message_ack_targets;
reindex table concurrently public.audit_log;
reindex table concurrently private.rate_counters;
```

Then the heap half, which does take `ACCESS EXCLUSIVE` and needs a window:

```sql
vacuum (full, analyze) public.messages;            -- 63 MB heap  -> ~2 MB expected
vacuum (full, analyze) public.channel_events;      -- 11 MB total -> ~1 MB expected
vacuum (full, analyze) cron.job_run_details;       -- 47 MB total -> ~8 MB expected
vacuum (full, analyze) public.message_ack_targets; -- 1880 kB for 8 rows
vacuum (full, analyze) public.audit_log;
```

Use `pg_repack` instead of `VACUUM FULL` if the lock is unacceptable. Taking the
working set from 186 MB to roughly 15 MB against 224 MB of `shared_buffers` is the
single largest performance win available on this plan, and it costs nothing.

Then run `analyze` across the database - `last_vacuum` is null on **every** table
and `read_state`, `audit_log` and `canvas_blocks` last saw autovacuum in
July/August.

Also reconsider `messages_nonce_uidx` (24 MB, the largest index on the table). It
exists to make the `on conflict (channel_id, author_id, client_msg_id) do nothing`
idempotency check in `send_message` work. It is 24 MB for 4,452 rows and it is
carried on the write path of every message. After the REINDEX it should be ~1 MB;
if it is not, it is worth asking whether client-side dedup can shrink it.

**A8. Fix the remaining `channels` full recompute.** `public.channels` has taken
188,129 new sequential scans since migration 0136 added its guard. The guard
suppresses the body when nothing moved, but the `update ... from (select ... left
join ... group by)` at
`dek/supabase/migrations/0136_stop_paying_for_nothing.sql:42` still recomputes
`viewer_count` for **every** channel whenever anything moved. Restrict the
recompute to channels that actually have a viewer row or a non-zero count.

**A9. Decide the temp-spill question before spending anything on it.** Run the
one query in "What could not be measured" item 1. If the answer is
`postgres_exporter`, the 560 GB is the cost of monitoring, not an application
defect, and the only action needed is to stop treating it as an incident signal.
That check is free and it prevents chasing a bug that may not exist.

Related and cheap: `pg_stat_statements` holds **4,768 of its 5,000** entry
maximum (95% full) and **937 of those entries are one-shot Management API
forensic queries**, each unique because the API appends a `-- date:` comment.
Those 937 entries are consuming 20% of the hash table and will start evicting real
application statistics. `select pg_stat_statements_reset()` after this
investigation is banked, or raise `pg_stat_statements.max`, so the next incident
has clean data.

**A10. Hardcoded credential.** `app.drain_notifications` embeds a literal
`Bearer sb_publishable_...` key and the project URL at
`dek/supabase/migrations/0135_fanout_outside_the_lock.sql` (the `net.http_post`
block, ~line 222). It is a publishable key so the severity is low, but it is a
hardcoded secret in a migration and the function already reads `push_drain_key`
from `vault.decrypted_secrets` twenty lines above. Read it from the vault the same
way.

### (b) Needs a bigger instance or a platform change

**B1. `cron.use_background_workers = off` is the structural fault, and changing
it needs a config change plus a restart.** With it off, every one of the
2,456,689 job executions opened a real libpq connection. The database has
recorded **2,776,764 sessions** since 2026-07-15 (35,800/day). With
`cron.max_running_jobs = 32` against `max_connections = 60`, cron can take 53% of
the connection pool. Turning background workers on removes the connection cost
entirely. This is the highest-value fix on the list and it is the one item here
that cannot be done from a migration.

**B2. `max_connections = 60` is too small for 387 concurrent users plus 32
possible cron slots plus PostgREST, GoTrue, Realtime and the reserved superuser
slots.** Raising it requires a compute addon. A1-A3 and B1 reduce demand enough
that this may not be needed, but the headroom is genuinely thin: on the free plan
387 users cannot each have a connection, so the arrival pattern is entirely
dependent on pooling working.

**B3. `work_mem = 2184 kB` is the reason the average temp file is 3.36 MB.** Any
sort or hash over ~2 MB spills. It is tied to the instance size. A7 reduces the
data that needs sorting, which is the free half of this.

**B4. `effective_cache_size = 384 MB`** tells the planner it has almost no cache,
biasing it toward sequential scans - which is consistent with 5,076,849 seq scans
of `channels` and 270,255 of `user_presence`. It rises with instance size.

**B5. Supabase Realtime's `SELECT m0."id" FROM realtime.messages WHERE id = ANY($1)`**
costs 1,597.7 s across 231,074 calls (1.84%) and hits the partitioned parent, so
every call touches every partition. Supabase-managed; not fixable from this
repo. The only lever is emitting fewer events.

---

## What could not be measured

Stated plainly so nobody re-derives a false confidence from this document.

1. **Attribution of the 560 GB of temp spill to specific statements.** This is
   the biggest open item. `pg_stat_statements` is complete (`dealloc = 2`) and
   accounts for 0.019% of the spill, so the cause is a statement class that view
   cannot record. Two candidates, neither confirmed:
   - **`postgres_exporter` scraping `pg_stat_statements` every ~60 s.** Fits
     best: measured cadence 1 file per 60.6 s, measured average 4.10 MB,
     and every `select ... from pg_stat_statements` on this box demonstrably
     spills ~4.5 MB. ~502 GB predicted against 521.8 GiB observed.
   - **`app.escalate_acks()` every 60 s.** Also fits the cadence, and its shape
     is a spiller (8-row table joined to a 139 MB heap, sorted by `created_at`,
     with `work_mem = 2184kB`, and 12,005 seq scans reading 37,890,585 tuples).

   **The one query that decides between them** timed out after five retries on
   three separate attempts as the database degraded during this session:

   ```sql
   select calls, temp_blks_written, round((total_exec_time/1000.0)::numeric,1) as total_s,
          left(regexp_replace(query,'\s+',' ','g'),110) as q
     from pg_stat_statements where query ilike '%pg_stat_statements%'
    order by calls desc limit 12;
   ```

   Run it first when the box is calmer. A six-figure `calls` count with ~570
   `temp_blks_written` means it is the exporter and there is no application bug
   here at all. A low count means it is `escalate_acks` and A4 is the fix.

   Definitive either way: set `log_temp_files = 0` (currently **-1**, off) and
   read the Postgres log through Supabase's Logs Explorer. That is not a SQL
   surface and was not available here.

2. **The exact split of the 8,338,627 lifetime rollbacks.** The current rate
   (0.19/s) matches failing cron runs tightly. The lifetime figure is 3.4
   rollbacks per cron execution, which the cron-failure model alone does not
   explain. `enforce_password_latch` raises and `statement_timeout`
   cancellations are both plausible additional sources and both are invisible for
   the same reason. Not resolved.

3. **`cron.job_run_details` aggregated over the outage window itself
   (14:00-15:30 UTC).** Every time-filtered aggregate timed out after 5 retries:
   there is no index on `start_time` and the table is 47 MB / 151k rows on a
   blocked box. The substitute sample covers 18:20-19:02 UTC - inside the
   degraded period, but about 4 hours after onset. The whole-table
   `group by status` count also did not return. A6's index would make this
   answerable next time.

4. **A rate for realtime insert volume during the incident.** The hourly
   breakdown of `realtime.messages_2026_09_30` timed out after 5 retries. Only
   the daily total (438 rows) was obtained - which is small enough that the
   hourly shape does not change any conclusion.

5. **How many accounts are actually latched**, so the rolled-back share
   attributable to `enforce_password_latch` is unquantified.

6. **No EXPLAIN plans were run.** `EXPLAIN` without `ANALYZE` is read-only and
   would have been safe, but on this box every probe cost 30 to 230 seconds and
   several timed out entirely, so counters were prioritised over plans. Both index
   recommendations (A4, A5) are therefore reasoned from table statistics and query
   text, not from a confirmed plan change.

7. **A measurement methodology warning for whoever reads this next.** Running
   four concurrent Management API queries against this database measurably made it
   worse: query latency went from 0.7-10 s to repeated 5-retry timeouts, and
   recovered when concurrency was dropped to one. Several of my own forensic
   queries are now the top temp writers in `pg_stat_statements` (90 MB of the
   103 MB) and each `select ... from pg_stat_statements` spills a ~4.5 MB temp
   file. Investigate serially.
