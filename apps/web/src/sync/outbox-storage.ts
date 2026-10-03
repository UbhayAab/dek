// Where the outbox lives: the person's IndexedDB (store `outbox`), and localStorage
// (`dek.outbox.<user>`) when IndexedDB is missing, refused or hangs past its 3 s
// open timeout (private-mode WebViews). Reads merge both, so a record written
// through the fallback during a bad moment is never forgotten.
import type { UserDb } from '../lib/idb';
import { readJson, removeKey, userKey, writeJson } from '../lib/storage';
import type { OutboxRecord, OutboxStorage } from './outbox';

function isRecord(x: unknown): x is OutboxRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<OutboxRecord>;
  return typeof r.clientId === 'string' && typeof r.channelId === 'string' && typeof r.body === 'string' && typeof r.createdAt === 'number';
}

export function createOutboxStorage(db: Promise<UserDb>, userId: string): OutboxStorage {
  const lsKey = userKey('outbox', userId);

  const lsRows = (): OutboxRecord[] => {
    const rows = readJson<unknown>(lsKey, []);
    return Array.isArray(rows) ? rows.filter(isRecord) : [];
  };

  const lsWrite = (rows: OutboxRecord[]): void => {
    if (rows.length === 0) removeKey(lsKey);
    else writeJson(lsKey, rows);
  };

  return {
    async load() {
      const d = await db;
      const out = new Map<string, OutboxRecord>();
      for (const r of lsRows()) out.set(r.clientId, r);
      if (d.ok) for (const r of await d.getAll<OutboxRecord>('outbox')) if (isRecord(r)) out.set(r.clientId, r);
      return Array.from(out.values());
    },
    async save(rec) {
      const d = await db;
      if (d.ok && (await d.put('outbox', rec))) {
        const rows = lsRows();
        if (rows.some((r) => r.clientId === rec.clientId)) lsWrite(rows.filter((r) => r.clientId !== rec.clientId));
        return;
      }
      const rows = lsRows().filter((r) => r.clientId !== rec.clientId);
      rows.push(rec);
      lsWrite(rows);
    },
    async remove(clientId) {
      const d = await db;
      if (d.ok) await d.delete('outbox', clientId);
      const rows = lsRows();
      if (rows.some((r) => r.clientId === clientId)) lsWrite(rows.filter((r) => r.clientId !== clientId));
    },
  };
}

// Tests and the localStorage-only path.
export function memoryOutboxStorage(initial: OutboxRecord[] = []): OutboxStorage & { rows: Map<string, OutboxRecord>; log: string[] } {
  const rows = new Map(initial.map((r) => [r.clientId, r]));
  const log: string[] = [];
  return {
    rows,
    log,
    async load() {
      return Array.from(rows.values());
    },
    async save(rec) {
      log.push(`save:${rec.clientId}:${rec.status}`);
      rows.set(rec.clientId, { ...rec });
    },
    async remove(clientId) {
      log.push(`remove:${clientId}`);
      rows.delete(clientId);
    },
  };
}
