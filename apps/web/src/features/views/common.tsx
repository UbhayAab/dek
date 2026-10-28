// Shared pieces of the list views (Unread, Mentions, Threads, Saved, DMs): a paged
// loader that ignores stale answers, profile fetching for names, the screen frame,
// and the loading, error, empty and "load more" states every list needs.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { humanError } from '../../api/errors';
import { actions, useDek } from '../../store';
import type { IconName } from '../../ui/icons';
import { Button, ErrorState, Skeleton } from '../../ui/kit';
import { ScreenHeader } from '../shell/ScreenHeader';
import type { Layout } from '../shell/layout';
import './views.css';

export function isDeeper(layout: Layout): boolean {
  return layout === 'phone';
}

// Calls a store action that may not be wired yet (it throws synchronously while
// the core builder works) as a promise, so callers can catch either failure.
export function runAction<T>(fn: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(fn);
}

export function refreshCounters(): void {
  void runAction(() => actions.refreshBootstrap()).catch(() => undefined);
}

// ---------------------------------------------------------------- paged list

export interface ListState<T> {
  status: 'loading' | 'ready' | 'error';
  items: T[];
  hasMore: boolean;
  error: string | null;
  more: 'idle' | 'loading' | 'error';
  moreError: string | null;
}

interface PagedOptions<T, C> {
  // Everything that should start the list over (organization, view).
  resetKey: string;
  fetchPage: (cursor: C | null) => Promise<{ items: T[]; hasMore: boolean }>;
  cursorOf: (last: T) => C;
  idOf: (item: T) => string;
}

const INITIAL = { status: 'loading', items: [], hasMore: false, error: null, more: 'idle', moreError: null } as const;

export function usePagedList<T, C>({ resetKey, fetchPage, cursorOf, idOf }: PagedOptions<T, C>) {
  const [state, setState] = useState<ListState<T>>(INITIAL as unknown as ListState<T>);
  const generation = useRef(0);
  const fetchRef = useRef(fetchPage);
  const cursorRef = useRef(cursorOf);
  const idRef = useRef(idOf);
  fetchRef.current = fetchPage;
  cursorRef.current = cursorOf;
  idRef.current = idOf;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    generation.current += 1;
    const gen = generation.current;
    setState(INITIAL as unknown as ListState<T>);
    fetchRef.current(null)
      .then((page) => {
        if (gen !== generation.current) return;
        setState({ status: 'ready', items: page.items, hasMore: page.hasMore, error: null, more: 'idle', moreError: null });
      })
      .catch((e: unknown) => {
        if (gen !== generation.current) return;
        setState({ status: 'error', items: [], hasMore: false, error: humanError(e), more: 'idle', moreError: null });
      });
  }, [resetKey, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // Read through a ref: a fetch started inside a state updater would run twice
  // under StrictMode, and a double click must not load the same page twice.
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadMore = useCallback(() => {
    const cur = stateRef.current;
    if (cur.status !== 'ready' || !cur.hasMore || cur.more === 'loading') return;
    const last = cur.items[cur.items.length - 1];
    if (last === undefined) return;
    const gen = generation.current;
    stateRef.current = { ...cur, more: 'loading', moreError: null };
    setState((s) => ({ ...s, more: 'loading', moreError: null }));
    fetchRef.current(cursorRef.current(last))
      .then((page) => {
        if (gen !== generation.current) return;
        setState((s) => {
          const seen = new Set(s.items.map((x) => idRef.current(x)));
          const fresh = page.items.filter((x) => !seen.has(idRef.current(x)));
          return { ...s, items: [...s.items, ...fresh], hasMore: page.hasMore && fresh.length > 0, more: 'idle', moreError: null };
        });
      })
      .catch((e: unknown) => {
        if (gen !== generation.current) return;
        setState((s) => ({ ...s, more: 'error', moreError: humanError(e) }));
      });
  }, []);

  const remove = useCallback((id: string) => {
    setState((s) => ({ ...s, items: s.items.filter((x) => idRef.current(x) !== id) }));
  }, []);

  return { state, reload, loadMore, remove };
}

// ---------------------------------------------------------------- profiles

// Asks the store for any names it does not know yet, each id at most once per
// mount (a deleted account must not cause a request on every render).
export function useEnsureProfiles(ids: (string | null | undefined)[]): void {
  const profiles = useDek((s) => s.profiles);
  const asked = useRef(new Set<string>());
  const key = ids.filter(Boolean).join(',');
  useEffect(() => {
    const missing = [...new Set(key ? key.split(',') : [])].filter((id) => !profiles[id] && !asked.current.has(id));
    if (!missing.length) return;
    missing.forEach((id) => asked.current.add(id));
    try {
      actions.ensureProfiles(missing);
    } catch {
      // The core store is not wired yet; names show as "Someone" meanwhile.
    }
  }, [key, profiles]);
}

// ---------------------------------------------------------------- frame and states

interface FrameProps {
  title: string;
  icon: IconName;
  subtitle?: ReactNode;
  actions?: ReactNode;
  embedded?: boolean;
  children: ReactNode;
}

// A root screen (no back button): header plus one scrolling body. Embedded views
// (inside the Activity tabs) render only the body.
export function ViewFrame({ title, icon, subtitle, actions: headerActions, embedded, children }: FrameProps) {
  const titleId = useId();
  if (embedded) {
    return (
      <div className="dk-view__embedded">
        {headerActions ? <div className="dk-view__toolbar">{headerActions}</div> : null}
        {children}
      </div>
    );
  }
  return (
    <section className="dk-view" aria-labelledby={titleId}>
      <ScreenHeader title={title} icon={icon} subtitle={subtitle} actions={headerActions} titleId={titleId} />
      <div className="dk-view__body scroll-y">{children}</div>
    </section>
  );
}

export function LoadingRows({ count = 4, label }: { count?: number; label: string }) {
  return (
    <div className="dk-view__loading" role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => <Skeleton key={i} lines={i % 2 ? 2 : 3} />)}
    </div>
  );
}

interface ListBodyProps<T> {
  state: ListState<T>;
  loadingLabel: string;
  errorTitle: string;
  onRetry: () => void;
  onMore?: () => void;
  empty: ReactNode;
  children: ReactNode;
}

export function ListBody<T>({ state, loadingLabel, errorTitle, onRetry, onMore, empty, children }: ListBodyProps<T>) {
  if (state.status === 'loading') return <LoadingRows label={loadingLabel} />;
  if (state.status === 'error') return <ErrorState title={errorTitle} body={state.error ?? undefined} onRetry={onRetry} />;
  if (!state.items.length) return <>{empty}</>;
  return (
    <>
      {children}
      {state.hasMore && onMore ? (
        <div className="dk-view__more">
          {state.more === 'error' ? <p className="dk-view__moreerr" role="alert">{state.moreError}</p> : null}
          <Button variant="secondary" onClick={onMore} loading={state.more === 'loading'}>
            {state.more === 'error' ? 'Try again' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
