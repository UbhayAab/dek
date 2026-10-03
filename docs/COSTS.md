# Dek cost model (PRD OPS15, OPS16)

Rate date 2026-10-03, USD, before taxes. Plan facts come from the live Management API on
that date; usage facts were measured on the legacy project. Re-check against the Supabase
invoice after the first full month.

## 1. What is being paid for

| Item | Plan or rate | Dek's share |
|---|---|---|
| Supabase Pro organization "UbhayAab's Org" (`qmlenovxatoyxxqlvzlo`) | USD 25 a month, includes USD 10 compute credit | shared with Patient Navigator and UbhayPDB |
| Compute, project `dek` (`nxljuctnauhgzekvmftp`), Micro (2 shared vCPU, 1 GB, 60 direct and 200 pooled connections) | USD 0.01344 an hour, about USD 10 a month | USD 10 |
| Cloudflare Pages (static app, `dek-7o4.pages.dev`) | free plan | 0 |
| Cloudflare TURN relay (calls on restrictive networks) | first 1,000 GB a month free, then USD 0.05 per GB | 0 at measured volume |
| JCF Mailer on AWS SES (sign-in codes only) | the mailer's existing SES account | under USD 0.10 a month |
| Google Play developer account | USD 25 once | 25 once |
| Apple Developer Program | USD 99 a year, or a nonprofit fee waiver if approved | 0 to 99 a year |

Organization total after the move: base 25 + compute 3 projects x 10 - credit 10 = **USD 45 a
month**, up from USD 35. Each further project moved into this org (Arc, Carcinome) adds about
USD 10. The free legacy project costs nothing and pauses itself after a week without traffic.

## 2. Measured usage (legacy project, two real orgs)

| Measure | Value |
|---|---|
| Accounts | 391 (327 members of the two real orgs) |
| Signed in within 7 days / 1 day | 97 / 8 (sessions persist, so sign-ins understate use) |
| Messages a week, last 4 weeks | 131, 462, 323 (about 60 a day) plus DMs |
| Peak arrival | about 387 people opening Dek at 20:00 on 2026-09-30 |
| Database | 133 MB after the 2026-10-03 reindex, of which real data is under 20 MB |
| Files | 73 objects, 117 MB |
| Push subscriptions | 135 from 110 people |

## 3. Pro allowances against Dek's load

| Meter | Included per org per month | Dek estimate now | Dek at 10x | Overage rate |
|---|---|---|---|---|
| Database size | 8 GB per project | under 0.1 GB | under 1 GB | USD 0.125 per GB |
| File storage | 100 GB | 0.12 GB | 2 GB | USD 0.021 per GB |
| Egress | 250 GB | under 5 GB | under 40 GB | USD 0.09 per GB |
| Realtime messages | 5 million | about 0.3 million (60 messages a day x about 100 recipients x 30, plus typing and read sync) | about 3 million | USD 2.50 per million |
| Realtime peak connections | 500 | about 400 at 20:00 (one socket per browser through the leader tab) | over 500 | USD 10 per 1,000 |
| Edge Function invocations | 2 million | about 5,000 (one push dispatch per message, uploads, TURN) | 50,000 | USD 2 per million |
| Monthly active users | 100,000 | 400 | 4,000 | n/a |

The one meter that can bind is **realtime peak connections**: 500 included, and the 20:00
arrival is about 400 people. With the spend cap ON (default) connections above 500 are refused;
with it OFF they cost USD 10 per extra 1,000 peak. Recommendation: leave the cap on, watch the
peak (section 5), and turn it off only if the peak passes 450.

## 4. Scenarios

| Scenario | Monthly | Notes |
|---|---|---|
| Today, Micro | USD 45 org total (Dek's increment USD 10) | measured load is light; the 2026-09-30 failure was cron on a free nano instance |
| Next release target (load test: 300 sustained, 500 burst) | USD 45 to 50 | Small compute (USD 15) only if the load test misses its p95 targets on Micro |
| Growth (10x messages, 1,000 people) | USD 55 to 70 | Small compute, spend cap off for connections over 500 |
| Recovery point objective of 1 hour (PRD OPS17 proposal) | add USD 100 | point-in-time recovery, 7 days; NOT bought. Pro's daily backups give an RPO of 24 hours, and a weekly logical dump adds an off-platform copy |

One-time: Google Play USD 25; Apple USD 99 a year unless the nonprofit waiver is granted; a Mac
or a macOS build service for the iOS build (not owned; a cloud Mac is roughly USD 1 an hour
for the build hours needed).

## 5. Watching it

- Supabase usage page of the org, and `node tools/db.mjs sql` against `pg_stat_database` for
  database size.
- Realtime peak connections: Supabase Realtime reports in the dashboard; the load test in
  `docs/LOAD.md` measures sockets per person.
- Alert thresholds proposed for decision GQ16: email Ubhay at USD 60 a month for the org.

## 6. Alternative considered (OPS16)

AWS managed Postgres (RDS db.t4g.micro about USD 12 a month plus storage) would need a
replacement for Auth, Realtime, Storage and Edge Functions, patching, backups and monitoring
that Supabase includes; operator time dominates the saving. Not recommended at this scale.
