// Dek realtime on Cloudflare.
//
// Supabase Realtime caps a Free project at 200 concurrent connections, which
// is a hard wall well under the 500 this has to carry. This replaces the
// transport, and only the transport. Postgres stays where it is, and so does
// the decision about who is allowed to hear what.
//
// TWO SOCKETS PER PERSON, ON PURPOSE.
//
//   1. the SPACE socket   -> Room named `ws:<workspaceId>`
//      channels, typing, presence for the server currently on screen.
//      One at a time: the client already subscribes to only the workspace it
//      is looking at, so being a member of twelve servers still costs one
//      socket. Switching servers closes one and opens the next.
//
//   2. the INBOX socket   -> Room named `u:<userId>`
//      DMs, mentions, notifications, claims changes. These are cross-workspace
//      by nature - a DM arrives while you are looking at a different server -
//      so they cannot ride the space socket without a directory of "where is
//      this person connected right now", which is state that has to stay
//      correct across every reconnect. A second socket is the cheaper answer,
//      and this one is nearly always asleep because DMs and mentions are rare
//      next to channel traffic.
//
// Both are the SAME Durable Object class, differing only in name. There is no
// second class and no second migration: Room already fans out by topic, and a
// personal inbox is just a Room whose topics are a user id and their
// conversation ids.
//
// AUTHORIZATION IS STILL POSTGRES. Supabase enforced channel access through
// RLS on realtime.messages, per message. The tempting replacement - a
// membership table cached in the Worker - is how you serve a private channel
// to somebody removed from it an hour ago. So the rule is not reimplemented:
// at connect the Worker asks PostgREST for the caller's topics USING THE
// CALLER'S OWN JWT, and the same RLS policies run in Postgres against the real
// identity. The Worker holds no service key and cannot see more than the
// person it is acting for. It caches the ANSWER for the life of one socket,
// never the rule.

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

const authed = (env, token) => ({
  apikey: env.SUPABASE_PUBLISHABLE, Authorization: `Bearer ${token}`,
});

// Every read here goes through PostgREST with the CALLER'S token, so RLS is
// what answers. A failure must never be read as "allow": it returns null and
// the caller fails closed.
async function topicsForSpace(env, token, workspace) {
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/channels?workspace_id=eq.${encodeURIComponent(workspace)}&select=id`,
      { headers: authed(env, token) },
    );
    if (!r.ok) return null;
    return (await r.json()).map((x) => x.id).filter(Boolean);
  } catch { return null; }
}

async function topicsForInbox(env, token, uid) {
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/conversation_members?user_id=eq.${encodeURIComponent(uid)}&select=conversation_id`,
      { headers: authed(env, token) },
    );
    if (!r.ok) return null;
    const convos = (await r.json()).map((x) => x.conversation_id).filter(Boolean);
    // The user's own id is a topic in its own right: mentions, notifications
    // and claims changes are addressed to the person, not to a conversation.
    return [uid, ...convos];
  } catch { return null; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ch = cors(origin, allowed);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'dek-realtime', rooms: ['ws:<id>', 'u:<id>'] }, 200, ch);
    }

    // ---------------------------------------------------- publish  (servers)
    // Called by Postgres through pg_net and by Edge Functions. Authenticated
    // by a shared secret rather than a JWT, because the caller is a server.
    // `room` is the Durable Object name: `ws:<workspaceId>` or `u:<userId>`.
    if (url.pathname === '/publish' && req.method === 'POST') {
      if (!env.PUBLISH_KEY || req.headers.get('x-dek-key') !== env.PUBLISH_KEY) {
        return json({ error: 'forbidden' }, 403, ch);
      }
      const body = await req.json().catch(() => null);
      // `workspace` is still accepted so the first cut of this API keeps
      // working; `room` is the general form.
      const room = body?.room || (body?.workspace ? `ws:${body.workspace}` : null);
      if (!room || !body?.topic) return json({ error: 'bad_body' }, 400, ch);

      const res = await env.ROOM.get(env.ROOM.idFromName(room)).fetch('https://do/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return new Response(res.body, {
        status: res.status, headers: { ...ch, 'content-type': 'application/json' },
      });
    }

    // ------------------------------------------------------- publish (batch)
    // One request carrying many fan-outs. A mention hits the space room AND
    // every mentioned person's inbox; doing that as N HTTP calls from pg_net
    // would be N round trips inside the transaction that is holding the
    // channel lock. This is the endpoint Postgres should use.
    if (url.pathname === '/publish/batch' && req.method === 'POST') {
      if (!env.PUBLISH_KEY || req.headers.get('x-dek-key') !== env.PUBLISH_KEY) {
        return json({ error: 'forbidden' }, 403, ch);
      }
      const body = await req.json().catch(() => null);
      if (!Array.isArray(body?.sends)) return json({ error: 'bad_body' }, 400, ch);
      const out = await Promise.all(body.sends.slice(0, 200).map(async (s) => {
        const room = s.room || (s.workspace ? `ws:${s.workspace}` : null);
        if (!room || !s.topic) return { error: 'bad_send' };
        try {
          const r = await env.ROOM.get(env.ROOM.idFromName(room)).fetch('https://do/publish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(s),
          });
          return await r.json();
        } catch (e) { return { error: e.message }; }
      }));
      return json({ ok: true, results: out }, 200, ch);
    }

    // ------------------------------------------------------------------ kick
    // The revocation lever. Access is resolved once at connect, so a live
    // socket outlives a change to who may hear what. Closing it forces a
    // reconnect, and the reconnect re-runs the RLS query.
    if (url.pathname === '/kick' && req.method === 'POST') {
      if (!env.PUBLISH_KEY || req.headers.get('x-dek-key') !== env.PUBLISH_KEY) {
        return json({ error: 'forbidden' }, 403, ch);
      }
      const body = await req.json().catch(() => null);
      const room = body?.room || (body?.workspace ? `ws:${body.workspace}` : null);
      if (!room || !body?.user) return json({ error: 'bad_body' }, 400, ch);
      const res = await env.ROOM.get(env.ROOM.idFromName(room)).fetch('https://do/kick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return new Response(res.body, {
        status: res.status, headers: { ...ch, 'content-type': 'application/json' },
      });
    }

    // --------------------------------------------------------------- connect
    const isInbox = url.pathname === '/connect/inbox';
    if (url.pathname === '/connect' || isInbox) {
      // A browser cannot set headers on a WebSocket handshake, so the token
      // rides in the URL. It is short lived and the connection is wss, but
      // this is the weakest point in the design and worth knowing about.
      const token = url.searchParams.get('token') || '';
      const workspace = url.searchParams.get('ws') || '';
      if (!token || (!isInbox && !workspace)) return json({ error: 'missing_params' }, 400, ch);

      // Identity is checked BEFORE the upgrade header, deliberately. A bad
      // token is answered 401 whether or not the caller asked to upgrade;
      // answering 426 first tells an attacker their token was never looked at,
      // and makes the endpoint untestable because undici refuses to send an
      // Upgrade header at all.
      let claims;
      try {
        claims = await verifySupabaseJwt(token, {
          jwksUrl: `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
          issuer: `${env.SUPABASE_URL}/auth/v1`,
        });
      } catch (e) {
        return json({ error: 'unauthorized', why: e.message }, 401, ch);
      }

      const room = isInbox ? `u:${claims.sub}` : `ws:${workspace}`;
      const topics = isInbox
        ? await topicsForInbox(env, token, claims.sub)
        : await topicsForSpace(env, token, workspace);

      // Fail CLOSED. An authorization service that cannot answer must never be
      // read as "allow"; the client falls back to Supabase Realtime.
      if (topics === null) return json({ error: 'authz_unavailable' }, 503, ch);
      // An inbox is always valid - a person always has their own id as a topic
      // even with no conversations. A space with no visible channels means no
      // access to that space.
      if (!isInbox && topics.length === 0) return json({ error: 'no_access' }, 403, ch);

      // Everything above is a real authorization answer and is worth returning
      // to a plain GET. Only the socket itself needs the upgrade.
      if (req.headers.get('Upgrade') !== 'websocket') {
        return json({ ok: true, room, topics: topics.length }, 426, ch);
      }

      return env.ROOM.get(env.ROOM.idFromName(room)).fetch('https://do/connect', {
        headers: {
          Upgrade: 'websocket',
          'x-dek-uid': claims.sub,
          'x-dek-exp': String(claims.exp || 0),
          // 2,000 is deliberately generous. The cap exists so one client
          // cannot make the index unbounded, not to ration topics.
          'x-dek-chans': JSON.stringify(topics.slice(0, 2000)),
        },
      });
    }

    return json({ error: 'not_found' }, 404, ch);
  },
};
