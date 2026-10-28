// Capped exponential backoff with jitter. Client retries amplified the 2026-09-30
// outage, so every retry loop in the app goes through here: the base doubles from
// `baseMs` to `maxMs`, and a random share is added on top so 400 phones coming back
// online at once do not retry in lockstep.
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  // Jitter added on top of the base: random() * max(minJitterMs, base * jitterRatio).
  jitterRatio?: number;
  minJitterMs?: number;
  random?: () => number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.min(n - 1, 30));
  const spread = Math.max(opts.minJitterMs ?? 0, base * (opts.jitterRatio ?? 0.25));
  const r = (opts.random ?? Math.random)();
  return Math.round(base + Math.min(Math.max(r, 0), 1) * spread);
}

// The outbox schedule (LESSONS "Durable sending"): 2 s doubling to 120 s, plus jitter.
export const SEND_BACKOFF: BackoffOptions = { baseMs: 2_000, maxMs: 120_000, jitterRatio: 0.25, minJitterMs: 1_000 };

// The realtime resubscribe schedule: 1 s doubling to 30 s, plus jitter.
export const REJOIN_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 30_000, jitterRatio: 0.3, minJitterMs: 500 };

// Session start retries (me and bootstrap while offline): 2 s doubling to 60 s.
export const START_BACKOFF: BackoffOptions = { baseMs: 2_000, maxMs: 60_000, jitterRatio: 0.3, minJitterMs: 500 };
