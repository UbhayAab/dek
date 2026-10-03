// DEK21 to DEK24, DEKA12, DEKA13 end to end against the real project: real
// start_call, answer_call, join_room, the realtime hub carrying signaling on
// call:<id>, the deployed turn function, and WebRTC between headless browsers
// with fake microphones and cameras (silent: --mute-audio, no ringtone under
// automation).
import { expect, test, type Page } from '@playwright/test';
import { audit, leaveStaleCalls, person, shotPath, world, type Person } from './support';

interface PeerStat {
  sessionId: string;
  userId: string;
  connectionState: string;
  localTypes: string[];
  gathered: string[];
  turnServers: number;
  selected: { local: string | null; remote: string | null };
}

interface CallInfo {
  status: string;
  final: boolean;
  callId: string | null;
  sessionId: string | null;
  relay: boolean | null;
  relayWarning: boolean;
  cameraOn: boolean;
  peers: number;
}

async function info(page: Page): Promise<CallInfo> {
  return page.evaluate(() => {
    const v = (window as unknown as { __media: { callEngine: { view: Record<string, unknown> } } }).__media.callEngine.view;
    return {
      status: v.status as string, final: v.final as boolean, callId: v.callId as string | null, sessionId: v.sessionId as string | null,
      relay: v.relay as boolean | null, relayWarning: v.relayWarning as boolean, cameraOn: v.cameraOn as boolean,
      peers: Object.keys(v.peers as object).length,
    };
  });
}

async function stats(page: Page): Promise<PeerStat[]> {
  return page.evaluate(() => (window as unknown as { __media: { stats(): Promise<PeerStat[]> } }).__media.stats());
}

// Every link of this page is connected, and there are `n` of them.
async function connected(page: Page, n: number): Promise<boolean> {
  const s = await stats(page);
  return s.length === n && s.every((x) => x.connectionState === 'connected');
}

async function roster(page: Page, callId: string): Promise<{ user: string; state: string; session: string | null }[]> {
  return page.evaluate(async (id) => {
    const m = (window as unknown as { __media: { api: { getCall(c: string): Promise<{ participants: { user_id: string; state: string; session_id: string | null }[] }> } } }).__media;
    return (await m.api.getCall(id)).participants.map((p) => ({ user: p.user_id, state: p.state, session: p.session_id }));
  }, callId);
}

async function forceRelay(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.setItem('dek.calls.forceRelay', '1'));
}

async function close(...people: Person[]): Promise<void> {
  await Promise.all(people.map((p) => p.context.close()));
}

test.describe.configure({ mode: 'serial' });

test('alice calls bob in their DM: ringing, the incoming sheet, accept, both connected (DEKA12, open network)', async ({ browser }) => {
  const w = await world();
  const alice = await person(browser, 'alice', { channel: w.dm });
  const bob = await person(browser, 'bob', { channel: w.dm });
  await leaveStaleCalls(alice.page, w.org);
  await leaveStaleCalls(bob.page, w.org);

  await alice.page.getByRole('button', { name: 'Start a voice call' }).click();
  await expect(alice.page.locator('.dc-panel .dc-status')).toHaveText(/Ringing/, { timeout: 20_000 });

  const sheet = bob.page.locator('.dc-incoming');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect(sheet).toContainText('Alice Member');
  await expect(sheet).toContainText('Incoming voice call');
  await bob.page.screenshot({ path: shotPath('incoming-1280x800') });
  expect(await audit(bob.page, '.dc-incoming', 24)).toEqual([]);

  await sheet.getByRole('button', { name: /^Accept the voice call/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => connected(alice.page, 1), { timeout: 45_000 }).toBe(true);
  await expect.poll(() => connected(bob.page, 1), { timeout: 45_000 }).toBe(true);
  await expect(alice.page.locator('.dc-panel .dc-status')).toHaveText(/Connected/);
  await expect(bob.page.locator('.dc-panel .dc-status')).toHaveText(/Connected/);

  // What path the call took, and whether the TURN relay offered candidates (a
  // relay allocation takes a moment longer than the direct path on one machine).
  const ai = await info(alice.page);
  const bi = await info(bob.page);
  expect(ai.relay).toBe(true);
  expect(bi.relay).toBe(true);
  const a0 = await stats(alice.page);
  const b0 = await stats(bob.page);
  console.log(`DM call: relay from turn=${ai.relay}/${bi.relay}; TURN servers configured alice=${a0[0]?.turnServers} bob=${b0[0]?.turnServers}; alice gathered [${a0[0]?.gathered.join(', ')}] stats [${a0[0]?.localTypes.join(', ')}]; bob gathered [${b0[0]?.gathered.join(', ')}] stats [${b0[0]?.localTypes.join(', ')}]; selected ${a0[0]?.selected.local}/${a0[0]?.selected.remote}`);
  // Whichever side offered (the session ids decide) gathers relay candidates. The
  // answerer reaches it over host candidates within milliseconds when both
  // browsers run on one machine, and Chrome then ends the answerer's gathering
  // before STUN and TURN answer (reproduced with two bare RTCPeerConnections, no
  // Dek code). Both sides' relay paths are proven by the relay-only test below.
  await expect.poll(async () => [...((await stats(alice.page))[0]?.gathered ?? []), ...((await stats(bob.page))[0]?.gathered ?? [])],
    { timeout: 20_000 }).toContain('relay');
  const a = await stats(alice.page);
  const b = await stats(bob.page);
  console.log(`DM call (later): alice gathered [${a[0]?.gathered.join(', ')}], bob gathered [${b[0]?.gathered.join(', ')}], selected ${a[0]?.selected.local}/${a[0]?.selected.remote}`);

  // the call view, then the speaking ring from the fake microphone's tone
  await expect(alice.page.locator('.dc-tile.is-speaking').first()).toBeVisible({ timeout: 15_000 });
  await alice.page.screenshot({ path: shotPath('call-view-1280x800') });
  expect(await audit(alice.page, '.dc-panel', 24)).toEqual([]);

  // mute is a real switch on the outgoing track
  await alice.page.getByRole('button', { name: 'Mute', exact: true }).click();
  expect(await alice.page.evaluate(() => (window as unknown as { __media: { callEngine: { view: { muted: boolean; local: MediaStream | null } } } }).__media.callEngine.view.local?.getAudioTracks().every((t) => !t.enabled))).toBe(true);
  await alice.page.getByRole('button', { name: 'Unmute', exact: true }).click();

  // a 1:1 call ends for both when one side leaves
  await bob.page.getByRole('button', { name: 'End', exact: true }).click();
  await expect(bob.page.locator('.dc-final')).toContainText('Call ended');
  await expect(alice.page.locator('.dc-final')).toContainText('Call ended', { timeout: 20_000 });
  expect((await info(alice.page)).final).toBe(true);
  await close(alice, bob);
});

test('a declined call says so to the caller', async ({ browser }) => {
  const w = await world();
  const alice = await person(browser, 'alice', { channel: w.dm });
  const bob = await person(browser, 'bob', { channel: w.dm });
  await leaveStaleCalls(alice.page, w.org);
  await leaveStaleCalls(bob.page, w.org);
  await alice.page.getByRole('button', { name: 'Start a voice call' }).click();
  const sheet = bob.page.locator('.dc-incoming');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await sheet.getByRole('button', { name: /^Decline/ }).click();
  await expect(sheet).toHaveCount(0);
  await expect(alice.page.locator('.dc-final')).toContainText('Call declined', { timeout: 20_000 });
  expect((await info(alice.page)).status).toBe('declined');
  await close(alice, bob);
});

test('a video call forced through the TURN relay connects, on a phone (DEKA12, restrictive network)', async ({ browser }) => {
  const w = await world();
  const alice = await person(browser, 'alice', { channel: w.dm });
  const bob = await person(browser, 'bob', { channel: w.dm, phone: true });
  await leaveStaleCalls(alice.page, w.org);
  await leaveStaleCalls(bob.page, w.org);
  // iceTransportPolicy 'relay': no direct path is even tried, exactly what a
  // carrier NAT or an office firewall leaves.
  await forceRelay(alice.page);
  await forceRelay(bob.page);

  await alice.page.getByRole('button', { name: 'Start a video call' }).click();
  const sheet = bob.page.locator('.dc-incoming');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect(sheet).toContainText('Incoming video call');
  await bob.page.screenshot({ path: shotPath('incoming-390x844') });
  expect(await audit(bob.page, '.dc-incoming', 44)).toEqual([]);

  await sheet.getByRole('button', { name: /^Accept the video call/ }).click();
  await expect(bob.page.locator('.dc-full')).toBeVisible();
  await expect.poll(() => connected(alice.page, 1), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => connected(bob.page, 1), { timeout: 60_000 }).toBe(true);
  const a = await stats(alice.page);
  const b = await stats(bob.page);
  console.log(`Relay-only call: alice selected ${a[0]?.selected.local}/${a[0]?.selected.remote}, bob selected ${b[0]?.selected.local}/${b[0]?.selected.remote}; gathered alice [${a[0]?.localTypes.join(', ')}] bob [${b[0]?.localTypes.join(', ')}]`);
  expect(a[0]?.gathered).toEqual(['relay']);
  expect(a[0]?.selected.local).toBe('relay');
  expect(b[0]?.selected.local).toBe('relay');

  // both cameras arrive: the far side's video plays
  await expect.poll(() => bob.page.locator('.dc-tile.has-video video').count(), { timeout: 30_000 }).toBe(2);
  await expect(bob.page.locator('.dc-full .dc-status')).toHaveText(/Connected/);
  await bob.page.waitForTimeout(800);
  await bob.page.screenshot({ path: shotPath('call-view-390x844') });
  expect(await audit(bob.page, '.dc-full', 44)).toEqual([]);

  // camera off really releases the camera; on again sends a new track
  await bob.page.getByRole('button', { name: 'Camera off' }).click();
  await expect.poll(async () => (await info(bob.page)).cameraOn).toBe(false);
  expect(await bob.page.evaluate(() => (window as unknown as { __media: { callEngine: { view: { local: MediaStream | null } } } }).__media.callEngine.view.local?.getVideoTracks().length ?? 0)).toBe(0);
  await bob.page.getByRole('button', { name: 'Camera on' }).click();
  await expect.poll(async () => (await info(bob.page)).cameraOn).toBe(true);

  // back to chat and into the call again through the pill
  await bob.page.getByRole('button', { name: 'Back to chat' }).click();
  await expect(bob.page.locator('.dc-pill')).toBeVisible();
  expect(await audit(bob.page, '.dc-pill', 44)).toEqual([]);
  await bob.page.locator('.dc-pill__main').click();
  await expect(bob.page.locator('.dc-full')).toBeVisible();

  await alice.page.getByRole('button', { name: 'End', exact: true }).click();
  await expect(bob.page.locator('.dc-final')).toContainText('Call ended', { timeout: 20_000 });
  await close(alice, bob);
});

test('three people in the huddle; one leaves and rejoins, then reconnects from another device: never a duplicate (DEKA13)', async ({ browser }) => {
  const w = await world();
  const alice = await person(browser, 'alice', { channel: w.huddle });
  const bob = await person(browser, 'bob', { channel: w.huddle });
  const admin = await person(browser, 'admin', { channel: w.huddle });
  for (const p of [alice, bob, admin]) await leaveStaleCalls(p.page, w.org);

  for (const p of [alice, bob, admin]) {
    await p.page.locator('.dc-room').getByRole('button', { name: 'Join room' }).click();
    await expect(p.page.locator('.dc-room').getByRole('button', { name: 'Leave room' })).toBeVisible({ timeout: 20_000 });
  }
  for (const p of [alice, bob, admin]) await expect.poll(() => connected(p.page, 2), { timeout: 60_000 }).toBe(true);
  const callId = (await info(alice.page)).callId as string;
  await expect(alice.page.locator('.dc-room__count')).toHaveText('3 of 8 people here');
  await alice.page.screenshot({ path: shotPath('room-1280x800') });
  expect(await audit(alice.page, '.dc-room', 24)).toEqual([]);

  // bob leaves: the other two carry on together
  const bobFirstSession = (await info(bob.page)).sessionId;
  await bob.page.locator('.dc-room').getByRole('button', { name: 'Leave room' }).click();
  await expect(bob.page.locator('.dc-room').getByRole('button', { name: 'Join room' })).toBeVisible({ timeout: 20_000 });
  for (const p of [alice, admin]) await expect.poll(() => connected(p.page, 1), { timeout: 30_000 }).toBe(true);
  await expect(alice.page.locator('.dc-room__count')).toHaveText('2 of 8 people here', { timeout: 20_000 });

  // bob comes back: a new session, the same participant row
  await bob.page.locator('.dc-room').getByRole('button', { name: 'Join room' }).click();
  for (const p of [alice, bob, admin]) await expect.poll(() => connected(p.page, 2), { timeout: 60_000 }).toBe(true);
  const bobSecondSession = (await info(bob.page)).sessionId;
  expect(bobSecondSession).not.toBe(bobFirstSession);
  let rows = await roster(alice.page, callId);
  expect(rows.filter((r) => r.user === w.users.bob)).toHaveLength(1);
  expect(rows.filter((r) => r.state === 'joined')).toHaveLength(3);
  await expect(alice.page.locator(`.dc-room__person[data-user="${w.users.bob}"]`)).toHaveCount(1);
  await expect(alice.page.locator('.dc-room__count')).toHaveText('3 of 8 people here');

  // bob joins again from another device without leaving: the server moves the
  // same row to the new session; the old tab is told, the others reconnect
  const bob2 = await person(browser, 'bob', { channel: w.huddle });
  await bob2.page.locator('.dc-room').getByRole('button', { name: 'Join room' }).click();
  await expect(bob.page.locator('.dc-final')).toContainText('The call moved to another device', { timeout: 20_000 });
  for (const p of [alice, bob2, admin]) await expect.poll(() => connected(p.page, 2), { timeout: 60_000 }).toBe(true);
  rows = await roster(alice.page, callId);
  expect(rows.filter((r) => r.user === w.users.bob)).toHaveLength(1);
  expect(rows.find((r) => r.user === w.users.bob)?.session).toBe((await info(bob2.page)).sessionId);
  expect(rows.filter((r) => r.state === 'joined')).toHaveLength(3);
  await expect(admin.page.locator(`.dc-room__person[data-user="${w.users.bob}"]`)).toHaveCount(1);

  for (const p of [alice, bob2, admin]) await p.page.locator('.dc-room').getByRole('button', { name: 'Leave room' }).click();
  await expect.poll(async () => (await roster(alice.page, callId)).filter((r) => r.state === 'joined').length, { timeout: 20_000 }).toBe(0);
  await close(alice, bob, bob2, admin);
});
