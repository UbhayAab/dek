// Names for the call screens: a person's display name (from the store, fetched
// once when missing) and the title of a call (the other person, the people of a
// group DM, or the audio channel).
import { useEffect, useReducer } from 'react';
import { api } from '../../api/rpc';
import type { Call, Profile } from '../../api/types';
import { actions, useDek } from '../../store';

const fetched = new Map<string, Profile>();
const pending = new Set<string>();
const listeners = new Set<() => void>();

function fetchMissing(ids: string[]): void {
  const need = ids.filter((id) => id && !fetched.has(id) && !pending.has(id));
  if (!need.length) return;
  try {
    actions.ensureProfiles(need);
    return;
  } catch {
    // the shared profile loader is not registered yet: fetch directly
  }
  for (const id of need) pending.add(id);
  api.getProfiles(need).then((list) => {
    for (const p of list) fetched.set(p.id, p);
  }).catch(() => undefined).finally(() => {
    for (const id of need) pending.delete(id);
    for (const l of [...listeners]) l();
  });
}

export function useProfiles(ids: (string | null | undefined)[]): Record<string, Profile | undefined> {
  const clean = ids.filter((x): x is string => !!x);
  const key = clean.join(',');
  const known = useDek((s) => s.profiles);
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => { listeners.delete(force); };
  }, []);
  useEffect(() => {
    const list = key ? key.split(',') : [];
    fetchMissing(list.filter((id) => !getKnown(id)));
  }, [key]);
  const out: Record<string, Profile | undefined> = {};
  for (const id of clean) out[id] = known[id] ?? fetched.get(id);
  return out;
}

function getKnown(id: string): Profile | undefined {
  return useDek.getState().profiles[id] ?? fetched.get(id);
}

export function displayName(p: Profile | undefined, fallback = 'Someone'): string {
  return p?.display_name || fallback;
}

export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// "Bob Member", "Bob, Carol and Ravi", "huddle".
export function useCallTitle(channelId: string | null, call: Call | null): string {
  const me = useDek((s) => s.session.userId);
  const channel = useDek((s) => (channelId ? s.channels[channelId] : undefined));
  const others = channel?.dm_user_ids?.length
    ? channel.dm_user_ids
    : (call?.participants ?? []).map((p) => p.user_id).filter((u) => u !== me);
  const profiles = useProfiles(others);
  if (channel?.kind === 'audio' || call?.kind === 'room') return channel?.name ?? 'Audio room';
  const names = others.map((id) => displayName(profiles[id]));
  return listNames(names) || channel?.name || 'Call';
}
