// --prove-auth: proves on the NEW project, with a throwaway user only, that
//   1. a user row written the way the migration writes it (SQL, a copied bcrypt
//      hash) can sign in with its password, and
//   2. a session plus refresh token row written the way the migration copies legacy
//      sessions can be exchanged at /auth/v1/token?grant_type=refresh_token for a
//      new session, with no sign-in.
// The user is deleted afterwards. No token or password is printed.
import { randomUUID, randomBytes } from 'node:crypto';
import { upsertRows } from './load.mjs';
import { SPECS } from './tables.mjs';

const spec = (name) => SPECS.find((s) => s.name === name);
const jwtPayload = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));

async function post(url, path, apikey, body, bearer) {
  const res = await fetch(`${url}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { apikey, 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

export async function proveAuth(db, { url, publishable }, log = () => {}) {
  const steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); return ok; };
  const id = randomUUID();
  const email = `migrate-proof-${id.slice(0, 8)}@dek-test.invalid`;
  const password = randomBytes(18).toString('base64url');
  const legacyToken = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 12);
  const sessionId = randomUUID();
  try {
    const hash = (await db.query("select extensions.crypt($1, extensions.gen_salt('bf', 10)) as h", [password])).rows[0].h;
    const now = (await db.query('select now() as t')).rows[0].t;
    await upsertRows(db, spec('auth_users'), [{
      instance_id: '00000000-0000-0000-0000-000000000000', id, aud: 'authenticated', role: 'authenticated', email,
      encrypted_password: hash, email_confirmed_at: now, last_sign_in_at: null,
      raw_app_meta_data: { provider: 'email', providers: ['email'] },
      raw_user_meta_data: { display_name: 'Migration proof', email_verified: true },
      created_at: now, updated_at: now, confirmation_token: '', recovery_token: '', email_change_token_new: '',
      email_change: '', email_change_token_current: '', phone_change_token: '', reauthentication_token: '',
      is_sso_user: false, is_anonymous: false,
    }]);
    await upsertRows(db, spec('identities'), [{ id: randomUUID(), user_id: id, provider_id: id, provider: 'email',
      identity_data: { sub: id, email, email_verified: true, phone_verified: false },
      created_at: now, updated_at: now, last_sign_in_at: now }]);
    const prof = (await db.query('select 1 from dek.profiles where id = $1', [id])).rows.length === 1;
    step('profile created by dek.on_auth_user_created for a SQL-inserted user', prof);

    const signin = await post(url, '/auth/v1/token?grant_type=password', publishable, { email, password });
    step('password sign-in of a SQL-inserted user with a copied bcrypt hash', signin.status === 200
      && jwtPayload(signin.data?.access_token).sub === id, `HTTP ${signin.status}`);
    if (signin.status === 200) {
      const s = (await db.query(`select refresh_token_hmac_key is not null as hmac from auth.sessions
          where id = $1`, [jwtPayload(signin.data.access_token).session_id])).rows[0];
      step('new project issues refresh tokens', true,
        `token length ${String(signin.data.refresh_token).length}, ${s?.hmac ? 'new HMAC format' : 'table-stored format'}`);
    }

    // A session exactly as the migration copies one from legacy: legacy tokens are
    // 12 characters, stored in auth.refresh_tokens.
    await upsertRows(db, spec('sessions'), [{ id: sessionId, user_id: id, created_at: now, updated_at: now,
      aal: 'aal1', refreshed_at: String(now).replace(/[+-]\d\d(:?\d\d)?$/, ''), user_agent: 'dek migration proof',
      not_after: null, factor_id: null, tag: null }]);
    await upsertRows(db, spec('refresh_tokens'), [{ instance_id: '00000000-0000-0000-0000-000000000000',
      token: legacyToken, user_id: id, revoked: false, created_at: now, updated_at: now, parent: null,
      session_id: sessionId }]);
    await upsertRows(db, spec('amr_claims'), [{ id: randomUUID(), session_id: sessionId,
      authentication_method: 'password', created_at: now, updated_at: now }]);

    const refreshed = await post(url, '/auth/v1/token?grant_type=refresh_token', publishable, { refresh_token: legacyToken });
    const claims = refreshed.status === 200 ? jwtPayload(refreshed.data.access_token) : {};
    step('legacy-format refresh token exchanged for a new session without sign-in',
      refreshed.status === 200 && claims.sub === id && claims.session_id === sessionId,
      `HTTP ${refreshed.status}${claims.session_id ? ', same session id' : ''}`);
    if (refreshed.status === 200) {
      const me = await post(url, '/auth/v1/user', publishable, null, refreshed.data.access_token);
      step('the new access token is accepted by the new project', me.status === 200 && me.data?.id === id, `HTTP ${me.status}`);
      const old = (await db.query('select revoked from auth.refresh_tokens where token = $1', [legacyToken])).rows[0];
      step('the copied token was rotated (revoked) by the new project', old?.revoked === true);
      const again = await post(url, '/auth/v1/token?grant_type=refresh_token', publishable, { refresh_token: refreshed.data.refresh_token });
      step('the rotated token refreshes again', again.status === 200, `HTTP ${again.status}`);
    }
    const bad = await post(url, '/auth/v1/token?grant_type=refresh_token', publishable, { refresh_token: 'abcdefghijkl' });
    step('an unknown token is refused', bad.status >= 400 && bad.status < 500, `HTTP ${bad.status}`);
  } catch (e) {
    step('proof ran to completion', false, e.message);
  } finally {
    await db.query('delete from auth.users where id = $1', [id]);
    await db.query('delete from dek.profiles where id = $1', [id]);
    const left = (await db.query(`select (select count(*) from auth.users where id = $1)::int
        + (select count(*) from dek.profiles where id = $1)::int as n`, [id])).rows[0].n;
    step('throwaway user and profile removed', left === 0);
  }
  return { ok: steps.every((s) => s.ok), steps };
}
