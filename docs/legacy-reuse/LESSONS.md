# Lessons from the legacy Dek client (carry these into the rebuild)

Harvested 2026-10-03 from tag `legacy-final` (reference checkout `../dek-legacy`). File refs
are under `dek-legacy/`. KEEP = port the behavior, AVOID = it was a mistake.

## Push
- KEEP payload `{title, body, url, tag}`, one tag per conversation with `renotify: true`, app
  badge set on push and cleared on open. Drop notifications older than 1 hour.
- KEEP permission prompt only from a real click; in `denied` show per-browser instructions
  (requestPermission cannot re-prompt); if granted but unsubscribed, subscribe silently.
- KEEP the VAPID mismatch guard: compare `sub.options.applicationServerKey` with the current
  key and re-subscribe if different. The legacy meta tag shipped a different public key from
  the one the server signed with, so Apple rejected every push. ONE source for the key (build
  env) plus a health check.
- AVOID never unsubscribing on sign-out: on a shared phone the next person got the previous
  person's lock-screen previews. Unsubscribe and unregister at sign-out.
- AVOID silent push on WebKit: Safari revokes subscriptions whose pushes do not show a
  notification. Suppress for a focused window only on Chromium.
- AVOID mismatched tags between local notifications and push (two OS notifications for one
  message).
- iOS Safari tab has no PushManager: tell the person to Add to Home Screen (iOS 16.4+), do not
  say "unsupported".
- Server: `npm:web-push@3.6.7` under Deno; prune 404, 410 and `VapidPkHashMismatch`; exact
  (timing safe) secret compares; a real `VAPID_SUBJECT`. Use the `sb_secret_*` key: the legacy
  service-role JWT silently stopped bypassing RLS and the sender read zero subscriptions.

## iPhone and phones
- Standalone: `matchMedia('(display-mode: standalone)') || navigator.standalone`; iPadOS is
  `MacIntel && maxTouchPoints > 1`; iOS Safari excludes CriOS, FxiOS, EdgiOS, OPiOS.
- Install: stash `beforeinstallprompt`, prompt from a click; iOS gets a Share then Add to Home
  Screen sheet.
- Fixed body with per-pane scrolling; `#app { height: 100% }` (not dvh); safe-area tokens from
  `env()`; add a visualViewport driven `--kb` keyboard inset for iOS.
- Inputs at least 16px font on small screens (stops iOS zoom).
- Tap feedback needs all three: `-webkit-tap-highlight-color: transparent` with
  `touch-action: manipulation`, an empty passive `touchstart` listener on document (iOS never
  applies `:active` without one), and `:active` styles.
- Hover only under `@media (hover: hover) and (pointer: fine)`.
- Long press is unreliable on iOS: every message action is also in a visible menu button.
- Save files on iOS with `navigator.share({ files })`.

## Auth
- Codes: 6 digits, `autocomplete="one-time-code" inputmode="numeric"`, auto-verify on the 6th
  digit, 60 s resend countdown, verify against the address the code was sent to. Use
  `crypto.getRandomValues`, constant-time compares, no dev escape hatches.
- Password forms are real `<form>`s with autocomplete attributes (password managers), a
  readonly username field on set-password. On "invalid login" retry once with the password
  trimmed (Android long-press copy adds a trailing space); trim new passwords.
- Enter in the email field moves to the password field.
- AVOID the per-request password latch hook (`db_pre_request`): 6.4% of all database time.
- supabase-js handles refresh; never run two refreshes at once (rotation kills the session);
  push new tokens to Realtime (`setAuth`).
- Sign-out wipes every local cache keyed by user (shared phones).
- A stale cached index.html running newer JS: clear caches and reload once.

## Message rendering
- Real data is CommonMark style: lists, `**bold**`, `*italic*`, line breaks, bare URLs. No HTML.
- Encode mentions as `<@uuid>` (legacy stored `@name` text and broke on rename).
- AVOID images in rendered markdown (tracking pixels). Load syntax highlighting only when a
  code fence appears. Never put user numbers into style attributes unvalidated (it was an XSS).
- `dir="auto"` on message bodies; Enter must check `isComposing` / keyCode 229 (IME users sent
  mid-word).

## Durable sending
- Legacy failures: the composer cleared text before the network was touched; retry minted a new
  id and dropped attachments; Android killed backgrounded PWAs and DOM-only text was lost; pending
  rows never resolved; raw "Failed to fetch" text in bubbles.
- KEEP: write to IndexedDB BEFORE the network (localStorage fallback, 3 s open timeout for
  WebViews that hang); replay with the ORIGINAL client id; 15 s request timeout; retry 401 (token
  expired in a pocket), 429, 5xx with backoff 2 s to 120 s plus jitter; other 4xx = failed with a
  human reason, Try again and Delete; flush oldest first, one at a time per channel; show
  delivery state only after 900 ms.

## Media
- Reject over-size files before reading them. Preserve original image bytes, dimensions and
  format (Fixboard #29, 2026-10-10); the former 1600 px resize blurred design lettering.
  Resize only the separate 640 px preview. Probe dimensions and duration before upload.
  Thumbnail failures never fail the upload. Unsupported image formats remain downloadable.
- Video: `playsinline preload="metadata"`, reserve aspect ratio.
- Signed URLs: batch mint, cache by expiry, mint once per sweep.
- AVOID `const net = fetch(req); return hit || await net` (creating the promise sends the request).
- Service worker media cache: refetch no-cors images as cors, key by path without the signature,
  cache-first with an LRU, wipe on sign-out.

## Calls
- Perfect negotiation (polite peer by id order, rollback on glare), buffer ICE until the remote
  description, serialize renegotiation, hold signals that arrive before the peer exists, stop
  every AudioContext you start.
- TURN: await the token (legacy sent "Bearer [object Promise]", so calls were STUN only and
  failed on Jio and Airtel CGNAT). Do not cache ICE servers forever (6 h TTL).
- Treat `disconnected` as transient (about 6 s grace); batch ICE candidates (150 ms) because an
  8 person mesh floods the realtime rate limit during setup.
- Direct calls: open the mic before ringing, ring 45 s, server state is the single writer,
  ending is idempotent, "busy" when already in a call, hang up on pagehide.

## Caching and deploy
- Navigations network first; own hashed JS and CSS cache first; never cache the Supabase API.
- No `skipWaiting` in install (stranded open pages on old modules); apply updates only when
  safe (empty composer, no modal, not recording).
- Generated precache list from hashed build output, never a hand list.
- `_headers`: no Cache-Control on `/*` (Cloudflare appends it to other rules); `immutable` for
  hashed assets; `sw.js` no-cache. Deploy `dist/` only (legacy published its schema and scripts).

## Realtime
- realtime-js drops an errored channel and never re-adds it: own the resubscribe loop, refresh
  the token before rejoining, force a retry on visibility and online (a sleeping socket looks
  joined for about 35 s).
- Never advance a cursor past a hole; a failed heal must not move the cursor; guard racing
  channel switches with a generation token.
- Typing: start after a short delay, keepalive 10 s, expire 12 s, a new message clears it.
- Presence by Realtime Presence is billed per recipient: avoid it.

## Other
- Accessibility: `role="log"` message list (mute aria-live while painting a page), rows as
  articles with labels, menus with arrow keys, one Escape stack, `:focus-visible` only.
- Emoji: bundled list (works offline), recents in localStorage.
- Self-host fonts or use system fonts (offline cold start lost fonts).
- Every local cache keyed by user id and wiped on sign-out.
- Jittered, capped retries everywhere: client retries amplified the 2026-09-30 spike.
