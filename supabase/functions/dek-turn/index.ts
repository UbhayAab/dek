// TURN credentials for voice rooms.
//
// Cloudflare moved TURN credential generation to an API-call model: a long-
// lived TURN KEY is created once (dashboard or /calls/turn_keys), and short-
// lived iceServers come from rtc.live.cloudflare.com using ANY Cloudflare API
// token authorised over that key. This function is the only thing that talks
// to it, so the browser never sees account-level credentials.
//
// Configuration modes, first match wins:
//  1. TURN SERVER app: env TURN_KEY_ID + TURN_API_TOKEN
//     -> rtc.live.cloudflare.com generate-ice-servers with the TURN token,
//        ttl 6h, :53 port stripped, cached an hour. THE production mode.
//  2. Realtime APP model: env RTC_APP_ID + RTC_APP_TOKEN + TURN_KEY_ID
//  3. LEGACY HMAC: env TURN_TOKEN_ID + TURN_TOKEN_SECRET
//  4. None set -> 503, and the client stays STUN-only exactly as before.
//
// Auth: any signed-in Dek user (GoTrue verification). The publishable key
// alone must NOT count - that would make this a free public relay.
//
// Deploy: supabase functions deploy dek-turn
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// The publishable key is public by design - it ships in every browser bundle.
// The env fallback exists because SUPABASE_ANON_KEY is not guaranteed to be
// injected on every project.
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? 'sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD';
const TURN_KEY_ID = Deno.env.get('TURN_KEY_ID');
const TURN_API_TOKEN = Deno.env.get('TURN_API_TOKEN');
const RTC_APP_ID = Deno.env.get('RTC_APP_ID');
const RTC_APP_TOKEN = Deno.env.get('RTC_APP_TOKEN');
const TURN_TOKEN_ID = Deno.env.get('TURN_TOKEN_ID');
const TURN_TOKEN_SECRET = Deno.env.get('TURN_TOKEN_SECRET');

const TTL_SECONDS = 3600 * 6;

const enc = new TextEncoder();
function b64(buf: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
async function hmacSha1(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

async function verifyUser(authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      // /auth/v1/user needs BOTH the user JWT and an apikey - without the
      // anon key the gateway 401s before GoTrue ever sees the token.
      headers: { Authorization: authHeader, apikey: ANON_KEY },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}

// APP model: the Realtime application token mints credentials for the
// account's TURN key. Cached for an hour; credentials inside live six.
let cfCache: { at: number; ice: unknown } | null = null;
async function viaCloudflare(): Promise<{ iceServers: unknown[] } | null> {
  if (!TURN_KEY_ID || !TURN_API_TOKEN) return null;
  if (cfCache && Date.now() - cfCache.at < 3600_000) return { iceServers: cfCache.ice };
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: TTL_SECONDS }),
  });
  if (!r.ok) throw new Error(`cloudflare ${r.status}`);
  const j = await r.json();
  if (!j?.iceServers?.length) return null;
  // The :53 alternate port times out in browsers without trickle ICE; drop it.
  const cleaned = j.iceServers.map((s: { urls: string[] }) => ({
    ...s,
    urls: Array.isArray(s.urls) ? s.urls.filter((u: string) => !u.endsWith(':53')) : s.urls,
  }));
  cfCache = { at: Date.now(), ice: cleaned };
  return { iceServers: cleaned };
}

// Legacy model: mint locally from the key secret.
function viaLegacy(): { iceServers: unknown[] } {
  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const username = `${expiry}:${crypto.randomUUID().slice(0, 8)}`;
  return hmacSha1(TURN_TOKEN_SECRET!, username).then((credential) => ({
    iceServers: [{
      urls: [
        'turn:standard.turn.cloudflare.com:3478?transport=udp',
        'turn:standard.turn.cloudflare.com:3478?transport=tcp',
        'turns:standard.turn.cloudflare.com:5349?transport=tcp',
      ],
      username,
      credential,
    }],
  }));
}

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const configured = (TURN_KEY_ID && TURN_API_TOKEN) || (TURN_TOKEN_ID && TURN_TOKEN_SECRET);
  if (!configured) {
    return new Response(JSON.stringify({ error: 'turn_not_configured' }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (!(await verifyUser(req.headers.get('Authorization')))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const out = TURN_KEY_ID && TURN_API_TOKEN ? await viaCloudflare() : await viaLegacy();
    if (!out) throw new Error('no ice servers');
    return new Response(JSON.stringify({ ...out, ttl: TTL_SECONDS }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'turn_mint_failed', detail: String(e).slice(0, 200) }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
