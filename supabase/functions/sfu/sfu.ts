// sfu: the request logic of the sfu Edge Function, kept free of Deno, the database and
// the network (index.ts wires those in) so Node can test it:
// supabase/tests/media-sfu-fn.test.mjs. Owner: lead. CONTRACT 5, migration 0914.
//
// Order of every request: validate what it says, then api.svc_sfu_gate (a joined
// participant of an SFU call, with this Dek session; the rate limits), then Cloudflare,
// then api.svc_sfu_publish for whatever this person now publishes.

export type Action = 'session' | 'push' | 'pull' | 'renegotiate' | 'close';
export type CfMethod = 'GET' | 'POST' | 'PUT';

export interface Wanted {
  session: string;
  name: string;
}

export interface GateResult {
  sfu_session: string | null;
  sfu_tracks: string[];
  allowed: Wanted[];
}

export interface Change {
  add?: string[];
  remove?: string[];
  fresh?: boolean;
  // The client connection's number with a new session: an older one cannot replace a newer.
  epoch?: number | null;
}

export interface SfuDeps {
  configured: boolean;
  gate(user: string, callId: string, sessionId: string, action: Action, wanted: Wanted[] | null): Promise<GateResult>;
  publish(user: string, callId: string, sessionId: string, sfuSession: string, change: Change): Promise<unknown>;
  cf(method: CfMethod, path: string, body?: unknown): Promise<Record<string, unknown>>;
}

export class Refusal extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const MAX_SDP = 256 * 1024;
export const MAX_BODY = 600 * 1024;
export const CF_TIMEOUT_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SFU_ID = /^[A-Za-z0-9_-]{8,64}$/;
const NAME = /^(mic|cam|screen)-[a-z0-9]{1,16}$/;
const MID = /^[A-Za-z0-9_-]{1,32}$/;
const ACTIONS = new Set(['session', 'push', 'pull', 'renegotiate', 'close']);
const DB_STATUS: Record<string, number> = {
  invalid_input: 400, auth_required: 401, forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429,
};

const bad = (message: string) => new Refusal(400, 'invalid_input', message);

// A database refusal (dek.err: the code in message, the sentence in hint) as an HTTP one.
export function dbRefusal(error: { message?: string; hint?: string | null } | null | undefined): Refusal {
  const code = error?.message ?? '';
  const status = DB_STATUS[code];
  if (status) return new Refusal(status, code, error?.hint || code);
  return new Refusal(503, 'unavailable', 'Calls cannot reach the database right now. Try again.');
}

// Cloudflare Realtime's API for one app. A refusal from Cloudflare is a 502 sfu_error
// carrying Cloudflare's own code and status (session_error with 410: the SFU session is
// gone); a rejected app token or app id is 503 not_configured. Logs never carry the
// token, an SDP or a session id.
export function cloudflare(fetchImpl: typeof fetch, appId: string, token: string, log?: (m: string) => void,
                           timeoutMs = CF_TIMEOUT_MS): SfuDeps['cf'] {
  const base = `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}`;
  const shape = (path: string) => path.replace(/\/sessions\/(?!new$)[^/]+/, '/sessions/:id');
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      log?.(`cloudflare ${method} ${shape(path)}: unreachable`);
      throw new Refusal(503, 'unavailable', 'The media server could not be reached. Try again.');
    }
    let j: Record<string, unknown> = {};
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
    } catch {
      j = {};
    }
    const code = typeof j.errorCode === 'string' ? j.errorCode : null;
    if (res.ok && !code) return j;
    log?.(`cloudflare ${method} ${shape(path)}: HTTP ${res.status} ${code ?? '-'}`);
    if (res.status === 401 || res.status === 403 || code === 'unauthorized' || code === 'not_found') {
      throw new Refusal(503, 'not_configured', 'Group calls through the media server are not set up yet.');
    }
    const said = typeof j.errorDescription === 'string' ? j.errorDescription.slice(0, 200) : '';
    throw new Refusal(502, 'sfu_error', said || 'The media server refused.', { code, status: res.status });
  };
}

function description(v: unknown, type: 'offer' | 'answer', field: string): { type: 'offer' | 'answer'; sdp: string } {
  const o = v as { type?: unknown; sdp?: unknown } | null;
  if (!o || typeof o !== 'object' || o.type !== type || typeof o.sdp !== 'string' || !o.sdp || o.sdp.length > MAX_SDP) {
    throw bad(`${field}: an ${type} description.`);
  }
  return { type, sdp: o.sdp };
}

function localTracks(v: unknown, min: number): { mid: string; name: string }[] {
  if (v === undefined || v === null) v = [];
  if (!Array.isArray(v) || v.length < min || v.length > 6) throw bad(`tracks: ${min} to 6.`);
  const out = v.map((t) => {
    const o = t as { mid?: unknown; name?: unknown } | null;
    if (!o || typeof o.mid !== 'string' || !MID.test(o.mid) || typeof o.name !== 'string' || !NAME.test(o.name)) {
      throw bad('tracks: { mid, name }, names mic-N, cam-N or screen-N.');
    }
    return { mid: o.mid, name: o.name };
  });
  if (new Set(out.map((t) => t.mid)).size !== out.length || new Set(out.map((t) => t.name)).size !== out.length) {
    throw bad('tracks: each mid and each name once.');
  }
  return out;
}

function remoteTracks(v: unknown): Wanted[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 64) throw bad('tracks: 1 to 64.');
  return v.map((t) => {
    const o = t as { session?: unknown; name?: unknown } | null;
    if (!o || typeof o.session !== 'string' || !SFU_ID.test(o.session) || typeof o.name !== 'string' || !NAME.test(o.name)) {
      throw bad('tracks: { session, name }.');
    }
    return { session: o.session, name: o.name };
  });
}

function midList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 64 || v.some((m) => typeof m !== 'string' || !MID.test(m))) {
    throw bad('mids: 1 to 64.');
  }
  return [...new Set(v as string[])];
}

function nameList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 6 || v.some((n) => typeof n !== 'string' || !NAME.test(n))) {
    throw bad('names: up to 6 of mic-N, cam-N and screen-N.');
  }
  return [...new Set(v as string[])];
}

function sfuSessionOf(b: Record<string, unknown>): string {
  const s = b.sfu_session;
  if (typeof s !== 'string' || !SFU_ID.test(s)) throw bad('sfu_session: required.');
  return s;
}

// The session must be the one recorded for this person (never someone else's).
function own(s: string, gate: GateResult): string {
  if (gate.sfu_session !== s) throw new Refusal(409, 'conflict', 'That media session was replaced. Start a new one.');
  return s;
}

function ready(deps: SfuDeps): void {
  if (!deps.configured) throw new Refusal(503, 'not_configured', 'Group calls through the media server are not set up yet.');
}

// The pushed tracks Cloudflare took: an item for the same mid (or name) without an error.
function taken(result: Record<string, unknown> | null, tracks: { mid: string; name: string }[]): string[] {
  const items = Array.isArray(result?.tracks) ? (result?.tracks as { mid?: unknown; trackName?: unknown; errorCode?: unknown }[]) : [];
  return tracks.filter((t) => items.some((i) => (i.mid === t.mid || i.trackName === t.name) && !i.errorCode)).map((t) => t.name);
}

function sdpOf(result: Record<string, unknown> | null, type: 'offer' | 'answer'): { type: 'offer' | 'answer'; sdp: string } | null {
  const d = result?.sessionDescription as { type?: unknown; sdp?: unknown } | undefined;
  return d && d.type === type && typeof d.sdp === 'string' ? { type, sdp: d.sdp } : null;
}

const listOf = (result: Record<string, unknown> | null) => (Array.isArray(result?.tracks) ? result?.tracks : []);

// SHA-256 both sides, then compare every byte: no early exit on the first difference.
export async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

// action 'revoke', from the database only (dek.sfu_revoke, header x-dek-internal):
// someone left the call or replaced their SFU session, so every track of that session
// stops at Cloudflare, sent or received. A session that is already gone is nothing to do.
export async function revoke(deps: SfuDeps, raw: unknown): Promise<Record<string, unknown>> {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (b.action !== 'revoke') throw bad('action: revoke.');
  const s = sfuSessionOf(b);
  ready(deps);
  let state: Record<string, unknown>;
  try {
    state = await deps.cf('GET', `/sessions/${s}`);
  } catch (e) {
    if (e instanceof Refusal && e.code === 'sfu_error' && [404, 410].includes(Number(e.extra.status))) return { closed: 0 };
    throw e;
  }
  const items = Array.isArray(state.tracks) ? (state.tracks as { mid?: unknown; status?: unknown }[]) : [];
  const mids = [...new Set(items.filter((t) => typeof t.mid === 'string' && t.status !== 'inactive').map((t) => t.mid as string))];
  if (!mids.length) return { closed: 0 };
  await deps.cf('PUT', `/sessions/${s}/tracks/close`, { tracks: mids.map((mid) => ({ mid })), force: true });
  return { closed: mids.length };
}

export async function handle(deps: SfuDeps, user: string, raw: unknown): Promise<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('A JSON object is expected.');
  const b = raw as Record<string, unknown>;
  const action = typeof b.action === 'string' && ACTIONS.has(b.action) ? (b.action as Action) : null;
  if (!action) throw bad('action: session, push, pull, renegotiate or close.');
  const callId = b.call_id;
  const sessionId = b.session_id;
  if (typeof callId !== 'string' || !UUID.test(callId) || typeof sessionId !== 'string' || !UUID.test(sessionId)) {
    throw bad('call_id and session_id: ids.');
  }

  if (action === 'session') {
    // A new SFU session for this person, with the tracks of the offer (none: listening only).
    const tracks = localTracks(b.tracks, 0);
    const offer = tracks.length ? description(b.offer, 'offer', 'offer') : null;
    const epoch = b.epoch === undefined || b.epoch === null ? null : b.epoch;
    if (epoch !== null && (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1)) throw bad('epoch: a positive whole number.');
    await deps.gate(user, callId, sessionId, 'session', null);
    ready(deps);
    const created = await deps.cf('POST', '/sessions/new');
    const sfu = typeof created.sessionId === 'string' ? created.sessionId : '';
    if (!SFU_ID.test(sfu)) throw new Refusal(502, 'sfu_error', 'The media server gave no session.', { code: null, status: null });
    const pushed = offer
      ? await deps.cf('POST', `/sessions/${sfu}/tracks/new`, {
          sessionDescription: offer, tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.name })),
        })
      : null;
    let call: unknown;
    try {
      call = await deps.publish(user, callId, sessionId, sfu, { add: taken(pushed, tracks), fresh: true, epoch });
    } catch (e) {
      // Nobody may pull what was never recorded: stop it at Cloudflare too.
      if (pushed) await deps.cf('PUT', `/sessions/${sfu}/tracks/close`, { tracks: tracks.map((t) => ({ mid: t.mid })), force: true }).catch(() => undefined);
      throw e;
    }
    return { sfu_session: sfu, answer: sdpOf(pushed, 'answer'), tracks: listOf(pushed), call };
  }

  if (action === 'push') {
    const tracks = localTracks(b.tracks, 1);
    const offer = description(b.offer, 'offer', 'offer');
    const s = sfuSessionOf(b);
    const g = await deps.gate(user, callId, sessionId, 'push', null);
    ready(deps);
    own(s, g);
    const r = await deps.cf('POST', `/sessions/${s}/tracks/new`, {
      sessionDescription: offer, tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.name })),
    });
    const ok = taken(r, tracks);
    const call = ok.length ? await deps.publish(user, callId, sessionId, s, { add: ok }) : null;
    return { answer: sdpOf(r, 'answer'), tracks: listOf(r), call };
  }

  if (action === 'pull') {
    // Only what another joined person of this call publishes now (the gate decides).
    const wanted = remoteTracks(b.tracks);
    const s = sfuSessionOf(b);
    const g = await deps.gate(user, callId, sessionId, 'pull', wanted);
    ready(deps);
    own(s, g);
    const key = (w: Wanted) => `${w.session}/${w.name}`;
    const allowed = Array.isArray(g.allowed) ? g.allowed : [];
    const ok = new Set(allowed.map(key));
    const refused = wanted.filter((w) => !ok.has(key(w)));
    if (!allowed.length) return { offer: null, renegotiate: false, tracks: [], refused };
    const r = await deps.cf('POST', `/sessions/${s}/tracks/new`, {
      tracks: allowed.map((w) => ({ location: 'remote', sessionId: w.session, trackName: w.name })),
    });
    const offer = sdpOf(r, 'offer');
    return { offer, renegotiate: !!offer, tracks: listOf(r), refused };
  }

  if (action === 'renegotiate') {
    const answer = description(b.answer, 'answer', 'answer');
    const s = sfuSessionOf(b);
    const g = await deps.gate(user, callId, sessionId, 'renegotiate', null);
    ready(deps);
    own(s, g);
    await deps.cf('PUT', `/sessions/${s}/renegotiate`, { sessionDescription: answer });
    return {};
  }

  // close: tracks this person sends (names: no longer published) or receives.
  const mids = midList(b.mids);
  const names = nameList(b.names);
  const offer = b.offer === undefined || b.offer === null ? null : description(b.offer, 'offer', 'offer');
  const s = sfuSessionOf(b);
  const g = await deps.gate(user, callId, sessionId, 'close', null);
  ready(deps);
  own(s, g);
  let r: Record<string, unknown> | null = null;
  let failure: unknown = null;
  try {
    r = await deps.cf('PUT', `/sessions/${s}/tracks/close`, offer
      ? { tracks: mids.map((mid) => ({ mid })), sessionDescription: offer, force: false }
      : { tracks: mids.map((mid) => ({ mid })), force: true });
  } catch (e) {
    failure = e;
  }
  // Unpublished whatever Cloudflare answered: nobody should pull them any more.
  const mine = names.filter((n) => (g.sfu_tracks ?? []).includes(n));
  const call = mine.length ? await deps.publish(user, callId, sessionId, s, { remove: mine }) : null;
  if (failure) throw failure;
  return { answer: sdpOf(r, 'answer'), tracks: listOf(r), call };
}
