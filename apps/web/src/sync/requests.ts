// Requests to join locked channels (migration 0916): a revision counter that screens
// re-load on, the count of requests waiting for this person, and the notices join.req
// brings. Approvers learn of a new request at once; the person who asked learns the answer.
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api/rpc';
import { navigate } from '../app/router';
import { getState } from '../store/state';
import { toast } from '../ui/kit';

let rev = 0;          // bumped by every join.req: lists re-load
let version = 0;      // bumped when anything here changes: hooks re-render
const counts = new Map<string, number>();
const fetched = new Map<string, number>();
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  listeners.forEach((l) => l());
}

export function bumpRequests(): void {
  rev += 1;
  changed();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function useVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

export function useRequestsRev(): number {
  useVersion();
  return rev;
}

// Pending requests this person may decide in the organization. One small call per
// organization and revision; people who approve nothing get an empty list.
export function useRequestCount(orgId: string | null): number {
  useVersion();
  const r = rev;
  useEffect(() => {
    if (!orgId || fetched.get(orgId) === r) return;
    fetched.set(orgId, r);
    api.listChannelRequests(orgId)
      .then((res) => setRequestCount(orgId, res.items.length))
      .catch(() => fetched.delete(orgId));
  }, [orgId, r]);
  return orgId ? counts.get(orgId) ?? 0 : 0;
}

export function setRequestCount(orgId: string, n: number): void {
  if (counts.get(orgId) === n) return;
  counts.set(orgId, n);
  changed();
}

export function onJoinRequest(p: { org_id: string; channel_id: string; user_id: string; change: string }): void {
  bumpRequests();
  const s = getState();
  const me = s.session.userId;
  if (p.change === 'new' && p.user_id !== me) {
    toast({
      kind: 'info',
      title: 'Someone asked to join a channel',
      body: 'You can let them in or decline.',
      duration: 10_000,
      action: { label: 'Review', onClick: () => navigate(`/o/${p.org_id}/activity?tab=requests`) },
    });
  } else if (p.user_id === me && (p.change === 'approved' || p.change === 'rejected')) {
    const name = s.channels[p.channel_id]?.name;
    toast(p.change === 'approved'
      ? { kind: 'success', title: name ? `You are in #${name} now` : 'Your request to join was approved',
          action: { label: 'Open', onClick: () => navigate(`/o/${p.org_id}/c/${p.channel_id}`) } }
      : { kind: 'info', title: 'Your request to join a channel was declined' });
  }
}
