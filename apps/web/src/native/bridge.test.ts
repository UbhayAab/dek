import { afterEach, describe, expect, it } from 'vitest';
import { callNative, hasPlugin, isNativeApp, listenNative, NativeUnavailableError, nativePlatform } from './bridge';
import { installFakeCapacitor, type FakeCapacitor } from './fakeCapacitor';
import { createSecureStorage } from './secureStorage';

let fake: FakeCapacitor | null = null;
afterEach(() => {
  fake?.uninstall();
  fake = null;
});

describe('bridge on the web', () => {
  it('reports the web and refuses native calls when no shell injected Capacitor', async () => {
    expect(isNativeApp()).toBe(false);
    expect(nativePlatform()).toBe('web');
    expect(hasPlugin('App')).toBe(false);
    await expect(callNative('App', 'exitApp')).rejects.toBeInstanceOf(NativeUnavailableError);
    const off = listenNative('App', 'backButton', () => undefined);
    expect(() => off()).not.toThrow();
  });

  it('treats a Capacitor global that says it is not native as the web', () => {
    (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => false, nativePromise: async () => undefined };
    expect(isNativeApp()).toBe(false);
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });
});

describe('bridge in the native shell', () => {
  it('detects the platform and the plugins announced by the shell', () => {
    fake = installFakeCapacitor({ platform: 'android', plugins: ['App', 'PushNotifications'] });
    expect(isNativeApp()).toBe(true);
    expect(nativePlatform()).toBe('android');
    expect(hasPlugin('PushNotifications')).toBe(true);
    expect(hasPlugin('DekNative')).toBe(false);
  });

  it('calls a plugin method and refuses one the build does not contain', async () => {
    fake = installFakeCapacitor({ platform: 'ios', plugins: ['App'], handlers: { 'App.getLaunchUrl': () => ({ url: 'dek://o/x' }) } });
    await expect(callNative('App', 'getLaunchUrl')).resolves.toEqual({ url: 'dek://o/x' });
    await expect(callNative('DekNative', 'info')).rejects.toBeInstanceOf(NativeUnavailableError);
  });

  it('subscribes, delivers events and unsubscribes', () => {
    fake = installFakeCapacitor({ platform: 'android', plugins: ['App'] });
    const seen: unknown[] = [];
    const off = listenNative('App', 'backButton', (d) => seen.push(d));
    fake.emit('App', 'backButton', { canGoBack: true });
    expect(seen).toEqual([{ canGoBack: true }]);
    off();
    fake.emit('App', 'backButton', { canGoBack: false });
    expect(seen).toHaveLength(1);
  });
});

describe('secure session storage', () => {
  it('reads, writes and removes through the Keystore/Keychain plugin with a prefixed key', async () => {
    const store = new Map<string, string>();
    fake = installFakeCapacitor({
      platform: 'android',
      plugins: ['SecureStorage'],
      handlers: {
        'SecureStorage.internalGetItem': (o) => ({ data: store.get(String(o.prefixedKey)) ?? null }),
        'SecureStorage.internalSetItem': (o) => { store.set(String(o.prefixedKey), String(o.data)); },
        'SecureStorage.internalRemoveItem': (o) => ({ success: store.delete(String(o.prefixedKey)) }),
      },
    });
    const s = createSecureStorage();
    expect(await s.getItem('dek.auth')).toBeNull();
    await s.setItem('dek.auth', '{"access_token":"a"}');
    expect(store.get('dek_dek.auth')).toBe('{"access_token":"a"}');
    const write = fake.calls.find((c) => c.method === 'internalSetItem');
    expect(write?.options).toMatchObject({ sync: false, access: 3 });
    expect(await s.getItem('dek.auth')).toBe('{"access_token":"a"}');
    await s.removeItem('dek.auth');
    expect(store.has('dek_dek.auth')).toBe(false);
    expect(await s.getItem('dek.auth')).toBeNull();
  });

  it('caches reads so the bridge is asked once per key', async () => {
    fake = installFakeCapacitor({
      platform: 'ios',
      plugins: ['SecureStorage'],
      handlers: { 'SecureStorage.internalGetItem': () => ({ data: 'v' }) },
    });
    const s = createSecureStorage();
    await s.getItem('k');
    await s.getItem('k');
    expect(fake.called('SecureStorage', 'internalGetItem')).toBe(1);
  });

  it('turns an unreadable entry into "no session" and never throws on write', async () => {
    fake = installFakeCapacitor({
      platform: 'android',
      plugins: ['SecureStorage'],
      handlers: {
        'SecureStorage.internalGetItem': () => { throw new Error('invalidData'); },
        'SecureStorage.internalSetItem': () => { throw new Error('osError'); },
      },
    });
    const s = createSecureStorage();
    await expect(s.getItem('dek.auth')).resolves.toBeNull();
    expect(s.lastError()).toContain('invalidData');
    await expect(s.setItem('dek.auth', 'x')).resolves.toBeUndefined();
    expect(s.lastError()).toContain('osError');
    expect(await s.getItem('dek.auth')).toBe('x');
  });
});
