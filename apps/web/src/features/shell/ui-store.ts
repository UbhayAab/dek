// Interface-only state the shell and screens share (not data: data lives in the
// core store). Per-person memory in localStorage is keyed by user id, and every
// access is guarded because private windows and WebViews can throw.
import { create } from 'zustand';

interface UiState {
  dmPickerOpen: boolean;
}

export const useUi = create<UiState>()(() => ({ dmPickerOpen: false }));

export function openDmPicker(): void {
  useUi.setState({ dmPickerOpen: true });
}

export function closeDmPicker(): void {
  useUi.setState({ dmPickerOpen: false });
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the app works without this convenience.
  }
}

export function lastOrg(userId: string | null): string | null {
  return userId ? read(`dek.lastOrg.${userId}`) : null;
}

export function rememberOrg(userId: string | null, orgId: string): void {
  if (userId) write(`dek.lastOrg.${userId}`, orgId);
}

export function lastChannel(userId: string | null, orgId: string): string | null {
  return userId ? read(`dek.lastChannel.${userId}.${orgId}`) : null;
}

export function rememberChannel(userId: string | null, orgId: string, channelId: string): void {
  if (userId) write(`dek.lastChannel.${userId}.${orgId}`, channelId);
}

export function collapsedSections(userId: string | null): Record<string, boolean> {
  if (!userId) return {};
  try {
    const v = JSON.parse(read(`dek.collapsed.${userId}`) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function setCollapsed(userId: string | null, id: string, collapsed: boolean): void {
  if (!userId) return;
  const cur = collapsedSections(userId);
  write(`dek.collapsed.${userId}`, JSON.stringify({ ...cur, [id]: collapsed }));
}

export function categoryPreferenceId(orgId: string, serverId: string, category: string): string {
  return `category:${JSON.stringify([orgId, serverId, category])}`;
}
