// The move from the legacy app (same origin, project ybddogqphinruyunnuwx) to this
// one, run once at startup before the sign-in screen can show:
//
// 1. Session exchange: the migration copied refresh tokens at cutover, so a legacy
//    session's refresh token is accepted by the new project. With no new session
//    and a legacy key present, refreshSession({ refresh_token }) signs the person
//    in without a password. The legacy key is deleted on success and on refusal;
//    on a network failure it stays so the next start (online) can try again.
// 2. Leftovers the old app kept (dak.*, Dek.*, dek-backend.* keys, its IndexedDB
//    caches of private message pages) are removed so nothing old confuses the new
//    app or outlives a sign-out. dek.* keys belong to this app and are never touched.
// 3. Unsent legacy messages (its outbox) are kept for the same person: they come
//    back as failed sends with Try again and Delete, never sent silently, because
//    nothing can tell whether the old app delivered them in its last second.
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

let exchangedUser: string | null = null;
export function legacyExchangedUser(): string | null {
  return exchangedUser;
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
      return 'refused';
    }
    try {
      const { data: d, error } = await sb.auth.refreshSession({ refresh_token: token.refreshToken });
      if (error || !d.session) {
        const status = (error as { status?: number } | null)?.status ?? null;
        if (error && (status === 0 || toDekError(error, status).code === 'network')) return 'offline';
        removeKey(LEGACY_AUTH_KEY);
        return 'refused';
      }
      removeKey(LEGACY_AUTH_KEY);
      exchangedUser = d.session.user.id;
      return 'exchanged';
    } catch (e) {
      if (toDekError(e).code === 'network') return 'offline';
      removeKey(LEGACY_AUTH_KEY);
      return 'refused';
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

// Only for the person whose legacy session was exchanged: someone else signing in
// on this phone must never inherit their unsent text.
export async function takeLegacyOutbox(userId: string, tabId: string): Promise<OutboxRecord[]> {
  let rows: LegacyRow[] = [];
  if (exchangedUser && exchangedUser === userId) {
    rows = await readLegacyIdb();
    try {
      const ls = JSON.parse(readString(LEGACY_OUTBOX_KEY) ?? '[]') as unknown;
      if (Array.isArray(ls)) rows = rows.concat(ls as LegacyRow[]);
    } catch {
      /* unreadable: nothing to keep */
    }
  }
  removeKey(LEGACY_OUTBOX_KEY);
  await deleteNamedDb(LEGACY_OUTBOX_DB);
  const seen = new Set<string>();
  return convertLegacyRows(rows, tabId).filter((r) => (seen.has(r.clientId) ? false : (seen.add(r.clientId), true)));
}
