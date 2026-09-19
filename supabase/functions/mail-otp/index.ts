// Dek's own OTP sign-in, delivered through the organisation's mailer.
//
// WHY THIS EXISTS: Supabase's built-in OTP mailer caps the whole project at a
// few messages per hour - a signup funnel that dies on launch day. The org
// already runs JCF-Mailer (SES, jarurat.care, template editor built in), so
// codes ride that.
//
// POST { action: 'send',  email }
//   -> rate limit: 1 per email per 60s, 10 per hour
//   -> 6 digits, SHA-256(code + email) stored, 10-minute expiry
//   -> JCF-Mailer /api/v1/transactional/send, template "dek-otp", {{CODE}}
//   -> DEV ESCAPE: with no MAIL_API_KEY configured, requests for @dek.app
//      addresses get { devCode } in the response so the flow is testable
//      end-to-end before the production API key lands. No other domain.
//
// POST { action: 'verify', email, code }
//   -> max 5 attempts per code
//   -> first-time users get an auth.users row created automatically
//   -> session minted via admin generateLink + verifyOtp
//   -> returns { access_token, refresh_token, user } - the client calls
//      setSession and is fully signed in, RLS and all.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MAIL_URL = Deno.env.get('MAIL_URL') || 'https://mailer.jarurat.care';
const MAIL_API_KEY = Deno.env.get('MAIL_API_KEY') || '';
const MAIL_TEMPLATE = Deno.env.get('MAIL_TEMPLATE') || 'dek-otp';
const MAIL_FROM_NAME = Deno.env.get('MAIL_FROM_NAME') || 'Dek';

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_LOCK_MS = 60 * 1000;
const HOURLY_SEND_CAP = 10;
const MAX_VERIFY_ATTEMPTS = 5;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
// Session minting needs an anon client. SUPABASE_ANON_KEY is NOT reliably
// injected on this project (legacy/new key-system mismatch), and the
// publishable key is public by design anyway.
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? 'sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD';

const enc = new TextEncoder();
async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const okEmail = (e: string) => EMAIL_RE.test(e) && e.length <= 254;

async function sendViaMailer(email: string, code: string): Promise<{ sent: boolean; error?: string }> {
  if (!MAIL_API_KEY) return { sent: false, error: 'mail_not_configured' };
  const r = await fetch(MAIL_URL + '/api/v1/transactional/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template: MAIL_TEMPLATE,
      to: email,
      data: { CODE: code, EMAIL: email, FROM_NAME: MAIL_FROM_NAME },
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { sent: false, error: `mailer ${r.status}: ${t.slice(0, 160)}` };
  }
  return { sent: true };
}

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let body: { action?: string; email?: string; code?: string };
  try { body = await req.json(); } catch { body = {}; }
  const email = String(body.email || '').trim().toLowerCase();
  const action = body.action;

  if (!okEmail(email)) {
    return new Response(JSON.stringify({ error: 'Enter a valid email address.' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // ------------------------------------------------------------- SEND
  if (action === 'send') {
    // Resend lock + hourly cap, enforced by counting recent rows.
    const { data: recent } = await admin
      .from('otp_codes')
      .select('created_at')
      .eq('email', email)
      .gte('created_at', new Date(Date.now() - 3600_000).toISOString())
      .order('created_at', { ascending: false });
    const rows = recent || [];
    if (rows.length && Date.now() - new Date(rows[0].created_at).getTime() < RESEND_LOCK_MS) {
      return new Response(JSON.stringify({ error: 'Wait a minute before asking for another code.' }), {
        status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    if (rows.length >= HOURLY_SEND_CAP) {
      return new Response(JSON.stringify({ error: 'Too many codes for this address this hour. Try again later.' }), {
        status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await sha256(code + email);

    const ins = await admin.from('otp_codes').insert({
      email,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    });
    if (ins.error) {
      return new Response(JSON.stringify({ error: 'Could not start sign-in. Try again.' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Housekeeping: anything expired or consumed is noise.
    await admin.from('otp_codes').delete()
      .lt('expires_at', new Date(Date.now() - 3600_000).toISOString());

    const mail = await sendViaMailer(email, code);
    if (!mail.sent) {
      // Dev escape: only ever for @dek.app addresses, only while no production
      // API key is configured. Lets the whole funnel be tested before the
      // mailer key lands.
      if (!MAIL_API_KEY && email.endsWith('@dek.app')) {
        return new Response(JSON.stringify({ ok: true, devCode: code }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'The code could not be emailed right now. Try again shortly.' }), {
        status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // ------------------------------------------------------------ VERIFY
  if (action === 'verify') {
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 6) {
      return new Response(JSON.stringify({ error: 'Enter the 6-digit code.' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const { data: rows } = await admin
      .from('otp_codes')
      .select('id, code_hash, expires_at, attempts, consumed_at')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1);
    const row = rows?.[0];
    if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ error: 'That code has expired. Ask for a new one.' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
      return new Response(JSON.stringify({ error: 'Too many wrong attempts. Ask for a new code.' }), {
        status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const codeHash = await sha256(code + email);
    if (codeHash !== row.code_hash) {
      await admin.from('otp_codes').update({ attempts: (row.attempts || 0) + 1 }).eq('id', row.id);
      return new Response(JSON.stringify({ error: 'That code is not right.' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    await admin.from('otp_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);

    // Find-or-create: try to create first; "already registered" means existing
    // user. Sign up and sign in are the same door.
    let isNew = false;
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { display_name: email.split('@')[0], otp_password_setup_required: true },
    });
    if (created.error) {
      const msg = String(created.error.message || '');
      if (!/already|exists|duplicate|been registered/i.test(msg)) {
        return new Response(JSON.stringify({ error: 'Could not create the account.', stage: 'create', detail: msg.slice(0, 160) }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    } else {
      isNew = true;
      // Latch the account so the app asks for a password on the way in.
      //
      // WHY: createUser without a password does NOT leave the account
      // passwordless - Supabase writes a random hash - so nothing downstream can
      // tell an OTP account from a real one, and the person is quietly left able
      // to sign in ONE way forever: request another code, every single time.
      // That is the whole "why do I keep needing a code" complaint. The latch is
      // the flag the set-password screen already reads on boot; it just was
      // never set for anybody who arrived this way. 53 existing accounts were
      // backfilled in migration 0115.
      const latched = await admin.from('profiles')
        .update({ must_set_password: true })
        .eq('id', created.data.user.id);
      // A failure here must not block the sign-in that just succeeded. The
      // person gets in; they are asked for a password on their next visit
      // instead, because the boot check reads the same column.
      if (latched.error) console.warn('otp: could not latch password setup', latched.error.message);
    }

    // Mint a real session: magic link generation + server-side verification is
    // the supported way to produce access/refresh tokens without a password.
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (link.error || !link.data?.properties?.hashed_token) {
      return new Response(JSON.stringify({ error: 'Could not sign you in. Try again.', stage: 'link', detail: String(link.error?.message || '').slice(0, 160) }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    // Mirrors soop-handoff, which has minted sessions this way in production
    // for a year: type 'email' + token_hash, not type 'magiclink' + token.
    const verified = await anon.auth.verifyOtp({
      type: 'email',
      token_hash: link.data.properties.hashed_token,
    });
    if (verified.error || !verified.data?.session) {
      return new Response(JSON.stringify({ error: 'Could not sign you in. Try again.', stage: 'verify', detail: String(verified.error?.message || '').slice(0, 160) }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      isNew,
      access_token: verified.data.session.access_token,
      refresh_token: verified.data.session.refresh_token,
      user: verified.data.user,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Unknown action.' }), {
    status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
