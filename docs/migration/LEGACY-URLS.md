# Legacy Dek link formats (for redirects in the new client)

Read from the legacy client `dek-legacy/js` (router `main.js` `route()`, lines 40-60) and the
live legacy push payload builder `app.notification_content`, 2026-10-03. The legacy app
was served from the same origin as the new one (`https://dek-7o4.pages.dev/`), and every
route lives in the URL **fragment** (`#/...`), so old links, bookmarks, home screen
shortcuts and notifications already on people's devices all arrive at the new client's
`index.html` with the old fragment intact. The new client must read `location.hash` once
on boot, translate it with the table below, then `history.replaceState` it away (as the
legacy router did).

Ids: the migration keeps every legacy id (`docs/migration/PLAN-RUN.md` section 2), so a
channel, conversation, user or workspace id in an old link is the new id, with two
exceptions listed under `#/d/`. The full old-to-new map, including the legacy seq of every
message, is `dek_migration.id_map` (lead-readable only).

## Routes

Matched in this order by the legacy router (first match wins). `<uuid>` is
`[0-9a-f-]{36}`, case-insensitive.

| legacy pattern (exact regex) | what it opened | produced by | new target |
|---|---|---|---|
| `#\/join-org\/([^/?#]+)` | redeem an **organization** invite | org invite links (`features/orgshare.js:51`: `<origin><path>#/join-org/<token>`) | invite flow with that token as the code. Token = 32 lowercase hex chars (`gen_random_uuid()` without dashes). |
| `#\/join\/([^/?#]+)` | redeem a **workspace (server)** invite | workspace invite links (`core/workspace.js:1063`, `features/admin.js:78`: `<origin><path>#/join/<token>`) | invite flow with that token as the code. Token = 24 chars of base64url (`[A-Za-z0-9_-]`, 18 random bytes). |
| `#\/m\/([0-9a-f-]{36})\/(\d+)` | open channel `<1>` and jump to the message whose **legacy** channel seq is `<2>` | "copy link" on a message (`core/actions.js:121`), in-app notifications (`features/notifications.js:154`), embed host `postMessage` (`embed.js:289`) | the message with `channel_id = <1>` and `meta.legacy.seq = <2>`. Seqs were renumbered, so the number in the link is NOT the new seq. If that message is a thread reply, open its root's thread (`thread_root_id`). |
| `#\/c\/([0-9a-f-]{36})` | open channel | "copy channel link" (`core/channels.js:403`); push for channel messages and "added to channel" (`./#/c/<channel>`); embed `?channel=` | channel `<1>` (same id). |
| `#\/d\/([0-9a-f-]{36})` | open the DM conversation | push for DMs (`./#/d/<conversation>`, legacy migration 0124) | DM channel with id `<1>`. Two conversations were merged into an older one of the same pair; their old ids open the kept channel: `01a0e7cc-80f1-74af-9a46-7c4f35e3a49c` -> `01a0ae59-ff4c-72da-abf5-d55672599f7c`, `01a0debb-ec36-7c3b-8fc6-7b92dcec9b60` -> `01a0deb4-beae-7156-86b1-88b425605dc2`. |
| `^#\/threads` | threads list | PWA manifest shortcut `./#/threads` | threads view |
| `^#\/search` | search | PWA manifest shortcut `./#/search` | search |
| `^#\/leave` | leave panel | push for leave requests and decisions (`./#/leave`) | leave was removed from Dek (Arc owns it): open the app home. |

Handled outside `route()` by feature modules:

| legacy pattern | what it opened | produced by | new target |
|---|---|---|---|
| `^#\/admin(?:\/([a-z]+))?` | org admin console, optional section | `features/orgadmin.js` (`#/admin`, `#/admin/<section>`); push for a join request (`./#/admin/requests`) | org admin; `requests` -> join requests list. |
| `^#\/u\/([0-9a-f-]{36})` | profile page of a user | `features/profilepage.js` | that profile (same id). |
| `^#\/snippet\/([0-9a-f-]{36})$` | a snippet | `features/snippets.js` | removed feature: app home. |
| `#/s/<workspace>` | (no route in legacy; opened the app root) | push "join request approved" (`./#/s/<workspace>`) | that server (same id). |
| `./`, `./?source=pwa` | app root | everything else, PWA `start_url` | app home. |

## Query parameters (embed mode)

`?embed=1&host=<origin>&space=<id or name>&channel=<id or name>&chrome=minimal|full&theme=<look>`
(`embed.js:499-535`). `space` matched a workspace by id, then name, then name with
non-alphanumerics removed; `channel` by id, then name. Embedding refused unless `host` is
on `EMBED_ORIGINS`. If the new client keeps an embed mode, `space` -> server id (same id)
and `channel` -> channel id (same id).

## Fragments that are not routes

Supabase auth callbacks to the **legacy** project: `#access_token=...&type=...`,
`#error=...&error_description=...`, `?code=...` (`core/auth.js:47-56`). They belong to the
legacy project's auth and mean nothing to the new one: clear them and show sign in.

## Notifications already on devices

The legacy service worker stored the payload in `notification.data` and opened
`data.url` on tap (`sw.js:478-490`), focusing an existing window and navigating it. Those
URLs are relative (`./#/c/<id>`, `./#/d/<id>`, `./#/leave`, `./#/admin/requests`,
`./#/s/<id>`, `./`), so after cutover a tap on an old notification loads the new client with
the fragment above. Legacy tags: `dek-msg-<channel>` (service worker default),
`ch:<channel>`, `dm:<conversation>`, `chadd:<channel>`, `joinreq:<request>`,
`joinok:<workspace>`, `leave:<id>`.

## Client state on the same origin

The new client inherits the legacy client's storage on `dek-7o4.pages.dev`:

| key | holds | use at cutover |
|---|---|---|
| localStorage `sb-ybddogqphinruyunnuwx-auth-token` | the legacy supabase-js session (`refresh_token`, `access_token`, `user`) | exchange `refresh_token` once at the NEW project (`auth.refreshSession({ refresh_token })`): sessions and non-revoked refresh tokens are copied, so this signs the person in without a password (proved by `--prove-auth`). A token refreshed in legacy after the final `--apply` is unknown to the new project: fall back to sign in. Delete the key afterwards. |
| IndexedDB `Dek-outbox` store `sends` (fallback localStorage `Dek.outbox.v1`) | messages queued but not yet confirmed, keyed by `nonce` = legacy `client_msg_id` | safe to replay through `send_message` with `p_client_id = nonce` (DM: the conversation id, or the kept id above): a message legacy had already stored was migrated with that `client_id`, so the replay returns it instead of duplicating it. |
| localStorage `Dek.drafts.v1` | unsent composer drafts by scope | optional: restore into the new drafts by channel id. |
| localStorage `dak.pendingInvite` | `{ token, at }`, an invite clicked before sign-in (30 minute TTL) | redeem through the new invite flow if still fresh. |
| localStorage `dak.lastChannel` | `{ uid, byWs: { <workspace>: <channel> } }` last channel per server (an older shape is `{ uid, id, name }`) | optional: open the same channel (ids unchanged). |
| localStorage `dak.look`, `dak.mode` | theme | optional. |
