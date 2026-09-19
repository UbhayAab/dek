# Embedding Dek in a dashboard

Dek runs two ways from one deploy: a standalone app at its own URL, and a panel
docked inside somebody else's dashboard. There is no separate build and no fork.
The app notices `?embed=1` and changes four things - where identity comes from,
which Space it opens, which chrome exists, and who it will talk to.

## The 30 second version

```html
<div id="chat-dock" style="width:400px;height:100vh"></div>

<script src="https://dek.example.com/embed.js"></script>
<script>
  const dek = Dek.mount({
    el: '#chat-dock',
    space: 'Tech',                                   // this dashboard's team
    auth: async () => (await fetch('/api/dek-token')).json(),
  });
  dek.on('unread', ({ total }) => setBadge(total));
</script>
```

`embed-demo.html` in this repo is a working host page. Serve it from an origin
that appears in `EMBED_ORIGINS` and open it.

## Why an iframe

This was measured, not assumed. Loaded in a cross-site iframe at 400x900 the app
boots with zero errors and every feature registers. The two facts that decide it:

- The iframe gets its **own viewport**, so `@media (max-width: 860px)` in
  `layout.css` fires and the narrow layout the app already has applies for free.
  A web component would have inherited the host page's viewport and rendered the
  desktop layout inside a 400px box.
- `(hover: none)` does **not** match in a docked panel, so the 44px thumb floors
  stay off and the panel keeps desktop density. Phone-width layout, mouse-width
  spacing. That combination is the thing the owner asked for and it costs nothing.

A web component would also have inherited the host page's CSS, and every host
would have restyled Dek by accident.

## What the host must configure

`js/config.js`:

```js
export const EMBED_ORIGINS = [
  'https://dash.yourcompany.com',
  'https://*.yourcompany.com',      // subdomains, same scheme and port
];
export const EMBED_EXCHANGE_URL = 'https://<project>.supabase.co/functions/v1/soop-handoff';
```

There is deliberately no bare `*`. A leading `*.` matches subdomains only.

**This allowlist is half the defence.** It stops Dek *talking to* an untrusted
page or accepting credentials from one. It does not stop a browser drawing the
frame. The other half is a response header from wherever the app is hosted:

```
Content-Security-Policy: frame-ancestors 'self' https://dash.yourcompany.com https://*.yourcompany.com;
```

GitHub Pages cannot set headers. If the app stays on Pages, the JS allowlist is
the only enforcement and clickjacking is not prevented. Moving to Cloudflare
Pages, Netlify or Vercel - all of which serve a `_headers` file - fixes that and
changes nothing else about the deploy.

## `Dek.mount(options)`

| option | meaning |
| --- | --- |
| `el` | selector or element the panel is mounted into |
| `space` | Space id, or its name. `'Tech'`, `'tech'` and `'Tech Team'` all match a Space called Tech |
| `channel` | optional channel id or name to open on arrival |
| `chrome` | `'minimal'` (default) hides the Space rail, invite and install. `'full'` keeps everything |
| `theme` | `'dark'`, `'light'`, or omit to let the person choose |
| `auth` | **the only part you have to write.** See below |
| `app` | app base URL, if the loader is not served next to the app |

Returned object: `on(event, fn)`, `off`, `navigate(channel)`, `identify()`,
`signOut()`, `visible()`, `hidden()`, `setTheme(theme)`,
`setTokens({'--c-accent': '#e5484d'})`, `destroy()`, and `.frame`.

Events out: `ready`, `signed-in`, `auth-needed`, `navigated`, `unread`, `tasks`,
`close-request`, `size`, `error`, `pong`.

- `tasks {open, overdue}` fires whenever the panel recounts the signed-in
  person's tasks - the same argument as `unread`, for products where the task
  list is the launcher.
- `close-request` fires when the person presses Escape with nothing left to
  close. The panel never collapses itself on Escape (a dock is furniture, not a
  dialog); you decide whether to hide it.
- `size {inlineSize}` reports the panel's inner width in px, debounced to the
  end of a drag, so a resizable splitter can snap to the app's breakpoints.

Call `panel.visible()` when your layout shows the panel and `panel.hidden()`
when it collapses it. A CSS collapse is invisible inside the iframe - visibility
events there reflect the browser tab, not your layout - and a panel hidden for
a while comes back with a socket that still claims to be joined while dropping
frames. `visible()` makes the panel rebuild the socket and refresh its unread
badge before painting.

`setTokens` accepts CSS custom properties and nothing else, so a host can take
the panel into its brand colours but cannot restyle it into something that
misrepresents what it is.

One token is load-bearing rather than cosmetic: `--kb`, the keyboard inset.
Inside an iframe the panel cannot see the on-screen keyboard - VisualViewport
always reports layout-viewport numbers there - so the composer can only clear
it if you tell it. Push the covered height when the keyboard appears over the
panel and reset it when it closes:

```js
panel.setTokens({ '--kb': '336px' });   // keyboard opened over the panel
panel.setTokens({ '--kb': '0px' });     // keyboard closed
```

The composer's bottom padding consumes it (`calc(max(spacing, safe-area) +
var(--kb))`), so the input row lifts above your keyboard instead of hiding
behind it. The same channel carries the safe-area overrides (`--safe-t/b/l/r`)
if you dock the panel under device bars.

## Identity: the part that matters

The whole point is that somebody already signed into your dashboard never sees a
password prompt. Your `auth` callback runs on **your** page and must call **your**
backend, because your backend is the only party that may hold a signing secret.
Nothing in `embed.js` ever sees one.

Return either shape:

```js
{ handoff: '<single-use token>' }                       // preferred
{ access_token: '...', refresh_token: '...' }           // if you minted it yourself
```

**Prefer `handoff`.** Your backend asks Dek's exchange endpoint for a
short-lived, single-use token naming the person; this browser spends it. A stolen
handoff token is worth one use inside its TTL. A stolen refresh token is worth the
account.

If `auth` is omitted, the panel shows its own sign-in card. That is fine for a
public demo and wrong for a dashboard.

If the host never answers, the panel waits 15 seconds saying so, then falls back
to the sign-in card rather than spinning forever. A real embed should never reach
that fallback.

## What embedded mode changes

| | standalone | embedded |
| --- | --- | --- |
| identity | sign-in card | handed over by the host |
| Space | last one, or a heuristic | pinned by `space=`, host's choice wins |
| Space rail | shown | hidden under `chrome=minimal` |
| service worker | registered | **not** registered |
| install prompt | shown when offered | hidden |
| invite / create-a-Space | shown | hidden under `chrome=minimal` |
| document scroll | normal | locked; only the message list scrolls |
| header | two bars up top | identical rules apply: the box is the frame, so below a 480px app box both modes collapse to ONE 40px bar whose centre button opens the place switcher |

The service worker is deliberately skipped. It is scoped to the whole origin, so
an embed registering one would start serving a cached shell to the standalone app
in another tab, on a version the person never chose.

## Storage inside a third-party frame

Browsers partition storage by the pair (top-level site, embedded site). Measured
in Chrome: `localStorage` inside the frame **works**, and the Supabase session
persists - but it is scoped to that one dashboard. The same person on a different
dashboard gets a different partition and a separate handover. That is the correct
security posture rather than a limitation - but the handover is NOT free, so do
not pay for it per route change. `ready` fires once per iframe MOUNT: mount the
panel once when your app loads and drive it afterwards with `navigate()` /
`identify()`. An SPA that tears down and remounts on every route change pays a
full mint round trip each time, which at scale is its own quota line.

Safari is stricter. If a Safari embed fails to persist, the fix is a memory-only
storage adapter passed to `createClient` in `js/sb.js` plus a handover on every
load, which the design above already assumes.

## Setting up a dashboard, end to end

### 1. Register it (once, in the SQL editor)

Run `supabase/migrations/0100_embed_registry.sql` first, then:

```sql
select * from public.register_embed_host(
  'tech-dashboard',                      -- key, also used to name the env var
  'Tech dashboard',                      -- human name
  '<your org uuid>',
  'Tech',                                -- the server this dashboard shows
  array['https://dash.yourcompany.com']  -- origins allowed to mint
);
```

It returns a secret **once**. Only its hash is stored, so there is no way to read
it back and no endpoint that could be tricked into printing it.

### 2. Give the secret to the Edge Function

```bash
supabase secrets set EMBED_SECRET_TECH_DASHBOARD='<the secret>'
supabase secrets set SOOP_APP_ORIGIN='https://dek.yourcompany.com'
supabase functions deploy soop-handoff --no-verify-jwt
```

`--no-verify-jwt` is required and is not a weakening: the caller does not have a
Supabase JWT yet, which is the entire problem being solved. The HMAC is the
authentication.

### 3. Add the origin in two more places

`js/config.js` -> `EMBED_ORIGINS`, and `_headers` -> `frame-ancestors`. Three
lists, three different failure modes, on purpose:

| missing from | symptom |
| --- | --- |
| `_headers` | blank panel; the browser refuses to draw the frame |
| `EMBED_ORIGINS` | panel loads, never signs anybody in, waits 15s |
| `embed_hosts.allowed_origins` | mint refused, function logs `origin not registered` |

### 4. The dashboard's backend endpoint

The only code you write. Node shown; any language with HMAC-SHA256 works. The
signing is verified byte-identical between Node's `crypto` and the function's
WebCrypto, including Unicode names and emoji.

```js
app.get('/api/dek-token', requireLogin, async (req, res) => {
  // The exact STRING is what gets signed and what gets sent. Do not sign an
  // object and re-serialise it: key order is not guaranteed to survive a round
  // trip through a different runtime, and the signature then fails for reasons
  // nothing will explain.
  const payload = JSON.stringify({
    key: 'tech-dashboard',
    sub: req.user.id,               // YOUR stable id for this person
    email: req.user.email,          // display only, never a credential
    name: req.user.name,
    ts: Date.now(),
    origin: 'https://dash.yourcompany.com',
  });
  const signature = crypto.createHmac('sha256', process.env.SOOP_SECRET)
    .update(payload).digest('hex');

  const r = await fetch(process.env.SOOP_URL + '/functions/v1/soop-handoff/mint', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload, signature }),
  });
  res.json(await r.json());          // { handoff: '...', expires_in: 60 }
});
```

The page's `auth` callback returns that object unchanged. The browser spends the
ticket; the secret never leaves your server.

### Why identity is namespaced

The Dek account is keyed on `<sub>@<key>.embed.dek.invalid`, not on the real
email. Supabase auto-links identities that share a verified email and there is no
documented way to switch that off, so a dashboard asserting somebody else's
address would otherwise land inside their account. Namespacing contains a leaked
secret to the one organisation that key belongs to. `.invalid` is reserved by RFC
2606 and can never receive mail, which is the point: no password reset can ever
be delivered to a shadow address. The real email lives on the profile, where it
is a label rather than a credential.

## Still not done

- **Deprovisioning.** Removing somebody from the dashboard does not remove them
  from the Space. There is no SCIM and no reconcile job.
- **Role mapping.** Everybody provisioned this way lands as a plain member. Host
  roles are not mapped onto Dek's permission bitfield.
- **One server per dashboard, not per customer.** `ensure_embed_space` keys on the
  host key alone, which is the right shape for dashboards built for one
  organisation. If these are ever sold to more than one, the key needs a tenant
  component and existing rows need migrating.
- **Nothing here has been run against a live Supabase project.** The SQL and the
  Edge Function are written and the HMAC protocol is tested locally, but the
  table names were read off the client rather than out of a schema file. Check
  the preflight query at the top of the migration before running it.
