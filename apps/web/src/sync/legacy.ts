// The move from the legacy app (same origin, project ybddogqphinruyunnuwx) to this
// one, run once at startup before the sign-in screen can show:
//
// 1. Session exchange: the migration copied refresh tokens at cutover, so a legacy
//    session's refresh token is accepted by the new project. With no new session
//    and a legacy key present, refreshSession({ refresh_token }) signs the person
//    in without a password. The legacy key is deleted on success and on a genuine
//    refusal (4xx: the token is invalid); offline, 429 and 5xx keep it, and the
//    exchange runs again when the network returns or on the next start.
// 2. Leftovers the old app kept (dak.*, Dek.*, dek-backend.* keys, its IndexedDB
//    caches of private message pages) are removed so nothing old confuses the new
//    app or outlives a sign-out. dek.* keys belong to this app and are never touched.
// 3. Unsent legacy messages (its outbox) are kept for the same person: they come
//    back as failed sends with Try again and Delete, never sent silently, because
//    nothing can tell whether the old app delivered them in its last second. They
//    are deleted only after that, or once the server refused the legacy session.
import { config } from '../config';
import { toDekError } from '../api/errors';
import { supabase } from '../api/client';
import { deleteNamedDb } from '../lib/idb';
import { allKeys, readString, removeKey } from '../lib/storage';
import { isUuid } from '../lib/uuid';
import type { OutboxRecord } from './outbox';

export const LEGACY_AUTH_KEY = `sb-${config.legacyProjectRef}-auth-token`;
const LEGACY_PREFIXES = ['dak.', 'Dek.', 'dek-backend.'];
const LEGACY_EXACT = new Set([LEGACY_AUTH_KEY, `${LEGACY_AUTH_KEY}-code-verifier`, `${LEGACY_AUTH_KEY}-user`, 'supabase.auth.token']);
const LEGACY_DBS = ['Dek-pages', 'Dek-reads', 'dak.media', 'dek-backend.media'];
const LEGACY_OUTBOX_DB = 'Dek-outbox';
const LEGACY_OUTBOX_KEY = 'Dek.outbox.v1';

export interface LegacyToken {
  refreshToken: string;
  userId: string | null;
}

// supabase-js v2 stores { access_token, refresh_token, user, ... }; v1 stored
// { currentSession: { refresh_token, user } }.
export function parseLegacySession(raw: string | null): LegacyToken | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const session = (v.currentSession && typeof v.currentSession === 'object' ? v.currentSession : v) as Record<string, unknown>;
    const token = session.refresh_token;
    if (typeof token !== 'string' || token.length < 8 || token.length > 2048) return null;
    const user = session.user as { id?: unknown } | undefined;
    return { refreshToken: token, userId: typeof user?.id === 'string' ? user.id : null };
  } catch {
    return null;
  }
}

// Which keys to delete: the old app's namespaces, never this app's dek.* keys.
export function legacyKeysToRemove(keys: readonly string[]): string[] {
  return keys.filter((k) => !k.startsWith('dek.') && (LEGACY_EXACT.has(k) || LEGACY_PREFIXES.some((p) => k.startsWith(p))));
}

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(name, fn) as Promise<T>;
  }
  return fn();
}

export type ExchangeResult = 'none' | 'exchanged' | 'refused' | 'offline';

// Who the legacy outbox belongs to: the person whose legacy session was exchanged,
// or whose legacy session the server genuinely refused (they may still sign in with
// a password; their unsent text is theirs).
let exchangedUser: string | null = null;
let refusedUser: string | null = null;
let refusedHere = false;
export function legacyExchangedUser(): string | null {
  return exchangedUser;
}

// A refusal the server meant (the refresh token is invalid or already used): the
// legacy session is gone for good. Everything else (offline, a timeout, 429, which
// api/client.ts reports as 503, any 5xx, a retryable fetch error) is "not now": the
// key stays and the exchange runs again on the next start or when back online.
export function isGenuineRefusal(error: { status?: number; name?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.name === 'AuthRetryableFetchError') return false;
  const status = typeof error.status === 'number' ? error.status : null;
  if (status === null || status === 0 || status === 408 || status === 429 || status >= 500) return false;
  if (toDekError(error, status).code === 'network') return false;
  return status >= 400 && status < 500;
}

export async function exchangeLegacySession(): Promise<ExchangeResult> {
  if (!readString(LEGACY_AUTH_KEY)) return 'none';
  // Two tabs opened at once must not both spend the same refresh token.
  return withLock('dek-legacy-exchange', async () => {
    const raw = readString(LEGACY_AUTH_KEY);
    if (!raw) return 'none';
    const sb = supabase();
    const { data } = await sb.auth.getSession();
    if (data.session) {
      removeKey(LEGACY_AUTH_KEY);
      return 'none';
    }
    const token = parseLegacySession(raw);
    if (!token) {
      removeKey(LEGACY_AUTH_KEY);
      refusedHere = true;
      return 'refused';
    }
    try {
      const { data: d, error } = await sb.auth.refreshSession({ refresh_token: token.refreshToken });
      if (d.session && !error) {
        removeKey(LEGACY_AUTH_KEY);
        exchangedUser = d.session.user.id;
        return 'exchanged';
      }
      if (!isGenuineRefusal(error as { status?: number; name?: string } | null)) return 'offline';
      removeKey(LEGACY_AUTH_KEY);
      refusedUser = token.userId;
      refusedHere = true;
      return 'refused';
    } catch {
      // A throw is a transport problem, never the server's answer: try again later.
      return 'offline';
    }
  });
}

// Remove the old app's localStorage keys (not the auth key while an exchange may
// still need it) and its cache databases.
export async function cleanupLegacy(): Promise<string[]> {
  const removed = legacyKeysToRemove(allKeys()).filter((k) => k !== LEGACY_AUTH_KEY && k !== LEGACY_OUTBOX_KEY);
  for (const k of removed) removeKey(k);
  for (const name of LEGACY_DBS) await deleteNamedDb(name);
  return removed;
}

// ---------------------------------------------------------------- legacy outbox

interface LegacyRow {
  nonce?: unknown;
  scope_id?: unknown;
  thread_id?: unknown;
  text?: unknown;
  attachments?: unknown;
  created_at?: unknown;
  state?: unknown;
}

export function convertLegacyRows(rows: readonly LegacyRow[], tabId: string): OutboxRecord[] {
  const out: OutboxRecord[] = [];
  for (const r of rows) {
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!isUuid(r.nonce) || !isUuid(r.scope_id) || !text || text.length > 8000) continue;
    if (r.thread_id) continue;                                   // legacy thread ids do not map to roots
    if (Array.isArray(r.attachments) && r.attachments.length > 0) continue;   // old storage paths
    if (r.state === 'sent') continue;
    out.push({
      clientId: r.nonce.toLowerCase(),
      orgId: '',
      channelId: r.scope_id.toLowerCase(),
      threadRootId: null,
      body: text,
      attachmentIds: [],
      alsoInChannel: false,
      status: 'failed',
      attempts: 0,
      createdAt: typeof r.created_at === 'number' ? r.created_at : Date.now(),
      nextAttemptAt: null,
      error: { code: 'legacy', hint: 'Not sent before Dek was updated. Send it now, or delete it.' },
      statusVisible: true,
      ownerTab: tabId,
    });
  }
  return out;
}

function readLegacyIdb(): Promise<LegacyRow[]> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve([]);
      return;
    }
    let settled = false;
    const done = (rows: LegacyRow[]) => {
      if (!settled) {
        settled = true;
        resolve(rows);
      }
    };
    setTimeout(() => done([]), 3_000);
    try {
      // Probe without creating: an upgrade means the database did not exist.
      const req = indexedDB.open(LEGACY_OUTBOX_DB);
      req.onupgradeneeded = () => {
        req.transaction?.abort();
        done([]);
      };
      req.onerror = () => done([]);
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains('sends')) {
            db.close();
            done([]);
            return;
          }
          const all = db.transaction('sends', 'readonly').objectStore('sends').getAll();
          all.onsuccess = () => {
            db.close();
            done((all.result as LegacyRow[]) ?? []);
          };
          all.onerror = () => {
            db.close();
            done([]);
          };
        } catch {
          db.close();
          done([]);
        }
      };
    } catch {
      done([]);
    }
  });
}

// Whose legacy messages these are: someone else signing in on this phone must never
// inherit them, and they are deleted only once migrated or once the legacy session
// is gone for good (the server refused it). While the exchange is merely postponed
// (offline, 429, 5xx) they stay where they are.
export type LegacyOutboxPlan = 'migrate' | 'delete' | 'keep';

export function legacyOutboxPlan(userId: string, s: { exchanged: string | null; refused: string | null; refusedHere: boolean; pendingTokenUser: string | null }): LegacyOutboxPlan {
  if (s.exchanged === userId || s.refused === userId || s.pendingTokenUser === userId) return 'migrate';
  if (s.refusedHere) return 'delete';
  return 'keep';
}

export async function takeLegacyOutbox(userId: string, tabId: string): Promise<OutboxRecord[]> {
  const pending = parseLegacySession(readString(LEGACY_AUTH_KEY));
  const plan = legacyOutboxPlan(userId, { exchanged: exchangedUser, refused: refusedUser, refusedHere, pendingTokenUser: pending?.userId ?? null });
  if (plan === 'keep') return [];
  let rows: LegacyRow[] = [];
  if (plan === 'migrate') {
    rows = await readLegacyIdb();
    try {
      const ls = JSON.parse(readString(LEGACY_OUTBOX_KEY) ?? '[]') as unknown;
      if (Array.isArray(ls)) rows = rows.concat(ls as LegacyRow[]);
    } catch {
      /* unreadable: nothing to keep */
    }
    // The same person signed in another way: their legacy session is not needed now.
    if (pending?.userId === userId) removeKey(LEGACY_AUTH_KEY);
  }
  removeKey(LEGACY_OUTBOX_KEY);
  await deleteNamedDb(LEGACY_OUTBOX_DB);
  const seen = new Set<string>();
  return convertLegacyRows(rows, tabId).filter((r) => (seen.has(r.clientId) ? false : (seen.add(r.clientId), true)));
}
