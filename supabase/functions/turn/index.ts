// turn: ICE servers for calls. Owner: [media].
// docs/CONTRACT.md section 5, docs/ARCHITECTURE.md section 9, PRD DEK22, DEKA12.
//
// GET or POST, Authorization: Bearer <user access token>. Relay bytes cost money and
// sign-up is open, so only active members of an organization get credentials, at most
// 30 times in 10 minutes (api.svc_turn_grant). Deployed with verify_jwt off because this
// project signs ES256 tokens; verified here instead.
//
//   200 { iceServers, relay: true, ttl, expires_at }        Cloudflare TURN (secrets TURN_KEY_ID and
//                                                            TURN_API_TOKEN set): STUN plus TURN over UDP,
//                                                            TCP and TLS, so calls cross CGNAT and firewalls
//   200 { iceServers: [STUN], relay: false, reason, ttl }   no relay: reason 'not_configured' or
//                                                            'unavailable'; calls work on open networks and
//                                                            the call screen says the relay is unavailable
//   401 { error: 'auth_required' }   403 { error: 'forbidden' } (in no organization)   429 { error: 'rate_limited' }
//
// Credentials are minted for 6 hours and cached for 1 hour per instance, so a call
// that starts from the cache still has at least 5 hours. The :53 alternates are
// dropped (they time out in browsers without trickle ICE).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

type IceServer = { urls: string[]; username?: string; credential?: string };

const STUN: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const TTL_SECONDS = 6 * 3600;
const CACHE_MS = 3600 * 1000;
const FAILURE_BACKOFF_MS = 60 * 1000;

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
const TURN_KEY_ID = Deno.env.get('TURN_KEY_ID') ?? '';
const TURN_API_TOKEN = Deno.env.get('TURN_API_TOKEN') ?? '';

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: 'api' },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-dek-build, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

let cache: { at: number; iceServers: IceServer[] } | null = null;
let failedAt = 0;

async function mint(): Promise<IceServer[]> {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`cloudflare HTTP ${res.status}`);
  }
  const j = await res.json();
  const list: unknown[] = Array.isArray(j?.iceServers) ? j.iceServers : j?.iceServers ? [j.iceServers] : [];
  const servers = list
    .map((s) => s as { urls?: unknown; username?: string; credential?: string })
    .map((s) => ({
      ...s,
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls])
        .filter((u): u is string => typeof u === 'string' && !/:53(\?|$)/.test(u)),
    }))
    .filter((s) => s.urls.length > 0) as IceServer[];
  if (!servers.some((s) => s.urls.some((u) => /^turns?:/.test(u)))) throw new Error('cloudflare returned no TURN urls');
  return servers;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET' && req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const uid = await callerId(req);
  if (!uid) return reply(401, { error: 'auth_required' });
  const grant = await admin.rpc('svc_turn_grant', { p_user: uid });
  if (grant.error) {
    const code = grant.error.message;
    if (code === 'forbidden' || code === 'rate_limited') {
      return reply(code === 'forbidden' ? 403 : 429, { error: code, message: grant.error.hint });
    }
    // The check itself failed: calls can still try direct paths.
    console.error('[turn] grant check failed:', code);
    return reply(200, { iceServers: STUN, relay: false, reason: 'unavailable', ttl: 60 });
  }

  if (!TURN_KEY_ID || !TURN_API_TOKEN) {
    return reply(200, { iceServers: STUN, relay: false, reason: 'not_configured', ttl: 3600 });
  }
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_MS) {
    if (now - failedAt < FAILURE_BACKOFF_MS) {
      return reply(200, { iceServers: STUN, relay: false, reason: 'unavailable', ttl: 60 });
    }
    try {
      cache = { at: now, iceServers: await mint() };
    } catch (e) {
      failedAt = now;
      console.error('[turn] minting failed:', e instanceof Error ? e.message : String(e));
      return reply(200, { iceServers: STUN, relay: false, reason: 'unavailable', ttl: 60 });
    }
  }
  const expires = cache.at + TTL_SECONDS * 1000;
  return reply(200, {
    iceServers: cache.iceServers,
    relay: true,
    ttl: Math.floor((expires - now) / 1000),
    expires_at: new Date(expires).toISOString(),
  });
});
