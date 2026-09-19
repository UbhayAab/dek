# dek

Dek - invite-only team chat: channels, threads that stay out of the way,
high-fidelity media. Static front end (no build step), Supabase for
Postgres/Auth/Realtime, Cloudflare Pages/R2/TURN on the edge. The service
worker in `sw.js` precaches the whole shell for offline use.

**Deploying is `npm run deploy`, which uploads to Cloudflare Pages.** `git push`
ships nothing: the Pages project has no Git integration, and the app has not been
on GitHub Pages since August 2026. See [DEPLOY.md](DEPLOY.md).

## Voice: rooms and calls

Two different things, on one peer mesh (`js/core/rtc.js`).

A **voice room** is a place. It sits in the sidebar, it is always open, and you
walk into it. Good for a standup, useless for reaching one person - nobody sits
in a room waiting to be found.

A **direct call** rings somebody. It is the handset in the channel bar of a
direct message, `Call` on a person's card, or `/call`. It rings for 45 seconds
with a sheet, a tone and a vibration, it can be answered or declined, and it
leaves a line in the conversation saying what happened. Up to three people; past
that the mesh is the wrong shape and the answer is a room.

Rooms broadcast their SDP on the room's own realtime topic. Calls have no such
topic, so their signalling goes through the `call_signal` RPC and comes back on
`user:<uid>` - the per-person topic every client already holds. That needs
`supabase/migrations/0119_direct_calls.sql`; without it the app quietly offers no
call button. `npm run probe -- --only call` is the test that matters here: it
builds two real peer connections in one page and fails unless audio bytes
actually arrive, because a call that connects and carries silence looks exactly
like one that works.

## Run it locally

```
npm install                # playwright + wrangler devDeps only, no app deps
npx playwright install chromium   # once, for the smoke/probe runners
python -m http.server 4173 # or any static server from the repo root
```

There is no bundler: edit files, reload.

## Standing toolchain

Six scripts under `scripts/` are the repo's guards and runners. `npm test`
runs the three gates; everything else is one command each.

| Command | Script | What it does |
|---|---|---|
| `npm test` | check-syntax.mjs, fix-encoding.mjs --check, audit-shell.mjs | The three gates below, chained; nonzero exit blocks a landing |
| `npm run smoke` | smoke.mjs | Boots its own static server (dynamic port, guaranteed teardown), loads headless Chromium, writes `s/smoke.png`, exits 1 on any pageerror |
| `npm run probe` | probe-all.mjs | Discovers every `probe-*.mjs` in root + scripts/, serves ports 4177 and 8098, runs the suite serially, gates on exit codes (`--only name`, `--timeout s`) |
| `npm run audit` | audit-shell.mjs | Shell/offline integrity audit (details below) |
| - | screenshot.mjs | Ad-hoc shot of any URL (`--url`, `--out`, `--device`, `--dark`, `--full-page`) |
| - | fix-encoding.mjs | Mojibake repair sweep: report-only by default, `--apply` repairs in place, `--check` is the gate mode |

The three gates:

1. **Syntax** - `node --check` over every .js/.mjs outside node_modules/.git.
   New top-level JS lands guarded by default.
2. **Encoding** - fails on repairable double-encoded UTF-8 ("mojibake") runs
   or text files that are not valid UTF-8 at all. BOMs print as `[bom]` lines
   but do not fail: pre-existing ones are valid UTF-8 and harmless.
3. **Shell audit** - exit 1 = do not ship. Checks that every local asset
   index.html references is in sw.js SHELL_FILES, every SHELL_FILES entry
   exists on disk, every FEATURES name in js/features/index.js is precached,
   VERSION matches dek-v<N>, and every js/features/*.js on disk is registered
   or imported somewhere (a file nobody references loads never and says
   nothing).

## CI

`.github/workflows/integrity.yml` runs `npm test` on push, PR and manual
dispatch. `.github/workflows/backup-cron.yml` handles the weekly database
dump and daily keepalive.

## Optional pre-commit hook

The encoding gate can also fire locally before each commit. Opt in once per
clone (never enabled silently):

```
git config core.hooksPath .githooks
```

## Conventions

- Commit messages: plain sentence, why over what.
- No em or en dashes anywhere in the repo - plain hyphens only.
- All text files UTF-8 without BOM.
- sw.js VERSION bumps to a fresh dek-v<N> whenever shell CONTENT changes;
  feature-module assets are network-first, so JS-only edits inside features
  do not need a bump.
