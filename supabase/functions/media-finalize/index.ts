// media-finalize: the server half of every upload. Owner: [media].
// docs/CONTRACT.md sections 2.7 and 5, docs/ARCHITECTURE.md section 8, PRD DEK10, DEK11, DEKA11.
//
// Deployed with verify_jwt off: this project signs ES256 access tokens, so the
// caller's token is verified here (auth.getClaims against the project's JWKS).
// Database access is through api.svc_* only, as service_role (the sb_secret_ key;
// the legacy service-role JWT is disabled on this project).
//
// POST { attachment_id, duration_ms?, width?, height? }    Authorization: Bearer <user access token>
//   The caller must have uploaded the attachment, and it must be pending. Reads the
//   real size and served type from Storage's metadata and the first 64 KB with a
//   Range request, sniffs the bytes (./sniff.ts) and refuses programs, scripts,
//   macros, web pages, types off the allow-list, types outside the declared family,
//   and anything over the limit. duration_ms, width and height are hints from the
//   client, used only when the file's header does not say (a voice note's length).
//     200 { ok: true, attachment: Attachment }                       ready (also when it already was)
//     422 { ok: false, error: 'rejected', reason, message, attachment }  refused; the bytes are removed
//     409 { ok: false, error: 'not_uploaded' | 'conflict', message }    upload missing or state changed
//     400 invalid_input, 401 auth_required, 404 not_found, 405, 500 failed
//
// POST { action: 'purge' }    x-dek-internal: <DEK_INTERNAL_SECRET>
//   Called once a day by dek.media_purge_tick through pg_net. Removes the Storage
//   objects of deleted and rejected attachments, 100 at a time, and stamps purged_at.
//     200 { ok: true, purged, failed }
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { HEAD_BYTES, MESSAGES, jpegScan, judge, sniff, thumbOk } from './sniff.ts';
import type { Reason, Sniff } from './sniff.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PURGE_BUDGET_MS = 50_000;
const PURGE_MAX_ROUNDS = 300;
const JPEG_MAX_HOPS = 6;

// SUPABASE_SECRET_KEYS is a JSON object of named keys; accept an array or a list too.
function pickKey(raw: string | undefined, prefix: string): string {
  if (!raw) return '';
  let values: unknown[];
  try {
    const parsed = JSON.parse(raw);
    values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed) : [parsed];
  } catch {
    values = raw.split(',');
  }
  return values.map((v) => String(v).trim()).find((v) => v.startsWith(prefix)) ?? '';
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SECRET_KEY = pickKey(Deno.env.get('SUPABASE_SECRET_KEYS'), 'sb_secret_');
const INTERNAL_SECRET = Deno.env.get('DEK_INTERNAL_SECRET') ?? '';

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: 'api' },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const MORE_MESSAGES: Record<string, string> = {
  aborted: 'This upload was cancelled.',
  abandoned: 'This upload was never finished.',
};

function rejected(reason: string | null, attachment: unknown): Response {
  const r = reason ?? 'unknown_type';
  const message = MESSAGES[r as Reason] ?? MORE_MESSAGES[r] ?? 'This file cannot be shared in Dek.';
  return reply(422, { ok: false, error: 'rejected', status: 'rejected', reason: r, reject_reason: r, message, attachment });
}

const ready = (attachment: unknown): Response => reply(200, { ok: true, status: 'ready', attachment });

// ------------------------------------------------------------------ auth

async function callerId(req: Request): Promise<string | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m || m[1].split('.').length !== 3) return null;   // an API key is not a signed-in person
  try {
    const { data, error } = await admin.auth.getClaims(m[1]);
    const c = data?.claims;
    if (error || !c || c.role !== 'authenticated' || typeof c.sub !== 'string') return null;
    return c.sub;
  } catch {
    return null;
  }
}

// Constant time whatever the lengths: compare digests.
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ------------------------------------------------------------------ database

type RpcError = { message: string; hint?: string | null; code?: string };
type ObjMeta = { size: number | null; mimetype: string | null } | null;
type UploadInfo = {
  id: string; status: string; reject_reason: string | null; mime_type: string;
  object_path: string; thumb_path: string | null; object: ObjMeta; thumb: ObjMeta;
  attachment: Record<string, unknown>;
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<{ data: T | null; error: RpcError | null }> {
  const { data, error } = await admin.rpc(fn, args);
  return { data: (data ?? null) as T | null, error: error ? { message: error.message, hint: error.hint, code: error.code } : null };
}

function rpcFailure(error: RpcError | null): Response {
  const code = error?.message ?? 'failed';
  const status = ({ not_found: 404, invalid_input: 400, conflict: 409, auth_required: 401 } as Record<string, number>)[code];
  if (!status) {
    console.error('[media-finalize] rpc failed', code);
    return reply(500, { ok: false, error: 'failed', message: 'Something went wrong. Try again.' });
  }
  return reply(status, { ok: false, error: code, message: error?.hint ?? code });
}

// ------------------------------------------------------------------ storage

function objectUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/authenticated/media/${path.split('/').map(encodeURIComponent).join('/')}`;
}

// Up to `length` bytes from `start`, the object's total size from Content-Range, and
// the type Storage serves it with.
async function readRange(path: string, start: number, length: number):
  Promise<{ status: number; bytes: Uint8Array; total: number | null; type: string | null }> {
  const res = await fetch(objectUrl(path), {
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}`, Range: `bytes=${start}-${start + length - 1}` },
  });
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    return { status: res.status, bytes: new Uint8Array(0), total: null, type: null };
  }
  const type = res.headers.get('content-type');
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  const total = range ? Number(range[1]) : res.status === 200 ? Number(res.headers.get('content-length')) : NaN;
  const out = new Uint8Array(length);
  let skip = res.status === 200 ? start : 0;   // a server that ignored Range sent everything
  let n = 0;
  const reader = res.body!.getReader();
  try {
    while (n < length) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (skip > 0) {
        const drop = Math.min(skip, chunk.length);
        chunk = chunk.subarray(drop);
        skip -= drop;
      }
      const take = Math.min(chunk.length, length - n);
      out.set(chunk.subarray(0, take), n);
      n += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { status: res.status, bytes: out.subarray(0, n), total: Number.isFinite(total) ? total : null, type };
}

async function remove(paths: string[], why: string): Promise<boolean> {
  const { error } = await admin.storage.from('media').remove(paths);
  if (error) console.error(`[media-finalize] remove failed (${why})`, error.message);
  return !error;
}

// Phone photos carry big EXIF blocks; read on until the JPEG frame header shows up.
async function jpegFollow(path: string, s: Sniff, total: number): Promise<Sniff> {
  if (s.kind !== 'match' || s.jpegNext === undefined) return s;
  let next: number | undefined = s.jpegNext;
  for (let hop = 0; hop < JPEG_MAX_HOPS && next !== undefined && next < total; hop += 1) {
    const r = await readRange(path, next, HEAD_BYTES);
    if (!r.bytes.length) break;
    const j = jpegScan(r.bytes, 0, next);
    if (j.width && j.height) return { ...s, width: j.width, height: j.height, jpegNext: undefined };
    if (j.next === undefined || j.next <= next) break;
    next = j.next;
  }
  return { ...s, jpegNext: undefined };
}

// The thumbnail is judged once the file is ready: from then on nothing can be uploaded
// to its paths, so what is checked is what will be served. A thumbnail that is not a
// small still image is removed and thumb_path reconciled (the upload still succeeds;
// people see the full image instead). One the database already dropped (missing,
// wrong type, too big) is removed too, so no bytes are left behind unreferenced.
type Attachment = Record<string, unknown>;
async function settleThumb(a: UploadInfo, att: Attachment | null): Promise<Attachment | null> {
  if (!a.thumb_path || !att) return att;
  if (att.thumb_path == null) {
    await remove([a.thumb_path], 'dropped thumbnail');
    return att;
  }
  const r = await readRange(a.thumb_path, 0, HEAD_BYTES);
  const size = r.total ?? r.bytes.length;
  if ((r.status === 200 || r.status === 206) && thumbOk(sniff(r.bytes, size), size, r.type)) return att;
  if (!(await remove([a.thumb_path], 'bad thumbnail'))) return att;
  const again = await rpc<Attachment>('svc_finalize_upload', {
    p_attachment: a.id, p_ok: true, p_mime: att.mime_type, p_size: att.size_bytes, p_width: null, p_height: null,
    p_duration_ms: null, p_reason: null,
  });
  return again.data ?? { ...att, thumb_path: null };
}

function hint(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : undefined;
}

// ------------------------------------------------------------------ finalize

async function reject(a: UploadInfo, reason: Reason): Promise<Response> {
  await remove([a.object_path, a.thumb_path].filter((p): p is string => !!p), `rejected ${reason}`);
  const fin = await rpc<Record<string, unknown>>('svc_finalize_upload', {
    p_attachment: a.id, p_ok: false, p_mime: null, p_size: null, p_width: null, p_height: null,
    p_duration_ms: null, p_reason: reason,
  });
  if (fin.error) return rpcFailure(fin.error);
  return rejected(reason, fin.data ?? a.attachment);
}

async function finalize(req: Request, body: Record<string, unknown>): Promise<Response> {
  const uid = await callerId(req);
  if (!uid) return reply(401, { ok: false, error: 'auth_required', message: 'Sign in to continue.' });
  const id = typeof body.attachment_id === 'string' ? body.attachment_id.trim().toLowerCase() : '';
  if (!UUID.test(id)) return reply(400, { ok: false, error: 'invalid_input', message: 'attachment_id is required.' });

  const info = await rpc<UploadInfo>('svc_upload_info', { p_attachment: id, p_user: uid });
  if (info.error || !info.data) return rpcFailure(info.error);
  const a = info.data;
  if (a.status === 'ready') return ready(a.attachment);
  if (a.status === 'rejected') return rejected(a.reject_reason, a.attachment);
  if (a.status !== 'pending') return reply(404, { ok: false, error: 'not_found', message: 'That upload does not exist.' });
  const notUploaded = { ok: false, error: 'not_uploaded', message: 'The file has not finished uploading.' };
  if (!a.object) return reply(409, notUploaded);
  if (a.object.size === 0) return reject(a, 'empty');

  const head = await readRange(a.object_path, 0, HEAD_BYTES);
  if (head.status === 400 || head.status === 404) return reply(409, notUploaded);
  if (head.status === 416) return reject(a, 'empty');   // a Range read of an empty object
  if (head.status !== 200 && head.status !== 206) throw new Error(`storage read failed: HTTP ${head.status}`);
  const size = a.object.size ?? head.total ?? head.bytes.length;
  const s = await jpegFollow(a.object_path, sniff(head.bytes, size), size);
  const v = judge(s, { declared: a.mime_type, size, storedType: a.object.mimetype });
  if (!v.ok) return reject(a, v.reason);

  const media = v.family === 'image' || v.family === 'video';
  const timed = v.family === 'audio' || v.family === 'video';
  const width = v.width ?? (media ? hint(body.width, 1, 20000) : undefined);
  const height = v.height ?? (media ? hint(body.height, 1, 20000) : undefined);
  const durationMs = v.durationMs ?? (timed ? hint(body.duration_ms, 0, 86_400_000) : undefined);

  const fin = await rpc<Attachment>('svc_finalize_upload', {
    p_attachment: a.id, p_ok: true, p_mime: v.mime, p_size: size, p_width: width ?? null,
    p_height: height ?? null, p_duration_ms: durationMs ?? null, p_reason: null,
  });
  if (fin.error) return rpcFailure(fin.error);
  return ready(await settleThumb(a, fin.data));
}

// ------------------------------------------------------------------ purge

async function purge(req: Request): Promise<Response> {
  if (!INTERNAL_SECRET || !(await sameSecret(req.headers.get('x-dek-internal') ?? '', INTERNAL_SECRET))) {
    return reply(401, { ok: false, error: 'auth_required' });
  }
  const started = Date.now();
  const failed: string[] = [];
  let done: string[] = [];
  let purged = 0;
  for (let round = 0; ; round += 1) {
    const last = round >= PURGE_MAX_ROUNDS || Date.now() - started > PURGE_BUDGET_MS;
    const res = await rpc<{ stamped: number; items: { id: string; paths: string[] }[] }>('svc_media_purge', {
      p_done: done, p_failed: failed, p_limit: last ? 0 : 100,
    });
    if (res.error || !res.data) throw new Error(`svc_media_purge: ${res.error?.message ?? 'no data'}`);
    purged += res.data.stamped;
    done = [];
    const items = res.data.items;
    if (last || !items.length) break;
    if (await remove(items.flatMap((i) => i.paths), 'purge')) done = items.map((i) => i.id);
    else failed.push(...items.map((i) => i.id));
  }
  return reply(200, { ok: true, purged, failed: failed.length });
}

// ------------------------------------------------------------------ entry

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SECRET_KEY) {
    console.error('[media-finalize] SUPABASE_URL or SUPABASE_SECRET_KEYS missing');
    return reply(500, { ok: false, error: 'failed', message: 'Uploads are not configured.' });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return reply(400, { ok: false, error: 'invalid_input', message: 'Send a JSON object.' });
  }
  try {
    return body.action === 'purge' ? await purge(req) : await finalize(req, body);
  } catch (e) {
    console.error('[media-finalize] failed', e instanceof Error ? e.message : String(e));
    return reply(500, { ok: false, error: 'failed', message: 'Something went wrong. Try again.' });
  }
});
