import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/tokens.css';
import './ui/base.css';
import { App } from './app/App';

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
