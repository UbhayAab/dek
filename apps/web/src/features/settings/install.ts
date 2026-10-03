// Install state for the settings screen. The platform builder owns the real
// install prompt (src/push/install.ts, useInstallPrompt: it keeps the
// beforeinstallprompt event from page load). This file uses it when it exists
// (Vite resolves the glob at build time, so a missing file is simply no match)
// and otherwise falls back to listening here, which only catches the event while
// the screen is open. Either way the iPhone gets Home Screen steps, never "not
// supported" (LESSONS "iPhone and phones", PRD DEK16).
import { useEffect, useState } from 'react';
import { detect, type PlatformInfo } from '../../lib/platform';

type Raw = Record<string, unknown> | null | undefined;

const found = import.meta.glob('../../push/install.ts', { eager: true }) as Record<string, Record<string, unknown>>;
const platformModule = found['../../push/install.ts'];
const platformHook = platformModule && typeof platformModule.useInstallPrompt === 'function'
  ? (platformModule.useInstallPrompt as () => Raw)
  : null;

export const INSTALL_SOURCE: 'platform' | 'local' = platformHook ? 'platform' : 'local';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type PromptOutcome = 'accepted' | 'dismissed' | 'unavailable';

export interface InstallState {
  platform: PlatformInfo;
  installed: boolean;
  canPrompt: boolean;
  prompt: (() => Promise<PromptOutcome>) | null;
  source: 'platform' | 'local';
}

function useLocalPrompt(): Raw {
  const [evt, setEvt] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setEvt(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  return {
    canInstall: !!evt,
    promptInstall: evt
      ? async () => {
        await evt.prompt();
        const choice = await evt.userChoice;
        setEvt(null);
        return choice.outcome;
      }
      : null,
  };
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isFn = (v: unknown): v is (...a: unknown[]) => unknown => typeof v === 'function';

function pick<T>(raw: Raw, keys: readonly string[], test: (v: unknown) => v is T): T | undefined {
  for (const k of keys) {
    const v = raw?.[k];
    if (test(v)) return v;
  }
  return undefined;
}

// Accepts the shapes an install hook plausibly returns ({ canInstall,
// promptInstall }, { available, prompt }, { state: 'available' | 'installed' }).
export function normalizeInstall(raw: Raw, platform: PlatformInfo, source: 'platform' | 'local'): InstallState {
  const state = typeof raw?.state === 'string' ? raw.state : typeof raw?.status === 'string' ? raw.status : null;
  const installed = pick(raw, ['installed', 'isInstalled', 'standalone', 'isStandalone'], isBool)
    ?? (state === 'installed' || platform.isStandalone);
  const fn = pick(raw, ['promptInstall', 'prompt', 'install', 'showPrompt'], isFn);
  const canPrompt = !installed && !!fn && (pick(raw, ['canInstall', 'canPrompt', 'available', 'promptable'], isBool)
    ?? (state === 'available' || state === 'ready' || state === 'promptable'));
  return {
    platform,
    installed,
    canPrompt,
    prompt: canPrompt && fn
      ? async () => {
        try {
          const out = await (fn as () => unknown)();
          if (out === 'accepted' || out === true) return 'accepted';
          if (out === 'dismissed' || out === false) return 'dismissed';
          if (out && typeof out === 'object' && 'outcome' in out) return (out as { outcome: PromptOutcome }).outcome;
          return 'accepted';
        } catch {
          return 'unavailable';
        }
      }
      : null,
    source,
  };
}

const useRaw: () => Raw = platformHook ?? useLocalPrompt;

export function useInstall(): InstallState {
  const raw = useRaw();
  return normalizeInstall(raw, detect(), INSTALL_SOURCE);
}
