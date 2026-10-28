// Saved (bookmarked) messages of the current organization. The ids load when the
// organization starts (list_saved_ids, newest first, at most 2000), stay in
// store.saved, follow saved.upd from every device of this person, and reload after a
// reconnect (an event missed while away). The UI imports exactly:
//   isSaved(id), useIsSaved(id), setSaved(id, saved)
import { api } from '../api/rpc';
import { DekError } from '../api/errors';
import { getState, setState, useDek } from '../store/state';
import { currentOrgGen } from './runtime';

export function isSaved(id: string): boolean {
  return getState().saved[id] === true;
}

export function useIsSaved(id: string): boolean {
  return useDek((s) => s.saved[id] === true);
}

function put(id: string, saved: boolean): void {
  const cur = getState().saved;
  if ((cur[id] === true) === saved) return;
  const next = { ...cur };
  if (saved) next[id] = true;
  else delete next[id];
  setState({ saved: next });
}

// Optimistic: the bookmark shows at once and goes back if the server refuses.
const inFlight = new Map<string, number>();
export async function setSaved(id: string, saved: boolean): Promise<void> {
  if (!getState().session.userId) throw new DekError('auth_required');
  const before = isSaved(id);
  const ticket = (inFlight.get(id) ?? 0) + 1;
  inFlight.set(id, ticket);
  put(id, saved);
  try {
    const r = await api.saveMessage(id, saved);
    if (inFlight.get(id) === ticket) put(id, r.saved);
  } catch (e) {
    // Only the latest tap for this message rolls back (a double tap must not flip it).
    if (inFlight.get(id) === ticket) put(id, before);
    throw e;
  } finally {
    if (inFlight.get(id) === ticket) inFlight.delete(id);
  }
}

// saved.upd { org_id, message_id, saved }: a save or unsave on any device.
export function applySavedEvent(p: { org_id?: string; message_id?: string; saved?: boolean }): void {
  if (!p.message_id || typeof p.saved !== 'boolean' || p.org_id !== getState().orgId) return;
  if (inFlight.has(p.message_id)) return;   // this tab's own tap: its reply decides
  put(p.message_id, p.saved);
}

export async function loadSavedIds(orgId: string): Promise<void> {
  const gen = currentOrgGen();
  try {
    const ids = await api.listSavedIds(orgId);
    if (gen !== currentOrgGen() || getState().orgId !== orgId) return;
    const saved: Record<string, true> = {};
    for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string') saved[id] = true;
    // Taps made while the list was loading win over the list.
    for (const [id] of inFlight) {
      if (getState().saved[id]) saved[id] = true;
      else delete saved[id];
    }
    setState({ saved });
  } catch {
    /* bookmarks are a convenience: the next start or reconnect loads them again */
  }
}

export function resetSaved(): void {
  inFlight.clear();
}
