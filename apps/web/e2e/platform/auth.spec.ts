// Auth and invite landing, end to end against the live project. No email is ever
// sent: see the auth-code notes above the code tests.
import { createHash, createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { QA, db, env, password, signIn, waitReady, waitSignedIn, type DekWindow } from './helpers';

const LEGACY_KEY = 'sb-ybddogqphinruyunnuwx-auth-token';

function apiClient() {
  const e = env();
  return createClient(e.SUPABASE_URL!, e.SUPABASE_PUBLISHABLE_KEY!, {
    db: { schema: 'api' }, auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function countRequests(page: Page, pattern: string): Promise<() => number> {
  let n = 0;
  page.on('request', (r) => { if (r.url().includes(pattern)) n += 1; });
  return () => n;
}

test('password sign-in: a trailing space is retried trimmed once; Enter moves to the password', async ({ page }) => {
  const tokenCalls = await countRequests(page, '/auth/v1/token');
  await page.goto('/');
  const email = page.getByLabel('Email', { exact: true });
  await email.fill(QA.alice);
  await email.press('Enter');
  expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name)).toBe('password');
  await page.getByLabel('Password', { exact: true }).fill(`${password()} `);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await waitSignedIn(page);
  expect(tokenCalls()).toBe(2);
});

test('a wrong password says so plainly and keeps the form', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(QA.alice);
  await page.getByLabel('Password', { exact: true }).fill('definitely-not-it');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('That email and password do not match.')).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(QA.alice);
});

// Email codes come from the auth-code function. Nothing here ever sends mail: a
// real send for a QA address is refused by design (reserved domain), every other
// send is answered by the test, and verify runs for real against a code row the
// test inserts (HMAC with the server secret from .env.local, never printed).
const AUTH_CODE = '**/functions/v1/auth-code';

async function answerSend(page: Page, reply: { status: number; body: unknown }, seen?: (body: Record<string, unknown>) => void): Promise<void> {
  await page.route(AUTH_CODE, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    if (body.action !== 'send') return route.continue();
    seen?.(body);
    return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
  });
}

// 0910: a code can only be tried with the request token its send returned, so the test
// plants the code with a token and answers the (intercepted) send with the same token.
async function plantCode(email: string, code: string, request: string): Promise<void> {
  const hash = createHmac('sha256', env().DEK_INTERNAL_SECRET!).update(`${email}:${code}`).digest('hex');
  const requestHash = createHash('sha256').update(request).digest('hex');
  await db("insert into dek.auth_codes (email, code_hash, request_hash, expires_at) values ($1, $2, $3, now() + interval '10 minutes')",
    [email, hash, requestHash]);
}

const newRequest = () => `e2e${Date.now()}${Math.random().toString(36).slice(2)}abcdefghijklmnop`;
const newCode = () => String(10000000 + Math.floor(Math.random() * 89999999));

async function toCodeEntry(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

test('a reserved address is refused by the real auth-code function, with its message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Email', { exact: true }).fill(QA.alice);
  const answer = page.waitForResponse((r) => r.url().includes('/functions/v1/auth-code'));
  await page.getByRole('button', { name: 'Send code' }).click();
  const res = await answer;
  expect(res.status()).toBe(400);
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in with a code' })).toBeVisible();
});

test('mail trouble points to the password; forgot password takes the same path', async ({ page }) => {
  let sends = 0;
  await answerSend(page, { status: 502, body: { error: 'mail_failed', message: 'The code could not be emailed right now. Try again shortly, or sign in with your password.' } }, () => { sends += 1; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Email', { exact: true }).fill('someone@example.org');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('The code could not be emailed right now. Try again shortly, or sign in with your password.')).toBeVisible();
  await page.getByRole('button', { name: 'Use password' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Dek' })).toBeVisible();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(/could not be emailed right now/)).toBeVisible();
  expect(sends).toBe(2);
});

test('too soon: straight to the code entry, the resend countdown follows retry_after', async ({ page }) => {
  await answerSend(page, { status: 429, body: { error: 'too_soon', message: 'Wait a minute before asking for another code.', retry_after: 42 } });
  await toCodeEntry(page, 'someone@example.org');
  await expect(page.getByText('We sent you a code a moment ago. Use the code from that email.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend code in (4[0-2]) s/ })).toBeDisabled();
});

test('code sign-in, verified by the real function: wrong code shows tries left, the right one signs in', async ({ page }) => {
  const code = newCode();
  const wrong = code === '11111111' ? '22222222' : '11111111';
  const request = newRequest();
  await plantCode(QA.alice, code, request);
  try {
    await answerSend(page, { status: 200, body: { ok: true, request } });
    await toCodeEntry(page, QA.alice);
    const field = page.getByLabel('8-digit code');
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    await expect(page.getByRole('button', { name: /Resend code in \d+ s/ })).toBeDisabled();
    await field.pressSequentially(wrong);                       // auto-verifies on the 8th digit
    await expect(page.getByText('That code is not right. Check the latest email from Dek. 2 tries left.')).toBeVisible();
    await field.fill('');
    await field.pressSequentially(`${code.slice(0, 2)}a${code.slice(2)}`);   // a letter is dropped
    await waitSignedIn(page).catch(async () => {
      // An account without the password flag is offered "Set a password" first.
      await page.getByRole('button', { name: 'Skip for now' }).click();
      await waitSignedIn(page);
    });
    expect(await page.evaluate(() => (window as unknown as DekWindow).__dek.useDek.getState().session.email)).toBe(QA.alice);
  } finally {
    await db('delete from dek.auth_codes where email = $1', [QA.alice]);
  }
});

test('a new account from a code is offered "Set a password", and the password works', async ({ page, browser }) => {
  const email = `qa-new-${Date.now()}@dek-test.invalid`;
  const code = newCode();
  const request = newRequest();
  const newPassword = `Qa-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await plantCode(email, code, request);
  const e = env();
  const admin = createClient(e.SUPABASE_URL!, e.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    await answerSend(page, { status: 200, body: { ok: true, request } });
    await toCodeEntry(page, email);
    await page.getByLabel('8-digit code').pressSequentially(code);
    await expect(page.getByRole('heading', { name: 'Set a password' })).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email);
    await page.getByLabel('New password').fill(newPassword);
    await page.getByRole('button', { name: 'Save password' }).click();
    await waitSignedIn(page);
    // the new password signs in elsewhere
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await signIn(p2, email, newPassword);
    await other.close();
  } finally {
    await db('delete from dek.auth_codes where email = $1', [email]);
    const users = await db<{ id: string }>('select id from auth.users where lower(email) = $1', [email]);
    for (const u of users) {
      await admin.auth.admin.deleteUser(u.id);
      await db('delete from dek.notification_prefs where user_id = $1', [u.id]);
      await db('delete from dek.profiles where id = $1', [u.id]);
    }
  }
});

test('invite: preview signed out, sign in, accept goes to the organization', async ({ page }) => {
  const owner = apiClient();
  const { error: signErr } = await owner.auth.signInWithPassword({ email: QA.owner, password: password() });
  expect(signErr).toBeNull();
  const orgs = await owner.rpc('me');
  const qa = (orgs.data as { orgs: { id: string; name: string }[] }).orgs.find((o) => o.name === 'Dek QA')!;
  const created = await owner.rpc('create_invite', { p_org: qa.id, p_expires_hours: 1, p_max_uses: 5 });
  expect(created.error).toBeNull();
  const invite = created.data as { id: string; code: string };
  try {
    await page.goto(`/invite/${invite.code}`);
    await expect(page.getByRole('heading', { name: 'Dek QA' })).toBeVisible();
    await expect(page.getByText(/invited you/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in to accept' })).toBeVisible();
    // a person without an account asks for a code with this invite
    let sent: Record<string, unknown> | null = null;
    await answerSend(page, { status: 200, body: { ok: true } }, (b) => { sent = b; });
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await expect(page.getByText('New to Dek? This also creates your account.')).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill('newcomer@example.org');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    expect(sent).toMatchObject({ action: 'send', email: 'newcomer@example.org', invite_code: invite.code });
    await page.getByRole('button', { name: 'Sign in with a password instead' }).click();
    await page.getByLabel('Email', { exact: true }).fill(QA.alice);
    await page.getByLabel('Password', { exact: true }).fill(password());
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await waitSignedIn(page);
    await page.getByRole('button', { name: 'Join Dek QA' }).click();
    await page.waitForURL(`**/o/${qa.id}`);
    await waitReady(page);
    expect(await page.evaluate(() => (window as unknown as DekWindow).__dek.useDek.getState().orgId)).toBe(qa.id);
  } finally {
    await owner.rpc('revoke_invite', { p_invite: invite.id });
    await owner.auth.signOut();
  }
});

test('an invalid invite says why and offers a way home', async ({ page }) => {
  await page.goto('/invite/AAAAAAAAAAAAAAAAAAAAAA');
  await expect(page.getByRole('heading', { name: 'This invite cannot be used' })).toBeVisible();
  await expect(page.getByText('This invite link is not valid. Check that you opened the whole link.')).toBeVisible();
  await page.getByRole('button', { name: 'Go to Dek' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Dek' })).toBeVisible();
});

test('legacy session exchange: signed in without a password, legacy keys gone, dek.* kept', async ({ browser }) => {
  // A refresh token of the NEW project stands in for one the migration copied.
  const sb = apiClient();
  const { data, error } = await sb.auth.signInWithPassword({ email: QA.alice, password: password() });
  expect(error).toBeNull();
  const legacy = JSON.stringify({ access_token: 'old', refresh_token: data.session!.refresh_token, user: { id: data.user!.id } });
  const ctx = await browser.newContext();
  await ctx.addInitScript(([key, value]) => {
    if (localStorage.getItem('e2e.legacy.planted')) return;
    localStorage.setItem('e2e.legacy.planted', '1');
    localStorage.setItem(key!, value!);
    localStorage.setItem('dak.lastChannel', '{"uid":"x"}');
    localStorage.setItem('Dek.drafts.v1', '{}');
    localStorage.setItem('dek.keepme', 'yes');
  }, [LEGACY_KEY, legacy]);
  const page = await ctx.newPage();
  let sawSignIn = false;
  page.on('framenavigated', () => undefined);
  await page.goto('/');
  const signInHeading = page.getByRole('heading', { name: 'Sign in to Dek' });
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (await signInHeading.isVisible().catch(() => false)) sawSignIn = true;
    const status = await page.evaluate(() => (window as unknown as DekWindow).__dek?.useDek.getState().session.status ?? 'none');
    if (status === 'signed_in') break;
    await page.waitForTimeout(50);
  }
  await waitSignedIn(page);
  expect(sawSignIn).toBe(false);
  const left = await page.evaluate(() => Object.keys(localStorage).sort());
  expect(left).not.toContain(LEGACY_KEY);
  expect(left).not.toContain('dak.lastChannel');
  expect(left).not.toContain('Dek.drafts.v1');
  expect(left).toContain('dek.keepme');
  expect(left).toContain('dek.auth');
  expect(await page.evaluate(() => (window as unknown as DekWindow).__dek.useDek.getState().session.userId)).toBe(data.user!.id);
  await ctx.close();
});
