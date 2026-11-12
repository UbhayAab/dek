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

// Server/org requests have their own event. Older cached0916 clients ignore it
// instead of mistaking a server for a channel during migration-first rollout.
export function serverRequestPath(orgId: string, serverId: string | null, orgRole?: string): string {
  return !serverId || orgRole === 'owner' || orgRole === 'admin'
    ? `/o/${orgId}/admin/requests`
    : `/o/${orgId}/s/${serverId}/settings#requests`;
}

type ServerRequestNotice = {
  org_id: string; server_id: string | null; request_id: string; user_id: string;
  change: 'new' | 'withdrawn' | 'approved' | 'rejected';
};
const seenServerRequests = new Set<string>();

export function onServerJoinRequest(p: ServerRequestNotice): void {
  const s = getState();
  const me = s.session.userId;
  if (!me) return;
  // The hub already deduplicates wire eid values. Also coalesce a repeated new
  // notice by request/account, with a bounded cache that cannot suppress another
  // signed-in person's notification. Decision events still refresh open lists.
  if (p.change === 'new') {
    const key = `${me}:${p.request_id}`;
    if (seenServerRequests.has(key)) return;
    seenServerRequests.add(key);
    if (seenServerRequests.size > 512) seenServerRequests.delete(seenServerRequests.values().next().value!);
  }
  bumpRequests();
  if (p.change === 'new' && p.user_id !== me) {
    const role = s.orgs.find(o => o.id === p.org_id)?.my_role;
    toast({
      kind: 'info', title: p.server_id ? 'Someone asked to join a team server' : 'Someone asked to join an organization',
      body: 'You can let them in or decline.', duration: 10_000,
      action: { label: 'Review', onClick: () => navigate(serverRequestPath(p.org_id, p.server_id, role)) },
    });
  } else if (p.user_id === me && p.change === 'approved') {
    toast({ kind: 'success', title: 'Your request to join was approved',
      action: { label: 'Open', onClick: () => navigate(p.server_id ? `/o/${p.org_id}/browse/${p.server_id}` : `/o/${p.org_id}`) } });
  } else if (p.user_id === me && p.change === 'rejected') {
    toast({ kind: 'info', title: 'Your request to join was declined' });
  }
}
