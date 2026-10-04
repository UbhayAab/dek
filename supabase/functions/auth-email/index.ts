// auth-email: the Supabase Auth Send Email Hook. Every sign-in code (signup,
// magiclink, recovery, invite, email change, reauthentication) is delivered through
// the JCF Mailer transactional API with the 'dek-otp' template, exactly the call the
// legacy mail-otp function made, instead of Supabase's rate-capped built-in mailer.
//
// Auth signs each call (Standard Webhooks, secret SEND_EMAIL_HOOK_SECRET =
// 'v1,whsec_...'); anything unsigned, stale or forged gets 401 and no mail. Deployed
// with verify_jwt false: the signature is the boundary.
//
// Safety for the shared SES account: addresses that cannot receive mail (.invalid,
// .test, example.com, ...) are refused before the mailer, and a signed request with
// header x-dek-dry-run: 1 returns what would be sent without sending (tests).
import { domainOf, mailsFor, undeliverable, verifyWebhook, type HookPayload, type Mail, type Verdict } from './hook.ts';

const SECRETS = (Deno.env.get('SEND_EMAIL_HOOK_SECRET') ?? '').split('|').map((s) => s.trim()).filter(Boolean);
const MAIL_URL = (Deno.env.get('MAIL_URL') || 'https://mailer.jarurat.care').replace(/\/+$/, '');
const MAIL_API_KEY = Deno.env.get('MAIL_API_KEY') ?? '';
const MAIL_TEMPLATE = Deno.env.get('MAIL_TEMPLATE') || 'dek-otp';
const ALLOWED_ACTIONS = new Set(['email_change', 'email_change_new', 'email_change_current']);
const FROM_NAME = 'Dek';
const MAILER_TIMEOUT_MS = 4000;   // Auth gives a hook about 5 s

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// An answer Auth passes on to the app as { code, msg }. Auth only reads the body of a
// 2xx reply: a 400 from a hook becomes its own generic 500 "Invalid payload sent to
// hook" (observed), and a 429/503 makes it retry, which could mail a code twice.
function refuse(httpCode: number, message: string): Response {
  return reply(200, { error: { http_code: httpCode, message } });
}

async function send(m: Mail): Promise<{ ok: boolean; status: number; detail?: string }> {
  try {
    const res = await fetch(`${MAIL_URL}/api/v1/transactional/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: MAIL_TEMPLATE, to: m.to, data: { CODE: m.code, EMAIL: m.to, FROM_NAME } }),
      signal: AbortSignal.timeout(MAILER_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, detail: (await res.text()).slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

async function verified(req: Request, raw: string): Promise<Verdict> {
  const headers = {
    id: req.headers.get('webhook-id'),
    timestamp: req.headers.get('webhook-timestamp'),
    signature: req.headers.get('webhook-signature'),
  };
  let verdict: Verdict = 'missing';
  for (const secret of SECRETS) {
    verdict = await verifyWebhook(secret, headers, raw);
    if (verdict === 'ok') break;
  }
  return verdict;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: { http_code: 405, message: 'POST only.' } });
  if (!SECRETS.length) return refuse(500, 'The sign-in email hook is not configured.');
  const raw = await req.text();
  const verdict = await verified(req, raw);
  // A real 401 here: only Auth can sign, and nothing unsigned deserves an answer body.
  if (verdict !== 'ok') return reply(401, { error: { http_code: 401, message: `Webhook signature ${verdict}.` } });

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return refuse(400, 'The hook payload is not JSON.');
  }
  const action = String(payload?.email_data?.email_action_type ?? 'unknown');
  // Sign-in codes come from the auth-code function (0910: 8 digits, request tokens, brakes).
  // Supabase Auth's own code path (/otp, /recover, magic links) is not used by any Dek
  // client, and anyone could trigger it to mail a guessable code: only an email change,
  // which needs a signed-in person, is still delivered here.
  if (!ALLOWED_ACTIONS.has(action)) {
    console.log(JSON.stringify({ action, mailed: 0, note: 'action not used by Dek: refused' }));
    return refuse(400, 'Use the Dek app to get a sign-in code.');
  }
  const mails = mailsFor(payload);
  if (req.headers.get('x-dek-dry-run') === '1') {
    return reply(200, { dry_run: true, action, template: MAIL_TEMPLATE, mailer: MAIL_URL, configured: Boolean(MAIL_API_KEY),
      mails: mails.map((m) => ({ to: m.to, code_digits: m.code.length, undeliverable: undeliverable(m.to) })) });
  }
  if (!mails.length) {
    console.log(JSON.stringify({ action, mailed: 0, note: 'nothing to mail for this action' }));
    return reply(200, {});
  }
  if (mails.some((m) => undeliverable(m.to))) {
    console.log(JSON.stringify({ action, mailed: 0, refused: mails.map((m) => domainOf(m.to)) }));
    return refuse(400, 'That email address cannot receive mail.');
  }
  if (!MAIL_API_KEY) return refuse(503, 'Sign-in codes cannot be emailed right now. Use your password, or try again later.');
  for (const m of mails) {
    const r = await send(m);
    if (!r.ok) {
      console.error(JSON.stringify({ action, domain: domainOf(m.to), mailer_status: r.status, detail: r.detail }));
      return refuse(503, 'The sign-in code could not be emailed. Try again in a minute.');
    }
  }
  console.log(JSON.stringify({ action, mailed: mails.length, domains: mails.map((m) => domainOf(m.to)) }));
  return reply(200, {});
});
