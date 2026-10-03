import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/tokens.css';
import './ui/base.css';
import { App } from './app/App';
import { applyStoredTheme } from './features/settings/theme';
import { initNative } from './native';

// Native shells (Capacitor) set up secure session storage, deep links and the back
// button before anything creates the Supabase client. A no-op in browsers.
initNative();

// Before first paint, so a dark choice never flashes light.
applyStoredTheme();

// iOS Safari applies :active styles on touch only when the document has at least
// one touchstart listener; without it taps give no feedback at all.
document.addEventListener('touchstart', () => undefined, { passive: true });

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
