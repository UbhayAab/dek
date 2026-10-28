// The caller's block list (DEK13), fetched once and shared by the DM composer, the
// members panel and Settings. Keyed by the signed-in person, so a shared computer never
// shows one person's blocks to the next; dropped after every block or unblock.
import { api } from '../../api/rpc';
import { getState } from '../../store';

let cache: { uid: string | null; list: Promise<Set<string>> } | null = null;

export function myBlocks(): Promise<Set<string>> {
  const uid = getState().session.userId;
  if (!cache || cache.uid !== uid) {
    const list = api.listBlocks()
      .then((r) => new Set(r.items.map((p) => p.id)))
      .catch(() => {
        cache = null; // a failed fetch must not stick
        return new Set<string>();
      });
    cache = { uid, list };
  }
  return cache.list;
}

export function forgetBlocks(): void {
  cache = null;
}

export async function setBlocked(userId: string, blocked: boolean): Promise<void> {
  try {
    await api.blockUser(userId, blocked);
  } finally {
    forgetBlocks();
  }
}
