// Node side of the admin and settings browser tests: QA logins (password from the
// repo's .env.local through tools/lib/env.mjs, never printed), sessions handed to
// the browser as storage state, contract calls as a given QA user, and the small
// fixture world these tests own (a fixture member and one test channel), so the
// tests never change the seeded people other builders rely on.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JavaScript helper shared by every repo tool
import { env, pgConfig } from '../../../../../tools/lib/env.mjs';
import pg from 'pg';

export const BASE_URL = 'http://127.0.0.1:5175';
const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB = join(HERE, '..', '..', '..');
export const STATE_DIR = join(WEB, 'test-results', 'admin-e2e');
export const AUTH_DIR = join(STATE_DIR, 'auth');
export const WORLD_FILE = join(STATE_DIR, 'world.json');
export const LEDGER_FILE = join(STATE_DIR, 'created.json');
export const SHOTS_DIR = join(HERE, '..', 'screenshots');

const E = env() as Record<string, string | undefined>;
const need = (k: string): string => {
  const v = E[k];
  if (!v) throw new Error(`${k} is missing from .env.local`);
  return v;
};

export const QA = {
  owner: 'qa-owner@dek-test.invalid',
  admin: 'qa-admin@dek-test.invalid',
  alice: 'qa-alice@dek-test.invalid',
  guest: 'qa-guest@dek-test.invalid',
  fixture: 'qa-adm-fixture@dek-test.invalid',
} as const;
export type QaUser = keyof typeof QA;

export const FIXTURE_NAME = 'Fiona Fixture';
export const E2E_CHANNEL = 'adm-e2e-settings';
export const CHANNEL_BASELINE = {
  topic: 'Admin and settings browser tests',
  description: '',
  posting_policy: 'everyone',
  allow_replies: true,
  allow_reactions: true,
  category: null,
} as const;

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

export interface Signed {
  client: SupabaseClient;
  userId: string;
  storageValue: string;
}

export async function signIn(email: string): Promise<Signed> {
  const storage = new MemoryStorage();
  const client = createClient(need('SUPABASE_URL'), need('SUPABASE_PUBLISHABLE_KEY'), {
    db: { schema: 'api' },
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'dek.auth', storage },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: need('DEK_QA_PASSWORD') });
  if (error || !data.session) throw new Error(`Sign in failed for ${email}: ${error?.message ?? 'no session'}`);
  const value = storage.getItem('dek.auth');
  if (!value) throw new Error('The session was not stored');
  return { client, userId: data.session.user.id, storageValue: value };
}

export function storageState(value: string) {
  return { cookies: [], origins: [{ origin: BASE_URL, localStorage: [{ name: 'dek.auth', value }] }] };
}

export function authFile(user: string): string {
  return join(AUTH_DIR, `${user}.json`);
}

export class RpcError extends Error {
  code: string;
  hint: string;
  constructor(fn: string, code: string, hint: string) {
    super(`${fn} refused: ${code} (${hint})`);
    this.code = code;
    this.hint = hint;
  }
}

export async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new RpcError(fn, error.message, error.hint ?? '');
  return data as T;
}

export function serviceClient(): SupabaseClient {
  return createClient(need('SUPABASE_URL'), need('SUPABASE_SECRET_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function ensureUser(email: string, name: string): Promise<string> {
  const admin = serviceClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const found = data.users.find((u) => u.email === email);
  if (found) {
    await admin.auth.admin.updateUserById(found.id, { password: need('DEK_QA_PASSWORD') });
    return found.id;
  }
  const { data: c, error: e } = await admin.auth.admin.createUser({
    email, password: need('DEK_QA_PASSWORD'), email_confirm: true, user_metadata: { display_name: name },
  });
  if (e || !c.user) throw e ?? new Error('createUser returned no user');
  return c.user.id;
}

// Deletes a throwaway sign-in account; one that is already gone counts as done.
export async function deleteAuthUser(id: string): Promise<void> {
  const { error } = await serviceClient().auth.admin.deleteUser(id);
  if (error && !/not.?found/i.test(error.message)) throw error;
}

export interface OrgBaseline {
  name: string;
  short_name: string | null;
  brand_color: string;
  settings: Record<string, unknown>;
}

// What the organization settings test changes, so a crashed run is recognised.
export const ORG_TEST_SHORT_NAME = 'DQ e2e';
export const ORG_SEEDED: OrgBaseline = {
  name: 'Dek QA',
  short_name: 'Dek QA',
  brand_color: '#0F766E',
  settings: { edit_window_minutes: null, allow_guests: true, member_can_create_channels: true, member_can_invite: false, default_invite_hours: 168 },
};

export interface World {
  orgId: string;
  orgName: string;
  orgBaseline: OrgBaseline;
  medId: string;
  techId: string;
  generalId: string;
  grantsId: string;
  e2eChannelId: string;
  ids: Record<QaUser, string>;
}

export function readWorld(): World {
  return JSON.parse(readFileSync(WORLD_FILE, 'utf8')) as World;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

// Things a test created that teardown must undo if the test did not get to it.
// profiles: throwaway accounts whose anonymised "Deleted user" profile row is purged
// at the end (an account deletion keeps that row on purpose, for message authors).
export interface Ledger {
  invites: string[];
  users: string[];
  profiles: string[];
}

export function readLedger(): Ledger {
  if (!existsSync(LEDGER_FILE)) return { invites: [], users: [], profiles: [] };
  const l = JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as Partial<Ledger>;
  return { invites: l.invites ?? [], users: l.users ?? [], profiles: l.profiles ?? [] };
}

export function record(kind: keyof Ledger, id: string): void {
  const l = readLedger();
  if (!l[kind].includes(id)) l[kind].push(id);
  writeJson(LEDGER_FILE, l);
}

export function forget(kind: keyof Ledger, id: string): void {
  const l = readLedger();
  l[kind] = l[kind].filter((x) => x !== id);
  writeJson(LEDGER_FILE, l);
}

// Purges the anonymised profile rows of throwaway accounts this run deleted: only
// rows that are deleted, have no sign-in account, no membership and no message.
export async function purgeThrowawayProfiles(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const db = new pg.Client(pgConfig());
  await db.connect();
  try {
    const r = await db.query(
      `delete from dek.profiles p
        where p.id = any($1::uuid[]) and p.deleted_at is not null
          and not exists (select 1 from auth.users u where u.id = p.id)
          and not exists (select 1 from dek.org_members m where m.user_id = p.id)
          and not exists (select 1 from dek.messages m where m.author_id = p.id)`, [ids]);
    return r.rowCount ?? 0;
  } finally {
    await db.end();
  }
}
