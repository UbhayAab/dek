// The browser wiring of the call engine: the contract's RPC wrappers, the realtime
// hub for signaling, the `turn` function for ICE servers, store.calls (filled by
// the platform builder from call.ring and call.upd) for the roster, and a
// keepalive leave when the page goes away.
import { supabase } from '../../api/client';
import { api } from '../../api/rpc';
import type { Call } from '../../api/types';
import { config } from '../../config';
import { hub } from '../../realtime/hub';
import type { CallSignal } from '../../realtime/types';
import { getState, useDek } from '../../store';
import { toast } from '../../ui/kit';
import { invokeFunction } from '../media/transfer';
import { canShareScreen, listDevices, openMedia } from './devices';
import { CallEngine, type SignalTransport } from './engine';
import { IceProvider } from './ice';
import { SpeakingMeter } from './meter';
import { SfuError, type SfuAction, type SfuReply } from './sfu';

// ------------------------------------------------------------------ transport

let transport: SignalTransport = hub;

// Tests and diagnostics can route signaling elsewhere (the e2e page uses this only
// when the realtime hub is not available yet).
export function setCallTransport(t: SignalTransport | null): void {
  transport = t ?? hub;
}

// The hub sends a broadcast only once its call:<id> topic is joined and drops it
// before that (realtime/hub.ts leaderSend: best effort). A dropped offer is a
// call that never connects, so signals wait here until the topic is joined: the
// leader tab knows (debug().joined); a follower tab relays through the leader and
// cannot see it, so it waits a moment. Offers are also retransmitted (link.ts).
const READY_POLL_MS = 100;
const READY_MAX_MS = 8000;
const FOLLOWER_SETTLE_MS = 1200;
const MAX_QUEUED = 300;

const joinedAt = new Map<string, number>();
const queued = new Map<string, CallSignal[]>();
const polls = new Map<string, ReturnType<typeof setInterval>>();

function topicReady(callId: string): boolean {
  if (transport !== hub) return true;
  const since = joinedAt.get(callId);
  if (since === undefined) return false;
  if (Date.now() - since > READY_MAX_MS) return true;   // waited long enough: try anyway
  try {
    if (hub.isLeader()) return hub.debug().joined.includes(`call:${callId}`);
  } catch {
    // an older hub without debug(): fall through to the timed wait
  }
  return Date.now() - since > FOLLOWER_SETTLE_MS;
}

function flushQueued(callId: string): void {
  const q = queued.get(callId);
  queued.delete(callId);
  const t = polls.get(callId);
  if (t) clearInterval(t);
  polls.delete(callId);
  for (const s of q ?? []) transport.sendSignal(callId, s);
}

const delegatingTransport: SignalTransport = {
  joinCall: (id) => {
    joinedAt.set(id, Date.now());
    transport.joinCall(id);
  },
  leaveCall: (id) => {
    // A goodbye still queued goes out if it can; the rest is moot.
    const q = queued.get(id)?.filter((s) => s.kind === 'bye') ?? [];
    queued.delete(id);
    const t = polls.get(id);
    if (t) clearInterval(t);
    polls.delete(id);
    if (q.length && topicReady(id)) for (const s of q) transport.sendSignal(id, s);
    joinedAt.delete(id);
    transport.leaveCall(id);
  },
  sendSignal: (id, s) => {
    if (topicReady(id) && !queued.has(id)) {
      transport.sendSignal(id, s);
      return;
    }
    const q = queued.get(id) ?? [];
    if (q.length < MAX_QUEUED) q.push(s);
    queued.set(id, q);
    if (!polls.has(id)) {
      polls.set(id, setInterval(() => {
        if (!joinedAt.has(id)) {
          queued.delete(id);
          clearInterval(polls.get(id));
          polls.delete(id);
          return;
        }
        if (topicReady(id)) flushQueued(id);
      }, READY_POLL_MS));
    }
  },
  onSignal: (id, h) => transport.onSignal(id, h),
};

// ------------------------------------------------------------------ token for keepalive

// pagehide allows no awaiting, so the leave request needs a token at hand. Kept
// current from the auth client while a call can happen.
let token: string | null = null;
let tokenWatch = false;

function watchToken(): void {
  if (tokenWatch) return;
  tokenWatch = true;
  void supabase().auth.getSession().then(({ data }) => { token = data.session?.access_token ?? null; }).catch(() => undefined);
  supabase().auth.onAuthStateChange((_event, session) => { token = session?.access_token ?? null; });
}

// leave_call through PostgREST with keepalive, so it outlives the page. Same RPC
// as api.leaveCall (supabase-js cannot send keepalive requests).
export function leaveWithKeepalive(callId: string): void {
  if (!token || typeof fetch !== 'function') return;
  try {
    void fetch(`${config.supabaseUrl}/rest/v1/rpc/leave_call`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'api',
        Accept: 'application/json',
      },
      body: JSON.stringify({ p_call: callId }),
    }).catch(() => undefined);
  } catch {
    // the page is going away either way
  }
}

// ------------------------------------------------------------------ ICE

export const iceProvider = new IceProvider(async () => {
  const res = await invokeFunction('turn', {});
  if (!res.ok) throw new Error(`turn: ${res.kind === 'http' ? `HTTP ${res.status}` : res.kind}`);
  return res.data;
});

// Diagnostics switch: force every call through the TURN relay, the way a
// restrictive network would. localStorage 'dek.calls.forceRelay' = '1'.
function forceRelay(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('dek.calls.forceRelay') === '1';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ SFU

// One step of a group call's SFU connection through the sfu Edge Function (CONTRACT
// 5). Refusals come back as SfuError: the HTTP status, the function's error code, and
// for sfu_error Cloudflare's own status and code. A step that hangs gives up after 30 s
// (the steps of one connection queue behind each other).
const SFU_REQUEST_MS = 30_000;

export async function sfuRequest(callId: string, sessionId: string, action: SfuAction, body: Record<string, unknown>): Promise<SfuReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SFU_REQUEST_MS); });
  const res = await Promise.race([invokeFunction('sfu', { ...body, action, call_id: callId, session_id: sessionId }), timeout]);
  clearTimeout(timer);
  if (!res) throw new SfuError(null, 'timeout', 'The media server did not answer in time.');
  if (res.ok) return (res.data && typeof res.data === 'object' ? res.data : {}) as SfuReply;
  if (res.kind !== 'http') throw new SfuError(null, res.kind === 'relay' ? 'unavailable' : 'network');
  const b = res.body;
  const code = typeof b.error === 'string' ? b.error : 'unavailable';
  const message = typeof b.message === 'string' ? b.message : code;
  throw new SfuError(res.status, code, message, typeof b.status === 'number' ? b.status : null, typeof b.code === 'string' ? b.code : null);
}

// ------------------------------------------------------------------ engine

// The last negotiation problems, for a support conversation (no console noise).
const diagnostics: string[] = [];
export function callDiagnostics(): string[] {
  return diagnostics.slice();
}

function activeCallInChannel(channelId: string): Call | undefined {
  return Object.values(getState().calls).find((c) => c.channel_id === channelId && !c.ended_at);
}

export const callEngine = new CallEngine({
  api: {
    startCall: (channel, media) => api.startCall(channel, media),
    answerCall: (call, session) => api.answerCall(call, session),
    declineCall: (call) => api.declineCall(call),
    joinRoom: (channel, session) => api.joinRoom(channel, session),
    leaveCall: (call) => api.leaveCall(call),
    callHeartbeat: (call, session) => api.callHeartbeat(call, session),
    getCall: (call) => api.getCall(call),
  },
  transport: delegatingTransport,
  ice: iceProvider,
  me: () => getState().session.userId,
  serverCall: (id) => getState().calls[id],
  watchServerCall: (id, fn) => useDek.subscribe((s, prev) => {
    const c = s.calls[id];
    if (c && c !== prev.calls[id]) fn(c);
  }),
  activeCallInChannel,
  openMedia: (req) => openMedia(req),
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  ...(canShareScreen() ? { getDisplayMedia: (c: DisplayMediaStreamOptions) => navigator.mediaDevices.getDisplayMedia(c) } : {}),
  createPeerConnection: (cfg) => new RTCPeerConnection(cfg),
  newSession: () => crypto.randomUUID(),
  leaveKeepalive: leaveWithKeepalive,
  onPageHide: (fn) => {
    watchToken();
    window.addEventListener('pagehide', fn);
    return () => window.removeEventListener('pagehide', fn);
  },
  forceRelay,
  listDevices,
  makeMeter: (onChange) => new SpeakingMeter(onChange),
  sfu: sfuRequest,
  createStream: () => new MediaStream(),
  notify: (title, body) => { toast({ kind: 'info', title, body }); },
  log: (message, error) => {
    diagnostics.push(`${new Date().toISOString()} ${message}${error ? `: ${(error as Error)?.message ?? String(error)}` : ''}`);
    if (diagnostics.length > 50) diagnostics.shift();
  },
});

// Signing out (or switching person) ends any call this tab is in.
let lastUser: string | null | undefined;
useDek.subscribe((s) => {
  const user = s.session.status === 'signed_in' ? s.session.userId : null;
  if (lastUser !== undefined && user !== lastUser && callEngine.isLive()) void callEngine.leave();
  if (user) watchToken();
  lastUser = user;
});

if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (callEngine.isLive()) void callEngine.refreshDevices();
  });
}
