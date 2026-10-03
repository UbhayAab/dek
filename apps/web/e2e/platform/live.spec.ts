// Live updates and the sign-out guard, end to end against the live project:
// - sign-out with an unsent message asks first; "Sign out anyway" wipes it,
// - chan.self: my notify setting changed in one tab reaches the other tab,
// - org.upd: the brand color changes in the open app at once (DEK01),
// - server.upd: a server's description changes in the open app.
// Every shared QA setting changed here is put back in a finally block.
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { QA, channelId, db, env, password, signIn, waitReady, waitSignedIn, type DekWindow } from './helpers';

function asOwner() {
  const e = env();
  return createClient(e.SUPABASE_URL!, e.SUPABASE_PUBLISHABLE_KEY!, { db: { schema: 'api' }, auth: { persistSession: false, autoRefreshToken: false } });
}

test('sign-out with an unsent message asks first; "Sign out anyway" wipes it', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, QA.alice);
  await waitReady(page);
  const general = await channelId(page, 'general');
  await ctx.setOffline(true);
  try {
    await page.evaluate((c) => (window as unknown as DekWindow).__dek.actions.sendMessage({ channelId: c, body: `e2e unsent ${Date.now()}` }), general);
    const refused = await page.evaluate(() => (window as unknown as DekWindow).__dek.actions.signOut().then(() => 'signed out', (e: { message?: string }) => e.message ?? 'error'));
    expect(refused).toBe('conflict');
    await expect(page.getByText('1 message has not been sent yet. Signing out deletes it from this device.')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as DekWindow).__dek.useDek.getState().session.status)).toBe('signed_in');
    await page.getByRole('button', { name: 'Sign out anyway' }).click();
    await page.waitForFunction(() => (window as unknown as DekWindow).__dek.useDek.getState().session.status === 'signed_out', undefined, { timeout: 20_000 });
    const left = await page.evaluate(() => indexedDB.databases().then((l) => l.map((d) => d.name).filter((n) => n?.startsWith('dek-'))));
    expect(left).toEqual([]);
  } finally {
    await ctx.setOffline(false);
    await ctx.close();
  }
});

test('a session that ends on its own keeps the unsent message, and it lands after signing back in', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, QA.alice);
  await waitReady(page);
  const general = await channelId(page, 'general');
  const userId = await page.evaluate(() => (window as unknown as DekWindow).__dek.useDek.getState().session.userId!);
  // sends fail at the network (everything else works), so the message waits in the outbox
  await page.route('**/rest/v1/rpc/send_message', (route) => route.abort('internetdisconnected'));
  const body = `e2e kept ${Date.now()}`;
  const clientId = await page.evaluate(([c, b]) => (window as unknown as DekWindow).__dek.actions.sendMessage({ channelId: c!, body: b! }), [general, body] as const);
  await page.waitForFunction((id) => (window as unknown as DekWindow).__dek.useDek.getState().pending[id]?.status === 'retrying', clientId);
  await page.evaluate((c) => (window as unknown as DekWindow).__dek.actions.setDraft(c, 'half a thought'), general);
  await page.waitForTimeout(600);
  // the session ends without the person signing out (as when a refresh is refused)
  await page.evaluate(() => (window as unknown as DekWindow).__dek.supabase().auth.signOut({ scope: 'local' }));
  await page.waitForFunction(() => (window as unknown as DekWindow).__dek.useDek.getState().session.status === 'signed_out', undefined, { timeout: 20_000 });
  const kept = await page.evaluate(([uid, id]) => new Promise<{ outbox: boolean; pages: number; draft: string | null }>((resolve) => {
    const req = indexedDB.open(`dek-${uid}`);
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction(['outbox', 'pages'], 'readonly');
      const o = tx.objectStore('outbox').get(id!);
      const p = tx.objectStore('pages').count();
      tx.oncomplete = () => {
        d.close();
        resolve({ outbox: !!o.result, pages: p.result, draft: localStorage.getItem(`dek.drafts.${uid}`) });
      };
    };
    req.onerror = () => resolve({ outbox: false, pages: -1, draft: null });
  }), [userId, clientId] as const);
  expect(kept.outbox).toBe(true);
  expect(kept.pages).toBe(0);
  expect(kept.draft).toContain('half a thought');
  // the same person signs back in: the message goes out, once
  await page.unroute('**/rest/v1/rpc/send_message');
  await page.getByLabel('Email', { exact: true }).fill(QA.alice);
  await page.getByLabel('Password', { exact: true }).fill(password());
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await waitSignedIn(page);
  await expect.poll(async () => (await db<{ n: number }>('select count(*)::int as n from dek.messages where client_id = $1', [clientId]))[0]!.n, { timeout: 30_000 }).toBe(1);
  await page.waitForFunction((id) => !(window as unknown as DekWindow).__dek.useDek.getState().pending[id], clientId, { timeout: 20_000 });
  expect(await page.evaluate((c) => (window as unknown as DekWindow).__dek.useDek.getState().drafts[c], general)).toBe('half a thought');
  await page.evaluate((c) => (window as unknown as DekWindow).__dek.actions.setDraft(c, ''), general);
  await ctx.close();
});

test('saved: a bookmark made in one tab shows in the other at once, and after a reload', async ({ browser }) => {
  const ctx = await browser.newContext();
  const tab1 = await ctx.newPage();
  await signIn(tab1, QA.alice);
  await waitReady(tab1);
  const tab2 = await ctx.newPage();
  await tab2.goto('/');
  await waitSignedIn(tab2);
  await waitReady(tab2);
  const general = await channelId(tab1, 'general');
  await tab1.evaluate((c) => (window as unknown as DekWindow).__dek.actions.openChannel(c), general);
  const id = await tab1.evaluate((c) => {
    const s = (window as unknown as DekWindow).__dek.useDek.getState();
    const ids = s.timelines[c]!.ids;
    return ids.slice().reverse().find((m) => !s.saved[m])!;
  }, general);
  try {
    const t0 = Date.now();
    await tab1.evaluate((m) => (window as unknown as DekWindow).__dek.actions.saveMessage(m, true), id);
    expect(await tab1.evaluate((m) => (window as unknown as DekWindow).__dek.useDek.getState().saved[m] === true, id)).toBe(true);
    await tab2.waitForFunction((m) => (window as unknown as DekWindow).__dek.useDek.getState().saved[m] === true, id, { timeout: 10_000 });
    console.log(`[measured] saved.upd reached the other tab in ${Date.now() - t0} ms`);
    await tab2.reload();
    await waitReady(tab2);
    await tab2.waitForFunction((m) => (window as unknown as DekWindow).__dek.useDek.getState().saved[m] === true, id, { timeout: 10_000 });
  } finally {
    await tab1.evaluate((m) => (window as unknown as DekWindow).__dek.actions.saveMessage(m, false), id);
  }
  await tab2.waitForFunction((m) => !(window as unknown as DekWindow).__dek.useDek.getState().saved[m], id, { timeout: 10_000 });
  await ctx.close();
});

test('membership actions: leave and join a channel, open a DM, all from the server reply', async ({ page }) => {
  await signIn(page, QA.alice);
  await waitReady(page);
  const announcements = await channelId(page, 'announcements');
  try {
    await page.evaluate((c) => (window as unknown as DekWindow).__dek.actions.leaveChannel(c), announcements);
    expect(await page.evaluate((c) => !!(window as unknown as DekWindow).__dek.useDek.getState().channels[c], announcements)).toBe(false);
  } finally {
    await page.evaluate((c) => (window as unknown as DekWindow).__dek.actions.joinChannel(c), announcements);
  }
  expect(await page.evaluate((c) => (window as unknown as DekWindow).__dek.useDek.getState().channels[c]?.member, announcements)).toBe(true);
  const bob = (await db<{ id: string }>('select id from auth.users where email = $1', [QA.bob]))[0]!.id;
  const dm = await page.evaluate((b) => (window as unknown as DekWindow).__dek.actions.openDm([b]), bob);
  expect(await page.evaluate((d) => (window as unknown as DekWindow).__dek.useDek.getState().channels[d]?.kind, dm)).toBe('dm');
  expect(await page.evaluate((d) => (window as unknown as DekWindow).__dek.useDek.getState().channels[d]?.dm_user_ids, dm)).toEqual([bob]);
});

test('chan.self: a notify change in one tab reaches the other tab', async ({ browser }) => {
  const ctx = await browser.newContext();
  const tab1 = await ctx.newPage();
  await signIn(tab1, QA.alice);
  await waitReady(tab1);
  const tab2 = await ctx.newPage();
  await tab2.goto('/');
  await waitSignedIn(tab2);
  await waitReady(tab2);
  const general = await channelId(tab1, 'general');
  try {
    const t0 = Date.now();
    await tab1.evaluate((c) => (window as unknown as DekWindow).__dek.actions.setChannelNotify(c, 'all'), general);
    expect(await tab1.evaluate((c) => (window as unknown as DekWindow).__dek.useDek.getState().channels[c]?.notify, general)).toBe('all');
    await tab2.waitForFunction((c) => (window as unknown as DekWindow).__dek.useDek.getState().channels[c]?.notify === 'all', general, { timeout: 10_000 });
    console.log(`[measured] chan.self reached the other tab in ${Date.now() - t0} ms`);
  } finally {
    await tab1.evaluate((c) => (window as unknown as DekWindow).__dek.actions.setChannelNotify(c, 'default'), general);
    await ctx.close();
  }
});

test('org.upd re-brands the open app; server.upd updates the server', async ({ page }) => {
  const owner = asOwner();
  expect((await owner.auth.signInWithPassword({ email: QA.owner, password: password() })).error).toBeNull();
  await signIn(page, QA.alice);
  await waitReady(page);
  const { orgId, server } = await page.evaluate(() => {
    const s = (window as unknown as DekWindow).__dek.useDek.getState();
    const srv = Object.values(s.servers).find((x) => x.name === 'Medical Partnerships')!;
    return { orgId: s.orgId!, server: { id: srv.id, description: srv.description } };
  });
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--org').trim());
  const original = (await owner.rpc('bootstrap', { p_org: orgId })).data as { org: { brand_color: string } };
  try {
    const t0 = Date.now();
    expect((await owner.rpc('update_org', { p_org: orgId, p_patch: { brand_color: '#0E7490' } })).error).toBeNull();
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--org').trim() === '#0e7490', undefined, { timeout: 10_000 });
    console.log(`[measured] org.upd re-branded the open app in ${Date.now() - t0} ms (was ${before})`);
    expect(await page.evaluate(() => (window as unknown as DekWindow).__dek.useDek.getState().org?.brand_color)).toBe('#0E7490');
    const note = `e2e description ${Date.now()}`;
    expect((await owner.rpc('update_server', { p_server: server.id, p_patch: { description: note } })).error).toBeNull();
    await page.waitForFunction(([id, d]) => (window as unknown as DekWindow).__dek.useDek.getState().servers[id!]?.description === d, [server.id, note] as const, { timeout: 10_000 });
    expect(await page.evaluate((id) => (window as unknown as DekWindow).__dek.useDek.getState().servers[id]?.my_role, server.id)).toBe('member');
  } finally {
    await owner.rpc('update_org', { p_org: orgId, p_patch: { brand_color: original.org.brand_color } });
    await owner.rpc('update_server', { p_server: server.id, p_patch: { description: server.description ?? '' } });
    await owner.auth.signOut();
  }
});
