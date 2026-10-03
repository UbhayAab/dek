// Bytes to Storage and the finalize call. The upload is an XMLHttpRequest straight
// to Storage (ARCHITECTURE 8) because only XHR reports upload progress; the
// Storage insert policy admits it only for the pending attachment the caller
// reserved. Then media-finalize reads the real bytes and decides.
import { supabase } from '../../api/client';
import type { Attachment } from '../../api/types';
import { config } from '../../config';
import { abortError } from './prepare';

export type TransferCode = 'network' | 'timeout' | 'auth' | 'denied' | 'too_large' | 'server' | 'missing' | 'unavailable';

export class TransferError extends Error {
  readonly code: TransferCode;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(code: TransferCode, message: string, retryable: boolean, status: number | null = null) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export async function accessToken(): Promise<string> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new TransferError('auth', 'You are signed out. Sign in again, then retry.', true);
  return token;
}

export function objectUrl(path: string): string {
  return `${config.supabaseUrl}/storage/v1/object/media/${path.split('/').map(encodeURIComponent).join('/')}`;
}

interface StorageErrorBody {
  statusCode?: string | number;
  error?: string;
  message?: string;
}

function parseBody(text: string): StorageErrorBody {
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === 'object' ? (j as StorageErrorBody) : {};
  } catch {
    return {};
  }
}

// Storage answers with HTTP 400 and the real status inside the body for some
// errors; both are considered.
export function classifyStorageFailure(status: number, text: string): TransferError | 'exists' {
  const body = parseBody(text);
  const inner = Number(body.statusCode ?? status) || status;
  const msg = `${body.error ?? ''} ${body.message ?? ''}`.toLowerCase();
  if (inner === 409 || msg.includes('already exists') || msg.includes('duplicate')) return 'exists';
  if (inner === 413 || msg.includes('too large') || msg.includes('maximum allowed size')) {
    return new TransferError('too_large', 'The file is larger than Dek allows.', false, inner);
  }
  if (msg.includes('jwt') || (msg.includes('token') && msg.includes('expired')) || inner === 401) {
    return new TransferError('auth', 'Your session expired during the upload. Retry to continue.', true, inner);
  }
  if (inner === 403 || msg.includes('row-level security') || msg.includes('unauthorized')) {
    return new TransferError('denied', 'This upload slot is no longer open. Retry to reserve a new one.', true, inner);
  }
  if (inner === 429) return new TransferError('server', 'Uploads are busy right now. Retry in a moment.', true, inner);
  if (inner >= 500 || inner === 0) return new TransferError('server', 'Storage had a problem. Retry in a moment.', true, inner);
  return new TransferError('server', `The upload was refused (${inner}).`, false, inner);
}

export interface PutOptions {
  token: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  // No progress for this long means the connection is dead (phones in tunnels).
  stallMs?: number;
}

// Resolves when Storage has the object (or already had it from an earlier try).
export function putObject(path: string, body: Blob, contentType: string, opts: PutOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const stallMs = opts.stallMs ?? 45_000;
    let stall: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const arm = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => {
        if (settled) return;
        settled = true;
        xhr.abort();
        cleanup();
        reject(new TransferError('timeout', 'The upload stalled. Check the connection and retry.', true));
      }, stallMs);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      xhr.abort();
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      if (stall) clearTimeout(stall);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    xhr.open('POST', objectUrl(path));
    xhr.setRequestHeader('Authorization', `Bearer ${opts.token}`);
    xhr.setRequestHeader('apikey', config.supabaseKey);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
    xhr.setRequestHeader('cache-control', 'max-age=3600');
    xhr.upload.onprogress = (e) => {
      arm();
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        opts.onProgress?.(1);
        resolve();
        return;
      }
      const verdict = classifyStorageFailure(xhr.status, xhr.responseText ?? '');
      if (verdict === 'exists') resolve();
      else reject(verdict);
    };
    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new TransferError('network', 'The connection dropped during the upload. Retry when you are back online.', true, 0));
    };
    arm();
    xhr.send(body);
  });
}

export interface FinalizeResult {
  status: 'ready' | 'rejected';
  reason: string | null;
  attachment: Attachment | null;
  // The function's own sentence for a refusal, when it sent one.
  message?: string | null;
}

export interface FinalizeMeta {
  width: number | null;
  height: number | null;
  duration_ms: number | null;
}

const REASONS: Record<string, string> = {
  blocked: 'Dek does not accept this kind of file.',
  blocked_type: 'Dek does not accept this kind of file.',
  executable: 'This file is a program. Dek does not accept programs.',
  type_mismatch: 'The file is not what its name says it is, so Dek did not accept it.',
  mismatch: 'The file is not what its name says it is, so Dek did not accept it.',
  not_allowed: 'Dek does not accept this kind of file.',
  unsupported: 'Dek does not accept this kind of file.',
  too_large: 'The file is larger than Dek allows.',
  size_mismatch: 'The file changed during the upload. Remove it and add it again.',
  empty: 'The file is empty.',
  missing: 'The file did not arrive. Retry the upload.',
  not_uploaded: 'The file did not arrive. Retry the upload.',
  aborted: 'The upload was cancelled.',
  abandoned: 'The upload took too long and was cancelled.',
};

// A sentence for whatever reason media-finalize gave.
export function rejectionSentence(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  if (!r) return 'Dek could not accept this file.';
  const known = REASONS[r.toLowerCase()];
  if (known) return known;
  if (/\s/.test(r) && /[a-z]/i.test(r)) return r.replace(/^p_[a-z_]+:\s*/i, '');
  return `Dek could not accept this file (${r}).`;
}

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

// The function's answer, whichever envelope it uses ({ attachment }, the
// attachment itself, { status, reason }).
export function parseFinalize(data: unknown): FinalizeResult {
  const top = asRecord(data) ?? {};
  const nested = asRecord(top.attachment);
  const att = (nested ?? (typeof top.id === 'string' && typeof top.path === 'string' ? top : null)) as Attachment | null;
  const status = String(top.status ?? nested?.status ?? '');
  const reason = (top.reject_reason ?? top.reason ?? nested?.reject_reason ?? null) as string | null;
  if (status === 'ready' || (top.ok === true && status !== 'rejected')) return { status: 'ready', reason: null, attachment: att };
  return { status: 'rejected', reason: reason ?? (typeof top.error === 'string' ? top.error : null), attachment: att };
}

interface HttpErrorLike {
  name?: string;
  message?: string;
  context?: unknown;
}

async function errorBody(err: HttpErrorLike): Promise<{ status: number | null; body: Record<string, unknown> }> {
  const ctx = err.context as { status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> } | undefined;
  const status = typeof ctx?.status === 'number' ? ctx.status : null;
  let body: Record<string, unknown> = {};
  try {
    if (ctx?.json) body = asRecord(await ctx.json()) ?? {};
  } catch {
    body = {};
  }
  return { status, body };
}

export type FunctionResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: 'http'; status: number | null; body: Record<string, unknown> }
  | { ok: false; kind: 'network' | 'relay' };

// An Edge Function call with the signed-in person's token. supabase-js first; if
// that request never got an answer, once more as a plain request: the shared
// client adds its own headers (x-dek-build) and a browser refuses those across
// origins when the function does not list them, which looks exactly like a
// dropped connection.
export async function invokeFunction(name: string, body: unknown): Promise<FunctionResult> {
  let res: { data: unknown; error: unknown };
  try {
    res = await supabase().functions.invoke(name, { body: body as Record<string, unknown> });
  } catch {
    res = { data: null, error: { name: 'FunctionsFetchError' } };
  }
  if (!res.error) return { ok: true, data: res.data };
  const err = res.error as HttpErrorLike;
  if (err.name === 'FunctionsRelayError') return { ok: false, kind: 'relay' };
  if (err.name !== 'FunctionsFetchError') {
    const { status, body: b } = await errorBody(err);
    return { ok: false, kind: 'http', status, body: b };
  }
  try {
    const token = await accessToken();
    const r = await fetch(`${config.supabaseUrl}/functions/v1/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: config.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    let j: unknown = null;
    try { j = await r.json(); } catch { j = null; }
    if (r.ok) return { ok: true, data: j };
    return { ok: false, kind: 'http', status: r.status, body: asRecord(j) ?? {} };
  } catch {
    return { ok: false, kind: 'network' };
  }
}

export async function finalizeUpload(attachmentId: string, meta: FinalizeMeta): Promise<FinalizeResult> {
  const res = await invokeFunction('media-finalize', { attachment_id: attachmentId, ...meta });
  if (res.ok) return parseFinalize(res.data);
  if (res.kind !== 'http') {
    throw res.kind === 'network'
      ? new TransferError('network', 'The connection dropped while the file was being checked. Retry.', true)
      : new TransferError('unavailable', 'File checking is not reachable right now. Retry in a moment.', true);
  }
  const { status, body } = res;
  const parsed = parseFinalize(body);
  // A definite verdict on the bytes (the function said rejected).
  if (String(body.status ?? '') === 'rejected' || body.reject_reason || body.error === 'rejected') {
    const message = typeof body.message === 'string' && body.message.trim() ? body.message : null;
    return { status: 'rejected', reason: parsed.reason, attachment: parsed.attachment, message };
  }
  const hint = typeof body.hint === 'string' ? body.hint : typeof body.message === 'string' ? body.message : null;
  const code = typeof body.error === 'string' ? body.error : typeof body.code === 'string' ? body.code : '';
  if (status === 404 && !code) {
    throw new TransferError('unavailable', 'File checking is not switched on yet. Retry later.', true, status);
  }
  if (status === 401 || code === 'auth_required') throw new TransferError('auth', 'Your session expired. Retry to continue.', true, status);
  if (status === 429 || code === 'rate_limited') throw new TransferError('server', 'Too many uploads at once. Retry in a moment.', true, status);
  // The bytes never landed: upload them again to the same reserved path.
  if (code === 'not_uploaded') throw new TransferError('missing', 'The file did not arrive. Retry the upload.', true, status);
  // The upload changed state meanwhile: asking again gives the final answer.
  if (code === 'conflict') throw new TransferError('server', 'The file is still being checked. Retry in a moment.', true, status);
  if (status !== null && status >= 500) throw new TransferError('server', 'File checking had a problem. Retry in a moment.', true, status);
  if (code === 'not_found' || code === 'forbidden' || code === 'invalid_input') {
    return { status: 'rejected', reason: hint ?? code, attachment: null };
  }
  throw new TransferError('server', rejectionSentence(hint), true, status);
}
