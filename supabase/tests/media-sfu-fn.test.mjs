// The sfu Edge Function's request logic (supabase/functions/sfu/sfu.ts): validation
// before the gate, the gate before Cloudflare, only the caller's own SFU session, only
// tracks the gate allows, what gets recorded, and how Cloudflare's answers map to HTTP.
// Node loads the .ts file directly (type stripping). No network, no database: every
// dependency is a recording fake. Owner: lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Refusal, cloudflare, dbRefusal, handle, revoke, sameSecret } from '../functions/sfu/sfu.ts';

const CALL = '6f1c0c7e-1d4b-4a7a-9d2e-3a1f0b9c8d7e';
const SESS = '0b9c8d7e-1d4b-4a7a-9d2e-3a1f6f1c0c7e';
const USER = '11111111-2222-4333-8444-555555555555';
const CF_MINE = 'e017a2629c754fedc1f7d8587e06d126';
const CF_BOB = '2a45361d5fd7cc14eface0587c276c94';
const OFFER = { type: 'offer', sdp: 'v=0 offer' };
const ANSWER = { type: 'answer', sdp: 'v=0 answer' };

function fakes({ gate = {}, configured = true, cf = {}, publishError = null } = {}) {
  const calls = { gate: [], publish: [], cf: [] };
  const deps = {
    configured,
    gate: async (user, callId, sessionId, action, wanted) => {
      calls.gate.push({ user, callId, sessionId, action, wanted });
      if (gate.error) throw gate.error;
      return { sfu_session: CF_MINE, sfu_tracks: ['mic-1'], allowed: [], ...gate };
    },
    publish: async (user, callId, sessionId, sfuSession, change) => {
      calls.publish.push({ user, callId, sessionId, sfuSession, change });
      if (publishError) throw publishError;
      return { id: callId, version: 9 };
    },
    cf: async (method, path, body) => {
      calls.cf.push({ method, path, body });
      const key = `${method} ${path.replace(/\/sessions\/(?!new$)[^/]+/, '/sessions/:id')}`;
      const r = cf[key];
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(body);
      if (r) return r;
      if (key === 'POST /sessions/new') return { sessionId: CF_MINE };
      return {};
    },
  };
  return { deps, calls };
}

const req = (action, extra = {}) => ({ action, call_id: CALL, session_id: SESS, ...extra });

async function refused(promise, status, code) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof Refusal, `expected a Refusal, got ${e}`);
    assert.equal(e.status, status, `status (${e.code}: ${e.message})`);
    if (code) assert.equal(e.code, code);
    return e;
  }
  throw new Error(`expected ${status} ${code ?? ''}, but it succeeded`);
}

test('what a request says is checked before the gate counts it', async () => {
  const { deps, calls } = fakes();
  await refused(handle(deps, USER, null), 400, 'invalid_input');
  await refused(handle(deps, USER, req('delete')), 400);
  await refused(handle(deps, USER, { ...req('session'), call_id: 'x' }), 400);
  await refused(handle(deps, USER, req('session', { tracks: [{ mid: '0', name: 'video-1' }], offer: OFFER })), 400);
  await refused(handle(deps, USER, req('session', { tracks: [{ mid: '0', name: 'mic-1' }] })), 400, 'invalid_input');   // tracks without an offer
  await refused(handle(deps, USER, req('session', { tracks: [{ mid: '0', name: 'mic-1' }, { mid: '0', name: 'cam-2' }], offer: OFFER })), 400);
  await refused(handle(deps, USER, req('push', { sfu_session: CF_MINE, offer: ANSWER, tracks: [{ mid: '1', name: 'cam-2' }] })), 400);
  await refused(handle(deps, USER, req('pull', { sfu_session: CF_MINE, tracks: [] })), 400);
  await refused(handle(deps, USER, req('pull', { sfu_session: 'no', tracks: [{ session: CF_BOB, name: 'mic-1' }] })), 400);
  await refused(handle(deps, USER, req('renegotiate', { sfu_session: CF_MINE, answer: { type: 'answer', sdp: 'x'.repeat(256 * 1024 + 1) } })), 400);
  await refused(handle(deps, USER, req('close', { sfu_session: CF_MINE, mids: [] })), 400);
  await refused(handle(deps, USER, req('session', { epoch: -1 })), 400);
  await refused(handle(deps, USER, req('session', { epoch: 1.5 })), 400);
  await refused(handle(deps, USER, req('session', { epoch: '9' })), 400);
  assert.equal(calls.gate.length, 0);
  assert.equal(calls.cf.length, 0);
});

test('session: a new SFU session, the offer\'s tracks pushed, then recorded for everyone', async () => {
  const { deps, calls } = fakes({
    cf: { 'POST /sessions/:id/tracks/new': { sessionDescription: ANSWER, tracks: [{ mid: '0', trackName: 'mic-1' }, { mid: '1', trackName: 'cam-2', errorCode: 'invalid_params' }] } },
  });
  const out = await handle(deps, USER, req('session', { offer: OFFER, tracks: [{ mid: '0', name: 'mic-1' }, { mid: '1', name: 'cam-2' }], epoch: 1759640000123 }));
  assert.deepEqual(calls.gate, [{ user: USER, callId: CALL, sessionId: SESS, action: 'session', wanted: null }]);
  assert.deepEqual(calls.cf.map((c) => `${c.method} ${c.path}`), ['POST /sessions/new', `POST /sessions/${CF_MINE}/tracks/new`]);
  assert.deepEqual(calls.cf[1].body, {
    sessionDescription: OFFER,
    tracks: [{ location: 'local', mid: '0', trackName: 'mic-1' }, { location: 'local', mid: '1', trackName: 'cam-2' }],
  });
  assert.deepEqual(calls.publish, [{ user: USER, callId: CALL, sessionId: SESS, sfuSession: CF_MINE, change: { add: ['mic-1'], fresh: true, epoch: 1759640000123 } }],
    'only what Cloudflare took is recorded');
  assert.equal(out.sfu_session, CF_MINE);
  assert.deepEqual(out.answer, ANSWER);
  assert.equal(out.tracks.length, 2);
  assert.deepEqual(out.call, { id: CALL, version: 9 });
});

test('session without tracks (listening only): a session, nothing pushed, recorded with no tracks', async () => {
  const { deps, calls } = fakes();
  const out = await handle(deps, USER, req('session'));
  assert.deepEqual(calls.cf.map((c) => c.path), ['/sessions/new']);
  assert.deepEqual(calls.publish[0].change, { add: [], fresh: true, epoch: null });
  assert.equal(out.answer, null);
});

test('session: when it cannot be recorded (the person left meanwhile), the pushed tracks are stopped at Cloudflare', async () => {
  const { deps, calls } = fakes({ publishError: new Refusal(409, 'conflict', 'You are no longer in this call.') });
  await refused(handle(deps, USER, req('session', { offer: OFFER, tracks: [{ mid: '0', name: 'mic-1' }] })), 409, 'conflict');
  const last = calls.cf[calls.cf.length - 1];
  assert.equal(last.method, 'PUT');
  assert.equal(last.path, `/sessions/${CF_MINE}/tracks/close`);
  assert.deepEqual(last.body, { tracks: [{ mid: '0' }], force: true });
});

test('the gate decides first; secrets missing is 503 only for someone the gate let through', async () => {
  const gated = fakes({ gate: { error: new Refusal(404, 'not_found', 'That call does not exist.') }, configured: false });
  await refused(handle(gated.deps, USER, req('session')), 404, 'not_found');
  const off = fakes({ configured: false });
  await refused(handle(off.deps, USER, req('session')), 503, 'not_configured');
  assert.equal(off.calls.cf.length, 0);
});

test('push, renegotiate and close act only on the caller\'s own recorded SFU session', async () => {
  const { deps, calls } = fakes();
  for (const r of [
    req('push', { sfu_session: CF_BOB, offer: OFFER, tracks: [{ mid: '1', name: 'cam-2' }] }),
    req('renegotiate', { sfu_session: CF_BOB, answer: ANSWER }),
    req('close', { sfu_session: CF_BOB, mids: ['1'] }),
    req('pull', { sfu_session: CF_BOB, tracks: [{ session: CF_MINE, name: 'mic-1' }] }),
  ]) await refused(handle(deps, USER, r), 409, 'conflict');
  assert.equal(calls.cf.length, 0);
});

test('push: Cloudflare\'s answer back, the new track recorded', async () => {
  const { deps, calls } = fakes({ cf: { 'POST /sessions/:id/tracks/new': { sessionDescription: ANSWER, tracks: [{ mid: '2', trackName: 'screen-3' }] } } });
  const out = await handle(deps, USER, req('push', { sfu_session: CF_MINE, offer: OFFER, tracks: [{ mid: '2', name: 'screen-3' }] }));
  assert.deepEqual(out.answer, ANSWER);
  assert.deepEqual(calls.publish[0].change, { add: ['screen-3'] });
  assert.equal(calls.publish[0].sfuSession, CF_MINE);
});

test('pull: only what the gate allows reaches Cloudflare; its offer comes back to be answered', async () => {
  const wanted = [{ session: CF_BOB, name: 'mic-1' }, { session: CF_BOB, name: 'cam-2' }, { session: CF_MINE, name: 'mic-1' }];
  const { deps, calls } = fakes({
    gate: { allowed: [{ session: CF_BOB, name: 'mic-1' }] },
    cf: { 'POST /sessions/:id/tracks/new': { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'sfu offer' }, tracks: [{ mid: '3', sessionId: CF_BOB, trackName: 'mic-1' }] } },
  });
  const out = await handle(deps, USER, req('pull', { sfu_session: CF_MINE, tracks: wanted }));
  assert.deepEqual(calls.gate[0].wanted, wanted);
  assert.equal(calls.gate[0].action, 'pull');
  assert.deepEqual(calls.cf[0].body, { tracks: [{ location: 'remote', sessionId: CF_BOB, trackName: 'mic-1' }] });
  assert.deepEqual(out.offer, { type: 'offer', sdp: 'sfu offer' });
  assert.equal(out.renegotiate, true);
  assert.deepEqual(out.refused, [{ session: CF_BOB, name: 'cam-2' }, { session: CF_MINE, name: 'mic-1' }]);
  assert.equal(calls.publish.length, 0, 'pulling records nothing');

  const none = fakes({ gate: { allowed: [] } });
  const nothing = await handle(none.deps, USER, req('pull', { sfu_session: CF_MINE, tracks: wanted }));
  assert.equal(none.calls.cf.length, 0);
  assert.equal(nothing.offer, null);
  assert.equal(nothing.renegotiate, false);
});

test('renegotiate: the answer goes to Cloudflare as is', async () => {
  const { deps, calls } = fakes();
  assert.deepEqual(await handle(deps, USER, req('renegotiate', { sfu_session: CF_MINE, answer: ANSWER })), {});
  assert.deepEqual(calls.cf, [{ method: 'PUT', path: `/sessions/${CF_MINE}/renegotiate`, body: { sessionDescription: ANSWER } }]);
});

test('close: negotiated with an offer, forced without; own names unpublished even when Cloudflare fails', async () => {
  const ok = fakes({ cf: { 'PUT /sessions/:id/tracks/close': { sessionDescription: ANSWER, tracks: [{ mid: '1' }] } } });
  const out = await handle(ok.deps, USER, req('close', { sfu_session: CF_MINE, mids: ['1', '1'], offer: OFFER, names: ['mic-1', 'cam-9'] }));
  assert.deepEqual(ok.calls.cf[0].body, { tracks: [{ mid: '1' }], sessionDescription: OFFER, force: false });
  assert.deepEqual(ok.calls.publish[0].change, { remove: ['mic-1'] }, 'cam-9 is not published by this person: left alone');
  assert.deepEqual(out.answer, ANSWER);

  const forced = fakes();
  await handle(forced.deps, USER, req('close', { sfu_session: CF_MINE, mids: ['4'] }));
  assert.deepEqual(forced.calls.cf[0].body, { tracks: [{ mid: '4' }], force: true });
  assert.equal(forced.calls.publish.length, 0);

  const gone = fakes({ cf: { 'PUT /sessions/:id/tracks/close': new Refusal(502, 'sfu_error', 'gone', { code: 'session_error', status: 410 }) } });
  const e = await refused(handle(gone.deps, USER, req('close', { sfu_session: CF_MINE, mids: ['0'], names: ['mic-1'] })), 502, 'sfu_error');
  assert.deepEqual(e.extra, { code: 'session_error', status: 410 });
  assert.deepEqual(gone.calls.publish[0].change, { remove: ['mic-1'] });
});

test('cloudflare(): the app token in the header only, errors mapped, logs without ids or secrets', async () => {
  const seen = [];
  const logs = [];
  const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let next = () => respond(201, { sessionId: CF_MINE });
  const api = cloudflare(async (url, init) => { seen.push({ url, init }); return next(); }, 'app-1', 'tok-secret', (m) => logs.push(m));

  assert.deepEqual(await api('POST', '/sessions/new'), { sessionId: CF_MINE });
  assert.equal(seen[0].url, 'https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/new');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tok-secret');
  assert.equal(seen[0].init.body, undefined);

  next = () => respond(410, { errorCode: 'session_error', errorDescription: 'Session is not active' });
  const e1 = await refused(api('PUT', `/sessions/${CF_MINE}/renegotiate`, { sessionDescription: ANSWER }), 502, 'sfu_error');
  assert.deepEqual(e1.extra, { code: 'session_error', status: 410 });
  assert.equal(e1.message, 'Session is not active');

  next = () => respond(200, { errorCode: 'invalid_session_description', errorDescription: 'bad sdp' });
  await refused(api('PUT', `/sessions/${CF_MINE}/renegotiate`, {}), 502, 'sfu_error');

  next = () => respond(401, { errorCode: 'unauthorized' });
  await refused(api('POST', '/sessions/new'), 503, 'not_configured');
  next = () => respond(404, { errorCode: 'not_found' });
  await refused(api('POST', '/sessions/new'), 503, 'not_configured');
  next = () => { throw new TypeError('fetch failed'); };
  await refused(api('POST', '/sessions/new'), 503, 'unavailable');

  assert.ok(logs.length >= 4);
  for (const l of logs) {
    assert.ok(!l.includes('tok-secret') && !l.includes(CF_MINE) && !l.includes('app-1'), `log leaks: ${l}`);
  }
});

test('revoke (from the database): every live track of the session stops at Cloudflare; a gone session is nothing to do', async () => {
  const live = fakes({ cf: { 'GET /sessions/:id': { tracks: [
    { location: 'local', mid: '0', trackName: 'mic-1', status: 'active' },
    { location: 'remote', mid: '3', sessionId: CF_BOB, trackName: 'mic-1', status: 'active' },
    { location: 'remote', mid: '4', sessionId: CF_BOB, trackName: 'cam-2', status: 'inactive' },
  ] } } });
  assert.deepEqual(await revoke(live.deps, { action: 'revoke', sfu_session: CF_MINE }), { closed: 2 });
  assert.deepEqual(live.calls.cf.map((c) => `${c.method} ${c.path}`), [`GET /sessions/${CF_MINE}`, `PUT /sessions/${CF_MINE}/tracks/close`]);
  assert.deepEqual(live.calls.cf[1].body, { tracks: [{ mid: '0' }, { mid: '3' }], force: true });
  assert.equal(live.calls.gate.length, 0, 'no person, no gate: the database asked');

  const gone = fakes({ cf: { 'GET /sessions/:id': new Refusal(502, 'sfu_error', 'gone', { code: 'session_error', status: 410 }) } });
  assert.deepEqual(await revoke(gone.deps, { action: 'revoke', sfu_session: CF_MINE }), { closed: 0 });
  const empty = fakes({ cf: { 'GET /sessions/:id': { tracks: [] } } });
  assert.deepEqual(await revoke(empty.deps, { action: 'revoke', sfu_session: CF_MINE }), { closed: 0 });
  assert.equal(empty.calls.cf.length, 1);

  await refused(revoke(live.deps, { action: 'pull', sfu_session: CF_MINE }), 400);
  await refused(revoke(live.deps, { action: 'revoke', sfu_session: 'x' }), 400);
  await refused(revoke(fakes({ configured: false }).deps, { action: 'revoke', sfu_session: CF_MINE }), 503, 'not_configured');
  await refused(handle(live.deps, USER, req('revoke', { sfu_session: CF_MINE })), 400, 'invalid_input');   // never from a person
});

test('sameSecret: equal strings only, empty never', async () => {
  assert.equal(await sameSecret('internal-secret-value', 'internal-secret-value'), true);
  assert.equal(await sameSecret('internal-secret-value', 'internal-secret-valuf'), false);
  assert.equal(await sameSecret('', ''), false);
  assert.equal(await sameSecret('x', ''), false);
});

test('dbRefusal: the database\'s codes become HTTP statuses; anything else is 503', () => {
  assert.equal(dbRefusal({ message: 'conflict', hint: 'You are no longer in this call.' }).status, 409);
  assert.equal(dbRefusal({ message: 'conflict', hint: 'You are no longer in this call.' }).message, 'You are no longer in this call.');
  assert.equal(dbRefusal({ message: 'not_found' }).status, 404);
  assert.equal(dbRefusal({ message: 'rate_limited', hint: 'Try again in 20 seconds.' }).status, 429);
  assert.equal(dbRefusal({ message: 'TypeError: fetch failed' }).status, 503);
  assert.equal(dbRefusal(null).code, 'unavailable');
});
