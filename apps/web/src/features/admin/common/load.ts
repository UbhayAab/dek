// Loading and mutation state for the admin and settings screens. Every screen goes
// through these two hooks so loading, empty, denied, retryable and terminal failures
// look and behave the same everywhere (PRD "Interface and completion requirements").
import { useCallback, useEffect, useRef, useState } from 'react';
import { DekError, toDekError } from '../../../api/errors';

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface Load<T> {
  status: LoadStatus;
  data: T | null;
  // A failure. With status 'ready' it is a failed background refresh of shown data.
  error: DekError | null;
  refreshing: boolean;
  reload: () => void;
  // Local update after a confirmed server change (the server answered first).
  mutate: (update: (prev: T | null) => T | null) => void;
}

// Last good answer per key (an org's servers, a server's channels): a section that
// opens again shows it at once and refreshes underneath. Memory only; wiped on
// sign-out with this feature's other caches.
const cache = new Map<string, unknown>();

export function invalidate(prefix: string): void {
  for (const k of Array.from(cache.keys())) if (k.startsWith(prefix)) cache.delete(k);
}

export function clearLoadCache(): void {
  cache.clear();
}

interface Inner<T> {
  status: LoadStatus;
  data: T | null;
  error: DekError | null;
  refreshing: boolean;
}

export function useLoad<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[],
  opts: { key?: string | null; enabled?: boolean } = {},
): Load<T> {
  const key = opts.key ?? null;
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<Inner<T>>(() => {
    const hit = key !== null && cache.has(key);
    return { status: hit ? 'ready' : 'loading', data: hit ? (cache.get(key) as T) : null, error: null, refreshing: false };
  });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const gen = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    gen.current += 1;
    const mine = gen.current;
    const hit = key !== null && cache.has(key);
    setState((prev) => (hit
      ? { status: 'ready', data: cache.get(key as string) as T, error: null, refreshing: true }
      : { status: 'loading', data: prev.data, error: null, refreshing: false }));
    let alive = true;
    fnRef.current().then(
      (data) => {
        if (!alive || gen.current !== mine) return;
        if (key !== null) cache.set(key, data);
        setState({ status: 'ready', data, error: null, refreshing: false });
      },
      (err: unknown) => {
        if (!alive || gen.current !== mine) return;
        const e = toDekError(err);
        setState((prev) => (hit && prev.data !== null
          ? { status: 'ready', data: prev.data, error: e, refreshing: false }
          : { status: 'error', data: prev.data, error: e, refreshing: false }));
      },
    );
    return () => { alive = false; };
    // The caller lists what the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback((update: (prev: T | null) => T | null) => {
    setState((prev) => {
      const data = update(prev.data);
      if (key !== null) {
        if (data === null) cache.delete(key);
        else cache.set(key, data);
      }
      return { ...prev, data, status: data === null ? prev.status : 'ready', error: null };
    });
  }, [key]);

  return { ...state, reload, mutate };
}

// error null = skipped because the same action is already running (double submit).
export type ActionResult<R> = { ok: true; value: R } | { ok: false; error: DekError | null };

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<ActionResult<R>>;
  busy: boolean;
  error: DekError | null;
  reset: () => void;
}

export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): Action<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DekError | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async (...args: A): Promise<ActionResult<R>> => {
    if (inFlight.current) return { ok: false, error: null };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await fnRef.current(...args);
      return { ok: true, value };
    } catch (err) {
      const e = toDekError(err);
      if (mounted.current) setError(e);
      return { ok: false, error: e };
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  const reset = useCallback(() => setError(null), []);
  return { run, busy, error, reset };
}

// Which form field a server refusal is about. The server's hints name the field
// first ("name is required.", "display_name: use 1 to 80 characters", "handle: that
// handle is already taken."), so the message can sit under the right input.
export function fieldFromHint(
  err: DekError | null,
  fields: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string | null {
  if (!err || (err.code !== 'invalid_input' && err.code !== 'conflict')) return null;
  const hint = err.hint.toLowerCase().trim();
  const candidates = [...fields.map((f) => [f, f] as const), ...Object.entries(aliases).map(([k, v]) => [k, v] as const)]
    .sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, field] of candidates) {
    const p = prefix.toLowerCase();
    if (hint.startsWith(`${p}:`) || hint.startsWith(`${p} `) || hint.startsWith(`${p}.`) || hint.startsWith(`settings.${p}`)) {
      return field;
    }
  }
  if (err.code === 'conflict' && fields.includes('name') && /\bname\b/.test(hint)) return 'name';
  return null;
}

// A function the contract lists but the database does not have yet (PostgREST 404).
export function isMissingFunction(err: DekError | null): boolean {
  return !!err && err.code === 'unknown' && err.status === 404;
}

export function asDekError(err: unknown): DekError {
  return err instanceof DekError ? err : toDekError(err);
}

// ------------------------------------------------------------------ paged lists

export interface Page<T, C> {
  items: T[];
  next: C | null;
  total?: number | null;
}

export interface Paged<T> {
  items: T[];
  total: number | null;
  hasMore: boolean;
  status: LoadStatus;
  error: DekError | null;
  loadingMore: boolean;
  moreError: DekError | null;
  loadMore: () => void;
  reload: () => void;
  update: (fn: (items: T[]) => T[]) => void;
}

interface PagedInner<T, C> {
  items: T[];
  next: C | null;
  total: number | null;
  status: LoadStatus;
  error: DekError | null;
  loadingMore: boolean;
  moreError: DekError | null;
}

// A list read page by page (offset or cursor). The first page reloads when deps
// change; "show more" appends; update() applies a confirmed change locally.
export function usePaged<T, C>(fetchPage: (cursor: C | null) => Promise<Page<T, C>>, deps: readonly unknown[]): Paged<T> {
  const [s, setS] = useState<PagedInner<T, C>>({
    items: [], next: null, total: null, status: 'loading', error: null, loadingMore: false, moreError: null,
  });
  const [nonce, setNonce] = useState(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const gen = useRef(0);
  const nextRef = useRef<C | null>(null);
  const moreBusy = useRef(false);

  useEffect(() => {
    gen.current += 1;
    const mine = gen.current;
    moreBusy.current = false;
    setS((prev) => ({ ...prev, status: 'loading', error: null, loadingMore: false, moreError: null }));
    fetchRef.current(null).then(
      (page) => {
        if (gen.current !== mine) return;
        nextRef.current = page.next;
        setS({ items: page.items, next: page.next, total: page.total ?? null, status: 'ready', error: null, loadingMore: false, moreError: null });
      },
      (err: unknown) => {
        if (gen.current !== mine) return;
        setS((prev) => ({ ...prev, items: [], next: null, status: 'error', error: toDekError(err) }));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const loadMore = useCallback(() => {
    const cursor = nextRef.current;
    if (cursor === null || moreBusy.current) return;
    moreBusy.current = true;
    const mine = gen.current;
    setS((prev) => ({ ...prev, loadingMore: true, moreError: null }));
    fetchRef.current(cursor).then(
      (page) => {
        moreBusy.current = false;
        if (gen.current !== mine) return;
        nextRef.current = page.next;
        setS((prev) => ({
          ...prev,
          items: [...prev.items, ...page.items],
          next: page.next,
          total: page.total ?? prev.total,
          loadingMore: false,
        }));
      },
      (err: unknown) => {
        moreBusy.current = false;
        if (gen.current !== mine) return;
        setS((prev) => ({ ...prev, loadingMore: false, moreError: toDekError(err) }));
      },
    );
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const update = useCallback((fn: (items: T[]) => T[]) => setS((prev) => ({ ...prev, items: fn(prev.items) })), []);

  return {
    items: s.items,
    total: s.total,
    hasMore: s.next !== null,
    status: s.status,
    error: s.error,
    loadingMore: s.loadingMore,
    moreError: s.moreError,
    loadMore,
    reload,
    update,
  };
}

// Offset pages for the list functions that return { items, total }.
export function offsetPage<T>(res: { items: T[]; total?: number }, offset: number): Page<T, number> {
  const seen = offset + res.items.length;
  const total = typeof res.total === 'number' ? res.total : null;
  const more = total !== null ? seen < total : false;
  return { items: res.items, next: more && res.items.length > 0 ? seen : null, total };
}
