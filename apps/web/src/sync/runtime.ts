// The signed-in session's runtime: who is signed in, their database, their outbox,
// the generation tokens that make late answers from a previous session or a
// previous organization harmless, and which channels are on screen.
import { DekError } from '../api/errors';
import { currentRoute } from '../app/router';
import type { UserDb } from '../lib/idb';
import { newId } from '../lib/uuid';
import type { Outbox } from './outbox';

export interface Runtime {
  userId: string;
  gen: number;
  db: Promise<UserDb>;
  outbox: Outbox;
}

export const tabId = newId();

let rt: Runtime | null = null;
let sessionGen = 0;
let orgGen = 0;
let accessGen=0;
export const currentAccessGen=()=>accessGen;
export const nextAccessGen=()=>++accessGen;
let skewMs = 0;

export function runtime(): Runtime | null {
  return rt;
}

export function requireRuntime(): Runtime {
  if (!rt) throw new DekError('auth_required');
  return rt;
}

export function setRuntime(next: Runtime | null): void {
  rt = next;
}

export function nextSessionGen(): number {
  sessionGen += 1;
  return sessionGen;
}

export function currentSessionGen(): number {
  return sessionGen;
}

export function nextOrgGen(): number {
  orgGen += 1;
  return orgGen;
}

export function currentOrgGen(): number {
  return orgGen;
}

// Server clock estimate from bootstrap.server_time, for sync_channel's
// changed_since (the server compares updated_at with its own clock).
export function noteServerTime(iso: string, sentAt: number, receivedAt: number): void {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return;
  skewMs = t - (sentAt + receivedAt) / 2;
}

export function serverNowIso(offsetMs = 0): string {
  return new Date(Date.now() + skewMs + offsetMs).toISOString();
}

// ---------------------------------------------------------------- on screen

const openCount = new Map<string, number>();

export function markOpen(channelId: string): number {
  const n = (openCount.get(channelId) ?? 0) + 1;
  openCount.set(channelId, n);
  return n;
}

export function markClosed(channelId: string): number {
  const n = (openCount.get(channelId) ?? 0) - 1;
  if (n > 0) openCount.set(channelId, n);
  else openCount.delete(channelId);
  return Math.max(0, n);
}

export function isOpen(channelId: string): boolean {
  return openCount.has(channelId);
}

export function openChannels(): string[] {
  return Array.from(openCount.keys());
}

export function clearOpen(): void {
  openCount.clear();
}

export function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export function onScreen(channelId: string): boolean {
  const route = currentRoute();
  if (route.name === 'channel' && route.threadId && typeof window !== 'undefined' && !window.matchMedia?.('(min-width: 1100px)').matches) return false;
  return isOpen(channelId) && pageVisible();
}

// ---------------------------------------------------------------- tab liveness

// Each tab holds a Web Lock named after itself for its whole life, so another tab
// can ask "is the tab that owns this outbox record still open?".
let tabLockHeld = false;
export function holdTabLock(): void {
  if (tabLockHeld || typeof navigator === 'undefined' || !navigator.locks) return;
  tabLockHeld = true;
  navigator.locks.request(`dek-tab:${tabId}`, () => new Promise<void>(() => undefined)).catch(() => {
    tabLockHeld = false;
  });
}

export async function isTabAlive(id: string): Promise<boolean> {
  if (id === tabId) return true;
  if (typeof navigator === 'undefined' || !navigator.locks) return false;
  try {
    const snap = await navigator.locks.query();
    return (snap.held ?? []).some((l) => l.name === `dek-tab:${id}`);
  } catch {
    return false;
  }
}
