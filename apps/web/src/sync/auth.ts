// Sign-in flows (LESSONS "Auth").
//
// Passwords: real forms; "invalid login" is retried once with the password trimmed
// (Android long-press copy adds a trailing space).
//
// Email codes go through Dek's own edge function `auth-code` (migration 0902), not
// Supabase Auth's mailer, which allows 2 emails an hour for the whole project. It is
// called with a plain fetch: supabase.functions.invoke would add the shared client's
// x-dek-build header, which the function's CORS preflight does not allow, so every
// browser request would fail as "offline".
//   send:   { action: 'send', email, invite_code? } -> 200 { ok }      (an invite lets a
//           person without an account get a code; QA's reserved domain is refused)
//   verify: { action: 'verify', email, code }      -> 200 { session, new_user }
//           and the session is installed with auth.setSession.
// Errors are non-2xx { error, message, retry_after?, attempts_left? }; the person
// sees the server's message, the resend countdown follows retry_after.
//
// After a code sign-in of a new account, or one without a password, the person is
// offered "Set a password" (skippable); "forgot password" asks for a new one.
import type { User } from '@supabase/supabase-js';
import { supabase } from '../api/client';
import { DekError, toDekError, type ErrorCode } from '../api/errors';
import { config } from '../config';
import { getState, setState } from '../store/state';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OFFLINE = 'You are offline or the connection dropped. Check it and try again.';
const CODE_TIMEOUT_MS = 20_000;   // the function waits up to 12 s for the Mailer

// ---------------------------------------------------------------- errors

interface AuthErrorLike {
  message?: string;
  code?: string;
  status?: number;
  name?: string;
}

function isInvalidLogin(e: AuthErrorLike): boolean {
  return e.code === 'invalid_credentials' || /invalid login credentials/i.test(e.message ?? '');
}

export function authError(e: AuthErrorLike | null | undefined, fallback: string): DekError {
  if (!e) return new DekError('unknown', fallback);
  const msg = e.message ?? '';
  if (isInvalidLogin(e)) return new DekError('invalid_input', 'That email and password do not match.');
  if (e.code === 'email_not_confirmed') return new DekError('invalid_input', 'This email address is not confirmed yet. Sign in with an email code instead.');
  if (e.code === 'user_banned') return new DekError('forbidden', 'This account is blocked. Ask your administrator.');
  if (e.code === 'weak_password' || /password should be/i.test(msg)) return new DekError('invalid_input', 'Choose a stronger password: at least 8 characters.');
  if (e.status === 429 || /rate limit|too many/i.test(msg) || e.code?.startsWith('over_')) {
    return new DekError('rate_limited', 'Too many attempts. Wait a minute and try again.');
  }
  if (e.status === 0 || e.name === 'AuthRetryableFetchError' || toDekError(e).code === 'network') {
    return new DekError('network', OFFLINE);
  }
  return new DekError('unknown', fallback);
}

// An auth-code refusal: the machine reason, the server's sentence, and what the
// screen needs to act on it.
const REASON_CODE: Record<string, ErrorCode> = {
  invalid_email: 'invalid_input',
  invalid_request: 'invalid_input',
  no_account: 'not_found',
  too_soon: 'rate_limited',
  too_many: 'rate_limited',
  too_many_attempts: 'rate_limited',
  busy: 'server',
  mail_failed: 'server',
  not_configured: 'server',
  server: 'server',
  expired: 'invalid_input',
  wrong_code: 'invalid_input',
  network: 'network',
};

export class CodeError extends DekError {
  readonly reason: string;
  readonly retryAfter: number | null;
  readonly attemptsLeft: number | null;
  constructor(reason: string, message: string, status: number | null, retryAfter: number | null = null, attemptsLeft: number | null = null) {
    super(REASON_CODE[reason] ?? 'unknown', message, status);
    this.reason = reason;
    this.retryAfter = retryAfter;
    this.attemptsLeft = attemptsLeft;
  }
}

// The sending side is down or saturated: the screen offers the password instead.
export function isMailProblem(e: unknown): boolean {
  return e instanceof CodeError && ['mail_failed', 'busy', 'not_configured', 'server', 'too_many'].includes(e.reason);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hasPassword(user: User): boolean {
  const m = (user.user_metadata ?? {}) as Record<string, unknown>;
  return m.password_set === true || m.password_setup_complete === true;
}

// ---------------------------------------------------------------- password

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw new DekError('invalid_input', 'Enter a valid email address.');
  if (!password) throw new DekError('invalid_input', 'Enter your password.');
  const sb = supabase();
  let res = await sb.auth.signInWithPassword({ email: e, password });
  // Sign-in is limited per network address (a burst of 30): an office signing in together
  // behind one NAT sees 429s that clear within seconds. Retry quietly before reporting.
  for (let attempt = 0; attempt < 3 && res.error?.status === 429; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1200 * 2 ** attempt + Math.random() * 1200));
    res = await sb.auth.signInWithPassword({ email: e, password });
  }
  if (res.error && isInvalidLogin(res.error) && password.trim() !== password && password.trim().length > 0) {
    res = await sb.auth.signInWithPassword({ email: e, password: password.trim() });
  }
  if (res.error || !res.data.user) throw authError(res.error, 'Could not sign you in. Try again.');
  // Remember that this account has a password, so a later code sign-in does not
  // offer to set one.
  if (!hasPassword(res.data.user)) void sb.auth.updateUser({ data: { password_set: true } }).catch(() => undefined);
}

// ---------------------------------------------------------------- email codes

// Codes are 8 digits (migration 0910). Each send returns a request token that only this
// device holds; verify must present it, so nobody else can try or burn the code.
export const CODE_LENGTH = 8;

interface CodeReply {
  ok?: boolean;
  request?: string;
  session?: { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number; token_type?: string };
  new_user?: boolean;
  error?: string;
  message?: string;
  retry_after?: number;
  attempts_left?: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function callAuthCode(body: Record<string, unknown>): Promise<CodeReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CODE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${config.supabaseUrl}/functions/v1/auth-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    // No answer at all: offline, or the request timed out.
    throw new CodeError('network', OFFLINE, 0);
  } finally {
    clearTimeout(timer);
  }
  let j: CodeReply = {};
  try {
    j = (await res.json()) as CodeReply;
  } catch {
    j = {};
  }
  if (res.ok) return j;
  const reason = j.error ?? (res.status >= 500 ? 'server' : 'invalid_request');
  throw new CodeError(reason, j.message ?? 'Something went wrong. Try again.', res.status, num(j.retry_after), num(j.attempts_left));
}

const codePurpose = new Map<string, 'signin' | 'reset'>();
// the newest send's request token per address (memory only: a reload asks for a new code)
const codeRequest = new Map<string, string>();
let codeFlow: { purpose: 'signin' | 'reset'; email: string; at: number; newUser: boolean } | null = null;

export async function sendEmailCode(email: string, opts: { purpose?: 'signin' | 'reset'; inviteCode?: string | null } = {}): Promise<void> {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw new DekError('invalid_input', 'Enter a valid email address.');
  // New codes are 22 base62 characters; migrated legacy links carry base64url or hex.
  const invite = opts.inviteCode && /^[A-Za-z0-9_-]{8,64}$/.test(opts.inviteCode) ? opts.inviteCode : null;
  const reply = await callAuthCode({ action: 'send', email: e, ...(invite ? { invite_code: invite } : {}) });
  if (reply.request) codeRequest.set(e, reply.request);
  codePurpose.set(e, opts.purpose ?? 'signin');
}

export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const e = normalizeEmail(email);
  const token = code.replace(/\D/g, '');
  if (token.length !== CODE_LENGTH) throw new DekError('invalid_input', `Enter the ${CODE_LENGTH}-digit code from the email.`);
  const request = codeRequest.get(e);
  if (!request) throw new CodeError('expired', 'Ask for a new code: this page was reloaded since the last one was sent.', 400);
  const reply = await callAuthCode({ action: 'verify', email: e, code: token, request });
  const s = reply.session;
  if (!s?.access_token || !s.refresh_token) throw new CodeError('server', 'Could not finish signing in. Try again.', 500);
  // Read by the auth listener when the new session arrives (it runs after this
  // promise settles), so the flag is consumed there, not cleared here.
  codeFlow = { purpose: codePurpose.get(e) ?? 'signin', email: e, at: Date.now(), newUser: reply.new_user === true };
  const { error } = await supabase().auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) {
    codeFlow = null;
    throw authError(error, 'Could not finish signing in. Try again.');
  }
}

// What the auth screen still shows once the session exists: the new password after
// "forgot password", or the offer to set one for a new account or one without.
export function consumeCodeFlow(user: User): 'password' | 'reset' | null {
  const flow = codeFlow;
  codeFlow = null;
  if (!flow || Date.now() - flow.at > 120_000 || flow.email !== (user.email ?? '').toLowerCase()) return null;
  if (flow.purpose === 'reset') return 'reset';
  if (flow.newUser) return 'password';
  return hasPassword(user) ? null : 'password';
}

// ---------------------------------------------------------------- set password

export async function setPassword(password: string): Promise<void> {
  const p = password.trim();
  if (p.length < 8) throw new DekError('invalid_input', 'Use at least 8 characters.');
  if (p.length > 72) throw new DekError('invalid_input', 'Use at most 72 characters.');
  const { error } = await supabase().auth.updateUser({ password: p, data: { password_set: true } });
  if (error && error.code !== 'same_password') throw authError(error, 'Could not save that password. Try again.');
  finishSetup();
}

export function skipSetup(): void {
  finishSetup();
}

function finishSetup(): void {
  const s = getState().session;
  if (s.userId) setState({ session: { ...s, status: 'signed_in', setup: null } });
}
