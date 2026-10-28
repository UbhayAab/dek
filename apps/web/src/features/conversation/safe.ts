// Store actions are implemented by another builder and may throw synchronously
// (placeholder) or reject. These wrappers turn both into one rejected promise so
// every caller can show a real failure state instead of crashing the screen.
import { useEffect, useState } from 'react';

export function run<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e);
  }
}

// Fire and forget for void actions (markRead, notifyTyping): never throws.
export function fire(fn: () => unknown): void {
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => undefined);
  } catch {
    // The action is not available yet; the interface keeps working without it.
  }
}

// Visible AND focused: the only time reading should count as read (DEK unread).
function activeNow(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}

export function useDocumentActive(): boolean {
  const [active, setActive] = useState(activeNow);
  useEffect(() => {
    const update = () => setActive(activeNow());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return active;
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}
