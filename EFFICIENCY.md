# Dek on the Supabase free plan

Produced by an 11-agent pass: 7 cost-centre analyses of the real code, then 3
adversarial reviews (user experience, correctness, arithmetic), then a ranking.
Kept in the repo because the measurements are expensive to reproduce and the
rejected list is the evidence that quality was not traded for quota.

**STATUS 2026-08-24 (post-execution refresh).** Ranks 1-9 and most of the client-side
half of 10-26 have landed. The analysis text below each rank is kept as written because
the measurements still explain WHY each change was worth making, but the defect
descriptions and file line numbers in ranks 2-22 have drifted or been overtaken by the
fixes themselves - read the status column before acting on any section. The remaining
work is almost entirely server-side (needs a deploy window and tokens).

| Rank | Status |
|---|---|
| 1 | DONE pre-doc / P0 batches (2026-08-22) |
| 2 | DONE commit 06acf1f (local clear + signature hardening) |
| 3 | ALREADY LANDED when audited - one merged visibilitychange handler existed all along (presence.js:290); see banner on the section |
| 4 | (a) ALREADY LANDED b112f3b-era; (b)+(c) DONE commit f1df785 |
| 5 | (a) fixed earlier; (b)+(c) DONE commit b95cf6f |
| 6 | In-repo half DONE commit 877875a (all five functions + mint-download allow-header completion); DEPLOY BLOCKED on tokens |
| 7 | DONE commit 6e1e380 (projection + snapshot delta merge) |
| 8 | NOT DONE - server-side index, needs deploy |
| 9 | Client half DONE (signed-URL IndexedDB cache + batched mint-download POST, media.js); server expires_at/array return still pending deploy |
| 10 | DONE commit 8f6e242, stale-while-revalidate form (sha256 claim unconfirmable from this repo), LRU cap + sign-out wipes included |
| 11 | DONE commits e644d57 + fbb5efb: uploads mint a second 700px content-addressed thumb through mint-upload, thumb_key rides the message jsonb attachments, inline img prefers it while lightbox/Save keep the full key, whole block failure-isolated; dimensions reporting verified already landed (probeDims feeds finalizeAttachment width/height/duration_ms). probe-thumb.mjs PROBE CLEAN 10/10. |
| 12 | DONE commit 6e650fb (debounceLead coalescing, {open} bypass kept) |
| 13 | DONE commit 64e256b (visibility guard, 30s, backstop %4) |
| 14 | DONE commit e6d4b34 (a+b) |
| 15 | DONE commit a53d39f (store.presenceStatus map; status.js network code deleted) |
| 16 | DONE commit a7ef3e3 (hidden tabs stop claiming viewer_count; event beats debounceLead(10s)) |
| 17 | NOT DONE - server-side, needs deploy window |
| 18 | a+b+d DONE commit 23a67d0; c NOT DONE (embed_sweep_tickets sampling is server-side) |
| 19 | DONE commit 6a382f9 (TABLE_COLUMNS for six tables + resync chunking) and cc2e27e (heal fetch projected with drift-guard fallback); profiles deliberately excluded - whole-row store paths still exist |
| 20 | NOT DONE - rejected three times for headless verifiability (WebRTC state changes need a real call) |
| 21 | DONE commit 11c15b0 (send-side retract, receiver clear on message:new, 800ms gate, race fix) |
| 22 | DONE commit 1b9d0e5 (coalescing + dm:receipts listener pre-existed b112f3b-era; flush paths + receipts debounce added); see banner on the section |
| 23-26 | NOT DONE - server-side |

Ranks 1-9 were verified landed during P0 batches 1-7 (2026-08-22) and by the burst
log in dek-research/opencode/DRIVER-STATE.md, which carries per-rank proof lines,
chosen trade-offs and revert commits for everything above.

---

## Headline

Repo root: C:/Users/abhay/Desktop/claude/dek

About 47% of your entire monthly Supabase allowance is spent by tabs sitting still. Not by people talking - by timers asking the server questions whose answer has not changed. A client with Dek open and nobody touching it makes 1,194 requests an hour, and roughly 285 of those exist only because the sidebar rebuilds itself twice a minute even when nothing in it moved. Photos are the second line: they are uploaded at full camera resolution and then re-downloaded from scratch by every single colleague who scrolls past them, because every viewer gets a differently-signed URL that no cache can match.

This pass removes 29% of idle traffic with client-only work (1,194 -> 849 requests/hour), 43% with one small server change (-> 684), and 70% if you also build the merged pulse (-> 354). It also fixes four live bugs found on the way: an unread badge that may never clear when you open a channel, a DM that can appear twice in the sidebar, DM badges that stay lit after they are read, and reaction healing that refreshes the wrong sixty messages. Nothing on this list makes anything staler, slower, or need a reload. Two things do get faster (channel opens lose 5 round trips; the "Seen" line in DMs starts updating live for the first time).

What it buys: roughly 30 people today -> 90-130 people. It does not buy 300, and no client change can. Two walls there are arithmetic, not bugs: 200 concurrent websockets is a hard step function (the 201st browser cannot connect at all), and realtime messages are billed per recipient so a 300-person org fans one message into 81 billed messages before anyone types.

Three numbers underneath all of this are guesses, and one query each replaces them with facts. Run those five queries (listed at the end) before spending a week on the medium-risk half of the list.

---

## Where the money goes

All figures are % of the free-plan monthly allowance. Assumptions stated below the table - two of them are guesses and are marked.

| Free-plan limit | What that actually is | Today @30 | Today @100 | Today @300 | After @30 | After @100 | After @300 |
|---|---|---|---|---|---|---|---|
| **Egress 5 GB/mo** (one shared bucket: database + realtime + files) | **Every byte that leaves Supabase** | **~250%** | **~1170%** | **~4090%** | **~36%** (22% w/ pulse) | **~118%** (74% w/ pulse) | **~356%** (224% w/ pulse) |
| - of which: idle polling | Timers ticking in open tabs | 47% | 158% | 474% | 27% | 90% | 271% |
| - of which: photos + files | Attachments downloaded | 200% | 950% | 3560% | 2.5% | 8% | 25% |
| - of which: reading + sign-in | Message pages, bootstraps | ~6% | ~20% | ~60% | ~5% | ~17% | ~50% |
| **Realtime messages 2M/mo** (billed per recipient) | Live delivery of messages + typing | 17% | 180% | 1590% | 10% | 112% | 997% |
| **Realtime 100 messages/second** | Burst ceiling | fine | fine | fine | fine, except voice | fine, except voice | fine, except voice |
| **Realtime 200 concurrent connections** | One websocket per open browser | 15% | 50% | **HARD FAIL** | 15% | 50% | **HARD FAIL** |
| **Edge Functions 500k/mo** | Signed-URL minting, embed sign-in | 36% | 120% | 360% | 3% | 6% | 18% |
| **File storage 1 GB** | Photos and files kept forever | full in ~2 months | full in ~17 days | full in ~6 days | full in ~9 months | full in ~3 months | full in ~28 days |
| **Database 500 MB** | Messages and their indexes | ~4% (UNMEASURED) | ~13% | ~40% | ~3% | ~10% | ~31% |
| **Monthly active users 50,000** | People signing in | 0.06% | 0.2% | 0.6% | same | same | same |
| **Max file upload 50 MB** | - | already correct | already correct | already correct | - | - | - |
| **Postgres connections 60 / pooler 200** | - | not a wall (PostgREST pools) | not a wall | not a wall | - | - | - |

### The three lines that matter, in plain words

**1. Idle tabs.** A visible tab with nobody touching it makes 1,194 requests an hour. Here is the whole list, per hour: online census 180, voice roster 180, **sidebar rebuild from the voice poll 180**, resync safety net 144, unread badge 120, **sidebar rebuild from the unread poll 120**, heartbeat 80, reactions 60, cross-Space rollup + DM list 60, "Later" badge 40, new-member backstop 30. The two sidebar rebuilds - 300 an hour, 900 if the open channel uses topics - are the largest single item and they refresh nothing anybody can see. Two of the seven analyses missed them entirely.

**2. Photos.** A 3 MB phone photo is displayed in a box 340 pixels wide. Nothing resizes it. Then 14 colleagues scroll past it and each one downloads all 3 MB, because each gets a signed URL with its own timestamp, which no cache can match to anyone else's. One photo, 42 MB.

**3. Typing indicators.** Every message you send costs 2 typing broadcasts and 1 message broadcast, all billed per viewer. So typing is two thirds of live-delivery cost, and that ratio barely changes with channel size.

### Assumptions (change these and the table moves)

- 22 working days; **6 hours/day with the tab visible** (one analysis used 8h x 30d, which doubles everything).
- ~500 bytes on the wire per request: ~250 B of HTTP/2 headers + a gzipped body. One analysis measured 605 B with curl over HTTP/1.1 and then modelled everything on it; browsers use HTTP/2 with header compression, so that figure is roughly 2x high.
- **GUESS:** the busiest channel has 0.27 x headcount people watching it. Every realtime number scales linearly in this. One query replaces it.
- **GUESS:** 0.4 photos per person per working day at 2 MB blended. Two analyses modelled this and disagreed by 6x. This single unknown swings total egress between 10% and 250% of your whole plan.
- Database size is inferred from the client's RPC calls - the schema is not in the repo. One query replaces the whole model.

---

## The list

### 1. Stop the two background polls repainting a sidebar that did not change  `xs` `high`

Stop the two background polls repainting a sidebar that did not change. refreshUnread() rebuilds store.unread then calls renderChannels() every 30s whether or not a single count moved; refreshVoice() rebuilds store.voiceParts then calls renderChannels() every 20s whether or not anyone joined a room. renderChannels writes the whole sidebar with innerHTML and then does `await renderNavSections()`, which issues list_topics (plus topic_read_state and a 500-row messages scan when the channel has topics). topics.js CACHE_MS is 1500, so a 20s or 30s poll NEVER hits that cache. Fix: build the new map, compare it against the previous one, and return before renderChannels() when they are identical.

- **Where.** js/core/channels.js:1093 (refreshUnread), js/core/voice.js:366 (refreshVoice), js/core/channels.js:192 (the renderNavSections tail)
- **Saves.** ~285 of 1,194 requests/hour per visible client, and ~855 of 1,794 where the open channel uses topics. That is 24-48% of the entire idle budget. ~0.55 GB/month at 30 people, 1.9 GB at 100, 5.6 GB at 300. It also removes ~300 full-sidebar innerHTML rebuilds an hour, which is battery and jank on the phones this product runs on.
- **Quality cost.** None, and this is the rare case where that needs no hedge: the skipped repaint would have painted byte-identical HTML from byte-identical data. Every path that genuinely changes the sidebar (openChannel, toggleMute, category collapse, reloadChannels, switchWorkspace, refreshDMList when a new DM appears) calls renderChannels directly and is untouched.

### 2. Clear the unread badge locally after mark_read instead of chaining refreshUnread, and make refreshUnread impossible to break from a distance  `s` `high`

Clear the unread badge locally after mark_read instead of chaining refreshUnread, and make refreshUnread impossible to break from a distance. Three sites do `api.markRead(...).then(refreshUnread)`. api.rpc returns PostgREST's data, which is null for a returns-void function, and refreshUnread destructures `{ full = true } = {}` - a default that fires on undefined but NOT on null. So refreshUnread(null) throws a TypeError straight into the trailing .catch(() => {}). Either mark_read returns a row and you pay 3 RPCs per channel open for an answer you already know, or it returns void and the badge on the channel you just opened stays lit until the next 30s poll. Replace all three with a local clear (delete the store.unread entry, emit 'unread', renderChannels), and change the signature to `(opts) => { const { full = true } = opts || {}; ... }`. There is a fourth site nobody found: presence.js:227 binds `bus.on('unread:reload', refreshUnread)`, passing the bus payload into the same destructure - benign only because all three emitters happen to pass nothing today.

- **Where.** js/core/channels.js:524, js/core/channels.js:921, js/core/dms.js:171, js/core/channels.js:1087 (signature), js/core/presence.js:227
- **Saves.** Up to 3 requests per channel open and per cursor-advancing resync: ~40,000/month at 30 people, 400,000 at 300. If mark_read returns void the saving is zero and this is instead a badge-correctness fix. Both outcomes are worth the same change.
- **Quality cost.** None. Whether the channel now on screen is read is knowable locally with certainty; no server fact is needed. Clear only after the promise resolves, never before - messageExtras.js:548 and uxfix.js:411 both read the pre-open store.unread value at channel:open to place the new-messages divider.

### 3. Collapse the two visibilitychange handlers that both refresh unread  `xs` `high`

> **STATUS: DO NOT ACT.** Audited 2026-08-24 against the live tree: there is ONE
> visibilitychange handler in presence.js (line ~290) and it already does everything
> this section asks - heartbeat, auth refresh, realtime retry, resync and one unread
> refresh per return. The defect described below did not exist at audit time (the
> merge predates or accompanied P0 batches; b112f3b-era). Kept for the measurement:
> the double-refresh it warns about is a real cost pattern to watch for when new
> visibility handlers are added.

Collapse the two visibilitychange handlers that both refresh unread. initPresence registers one at presence.js:212 (sets unreadTick = 0 then calls pollUnread(), and because unreadTick++ % 4 === 0 is now true it runs the FULL three-RPC version) and a second at presence.js:240 (calls a bare refreshUnread(), which also defaults to full). Every tab focus therefore costs six RPCs from two handlers inside the same function. Merge into one handler.

- **Where.** js/core/presence.js:212-215 and js/core/presence.js:240-250
- **Saves.** 3 of 6 RPCs on every return to the tab. A laptop user switching browser tabs 10-20 times an hour pays 60-120 requests/hour for this alone - comparable to the entire 'Later' and heartbeat loops combined. Found by none of the seven analyses.
- **Quality cost.** None. The remaining handler does exactly what the pair did: heartbeat, refresh auth, force realtime retry, resync, refresh unread - once instead of twice.

### 4. Add the three missing visibility guards, and fix which messages the reaction sweep heals  `xs` `high`

> **STATUS: DONE, with one correction.** (a) the canvas poll guard ALREADY existed
> when audited (canvases.js skips the 4s poll while hidden and refreshes on return,
> b112f3b-era) - this section's premise was stale on that sub-item. (b) and (c)
> landed as commit f1df785 (2026-08-24): sweep guarded + fired immediately on
> return to visible, ids read off #messages .msg DOM rows instead of store.seen
> insertion order, Later badge guarded + refreshed on return. One accepted delta:
> thread-panel rows outside #messages are no longer swept; realtime reaction
> events remain their paint path.

Add the three missing visibility guards, and fix which messages the reaction sweep heals. (a) The canvas poll runs every 4 seconds with no guard at all, including in a fully hidden tab. (b) The reaction sweep runs every 9s and is dirtied by `bus.on('message:new')`, which fires from realtime regardless of visibility - so a backgrounded tab on a busy channel sweeps reactions forever. (c) The 'Later' badge polls every 90s with no guard, the last unguarded whole-app poll. While in the sweep: it takes `[...store.seen].slice(-60)`, which is INSERTION order, so after paging up it heals the oldest rows just prepended and ignores the reactions actually on screen. Read the ids off the DOM instead.

- **Where.** js/features/canvases.js:388-397, js/core/presence.js:173-180 (guard + the store.seen slice at :175), js/features/later.js:65-71 and :154
- **Saves.** 900 req/hour per canvas left open in a background tab (the highest per-unit waste in the app), up to 400 req/hour from the reaction sweep in a hidden tab on a busy channel, 40 req/hour from the Later badge. Each fires a refresh on return to visible so nothing is stale when it is looked at.
- **Quality cost.** None from the guards - nobody reads a canvas, a reaction count or a badge they cannot see, and each refreshes before the first visible frame. The DOM-order change is strictly better: today a dropped reaction event on a message you are looking at can stay wrong until you reopen the channel.

### 5. Three duplicate-call bugs in the DM path  `xs` `high`

Three duplicate-call bugs in the DM path. (a) main.js:397 calls refreshUnread(), which defaults full:true and already ends in `await refreshDMList()`; main.js:399 then imports channels.js and calls refreshDMList() again, concurrently. Both compute `const known = new Set(store.dms.map(...))` before either pushes, so a genuinely new conversation is pushed TWICE and renders on two sidebar rows for the rest of the session. Delete line 399. (b) refreshDMList returns early on `if (!rows.length) return;` BEFORE the loop that writes each conversation's unread flag back into store.dms, and that loop only updates conversations present in rows - so a DM read elsewhere keeps its lit dot until a Space switch or reload. Move the early return below the clearing loop and clear conversations absent from rows. (c) workspace.js:248 and channels.js:1101 both fetch get_space_summary within seconds at sign-in; guard the second with a 20s freshness stamp.

- **Where.** js/main.js:396-399, js/core/channels.js:1119 and :1141-1145, js/core/workspace.js:248 vs js/core/channels.js:1101
- **Saves.** One request per incoming DM per recipient plus one per sign-in - ~4,400/month at 30 people. The real value is that (a) and (b) are visible bugs: a duplicated person in the sidebar and a DM badge that will not go out.
- **Quality cost.** None. (a) and (c) are literal duplicates of a call made moments earlier with identical arguments. (b) makes a stale badge correct.

### 6. Add `'Access-Control-Max-Age': '86400'` to the CORS headers of every Edge Function  `xs` `needs DB` `high`

Add `'Access-Control-Max-Age': '86400'` to the CORS headers of every Edge Function. Every browser call to mint-download, mint-upload, soop-handoff and admin-users sends Authorization, apikey and Content-Type: application/json - none CORS-safelisted - so each is a preflight OPTIONS plus the real POST, and the OPTIONS is answered by the function's own code, so it executes.

- **Where.** supabase/functions/soop-handoff/index.ts:81-86, supabase/functions/soop-jira/index.ts:50-55, and the same one-line addition in mint-download, mint-upload and admin-users (not in this repo)
- **Saves.** Halves the executions of every browser-called function after the first request in a session. On mint-download alone at 100 people that is ~300,000 invocations/month removed - 60% of the entire 500,000 quota - before any batching. One line per function.
- **Quality cost.** None. Strictly fewer round trips, so every image load and every admin action is one RTT faster.

### 7. Project and bound the threads query on channel open  `s` `measured`

Project and bound the threads query on channel open. It is currently `table('threads', q => q.eq('channel_id', c.id))` - select('*'), no order, no limit - on the critical path of every open, to read four fields. Change to `.select('id,channel_id,root_message_id,reply_count,last_message_at,title').order('last_message_at', { ascending: false })` and, when the pagecache has a snapshot, add `.gt('last_message_at', snapshot.at)` and merge over the cached array. `title` must be in the list: forum.js:129/309 and shortcuts.js:246 read it.

- **Where.** js/core/channels.js:426 (snapshot at js/lib/pagecache.js:113)
- **Saves.** The code's own comment at channels.js:424 measures this: 224 rows, 19 KB, 193ms on a good line, six seconds on a bad one. Projection takes it to roughly 3 KB; the incremental filter takes a warm open to near zero. ~16 KB per channel open, ~290 MB/month at 30 people, and it removes an unbounded query that grows forever.
- **Quality cost.** None from the projection or the incremental filter - reply_count only moves when last_message_at moves, and there is no delete-thread RPC anywhere in api.js, so a thread cannot silently vanish. Do NOT add the 200-row cap the analyses proposed: above 200 threads in a channel, paging up reaches a root message whose reply indicator never paints, which is a silent missing affordance. If you cap at all, cap at 500 and re-fetch on loadOlder.

### 8. Create the index behind the app's highest-frequency background query: `create index concurrently on user_presence (last_seen_at) where status <> 'offline';`  `xs` `needs DB` `high`

Create the index behind the app's highest-frequency background query: `create index concurrently on user_presence (last_seen_at) where status <> 'offline';`. The client query is exactly `.neq('status','offline').gt('last_seen_at', cutoff)` and neither predicate is usefully indexable on its own today.

- **Where.** server-side index; consumer is js/core/presence.js:138-141
- **Saves.** Converts a full scan of user_presence into a range scan over only the currently-online rows, on a query every client runs continuously. At the 1,798 presence rows the code comment records it is ~20 pages per call; at 50,000 rows with 100 clients it is the difference between ~250,000 rows/second scanned and roughly 6,000. Highest saving-to-effort ratio of any server change here, and it compounds with the interval change at rank 13.
- **Quality cost.** None. Same rows, same order, same answer.

### 9. Batch mint-download and stop awaiting it serially  `s` `needs DB` `high`

Batch mint-download and stop awaiting it serially. hydrateMedia has four loops of the shape `for (const box of imgs) { const url = await mediaUrl(...) }`, so a message with four images pays four sequential Edge round trips before the last one starts loading, and messages.js:121 fires hydrateMedia per row across a 50-row page. Two changes: collect keys and Promise.all them (client-only, ship immediately), and make mint-download accept an array of object_keys returning `{key: url}`, with mediaUrl coalescing pending keys on a ~16ms timer. Have it return `expires_at` too, so media.js stops guessing 250,000ms.

- **Where.** js/core/media.js:83-100 (mediaUrl), js/core/media.js:140-165 (the four serial loops), js/core/messages.js:121; supabase/functions/mint-download (not in this repo)
- **Saves.** Against the 500,000 Edge invocation quota, which mint-download is currently on track to blow on its own: ~600,000/month at 100 people today, ~30,000 after batching plus the Max-Age header at rank 6. A 20x cut.
- **Quality cost.** None, and images appear sooner. The 16ms flush window is below one frame. Roll the server side out accepting both a single object_key and an array so an unreloaded client keeps working.

### 10. Let the service worker cache Storage objects by path, ignoring the signed query string, and give new uploads a cache header  `m` `high`

Let the service worker cache Storage objects by path, ignoring the signed query string, and give new uploads a cache header. sw.js:126 currently drops every Supabase URL out of Cache Storage. Add a narrow exception above it (after the existing non-GET early return at sw.js:122): if the pathname starts with /storage/v1/object/, build the cache key from `url.origin + url.pathname` with the search stripped, serve cache-first, populate on miss. This is what actually defeats the token rotation - you own the cache key. Separately, media.js:68 calls uploadToSignedUrl with no fileOptions; pass `{ cacheControl: '31536000', contentType: mime }`.

- **Where.** sw.js:122 and sw.js:126, js/core/media.js:68, plus the sign-out wipe at js/shell.js:97 and js/core/auth.js:260
- **Saves.** Removes every repeat view of every image, permanently rather than for 250 seconds - roughly 26-35% of attachment egress on its own, and it makes the lightbox open from local disk. Combined with ranks 11 and 20 it takes attachments from ~200% of the whole plan at 30 people to ~2.5%.
- **Quality cost.** None to freshness IF object keys are content-addressed off the sha256 - media.js:66 asserts this in a comment but mint-upload is not in the repo, so read it and confirm before choosing cache-first. If you cannot confirm it, use stale-while-revalidate for one release. Two things are mandatory in the same change: a ~150 MB LRU cap with eviction on put, or this fills a 64 GB phone; and adding the new cache name to the sign-out wipe, or a shared phone hands one person's photos to the next.

### 11. Resize images in the browser before upload, and ship a thumbnail alongside  `m` `medium`

Resize images in the browser before upload, and ship a thumbnail alongside. There is no resizing anywhere today - grep for toBlob, createImageBitmap, OffscreenCanvas, drawImage and getContext('2d') across js/ returns zero matches - so a 4032x3024 photo is uploaded whole into a box capped at 340 CSS px. Use createImageBitmap -> canvas -> toBlob at 2048px longest edge, q0.85, plus a second blob at 700px (~55 KB) for the inline box. Six conditions are mandatory: hash the RE-ENCODED blob (media.js:48 currently hashes the original arrayBuffer and passes it to finalizeAttachment as '\\x' + sha - both uses must change together or dedup and the attachment row disagree); skip image/gif entirely; skip anything already small; discard the output and upload the original if it came out larger; pass imageOrientation:'from-image' or portrait photos upload sideways; report the NEW dimensions into finalizeAttachment and the attachment object. Keep the size check ahead of the decode. Carry the thumb as a separate `data-thumb` attribute - do NOT overwrite `data-key`, which openViewer and the Save button read.

- **Where.** js/core/media.js:45-81 (insert before line 47), js/core/media.js:121-124 (render from data-thumb), js/core/media.js:196 (lightbox keeps data-key), js/core/composer.js:267-270
- **Saves.** 5x on both storage and egress from the downscale, then a further ~3.5x from the thumbnail. It is the only lever that helps the 1 GB storage bucket at all, which matters because there is no attachment deletion path anywhere in the repo - the only purge destroys an entire workspace.
- **Quality cost.** REAL AND PERMANENT, and this one needs your explicit yes rather than a default. Detail above 2048px is gone forever with no original to fall back to. The person who loses is the one photographing a whiteboard, a document or a serial number and later pinch-zooming to 6x in the lightbox, which the viewer allows. At 2048px the 340px box is oversampled at every screen density so normal viewing is pixel-identical, and 700px thumbnails are retina-sharp at 2x. Ship 700px, never the 400px two analyses suggested - 400px against a 340 CSS px box is visibly soft on a phone, which is exactly the trade that is off the table. Two side effects are wins: uploads finish ~5x faster on mobile data, and EXIF stripping removes GPS coordinates from photos posted into a work chat.

### 12. Coalesce the realtime handlers that each fire three RPCs  `s` `high`

Coalesce the realtime handlers that each fire three RPCs. main.js:367, :368 and :397 all call a bare refreshUnread(), which defaults full:true and therefore runs get_unread + get_space_summary + get_dm_unread, un-debounced, once per broadcast - a twenty-message burst in a Space you are not looking at is 60 requests. Wrap in a LEADING-edge debounce (fire immediately, swallow repeats for 700ms, one trailing call if any were swallowed) applied at the three bindings, not at the export. Do the same for the two reload-everything handlers: channel_created/updated/deleted all emit 'channels:reload' into a full get_bootstrap, and voice_join/voice_leave both emit voice:refresh into a full voice_participants read.

- **Where.** js/main.js:367, :368, :397; js/core/workspace.js:657-659; js/core/channels.js:674-675
- **Saves.** Collapses N identical full-state reads per burst into 1. An admin renaming five channels currently triggers five full bootstraps on every connected client. Order of 30,000-40,000 requests/month removed at 30 people.
- **Quality cost.** None - a leading edge means the first badge update is exactly as fast as today and only redundant repeats inside the window are dropped. Two traps: do NOT use a trailing debounce (it delays the first update by over a second on the single-message case, which is the common one), and do NOT wrap the refreshUnread export - presence.js:227 binds it to 'unread:reload', which is emitted by the explicit 'Mark as read' menu item, and a debounced export makes that click appear to do nothing. For channels:reload, bypass the debounce entirely when the payload carries `open` (channels.js:278 uses it to open a just-created channel) - debounce only the payload-free emits from the ws: handlers.

### 13. Guard the online census on visibility, slow it from 20s to 30s, and keep the member backstop where it is  `xs` `high`

Guard the online census on visibility, slow it from 20s to 30s, and keep the member backstop where it is. tick() has no visibility check, and it carries syncMembers every 6th pass. Add `if (document.visibilityState !== 'visible') return;` and add tick() to the merged visibilitychange handler from rank 3 so the dots are right before the first visible frame. Change the interval to 30000 and the modulus from 6 to 4 so the member backstop stays at ~120s.

- **Where.** js/core/presence.js:134, :135 (the % 6), :153, and the merged handler at :240
- **Saves.** 60 req/hour on a visible client, plus 60-90 req/hour on a hidden one (paper says 180, but browsers already throttle hidden timers and freeze the page after ~5 minutes, so the honest measured delta is smaller).
- **Quality cost.** Small and named honestly. Do NOT take the 45s that two analyses proposed. Their argument - that a green dot is already 45s behind because that is the heartbeat period - is wrong: presence.js:76 beats immediately on init and :81 beats on every channel open, so somebody arriving writes their row at t=0 and the POLL is the only thing gating when colleagues see them. 45s doubles the worst case for 'is Priya here yet' from 20s to 45s. 30s costs 5 seconds of average latency on a decoration nobody times. Do not touch the 45s heartbeat write either - the server reaps presence 60s after the last beat.

### 14. Stop the channel-open path refetching three things it already has  `s` `high`

Stop the channel-open path refetching three things it already has. (a) tasks.js binds refreshChips to BOTH channel:open and channel:subscribed, and channel:subscribed fires immediately after every open - two identical reads of every task in the Space including finished ones. Delete the call from the channel:open handler and keep channel:subscribed unconditional (do NOT add the global 5s cooldown the analysis proposed: the task_update broadcast is bound to the CURRENT channel's topic only, so tasks changed while you were elsewhere reach this client only through that refetch, and a global cooldown swallows it on a fast A -> B -> A switch). (b) orientation.js:222 calls get_channel_guide directly while load() at :40 reads a cache that is already invalidated on every mutation path and on the guide_update broadcast. Route :222 through load(), and change load() to use tryRpc so an offline channel open does not reject inside a bus handler.

- **Where.** js/features/tasks.js:739 (delete the refreshChips call), js/features/orientation.js:40-46 and :222
- **Saves.** 3 requests per channel open removed: ~26,000/month for tasks and ~13,000 for guides at 30 people, and the tasks one carries the largest response body in the open path.
- **Quality cost.** None from (a) - the task_update broadcast paints live changes and the retained channel:subscribed refetch still heals a broadcast dropped while the socket was down. For (b), verify get_channel_guide is a pure read before caching: onChannelOpen reads `g.seen` to decide whether to show the welcome card, and if the RPC has a server-side side effect of marking seen, caching it changes that behaviour.

### 15. Stop the member panel re-fetching a column core already threw away  `s` `high`

Stop the member panel re-fetching a column core already threw away. presence.js:139 selects user_id,status,last_seen_at every 20s and keeps only user_id at :146. status.js:134 then issues its own `table('user_presence', q => q.in('user_id', ids))` - select('*') with EVERY key in store.profiles in the query string - to read exactly that discarded column. Keep it: `store.presenceStatus = new Map((data||[]).map(p => [p.user_id, p.status]))`, have status.js read that Map, and delete its fetch, its 8-second throttle and its `bus.on('presence')` fetch binding (keep the binding, drop the network call).

- **Where.** js/features/status.js:125-141 and :397, js/core/presence.js:146
- **Saves.** Removes a request whose URL reaches ~11 KB at 300 members, up to 180 times an hour while the member panel is open. Be honest about magnitude: refreshPresenceDetail returns early unless a '.member' row is on screen, so it only runs while that panel is open - the 6.67 GB/month figure one analysis projected assumes everyone has it open all day and is an order of magnitude high.
- **Quality cost.** None, and strictly better: away and do-not-disturb badges now update on the same 20s tick as the online dot instead of up to 8 seconds behind it via a MutationObserver, and they stop being queried for every stranger in the profile map. The census filter (.neq status offline, last_seen_at within 90s) is exactly the away/dnd set status.js needs.

### 16. Make viewer_count trustworthy and stop hammering the hottest row in the database  `xs` `high`

Make viewer_count trustworthy and stop hammering the hottest row in the database. api.heartbeat(status, channel) sends `store.current?.id` unconditionally with no visibility guard, so a phone in a pocket keeps asserting it is viewing a channel - and channels.viewer_count is the only input to the server-side digest valve that every analysis agrees is the sole path past ~100 people. Send `p_channel: null` when the tab is hidden while still beating (presence must stay correct). Separately, the beat is also bound to channel:open and dm:open on top of the 45s interval; debounce that event-driven beat to at most one per 10s.

- **Where.** js/core/presence.js:70, :77, :81-82
- **Saves.** Removes roughly a third of the write traffic on user_presence (the busiest updated row in the app) on a 250-baseline-IOPS instance: 40 channel switches a day per person is 40 extra beats plus 40 viewer_count updates. The real value is that it is the prerequisite for trusting viewer_count at all.
- **Quality cost.** None. Presence stays exactly as accurate - the status half of the beat is unchanged and still fires every 45s from hidden tabs. Only the 'which channel am I looking at' claim becomes honest.

### 17. Replace the embed handoff's create-then-scan user lookup with an indexed one  `s` `needs DB` `high`

Replace the embed handoff's create-then-scan user lookup with an indexed one. soop-handoff calls createUser FIRST on every mint, detects 'already registered' by string match, then pages `for (let page = 1; page <= 20; page++)` at perPage 200 through GoTrue's admin list - which is ordered created_at DESC, so the longest-standing accounts sit on the deepest pages and cost rises with tenure. Add a security-definer `embed_user_id_by_email(p_email)` reading auth.users' existing unique email index, revoke execute from anon and authenticated, and reorder to lookup -> create on miss -> one retry on the genuine race.

- **Where.** supabase/functions/soop-handoff/index.ts:215-241, plus a migration alongside supabase/migrations/0100_embed_registry.sql
- **Saves.** A steady-state mint goes from 15 backend round trips moving ~1.4 MB (at 2,000 users) to 5 round trips and ~1 KB, and stops scaling with table size. It also removes one aborted auth.users INSERT - and its dead tuple - per returning-user mint.
- **Quality cost.** None, and it fixes a live correctness cliff rather than an inefficiency. Past 4,000 rows in auth.users the loop gives up, returns null, the mint 500s with 'could not resolve a user', and that person can never sign into the panel again. main.js records a 1,770-member demo Space, so the table is already in the low thousands.

### 18. Four small fixes on the embed path  `xs` `needs DB` `high`

Four small fixes on the embed path. (a) embed.js:123 sends content-type: application/json on the redeem POST, which is not CORS-safelisted and forces a preflight the function executes; send text/plain instead - soop-handoff uses `await req.json()`, which parses the body regardless of the declared type. (b) embed.js:137 calls sb.auth.getUser() - always a network GET - eight lines after setSession already returned the user; capture `data` from setSession in both branches and read the id locally. (c) soop-handoff fires embed_sweep_tickets on every mint, a write transaction that deletes ~0 rows because the predicate only reaches tickets older than an hour while mints arrive continuously; sample it at 1% or move it to pg_cron. (d) EMBED.md:143 says the handover is 'cheap enough to run on every load'; correct it and state that `ready` fires once per iframe MOUNT, so an SPA dashboard must mount the panel once and drive it with navigate()/identify() rather than remounting on every route change.

- **Where.** js/embed.js:123, js/embed.js:129 and :137, supabase/functions/soop-handoff/index.ts:209, EMBED.md:143 and :70-80
- **Saves.** (a) and (b) remove two round trips from every panel boot. (c) removes 45,000 useless write transactions/month at 300 people. (d) is the multiplier on everything else in this cost centre: a dashboard remounting the panel on 6 route changes per session multiplies soop-handoff invocations by 6, taking 300 people from 27% to over 100% of the Edge quota.
- **Quality cost.** None on any of the four. The mint call is server-to-server and was never preflighted. Redeem already enforces single-use and expiry itself, so an unswept ticket is never honoured. A persistently mounted panel is also a better experience - it keeps its socket, scroll position and unread state across the host's navigation.

### 19. Give api.table() a column list, and chunk the resync id fetch  `m` `high`

Give api.table() a column list, and chunk the resync id fetch. api.js:31 hardcodes `sb.from(name).select('*')` for all 51 table reads with no way for a caller to project. Add a third argument with a per-table default map and '*' as the fallback so an unlisted table cannot silently break: voice_participants 'channel_id,user_id'; workspace_members 'user_id,member_type,joined_at'; profiles 'id,display_name,username,avatar_key,status_text,status_emoji,is_ghost'; conversation_members 'conversation_id,user_id'; message_acks 'message_id,user_id'; read_state 'last_read_seq'; member_roles 'user_id,role_id'. Separately, channels.js:948 is a direct `sb.from('messages').select('*').in('id', wanted)` over up to 200 uuids - a ~7.4 KB URL that the code's own comment already names as a way this read fails, and a failure abandons the whole healing pass. Give it an explicit column list and chunk the ids into groups of 50 with Promise.all.

- **Where.** js/api.js:30-36, then js/core/channels.js:426/:1126/:1130, js/core/voice.js:71/:360, js/core/workspace.js:124/127/629/635/695/698, js/core/presence.js:121/129, js/features/messageExtras.js:102/:552, js/features/roles.js:252-254, and js/core/channels.js:948
- **Saves.** 40-60 MB/month at 30 people, 145 MB at 100, 435 MB at 300. Deliberately smaller than two analyses claimed: gzip already squeezes repeated JSON key names hard, so removing columns removes far fewer wire bytes than raw counts suggest. The better justifications are DB compute and index-only scans on a shared-CPU instance, and closing the hazard that any column added server-side today silently starts shipping to every client on every poll - including a stored tsvector, which would be ~110 B x 200 rows on every resync.
- **Quality cost.** None if each list is a superset of what is read. The one real risk is a column read by a path nobody enumerated, which the default-to-'*' fallback contains. Two traps: threads needs `title` (forum.js and shortcuts.js read it), and the resync fetch is the path that heals dropped messages, so it has the least slack of any read in the app - add a dev assertion that every key buildMessage touches is present.

### 20. Fix voice signalling stability and halve its message count  `s` `high`

Fix voice signalling stability and halve its message count. Three changes to the same file. (a) pc.onconnectionstatechange calls dropPeer on 'disconnected', which in WebRTC is a transient state that usually recovers on its own - so a two-second wifi wobble closes the connection, removes the audio element, and triggers a full 12-signal renegotiation. Only drop on 'failed' and 'closed'; on 'disconnected' start a 6s grace timer and cancel it if the state returns to 'connected'. (b) Add a per-peer re-offer cooldown keyed on peerId in a module Map (dropPeer is immediately followed by refreshVoice, which re-offers the same peer on the next line), cleared on 'connected' and on leaveVoice. (c) Batch ICE candidates: send the first immediately, queue the rest and flush on whichever comes first of 150ms, 4 queued, or e.candidate === null. Accept both an array and a single object on the receive side so mixed client versions interoperate, and push an array as N entries into the existing per-peer buffer so its 50-candidate bound stays meaningful. Clear the outbound buffer and its timer in dropPeer and leaveVoice.

- **Where.** js/core/voice.js:88 and :210 (ICE), js/core/voice.js:121-124 and :377 (teardown and re-offer)
- **Saves.** Signals per peer pair drop from 12 to 6. The monthly figure is small - voice is ~0.6% of the realtime quota at this size - so the reason to do it is the 100 messages/second ceiling that the whole organisation shares: one flapping connection in a 5-person room currently emits 60 billed messages per state change, repeatable once per second, against a cap that everyone else's typing and messages also draw on.
- **Quality cost.** None, and (a) is an audio-quality fix: today a brief wobble cuts the call out and brings it back several seconds later. Trickle ICE tolerates 150ms on candidates 2..n - but the first candidate must stay un-batched or you add a real 150ms to every connect. Waiting before re-offering a flapping peer reconnects more reliably, not less, because it stops both sides racing to rebuild a connection neither has finished tearing down.

### 21. Cut typing broadcasts roughly in half  `s` `high`

Cut typing broadcasts roughly in half. (a) Delete the send-side 'stop': in send(), replace stopTyping() with a local-only reset that broadcasts nothing, and in initPresence add `bus.on('message:new', ({ msg }) => { if (msg?.author_id) clearTyping(msg.author_id); })`. Keep stopTyping unchanged on blur, hidden, delete-to-empty and the 4s idle timer - those are the paths where no message is about to arrive. MANDATORY amendment nobody else caught: 'stop' rides the open websocket while the msg broadcast only exists after the send POST returns, so on back-to-back messages a fresh 'start' can be sent and then cleared by the previous message's broadcast, after which emitTyping short-circuits for up to ten seconds and the receiver sees nothing while someone is actively typing. Record lastSendAt in send() and force a fresh 'start' in emitTyping when typingSentAt predates it. Also keep the explicit stop on the outbox path - a queued message produces no message:new for anyone. (b) Gate the 'start' behind ~800ms of sustained composition, cancelled on send, blur, hidden, delete-to-empty, and in resetTyping (or a timer armed in channel A fires after a switch and publishes onto channel B's topic).

- **Where.** js/core/composer.js:283, js/core/composer.js:226-230, js/core/composer.js:238, js/core/presence.js:225
- **Saves.** (a) removes one of the two typing sends per message - V of the 3V+1 billed per message, i.e. 33% of ALL channel realtime traffic at every channel size. (b) removes both for the shortest replies. Together: realtime per message goes from 3V+1 to about 1.85V+1, and the point where the 2M/month quota breaks moves from roughly 74 people to roughly 95. Note this is against a quota that is only 17% used at 30 people - it is a scaling valve, not a present-day saving.
- **Quality cost.** (a) is marginally better than today: the indicator currently clears one round trip AFTER the message paints; this clears it in the same frame. (b) is where the honest cost is - use 800ms, not the 1200ms proposed. At 1200ms a two-word reply typed slowly on a phone loses the indicator it should have had, and 'the indicator appears later' IS the indicator being slower. At 800ms you only kill the sub-second flash on 'ok' and 'done', which is the flicker that trains people to ignore the indicator in the first place.

### 22. Two DM fixes in one file  `xs` `high`

> **STATUS: DONE, text partially stale.** The coalesced markDMRead and the
> dm:receipts LISTENER described in (b) as missing were already present b112f3b-era
> when audited - the doc's "zero listeners" grep result no longer held. What was
> genuinely missing and landed as commit 1b9d0e5 (2026-08-24): flushDMRead()
> called from openDM before the switch and from a visibilitychange->hidden
> listener, so pocketing the tab mid-burst cannot leave a conversation unread
> everywhere but this device; and the dm:receipts handler routed through
> debounce(1000) because read broadcasts arrive in bursts.

Two DM fixes in one file. (a) dms.js:122 calls api.markDMRead on every incoming DM with no coalescing, while the channel path coalesces the identical write at 1200ms - copy that shape (hold the highest seq, one RPC per 1200ms, monotonic), and flush the pending write on a switch to another conversation and on visibilitychange->hidden so closing the tab mid-burst does not leave it unread. (b) dms.js:85 binds `read: () => bus.emit('dm:receipts', { conversationId })` and grep for 'dm:receipts' across the whole repo returns exactly one hit - that emit. Zero listeners. Point it at a 1000ms-debounced refreshReceipts(conversationId), guarded on store.currentDM still matching.

- **Where.** js/core/dms.js:122, js/core/dms.js:85 (refreshReceipts at :175)
- **Saves.** (a) is one RPC and one broadcast per 1.2s burst instead of per DM message - with 2 participants online that is 3 of the ~6 billed messages a DM costs. (b) saves nothing at all and adds a debounced RPC. Include it anyway: it converts a broadcast you are ALREADY billed for from pure waste into the live 'Seen' indicator, which today only repaints when you open the conversation.
- **Quality cost.** None. The reader's screen already cleared the unread state locally; the only observable is the sender's 'Seen' line, which cannot get staler than it already is - and (b) makes it live for the first time. This is the identical trade the channel path made deliberately.

### 23. Publish voice_join and voice_leave on the ws:<workspace_id> topic, then drop the voice poll to a 120s backstop  `m` `needs DB` `high`

Publish voice_join and voice_leave on the ws:<workspace_id> topic, then drop the voice poll to a 120s backstop. Those events exist only on ch:<channel_id> today, and nothing ever subscribes to a voice channel's ch: topic - so the 20s refreshVoice poll is the ONLY thing populating room counts for every room you are not standing in. The client already has the handler shape in workspace.js. Only after this lands may the poll interval change.

- **Where.** js/core/channels.js:674-675 (today's publisher), js/core/workspace.js:656-690 (client handler), js/core/presence.js:217-221 (the poll)
- **Saves.** 150 of 180 req/hour per client in any Space with voice rooms, and it makes a join appear in under a second instead of up to 20.
- **Quality cost.** None, and faster. This ordering is not optional: two analyses proposed raising the poll to 45s or skipping it when all rooms are empty, and both are silent-wrong without this change - 'empty' becomes an absorbing state and the first person to join a room is invisible to everyone else. Keep the poll as a 120s backstop rather than deleting it; the events are low-frequency on a topic everyone in the Space already holds, so the realtime cost is bounded.

### 24. Three server-side reads that are cheaper without being staler  `m` `needs DB` `high`

Three server-side reads that are cheaper without being staler. (a) reloadChannels() runs a full get_bootstrap and then uses exactly two fields from it - read channels and categories directly instead, which is the code path the app already falls back to at workspace.js:710-711. Verify first that a raw channels read returns the same visible set as get_bootstrap for a member of a private channel, and that last_seq is a real column (channels.js:516 seeds the cursor from it). (b) Drop status_text, status_emoji and bio from get_bootstrap's member rows - the member_status broadcast already keeps those live, so this is ~30% off the roster block with zero behaviour change. (c) get_read_receipts returns one row per member to render `Seen by N` plus a names tooltip; change the signature to get_read_receipts(p_channel, p_since_seq), have the server do the seq comparison the client currently does, and return a count plus at most 8 sample names. Pair it with a client-side recency gate: keep the 30s cadence for five minutes after you post and stop polling outside that window.

- **Where.** js/core/workspace.js:705, js/core/workspace.js:548 and :572, js/features/messageExtras.js:177 and :204 and :212-216
- **Saves.** (a) stops every connected client re-downloading the whole roster because one admin renamed one channel: 20 MB/month at 30 people, 1.78 GB at 300. (b) ~30% of the bootstrap's largest block on every Space switch. (c) removes the only quadratic term in the app - one row per member per call, per client, forever - and the recency gate takes a normal reading session from ~120 calls/hour to about 10.
- **Quality cost.** None on (a) or (b) - same arrays, same RLS visibility, and the dropped fields arrive live on a broadcast. On (c) the tooltip lists 8 names and 'and more' instead of all 26; paintReactions already truncates the identical tooltip at 8, so this makes two tooltips consistent rather than inventing a limit. The count must be computed against the seq the client passes, not as a bare count of everyone with any read state, or 'Seen by N' becomes wrong rather than smaller - and a wrong receipt is worse than a large one.

### 25. Broadcast the three per-channel things that currently only refresh when you leave and come back: pins, bookmarks and topics  `m` `needs DB` `medium`

Broadcast the three per-channel things that currently only refresh when you leave and come back: pins, bookmarks and topics. A colleague pinning a message while you are sitting in the channel is invisible to you today - subscribeChannel has no `pin` handler and applyEvents explicitly skips kind === 'pin', even though the event log carries it. Wire a pin handler onto the chan topic and add bookmark_added/topic_changed alongside the guide_update broadcast that already exists, then cache each set per channel client-side. Also add the two remaining indexes and the search index: `create index concurrently on messages (channel_id, seq desc) where topic is not null and deleted_at is null;`, `create index concurrently on workspace_members (workspace_id, joined_at);`, and `create extension if not exists btree_gin; create index concurrently on messages using gin (workspace_id, search_vector);`.

- **Where.** js/core/channels.js:661 and :973, js/features/messageExtras.js:416 and :421, js/features/bookmarks.js:182, js/features/topics.js:82, js/features/orientation.js:318; server-side indexes consumed by js/features/topics.js:126, js/core/presence.js:121, js/api.js:295-299
- **Saves.** One table read per channel re-open for each of pins, bookmarks and topics. The indexes matter more: search_messages is workspace-scoped by both call sites but the workspace filter is currently a post-GIN heap recheck, so on a database holding three organisations a common-word search touches roughly three times the tuples it needs - which is one person searching consuming the shared IOPS budget everyone else's app draws on.
- **Quality cost.** None, and the broadcasts fix a real staleness. Do NOT ship the caches without the broadcasts - a session cache with no invalidation is strictly worse than today. Do NOT fold these into get_bootstrap as one analysis proposed: that grows the blocking first-paint call with the channel count, in the opposite direction from (b) at rank 24. For the search index: run EXPLAIN ANALYZE on the real search_messages first (the tsvector's existence is inferred from a user-facing string, and messages may have no workspace_id column at all), build concurrently, and confirm the planner picks it before dropping the old one.

### 26. Merge the remaining polling loops into one get_pulse(p_workspace, p_channel, p_since) on a single 20s timer, absorbing the heartbeat write, the online set, the unread map, the read-receipt count, the later-queue count and the member backstop  `l` `needs DB` `medium`

Merge the remaining polling loops into one get_pulse(p_workspace, p_channel, p_since) on a single 20s timer, absorbing the heartbeat write, the online set, the unread map, the read-receipt count, the later-queue count and the member backstop. This is the structural version of everything above and the honest reason it works is that response headers dominate a small poll - a get_unread body is ~385 B against ~250 B of headers, so a perfect cursor saves 39% of that loop while deleting the request saves 100%.

- **Where.** js/core/presence.js:77, :153, :173, :211 and js/features/messageExtras.js:177 and js/features/later.js:154; new SQL function
- **Saves.** After ranks 1-25 the idle-visible baseline is ~684 req/hour; the pulse takes it to ~354, i.e. 1,194 -> 354, a 70% cut. ~0.7 GB/month at 30 people (14% of the plan) against 2.37 GB today. Several things also get FRESHER: the later badge goes 90s -> 20s, receipts 30s -> 20s, the heartbeat 45s -> 20s.
- **Quality cost.** None to freshness, but it concentrates risk and that has to be designed for. Four amendments are mandatory. Keep the 4-tick gating for the cross-Space rollup and DM list INSIDE the RPC - a uniform 20s pulse would run get_space_summary (which takes no arguments and aggregates across every Space you belong to) six times more often than today, trading egress for database CPU on a shared-CPU instance. Leave the resume/backstop delta OUT of the pulse entirely. Carry a generation token and discard the whole response if store.ws or store.current changed while it was in flight. Return per-section results so one failing sub-query cannot void the body, and fall back to the individual calls after two consecutive failures. And keep every event-driven trigger exactly as it is - visibilitychange, online, focus, rejoin and the seq-gap detector are what actually deliver; the pulse is only ever a backstop.

---

## Deliberately NOT done

Each of these buys quota with something somebody would notice.

1. ALREADY DONE, do not pay for it twice: lowering MAX_UPLOAD_BYTES from 100 MB to 50 MB. js/config.js:112 already reads `50 * 1024 * 1024` with a comment describing this exact fix and its reasoning, and the size check already sits ahead of file.arrayBuffer(). One of the seven analyses was run against a stale working tree, which also means its arithmetic about videos ("at the current 100 MB client cap...") is computed against a cap that no longer exists. Re-read config.js and media.js against HEAD before committing to the image work.

2. ALREADY DONE: skipping the topics unread-count query when the channel has no topics. topics.js:90 already reads `counts = rows.length ? await unreadCounts(ch.id) : null`. The 500-row backward scan it was meant to prevent cannot fire in a topic-less channel. The partial index at rank 25 is still worth having for channels that do use topics.

3. Gating the 25s resync backstop on evidence the socket is delivering frames. All three adversarial passes rejected this, and it is the only loop in the codebase with fifteen lines of comment explaining why it exists. The failure it catches is a socket that reports joined and carries nothing - and a topic delivering SOME frames while silently dropping others satisfies the proposed skip condition on every tick, while the seq-gap detector only finds a hole if a LATER message actually arrives. If the drop is at the tail, nothing catches it. That is 'I have to refresh the site to see new messages' reintroduced through a side door, for 45-85 requests/hour. QUALITY IT WOULD COST: message delivery reliability, the single thing this app was rebuilt around.

4. Using api.resume() with the cached cursor instead of fetching a page on a warm channel open (and the same idea for DMs). Two of three attackers rejected it and the third only shipped it with a list of caveats that includes a hole none of the original analyses saw: reactions are NOT in channel_events, so a resume-only open refreshes reaction counts for newly-arrived messages only, and a reaction added while you were away shows a stale number. The same analysis that proposed this correctly rejected caching reactions for precisely that reason. It is l effort at medium risk on openChannel - the most correctness-critical path in the app - for roughly 8 KB gzipped per warm open. QUALITY IT WOULD COST: a deleted or edited message could stay on screen, correctable only by a reload.

5. Addressing voice signals to per-recipient realtime topics. The R^3 -> R^2 arithmetic is right and the HTTP fallback is real, but it does not fix the thing it is justified by: the proposal itself concedes an 8-person room still emits 168 messages/second against a 100/second cap even after the change. Voice signalling is ~0.6% of the realtime quota at this size. Against that, it needs a new RLS policy on realtime.messages that cannot be verified from this repo. QUALITY IT WOULD COST: if that policy is wrong, calls silently fail to connect with no error surface at all. Ship the ICE batching at rank 20 instead, and revisit only if voice rooms routinely exceed six people.

6. Suppressing the typing broadcast in channels above 40 concurrent viewers. Two of three rejected it. Its own author states the saving is zero at 30 people and probably zero at 100. It needs a server change to plumb viewer_count onto channel rows, and viewer_count is not trustworthy yet anyway because hidden tabs currently report a channel they are not looking at (fixed at rank 16). QUALITY IT WOULD COST: in the organisation's busiest channel - the one place where knowing a colleague is already answering matters most - nobody can see that anyone is composing, so two people write the same reply.

7. Suppressing typing at a LOW viewer threshold (10-15), or dropping the typing indicator entirely. At this organisation's message rate the indicator is lit only about 6.5% of the time at 12 viewers and it still names the person, which is exactly when it is worth reading. QUALITY IT WOULD COST: a working feature, for about 4% of the bill.

8. Raising the typing keepalive from 10s to 25s and the receiver expiry from 12s to 30s. Worth about 3% of channel traffic. QUALITY IT WOULD COST: a ghost 'X is typing...' left on everyone's screen for up to 30 seconds after a client dies mid-sentence, instead of 12. Every graceful exit already sends an explicit stop, so this only bites on hard death - but a lie on screen for half a minute is a visible wrong for a rounding error.

9. Stopping mark_read broadcasting back to the calling device. The entire claimed saving - and the claim that the realtime wall sits at 57 rather than 74 people - rests on a code comment at channels.js:777-779, not on the schema, which is not in this repo. That comment has already gone stale once: it says the event is one 'nothing listens for', but main.js:368 now binds it to a three-RPC refreshUnread. Do not build a server change against an unverified assertion. The blunt variant is worse: QUALITY IT WOULD COST: read a message on your phone and the badge stays lit on your laptop for up to 30 seconds. Rank 12's debounce already removes the expensive downstream half of this with no server work; check `select prorettype::regtype from pg_proc where proname='mark_read'` before spending anything more.

10. Passing {full:false} to refreshUnread on the channel-open path. All three attackers rejected it as superseded by the local-clear at rank 2, which removes all three requests rather than narrowing to one. QUALITY IT WOULD COST: on its own it makes another Space's rail badge up to 120 seconds stale after every channel switch.

11. Capping the bootstrap member roster at 200, or adding a p_members_since delta. I traced what a missing profile actually renders: nameOf falls back to the literal string 'someone' and the avatar renders '?'. That is not confined to mention autocomplete - it hits the message list, the member panel, reaction tooltips, read-receipt tooltips and the voice participant labels in the sidebar. At 30 to 100 people the whole roster is 6-13 KB and the cap never even binds. The delta variant is worse: a delta with no tombstones cannot express removal, and the one client signal that would repair it (member_left on the ws: topic) is missed entirely whenever the tab is in another Space. QUALITY IT WOULD COST: colleagues rendering as 'someone' with a '?' avatar, and departed colleagues lingering in the member list and DM picker with nothing to clear them. Take the field-trimming at rank 24 instead, which has no correctness cliff.

12. A separate 25 MB cap on video. This is the only proposal in the entire set that takes a capability away from people, and two of three attackers rejected it on exactly that ground. The arithmetic is alarming and correct (one 45 MB clip seen by 14 people is 12.6% of a monthly quota) but the existing mitigation is already better than the proposed one: media.js:127 sets preload='metadata', so an unplayed video costs only a range request. QUALITY IT WOULD COST: someone with a 40-second clip is refused and has to go and trim it. If you want awareness, put a size warning in the composer - but this is your call, not an engineering default.

13. Lowering image quality below q0.82 or capping the longest edge at 1024px, and any tap-to-load placeholder instead of an inline image. The placeholder is by a wide margin the biggest single saving available anywhere in this codebase - 80% or more of image egress in one line. QUALITY IT WOULD COST: reading a conversation gains a step and gets visibly slower, and at 1024px a photographed whiteboard or document stops being readable. 2048px at q0.85 is the point where both the 340px inline box and the full-screen lightbox are clean at every screen density; below it you start costing people information.

14. Automatically deleting or expiring old attachments or old messages to stay under the 1 GB and 500 MB caps. QUALITY IT WOULD COST: an image that was in the channel yesterday and is a broken box today, unrecoverable rather than fixable by reloading; or somebody scrolling up and finding their history gone. Flagging honestly that after every change on the list, storage still fills in about 28 days at 300 people - so a retention decision is coming. It has to be an announced, agreed org-level rule, never a silent background sweep, and it is your decision to make, not one to be made by stealth.

15. Raising the signed-URL lifetime to an hour as a caching measure. The storage analysis proves in its own text why this is the wrong fix: viewer A and viewer B each get a JWT with its own timestamps, so they get different URLs and different cache keys NO MATTER HOW LONG THE EXPIRY IS. It only helps the same device re-viewing, which the service-worker cache at rank 10 already handles. QUALITY IT WOULD COST: it is the only one of the three attachment fixes that widens a security window - a leaked URL stays live 12x longer - in exchange for a benefit something else delivers free. The window-pinned variant (a fixed 6-hour boundary so every viewer gets a byte-identical string) is the correct version of this idea and belongs after rank 10; it is worth revisiting once the service-worker cache is measured.

16. Making the attachments bucket public to get perfectly cacheable URLs. It is the simplest possible fix for the cross-viewer problem and it would work. QUALITY IT WOULD COST: every file becomes readable forever by anyone holding the URL, including after the message is deleted and after the person leaves the organisation - and 'forever' is not an overstatement, because there is no revocation on a public object. For a product carrying three real organisations' internal documents that is not a trade to make by default.

17. Lengthening any healing interval - the 30s unread poll, the 25s backstop, the 9s reaction sweep, or the read-receipt cadence outside the recency window. Every proposal on the final list either removes redundant work or gates it on proof it is unnecessary; none makes a healing loop slower. QUALITY IT WOULD COST: a stale unread badge is the single most visible wrongness available in a chat app and it is the reason people reload.

18. Moving presence onto Supabase Realtime Presence, or broadcasting heartbeats instead of polling user_presence. It looks like the obvious win and it is a trap, because realtime is billed per recipient: 30 clients beating every 45s fanned to 30 subscribers is 72,000 messages/hour = 52 million/month against a 2 million cap, 26x over, and it worsens quadratically. The free plan also caps presence at 20 messages/second and 5 presence calls per client per 30 seconds. The current poll is the cheap option and should stay a poll.

19. Turning on the server-side digest/nudge valve for ordinary channels. It is the only mechanism that touches the irreducible 1+V per message and therefore the only thing that reaches 300 people - but every message it batches then costs the reader a resume round trip before it appears. QUALITY IT WOULD COST: chat becoming visibly slower, which is the one thing ruled out. It belongs at a high viewer_count (60+) and gated on burst rate, never as a general setting - and rank 16 has to land first, because viewer_count is its only input and hidden tabs currently corrupt it.

20. Removing or lengthening the 30-second ensureFreshAuth interval at sb.js:222. Several analyses listed it in their loop tables as if it were a cost centre. It is not: verified against the pinned auth-js 2.72.0 and realtime-js 2.15.5 sources, getSession returns from localStorage unless the token is within 90 seconds of expiry, and re-pushing an unchanged token to the socket emits zero frames. 2,880 fires a day cost zero requests. QUALITY IT WOULD COST: the wake-from-sleep guarantee that the comment beside it was written for, which is the client half of 'I have to refresh the site to see the latest messages'.

21. Replacing soop-jira's admin.auth.getUser with a local JWT decode, and hoisting the per-redeem anon client to module scope. All three attackers rejected both. The first saves ~100ms on a call somebody makes twice a day, and buys it by making correctness depend on a flag in a deploy command rather than on code: the day anyone adds --no-verify-jwt to that line, a forged sub claim acts as any user. The second saves a few milliseconds of object construction and leaves a warm isolate holding the previous request's session in memory - inert today, which is exactly what makes it a footgun for whoever edits the file next.

22. Reducing MESSAGE_PAGE below 50, or shrinking the page cache. Fewer bytes per open, but paging up then costs a fresh fetch per page, so it moves cost rather than removing it. QUALITY IT WOULD COST: scrollback feels worse on exactly the slow phones the caches exist for, and the offline first-frame view shows less history.

23. Setting broadcast self:false on the channel topic so a sender does not receive their own message back. It saves one frame in N and looks free. It is not: the sender's copy of their own message would depend entirely on the send RPC's response arriving, so a write that succeeds while the response is lost leaves the author staring at a permanently pending row. There is also no saving to be had - the client never broadcasts on that topic at all.

24. Merging one get_channel_view RPC across the whole channel-open path. Deferred rather than refused. openChannel deliberately fires threads and get_channel_messages in parallel, and the comment there records that awaiting the unbounded threads query in front of the thing the person clicked was the bug being fixed. If it is ever built, get_channel_messages must stay its own parallel call so a slow sub-query cannot delay the conversation. Re-measure first: after ranks 2, 7 and 14 the channel open drops from 14 requests to about 9, and the polling loops are where the money actually is.

25. Nulling the duplicate `body` jsonb column when it is a plain {text} copy of body_text. About 10% of the message footprint on a database with roughly two years of runway at this size, bought with a server change touching every read path. QUALITY IT WOULD COST: if the omission is not strictly conditional, or if one read path forgets the coalesce, polls, forms and event cards silently render blank - and one of the paths that would need it (the resync fetch at channels.js:948) is a direct table select, not an RPC, so it would bypass a coalesce written into get_channel_messages. Revisit only if the database measurement at the end says disk is actually a near-term wall.

---

## The ceiling

## Where the free plan actually breaks, after everything on this list

**~90-130 people, and a hard stop at 200 regardless.** Three walls, in the order they arrive:

1. **Realtime messages, at roughly 95 people.** After the typing fixes, a message costs about 1.85V+1 billed messages where V is the number of people watching that channel. At the assumed V = 0.27 x headcount, 95 people uses 2.03M against a 2M cap. This is the softest of the three numbers because V is a guess - if your busiest channel has half that many watchers, the wall moves to about 130 people. **One query settles it.**

2. **Egress, at roughly 135 people.** After everything including the pulse, 100 people uses ~74% of the 5 GB bucket. Without the pulse it is ~118% and 100 people does not fit. This is the wall you can push furthest with engineering, and the pulse (rank 26) is the last big push available.

3. **Realtime concurrent connections, at exactly 200.** Every browser holds one websocket. At 200 open browsers the 201st cannot connect at all. This is a step function with no warning, no gradual degradation and no client-side mitigation, and it arrives first during a burst - everyone signing in at 9am while stale sockets have not yet been reaped. **No amount of optimisation moves this one.**

Two other things break before 300 even if the above were solved: file storage fills in about 28 days at 300 people (there is no attachment deletion path anywhere in the codebase), and an 8-person voice room exceeds the 100-messages-per-second ceiling during connection setup under any client-side fix.

## Measure these five things before spending a week on the medium-risk half

Each one replaces a guess that several conclusions above stand on. Together they are about ten minutes of work.

1. `select name, viewer_count from channels order by viewer_count desc limit 20;` - replaces V = 0.27P. Every realtime figure in this document scales linearly in it, and it is the weakest number underneath the biggest conclusions.
2. `select pg_size_pretty(pg_database_size(current_database()));` plus the per-table breakdown - replaces an entirely inferred database model and decides whether the DB workstream is a two-year problem or a two-month one.
3. One week of Storage egress from the Supabase dashboard - settles a 6x disagreement between two analyses about the single largest and least certain line in the whole budget. It swings your total between 10% and 250% of the plan.
4. `select prorettype::regtype from pg_proc where proname = 'mark_read';` - decides whether rank 2 saves three requests per channel open or fixes a badge that never clears. Two entirely different changelog entries.
5. DevTools, network tab, one idle visible hour - gives the real metered bytes per request and settles the 605-vs-250 byte header argument that doubles or halves the entire egress model.

## The first thing worth paying for

**Supabase Pro, $25/month for the organisation.** It is not a marginal upgrade - it moves every wall at once: egress 5 GB -> 250 GB (50x), realtime messages 2M -> 5M, realtime concurrent connections 200 -> 500, database 500 MB -> 8 GB, file storage 1 GB -> 100 GB, Edge invocations 500k -> 2M. It includes $10 of compute credit, so the Nano instance stays free within it.

Concretely: at 300 people, after everything on this list, you would be at roughly 4.5% of Pro's egress, 400% of its realtime message allowance (still the binding wall, and still only fixable with the server-side digest valve), and 60% of its connection cap. So Pro plus the digest valve is the route to 300; Pro alone gets you comfortably to ~250.

**Do the free work first anyway.** Not to avoid the $25 - at 100+ people you will pay it regardless - but because everything on ranks 1 through 9 is either a bug fix or a strict improvement, and because paying for a plan to carry 300 requests an hour that refresh nothing is how a $25 bill becomes a $300 one at 500 people. Ranks 1-9 are roughly a day of work, need almost no server change, and every one of them is neutral or better on quality. Ship those, measure the five numbers, then decide about the medium-risk half one item at a time - each of ranks 10, 11, 19 and 26 has an edge that only shows up on a reconnect, a stale cache, a second tab or a Space switch mid-flight, and shipping two at once makes the resulting bug report unattributable.
