// Dek realtime on Cloudflare.
//
// Supabase Realtime caps a Free project at 200 concurrent connections, which
// is a hard wall well under the 500 this has to carry. This replaces the
// transport - and only the transport. Postgres stays exactly where it is, and
// so does the decision about who may hear what.
//
// THE PART WORTH BEING CAREFUL ABOUT IS AUTHORIZATION.
//
// Supabase enforced channel access in Postgres, per message, through RLS on
// realtime.messages. Moving the socket off Supabase means something has to
// answer "is this person allowed in this channel" again, and the tempting
// answer - a membership table cached in the Worker - is how you end up serving
// a private channel to somebody who was removed from it an hour ago.
//
// So this does not re-implement the rule. At connect, the Worker asks
// PostgREST for the caller's channel list USING THE CALLER'S OWN JWT. The same
// RLS policies that guarded realtime.messages run, in Postgres, against the
// real identity. The Worker never holds a service key and cannot see more than
// the person it is acting for. What it caches is the ANSWER, for the life of
// one socket, not the rule.
//
// The honest limitation: revocation waits for a reconnect. Removing somebody
// from a private channel does not drop their live socket by itself. That is
// the one thing Supabase gave for free that this does not, and /kick is the
// deliberate lever for it.

import { verifySupabaseJwt } from './jwt.js';
import { Room } from './room.js';

export { Room };

const cors = (origin, allowed) => {
  // Reflect only an origin we actually published to. `*` would be wrong here:
  // the token rides in the query string of the upgrade, and a permissive
  // policy invites somebody else's page to open sockets as your users.
  const ok = allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? origin : allowed[0] || 'null',
    'access-control-allow-headers': 'content-type,x-dek-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    vary: 'origin',
  };
};

const json = (o, status, headers = {}) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ch = cors(origin, allowed);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });

    // ---------------------------------------------------------------- health
    if (url.pathname === '/health') {
      return json({ ok: true, service: 'dek-realtime' }, 200, ch);
    }

    // --------------------------------------------------------------- publish
    // Called by Postgres through pg_net, and by Edge Functions. Authenticated
    // by a shared secret rather than a JWT, because the caller is a server.
    if (url.pathname === '/publish' && req.method === 'POST') {
      if (!env.PUBLISH_KEY || req.headers.get('x-dek-key') !== env.PUBLISH_KEY) {
        return json({ error: 'forbidden' }, 403, ch);
      }
      const body = await req.json().catch(() => null);
      if (!body?.workspace || !body?.topic) return json({ error: 'bad_body' }, 400, ch);

      const id = env.ROOM.idFromName(body.workspace);
      const res = await env.ROOM.get(id).fetch('https://do/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return new Response(res.body, {
        status: res.status, headers: { ...ch, 'content-type': 'application/json' },
      });
    }

    // ------------------------------------------------------------------ kick
    // The revocation lever. Closing a live socket is the only way to make
    // "removed from a private channel" take effect before the token expires.
    if (url.pathname === '/kick' && req.method === 'POST') {
      if (!env.PUBLISH_KEY || req.headers.get('x-dek-key') !== env.PUBLISH_KEY) {
        return json({ error: 'forbidden' }, 403, ch);
      }
      const body = await req.json().catch(() => null);
      if (!body?.workspace || !body?.user) return json({ error: 'bad_body' }, 400, ch);
      const id = env.ROOM.idFromName(body.workspace);
      const res = await env.ROOM.get(id).fetch('https://do/kick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return new Response(res.body, {
        status: res.status, headers: { ...ch, 'content-type': 'application/json' },
      });
    }

    // --------------------------------------------------------------- connect
    if (url.pathname === '/connect') {
      const workspace = url.searchParams.get('ws') || '';
      // A browser cannot set headers on a WebSocket handshake, so the token
      // has to ride in the URL. It is a short-lived access token and the
      // connection is wss, but this is the weakest point in the design and
      // worth knowing about rather than discovering.
      const token = url.searchParams.get('token') || '';
      if (!workspace || !token) return json({ error: 'missing_params' }, 400, ch);

      // Identity is checked BEFORE the upgrade header, deliberately. A bad
      // token should be answered with 401 whether or not the caller asked to
      // upgrade - answering 426 first tells an attacker their token was never
      // even looked at, and it makes the endpoint untestable with a plain
      // fetch, because undici refuses to send an Upgrade header at all.
      let claims;
      try {
        claims = await verifySupabaseJwt(token, {
          jwksUrl: `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
          issuer: `${env.SUPABASE_URL}/auth/v1`,
        });
      } catch (e) {
        return json({ error: 'unauthorized', why: e.message }, 401, ch);
      }

      // RLS decides. Asked with the caller's own token, so this returns
      // exactly the channels Postgres would have let them read - including
      // private ones they belong to, and nothing else.
      let chans = [];
      try {
        const r = await fetch(
          `${env.SUPABASE_URL}/rest/v1/channels?workspace_id=eq.${encodeURIComponent(workspace)}&select=id`,
          { headers: { apikey: env.SUPABASE_PUBLISHABLE, Authorization: `Bearer ${token}` } },
        );
        if (!r.ok) return json({ error: 'authz_unavailable', status: r.status }, 503, ch);
        chans = (await r.json()).map((row) => row.id).filter(Boolean);
      } catch {
        // Fail CLOSED. An authorization service that cannot answer must never
        // be read as "allow"; the client falls back to Supabase Realtime.
        return json({ error: 'authz_unavailable' }, 503, ch);
      }
      // Membership of the workspace is implied by RLS returning any row for
      // it. No rows means no access, and nothing to listen to.
      if (chans.length === 0) return json({ error: 'no_access' }, 403, ch);

      // Everything above is a real authorization answer and is worth returning
      // to a plain GET. Only the socket itself needs the upgrade.
      if (req.headers.get('Upgrade') !== 'websocket') {
        return json({ ok: true, channels: chans.length }, 426, ch);
      }

      const id = env.ROOM.idFromName(workspace);
      return env.ROOM.get(id).fetch('https://do/connect', {
        headers: {
          Upgrade: 'websocket',
          'x-dek-uid': claims.sub,
          'x-dek-exp': String(claims.exp || 0),
          'x-dek-chans': JSON.stringify(chans.slice(0, 500)),
        },
      });
    }

    return json({ error: 'not_found' }, 404, ch);
  },
};
