// localStorage that never throws (private mode, quota, disabled storage) and keys
// that carry the user id, so sign-out can wipe exactly one person's leftovers on a
// shared phone (LESSONS "Every local cache keyed by user id and wiped on sign-out").
export const KEY_PREFIX = 'dek.';

export function userKey(name: string, userId: string): string {
  return `${KEY_PREFIX}${name}.${userId}`;
}

function ls(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const s = ls();
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  const s = ls();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readString(key: string): string | null {
  const s = ls();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): boolean {
  const s = ls();
  if (!s) return false;
  try {
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string): void {
  const s = ls();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    /* nothing stored, nothing to remove */
  }
}

export function allKeys(): string[] {
  const s = ls();
  if (!s) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k !== null) out.push(k);
    }
  } catch {
    /* storage went away mid-walk */
  }
  return out;
}

// Every dek.* key that belongs to this user: the user id is one dot-separated
// segment, last (dek.drafts.<user>) or not (the shell's dek.lastChannel.<user>.<org>).
export function isUserKey(key: string, userId: string): boolean {
  return key.startsWith(KEY_PREFIX) && (key.endsWith(`.${userId}`) || key.includes(`.${userId}.`));
}

export function removeUserKeys(userId: string, keep: readonly string[] = []): number {
  let n = 0;
  for (const k of allKeys()) {
    if (isUserKey(k, userId) && !keep.includes(k)) {
      removeKey(k);
      n += 1;
    }
  }
  return n;
}
