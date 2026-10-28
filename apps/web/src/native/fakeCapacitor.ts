// OWNER: native builder. Test helper only (imported by src/native/*.test.ts, never
// by app code): a stand-in for the `window.Capacitor` bridge the native shell
// injects, recording every call and letting a test emit plugin events.
import type { CapacitorGlobal } from './bridge';

type Handler = (options: Record<string, unknown>) => unknown;

export interface FakeCapacitor {
  calls: { plugin: string; method: string; options: Record<string, unknown> }[];
  emit(plugin: string, event: string, data: unknown): void;
  listenerCount(plugin: string, event: string): number;
  called(plugin: string, method: string): number;
  uninstall(): void;
}

export function installFakeCapacitor(opts: {
  platform: 'android' | 'ios';
  plugins: string[];
  handlers?: Record<string, Handler>;
}): FakeCapacitor {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const calls: FakeCapacitor['calls'] = [];
  const handlers = opts.handlers ?? {};
  const cap: CapacitorGlobal = {
    isNativePlatform: () => true,
    getPlatform: () => opts.platform,
    PluginHeaders: opts.plugins.map((name) => ({ name, methods: [] })),
    nativePromise: async (plugin, method, options) => {
      const o = (options ?? {}) as Record<string, unknown>;
      calls.push({ plugin, method, options: o });
      const h = handlers[`${plugin}.${method}`];
      return h ? h(o) : undefined;
    },
    addListener: (plugin, event, cb) => {
      const key = `${plugin}.${event}`;
      const set = listeners.get(key) ?? new Set();
      const fn = (data: unknown) => cb(data);
      set.add(fn);
      listeners.set(key, set);
      return { remove: () => { set.delete(fn); } };
    },
  };
  (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor = cap;
  return {
    calls,
    emit(plugin, event, data) {
      for (const fn of [...(listeners.get(`${plugin}.${event}`) ?? [])]) fn(data);
    },
    listenerCount: (plugin, event) => listeners.get(`${plugin}.${event}`)?.size ?? 0,
    called: (plugin, method) => calls.filter((c) => c.plugin === plugin && c.method === method).length,
    uninstall() {
      delete (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
    },
  };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
