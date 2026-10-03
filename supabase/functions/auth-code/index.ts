// Dek sign-in codes (migration 0902 has the reasoning and the brakes).
//
//   POST { action: 'send', email, invite_code? }  -> 200 { ok: true } | 4xx { error, message }
//   POST { action: 'verify', email, code }         -> 200 { session, new_user } | 4xx { error, message }
//
// Anonymous by design (verify_jwt false): this is how people sign in. Codes are 6 digits
// from crypto.getRandomValues; only HMAC-SHA256(DEK_INTERNAL_SECRET, email:code) is
// stored. A verified code becomes a session through admin.generateLink (magiclink, which
// sends no email) and verifyOtp; Supabase Auth's own email limit is never touched.
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

const MESSAGES: Record<string, [number, string]> = {
  invalid_email: [400, 'Enter a valid email address.'],
  invalid_request: [400, 'That request was not valid.'],
  no_account: [404, 'There is no Dek account for this email. Ask your organization admin for an invite link.'],
  too_soon: [429, 'Wait a minute before asking for another code.'],
  too_many: [429, 'Too many codes were requested. Try again in an hour, or sign in with your password.'],
  busy: [503, 'Dek is sending a lot of codes right now. Try again in a few minutes, or sign in with your password.'],
  expired: [400, 'That code has expired. Ask for a new one.'],
  too_many_attempts: [429, 'Too many wrong tries. Ask for a new code.'],
  wrong_code: [400, 'That code is not right. Check the latest email from Dek.'],
  mail_failed: [502, 'The code could not be emailed right now. Try again shortly, or sign in with your password.'],
  not_configured: [503, 'Email codes are not set up yet. Sign in with your password.'],
};

function fail(reason: string, extra: Record<string, unknown> = {}): Response {
  const [status, message] = MESSAGES[reason] ?? [400, 'Something went wrong. Try again.'];
  return reply(status, { error: reason, message, ...extra });
}

async function hmac(email: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${email}:${code}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Uniform 6-digit code (rejection sampling, no modulo bias).
function newCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

function clientIp(req: Request): string | null {
  const raw = req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip') ?? '';
  const ip = raw.split(',')[0]?.trim() ?? '';
  return ip ? ip.slice(0, 64) : null;
}

async function send(email: string, inviteCode: string | null, ip: string | null): Promise<Response> {
  if (!MAIL_API_KEY || !PEPPER || !SECRET_KEY) return fail('not_configured');
  const code = newCode();
  const { data, error } = await admin.rpc('svc_auth_code_issue', {
    p_email: email, p_code_hash: await hmac(email, code), p_invite_code: inviteCode, p_ip: ip,
  });
  if (error) return reply(500, { error: 'server', message: 'Could not start sign-in. Try again.' });
  if (!data?.ok) return fail(data?.reason ?? 'invalid_request', data?.retry_after ? { retry_after: data.retry_after } : {});
  const res = await fetch(`${MAIL_URL}/api/v1/transactional/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: MAIL_TEMPLATE, to: email, data: { CODE: code, EMAIL: email, FROM_NAME: 'Dek' } }),
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  // Any 2xx counts as sent (the Mailer may answer 202 queued when SES is slow).
  if (!res || res.status < 200 || res.status > 299) return fail('mail_failed');
  return reply(200, { ok: true });
}

async function verify(email: string, code: string): Promise<Response> {
  if (!PEPPER || !SECRET_KEY) return fail('not_configured');
  if (!/^[0-9]{6}$/.test(code)) return fail('wrong_code');
  const { data, error } = await admin.rpc('svc_auth_code_verify', { p_email: email, p_code_hash: await hmac(email, code) });
  if (error) return reply(500, { error: 'server', message: 'Could not check the code. Try again.' });
  if (!data?.ok) return fail(data?.reason ?? 'wrong_code', data?.attempts_left !== undefined ? { attempts_left: data.attempts_left } : {});
  // Public sign-up is off: an invited newcomer's account is made here (a code was only
  // issued to them because they held a valid invite). Neither call sends any email.
  if (!data.existing) {
    const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createErr && !/already|registered|exists/i.test(createErr.message)) {
      return reply(500, { error: 'server', message: 'Could not create your account. Try again.' });
    }
  }
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const hashed = link?.properties?.hashed_token;
  if (linkErr || !hashed) return reply(500, { error: 'server', message: 'Could not finish signing in. Try again.' });
  const isNew = !link.user?.last_sign_in_at;
  const { data: verified, error: otpErr } = await admin.auth.verifyOtp({ type: 'magiclink', token_hash: hashed });
  const s = verified?.session;
  if (otpErr || !s) return reply(500, { error: 'server', message: 'Could not finish signing in. Try again.' });
  return reply(200, {
    session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_in: s.expires_in, expires_at: s.expires_at, token_type: s.token_type },
    new_user: isNew,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method', message: 'POST only.' });
  let body: { action?: string; email?: string; code?: string; invite_code?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const email = String(body.email ?? '').trim().toLowerCase();
  if (body.action === 'send') {
    // new codes are 22 base62 characters; migrated legacy links carry 24 base64url or 32 hex
    const invite = typeof body.invite_code === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.invite_code) ? body.invite_code : null;
    return send(email, invite, clientIp(req));
  }
  if (body.action === 'verify') return verify(email, String(body.code ?? '').replace(/[^0-9]/g, ''));
  return reply(400, { error: 'invalid_request', message: 'Unknown action.' });
});
