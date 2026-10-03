// FCM HTTP v1 adapter for the native Android app (device kind 'fcm'). OAuth access
// token from a service account (RS256 JWT bearer grant), cached until a minute before
// it expires. Until FCM_SERVICE_ACCOUNT_JSON exists every send reports
// 'not_configured', which svc_record_deliveries stores as a final, honest status.
import { clip, pemToDer, signJwt, type Outcome, type Payload, type SendOptions, type Sender } from './lib.ts';

type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

export function parseServiceAccount(json: string | undefined | null): ServiceAccount | null {
  if (!json) return null;
  try {
    const sa = JSON.parse(json);
    return sa?.project_id && sa?.client_email && sa?.private_key ? sa : null;
  } catch {
    return null;
  }
}

// FCM data values must all be strings.
export function fcmMessage(token: string, p: Payload, opt: SendOptions) {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined) data[k] = String(v);
  return {
    message: {
      token,
      notification: { title: p.title, body: p.body },
      data,
      android: {
        priority: opt.urgency === 'high' ? 'HIGH' : 'NORMAL',
        ttl: `${opt.ttl}s`,
        // the Android app registers two channels: ringing calls must not share the
        // importance (or the person's mute choice) of ordinary messages
        notification: { tag: p.tag, channel_id: p.kind === 'call' ? 'calls' : 'messages' },
      },
    },
  };
}

// Only UNREGISTERED proves that this one token is dead. SENDER_ID_MISMATCH, an
// "invalid registration token" or a 404 without that code also come back for EVERY
// token when the service account belongs to the wrong Firebase project, so they
// fail (final, counted on the device) without revoking. 429 and 5xx are retryable.
export function fcmOutcome(http: number, text: string): Outcome {
  let code = '';
  try {
    const err = JSON.parse(text)?.error ?? {};
    code = (err.details ?? []).map((d: { errorCode?: string }) => d?.errorCode).find(Boolean) ?? err.status ?? '';
  } catch { /* not JSON */ }
  const reason = clip(text);
  if (code === 'UNREGISTERED') return { status: 'expired', reason, http_status: http };
  return { status: 'failed', reason, http_status: http };
}

export function makeFcmSender(serviceAccountJson: string | undefined | null, fetchFn: FetchFn = fetch,
                              now: () => number = Date.now): Sender {
  const sa = parseServiceAccount(serviceAccountJson);
  if (!sa) {
    return () => Promise.resolve({ status: 'not_configured', reason: 'FCM is not configured (FCM_SERVICE_ACCOUNT_JSON)', http_status: null });
  }
  const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  const exchange = async (): Promise<string> => {
    const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const iat = Math.floor(now() / 1000);
    const assertion = await signJwt({ alg: 'RS256', typ: 'JWT' },
      { iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 }, key, { name: 'RSASSA-PKCS1-v1_5' });
    const res = await fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.access_token) throw new Error(`FCM token exchange failed: HTTP ${res.status} ${clip(JSON.stringify(body), 160)}`);
    cached = { token: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 };
    return cached.token;
  };
  const accessToken = (): Promise<string> => {
    if (cached && cached.expiresAt - 60_000 > now()) return Promise.resolve(cached.token);
    inflight ??= exchange().finally(() => { inflight = null; });
    return inflight;
  };

  return async (d, payload, opt) => {
    let token: string;
    try {
      token = await accessToken();
    } catch (e) {
      return { status: 'failed', reason: clip((e as Error).message), http_status: null };
    }
    const res = await fetchFn(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fcmMessage(d.device.endpoint, payload, opt)),
    });
    if (res.ok) return { status: 'sent', reason: null, http_status: res.status };
    if (res.status === 401) cached = null;   // token revoked early: mint a new one next time
    return fcmOutcome(res.status, await res.text());
  };
}
