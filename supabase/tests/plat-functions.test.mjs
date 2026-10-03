// Unit tests for the pure parts of the plat Edge Functions: the push-dispatch
// orchestration, error mapping and FCM/APNs adapters, and the auth-email hook logic.
// Node loads the .ts files directly (type stripping). No network: every fetch here is
// a recording fake. Owner: plat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHmac, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import * as lib from '../functions/push-dispatch/lib.ts';
import { makeFcmSender, fcmOutcome } from '../functions/push-dispatch/fcm.ts';
import { makeApnsSender, apnsOutcome } from '../functions/push-dispatch/apns.ts';
import { verifyWebhook, mailsFor, undeliverable } from '../functions/auth-email/hook.ts';

const delivery = (over = {}) => ({
  user_id: 'u1',
  device: { id: 'd1', kind: 'webpush', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a' },
  title: 'Alice in #general', body: 'hi', url: '/o/1/c/2/m/3', tag: 'c:2', org_id: 'o1', org_short_name: 'JCF',
  preview: 'full', urgency: 'normal', ...over,
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init, calls.length) ?? {};
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

function jwtParts(jwt) {
  const [h, c, s] = jwt.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')),
           signed: Buffer.from(`${h}.${c}`), sig: Buffer.from(s, 'base64url') };
}

test('safeEqual, pickKey, topicFor', async () => {
  assert.equal(await lib.safeEqual('s3cret-value', 's3cret-value'), true);
  assert.equal(await lib.safeEqual('s3cret-value', 's3cret-valuf'), false);
  assert.equal(await lib.safeEqual('short', 'a much longer value'), false);
  assert.equal(await lib.safeEqual('', 'x'), false);
  assert.equal(lib.pickKey('{"default":"sb_secret_abc"}', 'sb_secret_'), 'sb_secret_abc');
  assert.equal(lib.pickKey('["eyJ.legacy", "sb_secret_x"]', 'sb_secret_'), 'sb_secret_x');
  assert.equal(lib.pickKey('eyJ.a, sb_publishable_p', 'sb_publishable_'), 'sb_publishable_p');
  assert.equal(lib.pickKey('', 'sb_secret_'), '');
  assert.equal(lib.pickKey('{"default":"eyJ.only"}', 'sb_secret_'), '');
  assert.equal(lib.clip('bad\u0000byte\r\n  and\ttabs'), 'bad byte and tabs', 'jsonb cannot store a NUL byte');
  assert.equal(lib.clip('x'.repeat(500)).length, 300);
  const t = lib.topicFor('c:6f1c0c7e-1d4b-4a7a-9d2e-3a1f0b9c8d7e');
  assert.match(t, /^[A-Za-z0-9_-]{32}$/, 'web push Topic: at most 32 URL-safe base64 characters');
  assert.equal(t, lib.topicFor('c:6f1c0c7e-1d4b-4a7a-9d2e-3a1f0b9c8d7e'));
  assert.notEqual(t, lib.topicFor('t:6f1c0c7e-1d4b-4a7a-9d2e-3a1f0b9c8d7e'));
});

test('vapidProblem: only a matching P-256 pair passes (legacy fault 4)', () => {
  const a = createECDH('prime256v1');
  a.generateKeys();
  const b = createECDH('prime256v1');
  b.generateKeys();
  const pub = a.getPublicKey('base64url');
  const priv = a.getPrivateKey('base64url');
  assert.equal(lib.vapidProblem(pub, priv), null);
  assert.equal(lib.vapidProblem(`${pub}=`, priv), null, 'padding is tolerated');
  assert.match(lib.vapidProblem(b.getPublicKey('base64url'), priv), /not the public half/);
  assert.match(lib.vapidProblem('', priv), /not set/);
  assert.match(lib.vapidProblem(pub, 'garbage!'), /not a P-256 private key|not the public half/);
});

test('withTimeout and runPool: deadlines and a hard concurrency cap', async () => {
  assert.equal(await lib.withTimeout(Promise.resolve(7), 50, 'late'), 7);
  await assert.rejects(lib.withTimeout(new Promise(() => {}), 20, 'late'), /late/);
  let inFlight = 0;
  let peak = 0;
  const out = await lib.runPool(Array.from({ length: 50 }, (_, i) => i), 20, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2 + (i % 5)));
    inFlight -= 1;
    return i * 2;
  });
  assert.equal(peak, 20);
  assert.deepEqual(out, Array.from({ length: 50 }, (_, i) => i * 2), 'results keep the input order');
  assert.deepEqual(await lib.runPool([], 20, async () => 1), []);
});

test('deliverAll: adapter per device kind, payload, TTL, urgency, topic; failures become results', async () => {
  const seen = [];
  const ok = (name) => async (d, payload, opt) => { seen.push({ name, d, payload, opt }); return { status: 'sent', http_status: 201 }; };
  const senders = { webpush: ok('webpush'), fcm: ok('fcm'), apns: ok('apns') };
  const items = [
    delivery(),
    delivery({ user_id: 'u2', device: { id: 'd2', kind: 'fcm', endpoint: 'tok' }, urgency: 'high' }),
    delivery({ user_id: 'u3', device: { id: 'd3', kind: 'apns', endpoint: 'ab'.repeat(32) } }),
  ];
  const res = await lib.deliverAll(items, senders, { kind: 'message', intentId: 42, concurrency: 20, timeoutMs: 1000,
                                                     deadline: Date.now() + 10_000, now: () => 1_700_000_000_000 });
  assert.deepEqual(res.map((r) => [r.device_id, r.status, r.http_status]), [['d1', 'sent', 201], ['d2', 'sent', 201], ['d3', 'sent', 201]]);
  assert.deepEqual(seen.map((s) => s.name), ['webpush', 'fcm', 'apns']);
  assert.deepEqual(seen[0].payload, { title: 'Alice in #general', body: 'hi', url: '/o/1/c/2/m/3', tag: 'c:2', org_id: 'o1',
                                      org: 'JCF', kind: 'message', intent_id: 42, ts: 1_700_000_000_000 });
  assert.deepEqual(seen[0].opt, { ttl: 3600, urgency: 'normal', topic: lib.topicFor('c:2') });
  assert.equal(seen[1].opt.urgency, 'high');
  const call = await lib.deliverAll([delivery({ tag: 'call:9', urgency: 'high' })], senders,
    { kind: 'call', intentId: 1, concurrency: 1, timeoutMs: 1000, deadline: Date.now() + 1000 });
  assert.equal(call[0].status, 'sent');
  assert.equal(seen.at(-1).opt.ttl, 45, 'a call push lives 45 s');

  let touched = false;
  const failing = {
    webpush: async () => { throw new Error('socket hang up'); },
    fcm: () => new Promise(() => {}),
    apns: async () => { touched = true; return { status: 'sent' }; },
  };
  const bad = await lib.deliverAll([delivery(), delivery({ device: { id: 'd2', kind: 'fcm', endpoint: 't' } }),
    delivery({ device: { id: 'd4', kind: 'carrier-pigeon', endpoint: 'x' } })], failing,
    { kind: 'message', intentId: 1, concurrency: 5, timeoutMs: 30, deadline: Date.now() + 1000 });
  assert.deepEqual(bad.map((r) => [r.status, r.http_status]), [['failed', null], ['failed', null], ['not_configured', null]]);
  assert.match(bad[0].reason, /socket hang up/);
  assert.match(bad[1].reason, /^timeout/);
  const late = await lib.deliverAll([delivery({ device: { id: 'd5', kind: 'apns', endpoint: 'x' } })], failing,
    { kind: 'message', intentId: 1, concurrency: 5, timeoutMs: 30, deadline: Date.now() - 1 });
  assert.deepEqual([late[0].status, late[0].reason, touched], ['failed', 'deadline: not attempted', false],
    'past the budget nothing is attempted, and the retry picks it up');
  assert.deepEqual(lib.tally([...res, ...bad]), { sent: 3, failed: 2, expired: 0, not_configured: 1 });
});

test('webpushOutcome: dead subscriptions are expired, everything else is a failure with its status', () => {
  const o = (statusCode, body, message) => lib.webpushOutcome(Object.assign(new Error(message ?? 'Received unexpected response code'),
    statusCode === undefined ? {} : { statusCode, body }));
  assert.deepEqual([o(410, '').status, o(410, '').http_status], ['expired', 410]);
  assert.equal(o(404, 'not found').status, 'expired');
  assert.equal(o(400, '{"reason":"VapidPkHashMismatch"}').status, 'expired');
  assert.equal(o(403, 'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.').status, 'expired');
  assert.deepEqual([o(500, 'oops').status, o(500, 'oops').http_status], ['failed', 500]);
  assert.deepEqual([o(429, 'slow down').status, o(429, '').http_status], ['failed', 429]);
  assert.deepEqual([o(403, 'invalid JWT').status], ['failed'], 'a 403 for any other reason is ours to fix, not the device');
  assert.deepEqual([o(undefined, '', 'getaddrinfo ENOTFOUND').status, o(undefined, '', 'x').http_status], ['failed', null]);
  assert.equal(o(undefined, '', 'The subscription p256dh value should be 65 bytes long.').status, 'expired');
});

test('FCM adapter: not configured until a service account exists', async () => {
  const send = makeFcmSender(undefined);
  assert.deepEqual(await send(delivery(), {}, {}), { status: 'not_configured', reason: 'FCM is not configured (FCM_SERVICE_ACCOUNT_JSON)', http_status: null });
  assert.equal((await makeFcmSender('{"not":"a service account"}')(delivery(), {}, {})).status, 'not_configured');
});

test('FCM adapter: RS256 bearer grant cached, HTTP v1 message, error mapping', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const sa = JSON.stringify({ project_id: 'dek-test', client_email: 'push@dek-test.iam.gserviceaccount.com', private_key: privateKey });
  let mode = 'ok';
  const fetchFn = fakeFetch((url) => {
    if (url === 'https://oauth2.googleapis.com/token') return { body: JSON.stringify({ access_token: 'ya29.token', expires_in: 3600 }) };
    if (mode === 'gone') return { status: 404, body: JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }) };
    if (mode === 'busy') return { status: 503, body: JSON.stringify({ error: { status: 'UNAVAILABLE' } }) };
    if (mode === 'auth') return { status: 401, body: '{}' };
    return { body: JSON.stringify({ name: 'projects/dek-test/messages/1' }) };
  });
  const send = makeFcmSender(sa, fetchFn, () => 1_700_000_000_000);
  const d = delivery({ device: { id: 'f1', kind: 'fcm', endpoint: 'fcm-token-1' }, urgency: 'high' });
  const payload = lib.buildPayload(d, 'message', 7, 1);
  assert.deepEqual(await send(d, payload, { ttl: 3600, urgency: 'high', topic: 't' }), { status: 'sent', reason: null, http_status: 200 });
  await send(d, payload, { ttl: 3600, urgency: 'normal', topic: 't' });
  const tokenCalls = fetchFn.calls.filter((c) => c.url.includes('oauth2'));
  assert.equal(tokenCalls.length, 1, 'one token exchange for many sends');
  const assertion = new URLSearchParams(tokenCalls[0].init.body).get('assertion');
  const j = jwtParts(assertion);
  assert.deepEqual(j.header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(j.claims.iss, 'push@dek-test.iam.gserviceaccount.com');
  assert.equal(j.claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(j.claims.exp - j.claims.iat, 3600);
  assert.ok(verify('sha256', j.signed, publicKey, j.sig), 'the grant is signed by the service account key');
  const sendCall = fetchFn.calls.find((c) => c.url.includes('messages:send'));
  assert.equal(sendCall.url, 'https://fcm.googleapis.com/v1/projects/dek-test/messages:send');
  assert.equal(sendCall.init.headers.Authorization, 'Bearer ya29.token');
  const msg = JSON.parse(sendCall.init.body).message;
  assert.equal(msg.token, 'fcm-token-1');
  assert.deepEqual(msg.notification, { title: 'Alice in #general', body: 'hi' });
  assert.equal(msg.data.intent_id, '7', 'FCM data values are strings');
  assert.deepEqual(msg.android, { priority: 'HIGH', ttl: '3600s', notification: { tag: 'c:2' } });
  mode = 'gone';
  assert.deepEqual((await send(d, payload, { ttl: 3600, urgency: 'high' })).status, 'expired');
  mode = 'busy';
  assert.deepEqual([(await send(d, payload, { ttl: 3600 })).status, (await send(d, payload, { ttl: 3600 })).http_status], ['failed', 503]);
  mode = 'auth';
  await send(d, payload, { ttl: 3600 });
  mode = 'ok';
  await send(d, payload, { ttl: 3600 });
  assert.equal(fetchFn.calls.filter((c) => c.url.includes('oauth2')).length, 2, 'a 401 throws the cached token away');
  // A wrong Firebase project answers like this for every token: fail, never revoke.
  assert.equal(fcmOutcome(400, '{"error":{"message":"The registration token is not a valid FCM registration token"}}').status, 'failed');
  assert.equal(fcmOutcome(403, '{"error":{"details":[{"errorCode":"SENDER_ID_MISMATCH"}]}}').status, 'failed');
  assert.equal(fcmOutcome(404, '{"error":{"status":"NOT_FOUND","message":"Requested entity was not found."}}').status, 'failed');
  assert.equal(fcmOutcome(404, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}').status, 'expired');
  assert.equal(fcmOutcome(429, '{"error":{"details":[{"errorCode":"QUOTA_EXCEEDED"}]}}').status, 'failed');
  const broken = makeFcmSender(sa, fakeFetch(() => ({ status: 400, body: '{"error":"invalid_grant"}' })));
  const r = await broken(d, payload, { ttl: 3600 });
  assert.deepEqual([r.status, r.http_status], ['failed', null]);
  assert.match(r.reason, /token exchange failed: HTTP 400/);
});

test('APNs adapter: ES256 provider token, headers, sandbox host, error mapping', async () => {
  assert.equal((await makeApnsSender({})(delivery(), {}, {})).status, 'not_configured');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let reply = { status: 200, body: '' };
  const fetchFn = fakeFetch(() => reply);
  const cfg = { keyId: 'KEY123', teamId: 'TEAM45', privateKey, topic: 'care.jarurat.dek' };
  const send = makeApnsSender(cfg, fetchFn, () => 1_700_000_000_000);
  const token = 'ab'.repeat(32);
  const d = delivery({ device: { id: 'a1', kind: 'apns', endpoint: token }, urgency: 'high', tag: 'call:9' });
  const payload = lib.buildPayload(d, 'call', 3, 1);
  assert.deepEqual(await send(d, payload, { ttl: 45, urgency: 'high' }), { status: 'sent', reason: null, http_status: 200 });
  const c = fetchFn.calls[0];
  assert.equal(c.url, `https://api.push.apple.com/3/device/${token}`);
  assert.equal(c.init.headers['apns-topic'], 'care.jarurat.dek');
  assert.equal(c.init.headers['apns-push-type'], 'alert');
  assert.equal(c.init.headers['apns-priority'], '10');
  assert.equal(c.init.headers['apns-collapse-id'], 'call:9');
  assert.equal(c.init.headers['apns-expiration'], String(1_700_000_000 + 45));
  const body = JSON.parse(c.init.body);
  assert.deepEqual(body.aps.alert, { title: 'Alice in #general', body: 'hi' });
  assert.equal(body.url, '/o/1/c/2/m/3');
  const j = jwtParts(c.init.headers.authorization.replace(/^bearer /, ''));
  assert.deepEqual(j.header, { alg: 'ES256', kid: 'KEY123' });
  assert.deepEqual(j.claims, { iss: 'TEAM45', iat: 1_700_000_000 });
  assert.ok(verify('sha256', j.signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, j.sig), 'ES256 over the p8 key');
  await send(d, payload, { ttl: 45, urgency: 'normal' });
  assert.equal(fetchFn.calls[1].init.headers.authorization, c.init.headers.authorization, 'the provider token is reused');
  assert.equal(fetchFn.calls[1].init.headers['apns-priority'], '5');
  reply = { status: 410, body: '{"reason":"Unregistered"}' };
  assert.deepEqual(await send(d, payload, { ttl: 45 }), { status: 'expired', reason: 'Unregistered', http_status: 410 });
  reply = { status: 400, body: '{"reason":"BadDeviceToken"}' };
  assert.equal((await send(d, payload, { ttl: 45 })).status, 'failed', 'also what a wrong APNS_ENV says for every token');
  assert.equal(apnsOutcome(400, '{"reason":"DeviceTokenNotForTopic"}').status, 'failed', 'a wrong APNS_TOPIC');
  reply = { status: 403, body: '{"reason":"ExpiredProviderToken"}' };
  assert.deepEqual([(await send(d, payload, { ttl: 45 })).status], ['failed'], 'our token, not the device');
  assert.equal(apnsOutcome(429, '{"reason":"TooManyRequests"}').status, 'failed');
  assert.equal(apnsOutcome(503, '').status, 'failed');
  const sandbox = fakeFetch(() => ({ status: 200 }));
  await makeApnsSender({ ...cfg, sandbox: true }, sandbox)(d, payload, { ttl: 45 });
  assert.match(sandbox.calls[0].url, /^https:\/\/api\.sandbox\.push\.apple\.com\/3\/device\//);
});

const secret = `v1,whsec_${randomBytes(32).toString('base64')}`;
function sign(body, { id = 'msg_1', ts = Math.floor(Date.now() / 1000), key = secret } = {}) {
  const raw = Buffer.from(key.replace(/^v1,whsec_/, ''), 'base64');
  const sig = createHmac('sha256', raw).update(`${id}.${ts}.${body}`).digest('base64');
  return { id, timestamp: String(ts), signature: `v1,${sig}` };
}

test('auth-email: Standard Webhooks signature, stale and forged requests', async () => {
  const body = JSON.stringify({ user: { email: 'a@jarurat.care' }, email_data: { token: '123456', email_action_type: 'magiclink' } });
  assert.equal(await verifyWebhook(secret, sign(body), body), 'ok');
  const two = sign(body);
  assert.equal(await verifyWebhook(secret, { ...two, signature: `v1,AAAA ${two.signature}` }, body), 'ok', 'several signatures');
  assert.equal(await verifyWebhook(secret, sign(body), body.replace('123456', '654321')), 'bad', 'tampered body');
  const other = `v1,whsec_${randomBytes(32).toString('base64')}`;
  assert.equal(await verifyWebhook(secret, sign(body, { key: other }), body), 'bad', 'signed with another secret');
  assert.equal(await verifyWebhook(secret, sign(body, { ts: Math.floor(Date.now() / 1000) - 3600 }), body), 'stale');
  assert.equal(await verifyWebhook(secret, { id: null, timestamp: null, signature: null }, body), 'missing');
  assert.equal(await verifyWebhook(secret, { ...sign(body), signature: 'v2,whatever' }, body), 'bad');
});

test('auth-email: every action with a code becomes one code mail; email change mails both addresses', () => {
  const p = (action, data = {}, user = { email: 'priya@jarurat.care' }) =>
    mailsFor({ user, email_data: { email_action_type: action, token: '123456', token_hash: 'h', ...data } });
  for (const action of ['signup', 'magiclink', 'recovery', 'invite', 'email', 'reauthentication']) {
    assert.deepEqual(p(action), [{ to: 'priya@jarurat.care', code: '123456', action }], action);
  }
  assert.deepEqual(p('email_change', { token_new: '654321' }, { email: 'old@jarurat.care', new_email: 'new@jarurat.care' }), [
    { to: 'old@jarurat.care', code: '123456', action: 'email_change' },
    { to: 'new@jarurat.care', code: '654321', action: 'email_change' },
  ], 'secure email change: token to the current address, token_new to the new one');
  assert.deepEqual(p('email_change', { token: '', token_new: '654321' }, { email: 'old@jarurat.care', new_email: 'new@jarurat.care' }),
    [{ to: 'new@jarurat.care', code: '654321', action: 'email_change' }], 'single confirmation: only the new address');
  assert.deepEqual(p('password_changed_notification'), [], 'no code, no mail');
  assert.deepEqual(p('magiclink', { token: '' }), []);
  assert.deepEqual(p('magiclink', { token: '12ab56' }), [], 'only digits are codes');
  assert.deepEqual(p('magiclink', {}, {}), [], 'no address');
});

test('auth-email: addresses that can never receive mail are refused before the mailer', () => {
  for (const a of ['t@dek-test.invalid', 'x@foo.test', 'y@example.com', 'z@mail.example.org', 'w@localhost', 'v@intranet',
    'nobody', '@jarurat.care', 'u@host.local']) {
    assert.equal(undeliverable(a), true, a);
  }
  for (const a of ['priya@gmail.com', 'ops@jarurat.care', 'a.b+c@sub.domain.co.in', 'me@examples.com']) {
    assert.equal(undeliverable(a), false, a);
  }
});
