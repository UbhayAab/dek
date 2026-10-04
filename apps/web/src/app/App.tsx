// Root: route plus session state decide the screen. Owned by the lead; screens are
// owned by their builders (see each feature's index).
import { useEffect } from 'react';
import { useRoute } from './router';
import { useDek } from '../store';
import { Spinner, Toaster } from '../ui/kit';
import { AuthScreen, InviteScreen } from '../features/auth';
import { AppShell } from '../features/shell';
import { startApp } from '../sync';
import { ErrorBoundary } from './ErrorBoundary';
import './app.css';

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

  let screen;
  if (route.name === 'invite') screen = <InviteScreen code={route.code} />;
  else if (status === 'unknown') screen = <Splash />;
  else if (status === 'signed_out') screen = <AuthScreen next={route.name === 'signin' ? route.next : null} />;
  else screen = <AppShell />;

  return (
    <>
      <ErrorBoundary resetKey={JSON.stringify(route)}>{screen}</ErrorBoundary>
      <Toaster />
    </>
  );
}
