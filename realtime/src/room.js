// One Durable Object per ROOM. Two kinds, distinguished only by name:
//
//   ws:<workspaceId>   channels, typing, presence for the server on screen
//   u:<userId>         DMs, mentions, notifications for one person
//
// WHY PER WORKSPACE AND NOT PER CHANNEL. Measured on the live database:
// servers per person median 1, average 1.75, max 12; channels per person
// median 6, max 37. And the client already subscribes to one workspace at a
// time. So per channel is a median of SIX sockets per person and ~3,450 at 500
// users; per workspace is one, and ~500.
//
// That matters because message-driven duration is the same in every topology
// (total messages x the ~10s idle tail). What differs is reconnects, which is
// sockets x churn. At five reconnects per socket per day: per channel is
// 202,500 object-seconds against a 101,562 budget and breaks; per workspace is
// 55,000, which is 54%.
//
// WHAT MUST NEVER APPEAR IN THIS FILE. Each one pins the object awake and
// turns ~0 into 11,059 GB-s/day - 85% of the whole daily budget - per object:
//   - ws.accept()            use state.acceptWebSocket() instead
//   - setInterval / setTimeout with anything still pending
//   - an in-flight fetch()
//   - an outbound WebSocket
// There is deliberately no presence sweep and no alarm here for that reason.
//
// WHERE A SOCKET'S TOPICS LIVE, and why it is not the attachment.
//
// The obvious place is serializeAttachment, and the first cut used it. That
// caps out: the documented limit is 16,384 bytes and a JSON array of UUIDs
// costs ~39 bytes each, so it throws somewhere around 415 channels. Today the
// busiest real person is in 37 - but "leads and HR are in far more" is exactly
// the case this has to hold, and a limit that is fine until one person crosses
// it is the worst kind.
//
// So topics live in the object's SQLite instead, one row per socket, and the
// attachment carries only {uid, exp, sid}. There is no channel ceiling now.
// The index is rebuilt with ONE query covering every socket rather than one
// read per socket, so a hibernation wake costs a single row scan.

const DDL = 'CREATE TABLE IF NOT EXISTS subs (sid TEXT PRIMARY KEY, chans TEXT NOT NULL)';

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.storage.sql.exec(DDL);
    // Rebuilt lazily. After a hibernation wake the constructor runs again, and
    // doing the rebuild here would pay for it even when the wake is a publish
    // to a topic nobody in this room listens to.
    this.byChannel = null;
  }

  // topic -> Set<WebSocket>. The sockets and their SQLite rows ARE the state;
  // this object holds nothing that must survive eviction, which is what makes
  // hibernation free.
  index() {
    if (this.byChannel) return this.byChannel;
    const rows = this.ctx.storage.sql.exec('SELECT sid, chans FROM subs').toArray();
    const bySid = new Map(rows.map((r) => [r.sid, r.chans]));
    const map = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      const a = safeAttachment(ws);
      if (!a?.sid) continue;
      let chans;
      try { chans = JSON.parse(bySid.get(a.sid) || '[]'); } catch { chans = []; }
      for (const c of chans) {
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
    // to who may hear what. This is how that change takes effect now rather
    // than at the next reconnect: find the person's sockets by their `u:<uid>`
    // tag and close them. The reconnect re-runs the RLS query, so the new
    // answer is the one that sticks.
    if (url.pathname.endsWith('/kick')) {
      const body = await req.json().catch(() => null);
      if (!body?.user) return json({ error: 'bad_body' }, 400);
      let closed = 0;
      for (const ws of this.ctx.getWebSockets(`u:${body.user}`)) {
        try { ws.close(4003, body.reason || 'access_changed'); closed++; } catch { /* gone */ }
      }
      this.byChannel = null;
      return json({ ok: true, closed });
    }

    // ---- a member connecting ----
    if (url.pathname.endsWith('/connect')) {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_ws' }, 426);

      // The Worker already verified the JWT and resolved what this person may
      // hear; it arrives as headers the Worker set itself. This object is not
      // reachable from the internet except through that Worker.
      const uid = req.headers.get('x-dek-uid');
      const exp = Number(req.headers.get('x-dek-exp') || 0);
      let chans = [];
      try { chans = JSON.parse(req.headers.get('x-dek-chans') || '[]'); } catch { chans = []; }
      if (!uid) return json({ error: 'no_identity' }, 401);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const sid = crypto.randomUUID();

      // THE line that makes this cheap. acceptWebSocket (not server.accept())
      // hands the socket to the runtime, so this object can be evicted from
      // memory while the connection stays open and duration stops being
      // billed. The `u:<uid>` tag is what /kick looks a person up by.
      this.ctx.acceptWebSocket(server, [`u:${uid}`]);
      server.serializeAttachment({ uid, exp, sid });
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO subs (sid, chans) VALUES (?, ?)', sid, JSON.stringify(chans),
      );

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
      // Outgoing messages are not billed, so fan-out is the free direction.
      try { ws.send(frame); sent++; } catch { /* closing; webSocketClose cleans up */ }
    }
    return sent;
  }

  chansOf(sid) {
    const row = this.ctx.storage.sql.exec('SELECT chans FROM subs WHERE sid = ?', sid).toArray()[0];
    try { return JSON.parse(row?.chans || '[]'); } catch { return []; }
  }

  // ---- socket lifecycle (hibernation handlers) ----

  async webSocketMessage(ws, raw) {
    const a = safeAttachment(ws);
    if (!a?.sid) { ws.close(1011, 'no_attachment'); return; }

    // Expiry is checked HERE, lazily, because a timer would forbid
    // hibernation. Supabase drops a socket whose JWT has expired; nothing on
    // Cloudflare does that for us, so a connection could otherwise outlive the
    // authorization that opened it. Checking on the next message is acceptable
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
      if (!this.chansOf(a.sid).includes(m.channel)) return;   // not yours to type in
      this.broadcast(m.channel, 'typing', { user_id: a.uid, at: Date.now() }, a.uid);
      return;
    }

    // Re-declaring what you are listening to, after opening a channel. Only
    // ever a NARROWING or a restatement of what the Worker already authorized
    // at connect: a client cannot add a topic it was not granted, which needs
    // a reconnect and therefore a fresh RLS check.
    if (m.t === 'sub' && Array.isArray(m.chans)) {
      const granted = new Set(this.chansOf(a.sid));
      const next = m.chans.filter((c) => typeof c === 'string' && granted.has(c));
      this.ctx.storage.sql.exec('UPDATE subs SET chans = ? WHERE sid = ?',
                                JSON.stringify(next), a.sid);
      this.byChannel = null;
    }
  }

  async webSocketClose(ws) { this.forget(ws); }
  async webSocketError(ws) { this.forget(ws); }

  forget(ws) {
    const a = safeAttachment(ws);
    // Rows would otherwise accumulate for the life of the object. SQLite
    // storage on the free plan is 5 GB, so this is hygiene rather than a
    // cliff - but an unbounded table is how the cron log reached 356 MB.
    if (a?.sid) this.ctx.storage.sql.exec('DELETE FROM subs WHERE sid = ?', a.sid);
    this.byChannel = null;
  }
}

function safeAttachment(ws) {
  try { return ws.deserializeAttachment(); } catch { return null; }
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json' },
  });
}
