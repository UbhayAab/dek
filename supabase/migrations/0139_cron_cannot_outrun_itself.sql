-- 0139: make it impossible for a cron job to outrun its own schedule.
--
-- THE OUTAGE THIS CLOSES. 2026-09-30, 20:00 IST. Everybody opened Dek at once
-- and it loaded for nobody. The cause was not the connection cap, not Realtime,
-- and not the size of the data. It was pg_cron scheduled faster than it can run,
-- with no upper bound on any single run. Measured over the newest 300 runs:
--
--   job                      schedule   avg run   max run   failed
--   drain-notifications       15 s       36.4 s    350.0 s   81%
--   fanout-tick               15 s       28.1 s    349.6 s   79%
--   tick-30s                  30 s       35.1 s    347.1 s   80%
--   clear-expired-statuses     1 min     29.9 s    343.6 s   86%
--   nag-tasks                  1 min     30.5 s    278.0 s   86%
--   escalate-acks              1 min     27.3 s    242.7 s   81%
--                                                  -------
--                             300 runs sampled, 246 failed = 82%
--
-- Three unrelated jobs sharing a ~350 s maximum is the tell: they were all
-- blocked on the same resource for about six minutes. With
-- cron.use_background_workers = off, each overlapping run takes another libpq
-- connection, so cron alone can hold 32 of this instance's 60. Cron accounted for
-- 27.9% of all database execution time while nobody could send a message.
--
-- And the asymmetry that turned "slow" into "down": the cron role has no
-- statement_timeout at all, while `authenticated` and `authenticator` are capped
-- at 8 s. Cron was allowed to run for 350 seconds while every user request was
-- cancelled at 8. The database was never deadlocked - it was busy, and only the
-- users were punished for it.
--
-- 0136 is the direct predecessor and it is where two of these schedules come
-- from (fanout-tick at :126, tick-30s at :157). It was written to stop cron
-- costing money for nothing and it already noticed the symptom - its own header
-- counts 37 'job startup timeout' rows in cron.job_run_details. It reduced how
-- OFTEN the work ran. It never bounded how LONG a run may take, so the overlap
-- survived and this is the half that was missing.
--
-- THE GUARANTEE, and why it is a guarantee rather than a hope:
--
--     statement_timeout (45 s)  <  schedule interval (60 s)
--
-- A run that cannot last longer than 45 seconds cannot still be running when the
-- next tick arrives 60 seconds later. Self-overlap stops being something to
-- monitor and becomes something that cannot happen. That is strictly stronger
-- than the advisory lock 0135 added to drain_notifications, which only makes a
-- second run exit quietly while the first is still free to take six minutes.
-- Keep that lock - it guards a manual invocation racing the schedule - but the
-- bound is what fixes this.
--
-- WHAT THIS COSTS, said plainly rather than buried. Notification drain and fanout
-- move from every 15 seconds to every minute, so a push notification can be up to
-- a minute late instead of up to fifteen seconds late. That is a real regression
-- and it is deliberate: a notification 45 seconds late beats an app that does not
-- load. The 36-second averages above were measured on a starved nano instance; on
-- real compute these should finish in low single digits. So after the instance is
-- resized, MEASURE again and tighten back toward 15 s if the numbers support it.
-- The ordering invariant is the only rule that must survive: never shorten a
-- schedule without lowering the timeout to stay under it.
--
-- Idempotent. Nothing here reads or writes application data.

-- ---------------------------------------------------------------- 1. the bound
--
-- ALTER FUNCTION ... SET is used deliberately, because it needs no knowledge of
-- any function body. These six are defined across two repositories and eight
-- migrations; reproducing their bodies here to insert a guard is how a "fix"
-- silently reverts behaviour that was added somewhere this file cannot see. A
-- per-function GUC attaches to the function, applies to the cron role that has no
-- timeout of its own, and survives any later CREATE OR REPLACE that does not
-- itself set it.
--
-- Matched by name across every argument signature, so an overload cannot be
-- missed, and a rename raises instead of silently skipping.
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'app'
       and p.proname in ('drain_notifications', 'run_fanout_tick', 'tick_30s',
                         'clear_expired_statuses', 'nag_tasks', 'escalate_acks')
  loop
    execute format('alter function %s set statement_timeout = %L', r.sig, '45s');
    raise notice '0139: bounded %  statement_timeout=45s', r.sig;
    n := n + 1;
  end loop;

  if n = 0 then
    raise exception '0139: none of the six scheduled functions exist in schema app. '
                    'They were renamed or moved; find them and bound them, because an '
                    'unbounded cron function is what took the app down on 2026-09-30.';
  end if;
  raise notice '0139: bounded % scheduled function(s)', n;
end $$;

-- ------------------------------------------------------------- 2. the schedules
--
-- cron.alter_job only rewrites cron's own metadata, so this is instant and cannot
-- stall on a busy database. That matters: this migration has to be applicable
-- while the instance is already in the state it is meant to fix.
--
-- Matched on jobname, never a hardcoded jobid: ids differ between this project
-- and any rebuild of it, and the wrong id would quietly retime the wrong job.
-- Jobs not named here are left exactly as they are.
do $$
declare
  r record;
  want text;
  n int := 0;
begin
  for r in select jobid, jobname, schedule from cron.job loop
    want := case r.jobname
      -- Each of these is now strictly longer than the 45 s bound above.
      when 'drain-notifications'     then '* * * * *'
      when 'fanout-tick'             then '* * * * *'
      when 'tick-30s'                then '* * * * *'
      when 'clear-expired-statuses'  then '* * * * *'
      when 'nag-tasks'               then '* * * * *'
      when 'escalate-acks'           then '* * * * *'
      else null
    end;
    if want is null then continue; end if;
    if r.schedule = want then
      raise notice '0139: % already on %', r.jobname, want;
    else
      perform cron.alter_job(job_id => r.jobid, schedule => want);
      raise notice '0139: % rescheduled  %  ->  %', r.jobname, r.schedule, want;
    end if;
    n := n + 1;
  end loop;
  if n < 6 then
    raise warning '0139: only % of the 6 expected jobs were found. Check cron.job '
                  'against the table in this header before trusting the invariant.', n;
  end if;
end $$;

-- ------------------------------------------------- 3. make the logbook readable
--
-- cron.job_run_details had grown to 47 MB and roughly 151,000 rows - 19% of a
-- 245 MB database, and the reason every time-filtered question about the outage
-- window timed out during the investigation.
--
-- 0136:161-164 ALREADY schedules `prune-cron-history` nightly to delete rows
-- older than seven days, so this is deliberately NOT a second prune job. The
-- reason the table is still 47 MB is not that rows are never deleted - it is that
-- DELETE leaves dead tuples behind and the space is only returned by a VACUUM.
-- Worth checking too whether `prune-cron-history` is itself among the 82% of runs
-- that fail, in which case nothing has been pruned at all; it is one of the jobs
-- this migration does not retime, because it runs once a day.
--
-- The missing piece is an index: every question asked of this table during the
-- incident was "what happened between these two times", and each was a sequential
-- scan over 151,000 bloated rows on a starved instance. It is NOT created here,
-- and that is a deliberate choice rather than an omission. A plain CREATE INDEX
-- takes ACCESS EXCLUSIVE on cron.job_run_details, and EVERY cron run writes to
-- that table - so on an instance already this slow, building it inline would block
-- all six jobs for the duration and could make the very pile-up this migration
-- exists to stop. It belongs in the supervised list below, CONCURRENTLY, which
-- cannot run inside a transaction block and so cannot live in this file at all.
--
-- Sections 1 and 2 above are both pure metadata changes and complete in
-- milliseconds. That is the whole point: this migration has to be applicable
-- while the database is in the state it is meant to fix.

-- --------------------------------------------------------- 4. what comes next
--
-- Deliberately NOT in this migration, because each wants a human watching it and
-- none of them can be allowed to take a long lock while the instance is starved:
--
--   * create index concurrently job_run_details_start_time_idx
--       on cron.job_run_details (start_time desc);
--       Run it on its own, outside any transaction, once the box is breathing.
--
--   * reindex table concurrently public.messages;
--       139 MB for 4,452 live rows, of which 77 MB is index - residue of a
--       150,000-row seed.mjs load test (n_tup_ins 179,719 / n_tup_del 301,079).
--       CONCURRENTLY holds only SHARE UPDATE EXCLUSIVE so it stays online, but it
--       is long. Reclaims roughly 70 MB. Follow it with vacuum (analyze) on the
--       heap, and expect the planner to get noticeably better statistics.
--
--   * cron.use_background_workers = on. Needs a platform restart and is the only
--       structural fix for cron competing with users for the same connection
--       slots instead of using background workers.
--
--   * app.drain_notifications carries a hardcoded `Bearer sb_publishable_...` in
--       its net.http_post block (0135). Twenty lines above, the same function
--       reads push_drain_key out of vault.decrypted_secrets. Move it there.
--
--   * app.drain_notifications is also the single largest WAL producer measured:
--       3,257 MB over 395,581 calls, 8.44 kB of WAL per call, 655,079 full-page
--       images. Once the schedule change lands, re-measure it; if the per-call
--       WAL is still that high, the function is rewriting more than it needs to.
select '0139 applied: cron can no longer outrun its own schedule' as result;
