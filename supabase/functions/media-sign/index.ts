// Signed links for private media, with a lifetime the server decides (PRD DEK11).
//
//   POST { paths: string[] }   Authorization: Bearer <user access token>
//   -> 200 { urls: { [path]: signedUrl }, expires_at }   (paths the caller may not open are absent)
//
// Before this function, the browser minted links itself through Storage, choosing any
// lifetime, so someone could keep a years-long link after leaving a channel. Now the
// caller's access is checked per path (api.svc_media_sign_check, the same rule as
// dek.can_read_channel), and links last 15 minutes.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const TTL_SECONDS = 900;
const MAX_PATHS = 100;

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

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: 'api' },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-dek-build, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function callerId(req: Request): Promise<string | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m || m[1].split('.').length !== 3) return null;
  try {
    const { data, error } = await admin.auth.getClaims(m[1]);
    const c = data?.claims;
    if (error || !c || c.role !== 'authenticated' || typeof c.sub !== 'string') return null;
    return c.sub;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method', message: 'POST only.' });
  const uid = await callerId(req);
  if (!uid) return reply(401, { error: 'auth_required', message: 'Sign in to continue.' });
  let body: { paths?: unknown } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const paths = Array.isArray(body.paths)
    ? [...new Set(body.paths.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 400))]
    : [];
  if (!paths.length) return reply(200, { urls: {}, expires_at: null });
  if (paths.length > MAX_PATHS) return reply(400, { error: 'invalid_input', message: `At most ${MAX_PATHS} files at a time.` });

  const { data: allowed, error } = await admin.rpc('svc_media_sign_check', { p_user: uid, p_paths: paths });
  if (error) return reply(500, { error: 'server', message: 'Could not check access. Try again.' });
  const ok: string[] = Array.isArray(allowed) ? allowed : [];
  if (!ok.length) return reply(200, { urls: {}, expires_at: null });

  const { data: signed, error: signErr } = await admin.storage.from('media').createSignedUrls(ok, TTL_SECONDS);
  if (signErr || !signed) return reply(502, { error: 'server', message: 'Could not prepare the files. Try again.' });
  const urls: Record<string, string> = {};
  for (const s of signed) if (s.path && s.signedUrl && !s.error) urls[s.path] = s.signedUrl;
  return reply(200, { urls, expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString() });
});
