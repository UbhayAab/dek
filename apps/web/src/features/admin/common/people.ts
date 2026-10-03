// Names for ids (invite creators, audit actors and targets). Uses the store's
// profiles first, then asks get_profiles once per batch (at most 200 ids, deduped,
// coalesced over 30 ms). A failed batch is not retried in a loop: the next screen
// that needs the name asks again.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from '../../../api/rpc';
import type { Profile } from '../../../api/types';
import { getState, useDek } from '../../../store';

const known = new Map<string, Profile>();
const unknown = new Set<string>();
const queue = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function bump(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function rememberProfiles(list: readonly (Profile | null | undefined)[]): void {
  let changed = false;
  for (const p of list) {
    if (p && p.id) {
      known.set(p.id, p);
      unknown.delete(p.id);
      changed = true;
    }
  }
  if (changed) bump();
}

export function clearProfileCache(): void {
  known.clear();
  unknown.clear();
  queue.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  bump();
}

export function profileOf(id: string | null | undefined): Profile | null {
  if (!id) return null;
  return known.get(id) ?? getState().profiles[id] ?? null;
}

async function flush(): Promise<void> {
  timer = null;
  const ids = Array.from(queue).slice(0, 200);
  for (const id of ids) queue.delete(id);
  if (!ids.length) return;
  try {
    const list = await api.getProfiles(ids);
    rememberProfiles(list);
    const got = new Set(list.map((p) => p.id));
    for (const id of ids) if (!got.has(id)) unknown.add(id);
    bump();
  } catch {
    // keep going without names; a later screen asks again
  }
  if (queue.size && !timer) timer = setTimeout(() => { void flush(); }, 30);
}

export function requestProfiles(ids: readonly (string | null | undefined)[]): void {
  const store = getState().profiles;
  for (const id of ids) {
    if (id && !known.has(id) && !store[id] && !unknown.has(id)) queue.add(id);
  }
  if (queue.size && !timer) timer = setTimeout(() => { void flush(); }, 30);
}

// A lookup that re-renders when names arrive.
export function useProfiles(ids: readonly (string | null | undefined)[]): (id: string | null | undefined) => Profile | null {
  const v = useSyncExternalStore(subscribe, () => version, () => version);
  const store = useDek((s) => s.profiles);
  const key = Array.from(new Set(ids.filter((x): x is string => !!x))).sort().join(',');
  useEffect(() => {
    if (key) requestProfiles(key.split(','));
  }, [key]);
  return useCallback(
    (id: string | null | undefined) => (id ? known.get(id) ?? store[id] ?? null : null),
    // version: names that arrived since the last render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, v],
  );
}

export function nameOf(p: Profile | null | undefined, fallback = 'Someone'): string {
  return p?.display_name ?? fallback;
}

export function isUnknownProfile(id: string): boolean {
  return unknown.has(id);
}
