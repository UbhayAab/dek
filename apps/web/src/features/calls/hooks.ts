// Hooks the call screens share.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { api } from '../../api/rpc';
import type { Call, CallParticipant } from '../../api/types';
import { useDek } from '../../store';
import type { CallView } from './engine';
import { callEngine } from './runtime';

export function useCallView<T>(select: (v: CallView) => T): T {
  return useStore(callEngine.store, select);
}

export const LIVE_STATUSES = new Set(['starting', 'ringing', 'connecting', 'connected', 'reconnecting']);

export function isLiveStatus(s: string): boolean {
  return LIVE_STATUSES.has(s);
}

const subscribers = new Map<string, (cb: () => void) => () => void>();

function subscribeMedia(query: string): (cb: () => void) => () => void {
  let fn = subscribers.get(query);
  if (!fn) {
    fn = (cb: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    };
    subscribers.set(query, fn);
  }
  return fn;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribeMedia(query),
    () => (typeof window !== 'undefined' && !!window.matchMedia?.(query).matches),
    () => false,
  );
}

export function useIsPhone(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

// One row per person: a reconnect with a new session id is the same person
// (DEKA13), so the list is keyed by user, never by session.
export function joinedPeople(call: Call | null): CallParticipant[] {
  if (!call) return [];
  const seen = new Map<string, CallParticipant>();
  for (const p of call.participants) {
    if (p.state !== 'joined') continue;
    const prev = seen.get(p.user_id);
    if (!prev || (p.joined_at ?? '') > (prev.joined_at ?? '')) seen.set(p.user_id, p);
  }
  return [...seen.values()];
}

// The live room of an audio channel: the engine's view when this tab is in it
// (freshest), else store.calls (call.upd events), else one active_calls read.
const roomCache = new Map<string, { call: Call | null; at: number }>();
const ROOM_CACHE_MS = 15_000;

export function useRoomCall(channelId: string): Call | null {
  const orgId = useDek((s) => s.channels[channelId]?.org_id ?? s.orgId);
  const fromStore = useDek((s) => {
    for (const c of Object.values(s.calls)) {
      if (c.channel_id === channelId && c.kind === 'room' && !c.ended_at) return c;
    }
    return null;
  });
  const fromEngine = useCallView((v) => (v.kind === 'room' && v.channelId === channelId && v.call && !v.final && !v.call.ended_at ? v.call : null));
  const [fetched, setFetched] = useState<Call | null>(() => roomCache.get(channelId)?.call ?? null);
  useEffect(() => {
    if (fromStore || fromEngine || !orgId) return undefined;
    const hit = roomCache.get(channelId);
    if (hit && Date.now() - hit.at < ROOM_CACHE_MS) {
      setFetched(hit.call);
      return undefined;
    }
    let alive = true;
    api.activeCalls(orgId).then((list) => {
      const c = list.find((x) => x.channel_id === channelId && x.kind === 'room' && !x.ended_at) ?? null;
      roomCache.set(channelId, { call: c, at: Date.now() });
      if (alive) setFetched(c);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [channelId, orgId, fromStore, fromEngine]);
  return fromEngine ?? fromStore ?? fetched;
}

export function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '';
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
