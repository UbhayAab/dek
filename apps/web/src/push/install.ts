// Install Dek as an app (LESSONS "iPhone and phones"): Chromium fires
// beforeinstallprompt, which is stashed and replayed from a click; iOS has no such
// event, so it gets the Share then Add to Home Screen steps (DEK16).
import { useSyncExternalStore } from 'react';
import { detect, type PlatformInfo } from '../lib/platform';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

let attached = false;
export function attachInstallListeners(): void {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
}
attachInstallListeners();

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

export async function promptInstall(): Promise<InstallOutcome> {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null;   // a prompt event can be used once
  emit();
  try {
    await e.prompt();
    const choice = await e.userChoice;
    if (choice.outcome === 'accepted') installed = true;
    emit();
    return choice.outcome;
  } catch {
    return 'unavailable';
  }
}

export interface InstallState {
  platform: PlatformInfo;
  installed: boolean;          // running as the installed app (or just installed)
  canPrompt: boolean;          // the browser's own install dialog is available
  showIosSteps: boolean;       // iPhone or iPad in Safari: Share, Add to Home Screen
  iosOtherBrowser: boolean;    // iPhone in Chrome or Firefox: open in Safari first
  prompt: () => Promise<InstallOutcome>;
}

export function useInstallPrompt(): InstallState {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => version,
    () => 0,
  );
  const platform = detect();
  const isInstalled = installed || platform.isStandalone;
  return {
    platform,
    installed: isInstalled,
    canPrompt: !isInstalled && deferred !== null,
    showIosSteps: !isInstalled && platform.isIOS && platform.isIOSSafari,
    iosOtherBrowser: !isInstalled && platform.isIOS && !platform.isIOSSafari,
    prompt: promptInstall,
  };
}
