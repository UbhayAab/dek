// Pure parts of the Send Email Hook: Standard Webhooks signature check, payload to
// mail mapping, and the never-mail list. No Deno globals, so the Node tests load it.

export type HookPayload = {
  user?: { id?: string; email?: string; new_email?: string };
  email_data?: {
    token?: string; token_hash?: string; token_new?: string; token_hash_new?: string;
    redirect_to?: string; email_action_type?: string; site_url?: string;
  };
};
export type Mail = { to: string; code: string; action: string };
export type Verdict = 'ok' | 'missing' | 'stale' | 'bad';

const enc = new TextEncoder();
const TOLERANCE_SECONDS = 5 * 60;

// Every action that carries a one-time code becomes a code mail. Notification-only
// actions (password_changed_notification and friends) have no code and are
// acknowledged without mail; they are off in the auth config anyway.
const CODE_ACTIONS = new Set(['signup', 'magiclink', 'recovery', 'invite', 'email', 'reauthentication']);

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Standard Webhooks (what Supabase Auth signs hooks with): HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<raw body>" with the base64 key after
// "v1,whsec_"; the header holds space separated "v1,<base64 signature>" entries.
export async function verifyWebhook(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null },
                                    body: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Verdict> {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return 'missing';
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return 'stale';
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', b64decode(secret.replace(/^v1,/, '').replace(/^whsec_/, '')),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    return 'bad';
  }
  const expected = b64encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`))));
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',');
    if (version === 'v1' && sig && await sameBytes(sig, expected)) return 'ok';
  }
  return 'bad';
}

// email_change with secure change on sends two codes: token to the current address
// (user.email) and token_new to the new one (user.new_email); with it off, only
// token_new to the new address. The hash fields are reversed for backward
// compatibility (Supabase docs) but codes are what Dek mails.
export function mailsFor(p: HookPayload): Mail[] {
  const action = String(p?.email_data?.email_action_type ?? '');
  const d = p?.email_data ?? {};
  const email = String(p?.user?.email ?? '').trim();
  const fresh = String(p?.user?.new_email ?? '').trim();
  const code = (c: unknown) => (typeof c === 'string' && /^[0-9]{6,10}$/.test(c) ? c : '');
  if (action === 'email_change') {
    const out: Mail[] = [];
    if (code(d.token) && email) out.push({ to: email, code: code(d.token), action });
    if (code(d.token_new) && fresh) out.push({ to: fresh, code: code(d.token_new), action });
    return out;
  }
  if (!CODE_ACTIONS.has(action) || !code(d.token) || !email) return [];
  return [{ to: email, code: code(d.token), action }];
}

// Addresses that can never receive mail (RFC 2606 and 6761 names, and anything
// without a dotted domain). Mailing them only produces a bounce on the shared SES
// account, which carries patient mail too, so they are refused before the mailer.
export function undeliverable(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return true;
  const domain = address.slice(at + 1).toLowerCase().replace(/\.$/, '');
  return !domain.includes('.')
    || /(^|\.)(invalid|test|example|localhost|local|internal)$/.test(domain)
    || /(^|\.)example\.(com|net|org)$/.test(domain);
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}
