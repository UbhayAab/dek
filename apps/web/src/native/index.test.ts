import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCapacitor, flush, type FakeCapacitor } from './fakeCapacitor';

type AuthCb = (event: string, session: { user: { id: string } } | null) => void;
const authCallbacks: AuthCb[] = [];
const setAuthStorage = vi.fn();
const startAutoRefresh = vi.fn();
vi.mock('../api/client', () => ({
  setAuthStorage: (s: unknown) => setAuthStorage(s),
  supabase: () => ({
    auth: {
      onAuthStateChange: (cb: AuthCb) => {
        authCallbacks.push(cb);
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
      startAutoRefresh: () => startAutoRefresh(),
    },
  }),
}));
const registerPushDevice = vi.fn();
vi.mock('../api/rpc', () => ({
  api: {
    registerPushDevice: (...a: unknown[]) => registerPushDevice(...a),
    unregisterPushDevice: async () => ({ removed: 1 }),
  },
}));

const native = await import('./index');
const { __resetNativePushForTests } = await import('./push');
const { currentRoute, navigate } = await import('../app/router');

const ORG = '11111111-1111-4111-8111-111111111111';
const CH = '22222222-2222-4222-8222-222222222222';
const PLUGINS = ['App', 'Keyboard', 'PushNotifications', 'SecureStorage', 'DekNative', 'StatusBar'];

let fake: FakeCapacitor | null = null;

beforeEach(() => {
  native.__resetNativeForTests();
  __resetNativePushForTests();
  localStorage.clear();
  authCallbacks.length = 0;
  setAuthStorage.mockReset();
  startAutoRefresh.mockReset();
  registerPushDevice.mockReset();
  registerPushDevice.mockResolvedValue({ id: 'dev-1' });
  document.documentElement.className = '';
  navigate('/');
});

afterEach(() => {
  fake?.uninstall();
  fake = null;
});

describe('initNative on the web', () => {
  it('does nothing at all', () => {
    native.initNative();
    expect(setAuthStorage).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('dk-native')).toBe(false);
    expect(authCallbacks).toHaveLength(0);
    expect(native.isNativeApp()).toBe(false);
  });
});

describe('initNative in the Android shell', () => {
  function boot(launchUrl?: string, perm = 'granted') {
    fake = installFakeCapacitor({
      platform: 'android',
      plugins: PLUGINS,
      handlers: {
        'App.getLaunchUrl': () => (launchUrl ? { url: launchUrl } : undefined),
        'DekNative.info': () => ({ pushConfigured: true }),
        'PushNotifications.checkPermissions': () => ({ receive: perm }),
        'PushNotifications.register': () => {
          setTimeout(() => fake?.emit('PushNotifications', 'registration', { value: 'tok' }), 0);
        },
      },
    });
    native.initNative();
    return fake;
  }

  it('moves the session into secure storage before the client exists and marks the document', () => {
    boot();
    expect(setAuthStorage).toHaveBeenCalledOnce();
    const storage = setAuthStorage.mock.calls[0]![0] as { getItem: unknown; setItem: unknown; removeItem: unknown };
    expect(typeof storage.getItem).toBe('function');
    expect(typeof storage.setItem).toBe('function');
    expect(typeof storage.removeItem).toBe('function');
    expect(document.documentElement.classList.contains('dk-native')).toBe(true);
    expect(document.documentElement.classList.contains('dk-android')).toBe(true);
  });

  it('listens for links, back, keyboard and push, once', () => {
    const f = boot();
    native.initNative();
    for (const [p, e] of [
      ['App', 'appUrlOpen'], ['App', 'backButton'], ['App', 'appStateChange'], ['Keyboard', 'keyboardWillShow'],
      ['PushNotifications', 'registration'], ['PushNotifications', 'pushNotificationActionPerformed'],
    ] as const) {
      expect(f.listenerCount(p, e)).toBe(1);
    }
  });

  it('opens the launch link once even when Android also sends it as appUrlOpen', async () => {
    const f = boot(`https://dek-7o4.pages.dev/o/${ORG}/c/${CH}`);
    await flush();
    expect(currentRoute()).toMatchObject({ name: 'channel', channelId: CH });
    navigate('/');
    f.emit('App', 'appUrlOpen', { url: `https://dek-7o4.pages.dev/o/${ORG}/c/${CH}` });
    expect(currentRoute()).toEqual({ name: 'home' });
  });

  it('routes a dek:// link that arrives while running', () => {
    const f = boot();
    f.emit('App', 'appUrlOpen', { url: `dek://o/${ORG}` });
    expect(currentRoute()).toEqual({ name: 'org', orgId: ORG });
  });

  it('registers an already allowed phone after sign-in, once per account', async () => {
    boot();
    for (const cb of authCallbacks) cb('INITIAL_SESSION', { user: { id: 'u1' } });
    await flush();
    await flush();
    await flush();
    expect(registerPushDevice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fcm', endpoint: 'tok' }));
    for (const cb of authCallbacks) cb('SIGNED_IN', { user: { id: 'u1' } });
    await flush();
    await flush();
    expect(registerPushDevice).toHaveBeenCalledTimes(1);
  });

  it('retries a failed registration when the app comes back or the network returns', async () => {
    boot();
    registerPushDevice.mockRejectedValueOnce(new Error('offline'));
    for (const cb of authCallbacks) cb('INITIAL_SESSION', { user: { id: 'u1' } });
    for (let i = 0; i < 4; i += 1) await flush();
    expect(registerPushDevice).toHaveBeenCalledTimes(1);
    fake!.emit('App', 'appStateChange', { isActive: true });
    for (let i = 0; i < 6; i += 1) await flush();
    expect(registerPushDevice).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('online'));
    for (let i = 0; i < 6; i += 1) await flush();
    expect(registerPushDevice).toHaveBeenCalledTimes(2);
  });

  it('deletes the token when the session ends', async () => {
    const f = boot();
    for (const cb of authCallbacks) cb('SIGNED_OUT', null);
    await flush();
    await flush();
    expect(f.called('PushNotifications', 'removeAllDeliveredNotifications')).toBe(1);
    expect(f.called('PushNotifications', 'unregister')).toBe(1);
  });

  it('refreshes the session and tells the app when it comes back to the foreground', () => {
    const f = boot();
    const resumed = vi.fn();
    window.addEventListener('dek:resume', resumed);
    f.emit('App', 'appStateChange', { isActive: true });
    window.removeEventListener('dek:resume', resumed);
    expect(startAutoRefresh).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledOnce();
  });

  it('exposes the keyboard to CSS', () => {
    const f = boot();
    f.emit('Keyboard', 'keyboardWillShow', { keyboardHeight: 301.4 });
    expect(document.documentElement.dataset.keyboard).toBe('open');
    expect(document.documentElement.style.getPropertyValue('--kb-native')).toBe('301px');
    f.emit('Keyboard', 'keyboardWillHide', {});
    expect(document.documentElement.dataset.keyboard).toBeUndefined();
  });

  it('sets the status bar style for the in-app theme', async () => {
    const f = boot();
    await native.setNativeBarStyle('dark');
    expect(f.calls.find((c) => c.method === 'setStyle')?.options).toEqual({ style: 'DARK' });
  });
});
