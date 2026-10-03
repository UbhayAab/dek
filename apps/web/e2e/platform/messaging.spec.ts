// Messaging platform, end to end against the live project (QA world):
// - alice sends in #general, bob (second browser) receives it within 2 s (measured),
// - DEKA03: offline send shows pending, survives in IndexedDB, and lands exactly
//   once after reconnecting,
// - DEKA10: two tabs share one socket; a read in one clears unread in the other;
//   closing the leader tab hands the socket to the other,
// - sign-out wipes IndexedDB and the person's local keys.
// Driven through window.__dek where the shell UI is still being built.
import { expect, test } from '@playwright/test';
import { QA, channelId, countSockets, db, signIn, waitReady, waitSignedIn, type DekWindow } from './helpers';

test('alice sends in #general and bob receives it within 2 s', async ({ browser }) => {
  const ca = await browser.newContext();
  const cb = await browser.newContext();
  const alice = await ca.newPage();
  const bob = await cb.newPage();
  await signIn(alice, QA.alice);
  await signIn(bob, QA.bob);
  await waitReady(alice);
  await waitReady(bob);
  const general = await channelId(alice, 'general');
  expect(await channelId(bob, 'general')).toBe(general);
  await bob.evaluate((c) => { void (window as unknown as DekWindow).__dek.actions.openChannel(c); }, general);
  await bob.waitForFunction((c) => (window as unknown as DekWindow).__dek.useDek.getState().timelines[c]?.status === 'ready', general);

  const latencies: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const body = `e2e latency ${Date.now()}-${i}`;
    // bob notes the moment the message is in his store
    await bob.evaluate((b) => {
      const d = (window as unknown as DekWindow & { __seen?: Promise<number> }).__dek;
      (window as unknown as { __seen: Promise<number> }).__seen = new Promise<number>((resolve) => {
        const hit = () => Object.values(d.useDek.getState().messages).some((m) => m.body === b);
        if (hit()) { resolve(Date.now()); return; }
        const off = d.useDek.subscribe(() => { if (hit()) { off(); resolve(Date.now()); } });
      });
    }, body);
    const sentAt = await alice.evaluate(([c, b]) => {
      const t = Date.now();
      (window as unknown as DekWindow).__dek.actions.sendMessage({ channelId: c!, body: b! });
      return t;
    }, [general, body] as const);
    const seenAt = await bob.evaluate(() => (window as unknown as { __seen: Promise<number> }).__seen);
    latencies.push(seenAt - sentAt);
    // and it is in bob's open timeline, in order
    const inTimeline = await bob.evaluate(([c, b]) => {
      const s = (window as unknown as DekWindow).__dek.useDek.getState();
      return s.timelines[c!]!.ids.some((id) => s.messages[id]?.body === b);
    }, [general, body] as const);
    expect(inTimeline).toBe(true);
  }
  console.log(`[measured] alice to bob delivery latency ms: ${latencies.join(', ')} (median ${[...latencies].sort((a, b) => a - b)[1]})`);
  for (const l of latencies) expect(l).toBeLessThan(2_000);
  await ca.close();
  await cb.close();
});

test('DEKA03: an offline send is pending, durable in IndexedDB, and lands exactly once', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, QA.alice);
  await waitReady(page);
  const general = await channelId(page, 'general');
  const userId = await page.evaluate(() => (window as unknown as DekWindow).__dek.useDek.getState().session.userId!);

  await ctx.setOffline(true);
  const body = `e2e offline ${Date.now()}`;
  const clientId = await page.evaluate(([c, b]) => (window as unknown as DekWindow).__dek.actions.sendMessage({ channelId: c!, body: b! }), [general, body] as const);

  // visible pending state (after the 900 ms delay), retrying, text kept
  await page.waitForFunction((id) => {
    const p = (window as unknown as DekWindow).__dek.useDek.getState().pending[id];
    return !!p && p.statusVisible && (p.status === 'retrying' || p.status === 'pending');
  }, clientId, { timeout: 10_000 });
  const pending = await page.evaluate((id) => (window as unknown as DekWindow).__dek.useDek.getState().pending[id], clientId);
  expect(pending?.body).toBe(body);
  expect(pending?.status).toBe('retrying');

  // written to this person's IndexedDB before any network answer
  const stored = await page.evaluate(([uid, id]) => new Promise<unknown>((resolve) => {
    const req = indexedDB.open(`dek-${uid}`);
    req.onsuccess = () => {
      const get = req.result.transaction('outbox', 'readonly').objectStore('outbox').get(id!);
      get.onsuccess = () => { resolve(get.result ?? null); req.result.close(); };
      get.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }), [userId, clientId] as const);
  expect((stored as { clientId?: string; body?: string } | null)?.clientId).toBe(clientId);
  expect((stored as { body?: string }).body).toBe(body);

  expect(await db('select 1 from dek.messages where client_id = $1', [clientId])).toHaveLength(0);

  const back = Date.now();
  await ctx.setOffline(false);
  await page.waitForFunction((id) => !(window as unknown as DekWindow).__dek.useDek.getState().pending[id], clientId, { timeout: 30_000 });
  console.log(`[measured] offline send landed ${Date.now() - back} ms after the network came back`);

  // exactly one durable row for that client id, and it is in the timeline once
  const rows = await db<{ n: number }>('select count(*)::int as n from dek.messages where client_id = $1', [clientId]);
  expect(rows[0]!.n).toBe(1);
  const stillQueued = await page.evaluate(() => (window as unknown as DekWindow).__dek.outbox().length);
  expect(stillQueued).toBe(0);
  await ctx.close();
});

test('DEKA10: two tabs, one socket; a read in one tab clears unread in the other', async ({ browser }) => {
  const ctx = await browser.newContext();
  await countSockets(ctx);
  const tab1 = await ctx.newPage();
  await signIn(tab1, QA.alice);
  await waitReady(tab1);
  const tab2 = await ctx.newPage();
  await tab2.goto('/');
  await waitSignedIn(tab2);
  await waitReady(tab2);
  await tab1.waitForTimeout(1_500);   // let the follower settle on the leader's socket

  const sockets = async () => {
    const a = await tab1.evaluate(() => (window as unknown as DekWindow).__ws.open);
    const b = await tab2.evaluate(() => (window as unknown as DekWindow).__ws.open);
    return [a, b];
  };
  const [s1, s2] = await sockets();
  const leaders = [
    await tab1.evaluate(() => (window as unknown as DekWindow).__dek.hub.isLeader()),
    await tab2.evaluate(() => (window as unknown as DekWindow).__dek.hub.isLeader()),
  ];
  console.log(`[measured] realtime sockets open: tab1=${s1} tab2=${s2}; leader flags ${leaders.join(',')}`);
  expect(s1 + s2).toBe(1);
  expect(leaders.filter(Boolean)).toHaveLength(1);

  // bob writes in a channel alice has not open in either tab
  const cb = await browser.newContext();
  const bob = await cb.newPage();
  await signIn(bob, QA.bob);
  await waitReady(bob);
  const general = await channelId(tab1, 'general');
  await bob.evaluate((c) => (window as unknown as DekWindow).__dek.actions.sendMessage({ channelId: c, body: `e2e unread ${Date.now()}` }), general);
  for (const t of [tab1, tab2]) {
    await t.waitForFunction((c) => ((window as unknown as DekWindow).__dek.useDek.getState().channels[c]?.unread ?? 0) > 0, general, { timeout: 15_000 });
  }

  const readAt = await tab1.evaluate((c) => { const t = Date.now(); (window as unknown as DekWindow).__dek.actions.markRead(c); return t; }, general);
  // tab1 clears at once (local), tab2 when the server's read event arrives
  expect(await tab1.evaluate((c) => (window as unknown as DekWindow).__dek.useDek.getState().channels[c]!.unread, general)).toBe(0);
  await tab2.waitForFunction((c) => (window as unknown as DekWindow).__dek.useDek.getState().channels[c]!.unread === 0, general, { timeout: 15_000 });
  const clearedAt = await tab2.evaluate(() => Date.now());
  console.log(`[measured] read in tab1 cleared unread in tab2 after ${clearedAt - readAt} ms (includes the 1.5 s debounce)`);
  const serverRead = await db<{ last_read_seq: string }>(
    'select cm.last_read_seq::text from dek.channel_members cm join auth.users u on u.id = cm.user_id where cm.channel_id = $1 and u.email = $2',
    [general, QA.alice]);
  const lastSeq = await tab1.evaluate((c) => (window as unknown as DekWindow).__dek.useDek.getState().channels[c]!.last_seq, general);
  expect(Number(serverRead[0]!.last_read_seq)).toBeGreaterThanOrEqual(lastSeq);

  // the leader tab closes: the other takes the socket over
  const leaderTab = leaders[0] ? tab1 : tab2;
  const other = leaders[0] ? tab2 : tab1;
  const closedAt = Date.now();
  await leaderTab.close();
  await other.waitForFunction(() => (window as unknown as DekWindow).__dek.hub.isLeader() && (window as unknown as DekWindow).__dek.useDek.getState().connection.realtime === 'online', undefined, { timeout: 20_000 });
  console.log(`[measured] takeover after the leader tab closed: ${Date.now() - closedAt} ms`);
  expect(await other.evaluate(() => (window as unknown as DekWindow).__ws.open)).toBe(1);
  await cb.close();
  await ctx.close();
});

test('sign-out wipes IndexedDB and the person\'s local keys', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, QA.alice);
  await waitReady(page);
  const general = await channelId(page, 'general');
  const userId = await page.evaluate(() => (window as unknown as DekWindow).__dek.useDek.getState().session.userId!);
  await page.evaluate((c) => { void (window as unknown as DekWindow).__dek.actions.openChannel(c); (window as unknown as DekWindow).__dek.actions.setDraft(c, 'a draft that must not survive'); }, general);
  await page.waitForTimeout(1_500);   // draft write (400 ms) and page cache write (1 s)
  const before = await page.evaluate((uid) => Promise.all([
    indexedDB.databases().then((l) => l.map((d) => d.name)),
    Promise.resolve(Object.keys(localStorage).filter((k) => k.includes(uid!))),
  ]), userId);
  expect(before[0]).toContain(`dek-${userId}`);
  expect(before[1]).toContain(`dek.drafts.${userId}`);

  await page.evaluate(() => (window as unknown as DekWindow).__dek.actions.signOut());
  await page.waitForFunction(() => (window as unknown as DekWindow).__dek.useDek.getState().session.status === 'signed_out');
  const after = await page.evaluate((uid) => Promise.all([
    indexedDB.databases().then((l) => l.map((d) => d.name).filter((n) => n?.startsWith('dek-'))),
    Promise.resolve(Object.keys(localStorage).filter((k) => k.includes(uid!) || k === 'dek.auth')),
    Promise.resolve(Object.keys((window as unknown as DekWindow).__dek.useDek.getState().messages).length),
  ]), userId);
  console.log(`[measured] after sign-out: dek-* databases ${JSON.stringify(after[0])}, user keys ${JSON.stringify(after[1])}, messages in memory ${after[2]}`);
  expect(after[0]).toEqual([]);
  expect(after[1]).toEqual([]);
  expect(after[2]).toBe(0);
  await expect(page.getByRole('heading', { name: 'Sign in to Dek' })).toBeVisible();
  await ctx.close();
});
