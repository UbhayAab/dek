// One IndexedDB database per signed-in person: `dek-<user id>`. Sign-out deletes
// it whole, so nothing from one person survives for the next on a shared phone.
// Opening has a 3 s timeout: some Android WebViews leave indexedDB.open pending
// forever, and a store we cannot reach must degrade to fallbacks, not hang the app.
import { deleteDB, openDB, type IDBPDatabase } from 'idb';

export type StoreName = 'outbox' | 'pages' | 'profiles' | 'meta';

export const DB_PREFIX = 'dek-';
export const DB_VERSION = 1;
export const OPEN_TIMEOUT_MS = 3_000;

const KEYS: Record<StoreName, string> = { outbox: 'clientId', pages: 'channelId', profiles: 'id', meta: 'key' };

export function dbName(userId: string): string {
  return `${DB_PREFIX}${userId}`;
}

export interface UserDb {
  readonly name: string;
  readonly ok: boolean;
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: StoreName): Promise<T[]>;
  put(store: StoreName, value: unknown): Promise<boolean>;
  putMany(store: StoreName, values: unknown[]): Promise<boolean>;
  delete(store: StoreName, key: string): Promise<boolean>;
  clear(store: StoreName): Promise<boolean>;
  close(): void;
}

class NoDb implements UserDb {
  readonly ok = false;
  constructor(readonly name: string) {}
  async get<T>(): Promise<T | undefined> { return undefined; }
  async getAll<T>(): Promise<T[]> { return []; }
  async put(): Promise<boolean> { return false; }
  async putMany(): Promise<boolean> { return false; }
  async delete(): Promise<boolean> { return false; }
  async clear(): Promise<boolean> { return false; }
  close(): void { /* nothing open */ }
}

class IdbUserDb implements UserDb {
  readonly ok = true;
  private closed = false;
  constructor(readonly name: string, private readonly db: IDBPDatabase) {}

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    if (this.closed) return undefined;
    try {
      return (await this.db.get(store, key)) as T | undefined;
    } catch {
      return undefined;
    }
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    if (this.closed) return [];
    try {
      return (await this.db.getAll(store)) as T[];
    } catch {
      return [];
    }
  }

  async put(store: StoreName, value: unknown): Promise<boolean> {
    if (this.closed) return false;
    try {
      await this.db.put(store, value);
      return true;
    } catch {
      return false;
    }
  }

  async putMany(store: StoreName, values: unknown[]): Promise<boolean> {
    if (this.closed) return false;
    if (values.length === 0) return true;
    try {
      const tx = this.db.transaction(store, 'readwrite');
      await Promise.all([...values.map((v) => tx.store.put(v)), tx.done]);
      return true;
    } catch {
      return false;
    }
  }

  async delete(store: StoreName, key: string): Promise<boolean> {
    if (this.closed) return false;
    try {
      await this.db.delete(store, key);
      return true;
    } catch {
      return false;
    }
  }

  async clear(store: StoreName): Promise<boolean> {
    if (this.closed) return false;
    try {
      await this.db.clear(store);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export async function openUserDb(userId: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<UserDb> {
  const name = dbName(userId);
  if (!hasIndexedDb()) return new NoDb(name);
  let holder: IdbUserDb | null = null;
  const opening = openDB(name, DB_VERSION, {
    upgrade(db) {
      for (const store of Object.keys(KEYS) as StoreName[]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: KEYS[store] });
      }
    },
    // Another tab is deleting this database (sign-out) or upgrading it: let go.
    blocking() {
      holder?.close();
    },
  }).then((db) => {
    db.addEventListener('versionchange', () => holder?.close());
    holder = new IdbUserDb(name, db);
    return holder;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const won = await Promise.race([opening.catch(() => null), timeout]);
    if (won) return won;
    // Timed out: if it opens later, close it again so it cannot block a delete.
    opening.then((late) => late.close()).catch(() => undefined);
    return new NoDb(name);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Deletes this person's database, or every dek-<uuid> database when the browser
// can list them (leftovers of a session that ended without a clean sign-out).
export async function deleteUserDbs(userId: string | null): Promise<string[]> {
  if (!hasIndexedDb()) return [];
  const names = new Set<string>();
  if (userId) names.add(dbName(userId));
  try {
    const list = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    for (const d of list) {
      if (d.name && /^dek-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.name)) names.add(d.name);
    }
  } catch {
    /* databases() unsupported: the named one is enough */
  }
  const done: string[] = [];
  for (const name of names) {
    try {
      await withTimeout(deleteDB(name, { blocked: () => undefined }), 5_000);
      done.push(name);
    } catch {
      /* best effort */
    }
  }
  return done;
}

export async function deleteNamedDb(name: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await withTimeout(deleteDB(name, { blocked: () => undefined }), 3_000);
  } catch {
    /* best effort */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}
