// One load worker: a slice of virtual users (see run.mjs). Reports raw samples once at
// the end over IPC. Every user is a real sign-in on the real project.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { sends: [], signins: [], boots: [], joins: [], deliver: [], reconnect: [], accepted: [], errors: {}, received: 0, joinFailures: 0, sockets: 0 };
const err = (code) => { out.errors[code] = (out.errors[code] ?? 0) + 1; };

async function rpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    err(`${fn}:${error.message || error.code || 'error'}`);
    return null;
  }
  return data;
}

function subscribe(client, topic, onEvent) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ch = client.channel(topic, { config: { private: true } });
    ch.on('broadcast', { event: 'msg.new' }, (m) => onEvent(m.payload));
    let done = false;
    ch.subscribe((status) => {
      if (done) return;
      if (status === 'SUBSCRIBED') { done = true; out.joins.push(Date.now() - t0); resolve(ch); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { done = true; out.joinFailures += 1; err(`join:${status}`); resolve(null); }
    });
    setTimeout(() => { if (!done) { done = true; out.joinFailures += 1; err('join:timeout'); resolve(null); } }, 20_000);
  });
}

async function user(cfg, person, deadline) {
  const client = createClient(cfg.url, cfg.key, {
    db: { schema: 'api' },
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  // Sign in (retrying 429s: every virtual user shares this machine's one IP address).
  let session = null;
  const s0 = Date.now();
  for (let attempt = 0; attempt < 8 && !session; attempt += 1) {
    const { data, error } = await client.auth.signInWithPassword({ email: person.email, password: cfg.password });
    if (error) { err(`signin:${error.status ?? error.message}`); await sleep(1000 * 2 ** attempt + Math.random() * 500); }
    else session = data.session;
  }
  if (!session) return null;
  out.signins.push(Date.now() - s0);
  client.realtime.setAuth(session.access_token);

  const b0 = Date.now();
  const me = await rpc(client, 'me', {});
  const boot = await rpc(client, 'bootstrap', { p_org: cfg.org });
  if (!me || !boot) return null;
  out.boots.push(Date.now() - b0);

  const general = boot.channels.find((c) => c.kind === 'text' && c.name === 'general' && c.member);
  let lastSeq = general?.last_seq ?? 0;
  const onEvent = (p) => {
    const m = p?.message;
    if (!m) return;
    out.received += 1;
    if (m.author_id !== person.id && typeof m.body === 'string' && m.body.startsWith('load ')) {
      const ts = Number(m.body.split(' ')[2]);
      if (ts) out.deliver.push(Date.now() - ts);
    }
    if (m.channel_id === general?.id && m.seq > lastSeq) lastSeq = m.seq;
  };
  const channels = [];
  for (const topic of boot.topics) {
    const ch = await subscribe(client, topic, onEvent);
    if (ch) channels.push(ch);
  }
  out.sockets += 1;
  if (general) await rpc(client, 'list_messages', { p_channel: general.id, p_before_seq: null, p_limit: 50 });

  const state = { client, channels, topics: boot.topics, onEvent, general, person };
  if (cfg.scenario === 'signin') return state;

  let lastRead = Date.now();
  while (Date.now() < deadline && general) {
    if (Math.random() < cfg.ratePerUser) {
      const t = Date.now();
      const id = randomUUID();
      const msg = await rpc(client, 'send_message', {
        p_channel: general.id, p_client_id: id, p_body: `load ${person.i} ${t} ${id}`,
        p_thread_root: null, p_attachment_ids: [], p_also_in_channel: false,
      });
      if (msg) { out.sends.push(Date.now() - t); out.accepted.push(msg.id); }
    }
    if (Date.now() - lastRead > 15_000) {
      lastRead = Date.now();
      await rpc(client, 'mark_read', { p_channel: general.id, p_seq: lastSeq });
    }
    await sleep(1000);
  }
  return state;
}

// DEKA02 second half: every socket drops at once and comes back; measure until every
// topic is joined again and the channel has been synced by cursor.
async function reconnect(state) {
  const t0 = Date.now();
  await state.client.removeAllChannels();
  state.client.realtime.disconnect();
  await sleep(50);
  state.client.realtime.connect();
  const { data } = await state.client.auth.getSession();
  if (data.session) state.client.realtime.setAuth(data.session.access_token);
  for (const topic of state.topics) await subscribe(state.client, topic, state.onEvent);
  if (state.general) {
    await rpc(state.client, 'sync_channel', {
      p_channel: state.general.id, p_after_seq: Math.max(0, (state.general.last_seq ?? 0) - 5),
      p_changed_since: new Date(Date.now() - 60_000).toISOString(), p_min_seq: 0 });
  }
  out.reconnect.push(Date.now() - t0);
}

process.on('message', async (m) => {
  if (m.type !== 'start') return;
  const cfg = m.cfg;
  const deadline = Date.now() + cfg.durationMs;
  const gap = cfg.people.length > 1 ? cfg.rampMs / cfg.people.length : 0;
  const states = await Promise.all(cfg.people.map(async (p, idx) => {
    if (gap) await sleep(idx * gap);
    try { return await user(cfg, p, deadline); } catch (e) { err(`crash:${e.message}`); return null; }
  }));
  if (cfg.scenario === 'reconnect') {
    await sleep(Math.max(0, Math.min(30_000, deadline - Date.now())));
    await Promise.all(states.filter(Boolean).map((s) => reconnect(s).catch((e) => err(`reconnect:${e.message}`))));
    await sleep(10_000);
  }
  if (cfg.scenario === 'signin') await sleep(5_000);
  await Promise.all(states.filter(Boolean).map(async (s) => { try { await s.client.removeAllChannels(); s.client.realtime.disconnect(); } catch { /* closing */ } }));
  process.send({ type: 'result', ...out });
  setTimeout(() => process.exit(0), 500);
});
