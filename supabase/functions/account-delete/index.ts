// account-delete: in-app account deletion (PRD APP08, a store requirement).
//
//   1. Verify the caller's JWT with Auth (getUser: signature, expiry and that the
//      session's user still exists). This project signs with ES256 keys and the
//      legacy JWT secret is revoked, so the gateway's verify_jwt is off and the
//      function checks for itself.
//   2. api.request_account_deletion AS THE USER (publishable key + their JWT): the
//      last-owner rule, leaving every organization, removing personal data and
//      anonymising the profile all happen there, inside one transaction.
//   3. Remove their avatar files, then delete the auth user with the admin API.
//   4. api.svc_complete_account_deletion (service role) purges the delivery log.
// A retry after a half-finished run is safe: step 2 answers "already deleted" and
// the rest continues.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const URL_ = Deno.env.get('SUPABASE_URL') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function pickKey(raw: string | undefined, prefix: string): string {
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

const SECRET_KEY = pickKey(Deno.env.get('SUPABASE_SECRET_KEYS'), 'sb_secret_');
const PUBLIC_KEY = pickKey(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'), 'sb_publishable_') || (Deno.env.get('SUPABASE_ANON_KEY') ?? '');
const OPTIONS = { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'api' } };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Every file under avatars/<uid>/ (the bucket is public), page by page and into
// sub-folders. Any storage error throws, so the auth user is never deleted while a
// public picture remains; the request step is idempotent and a retry finishes.
// deno-lint-ignore no-explicit-any
async function removeAvatars(admin: any, prefix: string, depth = 0): Promise<number> {
  const bucket = admin.storage.from('avatars');
  let removed = 0;
  for (let round = 0; round < 50; round += 1) {
    const { data, error } = await bucket.list(prefix, { limit: 100 });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    const entries: { name: string; id: string | null }[] = data ?? [];
    const folders = entries.filter((e) => e.id === null && e.name);
    const files = entries.filter((e) => e.id !== null && e.name);
    if (depth < 3) for (const f of folders) removed += await removeAvatars(admin, `${prefix}/${f.name}`, depth + 1);
    if (!files.length) return removed;
    const { error: rmError } = await bucket.remove(files.map((f) => `${prefix}/${f.name}`));
    if (rmError) throw new Error(`remove: ${rmError.message}`);
    removed += files.length;
  }
  throw new Error('avatars: too many files');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!SECRET_KEY || !PUBLIC_KEY) return json(503, { error: 'not_configured', hint: 'Account deletion is not available right now.' });
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'auth_required', hint: 'Sign in to continue.' });

  const admin = createClient(URL_, SECRET_KEY, OPTIONS);
  const { data: who, error: whoError } = await admin.auth.getUser(jwt);
  if (whoError || !who?.user?.id) return json(401, { error: 'auth_required', hint: 'Your session has ended. Sign in again.' });
  const uid = who.user.id;

  const asUser = createClient(URL_, PUBLIC_KEY, { ...OPTIONS, global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { error: reqError } = await asUser.rpc('request_account_deletion');
  if (reqError) {
    const alreadyDone = reqError.message === 'auth_required' && /deleted/i.test(reqError.hint ?? '');
    if (!alreadyDone) {
      const status = reqError.message === 'conflict' ? 409 : reqError.message === 'auth_required' ? 401 : 500;
      return json(status, { error: reqError.message, hint: reqError.hint ?? 'Account deletion failed. Try again.' });
    }
  }

  let avatars = 0;
  try {
    avatars = await removeAvatars(admin, uid);
  } catch (e) {
    console.error(JSON.stringify({ step: 'avatars', user: uid, error: String((e as Error)?.message ?? e) }));
    return json(500, { error: 'delete_failed', hint: 'Your data is removed, but your profile picture could not be deleted yet. Try again.' });
  }
  const { error: delError } = await admin.auth.admin.deleteUser(uid);
  if (delError && !/not.?found/i.test(delError.message)) {
    console.error(JSON.stringify({ step: 'auth', user: uid, error: delError.message }));
    return json(500, { error: 'delete_failed', hint: 'Your data is removed, but the sign-in account could not be closed. Try again.' });
  }
  // The account is closed and the personal data gone at this point. If the last purge
  // fails, what is left is the delivery log (statuses and device ids, no content),
  // which dek.prune() removes after 14 days anyway: logged, not shown as a failure.
  const { error: doneError } = await admin.rpc('svc_complete_account_deletion', { p_user: uid });
  if (doneError) console.error(JSON.stringify({ step: 'complete', user: uid, error: doneError.message }));
  console.log(JSON.stringify({ deleted: uid, avatars, completed: !doneError }));
  return json(200, { status: 'deleted' });
});
