// Auth and invite landing, end to end. No email is ever sent from these tests:
// every /auth/v1/otp and /auth/v1/verify request is answered by the test itself
// (the auth-email hook is not enabled, and QA addresses are .invalid anyway).
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { QA, env, password, waitReady, waitSignedIn, type DekWindow } from './helpers';

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

test('email codes fail gracefully while the mailer is off', async ({ page }) => {
  let otp = 0;
  await page.route('**/auth/v1/otp**', (route) => {
    otp += 1;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'unexpected_failure', message: 'Error sending magic link email' }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Email', { exact: true }).fill(QA.alice);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('We could not email a code right now. Sign in with your password, or try again later.')).toBeVisible();
  expect(otp).toBe(1);
  await page.getByRole('button', { name: 'Use password' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Dek' })).toBeVisible();

  // forgot password takes the same graceful path
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(/We could not email a code right now/)).toBeVisible();
  expect(otp).toBe(2);
});

test('code entry: one-time-code field, auto-verify on the 6th digit, 60 s resend countdown', async ({ page }) => {
  let verify = 0;
  let verifyBody = '';
  await page.route('**/auth/v1/otp**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/auth/v1/verify**', (route) => {
    verify += 1;
    verifyBody = route.request().postData() ?? '';
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'otp_expired', message: 'Token has expired or is invalid' }) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Email', { exact: true }).fill(QA.alice);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const code = page.getByLabel('6-digit code');
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(code).toHaveAttribute('inputmode', 'numeric');
  await expect(page.getByRole('button', { name: /Resend code in \d+ s/ })).toBeDisabled();
  await code.pressSequentially('12a3456');           // letters are dropped
  await expect(page.getByText('That code is wrong or has expired. Check the latest email, or send a new code.')).toBeVisible();
  expect(verify).toBe(1);
  expect(JSON.parse(verifyBody)).toMatchObject({ email: QA.alice, token: '123456', type: 'email' });
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
