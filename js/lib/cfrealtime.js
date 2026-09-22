// The Cloudflare realtime transport, shaped to be a drop-in for js/sb.js.
//
// Supabase Realtime caps a Free project at 200 concurrent connections. This
// speaks to the Worker at dek-realtime instead. It deliberately presents the
// SAME contract js/sb.js already offers - subscribe(key, topic, handlers,
// opts), unsubscribe(key), the same bus events - so not one call site changes.
// The topic strings the app already uses are translated here and nowhere else.
//
// TWO SOCKETS, MAPPED FROM SIX TOPIC PREFIXES:
//
//   ws:<workspaceId>   -> SPACE socket, topic <workspaceId>
//   ch:<channelId>     -> SPACE socket, topic <channelId>
//   typ:<channelId>    -> SPACE socket, topic <channelId>   (event 'typing')
//   vc:<channelId>     -> SPACE socket, topic <channelId>   (voice events)
//   user:<userId>      -> INBOX socket, topic <userId>
//   dm:<conversation>  -> INBOX socket, topic <conversation>
//
// ch: and typ: land on the same room and topic on purpose - they always
// referred to the same channel, and Supabase only split them because a topic
// was the unit of subscription there. Here the unit is the room and the event
// name does the separating. Several registrations can share one topic; a frame
// is delivered to every registration that asked for that event on it.
import { bus } from '../store.js';
import { CF_REALTIME_URL } from '../config.js';

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000, 30000];
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));
// Cloudflare answers this without waking the Durable Object, so a keepalive
// from every client costs nothing. Anything much longer risks an idle
// middlebox dropping the connection silently.
const PING_MS = 25000;

// key -> { sock, topic, rawTopic, handlers, opts }
const regs = new Map();
const socks = {
  space: { ws: null, timer: null, attempts: 0, ping: null, open: false, everOpen: false },
  inbox: { ws: null, timer: null, attempts: 0, ping: null, open: false, everOpen: false },
};

let getToken = async () => null;
let currentWorkspace = null;
let failuresInARow = 0;
let disabled = false;

// After this many consecutive failures to open, stop trying and let the app
// fall back to Supabase. A transport that cannot connect must not take the app
// down with it: the old, capped, slower path beats no path.
const GIVE_UP_AFTER = 4;

export function configure({ tokenFn }) { getToken = tokenFn; }
export function isDisabled() { return disabled; }

// ---------------------------------------------------------------- mapping
function route(topic) {
  const i = topic.indexOf(':');
  if (i < 0) return null;
  const kind = topic.slice(0, i);
  const id = topic.slice(i + 1);
  switch (kind) {
    case 'ws': return { sock: 'space', topic: id, workspace: id };
    case 'ch': case 'typ': case 'vc': return { sock: 'space', topic: id };
    case 'user': case 'dm': return { sock: 'inbox', topic: id };
    default: return null;
  }
}

// ---------------------------------------------------------------- sockets
function urlFor(which, token) {
  const base = CF_REALTIME_URL.replace(/^http/, 'ws');
  return which === 'inbox'
    ? `${base}/connect/inbox?token=${encodeURIComponent(token)}`
    : `${base}/connect?ws=${encodeURIComponent(currentWorkspace || '')}&token=${encodeURIComponent(token)}`;
}

function announce(which) {
  const s = socks[which];
  if (!s.open || !s.ws) return;
  const topics = [...regs.values()].filter((r) => r.sock === which).map((r) => r.topic);
  try { s.ws.send(JSON.stringify({ t: 'sub', chans: [...new Set(topics)] })); } catch { /* closing */ }
}

async function openSock(which) {
  const s = socks[which];
  if (disabled || s.ws || s.timer) return;
  if (which === 'space' && !currentWorkspace) return;

  const token = await getToken();
  if (!token) { scheduleReopen(which); return; }

  let ws;
  try { ws = new WebSocket(urlFor(which, token)); } catch { scheduleReopen(which); return; }
  s.ws = ws;

  ws.onopen = () => {
    s.open = true;
    s.attempts = 0;
    failuresInARow = 0;
    // Re-declare what this socket listens to. The Worker granted a set at
    // connect and will only ever narrow it, so this cannot widen access.
    announce(which);
    // No timers on the server side; this one is on the CLIENT, where they are
    // free and hibernation is not a concept.
    clearInterval(s.ping);
    s.ping = setInterval(() => {
      try { ws.send('{"t":"ping"}'); } catch { /* closing */ }
    }, PING_MS);
    for (const [key, r] of regs) {
      if (r.sock !== which) continue;
      // opts.onStatus is how js/core/channels.js emits 'channel:subscribed',
      // which is the rebind trigger for ackloop, polls, forms, labels,
      // orientation and tasks. Without it those six go dead after the first
      // reconnect with nothing in the console.
      try { r.opts.onStatus?.('SUBSCRIBED', null); } catch (e) { console.error('onStatus', e); }
      bus.emit('realtime:status', { key, topic: r.rawTopic, status: 'SUBSCRIBED', error: null });
      bus.emit('realtime:subscribed', { key, topic: r.rawTopic, rejoined: s.everOpen });
    }
    s.everOpen = true;
  };

  ws.onmessage = (e) => {
    let f = null;
    try { f = JSON.parse(e.data); } catch { return; }
    if (!f || f.t === 'pong') return;
    dispatch(which, f);
  };

  const down = () => {
    clearInterval(s.ping); s.ping = null;
    const wasOpen = s.open;
    s.open = false;
    s.ws = null;
    for (const [key, r] of regs) {
      if (r.sock !== which) continue;
      try { r.opts.onStatus?.('CLOSED', null); } catch (e) { console.error('onStatus', e); }
      if (wasOpen) bus.emit('realtime:down', { key, topic: r.rawTopic, status: 'CLOSED' });
      bus.emit('realtime:status', { key, topic: r.rawTopic, status: 'CLOSED', error: null });
    }
    if (!wasOpen) {
      // Never opened: a dead Worker, a refused token, or no access.
      failuresInARow++;
      if (failuresInARow >= GIVE_UP_AFTER) {
        disabled = true;
        // Loud on purpose. A silent downgrade is how you find out months later
        // that nobody was ever on the new transport.
        console.warn('[dek] cloudflare realtime unreachable; falling back to supabase');
        bus.emit('realtime:transport', { transport: 'supabase', reason: 'cf_unreachable' });
        return;
      }
    }
    scheduleReopen(which);
  };
  ws.onclose = down;
  ws.onerror = down;
}

function scheduleReopen(which) {
  const s = socks[which];
  if (disabled || s.timer) return;
  const wait = jitter(BACKOFF[Math.min(s.attempts, BACKOFF.length - 1)]);
  s.attempts++;
  s.timer = setTimeout(() => { s.timer = null; openSock(which); }, wait);
}

function closeSock(which) {
  const s = socks[which];
  clearTimeout(s.timer); s.timer = null;
  clearInterval(s.ping); s.ping = null;
  const ws = s.ws;
  s.ws = null; s.open = false;
  try { ws?.close(1000, 'replaced'); } catch { /* already gone */ }
}

// A frame goes to EVERY registration on that topic that asked for that event.
// ch: and typ: share a topic, so this is the normal case rather than an edge.
function dispatch(which, f) {
  for (const r of regs.values()) {
    if (r.sock !== which || r.topic !== f.topic) continue;
    // `handlers` came from subscribe(); `extra` came from a later
    // ch.on('broadcast', ...) - nine feature modules bind that way and would
    // otherwise be silently dead.
    const fn = r.handlers[f.event] || r.extra[f.event];
    if (!fn) continue;
    // `self:false` means "not my own echo". The server honours it through
    // `except`, but a second tab of the same account would still see its own,
    // so it is enforced on both sides.
    if (r.opts.self === false && f.payload?.user_id && f.payload.user_id === r.opts.uid) continue;
    try { fn(f.payload); } catch (e) { console.error('cf realtime handler', f.event, e); }
  }
}

// ------------------------------------------------------------ the contract
export function subscribe(key, topic, handlers, opts = {}) {
  const r = route(topic);
  if (!r) return null;                       // unknown prefix: caller falls back
  unsubscribe(key);
  if (r.workspace) setWorkspace(r.workspace);
  const shim = makeShim(key, r.sock, r.topic);
  regs.set(key, { ...r, rawTopic: topic, handlers, opts, extra: {}, shim });

  const s = socks[r.sock];
  if (s.open) {
    announce(r.sock);                        // already connected: widen the forward list
    bus.emit('realtime:subscribed', { key, topic, rejoined: false });
  } else {
    // Jitter the FIRST open too, not only the retry. Five hundred clients
    // reconnecting the instant a Worker deploys is the one way to breach the
    // join-rate limit, and only the retry path jittered before.
    setTimeout(() => openSock(r.sock), Math.random() * 1200);
  }
  return shim;
}

// WHAT subscribe() HANDS BACK, and why it is not a plain object.
//
// Nine feature modules do not pass their handlers to subscribe(). They take
// the returned channel and call .on('broadcast', {event}, cb) on it later -
// ackloop, polls, forms, labels, orientation, tasks, and events. Two more
// SEND through it: composer.js broadcasts typing as
// getSub('typing').send({type:'broadcast', event:'typing', payload}), and
// voice.js broadcasts WebRTC signals the same way.
//
// So the return value has to walk and talk like a Supabase RealtimeChannel or
// seven features go dead and voice never connects, with nothing in the console
// to say why. Note the envelope: .on() callbacks are handed {payload}, not the
// bare payload, because that is what the existing call sites destructure.
function makeShim(key, sock, topic) {
  return {
    topic,
    get state() { return socks[sock].open ? 'joined' : 'closed'; },
    on(type, opts, cb) {
      if (type === 'broadcast' && opts?.event) {
        const r = regs.get(key);
        if (r) r.extra[opts.event] = (payload) => cb({ payload });
      }
      return this;                       // chainable, like the real thing
    },
    subscribe(cb) {
      // Supabase calls this back with a status. Anything already connected is
      // reported immediately so a late binder is not left waiting forever.
      if (typeof cb === 'function') setTimeout(() => cb(socks[sock].open ? 'SUBSCRIBED' : 'JOINING'), 0);
      return this;
    },
    send(msg) {
      const s = socks[sock];
      if (!s.open || !s.ws) return Promise.resolve('error');
      if (msg?.type !== 'broadcast' || !msg.event) return Promise.resolve('error');
      try {
        s.ws.send(JSON.stringify({
          t: 'pub', topic, event: msg.event, payload: msg.payload || {},
          // The server enforces this too, but a second tab of the same account
          // would otherwise see its own typing.
          self: regs.get(key)?.opts.self,
        }));
        return Promise.resolve('ok');
      } catch { return Promise.resolve('error'); }
    },
  };
}

export function unsubscribe(key) {
  const had = regs.delete(key);
  // Sockets are NOT closed when their last registration goes. A space socket
  // survives a channel switch, which is the common case, and closing it would
  // turn every channel open into a reconnect - the one meter that can actually
  // breach the free tier.
  if (had) announce('space'), announce('inbox');
}

export function setWorkspace(id) {
  if (id === currentWorkspace) return;
  currentWorkspace = id;
  // The space socket is bound to one workspace at connect, because that is
  // what the Worker asked Postgres about. Changing servers means a new socket,
  // which is also why being in twelve servers still costs one.
  closeSock('space');
  socks.space.attempts = 0;
  if (id && !disabled) setTimeout(() => openSock('space'), Math.random() * 400);
}

// Supabase rotates the access token roughly hourly. The socket carries the old
// token's expiry and the Worker closes it lazily on the next message; better to
// replace it before that than to discover it by going deaf.
export function reauth() {
  for (const which of ['space', 'inbox']) {
    const s = socks[which];
    if (s.ws || s.timer) { closeSock(which); s.attempts = 0; openSock(which); }
  }
}

export function startInbox() {
  if (!disabled) setTimeout(() => openSock('inbox'), Math.random() * 1200);
}

export function stopAll() {
  closeSock('space'); closeSock('inbox');
  regs.clear();
  currentWorkspace = null;
  socks.space.everOpen = false;
  socks.inbox.everOpen = false;
}

export function sendTyping(channelId) {
  const s = socks.space;
  if (!s.open || !s.ws) return false;
  try { s.ws.send(JSON.stringify({ t: 'typing', channel: channelId })); return true; }
  catch { return false; }
}

// getSub(key) in js/sb.js must hand back the SAME object subscribe() returned,
// because the late binders keep a WeakSet of what they have already bound to.
export function getShim(key) { return regs.get(key)?.shim || null; }

export function status() {
  return {
    disabled,
    space: { open: socks.space.open, attempts: socks.space.attempts },
    inbox: { open: socks.inbox.open, attempts: socks.inbox.attempts },
    registrations: regs.size,
  };
}
