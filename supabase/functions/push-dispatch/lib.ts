// Pure helpers for push-dispatch: no Deno globals and no npm: imports, so
// supabase/tests/plat-functions.test.mjs loads this file under Node as well.
import { createECDH, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export type Status = 'sent' | 'failed' | 'expired' | 'not_configured' | 'skipped';
export type Outcome = { status: Status; reason?: string | null; http_status?: number | null };
export type Result = { user_id: string; device_id: string; status: Status; reason: string | null; http_status: number | null };

export type Device = {
  id: string; kind: 'webpush' | 'fcm' | 'apns'; endpoint: string; p256dh: string | null; auth: string | null;
};
// One item of svc_claim_intent's deliveries.
export type Delivery = {
  user_id: string; device: Device; title: string; body: string; url: string; tag: string;
  org_id: string | null; org_short_name: string | null; preview: string; urgency: 'high' | 'normal';
};
// What the service worker (or the native app) receives.
export type Payload = {
  title: string; body: string; url: string; tag: string; org_id: string | null; org: string | null;
  kind: string; intent_id: number; ts: number;
};
export type SendOptions = { ttl: number; urgency: 'high' | 'normal'; topic: string };
export type Sender = (d: Delivery, payload: Payload, opt: SendOptions) => Promise<Outcome>;
export type Senders = Record<Device['kind'], Sender>;

export const TTL_SECONDS = 3600;        // a notification an hour late is noise
export const CALL_TTL_SECONDS = 45;     // a call rings for 45 s

const enc = new TextEncoder();

// Control characters go first: a NUL byte from a push service would make jsonb
// refuse the whole svc_record_deliveries call.
export function clip(s: unknown, n = 300): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

// Constant time: both sides are hashed first, so neither the length nor the first
// differing byte of the secret shows in the timing.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

// SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS are JSON dictionaries
// ({"default": "sb_secret_..."}); older runtimes gave an array or a plain list.
export function pickKey(raw: string | undefined | null, prefix: string): string {
  if (!raw) return '';
  let values: string[];
  try {
    const parsed = JSON.parse(raw);
    values = Array.isArray(parsed) ? parsed.map(String)
      : parsed && typeof parsed === 'object' ? Object.values(parsed).map(String) : [String(parsed)];
  } catch {
    values = raw.split(',');
  }
  return values.map((v) => v.trim()).find((v) => v.startsWith(prefix)) ?? '';
}

// The legacy push chain once signed with a private key whose public half was not the
// one browsers subscribed with, and every push died as VapidPkHashMismatch. The pair
// is checked at startup and the function refuses to send with a broken one.
export function vapidProblem(pub: string, priv: string): string | null {
  if (!pub || !priv) return 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set';
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(priv, 'base64url'));
    if (ecdh.getPublicKey('base64url') !== pub.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')) {
      return 'VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY';
    }
  } catch {
    return 'VAPID_PRIVATE_KEY is not a P-256 private key';
  }
  return null;
}

// Web Push Topic: push services keep only the newest undelivered message per topic,
// so a phone that was offline gets one notification per conversation, not twenty.
export function topicFor(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

// At most `limit` jobs in flight; results keep the input order. `work` never throws.
export async function runPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, lane));
  return out;
}

export function buildPayload(d: Delivery, kind: string, intentId: number, now: number): Payload {
  return { title: d.title, body: d.body, url: d.url, tag: d.tag, org_id: d.org_id, org: d.org_short_name,
           kind, intent_id: intentId, ts: now };
}

export type DeliverOptions = {
  kind: string; intentId: number; concurrency: number; timeoutMs: number; deadline: number; now?: () => number;
};

// Sends every delivery through the adapter for its device kind. A device not reached
// before the deadline is reported as a retryable failure, so the next claim (after
// svc_record_deliveries puts the intent back to pending) picks it up.
export function deliverAll(deliveries: Delivery[], senders: Senders, o: DeliverOptions): Promise<Result[]> {
  const now = o.now ?? Date.now;
  const ttl = o.kind === 'call' ? CALL_TTL_SECONDS : TTL_SECONDS;
  return runPool(deliveries, o.concurrency, async (d): Promise<Result> => {
    const base = { user_id: d.user_id, device_id: d.device.id };
    if (now() > o.deadline) return { ...base, status: 'failed', reason: 'deadline: not attempted', http_status: null };
    const send = senders[d.device.kind];
    if (!send) return { ...base, status: 'not_configured', reason: `no adapter for ${d.device.kind}`, http_status: null };
    try {
      const out = await withTimeout(
        send(d, buildPayload(d, o.kind, o.intentId, now()), { ttl, urgency: d.urgency === 'high' ? 'high' : 'normal', topic: topicFor(d.tag) }),
        o.timeoutMs, `timeout after ${Math.round(o.timeoutMs / 1000)} s`);
      return { ...base, status: out.status, reason: out.reason ? clip(out.reason) : null, http_status: out.http_status ?? null };
    } catch (e) {
      return { ...base, status: 'failed', reason: clip((e as Error)?.message ?? e), http_status: null };
    }
  });
}

// web-push rejects with WebPushError { statusCode, body } for an HTTP answer and a
// plain Error otherwise. 404/410 mean the subscription is gone; VapidPkHashMismatch
// (Apple) and FCM's "do not correspond to the credentials used to create the
// subscriptions" mean it was made for another key and can never be signed for. A
// local "p256dh/auth" complaint means the stored keys are unusable. All four are
// dead subscriptions: revoke, so the client notices and subscribes again.
export function webpushOutcome(err: unknown): Outcome {
  const e = (err ?? {}) as { statusCode?: unknown; body?: unknown; message?: unknown };
  const http = typeof e.statusCode === 'number' ? e.statusCode : null;
  const text = clip(e.body || e.message || err);
  if (http === 404 || http === 410 || /VapidPkHashMismatch/i.test(text)
      || /do not correspond to the credentials used to create the subscriptions/i.test(text)) {
    return { status: 'expired', reason: text, http_status: http };
  }
  if (http === null && /p256dh|auth secret|subscription (keys|endpoint)|must have an endpoint/i.test(text)) {
    return { status: 'expired', reason: `unusable subscription: ${text}`, http_status: null };
  }
  return { status: 'failed', reason: text, http_status: http };
}

export function tally(results: Result[]): Record<string, number> {
  const t: Record<string, number> = { sent: 0, failed: 0, expired: 0, not_configured: 0 };
  for (const r of results) t[r.status] = (t[r.status] ?? 0) + 1;
  return t;
}

// Shared by the FCM and APNs adapters: JWTs signed with WebCrypto.
export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

export async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey,
                              algorithm: AlgorithmIdentifier | EcdsaParams): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify(header)));
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign(algorithm, key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}
