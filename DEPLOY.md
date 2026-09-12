# Where Dek lives, and how to ship it

## Read this first

**The front end is on Cloudflare Pages. It is not on GitHub Pages, and pushing to
GitHub deploys nothing.**

That sentence is at the top because this file used to be a guide to *moving* off
GitHub Pages, written before the move, and anybody skimming it came away with
"served straight off the main branch on GitHub Pages" and shipped a change by
pushing a commit. The move happened. The old address is gone.

| | what it is | where it lives | how it ships |
| --- | --- | --- | --- |
| **Front end** | this repo. HTML, CSS, JS. No build step, no bundler, no server. | **Cloudflare Pages**, project `dek`, at `https://dek-7o4.pages.dev` | `npm run deploy` |
| **Back end** | Postgres, sign-in, realtime, file storage, Edge Functions | **Supabase**, project `ybddogqphinruyunnuwx` | `node scripts/db-query.mjs -f <migration>.sql`, `npx supabase functions deploy <name>` |
| **GitHub** | `github.com/UbhayAab/soop`, private | source history only | `git push`. **Deploys nothing.** |

There is no Git integration on the Pages project - `wrangler pages project list`
shows `Git Provider: No` - which is exactly why a push is not a deploy. The
upload is direct, from your machine, of a staged copy of the working tree.

## Shipping a front-end change

```bash
npm test          # syntax, encoding, shell audit
npm run probe     # the standing probe suite (playwright, takes a few minutes)
npm run deploy    # -> Cloudflare Pages project "dek"
```

`npm run deploy` is `scripts/deploy-web.mjs`. It does not upload the repository.
It copies the working tree into a temp directory **minus** `scripts/`,
`supabase/`, `docs/`, `qa/`, `node_modules/`, every `.md`, every `.sql` and every
`probe-*.mjs`, refuses to continue if `index.html`, `sw.js`, `js/` or `css/` went
missing, and hands that directory to `wrangler pages deploy --project-name=dek`.
Read the comment at the top of that file before changing the deny list: the
version of this that uploaded the whole repo was serving the entire database
schema and a working demo password at guessable URLs.

`--dry` stages without uploading and prints the path, if you want to look at
exactly what would go out.

### Two things that have to move with the front end

- **`sw.js` `VERSION`.** Bump it in the same commit as any change to `js/` or
  `css/`. The service worker precaches the whole shell; without a new version key
  an installed PWA serves the old bundle out of its own cache and the deploy
  looks like it did nothing.
- **Any migration the new code needs.** Deploy the SQL *first*. The client
  degrades politely when an RPC is missing - `tryRpc` swallows it and the feature
  switches itself off - so the failure mode of the wrong order is a feature that
  silently is not there, which is harder to spot than an error.

### Wrangler auth

Wrangler is logged in on this machine via OAuth (`pages:write` is in the stored
scopes). If it ever asks again:

```bash
npx wrangler login          # opens a browser
npx wrangler whoami         # confirms which account
npx wrangler pages project list
```

`CLOUDFLARE_API_TOKEN` in the environment also works and is what a CI runner
would use.

## Why Cloudflare and not Pages

One reason, and it is narrow but it is real.

Dek is embeddable, which means it runs inside an iframe on other people's
dashboards. The browser has to be told **which pages are allowed to frame it**.
There is exactly one way to say that: a response header,
`Content-Security-Policy: frame-ancestors`.

GitHub Pages cannot send custom response headers. At all. There is no setting, no
file, no workaround. And the header is deliberately **ignored** when you put it in
a `<meta>` tag, so the usual static-site trick does not apply either.

Without it, any page on the internet could load a signed-in Dek in an invisible
iframe and steer somebody's clicks into it. There is a script-level refusal in
`js/embed.js` that catches this and it stays, but it is script running inside the
frame. The header stops the frame being drawn at all. Both, neither relying on
the other.

`_headers` in this repo is the file that produces those headers on Cloudflare.

### Checking the headers actually arrived

F12 -> **Network** -> reload -> click the top row -> **Headers**. Under Response
Headers:

```
content-security-policy: frame-ancestors 'self' http://localhost:8098 ...
referrer-policy: strict-origin-when-cross-origin
x-content-type-options: nosniff
```

If those are there, the whole reason for being on Cloudflare is working.

## A custom domain

Pages project -> **Custom domains** -> **Set up a custom domain** -> e.g.
`dek.jarurat.care`. If the domain's DNS is already at Cloudflare it is one click.

Worth doing, and not only for the nicer address: if the dashboard embedding Dek
is at `dash.jarurat.care` and Dek is at `dek-7o4.pages.dev`, those are different
**sites**, and every browser now partitions storage between them. It works, but
the panel gets isolated storage per dashboard and Safari wipes it between
launches. Same registrable domain, and that entire class of problem disappears.

After adding one, update **Site URL** and **Redirect URLs** in Supabase ->
Authentication -> URL Configuration, and `SOOP_APP_ORIGIN` in the Edge Function
secrets.

## The `_headers` file needs your real dashboard origins

Open `_headers` and find the line marked `>>> EDIT THIS LINE`. Every dashboard
that will embed Dek needs its origin listed there, **and** in `EMBED_ORIGINS` in
`js/config.js`, **and** in the `allowed_origins` column when you register it.

Three lists on purpose. They fail differently, which is how you tell which one
you forgot:

| missing from | what you see |
| --- | --- |
| `_headers` | blank panel; the browser refuses to draw the frame |
| `js/config.js` | panel loads, spins 15 seconds, then asks for a password |
| `allowed_origins` | the Edge Function log says `origin not registered` |

---

## The back-end checklist (separate from the front end)

None of this is affected by where the front end lives. It is the work that makes
credential passthrough and the new task features actually function. It has
**never been run against your live project**, so go carefully.

### 1. Check the table names before running anything

The migrations were written by reading the client code, because the database
schema is not in this repository. Run this first in the Supabase SQL editor:

```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('organizations','workspaces','workspace_members','channels','tasks');
```

You should get five rows. If any name differs, tell me and I will correct the
migrations rather than you editing SQL you did not write.

### 2. Run the migrations

The fast way, and the one used here, is `node scripts/db-query.mjs -f
supabase/migrations/<file>.sql`. It reads the project ref and a management token
from `hearth/.env.local`, never prints either, and runs the file as one
statement batch. The Supabase dashboard's **SQL Editor** does the same job if
you would rather paste.

Already applied to the live project; listed so a fresh project can be brought up
to the same state, in this order:

- `supabase/migrations/0100_embed_registry.sql` - the dashboard registry and the
  one call that makes a team's server exist
- `supabase/migrations/0101_tasks_v2.sql` - progress log, blockers, triage,
  started_at, priority
- `supabase/migrations/0119_direct_calls.sql` - direct calls: ringing one person
  (or two) instead of walking into a voice room. Nothing else depends on it, and
  until it is run the app simply does not offer a call button - `get_active_call`
  answers "no such function" once per sign-in and calling switches itself off,
  the same way every other optional RPC in this codebase degrades.
- `supabase/migrations/0120_dm_reactions_and_admin_badges.sql` - two things the
  UI offered and the database could not do. `public.dm_message_reactions` plus a
  `toggle_reaction` that routes by which table the message id lives in, so the
  reaction bar that has always been drawn on a DM finally works instead of
  answering "forbidden"; and `is_admin`/`is_owner` per member in `get_bootstrap`
  plus `get_member_badges`, an RPC any member may call, so the Admin badge beside
  a name is visible to the people who need to know who to ask rather than only to
  admins (the Members panel used to work it out by reading `member_roles`, which
  RLS hides from everybody else).

- `supabase/migrations/0121_dm_reaction_rpc.sql` and
  `0122_space_admins.sql` - the same three fixes from a parallel branch,
  renumbered. Additive on top of 0120; each says at its top why it moved.
- `supabase/migrations/0123_reconcile_dm_reactions_and_admins.sql` - the merge of
  the two. `private.space_admin_ids` becomes the one answer to "who runs this
  Space", read by both `get_member_badges` and `get_bootstrap` so the first paint
  and every refresh cannot disagree; and `toggle_reaction` gains the
  deleted-message and personal-block rules.
- `supabase/migrations/0124_push_drain_actually_sends.sql` - **push notifications
  had never been delivered once.** The drain authenticated with the publishable
  key against a function that requires the service role (403, every fifteen
  seconds, 1438 of them in six hours), and sent `{}` where the contract is
  `{user_ids,title,body,url}`. Needs two things this file cannot do for you:
  a Vault secret `push_drain_key` and the matching Edge Function secret
  `PUSH_DRAIN_SECRET`, and a redeploy of the `web-push` function
  (`node scripts/deploy-fn.mjs web-push`). Without the Vault row the drain logs a
  warning and does nothing, rather than hammering the function.
- `supabase/migrations/0125_activity_includes_dms.sql` - the Activity tab was
  correctly empty: `get_activity` covered channels only, and across this whole
  database 126 messages have ever contained a mention. Adds direct messages.
- `supabase/migrations/0126_later_board.sql` - `create_task_in_channel` (a task
  could not be written down without first finding a message), `claim_task`
  (unclaimed work could not be picked up), `team_workload` (there was no view of
  anybody but yourself), and an `unclaimed` filter on `list_tasks`.
- `supabase/migrations/0127_org_form_templates.sql` - org-level form templates
  plus a searchable import, so a leave-request form is written once and posted
  into any channel of any server in the same organisation.
- `supabase/migrations/0128_activity_read_state.sql` - per-item read state, so an
  Activity item can be cleared without opening what it points at.
- `supabase/migrations/0129_labels_and_away.sql` - `message_labels` and
  `toggle_message_label` (Important, High priority, Pending, Blocked, FYI), and
  the first cut of `away_days`.
- `supabase/migrations/0130_leave_management.sql` - leave stops being a display
  and becomes a system: `leave_policies` per organisation (2 auto-approved days a
  month, a 15-day ceiling on one application, and which kinds spend the
  allowance, need approval or are always raised), `apply_leave`, `decide_leave`,
  `flag_leave`, `cancel_leave` (which marks rather than deletes, so the ledger
  survives), `leave_balance`, `list_leave` and `leave_inbox`. `away_days` gains
  status, flags, a decision and a generated `days`.
- `supabase/migrations/0131_leave_reaches_people.sql` - the half that makes
  anybody find out: pushes to approvers and back to the applicant, a `leave` arm
  in `get_activity` (**this one drops and recreates `get_activity` to add a
  `ref_id` column**, so it is the one file here that is not a pure
  `create or replace`), the profile status following an approved leave, and a
  nightly `sync-leave-statuses` cron job at 18:40 UTC - 00:10 Asia/Kolkata - for
  leave booked in advance.

All of them are written to be safe to run twice.

### The two things that are NOT a migration

`0124` only works if both halves of the push credential exist. If you are
standing a fresh project up:

```sql
select vault.create_secret('<a long random string>', 'push_drain_key',
  'Shared secret app.drain_notifications sends to the web-push function.');
```

then set the SAME value as the Edge Function secret `PUSH_DRAIN_SECRET` (the
Supabase dashboard, or POST it to `/v1/projects/<ref>/secrets`), and redeploy the
function. Check it worked with `select status_code, count(*) from
net._http_response group by 1` - a row of 403s means the two values disagree, and
a row of 200s means push is live. That one query is how all four faults in the
push chain were found.

0119 leans on four things that are already in your database and are NOT in this
repository. Check them before running it, because a missing one is a migration
that half-applies:

```sql
select 'uuidv7' as needs, count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'util' and p.proname = 'uuidv7'
union all select 'app.emit', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app' and p.proname = 'emit'
union all select 'rate_limit', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'private' and p.proname = 'rate_limit'
union all select 'conversations', count(*) from information_schema.tables
 where table_schema = 'public' and table_name in ('conversations','conversation_members');
```

Four rows, each count 1 except `conversations` which is 2. If any is 0, stop and
say so rather than editing the migration.

After it runs, the whole feature is verifiable in one go from two browsers signed
in as two people: open a direct message, press the handset in the channel bar,
and the other browser should ring. If it rings and connects but neither person
hears anything, that is TURN, not signalling - see the note below.

#### If a call connects but nobody can hear anything

That is the relay, and it is the one failure in this feature with no error
message anywhere. Audio is peer to peer; on a permissive network the two browsers
reach each other directly, and behind carrier-grade NAT - which is what Jio and
Airtel mobile data are - they cannot, so a relay has to stand in the middle. The
relay credentials come from the `dek-turn` Edge Function:

```bash
supabase functions deploy dek-turn
```

Until it is deployed, both voice rooms and calls are STUN-only: they work on
office wifi and fail silently on mobile data. Note that this path had never
actually worked - the fetch built its Authorization header from an un-awaited
promise and sent the literal string `Bearer [object Promise]` - so if you have
been told "voice does not work on phones", this is very likely why. It is fixed
in `js/core/rtc.js`, but the function still has to be deployed for it to matter.

### 3. Deploy the Edge Functions

```bash
supabase login
supabase link --project-ref ybddogqphinruyunnuwx

supabase secrets set SOOP_APP_ORIGIN='https://dek-7o4.pages.dev'
supabase functions deploy soop-handoff --no-verify-jwt
```

`--no-verify-jwt` is required and is not a hole: the whole point of that function
is that the caller does not have a Supabase login yet. An HMAC signature is what
authenticates it.

Jira is optional and only if you actually use Jira:

```bash
supabase secrets set JIRA_BASE_URL='https://yourcompany.atlassian.net'
supabase secrets set JIRA_EMAIL='you@yourcompany.com'
supabase secrets set JIRA_API_TOKEN='<from id.atlassian.com/manage/api-tokens>'
supabase functions deploy soop-jira
```

### 4. One edit to a function that is not in this repo

`list_tasks` lives in your database, not here. For the new task columns to reach
the client, add these to its select list:

```sql
started_at, priority, origin, due_precision, due_string,
task_category(state, done_at) as category
```

Everything degrades gracefully without this - the forecast falls back to
`created_at`, the priority glyph does not draw - so it is not urgent, but the
numbers get better with it.

### 5. Revoke the old demo token

`js/config.js` used to export a live open-invite token for a 1770-member Space,
served to every visitor. The export is gone, but the value is in git history and
in every copy of that file ever served, so it has to be revoked server-side.
Rotating it does not help for the same reason.

### 6. Register your first dashboard

Only once you actually have a dashboard to embed into:

```sql
select * from public.register_embed_host(
  'tech-dashboard', 'Tech dashboard', '<your org uuid>', 'Tech',
  array['https://dash.jarurat.care']);
```

It prints a secret **once**. Put it in the Edge Function and in the dashboard's
backend:

```bash
supabase secrets set EMBED_SECRET_TECH_DASHBOARD='<the secret>'
```

The rest of that flow, including the ten lines the dashboard's backend needs, is
in `EMBED.md`.
