// Dek sign-in codes (migrations 0902, 0903, 0910 have the reasoning and the brakes).
//
//   POST { action: 'send', email, invite_code? }      -> 200 { ok: true, request } | 4xx { error, message }
//   POST { action: 'verify', email, code, request }   -> 200 { session, new_user } | 4xx { error, message }
//
// Anonymous by design (verify_jwt false): this is how people sign in.
// - Codes are 8 digits from crypto.getRandomValues; only HMAC-SHA256(pepper, email:code)
//   is stored. 3 tries per code, 5 codes an hour, 30 wrong tries a day per address.
// - send returns a request token; verify needs it, so nobody but the requester can try
//   (or burn) that code. Only its SHA-256 is stored.
// - An address with no account and no usable invite gets the same 200 and a token, after
//   a similar delay, but no mail and no code: Dek does not reveal who has an account.
// - A verified code becomes a session through admin.generateLink (magiclink: no email is
//   sent) and verifyOtp on a client made for this request only. The shared admin client
//   must never hold a user session: supabase-js would then send that user's token on
//   every later admin call (2026-10-04 review).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

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
const PEPPER = Deno.env.get('DEK_INTERNAL_SECRET') ?? '';
const MAIL_URL = (Deno.env.get('MAIL_URL') ?? 'https://mailer.jarurat.care').replace(/\/+$/, '');
const MAIL_API_KEY = Deno.env.get('MAIL_API_KEY') ?? '';
const MAIL_TEMPLATE = Deno.env.get('MAIL_TEMPLATE') ?? 'dek-otp';
const CODE_DIGITS = 8;

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
// rpc and admin.* only; never verifyOtp, signIn* or setSession on this client
const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: NO_SESSION, db: { schema: 'api' } });

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

const MESSAGES: Record<string, [number, string]> = {
  invalid_email: [400, 'Enter a valid email address.'],
  invalid_request: [400, 'That request was not valid.'],
  too_soon: [429, 'Wait a minute before asking for another code.'],
  too_many: [429, 'Too many codes were requested. Try again in an hour, or sign in with your password.'],
  busy: [503, 'Dek is sending a lot of codes right now. Try again in a few minutes, or sign in with your password.'],
  expired: [400, 'That code has expired. Ask for a new one.'],
  too_many_attempts: [429, 'Too many wrong tries. Ask for a new code later, or sign in with your password.'],
  wrong_code: [400, 'That code is not right. Check the latest email from Dek.'],
  mail_failed: [502, 'The code could not be emailed right now. Try again shortly, or sign in with your password.'],
  not_configured: [503, 'Email codes are not set up yet. Sign in with your password.'],
};

function fail(reason: string, extra: Record<string, unknown> = {}): Response {
  const [status, message] = MESSAGES[reason] ?? [400, 'Something went wrong. Try again.'];
  return reply(status, { error: reason, message, ...extra });
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(email: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${email}:${code}`)));
}

async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

// Uniform 8-digit code (rejection sampling, no modulo bias).
function newCode(): string {
  const space = 10 ** CODE_DIGITS;
  const limit = Math.floor(0xffffffff / space) * space;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % space).padStart(CODE_DIGITS, '0');
  }
}

function token(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;
const validIp = (s: string | null | undefined) => {
  const v = (s ?? '').trim();
  return v && (IPV4.test(v) || (v.includes(':') && IPV6.test(v))) ? v : null;
};

// The address the edge saw. cf-connecting-ip is set by Cloudflare itself; in
// x-forwarded-for each proxy appends, so the leftmost entry is whatever the client sent.
function clientIp(req: Request): string | null {
  const cf = validIp(req.headers.get('cf-connecting-ip'));
  if (cf) return cf;
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return validIp(chain[chain.length - 1]);
}

const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

async function send(email: string, inviteCode: string | null, ip: string | null): Promise<Response> {
  if (!MAIL_API_KEY || !PEPPER || !SECRET_KEY) return fail('not_configured');
  const code = newCode();
  const request = token();
  const t0 = Date.now();
  const { data, error } = await admin.rpc('svc_auth_code_issue', {
    p_email: email, p_code_hash: await hmac(email, code), p_request_hash: await sha256(request),
    p_invite_code: inviteCode, p_ip: ip,
  });
  if (error) return reply(500, { error: 'server', message: 'Could not start sign-in. Try again.' });
  if (!data?.ok) return fail(data?.reason ?? 'invalid_request', data?.retry_after ? { retry_after: data.retry_after } : {});
  if (!data.mail) {
    // no account: same answer, about as slow as a real send, nothing mailed
    await pause(Math.max(0, 500 - (Date.now() - t0)), 1300);
    return reply(200, { ok: true, request });
  }
  const res = await fetch(`${MAIL_URL}/api/v1/transactional/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: MAIL_TEMPLATE, to: email, data: { CODE: code, EMAIL: email, FROM_NAME: 'Dek' } }),
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  // Any 2xx counts as sent (the Mailer answers 202 queued when SES is slow).
  if (!res || res.status < 200 || res.status > 299) return fail('mail_failed');
  return reply(200, { ok: true, request });
}

async function verify(email: string, code: string, request: string): Promise<Response> {
  if (!PEPPER || !SECRET_KEY) return fail('not_configured');
  if (!new RegExp(`^[0-9]{${CODE_DIGITS}}$`).test(code)) return fail('wrong_code');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(request)) return fail('expired');
  const requestHash = await sha256(request);
  const { data, error } = await admin.rpc('svc_auth_code_verify', {
    p_email: email, p_code_hash: await hmac(email, code), p_request_hash: requestHash,
  });
  if (error) return reply(500, { error: 'server', message: 'Could not check the code. Try again.' });
  if (!data?.ok) return fail(data?.reason ?? 'wrong_code', data?.attempts_left !== undefined ? { attempts_left: data.attempts_left } : {});

  // From here the code is consumed: on any failure put it back, so the person can retry it.
  const release = async () => {
    await admin.rpc('svc_auth_code_release', { p_email: email, p_request_hash: requestHash }).catch(() => undefined);
  };
  const serverError = async (message: string) => {
    await release();
    return reply(500, { error: 'server', message });
  };

  // Public sign-up is off: an invited newcomer's account is made here (a code was only
  // issued to them because they held a valid invite). Neither call sends any email.
  if (!data.existing) {
    const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createErr && !/already|registered|exists/i.test(createErr.message)) {
      return serverError('Could not create your account. Try again.');
    }
  }
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const hashed = link?.properties?.hashed_token;
  if (linkErr || !hashed) return serverError('Could not finish signing in. Try again.');
  const isNew = !link.user?.last_sign_in_at;
  // a client for this one request: the session it receives goes to the caller and dies here
  const once = createClient(SUPABASE_URL, SECRET_KEY, { auth: NO_SESSION });
  const { data: verified, error: otpErr } = await once.auth.verifyOtp({ type: 'magiclink', token_hash: hashed });
  const s = verified?.session;
  if (otpErr || !s) return serverError('Could not finish signing in. Try again.');
  return reply(200, {
    session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_in: s.expires_in, expires_at: s.expires_at, token_type: s.token_type },
    new_user: isNew,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method', message: 'POST only.' });
  let body: { action?: string; email?: string; code?: string; invite_code?: string; request?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const email = String(body.email ?? '').trim().toLowerCase();
  if (body.action === 'send') {
    // new codes are 22 base62 characters; migrated legacy links carry 24 base64url or 32 hex
    const invite = typeof body.invite_code === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.invite_code) ? body.invite_code : null;
    return send(email, invite, clientIp(req));
  }
  if (body.action === 'verify') {
    return verify(email, String(body.code ?? '').replace(/[^0-9]/g, ''), String(body.request ?? ''));
  }
  return reply(400, { error: 'invalid_request', message: 'Unknown action.' });
});
