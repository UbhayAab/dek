# Dek: plugin mode and task management

Design produced by a 19-agent research and audit pass (11 external research
reports, 6 codebase audits, 1 synthesis). Kept in the repo because the
measurements in it are expensive to reproduce and the traps are the kind of
thing that is only obvious once.

Steps 1 through 8 of the roadmap are DONE in the client; what is left of them
is server-side deploy work. The status block below was written 2026-08-25 by a
driver sweep that re-verified every "today"/"currently" claim in this file
against the live tree; sections keep their original analysis because the
measurements in them stay true, and any claim now false carries a dated banner.
Do not re-implement anything carrying one.

## Status 2026-08-25 (driver sweep, supersedes stale text flagged inline)

LANDED since this plan was written, client side:
- Roadmap 1-2: SW precache complete for the whole module graph (VERSION
  dek-v16), attachment XSS sinks hardened, DEMO_TOKEN gone, referrer set.
- Roadmap 3: hosted off GitHub Pages; _headers at repo root serves
  frame-ancestors; localhost gated out of EMBED_ORIGINS.
- Roadmap 4: #app is `container: dek / inline-size` (7ed459f, d2102c2); the
  size media queries governing panel geometry migrated to container queries.
- Roadmap 5 core: pointer-axis target sizing via data-input (23a450f);
  safe-area insets dropped to --safe-* tokens, f7a8e82; narrow message
  geometry behind @container dek (max-width: 440px), 92e7848.
- Roadmap 6: panel sheet + navStack + back chevron eae2fe9; single merged
  40px header below 480px of app box 3a26193; sidebar pushed full-width view
  below 440px b07f22c. NOTE: the bottom tab bar was REJECTED here but shipped
  anyway (js/tabbar.js) - deliberate product reversal, do not delete it.
- Roadmap 7-8: bridge hardened end to end - ev.source pin 0539aa2, navigate
  allowlist/signout teardown/origin anchoring in the P0 batches, visibility
  push + re-identify follow fc3d6fc, tasks/close-request/size outbound and
  notifications host note 4bd7168.
- Keyboard/a11y section: hijacks removed 400ee1b; LIFO close stack +
  CloseWatcher fast path daf00df; role=log live region gated on panel
  visibility 6893a9f (kept aria-live=polite as the mute switch, deviation
  noted in its proof); --kb keyboard-inset token bf25228.
- Roadmap 18: js/lib/forecast.js implements the whole measured kernel
  (WINDOW_DAYS 56, MIN_SAMPLES 12, pct/refClass/conditionalRemaining/ageBand/
  mcWhen) exactly as specified.
- Bug list items 1-13 and quick wins 1-22: every item verified landed against
  the live tree by three separate sweeps recorded in DRIVER-STATE.md
  (commits 7552bac, fec9789, 7cebd18 among others).

STILL OPEN:
- Roadmap 10-11: embed registry tables, ensure_embed_space, OIDC tier A,
  ticket tier B - backend-heavy, DB deploy window needed.
  BANNER 2026-08-25: roadmap 9's CLIENT half landed (f1218a0) - the registry
  gate in features/index.js keeps admin/orgadmin/integrations out of embeds,
  sign-out/leave-space removed in embed mode, pinned Space refuses switching;
  verified live (embed boot loads 33 features, standalone all 36). Do not
  re-implement gating from the stale text above.
- Task system steps 12-17, 19-30 (schema v2, forecast on the card, nudges,
  digest, Jira interop): backend-heavy, none started.
- Density attribute tier (#app[data-density]): blocked on choosing concrete
  compact/cozy --s-* values, a design decision no headless burst will make.
  NOTE 2026-08-25: the concurrent ground-up session reworked sidebar density
  directly (33px rows, 442f875) rather than via a data-density tier.
- Voice ICE batching (EFFICIENCY rank 20): needs a real call to verify;
  rejected by thirteen consecutive bursts for exactly that reason.

---

## Verdict

The tree is well ahead of the audits. Verified just now: the grey-box rail divider is ALREADY FIXED (css/polish.css:81 is `#spaceRail > .sicon`, with the measured 24x44 explanation at line 70), and a deterministic NL intake already exists and is registered - js/lib/asks.js (343 lines: parseDue/parseAsk/sayDue, confidence scoring, a `why` array, unowned and self-commit detection) driving js/features/quicktask.js (confirm strip, amend dialog, /task). That is the single highest-risk item in the whole brief already built, correctly, with no model and no round trip. Do not rebuild it.

WHAT IS A REAL WIN. (1) The embed is ~70% done and the iframe choice is right for a measured reason already written into js/embed.js's header: a cross-site iframe gets its OWN viewport so `@media (max-width:860px)` fires and the narrow layout applies for free, while `(hover:none)` does NOT match so the 44px thumb floors stay off. A web component would have inherited the host's viewport and put the desktop layout in a 400px box. (2) Chat-native tasks: the source message's thread IS the task's discussion. Linear spends real engineering faking this with synced Slack threads; Height's customers named chat-per-task as the feature they loved, then Height shut down (Oct 2024 launch, Sept 2025 dead, >$18M raised) betting on the auto-attributes vision instead. Dek gets the good half free. (3) The conditional-remaining forecast: given a task is 5 days old and still open, filter past cycle times to those >5 days, subtract 5, read percentiles. ~200 lines of dependency-free JS, 1.4ms for 5000 Monte Carlo trials, fed entirely by rows list_tasks already returns. Nobody ships this on the task card - Linear leaves project health as a human judgement, Jira has no native predicted date. That is a genuine, defensible gap.

WHAT IS MARGINAL. Story points (the strongest published estimator, Deep-SE, beat a median-of-past-items baseline in 8 of 42 settings). Cycles/sprints. Custom fields. A kanban board in a 380px panel (it degrades to a horizontally scrolling column of one). Two-way Jira field sync. AI enrichment in the create path - Linear's own AI triage takes 1-4 MINUTES per issue and still never blocks issue creation.

THE CEILING. Dek can credibly replace Jira for a 30-300 person mixed technical/non-technical org, and can be embedded as a first-class panel. It cannot match Linear's perceived speed without a client-side object database with a monotonic sync counter, and should not try yet. The honest ceiling on requirement 4 is: ownership, dates, blockers, progress and forecasting handled automatically-and-confirmed; not handled silently. Asana shipped silent auto-promotion between Today/Upcoming/Later and REMOVED it because users read it as lost work.

[STATUS 2026-08-25: RESOLVED. The app moved off GitHub Pages; _headers at the
repo root serves frame-ancestors (see its own header comment). The residual
client-side refusal hardening landed with the P0 embed batches.]

THE ONE THING THAT GATES EVERYTHING. GitHub Pages cannot send response headers, and `frame-ancestors` is ignored in a `<meta>` CSP. So today any page on the internet can iframe Dek with a live session and clickjack it - js/main.js returns via enter() before the embed auth-wait branch, so an existing session paints the full authenticated UI regardless of who the real parent is. The allowlist in js/config.js stops the bridge, not the framing, and config.js already says so. Moving off Pages is a prerequisite, not a follow-up. Until then embed mode is a demo, not a product.

[STATUS 2026-08-25: STALE. sw.js VERSION is dek-v16 and SHELL_FILES precaches
./js/embed.js and ./css/embed.css plus every feature module; the offline blank
page was fixed in the P0 batches and re-proven by the SW precache burst
(53/53 shell paths verified on disk). Kept only as a record of the audit.]

ALSO LIVE RIGHT NOW, VERIFIED: sw.js VERSION is still 'dek-v9' and SHELL_FILES contains neither './js/embed.js' nor './css/embed.css', while js/main.js STATICALLY imports './embed.js'. On an offline cold start the module graph fails and the STANDALONE app is a blank page. The embed work regressed the non-embedded app.

---

## Plugin architecture

## Decision: iframe, wrapped in a light-DOM custom element. Keep the iframe.

Do not revisit this. The measured argument is already in js/embed.js's header and it is correct. Reinforcing evidence: Cord shipped shadow DOM then deliberately removed it in JS SDK 1.0.0 (30 June 2023) because customers could not restyle past the exposed variables, then the company folded; TalkJS, the canonical iframe vendor, rewrote as light-DOM web components with a `html:is(html):is(html):is(html):is(html):is(html) :where(t-chatbox *){all:revert-layer}` reset - which does NOT defeat a host that puts its CSS in `@layer`. Dek additionally has window-level keydown handlers, a hash router, `<html data-theme>`, a service worker and its own CSS reset in css/base.css. All five collide in light DOM. The iframe also gives total shortcut isolation for free: keyboard events do not cross a frame boundary in either direction.

Ship the PUBLIC surface as a custom element anyway, because that is where the ecosystem landed and it gives hosts normal CSS sizing, normal DOM events and normal teardown.

## Loader snippet

Two forms from one file, `/embed.js` served from the Dek origin.

Module hosts:
```html
<script type="module">
  import Dek from 'https://dek.acme.com/embed.js';
  const panel = Dek.mount('#dek', {
    space:  'tech',            // host_key; resolves to a provisioned Space
    chrome: 'minimal',         // rail hidden, switching still reachable
    theme:  'dark',
    auth:   async () => ({ idToken: await fetch('/api/dek-token').then(r => r.json()) }),
  });
  panel.on('unread', ({ total, mentions }) => badge(total, mentions));
  panel.on('tasks',  ({ open, overdue }) => taskBadge(open, overdue));
</script>
<dek-panel id="dek" style="width:380px;height:100%"></dek-panel>
```

Legacy hosts get the standard queue stub - a global function that pushes arguments onto an array, plus an async script tag. Every vendor surveyed (Intercom, Crisp, HubSpot, Zendesk, Tidio) ships exactly this and it is ~10 lines. Without it, half the calls made before the network settles are lost and integrators blame Dek:
```html
<script>window.Dek=window.Dek||function(){(Dek.q=Dek.q||[]).push(arguments)};</script>
<script>Dek('mount','#dek',{space:'tech',chrome:'minimal'});Dek('on','unread',badge);</script>
<script async src="https://dek.acme.com/embed.js"></script>
```

`auth` is a CALLBACK, never a static token. Every serious platform learned this: Stream returns error code 40 specifically meaning "use a provider, not a static token"; Sendbird requires setSessionHandler before connect; Ably takes authCallback; Zendesk takes `loginUser(cb => cb(jwt))`. A dashboard tab left open overnight outlives any single token.

### Iframe attributes the loader writes itself

```js
frame.setAttribute('allow', 'clipboard-write; microphone; autoplay; web-share; fullscreen');
frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
frame.setAttribute('title', 'Dek team chat');   // WCAG 4.1.2; an unlabelled frame is announced as "frame"
```
DROP `camera` and `display-capture` from the current embed.js:80-83. Grep confirms nothing in the repo calls getUserMedia with video or getDisplayMedia - js/core/voice.js:30-32 asks for `{audio:{...}, video:false}`. Over-granting is what makes a host security reviewer refuse the whole embed, and combined with the two live XSS sinks in js/core/media.js it would turn message-body script into screen capture on the dashboard's page.

Publish "do not add `sandbox`" as part of the contract. A sandbox without `allow-same-origin` gives the frame an opaque origin, `localStorage` throws SecurityError, and supabase-js silently falls back to `memoryLocalStorageAdapter` (GoTrueClient does `if (supportsLocalStorage())... else memoryStorage`). Everything works until the first reload, which signs everyone out with nothing in the console.

Tell hosts the iframe needs an explicit height. css/base.css:26-32 sets `body{position:fixed;inset:0;overflow:hidden}`, so the app can never grow to its content and auto-sizing is impossible by construction. Log a console warning when the measured height is under 200px - collapsed-to-zero is the most common embed support ticket across every vendor.

## postMessage bridge

Envelope already implemented and correct: `{ dek: '<type>', v: 1, ... }`, bound to the exact pinned origin in both directions, with `ev.origin !== embed.host` checked before dispatch. Keep it. Four changes:

1. Add `if (ev.source !== window.parent) return;` before the origin check. The host loader already checks `ev.source` (embed.js:140); the app does not, so any window at an allowed origin - a sibling frame, a popup the dashboard spawned - can drive the panel.
2. Normalise once at init: `embed.host = new URL(host).origin;`. Today the raw query-string value is stored and later compared with `!==`, so a trailing slash passes `originAllowed` and then never matches an inbound message, hanging the panel for the full 15s giveUp.
3. Anchor the wildcard. `pat.replace('*.','')` replaces the first occurrence ANYWHERE, and the match also accepts the apex (`u.hostname === p.hostname`), contradicting config.js's own promise of "subdomains of that host, and nothing else". Require `pat.startsWith('https://*.')`, strip exactly that prefix, and match only `u.hostname.endsWith('.' + p.hostname)`. Reject any pattern containing a path at load time.
4. Fix the dead branch at js/embed.js:155-156 - `if (msg.channel)` catches every message that also carries `msg.message`, so `#/m/<channel>/<seq>` is unreachable.

### Inbound (host -> panel)

| type | payload | notes |
|---|---|---|
| `auth` | `{idToken, provider}` or `{handoff}` | DELETE the raw `{session:{access_token, refresh_token}}` branch |
| `signout` | - | must tear down, see below |
| `navigate` | `{space}` \| `{channel}` \| `{channel, message}` | **allowlist only**, see below |
| `theme` | `{theme}` | also apply `embed.theme` from the URL at init - it is parsed and stored today and never applied |
| `tokens` | `{'--c-accent': '#4f7cff'}` | tighten, see below |
| `visible` | `{visible: bool}` | NEW, load-bearing |
| `focus` | - | NEW, so the host can bind its own shortcut |
| `ping` | - | |

**`navigate` is currently a privilege-escalation hole.** `msg.route` is written straight to `location.hash`, and js/main.js:74-92 `redeemFromRoute` redeems `#/join/<token>` and `#/join-org/<token>` with no confirmation and no user gesture. An allowlisted-but-XSS'd dashboard silently enrols the signed-in person into an attacker's organisation, or drives the panel to `#/admin` and clickjacks it. Drop the free-text `route` branch entirely. Accept only `{space}`, `{channel}`, `{channel, message}` and resolve them through the lookup js/main.js:224-228 already uses - the host names a room, the app decides the route. If a general route is ever needed, allowlist `#/c/` and `#/m/` prefixes and explicitly refuse `#/join`, `#/join-org`, `#/admin`.

**`visible` is not optional.** `document.visibilityState` inside an iframe reflects the TOP-LEVEL tab, so when the host collapses the panel with CSS the frame's visibility never changes and js/sb.js's `visibilitychange` handler never fires. js/sb.js documents a measured ~35 second window in which the socket reports `joined` while carrying no frames, curable only by `retryAllNow({force:true})`. On `{visible:true}` call `ensureFreshAuth()` then `retryAllNow()`; on false do nothing (keep the socket - a panel is a background surface by design). Also suppress `flashTitle()` in embed mode: the title never reaches the tab, and the `document.visibilityState !== 'visible'` gate at js/main.js:348 means it would essentially never fire anyway. Same gate kills js/features/notifications.js:106, and `Notification.requestPermission()` cannot succeed in a cross-origin frame in Chrome or Firefox at all - the Notifications spec deliberately defines no Permissions-Policy feature for it. In embed mode the notifications panel must say "your dashboard handles notifications" rather than offering a button that can never work.

**`tokens` needs tightening.** Today the key is shape-tested `/^--[a-z0-9-]+$/i` and the value is any string under 120 chars set on documentElement. Anything a stylesheet feeds into `background-image` or `content` becomes a `url()` the host chose - a per-load beacon from inside the panel. Allowlist ~8 token names (`--c-accent`, `--c-accent-hover`, `--c-bg`, `--c-surface`, `--c-text`, `--r-md`, `--c-nav-bg`, `--c-nav-text`) and validate values against a colour grammar `/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\))$/i`. This is Stripe's shipped posture for Connect embedded components: appearance variables are the only lever and CSS overrides are explicitly refused, because open CSS makes every internal class name a permanent compatibility contract. Dek is well placed here - css/tokens.css already declares everything on `:root` and `:root[data-theme=...]`, so an inline `documentElement.style.setProperty` wins on specificity with no new machinery.

**`signout` currently leaks the previous person.** It calls `sb.auth.signOut()` and nothing else: store.me, the painted message list, the realtime topics and the pagecache/readcache all survive, so the previous person's conversation stays fully readable in the dock while the panel reports `auth-needed`. Mirror js/shell.js:84-91 exactly: wipe both IndexedDB caches, sign out, `location.reload()` - the reload re-sends `ready` and the loader re-runs the auth callback automatically.

**Re-identify is broken the same way.** A host calling `identify()` again after boot swaps the Supabase session but nothing re-enters the app, because `bus.on('embed:authed')` is only registered in the signed-out branch (js/main.js:553) and js/main.js:527 already returned via `enter()`. The panel then shows one person's messages under another person's token. In `applyAuth`, compare the new user id against `store.me` and `location.reload()` when it differs; register the listener unconditionally.

Also: `needsPasswordSetup()` (js/main.js:138) still routes a host-authenticated person to `showSetPassword()` inside a 380px dock, with no way out and no signal to the host. Do not skip the latch (a provisioned temp password would become permanent) - notify the host with `error {where:'password-setup'}` so it can render its own explanation and a link to standalone Dek.

### Outbound (panel -> host)

`ready`, `signed-in`, `auth-needed`, `navigated`, `unread {total, mentions}`, `error`, `pong` all exist. Add:
- `tasks {open, overdue, unassigned}` - wire to the existing `bus.on('tasks:count')` that js/features/coordnav.js:99 already consumes. Unread count is the one callback every single vendor ships because it is what makes a collapsed panel worth collapsing; task count is the same argument for this product.
- `close-request` - when the Escape stack empties, do NOT close the panel. A dock is furniture, not a dialog; dismissing it on a stray Escape while somebody is typing is a data-loss-shaped event. Post the request and let the host decide.
- `size {inlineSize}` from a ResizeObserver on `#app`, so a host with a resizable splitter can snap to Dek's own breakpoints.

Freeze the public verb list at nine: `mount, identify, open, close, toggle, navigate, on, setTheme, destroy`. Every vendor surveyed converged on exactly this set independently, so integrators already know it. Version the bridge with `dek:1` and the loader path `/embed/v1.js` so a v2 ships at a new path without breaking pasted snippets. `destroy()` must be wired to `disconnectedCallback` and call `unsubscribeAll()` plus the cache wipe - a host SPA that mounts and unmounts the panel on tab switches will otherwise accumulate live websockets against a platform cap of 100 channels per connection. Rate-limit and de-duplicate `identify` on an identity fingerprint: Intercom caps `update` at 20 calls per 30 minutes precisely because SPA hosts call it on every route change, and in Dek each call would re-run the whole ticket exchange.

## SSO / credential passthrough

Two tiers. DELETE the raw-session path currently in js/embed.js:95-101 rather than keeping it as a fallback - a fallback to the unsafe path is the path everyone will use. js/embed.js's own comment says a stolen refresh token is worth the account, and it is right.

### Tier A (recommended): Supabase Custom OIDC provider

Verified in GoTrue source (`internal/api/token_oidc.go`: `case strings.HasPrefix(p.Provider, "custom:")`). The id_token grant resolves custom providers, validates `aud` against `client_id` plus `acceptable_client_ids`, enforces `nonce` unless `skip_nonce_check`, requires a non-empty `sub`, and mints a REAL Supabase session with refresh token, `auth.users` row and `auth.identities` row.

Register once per host dashboard, service-role, from a script:
```
POST https://<ref>.supabase.co/auth/v1/admin/custom-providers
{ "provider_type": "oidc",
  "identifier": "custom:acme-tech",
  "name": "Acme Tech Dashboard",
  "issuer": "https://dash.acme.com",
  "client_id": "dek-acme-tech",
  "email_optional": true,
  "skip_nonce_check": false,
  "custom_claims_allowlist": ["tenant_id","team_slug","host_role"] }
```
Host mints RS256/ES256, `exp - iat <= 60`, `nonce`, and **no `email` claim**. Panel calls:
```js
await sb.auth.signInWithIdToken({ provider: 'custom:acme-tech', token, nonce });
```
Why this and not "Third-Party Auth": setting supabase-js's top-level `accessToken` option replaces `supabase.auth` with a Proxy whose `get` trap throws unconditionally. Dek calls ten distinct `sb.auth.*` methods across six files (signInWithPassword x3, updateUser x2, signOut x2, refreshSession x2, getSession x2, verifyOtp, signInWithOtp, signInAnonymously, onAuthStateChange, getUser). There would also be no `auth.users` row, `sub` would not be a UUID so `auth.uid()` breaks, and every RLS policy would need rewriting to `auth.jwt()->>'sub'` against a text column. Tier A leaves all ~32k lines untouched. It also lands in the `/auth/v1/token` bucket (1800 req/hr per IP) rather than `/auth/v1/verify` (360/hr per IP, explicitly not configurable) - a real ceiling behind office NAT.

Free plan caps custom providers at 3. Budget Pro before the fourth dashboard.

**Omit the email claim and set `email_optional:true`.** Supabase automatically links identities sharing a verified email into one user and documents no way to disable it. With two dashboards on one project, a sloppy or hostile host asserting `email_verified` for an address it does not own walks straight into the other tenant's Dek account. Dropping the claim removes the join key for the cost of one boolean. Keep the display email in Dek's own profile row where it carries no authentication weight.

### Tier B (fallback for hosts that cannot run an issuer): Edge Function ticket exchange

There is no `auth.admin.createSession` - the entire GoTrueAdminApi is ten methods and none returns tokens. The only server-mintable, client-redeemable artefact is `generateLink().data.properties.hashed_token`.

```ts
// supabase/functions/embed-ticket/index.ts   (verify_jwt = false, auth mode 'none')
Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const { host_key, assertion } = await req.json();
  const admin = createClient(SUPABASE_URL, SECRET_KEY);

  const { data: host } = await admin.from('embed_hosts')
    .select('*').eq('host_key', host_key).is('disabled_at', null).single();
  if (!host || !host.allowed_origins.includes(origin)) return json(403, {error:'origin'});

  // Tenant derives from the KEY that verifies, never from a field in the payload.
  const secret = Deno.env.get(`HOST_KEY_${host_key.toUpperCase().replace(/-/g,'_')}`);
  const claims = await verifyHS256(assertion, secret);        // throws on bad signature
  if (claims.aud !== host_key)          return json(403, {error:'aud'});
  if (claims.exp - claims.iat > 60)     return json(403, {error:'ttl'});

  // Replay: a unique-constraint insert is the only race-free store in a stateless isolate.
  const { error: dup } = await admin.from('embed_nonces')
    .insert({ jti: claims.jti, host_key });
  if (dup) return json(409, {error:'replay'});                // 23505 unique_violation

  const uid   = uuidv5(`${claims.iss}|${claims.sub}`, SOOP_NS);   // idempotent re-provision
  const email = `${uid}@embed.invalid`;                           // never the host's email
  await admin.auth.admin.createUser({
    id: uid, email, email_confirm: true,
    app_metadata: { dek_host: host_key, dek_sub: claims.sub },   // NEVER pass `role`
  }).catch(() => {});                                              // 422 email_exists is fine

  await admin.rpc('ensure_embed_space', { p_host_key: host_key, p_user: uid });

  const { data: link } = await admin.auth.admin.generateLink({ type:'magiclink', email });
  return json(200, { ticket: link.properties.hashed_token, expires_in: 60 });
});
```
Client: `await sb.auth.verifyOtp({ token_hash: ticket, type: 'magiclink' })`.

Return the hash, never `{access_token, refresh_token}`: a stolen hash is worth one redemption inside its TTL, a stolen refresh token is worth the account.

Three traps encoded above. `POST /auth/v1/admin/users` accepts a caller-supplied `role` and GoTrue does `if params.Role != "" { role = params.Role }` - a host-influenced `role: "service_role"` produces a user whose every future JWT bypasses all RLS, permanently, with no trace in the API keys page. Hard-code it. `generateLink({type:'magiclink'})` on an unknown email silently rewrites the type to `signup` and creates the user with a random 64-char password, so a typo manufactures a ghost account - hence the explicit `createUser` first (supabase/supabase#22521 also reports implicit creation failing intermittently). And for an existing user it overwrites `recovery_token`, invalidating any in-flight password reset - which collides directly with Dek's provisioned-temp-password flow, so the short TTL must live on Dek's own nonce, not on Supabase's project-wide `MAILER_OTP_EXP`.

Give the host secret a rotation window (`secret_hash`, `prev_secret_hash`, `prev_expires_at` = now + 24h) or rotating means a synchronised deploy of Dek and every dashboard.

## Storage partitioning

Chrome has partitioned localStorage, sessionStorage, IndexedDB, CacheStorage, BroadcastChannel, SharedWorker, Web Locks and service worker registrations for all users since Chrome 115, keyed on (top-level site, frame origin). Firefox statically partitions the same set. Safari goes further: third-party localStorage is ephemeral and wiped between Safari launches, plus the ITP 7-day cap.

js/sb.js sets `persistSession: true` with no `storageKey`, so the session lands in `sb-ybddogqphinruyunnuwx-auth-token` in a per-host-dashboard bucket. Consequences to design for, not fight:
- The user signed into standalone Dek is signed OUT inside the dashboard. This is why credential passthrough is structural, not a convenience.
- Two customer domains are two independent sessions, two themes, two outboxes.
- The Storage Access API does NOT fix it - Safari's grant is cookies-only by explicit WebKit statement, Firefox cannot unpartition non-cookie storage at all, and only Chrome's `requestStorageAccess(types)` returns a `StorageAccessHandle` with `.localStorage` (Chrome 125+, MDN flags it not Baseline, and it is click-gated and 30-day expiring). Progressive enhancement at most; never the mechanism.

**Primary install: `dek.<customer-domain>` CNAME to the same static origin.** Same-site framing is not partitioned at all. One DNS record plus a cert removes the entire class. Document cross-site as supported with caveats.

Three code changes regardless:
1. Give the embed its own `storageKey`: `sb-dek-embed-<hash of host_key>`. Refresh tokens rotate with a 10-second reuse interval, after which the whole session family is revoked; two supabase-js instances on one key (standalone tab plus embed) will race and log the person out of both, and js/sb.js's single-flight guard cannot see across realms.
2. Set `detectSessionInUrl: !embedActive`. The host controls the iframe URL including its fragment, so `#access_token=...` is an undocumented second credential channel that bypasses the postMessage origin check entirely.
3. Add a storage probe at boot (`try { localStorage.setItem('__dek_probe','1') ... }`); on failure recreate the client with `persistSession:false` and emit `error` so the host renders "chat unavailable in this browser" rather than a spinner. Also wrap the unguarded reads at js/core/channels.js:122 and :174-175 - they sit inside `renderChannels()`, which `switchWorkspace` awaits, so a SecurityError there means no channel list and no recovery. Same for the two module-level reads that run at import time (js/features/activityReport.js:22, js/features/tasks.js:265-266), which throw inside `registerFeatures`' catch and silently delete those features.

Always re-handoff on every embed boot. Treat a surviving session as a bonus.

## Tenant auto-provisioning

Key on an immutable natural key, never on the Space name. Two dashboards will both call their team "Tech".

```sql
alter table public.workspaces add column if not exists provision_key text;
create unique index if not exists workspaces_provision_key_uk
  on public.workspaces (org_id, provision_key) where provision_key is not null;

create table if not exists public.embed_hosts (
  id               uuid primary key default gen_random_uuid(),
  host_key         text not null unique,          -- 'acme-tech'
  org_id           uuid not null references public.organizations(id) on delete cascade,
  label            text not null,
  allowed_origins  text[] not null default '{}',  -- exact scheme://host[:port], no wildcards
  auth_mode        text not null default 'oidc' check (auth_mode in ('oidc','ticket')),
  oidc_provider    text,                          -- 'custom:acme-tech'
  secret_hash      text, prev_secret_hash text, prev_expires_at timestamptz,
  space_slug       text not null,
  space_name       text not null,
  seed_channels    jsonb not null default '["general"]'::jsonb,
  member_role      text not null default 'member',
  created_by       uuid not null,
  disabled_at      timestamptz,
  created_at       timestamptz not null default now()
);
revoke all on public.embed_hosts from anon, authenticated;   -- service role only

create table if not exists public.embed_nonces (
  jti text primary key, host_key text not null, used_at timestamptz not null default now()
);
```

```sql
create or replace function public.ensure_embed_space(p_host_key text, p_user uuid)
returns table (space_id uuid, channel_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare h public.embed_hosts; ws uuid; ch uuid; pk text;
begin
  select * into h from public.embed_hosts
    where host_key = p_host_key and disabled_at is null;
  if not found then raise exception 'unknown_embed_host'; end if;

  pk := 'embed:' || p_host_key;
  perform pg_advisory_xact_lock(hashtextextended(pk, 0));

  -- DO UPDATE, never DO NOTHING: Postgres returns NO ROW on the conflict path,
  -- so 49 of 50 people opening the dashboard at 09:00 would get a null space id.
  insert into public.workspaces (org_id, name, provision_key, created_by)
  values (h.org_id, h.space_name, pk, h.created_by)
  on conflict (org_id, provision_key) where provision_key is not null
  do update set name = public.workspaces.name
  returning id into ws;

  insert into public.channels (workspace_id, name, kind)
  values (ws, h.seed_channels->>0, 'text')
  on conflict (workspace_id, name) do update set name = public.channels.name
  returning id into ch;

  insert into public.workspace_members (workspace_id, user_id, role, source)
  values (ws, p_user, h.member_role, pk)
  on conflict (workspace_id, user_id)
  do update set source = coalesce(public.workspace_members.source, pk);

  update public.workspaces set default_channel_id = ch where id = ws and default_channel_id is null;
  return query select ws, ch;
end $$;
```

Call it service-role from the ticket/registration path BEFORE the client's first `loadSpaces()`, so there is no window in which a person is authenticated but belongs to nothing - which today lands them in `showNoTeam()` asking for an invite code an embedded user can never have.

`workspace_members.source = 'embed:<key>'` is what makes deprovisioning safe later: a nightly reconcile may only revoke what it provisioned, never a manual invite. That is GitHub's rule ("removes users who became members via team membership if they do not have membership by any other means") and it matters because Supabase has no SCIM, so "Bob left" never reaches Dek on its own.

Ownership: assign the auto-created Space to the Organisation at creation (`created_by` = the registering admin), never to whoever opened the dashboard first. Both Microsoft and Notion had to build expensive recovery machinery for the other choice - DNS TXT admin takeover in two flavours, and a 14-day claim window in which only single-member workspaces can be transferred. Get it right at creation and the flow never needs to exist.

Client side: read `?embed=1&host=<origin>&space=<host_key>`, set `document.documentElement.dataset.embed='1'` before first paint, and prefer the pinned Space at the head of the `active` selection chain in js/main.js:204-216 - which is already done. Hide the rail via `html.embed-minimal #spaceRail{display:none}` (already in css/embed.css) and keep switching reachable through `orgDirectory()` (js/core/workspace.js:260) bound to the `#spacename-menu` click handler that already exists, plus a switcher source. Do not empty `#spaceRail` in JS: `loadSpaces()` calls `renderSpaceRail()` unconditionally at workspace.js:252 and would undo it.

Also guard the escape hatches that CSS cannot reach: `spaceMenu` (workspace.js:210) still offers Leave and Invite, `switchWorkspace` has no pin guard, and js/shell.js:80 builds Sign out in JS. Add `if (embed.active && embed.space) return;` to spaceMenu/spaceChooser and gate the Sign out entry on `!embed.active` - a dock signs out through the dashboard.

**Do not register privileged features in embed mode.** js/features/index.js loads admin, orgadmin and integrations unconditionally, and css/embed.css only hides four elements, so `#/admin` is reachable directly inside a third-party frame. js/features/people.js:387-395 paints a colleague's plaintext temporary password into the DOM and js/features/integrations.js:89-98 paints freshly minted webhook and bot tokens. Pass `embed.active` into `registerFeatures` and skip those three; make `orgadmin.openFromHash` refuse when embedded.

## Framing and CSP

Non-negotiable and it is a hosting decision. Serve from Cloudflare Pages / Netlify / Vercel / a Worker in front of Pages, with a `_headers` file at repo root (no build step needed - it ships as-is):

```
/*
  Content-Security-Policy: frame-ancestors 'self' https://dash.acme.com https://*.acme.com;
  Cross-Origin-Resource-Policy: cross-origin
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: storage-access=*
```

Generate `_headers` from `EMBED_ORIGINS` with a ~15-line node script so the two lists cannot drift. `frame-ancestors` is ignored in a `<meta>` CSP, so there is no static-HTML workaround.

Until the header exists, add a client-side refusal as a partial mitigation: in `initEmbed()`, when `window.parent !== window` but `embed=1` is absent, refuse the same way a disallowed host is refused. It does not stop a hostile framer who passes `?embed=1&host=<an allowlisted origin>`, but it closes the case where an existing session paints the full authenticated UI in an arbitrary frame.

Also gate the localhost entries in `EMBED_ORIGINS` and the http exemption in `originAllowed()` on `location.hostname` being localhost. Shipped as-is, any page a user's own machine serves on port 8098 can drive the panel.

If a host is cross-origin isolated (`COEP: require-corp` - any dashboard using SharedArrayBuffer for WASM, video or spreadsheets) the frame will not load unless Dek also sends COEP. `<iframe credentialless>` is the Chrome-only escape hatch and it loads in a fresh ephemeral partition cleared on every top-level unload, which the token-per-boot design survives and a persisted-session design would not.

---

## Task system

## Starting position, honestly

js/features/tasks.js is 656 lines and already implements more real coordination machinery than Microsoft Planner or Slack Lists: eight states (`proposed, accepted, in_progress, blocked, in_review, done, rejected, cancelled`), request/accept/decline with a reason, first-class "I am stuck" with a written blocker note, send-for-review with a reviewer, due dates, message chips, seven tabs, two badges, realtime. js/lib/asks.js + js/features/quicktask.js already deliver the owner's "@xyz please get this done" requirement, deterministically, with a confirm strip and an editable amend dialog.

The file header at js/features/tasks.js:8 still says "Two states, open and done. No projects, no boards, no dependencies, no subtasks." That is stale by an entire state machine and will send the next reader in the wrong direction. Fix the comment first.

Three real gaps in what exists: `in_progress` is a defined state that NO client action can reach (`set_task_state` is only ever called with `blocked`, `unblocked`, `in_review`), so every unfinished task looks identical; `note` is a single overloaded column serving both the changes-requested note and the decline reason; and tasks.js:5-6 claims tasks land in the assignee's Later queue while nothing in the client calls `later_add`.

## Data model

Freeze the vocabulary at Linear's set and refuse everything past it. Jira's slowness comes from a project not owning a workflow but a *scheme*, with at least six indirection layers between a project and a field appearing on a form; Atlassian is now shipping hard caps (700 fields per space, 150 work types) which is an admission the model is unbounded by construction. One Space owns its states and fields directly, edited in place, no mapping table. Ever.

### Columns on `tasks` (backend)

```sql
alter table public.tasks
  add column if not exists started_at     timestamptz,
  add column if not exists eta_at         timestamptz,
  add column if not exists priority       smallint not null default 0 check (priority between 0 and 4),
  add column if not exists parent_task_id uuid references public.tasks(id) on delete set null,
  add column if not exists due_precision  text not null default 'minute' check (due_precision in ('day','minute')),
  add column if not exists due_string     text,
  add column if not exists due_tz         text,
  add column if not exists origin         text not null default 'manual'
      check (origin in ('manual','parsed','proposed','slash','import','external')),
  add column if not exists order_hint     text,
  add column if not exists external_ref   jsonb,
  add column if not exists review_note    text,
  add column if not exists decline_reason text,
  add column if not exists triage_snooze_until timestamptz,
  add column if not exists sync_seq       bigint;

create index if not exists tasks_ws_open_idx   on public.tasks (workspace_id, state) where done_at is null;
create index if not exists tasks_assignee_idx  on public.tasks (assignee_id)          where done_at is null;
create index if not exists tasks_parent_idx    on public.tasks (parent_task_id);
create index if not exists tasks_seq_idx       on public.tasks (workspace_id, sync_seq);
```

Why each earns its place:
- `started_at`: without it, created_at -> done_at is LEAD time, not cycle time, and includes however long the task sat in a queue while somebody was on holiday. The Kanban Guide defines both from when work *started*. Stamp it on the first transition to `in_progress`, and on a force-complete of a task that was never started. This is the single highest-value backend column for the forecast.
- `due_precision`: js/lib/asks.js already computes `dueHadTime` and throws it away. chrono-style parsers default a bare weekday to 12:00 noon; rendering "due Friday 12:00" when somebody wrote "by Friday" is a fabricated lunchtime deadline and is the exact moment people stop trusting every parsed field, including the right ones.
- `due_string`: store the raw phrase. It is how recurrence and "end of month" survive a round trip, and it is what lets you answer "why does this say 3:30am".
- `origin`: the only way to ever answer "is the parser helping". Compare edit-before-send rate and delete-within-an-hour rate for `parsed` versus `manual`. Without it the LLM layer question is unanswerable.
- `order_hint` and an `updated_at` etag: both come straight from `plannerTask` (orderHint/assigneePriority, If-Match against @odata.etag), the most heavily used non-technical task model in existence. Reordering without renumbering and last-write-detection are very expensive to add once boards and offline edits exist.
- `priority`: five values, one glyph in the card top row so it costs no vertical space in a 380px panel.

### Status category

The single most portable idea in Jira, and it costs one function. Boards, filters and burndowns key off `statusCategory` and never off the status name, which is why a team can rename "In Progress" to "On the ward" without breaking a report.

```sql
create or replace function public.task_category(p_state text) returns text
language sql immutable as $$
  select case p_state
    when 'proposed' then 'triage'  when 'accepted'  then 'todo'
    when 'in_progress' then 'doing' when 'blocked'  then 'doing'
    when 'in_review' then 'doing'   when 'done'     then 'closed'
    when 'rejected'  then 'closed'  when 'cancelled' then 'closed'
    else 'todo' end
$$;
```
Return `category` on every `list_tasks` row and turn `STATE_LABEL` (tasks.js:253) into `STATE_META = {label, category, tone}`. Every future view, rollup, badge and board grouping then switches on 5 cases instead of 8, and a Space can rename a state later without a client release.

Never add a second done-flag. Jira's `Resolution` field is orthogonal to status - Done-with-empty-resolution is "Unresolved" to every JQL filter forever, In-Progress-with-a-resolution renders struck through - and Atlassian's own fix is a post-function on every terminal transition, i.e. permanent config maintenance. Dek got this right by accident with `done_at` plus `cancelled`/`rejected`. Keep exactly one completion axis. Also introduce one helper and use it at all six sites that currently key off `done_at` alone (tasks.js:41, 160, 169, 294-295, 320, 434): `const isDone = (t) => !!t.done_at || t.state === 'done' || t.state === 'cancelled';`

### `task_events` - append-only, replaces the mutable blocker note

```sql
create table if not exists public.task_events (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks(id) on delete cascade,
  workspace_id  uuid not null,
  actor_id      uuid not null,
  kind          text not null check (kind in
                  ('progress','eta','blocked','unblocked','state','handoff','note','nudge','forecast')),
  from_state    text, to_state text,
  eta_at        timestamptz,
  note          text,
  blocked_on_task     uuid references public.tasks(id) on delete set null,
  blocked_on_user     uuid,
  blocked_on_external text,
  source        text not null default 'ui' check (source in ('ui','parse','nudge_reply','bot','external')),
  created_at    timestamptz not null default now()
);
create index on public.task_events (task_id, created_at desc);
create index on public.task_events (workspace_id, created_at desc);
```
RPCs: `post_task_progress(p_task, p_kind, p_eta_at, p_note, p_blocked_on_task, p_blocked_on_user, p_blocked_on_external)` and `list_task_events(p_task)`. Keep `blocker_note` and `blocked_at` as denormalised latest-values on the task so the list render stays cheap; write history to the log.

Asana's status updates are create-and-delete-only by deliberate API design, for exactly this reason. A single mutable note cannot answer "how long has this been stuck", "how many times has the ETA moved", or "who last touched this" - and all three are inputs to the roll-up, the escalation clock and the forecast.

### `task_links` - one row per edge, and auto-downgrade

```sql
create table if not exists public.task_links (
  from_task  uuid not null references public.tasks(id) on delete cascade,
  to_task    uuid not null references public.tasks(id) on delete cascade,
  kind       text not null check (kind in ('blocks','relates','duplicates')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  primary key (from_task, to_task, kind),
  check (from_task <> to_task)
);
create index on public.task_links (to_task) where cleared_at is null;
```
Store ONE row, always in the `blocks` direction, and derive "is blocked by" in the client. Atlassian's own model doc states that link direction semantics are "only interpretable at the user interface level and not at the API level" - two-row storage buys nothing and guarantees desync.

When `set_task_done` fires on a blocker, flip its outgoing `blocks` rows to `relates`, stamp `cleared_at`, and broadcast `task_unblocked` to everyone downstream. That auto-downgrade is Linear's behaviour and it is the mechanism that stops blocker flags rotting into permanent red decoration nobody clears.

Two non-task targets on the task row itself matter more than task-to-task for this product's actual users: `blocked_on_user` (waiting on a colleague who has no task) and `blocked_on_external` (waiting on the district office, with an optional expected date - which is literally the placeholder text already at tasks.js:419). Most real blockers are a person or an outside body, not another ticket.

**Never gate `set_task_done` on an uncleared blocker.** No shipped tracker does. The existing force-override confirm at tasks.js:438 is exactly the right shape. Hard gates teach people to mark blockers resolved just to get past them, which turns the one signal that told you where work is stuck into noise.

### Chain query, with cycle protection

```sql
create or replace function public.blocker_chains(p_workspace uuid)
returns table (blocker uuid, downstream_count int, chain_depth int, worst_due timestamptz)
language sql stable as $$
  with recursive edges as (
    select l.from_task, l.to_task from public.task_links l
      join public.tasks t on t.id = l.from_task
     where l.kind = 'blocks' and l.cleared_at is null and t.workspace_id = p_workspace
  ),
  walk as (
    select from_task as root, to_task as node, 1 as depth from edges
    union all
    select w.root, e.to_task, w.depth + 1 from walk w join edges e on e.from_task = w.node
     where w.depth < 8
  ) cycle node set is_cycle using path
  select w.root, count(distinct w.node)::int, max(w.depth)::int, min(t.due_at)
    from walk w join public.tasks t on t.id = w.node
   where not w.is_cycle group by w.root
$$;
```
The `CYCLE` clause is not optional - the link graph is user-editable and will contain loops within weeks. Postgres 14+, so it is available on Supabase.

Report two integers per blocker and nothing else: `downstream_count` ("3 people are waiting on this") and `chain_depth`. Do not build a Gantt. Dek tasks have a due date and no duration, so true critical-path float is not computable and any bar chart would be a lie about precision you do not have. Smartsheet-style date-shifting predecessors are worse than useless here: one person nudging a date cascades new dates onto a dozen people who never agreed to them.

Promote any blocker with `downstream_count >= 3` or `chain_depth >= 3` straight to the escalation tier at its first nudge boundary, skipping the personal steps.

## Natural-language intake

Already built. `js/lib/asks.js` is genuinely good: longest-name-first mention matching so "@Priya Raghavan" is not matched as "@Priya", a legible additive confidence score with a threshold of 4 ("two independent signals agreed" - 3 fired on ordinary conversation), a `why` array so the suggestion explains itself, `UNOWNED` detection routing "can someone..." to an ownerless queue rather than to whoever read it, `SELF_TEST` for "I'll do it", and title cleanup that strips the trailing preposition left behind when a date phrase is cut from the middle of a sentence.

It is right to be deterministic. A regex table recovers most of what an LLM would be called in for, at zero latency and zero cost, and it is auditable: when it is wrong you can read the rule that did it. Six changes, all small:

1. **Plumb precision through.** `parseAsk` already returns `dueHadTime`; send it as `p_due_precision: ask.dueHadTime ? 'minute' : 'day'`, add `p_due_string: ask.dueText`, `p_due_tz: Intl.DateTimeFormat().resolvedOptions().timeZone`, and `p_origin: 'parsed'`. Then teach `dueLabel()` to print "due Friday" for day precision and "due Fri 17:00" only for minute precision.
2. **Recurrence guard.** Test `/\b(every|each|daily|weekly|monthly|fortnightly|bi-?weekly)\b/i` BEFORE computing a due date. Silently turning "post the numbers every other Tuesday" into one task due next Tuesday is the worst failure available: the person marks it done and the commitment evaporates. Until recurrence ships, the strip must say "Dek cannot repeat tasks yet - this will be a one-off for Tue 11 Aug". When it does ship, store an RFC 5545 RRULE and confirm by rendering the rule BACK to English, because a wrong rule reads obviously wrong in English and an RRULE is what Jira, Google Calendar and Outlook already speak.
3. **Calendar arithmetic must be computed, never rewritten into English.** "by month end" rewritten to "last day of this month" resolves to a date in the past. Month ends, quarter ends and business-day offsets get computed in JS and substituted as an absolute date.
4. **Business-hours meridiem bias.** A bare hour 1-7 with no am/pm in a work channel means PM. Voice dictation is the intake path the owner actually uses and it is exactly where a bare-number parse fails by five hours with no signal.
5. **Individually removable chips.** Today the strip is accept/amend/dismiss. Make each recognised element (assignee, due, recurrence) its own pill with an x, mirroring Todoist's click-to-unhighlight. Todoist's own documentation picks "Create monthly report" as its example, meaning the market leader expects false positives on ordinary English and designs the rejection path first. If rejecting costs more than one tap, people do not reject, they disable the feature - so also add a per-user off switch.
6. **`p_due_string` re-parsed server-side** so web, embed and bot all agree.

**Do not run intent classification over channel traffic.** Microsoft built exactly this - Viva Insights extracted Commitments, Requests and Follow-ups from email and chat - and retired it in MC713042 rolling out from late February 2024, keeping only the mechanical suggestions. Even at its peak it was confirm-first: three buttons (Done / Remind me / Delete) and no task entered To Do without an affirmative press. The trigger must stay author-initiated: the live composer parse, `/task`, and the existing "Make this a task" action. If a passive signal is wanted later, copy Gmail Nudges: resurface the original message to the author only, create nothing. A wrong nudge costs one glance; a wrong task costs a wrong deadline in a colleague's queue.

### Optional LLM layer, if it ever ships

Edge Function `propose_task`, called ONLY when the deterministic parse is ambiguous (span truncated, two or more mentions, a recurrence keyword present, or a phrase the parser returned nothing for). Anthropic tool use with `strict: true`, `additionalProperties: false`, `tool_choice: {type:'tool', name:'propose_task', disable_parallel_tool_use:true}`. Schema where `title` is required but `due_at`, `assignee_hint` and `recurrence` are each OPTIONAL and paired with a required-if-present `*_evidence` string. Server-side, reject the extraction unless every evidence string is a verbatim substring of the message; on rejection drop that field and do not retry.

Anthropic's docs state plainly that the model "might guess values you didn't supply" for underspecified required parameters. Strict mode buys valid JSON, not true JSON. Optional fields plus a mandatory verbatim-substring check is what converts a hallucinated deadline from an invisible error into a caught one. The function returns a proposal to the client; only the client's confirmed chip calls `create_task`. It never writes `assignee_id` directly - that is Zendesk's shipped architecture (the classifier writes intent/language/five-point sentiment into fields, a separate deterministic routing layer consumes them) and it is the difference between a wrong assignment that is explainable and reversible and one that is an unattributable state change. In Dek specifically, a model-chosen assignee who cannot see the channel gets rejected by `create_task` with `assignee_cannot_see_channel` and the user gets an error they had no part in causing.

## ETA and forecasting

The owner asked for ETAs "calculated automatically". The honest answer: a per-task point ETA cannot be made accurate by anyone at any budget. Durations are lognormal with a fat right tail (Little's Landmark Graphics study, 120 commercial releases: median actual/estimate 1.75, mean 2.0, p90/p10 spread 3.25-4x, and the uncertainty band does NOT narrow as work proceeds). The strongest published text-based estimator beat a median-of-past-items baseline in 8 of 42 within-project settings. The planning fallacy survives asking for a worst case (Buehler 1994: predicted 33.9 days, actual 55.5, and even "if everything went as poorly as possible" said 48.6).

What CAN be computed automatically and correctly, with no model, is the **conditional remaining time**. Measured on a lognormal population (p50 3.3d, p85 8.2d): conditional on still being open at age A, remaining p50 barely moves (2.6d at age 1, 3.0d at age 5, 3.5d at age 8, 4.5d at age 13) while the implied total explodes (p85 total 8.7d -> 14.5d -> 19.2d -> 27.3d). That is the fact everyone feels and nobody can see, it updates on every render, and it is right by construction rather than a claim that can be falsified.

### `js/features/forecast.js` - pure, DOM-free, no imports, ~200 lines

```js
export const WINDOW_DAYS = 56;   // 8 weeks. MUST be a multiple of 7.
export const MIN_SAMPLES = 12;

// Nearest-rank. Never average: a lognormal mean sits well above the median
// and describes almost no task.
export function pct(sortedAsc, p) {
  const n = sortedAsc.length; if (!n) return null;
  const rank = Math.ceil((p / 100) * n);
  return sortedAsc[Math.min(n - 1, Math.max(0, rank - 1))];
}

export function cycleDays(rows) {
  return rows
    .filter((t) => t.done_at && t.state === 'done')
    .map((t) => (new Date(t.done_at) - new Date(t.started_at || t.created_at)) / 86400000)
    .filter((d) => d >= 0 && Number.isFinite(d))
    .sort((a, b) => a - b);
}

// Cascade with a hard minimum. Measured: per-assignee classes are WORSE than
// the pooled class below ~10 finished items each, even when people genuinely
// differ 2x, and strictly worse when they do not.
export function refClass(done, probe, min = MIN_SAMPLES) {
  const tiers = [
    ['this person in this channel', (t) => t.assignee_id === probe.assignee_id && t.channel_id === probe.channel_id],
    ['this person',                 (t) => t.assignee_id === probe.assignee_id],
    ['this channel',                (t) => t.channel_id  === probe.channel_id],
    ['this Space',                  () => true],
  ];
  for (const [basis, f] of tiers) {
    const rows = done.filter(f).slice(-50);          // never more than 50: drift makes old data harmful
    if (rows.length >= min) return { basis, n: rows.length, days: cycleDays(rows) };
  }
  const all = done.slice(-50);
  return { basis: 'thin', n: all.length, days: cycleDays(all) };
}

// THE HEADLINE NUMBER.
export function conditionalRemaining(sortedDays, ageDays) {
  const left = sortedDays.filter((d) => d > ageDays).map((d) => d - ageDays);
  if (left.length < 3) return null;
  return { p50: pct(left, 50), p85: pct(left, 85), n: left.length };
}

// Amber at p70: 30% of work flagged, 50% precision, 3 days of notice.
// p50 floods you (50% of all work, 30% precision). p85 has perfect precision
// and zero warning, because age is a lower bound on cycle time.
export function ageBand(ageDays, sortedDays) {
  if (sortedDays.length < MIN_SAMPLES) return 'unknown';
  if (ageDays >= pct(sortedDays, 95)) return 'stale';
  if (ageDays >= pct(sortedDays, 85)) return 'red';
  if (ageDays >= pct(sortedDays, 70)) return 'amber';
  return 'ok';
}

export function dailyThroughput(doneAtList, days = WINDOW_DAYS) {
  const now = Date.now(); const b = new Array(days).fill(0);
  for (const d of doneAtList) {
    const age = Math.floor((now - new Date(d)) / 86400000);
    if (age >= 0 && age < days) b[age]++;
  }
  return b;
}

// "When will these N be done?" Measured at 1.4ms for 5000 trials in plain JS.
// 500 trials already pins p85 to within 1 day across 20 repeat runs, so raising
// the count buys nothing - all the error lives in the window and the sample size.
export function mcWhen(hist, n, trials = 2000) {
  if (!hist.length || n <= 0) return null;
  const out = new Array(trials);
  for (let t = 0; t < trials; t++) {
    let left = n, d = 0;
    while (left > 0 && d < 2000) { left -= hist[(Math.random() * hist.length) | 0]; d++; }
    out[t] = d;
  }
  out.sort((a, b) => a - b);
  return { p50: pct(out, 50), p85: pct(out, 85) };
}

// Two dates, always. Numerals, never words.
export function phrase({ p50Date, p85Date, n, basis }) {
  return `Most likely ${p50Date}. 85 times out of 100 it is done by ${p85Date}. `
       + `Based on the last ${n} finished by ${basis}.`;
}
```

### Three rules that matter more than the modelling

1. **The window must be a whole number of weeks.** Measured with deterministic throughput (2/day weekdays, 0 weekends, forecast 20 items, true p85 = 16 days): a 5-day window gave 20 (+25%), 10-day 20 (+25%), 17-day 18 (+13%), **30-day 18 (+13%)**, 60-day 17 (+6%). Every multiple of 7 (7, 14, 21, 28, 35, 63) returned exactly 16, zero error. The mechanism is simply that a non-multiple-of-7 window over- or under-samples the zero-throughput days. Every round number a human would pick (10, 30, 90) is wrong. Hard-code 56 with a comment giving this reason, because no test would ever catch it.
2. **Below 12 finished items, refuse to quote a percentile.** Rolling backtest against an 85% target: N=10 covered 81.8%, N=20 81.0%, N=30 83.8%, N=50 84.3%, N=100 84.1%. Under drift (0.3% slower per item) the LONG window degrades most: N=100 fell to 79.8% while N=30 held 82.5%. So: 30-50 items is the sweet spot, never more than ~50. Below 12, quote the observed slowest instead - with n samples the sample max sits near the n/(n+1) percentile, so "the slowest of the last 8 took 9 days" is both honest and coincidentally about a p89.
3. **Always print the basis.** "Based on the last 34 jobs finished by Priya in #tech" is what makes a non-technical person believe the number, and "based on 3 jobs" is what stops them believing it when they should not.

### Rendering

Replace the single `dueLabel` span in `taskCard()` with a forecast line and a band chip. Lead with the OBSERVATION, not the prediction, because aging is a fact and a date is a claim:

> Usually finished by now. About 3 more days at even odds, 9 more to be safe.
> Based on the last 34 jobs finished in #tech.

Ban the words percentile, throughput, Monte Carlo, cycle time, SLA and confidence interval from every user-visible string; keep them in code comments. And never use "likely" or "probably" as the confidence word: Sherman Kent's 1951 case had "serious possibility" read as both 20% and 80% inside the same building, and a 1977 study of 23 NATO officers found "probable" read anywhere from 30% to 75% even by people familiar with the scale. Use a frequency: "85 times out of 100".

Ship a calibration self-check nobody else ships: store each forecast when first shown (`task_forecasts(task_id, made_at, p50_at, p85_at)`), score it on `done_at`, and print one line at the bottom of the panel - "Our 'nearly always' line has been right 81 times out of 100 here." Backtests say a well-built p85 lands at 81-84%, so the number will be respectable but not perfect, which is exactly the right message. This is what converts scepticism into trust, and it is self-protecting: if the forecast is bad the product says so before a user discovers it.

### Zombie policy

Little's Law's second assumption is that every started item eventually leaves the system. A task created from a message, never started and never cancelled, sits open forever, inflates WIP, drags the aging distribution and produces a monstrous outlier the day somebody finally closes it. In a chat-native tool where any message can become a task this is the default outcome, not an edge case. Any open task past the class p95 gets ONE automated question to the assignee ("Is this still happening?" / Yes / Cancel it) and, if cancelled, is excluded from the reference class.

## Blockers, progress, nudges, roll-ups

### Progress is the thread. Build no comment system.

Tasks already carry `message_id`. Promote that to a structured reference `{message_id, channel_id, thread_root}` - Slack Lists stores exactly this shape (`{value, channel_id, ts, thread_ts}`) and capturing `thread_ts` is the difference between "Go to message" landing on the right reply and dumping the user at the top of a busy channel. Change the card's Go-to-message button to open the THREAD (js/core/threads.js), and render the last reply plus its author inline on the card as the live progress line.

Post exactly four transitions into that thread via `post_as_bot`: assigned, became stuck (with the target named), became unstuck, completed. Everything else edits the chip in place. One new channel message per progress update is the fastest possible route to a muted channel - Slack's `chat.update`, Geekbot's threaded reports and the GitHub sticky-comment convention all exist to avoid it. When you do update the card in place, key off a stable marker in the payload rather than authorship (`data-task="<uuid>"`), which is the pattern that already works in this codebase via `slotMessageId()`.

This is the whole answer to "many people posting progress, ETAs, blockers". The progress stream is the thread, not a new object. Linear spends real engineering syncing Slack threads bidirectionally to fake it; Height's customers named chat-per-task as the thing they loved. Dek has it natively.

### ETA is a separate field from due date

`due_at` is the ask. `eta_at` is the promise. Add an "ETA slipped" action next to "I am stuck" that records the delta and posts one line into the thread, and sort the Stuck tab by `(eta_at - due_at)` descending so the worst divergence is on top. A person changing `due_at` to cover a slip destroys the record of the original commitment; two fields keep both facts.

### Nudge ladder - bounded, with a hard stop

The evidence here is unusually hard: across 112 clinicians and 1,266,325 alerts, each 5 percentage point increase in the proportion of REPEATED alerts dropped acceptance with an adjusted IRR of 0.90 (95% CI 0.86-0.95, p<.001), and roughly a quarter of reminders were within-patient repeats. Repeats have negative marginal value AND degrade response to unrelated alerts. The correct answer to silence is a change of SURFACE, not of volume.

```
step 1  one working day BEFORE due          personal DM
step 2  due + 4 working hours               personal DM
step 3  due + 1 working day                 personal DM, and it says who is told next
--- direct nudging stops permanently for this task ---
step 4  the task joins the channel's daily "Waiting on" digest card
step 5  due + 2 working days                notify t.assigned_by
step 6  due + 3 working days                notify MANAGE_WORKSPACE holders
--- then it goes quiet and stays owned ---
```
Table `task_nudges(task_id, user_id, step, last_nudged_at, snoozed_until, escalated_at, muted)`, driven by a pg_cron Edge Function reusing the existing `reminders` firing path.

Every threshold is in WORKING hours, clamped through the quiet-hours predicate Dek already has (js/features/notifications.js: `prefs.quiet_start`/`quiet_end` with midnight-wrap handling in `inQuietHours()`, plus `dnd_until`). A blocker raised at 17:00 Friday must not reach a manager at 17:30 Friday. A step suppressed by quiet hours fires ONCE at window open; it does not queue up and arrive as a burst.

PagerDuty is the reference for the shape: 30-minute default per step, up to 20 steps, repeat at most 9 times, then it stops notifying and parks ownership on the last responder. The load-bearing detail is the terminal state. A loop that never ends is the thing people mute, and a muted channel takes the genuine emergencies with it.

**Snooze must produce a commitment, not a delay.** Replace any bare "remind me later" with three buttons: Done / New date / I am stuck. Picking a new date writes a `kind='eta'` task_event, updates `due_at`, and resets the ladder to step 1 relative to the NEW date while recording that this is a second cycle - so the roll-up can count how many times a date has moved. Opsgenie splits `if-not-acked` from `if-not-closed` for exactly this reason: acknowledging is not progressing. A dismiss-only nudge teaches people that ignoring the system works and yields no data.

Also: `nudge_task(p_task)` modelled directly on the existing `chase_acks` (js/features/ackloop.js:106) - server-side rate limited, returns a count, pings only the assignee, surfaced for `created_by === me || assigned_by === me`, with the `rate_limited` humanisation tasks.js:34 already has. Until it exists, DELETE the false promise in the create dialog hint at tasks.js:128 ("They get one reminder when it falls due") - no client code implements it.

### The "Waiting on" digest is already built

js/features/ackloop.js has the entire mechanism and it is the hardest half: `ack_status` returning `{audience, acked_count, pending[]}`, a card that lists pending people BY NAME rather than as a count (its comment explains why: the point is that you can ring them), a `chase_acks` RPC that pings only non-responders and is server-side rate limited, and an admin report split into "Still waiting" / "Everyone confirmed". Generalise it: `task_digest(p_workspace, p_date)` over the same shape - who owes an update, what is stuck and for how long, what went red today. Post it once per day via `post_as_bot` and EDIT that same message all day rather than reposting.

This is Geekbot's Engagement Summary, described in their own docs as "a gentle way to remind teammates that haven't reported", and it is the escalation tier that costs one RPC because the hard part exists.

### Scheduled check-ins beat inference

Basecamp gets automatic status from a clock and two questions: every workday at 16:30 "What did you work on today?", every Monday "What will you be working on this week?", with all answers published to one page grouped by date, explicitly to delete status meetings. Zapier's own writeup of running async standups names three failure modes and TWO of them are answer-quality failures (vague responses, performative detail) - which is an argument against free-text questions as the primary data path.

So: generate each person's weekly recap FROM their own `task_events` (what they finished, what moved date and how many times, what they are stuck on and for how long), deliver it as one card in the Later/Now panel with a single "Send to #channel" button, and leave exactly one optional free-text box labelled "Anything the numbers do not show?". Pre-filling turns writing into editing, which is what makes reply rates hold. This is a cron plus `post_as_bot`, both of which exist.

### Roll-up: compute the colour, take the human's too, show the disagreement

Nobody in this market has solved this and the two credible attempts fail in opposite directions. Linear explored computing project health from issue data, abandoned it ("project progress is not something that can be predicted based on quantitative data alone. It needs qualitative input from the project team"), and now takes a human's word for it. Jira has no native RAG field at all - the official KB tells admins to fake one with an emoji dropdown - yet derives an entire machine-only Summary view (Unassigned, High priority, Overdue, Blocked, plus a Key dependencies widget colouring overdue blockers red and chain-starters yellow). Neither shows the gap between the two, and the gap is exactly where the "watermelon" hides: green outside, red inside, because reporting amber gets you asked hard questions so people report green until it is undeniable.

`space_rollup(p_workspace)` returns `{derived, reasons[], counts{}, override, override_by, override_expires_at}` with PUBLISHED thresholds printed next to the colour:
- RED: an open task overdue by more than 2 working days, OR a blocker stuck more than 3 working days, OR more than 25% of open tasks overdue, OR an overdue task on the longest blocker chain.
- AMBER: any open task overdue, OR anything stuck more than 1 working day, OR more than 20% of open tasks with no due date, OR an assignee has ignored 2 nudges.
- GREEN otherwise.

The human override expires after 7 days, following the rule already written into js/features/status.js: "A status that outlives the thing it describes is the single reason people stop trusting statuses." Render the disagreement in words: "Owner says on track. The numbers say at risk: 2 overdue, 1 stuck for 4 days." A published threshold makes amber a fact rather than an accusation, which is the only way non-technical staff tolerate an automatic colour on their work. Never ship a bare coloured dot - it is unreadable for colour-blind users and meaningless to anyone not taught the convention.

Put the roll-up where the work is discussed - a message in the channel and a chip on the originating message - not on a dashboard somebody has to remember to open. Microsoft retired Viva Goals on 31 December 2025 with no replacement, for lack of adoption. A roll-up that lives anywhere other than the conversation dies.

## Views

**Triage inbox.** Dek is one status rename and four key handlers away from Linear's Triage, which is precisely the owner's "top of the funnel person" made concrete. The `proposed` state with Accept/Decline already exists at tasks.js:363-382. Add: single-key disposition on the panel body - `1` accept-and-assign, `2` mark duplicate, `3` decline with an optional reason, `h` snooze. Snooze must accept BOTH a time AND wake-on-new-activity; a triage item snoozed for a week where the requester replied an hour later is the failure mode that makes snooze unsafe to use aggressively, and it is the half everyone forgets. Store `triage_router_id` per Space, set from js/features/admin.js, and show that person's avatar on the queue header so the funnel has a face. Routing is rules-first with a named accountable human as the backstop - that is the shipped design at the market leader, not AI-first.

Add `{key:'unassigned', label:'Nobody yet', empty:'Everything has an owner.'}` to TABS. `assigneeOptions` already offers "Nobody yet", `p_assignee` already accepts null, and both `paintChip` and `taskCard` already render "nobody yet" - but no tab surfaces them, so an ownerless task is invisible unless somebody reads every row of Everything. js/lib/asks.js's `UNOWNED` detection routes "can someone..." straight here, which is the whole answer to the problem tasks.js's own header comment was written about: an ask that gets three thumbs-up and is done by nobody. One-tap "I'll take it" on every row.

**My work.** `mine` exists. Merge it with Later (see below).

**Saved views instead of fixed tabs.** Turn `TABS` into `PRESETS`, each a `{assignee, state[], category[], channel, due_before, overdue, text}` object, serialise the active filter into the URL hash so a view is linkable into a channel, and persist user-made views under `dek-backend.tasks.views`. Fixed tabs are the ceiling on every product in this category until they add saved filters, and it kills the class of bug tasks.js:265 already guards against (a stale tab key from an older build), because a view becomes data rather than a hardcoded enum.

**Board: a full-page route, never the panel.** Follow js/features/orgadmin.js's precedent (`#/admin` is a page, not a panel) with `#/tasks`. Bucket the SAME `list_tasks` payload by `category` into flex columns; drag calls the existing `set_task_state`. No new RPC, no new table. Board is the single feature non-technical buyers check for, and Slack Lists ships exactly two layouts (table and board) and stops there. But it must never be the panel view: column layouts assume ~1000px and in a 380px dock a board degrades to a horizontally scrolling column of one, which is strictly worse than the card list that already exists.

**Workload.** `task_workload(p_workspace)` returning `[{user_id, open, overdue, blocked, in_review}]`, bucketed by ISO week of `due_at`, default capacity 5 open tasks per person per week. monday's own default is one item = one unit of effort, which means the useful version needs no estimation discipline at all. Make effort optional, and REFUSE to draw the chart when the effort unit and the capacity unit disagree - that is monday's own documented failure mode, where hours-vs-count silently renders meaningless bubbles. "Who is on what" is a grouping, and it is the question a top-of-funnel person actually asks; it is also the one new view Microsoft highlighted when it merged To Do, Planner and Project.

**Slipping.** Extend TABS with `{key:'slipping'}`, computed client-side from the same payload: rank open tasks by `ageDays / p85_of_their_class` descending, show the top 5 with a "show all N" expander. Cap the existing Overdue section at 5 with the same expander, and publish the top-of-list count on `bus.emit('tasks:count')` so the sidebar badge shows the number that matters rather than the total. An unbounded Overdue wall is the alarm-fatigue experiment run on your own users: 72-99% false alarms in the ICU literature produces over 60% non-response and 85% of nurses reporting they are overwhelmed. Ranking preserves all the information and destroys none of the attention.

Also fix the badge itself: `refreshCount()` counts every row from `p_filter:'mine', p_include_done:false`, which by the client's own state list includes `proposed`, `rejected` and `cancelled`. Somebody with three declined tasks sees a permanent badge of 3 with nothing actionable behind it.

## The second-inbox problem - fix it before adding anything

Slack has three personal queues (Activity, Later, Lists "Assigned to you") and its January 2026 Activity rebuild still does not carry list assignments, so assignees must remember to visit a separate page. Microsoft is the only vendor that solved it, and it solved it by making an assignment inside a Loop task list create a REAL Planner task that then appears in To Do's "Assigned to me" - one write, three surfaces, no new queue.

Dek is reproducing Slack's mistake at 1/1000th the scale: core's `saved` panel and js/features/later.js both read `get_later` with separate badges, js/features/tasks.js reads `list_tasks` with a third badge, and tasks.js:5-6 claims tasks land in the Later queue while nothing in the client calls `later_add` (js/features/quicktask.js emits `bus.emit('later:changed')`, which nothing listens to).

Merge at the READ side, which is cheaper than changing the write: have the Later panel also call `list_tasks({p_filter:'mine'})` and render task rows alongside saved messages and reminders, in one time-ordered list with sections Overdue / Today / Waiting on me / Later. Publish ONE badge count. Keep both panel ids as deep-link targets. Then either make `create_task` also write a later row server-side so the comment becomes true, or delete the sentence.

## Jira and external interop

**One-way idempotent remote links. Refuse field mirroring.** Two-way sync between systems that will never agree on status vocabulary, where both sides emit webhooks on write, is a permanent source of loop bugs and duplicate issues.

```
POST /rest/api/3/issue/{issueIdOrKey}/remotelink
{ "globalId": "dek:task:<uuid>",
  "application": { "type": "com.redtree.dek", "name": "Dek" },
  "object": { "url": "https://dek.acme.com/#/t/<uuid>",
              "title": "<task title>",
              "icon": { "url16x16": "...", "title": "Dek" },
              "status": { "resolved": true } } }
```
The contract is an upsert: re-POST with the same `globalId` and it updates rather than duplicating. So Dek can re-POST on every state change with NO mapping table, no conflict resolution and no duplicate risk, and `object.status.resolved` renders the link struck through, which carries the only bit that actually matters. One small Edge Function. Ship this long before anything else Jira-shaped.

Hard constraints to design around:
- **Jira Cloud serves no CORS headers on its REST API by deliberate Atlassian policy** (JRACLOUD-65573: the site host accepts session auth, so allowing cross-origin reads would let any page make authenticated requests). A pure static frontend physically cannot call Jira. Every byte of this is Edge Function work and it can never be a `js/features/*.js` file. Budget it as backend.
- **Do NOT build an Atlassian Connect app.** New Connect apps have been blocked from the Marketplace since 17 September 2025, descriptor updates stop March 2026, full end of support Q4 2026. A plain OAuth 2.0 3LO app is entirely unaffected and is what Dek needs, because Dek's UI lives in Dek.
- **OAuth apps get 5 dynamic webhooks per user per tenant, and they expire 30 days after creation or last refresh.** Register ONE webhook per connected site with a broad `jqlFilter` (`project IN (ENG, OPS)`) and fan out server-side. Per-Space registration hits the ceiling at the fifth Space and fails as "a random subset of projects does not sync". Run a daily `PUT /rest/api/3/webhook/refresh` cron or everything stops on day 31 with no error emitted anywhere - this is the highest-probability silent failure in the whole plan.
- **Return literally HTTP 200.** Jira treats every other status, including 204, as a delivery failure and retries five times with 5-15 minute backoff.
- **Key the mapping on the immutable numeric id, never the issue key.** Jira issue keys change when an issue moves project and the old key becomes a redirect; every row keyed on ENG-123 silently detaches months later and the next sync creates a duplicate.
- **The easiest path needs no OAuth at all.** A Jira admin builds an Automation rule with a "Send web request" action pointing at Dek's ingest, reusing the token-in-body credential model js/features/integrations.js already implements. No app registration, no scopes, no 30-day expiry. State the quota in the setup UI (Free 100 rule runs/month, Standard 1700, Premium 1000 per user, Enterprise unlimited) or a Free-plan customer's tasks silently stop arriving on the 3rd of the month. Every smart value in the custom JSON body needs `.asJsonString` or a quote or newline breaks the payload.
- **Reconcile on a schedule; do not trust webhooks as a complete stream.** `POST /rest/api/3/search/jql` with `updated >= '-75m' ORDER BY updated ASC` against an hourly cron (the 15-minute overlap is deliberate and free once value-equality is in place). The 2025 rebuild removed `startAt` and `total`, rejects unbounded JQL with a 400, and defaults `fields` to id only - so any port of pre-2025 code appears to work and returns issues that are entirely empty except for an id. Label the UI "synced 12m ago", never "live". Coda's sync tables, a far more mature platform, do full-refresh diffing with a resumable continuation at most hourly.

**Loop prevention needs three independent layers**, because each alone has a known hole: (1) drop at ingress when the event's actor equals `external_connections.self_actor_id` - but Jira Automation rules that fire after your write are attributed to the rule owner, not your token; (2) a 120-second suppression set keyed on `(connection, external_id, field, sha256(value))` written just before every outbound write - but Asana delivery can exceed the TTL; (3) never issue a write whose normalised value already equals what the remote holds, which makes an escaped echo a no-op rather than a new event. Layer 3 is also what protects Dek's existing `task_update` Realtime broadcast from repainting every connected client on every reconciliation pass.

**Outbound webhooks** so Dek is pluggable the other way: copy Linear's contract verbatim - payload `{action, type:'Task', actor, createdAt, data, updatedFrom, webhookTimestamp}`, hex HMAC-SHA256 of the raw body in `Dek-Signature`, `Dek-Timestamp`, 60-second replay window, 5-second timeout, at most 3 retries at 1 minute / 1 hour / 6 hours. `updatedFrom` is the field every home-grown webhook omits and every consumer needs, because it turns an update event into a diff without a read.

**Prefill-by-URL** is the cheapest integration surface that exists: `#/task/new?title=&assignee=&due=&space=&channel=` opens the create dialog pre-populated, and `#/tasks?filter=mine` opens the panel. Any host page can create a Dek task with an anchor tag - no API key, no SDK, no CORS, one route handler. Linear ships exactly this.

**Import:** accept the Jira CSV export shape verbatim (Summary required, plus Assignee, Due date, Status, Work item ID, Parent, Work Type; repeated headers for multi-value fields; parents before children). It is what customers already have on disk. Do NOT build a Trello CSV importer - Trello has no native CSV import at all, Atlassian's own docs offer only paste-one-card-per-line, the REST API, or a Power-Up. Import the JSON board export instead.

## Performance, since this is now a panel people leave open all day

`refreshChips()` pulls EVERY task in the workspace including done ones, with no limit, on every `channel:open` AND every `task_update` broadcast, purely to paint chips on the dozen messages on screen. At the "many tasks, many people" scale the owner wants, that is O(tasks x clients) network per event. Add `p_message_ids uuid[]` to `list_tasks` and pass only the ids of `.tsk-slot` elements currently in the DOM; keep the full refetch as a reconnect-only path. Change the server broadcast to carry `{task_id, message_id, ...changed}` and patch the `byMessage` map in place.

And move the broadcast to the WORKSPACE topic. Today `task_update` rides `ch:<channel_id>` via `getSub('chan')`, so a task assigned to you in a channel you are not looking at produces no live update anywhere - not the badge, not the sidebar. js/features/events.js made the opposite and correct choice with `getSub('ws')`. Keep the channel broadcast for chips if you like, but the badge must ride the workspace topic.

Route task writes through the existing durable outbox (js/lib/outbox.js), and keep an in-memory optimistic overlay that the cached list is rendered THROUGH, never written INTO. Linear is explicit: "client-side operations will never directly modify the tables in the local database" - a transaction waits for the server's own delta packet before IndexedDB is touched. That is the structural fix for the exact bug class tasks.js:186-200 already documents, and it makes tasks work on hotel wifi, which an embedded panel needs. Add `list_tasks(p_since bigint)` against a `sync_seq` counter so a client can tell whether its cache is stale without refetching - that single column buys most of the perceived speed for almost no code.

---

## Narrow-panel UX

## The root cause, and the one change that fixes the class

Dek's phone view is not bad. It is not ON. Every layout switch is a VIEWPORT media query - `@media (max-width: 860px)` at css/layout.css:998 is the master gate, with siblings in shell.css:331, messages.css:1292, components.css:319/508, panels.css:1124, features.css:1606, reading.css:133, polish.css:421/579. In a 380px panel on a 1440px screen NONE of them fire, so `main` lays out as three desktop columns (68px rail + 260px sidebar + messages + 400px panel = 728px minimum inside a 400px box) and `body{position:fixed; inset:0; overflow:hidden}` (css/base.css:26-32) CLIPS the excess rather than scrolling it. The conversation and the panel are simply gone.

Meanwhile the ~20 `@media (hover: none)` blocks that supply every touch affordance correctly stay OFF for a mouse. So the embedded panel gets desktop LAYOUT with none of the phone's compensations - and the mouse-driven narrow panel is the WORST case, not the best, because js/features/uxfix.js:987 gates three of five composer format buttons on `!isTouch()`, so it gets the maximum number of tools in the minimum width.

Note the iframe partially rescues this today: a cross-site frame gets its own viewport, so the 860px query DOES fire and the narrow layout applies for free. That is the measured argument in js/embed.js's header and it is why the iframe is the right call. But the same-document case, any future non-iframe tier, and every "why is this 400px sidebar broken" bug all trace back here.

### Do this first, it unblocks everything else

[STATUS 2026-08-25: DONE - css/base.css:100 declares container: dek /
inline-size and #app height 100%; the geometry media queries migrated to
container queries across later bursts (7ed459f, d2102c2). The second
`aside#panel` container was deliberately NOT added; the reasoning is in
DRIVER-STATE.md 2026-08-24.]

```css
/* css/base.css */
#app { container: dek / inline-size; inline-size: 100%; block-size: 100%; }
html, body { height: 100%; }
```
Then mechanically rewrite every `max-width` media query that governs frame or content geometry to `@container dek (max-width: ...)`. Leave EVERY `(hover:...)`, `(pointer:...)`, `(prefers-*)` and `@media print` block exactly where it is: modality is a device fact, size is a box fact, and there is no container query for pointer or hover and there never will be.

Four things make this safe and cheap:
- Size container queries are Baseline widely available since 2023 (Chrome/Edge 105+, Safari 16+, Firefox 110+).
- Container query length units fall back to SMALL VIEWPORT units when no container matches, so the migration is file-by-file and a rule that escapes the container degrades rather than breaking.
- `container-type: inline-size` applies LAYOUT containment, which makes `#app` the containing block for `position: fixed` descendants. That single side effect converts Dek's fixed full-screen sheets, modals, toasts, context menus and the mobile panel sheet from "covers the host dashboard" into "panel-relative". It is the highest-leverage line of CSS in the whole migration.
- Use `inline-size`, never `size`. `size` containment applies in both axes and MDN is explicit that an element with size containment collapses if a contextual size is not available; `#app` is a flex column whose height comes from its children in some embed modes.

Second container: `aside#panel { container: dek-panel / inline-size }`. Remember a container CANNOT query itself, so the panel's own WIDTH stays a `dek` query and only its children use `dek-panel`.

Also drop `#app{height:100dvh}` (css/base.css:89) for `height:100%`. Inside an iframe `dvh` resolves to the frame height while the fixed body is already exactly that, so it is redundant and will silently mis-size if a host ever animates the iframe height.

## Navigation: stacked push-navigation, one 40px header, no bottom bar

[STATUS 2026-08-25: ALL THREE SLICES LANDED - panel sheet + navStack eae2fe9,
480px single header 3a26193, 440px pushed sidebar b07f22c. One deliberate
reversal: the bottom tab bar rejected below SHIPS as js/tabbar.js; treat the
reject paragraph as the argument it lost to, not current policy.]

Below ~480px, collapse `#topbar` + `#channelbar` (+ `#voicebar`) into ONE 40px header whose centre is a single place-switcher button rendering `<space glyph> #channel ▾`. Truncate the space name first, never the channel. `#headerActions` and `#btnInvite` fold into the existing `#btnMore`. `#voicebar` becomes a 28px single-line strip - delete the two-row `flex: 1 0 100%` spacer hack at css/layout.css:1026, which exists to protect a 390px phone from wrapping and is wrong here. That returns 56-60px permanently, about two messages.

Below ~640px, `aside#panel` becomes `position:absolute; inset:0` inside `main` (absolute, not fixed - layout containment now scopes it), its header swaps `#panelTitle` for a back chevron plus title, and `openPanel()` pushes onto a `navStack` array in js/ui.js so the chevron pops.

Below ~440px, do the same to `#sidebar`: a pushed full-width view, NOT the current 272px drawer with a scrim (css/layout.css:1054-1082). At 380px that drawer covers 272px and leaves a 108px sliver, which is not a preview of the conversation, it is a tap target painted grey.

**Reject the bottom tab bar.** Material 3's "always use a navigation bar below 600dp" is thumb-reach reasoning; there is no reach gradient with a mouse, the bottom edge is already the composer, and a 56-80dp bar costs 6-9% of the column forever. Microsoft Teams took its minimum desktop window from 720px to 360x502 in January 2025 with an explicit no-loss-of-functionality commitment and did NOT add one. **Reject the permanent rail too** - at 380px it is 16-18% of the width for a dashboard that is team-specific by definition. Push-navigation costs zero permanent pixels, and Ctrl+K carries what chrome cannot.

Design floor: **360 wide by 500 tall**, not 380x900. Chrome's Side Panel minimum was raised from 320px to 360px and extensions get no width control at all, and it resets every restart. Assume you will be handed 360 and cannot negotiate.

## Density: geometry, not type

[STATUS 2026-08-25: pointer-axis split LANDED (23a450f, data-input twins
beside every target-sizing media block; mouse compaction shipped for #sidebar
rows only), narrow message geometry LANDED (92e7848, messages.css section 14).
The data-density attribute tier stays OPEN pending concrete --s-* token
values - no burst will invent them headless.]

WCAG 2.2 SC 2.5.8 Target Size (Minimum) is **24x24 CSS pixels at AA**, with a spacing exception. 44x44 is SC 2.5.5, Level **AAA**, and is an Apple/Material touch heuristic. Dek's 44px floors are the largest waste of vertical space in a narrow mouse-driven panel.

Split target sizing off the width axis entirely. Set `data-input` from the last pointer actually used:
```js
addEventListener('pointerdown', (e) => {
  document.documentElement.dataset.input = e.pointerType === 'mouse' ? 'mouse' : 'touch';
}, { capture: true });
```
seeded from `matchMedia('(any-pointer: fine)')`. Then convert the `(hover:none)` blocks to `:root[data-input="touch"]` selectors, keeping the media query as the pre-JS default. Under `mouse`, drop to 26-28px rows. Across ~15 sidebar rows plus the action bars that is roughly 200px reclaimed from a 900px column, with no AA regression. A laptop WITH a touchscreen reports `pointer: fine` for its primary device, so neither `hover:none` nor `any-pointer:coarse` alone is honest - only the last actually-used pointer is.

Message geometry under `@container dek (max-width: 440px)`: `--gutter: 28px` (avatar 24px, from 44), `.msg { padding: 3px 10px; gap: 8px }`, `.msg:not(.grouped) { padding-top: 6px }`. Keep `--t-base: 14px` - do NOT shrink body type. At 380px minus 20px padding minus a 28px gutter the measure is 332px, about 55 characters at 14px, inside the comfortable 45-75 range; shrinking type would push past 65 and hurt. Move the header timestamp to the end of the name line with `margin-inline-start:auto` so it can never wrap. Add `text-wrap: pretty`, `overflow-wrap: anywhere` and `scrollbar-gutter: stable` so the measure does not jump 15px when the list becomes scrollable. Widen the message grouping window to 10 minutes below 440px, read from a ResizeObserver on `#app`. Net effect combined with the header merge: roughly 23 visible messages to roughly 30.

Adopt `field-sizing: content` for the composer (Baseline newly available June 2026) with `min-height: 22px; max-height: 30cqb` and never an explicit `height` - it removes a scrollHeight read-write cycle and the jitter it causes when the message list is auto-scrolling. Keep `rows="1"` as the no-support fallback, but note `rows` is ignored once field-sizing is active.

Ship density as `#app[data-density="compact"|"cozy"]` attribute selectors overriding the `--s-*` tokens, defaulting to compact when embedded. Set a `--density` custom property in parallel so the eventual `@container style(--density: compact)` refactor costs nothing - style queries on custom properties were still landing in Firefox through 2026, so the attribute is what ships today.

## Existing bugs to fix first, in order

[STATUS 2026-08-25: ALL 13 VERIFIED LANDED against the live tree. Item 1 was
committed long ago (the "currently uncommitted" note below is false), 2-8 and
10 and 12 in the P0 batches, 9 via fec9789, 11 via d2102c2, 13 via 7552bac
(breakpoint crossing retires phone furniture). Do not re-implement; kept as
the measurement record.]

1. **Grey box under the servers - ALREADY FIXED, verify and commit.** `css/polish.css` line 81 now reads `#spaceRail > .sicon { min-height: 44px; }` with a comment at line 70 recording exactly what happened: it was `#spaceRail > *`, which hit `.sorg-sep` (declared `height:1px` at css/features.css:1728) and `.sorg-label`. min-height beats height (CSS 2.2 §10.7 recomputes used height; Flexbox §9.7 clamps the item's target main size, and `#spaceRail` is `flex-direction:column` so height IS the main axis), so the 1px partition rendered as a 24x44 block of `--c-nav-border` and the label inflated from 16px to 44px with its text top-aligned. Measured at 390x844: sorg-sep 24x44, sorg-label 44x44. The rule was a pure no-op for its intended targets, since `.sicon` is already 44x44 unconditionally at css/layout.css:566. Verify at 390x844 with two organisations, then COMMIT - css/polish.css is currently uncommitted.

2. **`#topbar` cannot shrink below 688px.** `minmax(180px,1fr) + minmax(280px,720px) + minmax(180px,1fr)` plus gaps and padding (css/shell.css:39-52). Below that the grid overflows and, because the override only fires on viewport width, a 400px panel on a big screen loses the entire right zone (connection state, install, help, user menu) off the clipped edge. Change the base track list to `minmax(0,auto) minmax(0,1fr) minmax(0,auto)` and move the shell.css:332-336 override into the container query.

3. **`.ctools { flex: none }` starves the composer.** Measured at 400px: 5 format tools at 36px + gaps = 188, attach/emoji/send = 108, `.crow` gaps 16, padding+border 10, `#composerBar` padding-inline 32 = 354, leaving the textarea **46px**. This is the exact failure the phone block's own comment (css/messages.css:1321-1324) was written to prevent, and it only bites where that block does not fire. Make `.ctools { flex: 1 1 0; min-width: 0; overflow-x: auto; scrollbar-width: none; }` UNCONDITIONAL at css/messages.css:1106 - it costs nothing at desktop width because the tools never overflow there.

4. **Two channel-bar actions are unreachable at every width ≤860px.** js/ui.js:239 renders the first `inlineCap = 4`; js/shell.js:102 builds the More menu from `all.slice(INLINE_ACTIONS)` with its own separate `INLINE_ACTIONS = 4`; css/shell.css:349 then hides `button:nth-child(n+3)`. So on every phone the third and fourth registered actions - by order, "Saved and Later" (30) and "About this channel" (30) - are in the DOM, invisible, and absent from More. Delete the CSS rule and make the cut ONE number in JS: a `visibleActions()` returning 2 when narrow and 4 otherwise, used for both the slice and the menu. One source of truth means they can never disagree.

5. **Adjacent channel-bar icons fire each other.** css/components.css:226-234 gives every `button.icon` a 44x44 centred `::after` under `(hover:none)`; css/shell.css:212 then wins on specificity and shrinks the visible box to 30px. With `gap: 2px` the two extensions overlap by 12px and the later sibling paints on top, so the last ~5px of every button belongs to its neighbour. `#topbar` does not have this because css/layout.css:1168 raises those to a real 44px. Either raise `#channelbar button.icon` to 44px on touch (and `--channelbar-h: 52px`), or shrink the extension to `32x44`.

6. **Channel name spills over the members chip.** `.cb-title strong` has `white-space:nowrap`, no `overflow`, no ellipsis, and `#channelbar` has no `overflow:hidden`. At 360px the fixed right-hand content leaves the title ~168px, about 16 characters at 15px bold. Add `min-width:0; overflow:hidden; text-overflow:ellipsis` at css/shell.css:178, matching what `.cb-topic` already does at :185.

7. **A permanent fade over a button that is not scrollable.** css/layout.css:399 gives `.hdr-actions` a right-edge `mask-image` with an 18px fade, but the live `#headerActions` lives in `#channelbar` and css/shell.css:211 restyles it without clearing the mask. With only two 30px buttons visible the box is 62px and the mask fades everything past 44px, so the second icon is permanently ~60% transparent with nothing to scroll to. Clear it in `#channelbar`, or apply the mask only via an `.is-scrollable` class set where the buttons are rendered.

8. **Two viewport-sized panels inside a 400px shell.** `aside#panel { width: clamp(300px, 32vw, var(--panel-w)) }` (css/layout.css:910) resolves 32vw against the HOST viewport - ~614px on a 1920 screen, clamped to 400px, so the panel consumes the entire shell. And js/features/admin.js:24 INJECTS `@media (min-width:861px){ aside#panel:has(.admin-root){ width: min(780px, 64vw) } }` from JS, which grepping `css/` will never find. Switch both to container units (`32cqw`, `64cqw`) and container queries. js/features/orgadmin.js:855/858/880/897 and js/features/profilepage.js:413 inject four more viewport queries that need the same treatment.

9. **Toasts and the error bar sit on the composer.** `.toasts` is `bottom: max(64px, safe+32px)` (css/components.css:554) against a touch composer measuring ~142px, despite the comment at :551 claiming it clears it. The error bar is worse: `position:fixed; bottom:12px; z-index:9999` (js/features/errorreport.js:113) for 30 seconds with `pointer-events:auto`, so it blocks the send button, and 9999 jumps outside the token ladder (`--z-toast` is 300) so it paints over modals and the lightbox. Set `--composer-h` from a ResizeObserver and anchor both to it; bring the error bar into the ladder, or better, append it into `section.msgs` as a flow child the way `#obBar` already is so it pushes the list instead of covering it.

10. **`#messages` has no `overscroll-behavior`.** Scrolling to the top of the message list scroll-chains into the host dashboard, which is the single most visible "this embed is broken" symptom. `#spaceRail` and `aside#panel > .content` already have `contain`; add it to `#messages`, `#sidebarScroll`, `.modal-body` and every `max-height + overflow-y:auto` block. One property.

11. **Popovers escape the panel.** js/ui.js:327 and :355 clamp to `window.innerWidth`, which is the HOST viewport in a same-document embed, and js/ui.js:327 has no lower bound so a narrow container produces a negative left. js/features/uxfix.js:371-376 already implements the correct two-sided clamp for the menu it rebuilds; ui.js was never updated. Clamp to `#app`'s rect, or move to CSS anchor positioning with `position-try-fallbacks: flip-block, flip-inline` behind an `@supports` guard and let the browser clamp against the real containing block.

12. **60px reserved band lands on the wrong element.** css/polish.css:239 applies the unread-pill reserve to `section.msgs > :first-child`, but js/features/offline.js:940 inserts `#obBar` before `#messages` and js/features/orientation.js:195 inserts a banner as `firstChild`. With the offline band showing, the state bar is pushed 60px down and a transparent hole opens under the channel bar. Name the elements that may carry the reserve instead of using `:first-child`.

13. **Nothing listens to resize.** `body.nav-open` and `body.panel-open` survive a rotation or a panel resize with no reconciliation, so a drawer opened at 390px stays flagged open when the box widens past 860px where `#sidebar` is no longer absolutely positioned. There is not one resize or matchMedia change listener in the repo.

## Keyboard and accessibility in a dock

[STATUS 2026-08-25: EVERY DELIVERABLE IN THIS SECTION IS LANDED. Hijacks:
400ee1b (Shift+T deleted, Ctrl+F deleted, Ctrl+K '#' routes to full-text
search, uxfix stopPropagation). Escape: daf00df (one LIFO close stack +
CloseWatcher per entry, capture keydown fallback). Live region: 6893a9f
(role=log gated on IO + bridge visibility; kept aria-live=polite as the
mute switch, a named deviation from the "do not add aria-live" note below).
Safe-area: f7a8e82 (--safe-t/b/l/r tokens, 36 sites not 16 - later features
added their own). Keyboard inset: bf25228 (--kb token consumed by both
composer padding sites, documented in EMBED.md). Still open: the window->#app
rebinding was REJECTED with reasons (10f924f proof) and the modal+lightbox
ordering edge is covered by the LIFO stack.]

**Rebind all three global keydown listeners from `window` to `#app`** (js/main.js:399 bubble, js/features/shortcuts.js:164 capture, js/features/uxfix.js:785 capture), add `tabindex="-1"` to `#app`, and gate unmodified keys on `app.contains(document.activeElement)`. Host-page events never bubble into `#app`, so scoping becomes automatic. **Delete Ctrl+F outright** (js/main.js:402) and move search behind Ctrl+K with a `#` prefix - browser find is muscle memory and stealing it is the one thing a user will unambiguously blame the dashboard for. **Delete plain Shift+T** (js/main.js:426), which cycles the theme with no modifier exclusion, so Ctrl+Shift+T (reopen closed tab) both opens Threads and cycles the theme, and which is documented nowhere in the help sheet. Also fix js/features/uxfix.js:1008, where the composer's Ctrl+K calls `preventDefault()` but not `stopPropagation()`, so a link dialog and the quick switcher stack two modals.

Replace the three competing Escape handlers with one LIFO close stack (inline edit -> context menu -> popover -> modal -> pushed panel view -> panel), with a `CloseWatcher` fast path where available - it groups correctly with `<dialog>` and popover and handles the Android back gesture, but MDN flags it not Baseline so it can only be an enhancement. Its `cancel` event is exactly the hook for "the last Escape posts `close-request` and does nothing else".

**Do not trap focus.** The panel is furniture, not a dialog; trapping is a WCAG 2.1.2 failure and makes the dashboard unreachable by keyboard. Give `#app` `role="complementary"` + `aria-label="Dek team chat"` when embedded, require `title` on the iframe, and expose `focus()` over the bridge.

Give `#messages` `role="log"` with `aria-label="Messages in #channel"` and `aria-relevant="additions"`. Do NOT add `aria-live` on top - `role=log` already implies polite and `aria-atomic="false"`, and doubling up gets messages announced twice. Then GATE it: flip to `aria-live="off"` when an IntersectionObserver on `#app`, a zero-width ResizeObserver, or the host's `visible` message says the panel is hidden. An ungated live region in a side panel reads every message from every channel aloud while somebody works in the host app. js/features/uxfix.js:619-646 already implements exactly this gating pattern and can be lifted.

**Drop `env(safe-area-inset-*)` to a token.** All 16 sites resolve to 0 inside an iframe because insets are exposed only to the top-level document, so the home-indicator clearance silently disappears from the composer, drawer, rail, panel, modal sheet, toasts and both full-page overlays. Introduce `--safe-b: env(safe-area-inset-bottom, 0px)` in tokens.css and use `var(--safe-b)` everywhere; the host can then set it on the frame or post it in.

**The iOS keyboard is invisible to the frame.** MDN is explicit: for an iframe, VisualViewport metrics always equal the layout viewport metrics. Neither `100dvh` nor `window.visualViewport` moves when the keyboard opens. Only the HOST can measure it, so keyboard inset must arrive over the bridge as a `--kb` custom property the composer's bottom padding consumes. This is the sort of thing discovered two weeks after ship.

---

## Roadmap

[STATUS 2026-08-25: steps 1-8 are done client-side (see the Status block up
top for per-step commits); 9-11 wait on DB deploy windows and 12-30 are
unstarted. `needs DB` remains the honest tag for every server-side item.]

### 1. Stop the offline regression and ship the security quick wins  `xs` `needs DB`

**Why.** js/main.js statically imports './embed.js' but sw.js does not precache it, so an offline cold start is a blank page for the STANDALONE app. The embed work regressed the shipped product. Bundle it with the two live stored-XSS sinks in attachment metadata, which XSS on the Dek origin and therefore read the refresh token out of localStorage - and which become screen capture on the dashboard once the embed grants camera.

**Files.** sw.js (VERSION -> dek-v10, add './js/embed.js' and './css/embed.css' to SHELL_FILES); js/core/media.js:109/113/117/126; js/util.js:220; js/core/composer.js:137; js/config.js:8 (delete DEMO_TOKEN); index.html (meta referrer)

**After.** nothing

### 2. Commit the grey-box fix and the rest of the narrow-panel one-liners  `s`

**Why.** css/polish.css is uncommitted, so the already-correct rail fix is one git checkout from being lost. The rest are single-property changes that make the panel stop looking broken: a 46px composer, a scroll-chaining message list, a channel name spilling over the members chip, a permanently half-transparent icon, and two channel-bar actions that are in the DOM but unreachable at every phone width.

**Files.** css/polish.css:81 (verify+commit); css/messages.css:1106 (.ctools unconditional); css/messages.css + css/layout.css (overscroll-behavior); css/shell.css:178, :211, :349; js/ui.js:232 + js/shell.js:26/102 (one visibleActions())

**After.** step 1

### 3. Move hosting off GitHub Pages and serve frame-ancestors  `s`

**Why.** THE gating decision for the entire embed. GitHub Pages cannot send response headers and frame-ancestors is ignored in a meta CSP, so today any page on the internet can iframe Dek with a live session and clickjack it - js/main.js returns via enter() before the embed auth-wait branch, so an existing session paints the full authenticated UI regardless of who the real parent is. The allowlist stops the bridge, not the framing, and config.js already says so. Until this lands the embed is a demo.

**Files.** _headers at repo root (Cloudflare Pages / Netlify) or vercel.json; a ~15-line node script generating _headers from EMBED_ORIGINS so the two lists cannot drift; js/embed.js initEmbed (refuse when framed without embed=1); js/config.js:44-46 (gate localhost on location.hostname)

**After.** step 1

### 4. Container-query migration: #app becomes the query container  `m`

**Why.** Unblocks every narrow-panel item and every future embed tier in one move. Today a 380px panel on a 1440px screen gets the three-column desktop layout clipped by body{overflow:hidden}. The side effect matters as much as the cause: container-type applies layout containment, which makes #app the containing block for position:fixed descendants, so every full-screen sheet, modal, toast and menu becomes panel-relative instead of covering the host dashboard.

**Files.** css/base.css:88-93 (container: dek / inline-size, height 100%); mechanical rewrite of max-width media queries in css/layout.css:993/998/1136, shell.css:331, messages.css:1292, components.css:319/508, panels.css:1124, features.css:1606, reading.css:133, polish.css:421/579; css/layout.css:910 (32vw -> 32cqw); the injected queries in js/features/admin.js:24, orgadmin.js:855/858/880/897, profilepage.js:413

**After.** step 2

### 5. Split target sizing onto the pointer axis and retune density  `m`

**Why.** WCAG 2.2 AA is 24x24 CSS px; 44x44 is AAA and a touch heuristic. A mouse-driven narrow panel currently pays the touch tax with none of the touch layout. Reclaims ~200px of a 900px column, roughly 6 extra messages, with no AA regression. Must come after the container split or the two axes stay tangled.

**Files.** js/main.js (pointerdown -> data-input); css/components.css:220/270/679/792/897/1240/1293; css/features.css:1676; css/layout.css:1153; css/messages.css (gutter, msg padding, grouping window); css/tokens.css (--safe-b indirection)

**After.** step 4

### 6. One 40px header, push-navigation, no bottom bar and no rail  `l`

**Why.** Returns 56-60px permanently by collapsing topbar + channelbar + voicebar, and replaces the 272px drawer that leaves a 108px grey sliver at 380px. Design floor 360x500, matching what Teams shipped in Jan 2025. Refusing the bottom tab bar and the permanent rail is the substance here: both are pure cost with a mouse and a composer on the bottom edge.

**Files.** index.html (place-switcher button); css/shell.css:39-52 (minmax(0,auto) tracks); css/layout.css:1026 (delete the two-row voicebar hack), :1054-1082 (drawer -> pushed view), :1101-1110 (panel absolute not fixed); js/ui.js:180-214 (navStack + back chevron)

**After.** step 4

### 7. Harden the embed bridge: navigate allowlist, signout teardown, source check, re-identify  `s`

**Why.** Four live defects, one of them a silent privilege escalation. navigate writes arbitrary hashes to location.hash and js/main.js redeems #/join and #/join-org with no confirmation and no gesture. signout leaves the previous person's conversation painted and their message bodies in IndexedDB. onMessage checks ev.origin but not ev.source. And a host calling identify() again swaps the session while the UI keeps showing the previous person, because bus.on('embed:authed') is only registered in the signed-out branch.

**Files.** js/embed.js:131-184 (source check, navigate allowlist refusing #/join,#/join-org,#/admin, signout mirroring shell.js:84-91, applyAuth comparing store.me), :64-71 (anchor the wildcard), :155-156 (reorder), init (normalise host origin, apply embed.theme); js/main.js:138 (notify host instead of trapping on password setup), :527/553 (register the listener unconditionally)

**After.** step 3

### 8. Visibility push, unread and task reports, and the nine-verb public API  `m`

**Why.** document.visibilityState in an iframe reflects the TOP-LEVEL tab, so a CSS-collapsed panel never knows it is hidden - and js/sb.js documents a measured ~35s window where the socket reports joined while carrying no frames, curable only by retryAllNow({force:true}). Without the visibility bridge 'I have to refresh to see new messages' comes straight back, and this time the user cannot refresh. Unread is the callback every vendor ships because it is what makes a collapsed panel worth collapsing.

**Files.** js/embed.js (visible/focus inbound; tasks/close-request/size outbound; ResizeObserver on #app); embed.js (queue stub, tokenProvider callback, drop camera+display-capture, referrerpolicy, title, destroy -> disconnectedCallback, identify de-dup); js/main.js:346-359 (suppress flashTitle when embedded); js/features/notifications.js (say the dashboard handles it)

**After.** step 7

### 9. Embed registry tables, ensure_embed_space, and privileged-feature gating  `m` `needs DB`

**Why.** Auto-provisioning keyed on an immutable provision_key, so two dashboards can both call their team 'Tech' and a rename never orphans the mapping. Must be service-role and complete BEFORE the client's first loadSpaces, or an embedded person lands in showNoTeam() asking for an invite code they can never have. Gating admin/orgadmin/integrations is security, not polish: #/admin is reachable directly inside a third-party frame today, and people.js:387 paints plaintext temporary passwords into the DOM.

**Files.** SQL: embed_hosts, embed_nonces, workspaces.provision_key + partial unique index, ensure_embed_space() (advisory lock, ON CONFLICT DO UPDATE never DO NOTHING, workspace_members.source); js/features/index.js (skip 3 features when embed.active); js/features/orgadmin.js:807-813 (refuse when embedded); js/core/workspace.js:210/260/509 (pin guards); js/shell.js:80 (hide Sign out)

**After.** step 7

### 10. Credential passthrough tier A: custom OIDC provider  `l` `needs DB`

**Why.** The correct answer, verified in GoTrue source (internal/api/token_oidc.go handles provider prefix 'custom:'): signInWithIdToken mints a REAL Supabase session with refresh token, auth.users row and auth.identities row. No service-role key in the request path, no shared HMAC, auth.uid() keeps working, and all ~32k lines are untouched. It also lands in the 1800/hr token bucket instead of the 360/hr non-configurable verify bucket. Omitting the email claim with email_optional:true closes the cross-tenant takeover Supabase's automatic identity linking would otherwise open.

**Files.** scripts/register-embed-host.mjs (POST /auth/v1/admin/custom-providers); js/embed.js applyAuth (signInWithIdToken branch, delete the raw-session branch); js/config.js (EMBED_PROVIDERS keyed by host origin); js/sb.js (per-embed storageKey, detectSessionInUrl:!embed, storage probe); js/core/channels.js:122/174 + activityReport.js:22 + tasks.js:265 (guard localStorage reads)

**After.** step 9

### 11. Credential passthrough tier B: embed-ticket Edge Function  `l` `needs DB`

**Why.** For hosts that cannot run an OIDC issuer. There is no auth.admin.createSession - generateLink + verifyOtp is the only server-mintable, client-redeemable primitive. Return the hashed_token, never a refresh token: a stolen hash is worth one redemption, a stolen refresh token is worth the account. Derive the tenant from the KEY that verified, never from a payload field, or one leaked secret mints every other tenant's users. Never forward a host-supplied role - GoTrue honours it and 'service_role' would produce a user who bypasses all RLS permanently.

**Files.** supabase/functions/embed-ticket/index.ts (verify_jwt=false); SQL: embed_nonces unique jti as the race-free replay store; js/config.js:52 EMBED_EXCHANGE_URL; js/embed.js:102-115 (redeem with verifyOtp({token_hash, type:'magiclink'})); secret rotation columns on embed_hosts

**After.** step 10

### 12. Task schema v2: categories, started_at, precision, priority, provenance  `m` `needs DB`

**Why.** Everything downstream reads one of these columns, and they are all painful to retrofit once real task data exists. started_at is the single highest-value one: without it created_at -> done_at is LEAD time, dominated by holidays and inbox behaviour, and every forecast built on it is noisier for no benefit. The category function is Jira's one genuinely portable idea and costs one immutable SQL function, turning every future view from 8 cases into 5.

**Files.** SQL: alter tasks (started_at, eta_at, priority, parent_task_id, due_precision, due_string, due_tz, origin, order_hint, external_ref, review_note, decline_reason, triage_snooze_until, sync_seq) + 4 indexes + task_category(); set_task_state stamps started_at on in_progress; list_tasks returns category; js/features/tasks.js:253 (STATE_LABEL -> STATE_META), :41/160/169/294/320/434 (one isDone helper)

**After.** step 1

### 13. Make in_progress reachable and split the overloaded note column  `s` `needs DB`

**Why.** in_progress is a defined state with a label that NO client action can set - set_task_state is only ever called with blocked, unblocked and in_review - so every unfinished task looks identical to every other, which is the exact failure the feature exists to fix. Meanwhile `note` serves both the changes-requested note and the decline reason, so a task declined then re-requested then sent back renders one string under the wrong heading.

**Files.** js/features/tasks.js:405-432 (Start/Pause actions in the mayFlip branch), :340-343 (read review_note and decline_reason independently); SQL: review_task writes review_note, decide_task writes decline_reason, keep note as an alias for one release

**After.** step 12

### 14. Plumb the existing NL parser's precision and provenance through  `s` `needs DB`

**Why.** js/lib/asks.js already computes dueHadTime and throws it away, so 'by Friday' is stored and rendered as Friday 12:00 - a fabricated lunchtime deadline, and the specific moment people stop trusting every parsed field including the right ones. The recurrence guard is the other half: silently turning 'every other Tuesday' into one task means the person marks it done and the commitment evaporates. Cheap because the parser exists and is good.

**Files.** js/features/quicktask.js:90-95 (p_due_precision, p_due_string, p_due_tz, p_origin); js/lib/asks.js (recurrence keyword guard before parseDue; business-hours meridiem bias; computed month-end and business-day offsets); js/features/tasks.js dueLabel (day vs minute); individually removable chips + a per-user off switch

**After.** step 12

### 15. task_events append-only log, with progress and ETA posting  `m` `needs DB`

**Why.** A single mutable blocker_note cannot answer 'how long has this been stuck', 'how many times has the ETA moved' or 'who last touched this' - and all three are inputs to the roll-up, the escalation clock and the weekly recap. Asana's status updates are create-and-delete-only by deliberate API design for exactly this reason. The `source` column is what later proves whether the parser and the nudges are helping.

**Files.** SQL: task_events table + 2 indexes, post_task_progress(), list_task_events(); js/features/tasks.js taskCard (ETA slipped action beside I am stuck; render the last event as the progress line); js/api.js (a tasks section - nine RPCs are currently called as bare strings with no single place to check arg names against the SQL)

**After.** step 12

### 16. Progress lives in the source message's thread, not a new comment system  `s` `needs DB`

**Why.** Dek's structural advantage over every competitor. Linear spends real engineering syncing Slack threads bidirectionally to fake this; Height's customers named chat-per-task as the feature they loved before the company shut down betting on autopilot instead. Tasks already carry message_id - promote it to {message_id, channel_id, thread_root} the way Slack Lists stores it, so 'Go to message' lands on the right reply instead of the top of a busy channel. Post exactly four transitions as bot lines; edit the chip for everything else.

**Files.** SQL: tasks.channel_id + thread_root on the row, returned by list_tasks; js/features/tasks.js:455/478 (open the thread, not the channel scroll position); post_as_bot on assigned/blocked/unblocked/done; stable data-task marker on the card, re-read at paint time like slotMessageId()

**After.** step 15

### 17. task_links, unblock notification, and the chain query  `m` `needs DB`

**Why.** The only part of the dependency model that has behaviour rather than decoration. Store ONE row per edge in the blocks direction - Atlassian's own model doc says direction semantics are UI-only, so two rows buys nothing and guarantees desync. Auto-downgrade to relates on resolve is what stops blocker flags rotting into permanent red nobody clears. blocked_on_user and blocked_on_external matter more than task-to-task for this product's actual users. Never gate set_task_done on it.

**Files.** SQL: task_links table, set_task_blocker(), blocker_chains() with WITH RECURSIVE ... CYCLE (PG14+, depth cap 8), task_unblocked broadcast on set_task_done; js/features/tasks.js:337-339 (render the blocking task as a jump link), Stuck tab sorted by downstream_count

**After.** step 15

### 18. forecast.js kernel - pure, dependency-free, ~200 lines  `s`

**Why.** The genuinely novel piece nobody ships on the task card: Linear leaves project health a human judgement, Jira has no native predicted date, and ActionableAgile/Nave sell Monte Carlo as separate analytics products bolted on. Conditional remaining time is right by construction rather than a claim that can be falsified. Measured at 1.4ms for 5000 trials, so it runs inline in renderPanel with no worker and no backend job. Two constants carry measured reasons that no test would ever catch: the window MUST be a multiple of 7 (30 days was 13% wrong, 28 and 35 were exact) and below 12 finished items an 85% promise only covers 81%.

**Files.** js/features/forecast.js (new: pct, cycleDays, refClass cascade, conditionalRemaining, ageBand, dailyThroughput, mcWhen, phrase). No imports from store/api/util so it is testable with plain node. Fed entirely by rows list_tasks already returns.

**After.** step 12

### 19. Forecast on the card, a Slipping tab, and a capped Overdue section  `m` `needs DB`

**Why.** Lead with the observation, not the prediction, because aging is a fact and a date is a claim. Amber at the 70th percentile of age buys 3 days of notice at 50% precision; p50 floods you with half of all work at 30% precision; p85 has perfect precision and zero warning. And the unbounded Overdue section is the alarm-fatigue experiment run on your own users - 72-99% false alarms in the ICU literature produces over 60% non-response. Ranking preserves all the information and destroys none of the attention.

**Files.** js/features/tasks.js taskCard (forecast line + band chip, .tsk-fc-amber/.tsk-fc-red), TABS + {key:'slipping'}, section('Overdue') capped at 5 with an expander, refreshCount excluding proposed/rejected/cancelled; SQL: task_forecasts(task_id, made_at, p50_at, p85_at) for the calibration self-check

**After.** step 18

### 20. Triage queue: single-key disposition, an unassigned tab, and a named router  `m` `needs DB`

**Why.** The owner's 'top of the funnel person' made concrete, and it is ~70% built - the proposed state with Accept/Decline already exists at tasks.js:363-382. Four verbs on single keys is the complete disposition vocabulary at the market leader and nothing else has proven necessary. The unassigned tab is the whole answer to the problem tasks.js's own header comment was written about: an ask that gets three thumbs-up and is done by nobody. asks.js's UNOWNED detection already routes 'can someone...' straight there. Snooze must wake on new activity as well as on a timer, which is the half everyone forgets.

**Files.** js/features/tasks.js:243-251 (add unassigned + triage tabs, one-tap 'I'll take it'), keydown on the panel body (1 accept, 2 duplicate, 3 decline, h snooze); SQL: triage_snooze_until, workspaces.triage_router_id; js/features/admin.js (set the router, show their avatar on the queue header)

**After.** step 13

### 21. Merge Later and Tasks into one personal queue with one badge  `m`

**Why.** Slack has three personal queues and its January 2026 Activity rebuild still does not carry list assignments; Microsoft is the only vendor that solved it, by making one write appear in three surfaces. Dek is reproducing the mistake at 1/1000th the scale, and tasks.js:5-6 documents an integration that does not exist in the code - nothing calls later_add. Merge at the READ side, which is far cheaper than changing the write. Do this BEFORE adding more task surfaces or every one of them starts at zero adoption.

**Files.** js/features/later.js (also call list_tasks({p_filter:'mine'}), one time-ordered list with Overdue/Today/Waiting on me/Later sections); js/features/coordnav.js ROWS; unregister the duplicate badge; fix or delete tasks.js:5-6

**After.** step 19

### 22. Bounded nudge ladder with a hard stop and commitment-producing snooze  `l` `needs DB`

**Why.** Measured: alert acceptance IRR 0.90 per 5 percentage points of repeated alerts (95% CI 0.86-0.95, 112 clinicians, 1.27M alerts). Repeats have negative marginal value AND degrade response to unrelated alerts, so the answer to silence is a change of surface, not volume. Three personal nudges - the first one working day BEFORE due, not on it - then a shared digest, then two escalations, then quiet with ownership parked. Every threshold in working hours, clamped through the quiet-hours predicate that already exists, or a Friday 17:00 blocker reaches a manager at 17:30.

**Files.** SQL: task_nudges table, nudge_task() modelled on chase_acks, a pg_cron Edge Function reusing the reminders firing path; js/features/tasks.js (Done / New date / I am stuck, never a bare dismiss; ladder resets to step 1 on a new date and records the cycle); js/features/notifications.js inQuietHours()

**After.** step 15

### 23. Daily 'Waiting on' digest, generalised from ackloop  `s` `needs DB`

**Why.** The hardest half is already built and hardened: ack_status returning {audience, acked_count, pending[]}, a card that names the non-responders rather than counting them (its comment explains why - the point is that you can ring them), a server-side rate-limited chase button, and an admin report split into Still waiting / Everyone confirmed. This is Geekbot's Engagement Summary, which their own docs call the gentle alternative to another DM, and it is escalation tier four in the ladder above.

**Files.** SQL: task_digest(p_workspace, p_date); js/features/ackloop.js (generalise the card); post_as_bot once per day, then EDIT that message all day rather than reposting; stable data-rollup marker, updated by marker not by author

**After.** step 22

### 24. Saved views replacing fixed tabs, plus a full-page board at #/tasks  `l` `needs DB`

**Why.** Fixed tabs are the ceiling on every product in this category until they add saved filters, and a view-as-data kills the stale-tab-key bug tasks.js:265 already guards against. Board is the single feature non-technical buyers check for and needs no new RPC - bucket the same payload by category, drag calls set_task_state. But it must be a PAGE, following orgadmin's #/admin precedent, never the panel: column layouts assume ~1000px and at 380px a board degrades to a horizontally scrolling column of one.

**Files.** js/features/tasks.js:243 (TABS -> PRESETS as filter objects, serialised into the hash, user views under dek-backend.tasks.views); a new #/tasks route owned by the feature the way profilepage.js:335 owns #/u/<id>; js/features/coordnav.js ROWS; SQL: list_tasks takes a filter object

**After.** step 21

### 25. Workload by person and week, and the space roll-up with a published threshold  `m` `needs DB`

**Why.** 'Who is on what' is the question a top-of-funnel person actually asks, and it is a grouping not a board. Compute from counts by default - monday's own default is one item = one unit of effort - and refuse to draw the chart when the effort unit and capacity unit disagree, which is monday's documented failure mode. The roll-up is the differentiated bit: compute a colour AND take the human's AND show the disagreement, with the threshold printed next to it, because that is what makes amber a fact rather than an accusation and is the only defence against the watermelon.

**Files.** SQL: task_workload(p_workspace), space_rollup(p_workspace) returning {derived, reasons[], counts{}, override, override_expires_at} with a 7-day override expiry; a rollup panel via ui.registerPanel; render the gap in words, never a bare coloured dot

**After.** step 24

### 26. Weekly per-person recap generated from task_events  `m` `needs DB`

**Why.** Two of Zapier's three named async-standup failure modes are answer-quality failures (vague, or performative detail), and both come from free text. Generating the update from state that already exists removes the daily tax and makes the answer un-vague by construction; one optional box preserves the qualitative input Linear identified as genuinely irreplaceable without making it the price of participation. Basecamp proves the mechanism: a clock and two questions, no inference, no failure mode.

**Files.** Edge Function on pg_cron per Space; render as a card in the merged Later/Now panel with one 'Send to #channel' button; one optional free-text field labelled 'Anything the numbers do not show?'

**After.** step 23

### 27. Jira interop, phase 1: idempotent remote links, one way only  `m` `needs DB`

**Why.** globalId 'dek:task:<uuid>' makes it a stateless upsert - re-POST on every change with no mapping table, no conflict resolution and no duplicate risk - and object.status.resolved renders the link struck through, which carries the only bit that matters. Highest value per line of any integration work here. Cannot be a features/*.js file under any circumstances: Jira Cloud serves no CORS headers on its REST API by deliberate Atlassian policy (JRACLOUD-65573), so a static frontend physically cannot call it. Build a plain OAuth 2.0 3LO app, never Connect, which is dead by Q4 2026.

**Files.** Edge Function posting /rest/api/3/issue/{key}/remotelink; SQL: external_connections (OAuth tokens, self_actor_id) + tasks.external_ref; js/features/tasks.js (issue-key chip in the meta row); a #/task/new?title=&assignee=&due= prefill route so any host page can create a task with an anchor tag

**After.** step 16

### 28. Jira interop, phase 2: inbound ingest with three-layer echo suppression  `xl` `needs DB`

**Why.** Start with the Automation 'Send web request' path, which needs no OAuth, no scopes and no 30-day expiry and reuses the token-in-body credential model integrations.js already implements - but state the plan quota in the setup UI or a Free-plan customer's tasks silently stop on the 3rd of the month. Loop prevention needs all three layers because each alone has a known hole, and layer 3 (never write a value that already equals the remote's) is also what protects Dek's own task_update broadcast from repainting every client on every reconciliation pass. Return literally 200 - Jira treats 204 as a failure and retries five times.

**Files.** Edge Function task-ingest with per-provider adapters (Jira Automation, Jira webhook, Linear); SQL: webhook_deliveries keyed on X-Atlassian-Webhook-Identifier (insert-then-process), sync_suppressions with a 120s TTL, external_links keyed on the IMMUTABLE numeric id never the issue key; hourly reconcile via /rest/api/3/search/jql with updated >= -75m; daily webhook refresh cron

**After.** step 27

### 29. Outbound task webhooks and the sync counter  `l` `needs DB`

**Why.** Makes Dek pluggable the other way, which is the point of the whole embed strategy. Copy Linear's contract verbatim so third-party integration is a documentation task rather than a design task - updatedFrom is the field every home-grown webhook omits and every consumer needs, because it turns an update event into a diff without a read. The sync_seq counter is the cheap half of Linear's speed: a client can tell whether its cached list is stale without refetching, which matters most for a panel on hotel wifi.

**Files.** SQL: a per-Space bigint sequence stamped on every task write, list_tasks(p_since bigint), list_tasks(p_message_ids uuid[]); move the task_update broadcast to the WORKSPACE topic (events.js:265 already does this correctly) carrying {task_id, message_id, ...changed}; js/features/tasks.js:204-217/544 (patch byMessage in place, full refetch reconnect-only); route writes through js/lib/outbox.js with an optimistic overlay the cache is rendered THROUGH, never written INTO

**After.** step 28

### 30. Optional LLM proposal layer, only for what the parser could not read  `xl` `needs DB`

**Why.** Last on purpose. The deterministic parser already covers most of what a model would be called for, at zero latency and zero cost, and the measurement infrastructure (the origin column from step 14) is what decides whether this is worth its spend at all. Linear's own AI triage takes 1-4 MINUTES per issue and still never blocks issue creation; Zendesk's shipped architecture has the classifier write fields and a separate deterministic layer route. Optional fields paired with a required verbatim-evidence span, checked server-side against the message, is what turns a hallucinated deadline from an invisible error into a caught one.

**Files.** Edge Function propose_task (strict:true, additionalProperties:false, tool_choice pinned, disable_parallel_tool_use); SQL: suggested_* columns rendered as dashed-outline chips with Accept/Dismiss, visually distinct from human-set values, plus a per-Space show/hide/auto-apply setting per property; human-written description columns on channels and labels, which are the highest-leverage prompt input and cost nothing

**After.** step 20

---

## Quick wins

[STATUS 2026-08-25: ALL 22 VERIFIED LANDED (the 7cebd18 burst swept the list
and re-checked each anchor; spot-checks this sweep confirm tasks.js header
and dialog copy rewritten, /me renamed /myprofile, sw.js dek-v16 with embed
entries, polish.css committed). Do not re-implement; kept as record.]

1. GREY BOX UNDER THE SERVERS - already fixed, verify and commit. css/polish.css:81 now reads `#spaceRail > .sicon { min-height: 44px; }` (was `#spaceRail > *`), with the measured explanation at line 70. min-height beats height and #spaceRail is flex-column, so the 1px .sorg-sep (css/features.css:1728) was clamped to a 24x44 block of --c-nav-border and .sorg-label inflated 16px -> 44px with top-aligned text. Load at 390x844 with two organisations, confirm the partition is a hairline again, then commit - css/polish.css is currently uncommitted so this fix is one `git checkout` away from being lost.

2. SW MANIFEST - live blocker on the STANDALONE app. sw.js VERSION is still 'dek-v9' and SHELL_FILES contains neither './js/embed.js' nor './css/embed.css', while js/main.js:23 statically imports './embed.js'. Offline, the own-asset handler races the network for 3.5s, misses the cache, returns Response.error(), and main.js never evaluates - blank page. Add both paths next to their neighbours and bump VERSION to 'dek-v10'. Without the bump the new entries never precache. 5 minutes.

3. ATTACHMENT XSS #1 - js/core/media.js:109. `const ratio = x.width && x.height ? `${x.width}/${x.height}` : '4/3'` is interpolated raw into a double-quoted style attribute at :113 and :117. `w` is neutralised by Math.min, `ratio` is not. Attachments are entirely client-authored (js/core/composer.js:295 -> p_attachments). Fix: `const ratio = +x.width > 0 && +x.height > 0 ? `${+x.width}/${+x.height}` : '4/3';` and coerce w with Number() too. Numeric coercion, not esc(), because it is a CSS ratio. XSS on this origin reads the refresh token out of localStorage.

4. ATTACHMENT XSS #2 - js/core/media.js:126 interpolates fmtSize(x.size) unescaped, and js/util.js:220 returns `(n || 0) + ' B'` verbatim for a non-numeric string (both `>` comparisons are false against NaN). Wrap as `${esc(fmtSize(x.size || 0))}` and harden the helper: `const n = Number(v) || 0` at the top. js/core/composer.js:137 has the same unescaped call on local files - fix both for consistency.

5. TASKS GO STALE AFTER EVERY RECONNECT - one line. js/features/tasks.js:620 re-binds the realtime handler only on `channel:open`. Core replaces the 'chan' object on every recovered drop as well as every switch and emits `channel:subscribed` precisely so features can re-bind (js/core/channels.js:659-665); ackloop, forms and polls all listen to it. Add `bus.on('channel:subscribed', scheduleBind);` next to line 620.

6. EMBED DEEP LINK IS DEAD CODE - js/embed.js:155-156. `if (msg.channel)` catches every message that also carries `msg.message`, so the `#/m/<channel>/<seq>` branch is unreachable and a host deep-linking to a message silently opens the channel at its bottom. Reorder: test `msg.channel && msg.message` first.

7. EMBED NAVIGATE IS A PRIVILEGE-ESCALATION HOLE - js/embed.js:157. `msg.route` is written straight to location.hash and js/main.js:74-92 redeems `#/join/<token>` and `#/join-org/<token>` with no confirmation and no user gesture, so an XSS'd allowlisted dashboard silently enrols the person into an attacker's org. Delete the free-text route branch; accept only {space}, {channel}, {channel,message}.

8. ORIGIN MATCHER IS LOOSER THAN ITS OWN COMMENT - js/embed.js:64-71. `pat.replace('*.','')` replaces the first occurrence ANYWHERE, and the branch also matches the apex (`u.hostname === p.hostname`), contradicting config.js's promise of 'subdomains of that host, and nothing else'. Require `pat.startsWith('https://*.')`, strip exactly that prefix, drop the apex equality. Also normalise `embed.host = new URL(host).origin` at init - the raw query value is compared with `!==` later, so a trailing slash hangs the panel for the full 15s.

9. LOCALHOST IN THE PRODUCTION ALLOWLIST - js/config.js:44-46 ships `http://localhost:8098` and `http://127.0.0.1:8098`, and originAllowed() exempts localhost from the https requirement. Deployed, any page a user's own machine serves on port 8098 can drive the panel and receive credentials. Gate both on `location.hostname` being localhost.

10. DEMO_TOKEN IS A LIVE CREDENTIAL - js/config.js:8 is an open-invite token for a real 1770-member Space, served to every visitor since the initial commit, and imported by nothing (grep confirms only the definition). Delete the export, then revoke the token server-side. Rotating the value is not enough: it is in git history and every cached copy of config.js.

11. REFERRER LEAK - no `<meta name="referrer">` in index.html and no `referrerpolicy` on the iframe (embed.js:73-87), so every Supabase request from the panel carries the customer's internal dashboard URL into third-party logs. Add `<meta name="referrer" content="strict-origin-when-cross-origin">` and `frame.setAttribute('referrerpolicy','strict-origin-when-cross-origin')`. Two lines.

12. OVER-GRANTED IFRAME PERMISSIONS - embed.js:80-83 delegates `camera` and `display-capture`, neither of which the repo ever uses (js/core/voice.js:30 asks for `{audio, video:false}`; grep finds no getDisplayMedia). Combined with the media.js XSS above this turns message-body script into screen capture on the dashboard's page. Reduce to 'clipboard-write; microphone; autoplay; web-share; fullscreen'.

13. COMPOSER STARVES TO 46px IN A NARROW PANEL - make `.ctools { flex: 1 1 0; min-width: 0; overflow-x: auto; scrollbar-width: none; }` unconditional at css/messages.css:1106 instead of only inside the 860px block. Free at desktop width because the tools never overflow there.

14. MESSAGE LIST SCROLL-CHAINS INTO THE HOST - add `overscroll-behavior: contain` to #messages, #sidebarScroll and .modal-body. #spaceRail and the panel content already have it. One property, and it is the most visible 'the embed is broken' symptom.

15. CHANNEL NAME HAS NO ELLIPSIS - add `min-width:0; overflow:hidden; text-overflow:ellipsis` to `.cb-title strong` at css/shell.css:178, matching what .cb-topic already does at :185. At 360px the title gets ~168px and currently spills over the members chip.

16. PERMANENT FADE OVER A NON-SCROLLING BUTTON - css/layout.css:399 masks `.hdr-actions` with an 18px right-edge fade, but the live element sits in #channelbar where css/shell.css:211 restyles it without clearing the mask, so with two visible buttons the second is ~60% transparent forever. Add `#channelbar .hdr-actions { mask-image: none; -webkit-mask-image: none; }`.

17. TWO SLASH COMMANDS SILENTLY OVERWRITE EACH OTHER - `/me` is registered by both js/features/profilepage.js:345 ('open your profile') and js/features/shortcuts.js:395 ('action in italics'); `/roles` by both onboarding.js:481 and roles.js:452. addSlashCommand is a Map, and features load via Promise.all so which wins is nondeterministic - the help sheet lists a description that may not match the behaviour. Rename to /myprofile and /getroles, and make addSlashCommand console.warn on a duplicate.

18. ASYNC BUS LISTENERS THROW UNCAUGHT - js/store.js:73-78 wraps handlers in try/catch, which cannot catch a rejection from an async listener, and ~30 listeners return promises. Add `const r = fn(payload); if (r && typeof r.then === 'function') r.catch(e => console.error('bus handler', evt, e));`. Six lines, removes a whole class of invisible failure.

19. UNAWAITED enter() - js/main.js:527 and :553 call enter() with no .catch, so any rejection on the sign-in path (loadSpaces, switchWorkspace, openChannel) is an unhandled rejection that main().catch cannot see, leaving a half-initialised shell. Wrap both.

20. DUPLICATE LINE - js/core/actions.js:384-385 has `if (!userId) return;` twice. Delete 385.

21. STALE COMMENT THAT WILL MISDIRECT THE NEXT READER - js/features/tasks.js:8 says 'Two states, open and done. No projects, no boards, no dependencies, no subtasks.' The file implements an eight-value state machine with proposal/acceptance, blocking with a note, and a review round trip. Rewrite it before anyone designs against it. Also tasks.js:5-6 claims tasks land in the Later queue and nothing in the client calls later_add - either make it true or delete the sentence.

22. FALSE PROMISE IN THE CREATE DIALOG - js/features/tasks.js:128 tells the user 'They get one reminder when it falls due.' No client code schedules it and there is no task equivalent of chase_acks. Delete the sentence until the nudge ladder ships.

---

## Traps

1. HOSTING IS THE GATE, NOT A FOLLOW-UP. GitHub Pages cannot send response headers and frame-ancestors is ignored in a <meta> CSP, so there is no static-HTML workaround. Today any page can iframe Dek with a live session, and js/main.js returns via enter() before the embed auth-wait branch, so an existing session paints the full authenticated UI regardless of the real parent. Leave-this-server and the org console rows are plain confirmModal, not typeToConfirm, so they are clickjackable. Decide the host before writing more embed code.

2. STORAGE PARTITIONING IS NOT A BUG TO FIX. Chrome has partitioned localStorage, IndexedDB, CacheStorage, BroadcastChannel, SharedWorker, Web Locks and service workers by (top-level site, frame origin) for ALL users since Chrome 115; Firefox does the same statically; Safari additionally makes third-party localStorage EPHEMERAL, wiped between Safari launches, plus a 7-day ITP cap. The Storage Access API grants unpartitioned COOKIES only - Safari says so explicitly, Firefox cannot unpartition non-cookie storage at all, and Chrome's StorageAccessHandle is click-gated and not Baseline. So the embedded panel can never see the standalone session. Design for re-handoff on every boot, give the embed its own storageKey, and recommend dek.<customer-domain> as a CNAME so same-site framing sidesteps the whole class for one DNS record.

3. DO NOT USE SUPABASE THIRD-PARTY AUTH WITH THE accessToken OPTION. It looks like the blessed path and it detonates here: SupabaseClient replaces this.auth with a Proxy whose get trap throws unconditionally, and Dek calls ten distinct sb.auth.* methods across six files. There would also be no auth.users row, sub would not be a UUID so auth.uid() breaks, and every RLS policy would need rewriting to auth.jwt()->>'sub' against a text column. Use signInWithIdToken with a custom: OIDC provider instead - verified in GoTrue source - which mints a real session and touches nothing.

4. SUPABASE AUTO-LINKS IDENTITIES SHARING A VERIFIED EMAIL AND THERE IS NO DOCUMENTED OFF SWITCH. With two dashboards on one project, host B minting an ID token asserting email_verified for ceo@tenant-a.com lands inside tenant A's Dek account. Mint host tokens with NO email claim, set email_optional:true, and keep the display email in Dek's own profile table where it carries no authentication weight. One boolean closes it; discovering it later is a breach.

5. NEVER FORWARD A HOST-SUPPLIED role TO admin/users. GoTrue does `if params.Role != "" { role = params.Role }` and auth-js does not even type the field, so it is only reachable by hitting REST directly - which is exactly what a hand-rolled exchange function does. role:'service_role' produces a user whose EVERY future JWT bypasses all RLS, permanently, with no trace in the API keys page. Hard-code it server-side. Same class: derive the tenant from the key that verified the signature, never from a tenant_id field in the payload, or one leaked secret mints every other tenant's users.

6. ON CONFLICT DO NOTHING ... RETURNING RETURNS ZERO ROWS. Postgres documents it: only rows successfully inserted or updated are returned. It passes every single-threaded test and fails the moment two people open the dashboard in the same second, so 49 of 50 people at 09:00 get a null space_id and branch into an error path. Use DO UPDATE with a no-op assignment purely to force RETURNING. Two siblings: a duplicate value in a claims array raises SQLSTATE 21000 cardinality_violation (select distinct first), and DO UPDATE takes a row lock while DO NOTHING does not, so put a read-only fast path in front of the writes.

7. AN LLM IN THE TASK CREATION PATH KILLS THE FEATURE. Linear's own Triage Intelligence takes 1 to 4 MINUTES per issue and still runs strictly after the issue exists. The instant Enter produces a spinner, the composer stops feeling like chat and starts feeling like Jira's create-issue modal, which is the entire thing the owner is escaping. The task must exist the moment Enter is pressed; enrichment arrives later as a separate, attributed, reversible write. js/lib/asks.js already does the right thing - do not regress it.

8. SILENT DERIVED MOVEMENT READS AS LOST WORK. Asana shipped automatic promotion between Today / Upcoming / Later and REMOVED it, replacing it with opt-in rules that run between midnight and 1am. Users could not predict where their work went. Everything Dek derives from a message must be a proposal with a confirm tap - which quicktask.js already does correctly. Never auto-assign, never auto-move, never auto-redate.

9. HEIGHT IS A TESTED COMMERCIAL FAILURE, NOT A PATTERN. Height 2.0 shipped exactly the auto-filled-attributes vision in October 2024 - a reasoning engine that filled Feature, Customer, Impact and tags from the task name, set priority on new bugs, and auto-assigned and escalated high-priority ones. They announced shutdown 24 March 2025 and ceased operations 24 September 2025, having raised over $18M. The feature customers actually praised in reviews was chat-per-task. Do not reason from Height's autopilot as validated; reason from it as tested and failed, and build the thing Dek gets for free instead.

10. A SECOND INBOX IS DEAD ON ARRIVAL. tasks.js's own header records the win that made the current feature work: it drops into the assignee's EXISTING Later queue rather than inventing an inbox nobody opens - except nothing in the client actually calls later_add, so the claim is false today. Slack shipped three personal queues and its Jan 2026 Activity rebuild still does not carry list assignments. Merge Later and Tasks into one surface with one badge BEFORE adding triage, slipping, workload or a board, or each of them starts at zero adoption.

11. TWO-WAY JIRA FIELD SYNC IS A LOOP GENERATOR. Jira and Dek will never agree on status vocabulary and both sides emit webhooks on write, so each system's echo triggers the other, plus duplicate issues when the mapping table drifts. Remote issue links keyed on globalId 'dek:task:<uuid>' are an idempotent upsert with no local state, and object.status.resolved carries the only bit that matters. Also: Jira Cloud serves no CORS headers on its REST API by deliberate Atlassian policy, so this can never be a features/*.js file - budget it as Edge Function work from the first line.

12. JIRA'S SILENT KILLERS: dynamic webhooks registered by an OAuth app EXPIRE 30 days after creation or last refresh, and OAuth apps get only 5 per user per tenant. Everything works perfectly for a month then stops with no error, no 4xx and nothing in any log; and per-Space registration hits the ceiling at the fifth Space and presents as 'a random subset of projects does not sync'. One webhook per site with a broad jqlFilter, fan out server-side, plus a daily refresh cron. Also key every mapping on the immutable numeric id: issue keys change when an issue moves project, and every row keyed on ENG-123 silently detaches months later.

13. AN UNBOUNDED OVERDUE LIST DESTROYS THE FEATURE. tasks.js renders one today. ICU alarm studies put 72-99% of alarms false or clinically insignificant, producing over 60% non-response and 85% of nurses reporting they are overwhelmed - and that is a base-rate property, not a property of any individual alarm. At 30 people and a few months of use the Overdue section becomes a wall, and the moment it does the whole feature is wallpaper. Cap what is shown, rank rather than flag, and make the badge a rank ('the 3 most likely to slip') rather than a count of everything that breached.

14. NUDGE VOLUME HAS NEGATIVE MARGINAL VALUE. Measured across 112 clinicians and 1,266,325 alerts: each 5 percentage point rise in repeated alerts dropped acceptance with an adjusted IRR of 0.90 (95% CI 0.86-0.95). The third identical DM is worth measurably less than the first AND degrades response to unrelated alerts. Change surface, never volume. And the ladder must have a terminal state - PagerDuty caps repeats at nine then parks ownership permanently - because a loop that never stops is what people mute, and a muted channel takes the genuine emergencies with it.

15. DO NOT ADD STORY POINTS, CYCLES, CUSTOM FIELDS OR A SCHEME LAYER. The strongest published story-point estimator beat a median-of-past-items baseline with significance in 8 of 42 within-project settings, and practitioner scatterplots show 2-point items spanning a few days to ~160 days with the widest spread in the 1/2/3 buckets. Jira's slowness originates precisely in the scheme chain: making one field required on one work type in one project forks four shared schemes and silently changes every other project using them, which is why 'Jira admin' is a job title. Cap fields per Space at first commit, not in 2026 like Atlassian had to.

16. MULTIPLE ASSIGNEES AND HARD DEPENDENCY GATES. Linear's stated rationale for one assignee is clear ownership; two names on a task is the same as zero, which is verbatim the problem tasks.js was written to solve. And no shipped tracker prevents marking a blocked task done - people just mark the blocker resolved to get past the gate, so the one signal telling you where work is actually stuck becomes noise. The existing force-override confirm at tasks.js:438 is already the right shape.

17. A KANBAN BOARD IN THE PANEL. Column layouts assume ~1000px; at 380px a board degrades to a horizontally scrolling single column, strictly worse than the card list that already exists, while costing a whole second view to maintain. Put the board on a full-width page at #/tasks following orgadmin's precedent, and keep the panel a ranked list. Refusing the board in the panel is a feature, not a limitation.

18. THE OPTIMISTIC-ID SWAP BREAKS ANYTHING STAMPED AT RENDER TIME. [STATUS
2026-08-25: THE REAL FIX SHIPPED - upgradeMessageRow and claimMessage's nonce
branch emit message:idUpgraded (b8b13dc) and tasks.js/ackloop.js deleted their
render-time workarounds. Kept as background for any new per-message UI.] Core rewrites row.dataset.id from the client nonce to the server uuidv7 WITHOUT re-emitting message:render, so a chip for a task you just created never appears until reload. tasks.js documents the measured uuids and carries slotMessageId() as a workaround; ackloop.js carries a different one. Any new per-message task UI must read the id off the row at paint time. The real fix is for upgradeMessageRow to emit message:idUpgraded, which would let four features delete their workarounds.

19. FEATURES LOAD IN PARALLEL, SO REGISTRATION ORDER IS NOT WHAT THE COMMENTS CLAIM. [STATUS
2026-08-25: LANDED - registerPanel warns on collision unless replaces:true and
addSlashCommand warns (7cebd18); the /me duplicate was renamed /myprofile.] registerFeatures uses Promise.all, so 'Late, so it is registered after the features whose errors it would catch' and 'Last on purpose: it re-registers a few core panels by id' are aspirational. registerPanel is a Map that overwrites silently by id and addSlashCommand is a Map that overwrites silently by name - /me and /roles are each registered twice today with different descriptions. Namespace new ids, and make both registries warn on collision.

20. A HEADER BUTTON IS NOT A REACHABLE SURFACE. renderHeaderButtons paints only the first inlineCap = 4, shell.js has its own separate hardcoded INLINE_ACTIONS = 4, and css/shell.css:349 hides all but the first TWO below 860px. There are 24 registered buttons; tasks sits at order 74 and never renders inline. coordnav.js exists entirely because of this and its header comment documents the measurement. Any new task surface must go into coordnav's ROWS or nobody will ever click it.

21. THE REPO HAS NO BUILD STEP, NO TESTS AND NO LINTER, AND registerFeatures SWALLOWS LOAD FAILURES. A syntax error in a new feature file produces a silently missing feature, not a visible failure, and the catch filters on /Failed to fetch|not found|404/ so a file you forgot to create looks identical to one that loaded fine. The '[dak] features loaded:' console line (renamed from [dek-backend], 2026-08-25) is the only integration check that exists; scripts/smoke.mjs asserts it. Check it after every edit.

22. COMMENT CULTURE IS PART OF THE DELIVERABLE. Every file opens with one line saying what it is for a person, then a WHY block recording what was broken, what was tried, what the trade is, usually with a measured number - and frequently longer than the code it precedes. Section dividers are exactly 70 dashes. There is not one em dash or en dash in the entire codebase. Code that does not match this reads as foreign and will be rewritten by the next person.

---

## Open questions

1. Where will this be hosted? Cloudflare Pages, Netlify, Vercel and a Worker in front of Pages all work and all take a _headers or config file with no build step. This decision gates the entire embed: frame-ancestors is the only thing that stops clickjacking, and it cannot be expressed from a static page. Everything else in the plugin roadmap is downstream of it.

2. Can the host dashboards run an OIDC issuer with a JWKS endpoint, or do they only have a backend that can HMAC a payload? Tier A (custom OIDC provider, signInWithIdToken) is materially better - real Supabase session, no service-role key in the path, the roomier 1800/hr rate bucket - but it requires the host to publish /.well-known/openid-configuration. Tier B (Edge Function ticket) works for anyone but caps at 360 verify calls per hour per IP, which a whole office behind one NAT will hit. If the dashboards are all yours, Tier A is easy and you should commit to it now.

3. How many dashboards, and on what timeline? Supabase's Free plan caps custom OIDC providers at 3. The fourth one means Pro. Cheap to know now, annoying to discover mid-integration.

4. Is a Space per dashboard right, or a Space per dashboard per customer? The design above keys workspaces.provision_key on the host_key, which gives one 'tech' Space shared by everyone opening the tech dashboard. If different customers each need their own isolated tech Space, the key must be host_key + tenant_id from the token and embed_hosts needs an org_id per tenant rather than one. Changing this after data exists is a migration.

5. Does the server's create_task already write a row into the assignee's Later queue? tasks.js:5-6 claims it does and no client code calls later_add, and the schema is not in this repo so it cannot be checked from here. If it does, the merge in step 21 is smaller than scoped. If it does not, that comment has been wrong since the feature shipped and the claim should be deleted rather than quietly made true.

6. Does set_task_state already accept 'in_progress'? The client never sends it, so it may or may not be a legal value server-side. If it is, step 13 is a two-line client change; if not, it needs the RPC opened up first.

7. Is there any server-side rate limit on post_as_bot? integrations.js:26-27 documents it as granted to anon, so the bot token plus the publishable key (which is public by design) is the entire credential on an unauthenticated endpoint. Whether that is safe depends entirely on throttling that is not in this repo. Same question for the /functions/v1/webhook ingress.

8. Who is the triage router in practice - a named rotating person, or whoever holds MANAGE_WORKSPACE? Linear's shipped design is deterministic rules first with a named accountable human as the backstop, and the queue header shows that person's face. For a 30-person NGO Space this may be one permanent coordinator, in which case the rotation machinery is dead weight and a single triage_router_id column is enough.

9. Is Jira actually in use by the people you are building for, or is it a checkbox for a future customer? Phase 1 (remote links) is a small Edge Function and worth doing speculatively. Phase 2 (inbound ingest, echo suppression, hourly reconcile, webhook refresh cron) is genuinely expensive and should wait for a named customer who has Jira today.

10. Should the embedded panel expose file upload and voice at all? Both work in an iframe with the right allow attributes, but voice needs microphone delegation that a host security reviewer may refuse outright, and dropping it shrinks the permission list to clipboard-write plus autoplay, which is a much easier conversation. This is a product call about what a dock is for.

11. How long should a task stay open before the zombie prompt fires, and who gets it? The design says the class p95 and the assignee. For a field team where a task legitimately waits three months on an outside body, p95 may be the wrong clock and blocked_on_external tasks may need exemption. Worth checking against real data once started_at exists and there is a reference class to compute from.
