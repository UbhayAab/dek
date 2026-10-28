// sfu: the Cloudflare Realtime SFU behind group calls. Owner: lead.
// docs/CONTRACT.md section 5, migration 0914, docs/ARCHITECTURE.md section 9.
//
// POST, Authorization: Bearer <user access token>, a JSON body naming the call and the
// caller's Dek session: { action, call_id, session_id, ... }. Deployed with verify_jwt
// off because this project signs ES256 tokens; the token is verified here (getClaims).
// The Cloudflare app token (secret RTC_APP_TOKEN, app RTC_APP_ID) never leaves this
// function. Every action first passes api.svc_sfu_gate: a JOINED participant of an
// active call that goes through the SFU (Call.sfu), with that session, still able to
// read the call's channel; 120 actions a minute and 20 new SFU sessions per 10 minutes.
//
//   session      { offer?, tracks?: [{ mid, name }], epoch? }
//                  -> 200 { sfu_session, answer, tracks, call }   a new SFU session for
//                     this person, the offer's tracks pushed and recorded (call.upd)
//   push         { sfu_session, offer, tracks: [{ mid, name }] } -> 200 { answer, tracks, call }
//   pull         { sfu_session, tracks: [{ session, name }] }
//                  -> 200 { offer, renegotiate, tracks, refused }   only what another
//                     joined person of the call publishes; answer through renegotiate
//   renegotiate  { sfu_session, answer } -> 200 {}
//   close        { sfu_session, mids, offer?, names? } -> 200 { answer, tracks, call }
//                  names: this person's own tracks that stop being published
//   revoke       { sfu_session } with header x-dek-internal (DEK_INTERNAL_SECRET), from the
//                  database only (dek.sfu_revoke): every track of that session stops at
//                  Cloudflare, because its person left or replaced it -> 200 { closed }
//
// Track names are mic-N, cam-N and screen-N; Cloudflare's per-track results are passed
// through (tracks[].mid, errorCode). Errors are { error, message }: 400 invalid_input,
// 401 auth_required, 404 not_found, 409 conflict (left, moved, ended, not an SFU call,
// sfu_session replaced), 413, 429 rate_limited, 502 sfu_error with Cloudflare's code
// and status (session_error with 410: the SFU session is gone, start a new one), 503
// not_configured (no app secrets, or Cloudflare refused them) or unavailable.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { MAX_BODY, Refusal, cloudflare, dbRefusal, handle, revoke, sameSecret, type GateResult, type SfuDeps } from './sfu.ts';

function pickKey(raw: string | undefined, prefix: string): string {
  if (!raw) return '';
  let values: unknown[];
  try {
    const parsed = JSON.parse(raw);
    values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed) : [parsed];
  } catch {
    values = raw.split(',');
  }
  return values.map((v) => String(v).trim()).find((v) => v.startsWith(prefix)) ?? '';
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SECRET_KEY = pickKey(Deno.env.get('SUPABASE_SECRET_KEYS'), 'sb_secret_');
const RTC_APP_ID = (Deno.env.get('RTC_APP_ID') ?? '').trim();
const RTC_APP_TOKEN = (Deno.env.get('RTC_APP_TOKEN') ?? '').trim();
const INTERNAL_SECRET = Deno.env.get('DEK_INTERNAL_SECRET') ?? '';

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: 'api' },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-dek-build, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function callerId(req: Request): Promise<string | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m || m[1].split('.').length !== 3) return null;   // an API key is not a signed-in person
  try {
    const { data, error } = await admin.auth.getClaims(m[1]);
    const c = data?.claims;
    if (error || !c || c.role !== 'authenticated' || typeof c.sub !== 'string') return null;
    return c.sub;
  } catch {
    return null;
  }
}

const log = (m: string) => console.error(`[sfu] ${m}`);

function fromDb(error: { message?: string; hint?: string | null }): Refusal {
  const r = dbRefusal(error);
  if (r.status === 503) log(`database check failed: ${error.message ?? 'unknown'}`);
  return r;
}

const deps: SfuDeps = {
  configured: RTC_APP_ID !== '' && RTC_APP_TOKEN !== '',
  gate: async (user, callId, sessionId, action, wanted) => {
    const { data, error } = await admin.rpc('svc_sfu_gate', {
      p_user: user, p_call: callId, p_session: sessionId, p_action: action, p_wanted: wanted,
    });
    if (error) throw fromDb(error);
    return data as GateResult;
  },
  publish: async (user, callId, sessionId, sfuSession, change) => {
    const { data, error } = await admin.rpc('svc_sfu_publish', {
      p_user: user, p_call: callId, p_session: sessionId, p_sfu_session: sfuSession,
      p_add: change.add ?? [], p_remove: change.remove ?? [], p_new_session: change.fresh === true,
      p_epoch: change.epoch ?? null,
    });
    if (error) throw fromDb(error);
    return data;
  },
  cf: cloudflare(fetch, RTC_APP_ID, RTC_APP_TOKEN, log),
};

async function readJson(req: Request): Promise<{ body: unknown } | Response> {
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return reply(413, { error: 'invalid_input', message: 'The request is too large.' });
    return { body: JSON.parse(text) };
  } catch {
    return reply(400, { error: 'invalid_input', message: 'The request is not JSON.' });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  // The database (dek.sfu_revoke): stop every track of a session whose person left.
  const internal = req.headers.get('x-dek-internal');
  if (internal !== null) {
    if (!INTERNAL_SECRET || !(await sameSecret(internal, INTERNAL_SECRET))) return reply(401, { error: 'unauthorized' });
    const read = await readJson(req);
    if (read instanceof Response) return read;
    try {
      return reply(200, await revoke(deps, read.body));
    } catch (e) {
      if (e instanceof Refusal) return reply(e.status, { error: e.code, message: e.message, ...e.extra });
      log(`revoke failed: ${e instanceof Error ? e.message : String(e)}`);
      return reply(500, { error: 'internal' });
    }
  }
  const uid = await callerId(req);
  if (!uid) return reply(401, { error: 'auth_required', message: 'Sign in to continue.' });
  const read = await readJson(req);
  if (read instanceof Response) return read;
  const body = read.body;
  try {
    return reply(200, await handle(deps, uid, body));
  } catch (e) {
    if (e instanceof Refusal) return reply(e.status, { error: e.code, message: e.message, ...e.extra });
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    return reply(500, { error: 'internal', message: 'Something went wrong. Try again.' });
  }
});
