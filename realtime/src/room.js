// One Durable Object per WORKSPACE, holding every member's socket.
//
// WHY PER WORKSPACE AND NOT PER CHANNEL.
//
// Per channel is the shape Cloudflare's own chat demo uses and it is the more
// scalable one, but it multiplies sockets: a member of six channels holds six
// connections, so 500 people become 3,000 sockets and every reconnect wakes
// six objects instead of one.
//
// The free tier's binding limit is DURATION, not connections. 13,000 GB-s/day
// divided by 0.128 GB per object-second is 101,562 object-seconds, and a wake
// is charged up to a ~10s idle tail. That is ~10,000 wake events a day in
// total. Per channel, 2,500 sockets share that budget: under three reconnects
// per socket per day before it breaches, which phones on Indian mobile
// networks will exceed without trying. Per workspace, 500 sockets get roughly
// fourteen reconnects each. That margin is the whole reason for this choice.
//
// The cost is that fan-out filters by channel in process rather than being
// addressed by topic. That is one Map lookup, and outgoing sends are free.
//
// WHAT MUST NEVER APPEAR IN THIS FILE. Each one pins the object awake and
// turns ~0 into 11,059 GB-s/day - 85% of the whole daily budget - per object:
//   - ws.accept()            use state.acceptWebSocket() instead
//   - setInterval / setTimeout with anything still pending
//   - an in-flight fetch()
//   - an outbound WebSocket
// There is deliberately no presence sweep and no alarm here for that reason.

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Rebuilt lazily rather than in the constructor. After a hibernation wake
    // the constructor runs again, and doing the deserialize loop there would
    // pay for every socket on every wake, even when the wake is a publish to
    // one channel.
    this.byChannel = null;
  }

  // channel id -> Set<WebSocket>, reconstructed from the sockets themselves.
  // The attachments ARE the state; this object holds nothing that has to
  // survive eviction, which is what makes hibernation free.
  index() {
    if (this.byChannel) return this.byChannel;
    const map = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = safeAttachment(ws);
      if (!a) continue;
      for (const c of a.chans || []) {
        let set = map.get(c);
        if (!set) { set = new Set(); map.set(c, set); }
        set.add(ws);
      }
    }
    this.byChannel = map;
    return map;
  }

  async fetch(req) {
    const url = new URL(req.url);

    // ---- publish: Postgres (via pg_net) or an Edge Function calls this ----
    if (url.pathname.endsWith('/publish')) {
      const body = await req.json().catch(() => null);
      if (!body || !body.topic) return json({ error: 'bad_body' }, 400);
      const sent = this.broadcast(body.topic, body.event || 'msg', body.payload ?? {},
                                  body.except || null);
      return json({ ok: true, sent });
    }

    // ---- revocation ----
    // Access is resolved once, at connect, so a live socket outlives a change
    // to who may hear what. This is how that change takes effect now instead
    // of at the next reconnect: find the person's sockets by their `u:<uid>`
    // tag and close them. The client reconnects, and the reconnect re-runs the
    // RLS query, so the new answer is the one that sticks.
    if (url.pathname.endsWith('/kick')) {
      const body = await req.json().catch(() => null);
      if (!body?.user) return json({ error: 'bad_body' }, 400);
      let closed = 0;
      for (const ws of this.ctx.getWebSockets(`u:${body.user}`)) {
        try { ws.close(4003, body.reason || 'access_changed'); closed++; } catch { /* already gone */ }
      }
      this.byChannel = null;
      return json({ ok: true, closed });
    }

    // ---- a member connecting ----
    if (url.pathname.endsWith('/connect')) {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_ws' }, 426);

      // The Worker already verified the JWT and resolved what this person is
      // allowed to hear; it arrives as headers the Worker set itself. This
      // object is not reachable from the internet except through that Worker.
      const uid = req.headers.get('x-dek-uid');
      const exp = Number(req.headers.get('x-dek-exp') || 0);
      let chans = [];
      try { chans = JSON.parse(req.headers.get('x-dek-chans') || '[]'); } catch { chans = []; }
      if (!uid) return json({ error: 'no_identity' }, 401);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // THE line that makes this cheap. acceptWebSocket (not server.accept())
      // hands the socket to the runtime, so this object can be evicted from
      // memory while the connection stays open and duration stops being
      // billed. One tag, `u:<uid>`, so somebody's sockets can be found when
      // their access changes. Channel membership rides in the attachment
      // instead, because the tag limit is 10 and people are in more channels
      // than that.
      this.ctx.acceptWebSocket(server, [`u:${uid}`]);
      server.serializeAttachment({ uid, chans, exp });

      // Answer the client's keepalive without waking anything. The runtime
      // matches this before the object is resumed, so a heartbeat costs
      // nothing - which matters when 500 sockets each send one every 25s.
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'),
      );

      this.byChannel = null;   // roster changed; rebuild on next use
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'not_found' }, 404);
  }

  broadcast(topic, event, payload, except) {
    const subs = this.index().get(topic);
    if (!subs || subs.size === 0) return 0;
    const frame = JSON.stringify({ topic, event, payload });
    let sent = 0;
    for (const ws of subs) {
      if (except && safeAttachment(ws)?.uid === except) continue;
      // Outgoing messages are not billed, so fan-out is the cheap direction.
      try { ws.send(frame); sent++; } catch { /* closing; webSocketClose cleans up */ }
    }
    return sent;
  }

  // ---- socket lifecycle (hibernation handlers) ----

  async webSocketMessage(ws, raw) {
    const a = safeAttachment(ws);
    if (!a) { ws.close(1011, 'no_attachment'); return; }

    // Expiry is checked HERE, lazily, because a timer would forbid
    // hibernation. Supabase drops a socket whose JWT has expired; nothing on
    // Cloudflare does that for us, so a connection could otherwise outlive the
    // authorization that opened it. The cost of checking on the next message
    // is that an idle expired socket lingers until it speaks - acceptable,
    // because an idle socket cannot read anything it was not already sent.
    if (a.exp && a.exp * 1000 < Date.now()) { ws.close(4001, 'token_expired'); return; }

    let m = null;
    try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); }
    catch { return; }
    if (!m || typeof m !== 'object') return;

    // Typing is the only thing clients may originate. Everything else in Dek
    // is written to Postgres first and published from there, so there is no
    // path here for a client to fabricate a message.
    if (m.t === 'typing' && typeof m.channel === 'string') {
      if (!(a.chans || []).includes(m.channel)) return;   // not yours to type in
      this.broadcast(m.channel, 'typing', { user_id: a.uid, at: Date.now() }, a.uid);
      return;
    }

    // Re-declaring what you are listening to, after opening a channel.
    if (m.t === 'sub' && Array.isArray(m.chans)) {
      const next = m.chans.filter((c) => typeof c === 'string').slice(0, 500);
      // Only ever a NARROWING or a restatement of what the Worker already
      // authorized at connect. A client cannot add a channel it was not
      // granted; that needs a reconnect, which re-runs the RLS check.
      const granted = new Set(a.chans || []);
      ws.serializeAttachment({ ...a, chans: next.filter((c) => granted.has(c)) });
      this.byChannel = null;
    }
  }

  async webSocketClose() { this.byChannel = null; }
  async webSocketError() { this.byChannel = null; }
}

function safeAttachment(ws) {
  try { return ws.deserializeAttachment(); } catch { return null; }
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json' },
  });
}
