// Root: route plus session state decide the screen. Owned by the lead; screens are
// owned by their builders (see each feature's index).
import { lazy, Suspense, useEffect } from 'react';
import { useRoute } from './router';
import { useDek } from '../store';
import { Spinner, Toaster } from '../ui/kit';
import { AuthScreen, InviteScreen } from '../features/auth';
import { AUTH_STORAGE_KEY } from '../api/client';
import { startApp } from '../sync';
import { LEGACY_AUTH_KEY } from '../sync/legacy';
import { ErrorBoundary } from './ErrorBoundary';
import './app.css';

// The signed-in app is its own chunk, so the sign-in screen does not wait for it. A
// device that already holds a session (ours, or the old app's) starts that download at
// once, in parallel with restoring the session: signed-in people wait no longer than
// before. Everyone else fetches it in the background while they type (AuthScreen).
const loadShell = () => import('../features/shell');
const AppShell = lazy(() => loadShell().then((m) => ({ default: m.AppShell })));

function hasStoredSession(): boolean {
  try {
    return !!(window.localStorage.getItem(AUTH_STORAGE_KEY) || window.localStorage.getItem(LEGACY_AUTH_KEY));
  } catch {
    return false;
  }
}
if (typeof window !== 'undefined' && hasStoredSession()) void loadShell().catch(() => undefined);

function usePrefetchShell(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const t = window.setTimeout(() => { void loadShell().catch(() => undefined); }, 1500);
    return () => window.clearTimeout(t);
  }, [active]);
}

function Splash() {
  return (
    <div className="dk-splash" role="status" aria-label="Loading Dek">
      <span className="dk-splash__mark" aria-hidden="true">Dek</span>
      <Spinner size={22} />
    </div>
  );
}

export function App() {
  useEffect(() => {
    startApp();
  }, []);
  const route = useRoute();
  const status = useDek((s) => s.session.status);
  usePrefetchShell(status === 'signed_out' || route.name === 'invite');

  let screen;
  if (route.name === 'invite') screen = <InviteScreen code={route.code} />;
  else if (status === 'unknown') screen = <Splash />;
  else if (status === 'signed_out') screen = <AuthScreen next={route.name === 'signin' ? route.next : null} />;
  else screen = <Suspense fallback={<Splash />}><AppShell /></Suspense>;

  return (
    <>
      <ErrorBoundary resetKey={JSON.stringify(route)}>{screen}</ErrorBoundary>
      <Toaster />
    </>
  );
}
