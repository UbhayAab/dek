// Machine codes from docs/CONTRACT.md section 0, and what people read.
export type ErrorCode =
  | 'auth_required' | 'not_found' | 'forbidden' | 'invalid_input' | 'rate_limited'
  | 'conflict' | 'archived' | 'blocked' | 'suspended'
  | 'network' | 'timeout' | 'server' | 'unknown';

const FALLBACK: Record<ErrorCode, string> = {
  auth_required: 'Your session ended. Sign in again.',
  not_found: 'That does not exist, or you no longer have access to it.',
  forbidden: 'You do not have permission to do that.',
  invalid_input: 'Something in that request was not valid.',
  rate_limited: 'Slow down a little and try again in a moment.',
  conflict: 'That changed while you were looking at it. Refresh and try again.',
  archived: 'This conversation is archived and read only.',
  blocked: 'You cannot message this person.',
  suspended: 'Your membership in this organization is suspended.',
  network: 'You are offline or the connection dropped.',
  timeout: 'The server took too long to answer.',
  server: 'Dek had a problem on its side. Try again.',
  unknown: 'Something went wrong. Try again.',
};

const KNOWN = new Set<string>(Object.keys(FALLBACK));

// Retryable means "the same request may succeed later without anyone changing it".
// auth_required is retryable because a token can expire in a pocket: the session
// refreshes and the replay succeeds (legacy outbox lesson).
const RETRYABLE = new Set<ErrorCode>(['network', 'timeout', 'server', 'rate_limited', 'auth_required']);

export class DekError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(code: ErrorCode, hint?: string | null, status: number | null = null) {
    super(code);
    this.name = 'DekError';
    this.code = code;
    this.hint = hint && hint !== code ? hint : FALLBACK[code];
    this.status = status;
    this.retryable = RETRYABLE.has(code);
  }
}

interface PostgrestLike {
  message?: string;
  hint?: string | null;
  code?: string;
  name?: string;
}

const NETWORK_WORDS = ['failed to fetch', 'networkerror', 'network request failed', 'load failed', 'fetch failed'];

export function toDekError(err: unknown, status: number | null = null): DekError {
  if (err instanceof DekError) return err;
  const e = (err ?? {}) as PostgrestLike;
  if (e.name === 'AbortError') return new DekError('timeout', null, status);
  const message = typeof e.message === 'string' ? e.message : '';
  if (KNOWN.has(message)) return new DekError(message as ErrorCode, e.hint ?? null, status);
  if (status === 401 || e.code === 'PGRST301' || e.code === 'PGRST303') return new DekError('auth_required', null, status);
  if (status === 429) return new DekError('rate_limited', null, status);
  if (e.code === '57014') return new DekError('timeout', null, status);
  if (status !== null && status >= 500) return new DekError('server', null, status);
  const lower = message.toLowerCase();
  if (NETWORK_WORDS.some((w) => lower.includes(w)) || status === 0) return new DekError('network', null, status);
  return new DekError('unknown', null, status);
}

export function humanError(err: unknown): string {
  return toDekError(err).hint;
}
