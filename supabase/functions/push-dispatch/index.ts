// push-dispatch: delivers one notification intent (docs/ARCHITECTURE.md section 7).
//
// pg_net calls it from the dek_intent_dispatch trigger right after a commit, and the
// one-minute sweeper calls it again for anything still pending: POST
// {"intent_id": n} with header x-dek-internal = DEK_INTERNAL_SECRET (the same value
// as Vault dek_internal_secret). Deployed with verify_jwt false; that shared secret,
// compared in constant time, is the boundary.
//
//   api.svc_claim_intent (every routing rule, in SQL)
//     -> each device through its adapter, 20 at a time, 10 s each, 80 s budget
//     -> api.svc_record_deliveries (dead endpoints revoked; a retryable failure puts
//        the intent back to pending for the sweeper)
//
// {"intent_id": n, "dry_run": true} returns the computed deliveries (endpoints cut to
// their origin, no keys) and changes nothing.
//
// The admin client uses the sb_secret key from SUPABASE_SECRET_KEYS: the legacy
// service-role JWT is disabled on this project (the legacy sender read zero
// subscriptions with it and reported success).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { deliverAll, pickKey, safeEqual, tally, vapidProblem, type Delivery, type Result, type Senders } from './lib.ts';
import { makeWebPushSender } from './webpush.ts';
import { makeFcmSender } from './fcm.ts';
import { makeApnsSender } from './apns.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const env = (k: string) => Deno.env.get(k) ?? '';
const CONCURRENCY = 20;
const SEND_TIMEOUT_MS = 10_000;
const BUDGET_MS = 80_000;          // well inside the 2 minute claim lock
const ANSWER_WITHIN_MS = 12_000;   // pg_net waits 15 s; past this, answer and finish in the background

const SECRET = env('DEK_INTERNAL_SECRET');
const ADMIN_KEY = pickKey(env('SUPABASE_SECRET_KEYS'), 'sb_secret_');
const VAPID_PUBLIC = env('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE = env('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = env('VAPID_SUBJECT');
const VAPID_PROBLEM = vapidProblem(VAPID_PUBLIC, VAPID_PRIVATE)
  ?? (/^(mailto:|https:\/\/)/.test(VAPID_SUBJECT) ? null : 'VAPID_SUBJECT must be a mailto: or https: URL');

const admin = ADMIN_KEY
  ? createClient(env('SUPABASE_URL'), ADMIN_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'api' } })
  : null;

let senders: Senders | null = null;
function getSenders(): Senders {
  senders ??= {
    webpush: makeWebPushSender(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE, SEND_TIMEOUT_MS),
    fcm: makeFcmSender(env('FCM_SERVICE_ACCOUNT_JSON')),
    apns: makeApnsSender({ keyId: env('APNS_KEY_ID'), teamId: env('APNS_TEAM_ID'), privateKey: env('APNS_PRIVATE_KEY'),
                           topic: env('APNS_TOPIC'), sandbox: env('APNS_ENV') === 'sandbox' }),
  };
  return senders;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function origin(url: string): string {
  try { return new URL(url).origin; } catch { return '(token)'; }
}

async function dryRun(id: number): Promise<Response> {
  const { data, error } = await admin!.rpc('svc_claim_intent', { p_intent: id, p_dry_run: true });
  if (error) return json(500, { error: 'claim_failed', detail: error.message });
  const i = data?.intent;
  return json(200, {
    dry_run: true,
    intent: i ? { id: i.id, kind: i.kind, status: i.status, attempts: i.attempts, org_id: i.org_id } : null,
    deliveries: (data?.deliveries ?? []).map((d: Delivery) => ({
      user_id: d.user_id, device_id: d.device.id, kind: d.device.kind,
      endpoint: d.device.kind === 'webpush' ? origin(d.device.endpoint) : '(token)',
      title: d.title, body: d.body, url: d.url, tag: d.tag, org_id: d.org_id, org_short_name: d.org_short_name,
      preview: d.preview, urgency: d.urgency,
    })),
    skipped: data?.skipped ?? [],
  });
}

// The pushes are already out: losing this write would make the sweeper send them
// all again after the claim lock expires. Retried twice; the call is idempotent
// (one delivery row per intent and device).
async function record(id: number, results: Result[]) {
  let out = await admin!.rpc('svc_record_deliveries', { p_intent: id, p_results: results });
  for (let attempt = 1; attempt <= 2 && out.error; attempt += 1) {
    await new Promise((r) => setTimeout(r, 400 * attempt));
    out = await admin!.rpc('svc_record_deliveries', { p_intent: id, p_results: results });
  }
  return out;
}

async function dispatch(id: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  const { data: claimed, error } = await admin!.rpc('svc_claim_intent', { p_intent: id });
  if (error) return { http: 500, error: 'claim_failed', detail: error.message };
  if (!claimed?.intent) return { intent_id: id, claimed: false };
  const kind = claimed.intent.kind;
  const deliveries: Delivery[] = claimed.deliveries ?? [];
  const skipped = (claimed.skipped ?? []).length;
  if (!deliveries.length) return { intent_id: id, claimed: true, kind, sent: 0, skipped, status: claimed.intent.status };
  const results = await deliverAll(deliveries, getSenders(), {
    kind, intentId: id, concurrency: CONCURRENCY, timeoutMs: SEND_TIMEOUT_MS, deadline: started + BUDGET_MS });
  const { data: rec, error: recError } = await record(id, results);
  const summary = { intent_id: id, claimed: true, kind, ...tally(results), skipped,
                    status: rec?.status ?? null, revoked: rec?.revoked ?? null, ms: Date.now() - started };
  console.log(JSON.stringify(summary));
  if (recError) return { http: 500, error: 'record_failed', detail: recError.message, ...summary };
  return summary;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!SECRET) return json(503, { error: 'not_configured', detail: 'DEK_INTERNAL_SECRET is not set' });
  if (!(await safeEqual(req.headers.get('x-dek-internal') ?? '', SECRET))) return json(401, { error: 'unauthorized' });
  if (!admin) return json(503, { error: 'not_configured', detail: 'SUPABASE_SECRET_KEYS has no sb_secret_ key' });
  let body: { intent_id?: unknown; dry_run?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = Number(body?.intent_id);
  if (!Number.isSafeInteger(id) || id <= 0) return json(400, { error: 'invalid_input', detail: 'intent_id must be a positive integer' });
  if (body?.dry_run === true) return dryRun(id);
  // A broken key pair would turn every subscription into VapidPkHashMismatch and get
  // them all revoked: refuse instead; the intent stays pending and the sweeper retries.
  if (VAPID_PROBLEM) return json(503, { error: 'not_configured', detail: VAPID_PROBLEM });

  const work = dispatch(id).catch((e) => ({ http: 500, error: 'dispatch_failed', detail: String(e?.message ?? e) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ANSWER_WITHIN_MS); });
  const first = await Promise.race([work, early]);
  clearTimeout(timer);
  if (first) {
    const { http, ...rest } = first as { http?: number };
    return json(http ?? 200, rest);
  }
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
  return json(200, { intent_id: id, claimed: true, still_running: true });
});
