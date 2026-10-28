// ensureProfiles: every screen asks for the people it shows; requests are batched
// (50 ms, at most 200 ids per call, the contract's limit) and de-duplicated, and
// answers are cached in IndexedDB so a cold start paints names at once.
import { api } from '../api/rpc';
import type { Profile } from '../api/types';
import type { UserDb } from '../lib/idb';
import { isUuid } from '../lib/uuid';
import { getState, setState } from '../store/state';
import { currentAccessGen,currentSessionGen, runtime } from './runtime';

export const BATCH_MS = 50;
export const MAX_IDS = 200;
const STALE_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const CACHE_LIMIT = 5_000;

interface ProfileRecord {
  id: string;
  profile: Profile;
  fetchedAt: number;
}

const queued = new Set<string>();
const inFlight = new Set<string>();
const fetchedAt = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function ensureProfiles(ids: readonly string[]): void {
  const known = getState().profiles;
  const now = Date.now();
  for (const id of ids) {
    if (!isUuid(id) || queued.has(id) || inFlight.has(id)) continue;
    const at = fetchedAt.get(id);
    if (known[id] && (at === undefined || now - at < STALE_MS)) continue;
    if (!known[id] && at !== undefined && now - at < RETRY_AFTER_FAILURE_MS) continue;
    queued.add(id);
  }
  if (queued.size === 0) return;
  if (queued.size >= MAX_IDS) {
    if (timer) clearTimeout(timer);
    timer = null;
    void flush();
  } else if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, BATCH_MS);
  }
}

async function flush(): Promise<void> {
  const batch = Array.from(queued).slice(0, MAX_IDS);
  for (const id of batch) {
    queued.delete(id);
    inFlight.add(id);
  }
  if (queued.size > 0 && !timer) {
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, BATCH_MS);
  }
  if (batch.length === 0) return;
  const gen = currentSessionGen();
  const access=currentAccessGen();
  try {
    const list = await api.getProfiles(batch);
    if (gen !== currentSessionGen() || access!==currentAccessGen()) return;
    const now = Date.now();
    mergeProfiles(Array.isArray(list) ? list : [], now);
    // Ids the server did not return (no shared organization) are not asked again
    // for a while: a missing name must not become a request loop.
    for (const id of batch) if (!fetchedAt.has(id)) fetchedAt.set(id, now);
  } catch {
    const now = Date.now();
    for (const id of batch) if (!getState().profiles[id]) fetchedAt.set(id, now);
  } finally {
    for (const id of batch) inFlight.delete(id);
  }
}

export function mergeProfiles(list: readonly Profile[], at: number = Date.now(), persist = true): void {
  const valid = list.filter((p) => p && isUuid(p.id));
  if (valid.length === 0) return;
  const profiles = { ...getState().profiles };
  for (const p of valid) {
    profiles[p.id] = p;
    fetchedAt.set(p.id, at);
  }
  setState({ profiles });
  if (persist) void saveProfiles(valid, at);
}

async function saveProfiles(list: readonly Profile[], at: number): Promise<void> {
  const rt = runtime();
  const access=currentAccessGen();
  if (!rt) return;
  const db = await rt.db;
  if (!db.ok || runtime()!==rt || access!==currentAccessGen()) return;
  await db.putMany('profiles', list.map((p): ProfileRecord => ({ id: p.id, profile: p, fetchedAt: at })));
}

export async function loadProfileCache(db: UserDb): Promise<void> {
  if (!db.ok) return;
  const gen = currentSessionGen();
  const access=currentAccessGen();
  const rows = await db.getAll<ProfileRecord>('profiles');
  if (gen !== currentSessionGen() || access!==currentAccessGen() || rows.length === 0) return;
  const profiles = { ...getState().profiles };
  let added = 0;
  for (const r of rows.slice(0, CACHE_LIMIT)) {
    if (!r?.profile || !isUuid(r.id) || profiles[r.id]) continue;
    profiles[r.id] = r.profile;
    fetchedAt.set(r.id, r.fetchedAt);
    added += 1;
  }
  if (added > 0) setState({ profiles });
}

export function resetProfiles(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  queued.clear();
  inFlight.clear();
  fetchedAt.clear();
}
