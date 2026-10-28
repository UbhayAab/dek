// APNs adapter for the native iOS app (device kind 'apns'): token-based auth with an
// ES256 JWT from the .p8 key, refreshed every 40 minutes (Apple accepts 20 to 60).
// HTTP/2 is negotiated by fetch. Until APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY and
// APNS_TOPIC exist every send reports 'not_configured'.
import { clip, pemToDer, signJwt, type Outcome, type Payload, type Sender } from './lib.ts';

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export type ApnsConfig = { keyId?: string; teamId?: string; privateKey?: string; topic?: string; sandbox?: boolean };

const JWT_LIFETIME_MS = 40 * 60_000;

export function apnsBody(p: Payload) {
  return {
    aps: { alert: { title: p.title, body: p.body }, sound: 'default', 'thread-id': p.tag },
    url: p.url, tag: p.tag, org_id: p.org_id, org: p.org, kind: p.kind, intent_id: p.intent_id, ts: p.ts,
  };
}

// Only 410 (Unregistered) proves that this one token is dead. BadDeviceToken and
// DeviceTokenNotForTopic also come back for EVERY token when APNS_ENV or APNS_TOPIC
// is wrong, and a 403 is our key or team, so those fail without revoking. 429 and
// 5xx are retryable.
export function apnsOutcome(http: number, text: string): Outcome {
  let code = '';
  try { code = JSON.parse(text)?.reason ?? ''; } catch { /* empty body */ }
  const reason = clip(code || text);
  if (http === 410 || code === 'Unregistered') return { status: 'expired', reason, http_status: http };
  return { status: 'failed', reason, http_status: http };
}

export function makeApnsSender(cfg: ApnsConfig, fetchFn: FetchFn = fetch, now: () => number = Date.now): Sender {
  const { keyId, teamId, privateKey, topic } = cfg;
  if (!keyId || !teamId || !privateKey || !topic) {
    return () => Promise.resolve({ status: 'not_configured',
      reason: 'APNs is not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_TOPIC)', http_status: null });
  }
  const host = cfg.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  let cached: { jwt: string; at: number } | null = null;

  const providerToken = async (): Promise<string> => {
    if (cached && now() - cached.at < JWT_LIFETIME_MS) return cached.jwt;
    const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const jwt = await signJwt({ alg: 'ES256', kid: keyId }, { iss: teamId, iat: Math.floor(now() / 1000) }, key,
      { name: 'ECDSA', hash: 'SHA-256' });
    cached = { jwt, at: now() };
    return jwt;
  };

  return async (d, payload, opt) => {
    let jwt: string;
    try {
      jwt = await providerToken();
    } catch (e) {
      return { status: 'failed', reason: clip(`APNs key unusable: ${(e as Error).message}`), http_status: null };
    }
    const res = await fetchFn(`${host}/3/device/${encodeURIComponent(d.device.endpoint)}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': opt.urgency === 'high' ? '10' : '5',
        'apns-expiration': String(Math.floor(now() / 1000) + opt.ttl),
        'apns-collapse-id': payload.tag.slice(0, 64),
        'content-type': 'application/json',
      },
      body: JSON.stringify(apnsBody(payload)),
    });
    if (res.ok) return { status: 'sent', reason: null, http_status: res.status };
    const text = await res.text();
    if (res.status === 403) cached = null;   // ExpiredProviderToken and friends: sign a fresh one
    return apnsOutcome(res.status, text);
  };
}
