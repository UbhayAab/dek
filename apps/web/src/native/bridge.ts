// OWNER: native builder. The one door from the web app to the native shell.
//
// The Capacitor shell (apps/mobile) injects `window.Capacitor` before any page
// script runs. Dek's web bundle deliberately does not import @capacitor/* packages:
// the web deploy must not depend on the mobile toolchain, and the shared lockfile
// stays untouched. These helpers make the same bridge calls @capacitor/core's
// registerPlugin makes (Capacitor.nativePromise and Capacitor.addListener, stable
// since Capacitor 3 and present in 8.5). On the web `window.Capacitor` does not
// exist, isNativeApp() is false and every caller turns into a no-op.

export type NativePlatform = 'android' | 'ios';

interface PluginHeader {
  name: string;
  methods?: { name: string; rtype?: string }[];
}

interface ListenerHandle {
  remove: () => Promise<void> | void;
}

export interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  PluginHeaders?: PluginHeader[];
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
  addListener?: (plugin: string, event: string, cb: (data: unknown, err?: unknown) => void) => ListenerHandle;
}

export class NativeUnavailableError extends Error {
  constructor(what: string) {
    super(`Native feature unavailable: ${what}`);
    this.name = 'NativeUnavailableError';
  }
}

function cap(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

export function isNativeApp(): boolean {
  const c = cap();
  if (!c || typeof c.isNativePlatform !== 'function' || typeof c.nativePromise !== 'function') return false;
  try {
    return c.isNativePlatform() === true;
  } catch {
    return false;
  }
}

export function nativePlatform(): NativePlatform | 'web' {
  if (!isNativeApp()) return 'web';
  const p = cap()?.getPlatform?.();
  return p === 'android' || p === 'ios' ? p : 'web';
}

// A plugin is in this build when the shell announced it in PluginHeaders.
export function hasPlugin(name: string): boolean {
  return !!cap()?.PluginHeaders?.some((h) => h.name === name);
}

export async function callNative<T>(plugin: string, method: string, options: Record<string, unknown> = {}): Promise<T> {
  const c = cap();
  if (!isNativeApp() || !c?.nativePromise) throw new NativeUnavailableError(`${plugin}.${method}`);
  if (!hasPlugin(plugin)) throw new NativeUnavailableError(`${plugin} is not in this build`);
  return (await c.nativePromise(plugin, method, options)) as T;
}

// Subscribes to a plugin event; returns the unsubscribe function. A throwing
// handler is re-raised outside the bridge so it shows up as an uncaught error
// instead of breaking event delivery.
export function listenNative<T>(plugin: string, event: string, cb: (data: T) => void): () => void {
  const c = cap();
  if (!isNativeApp() || !c?.addListener || !hasPlugin(plugin)) return () => undefined;
  const handle = c.addListener(plugin, event, (data, err) => {
    if (err) return;
    try {
      cb(data as T);
    } catch (e) {
      queueMicrotask(() => {
        throw e;
      });
    }
  });
  return () => {
    void handle.remove();
  };
}
