import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCapacitor, flush, type FakeCapacitor } from './fakeCapacitor';

const registerPushDevice = vi.fn();
const unregisterPushDevice = vi.fn();
vi.mock('../api/rpc', () => ({
  api: {
    registerPushDevice: (...a: unknown[]) => registerPushDevice(...a),
    unregisterPushDevice: (...a: unknown[]) => unregisterPushDevice(...a),
  },
}));

const push = await import('./push');
const {
  NOT_CONFIGURED, clearConversationNotifications, disableNativePush, enableNativePush, ensureNativePushOnLogin,
  installPushListeners, nativePushStatus, onNativePushReceived, __resetNativePushForTests,
} = push;

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANDROID_PLUGINS = ['PushNotifications', 'DekNative', 'App'];

let fake: FakeCapacitor | null = null;
let perm: string;
let offListeners: () => void = () => undefined;

function android(configured: boolean, extra: Record<string, (o: Record<string, unknown>) => unknown> = {}) {
  fake = installFakeCapacitor({
    platform: 'android',
    plugins: ANDROID_PLUGINS,
    handlers: {
      'DekNative.info': () => ({ pushConfigured: configured }),
      'PushNotifications.checkPermissions': () => ({ receive: perm }),
      'PushNotifications.requestPermissions': () => {
        perm = 'granted';
        return { receive: perm };
      },
      'PushNotifications.register': () => {
        setTimeout(() => fake?.emit('PushNotifications', 'registration', { value: 'fcm-token-1' }), 0);
      },
      ...extra,
    },
  });
  offListeners = installPushListeners(openUrl);
  return fake;
}

const openUrl = vi.fn();

beforeEach(() => {
  perm = 'prompt';
  localStorage.clear();
  registerPushDevice.mockReset();
  unregisterPushDevice.mockReset();
  openUrl.mockReset();
  registerPushDevice.mockImplementation(async (a: { endpoint: string }) => ({ id: `dev-${a.endpoint}`, kind: 'fcm' }));
  unregisterPushDevice.mockResolvedValue({ removed: 1 });
  __resetNativePushForTests();
});

afterEach(() => {
  offListeners();
  offListeners = () => undefined;
  fake?.uninstall();
  fake = null;
});

describe('native push on the web', () => {
  it('is a no-op that says so', async () => {
    expect(await enableNativePush(USER)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect((await nativePushStatus()).state).toBe('unsupported');
    await expect(disableNativePush(USER, { unregister: true })).resolves.toBeUndefined();
    expect(registerPushDevice).not.toHaveBeenCalled();
  });
});

describe('a build without Firebase (DEK19)', () => {
  it('reports "Push not configured on this build" and never calls register', async () => {
    const f = android(false);
    const res = await enableNativePush(USER);
    expect(res).toEqual({ ok: false, reason: 'unsupported', message: NOT_CONFIGURED });
    const status = await nativePushStatus();
    expect(status.state).toBe('not_configured');
    expect(status.message).toBe('Push not configured on this build');
    await disableNativePush(USER, { unregister: true });
    expect(f.called('PushNotifications', 'register')).toBe(0);
    expect(f.called('PushNotifications', 'unregister')).toBe(0);
  });
});

describe('enabling from notification settings', () => {
  it('asks permission, registers the FCM token as an fcm device and reports it', async () => {
    const f = android(true);
    const res = await enableNativePush(USER);
    expect(res).toMatchObject({ ok: true, device: { id: 'dev-fcm-token-1' } });
    expect(f.called('PushNotifications', 'requestPermissions')).toBe(1);
    expect(registerPushDevice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fcm', endpoint: 'fcm-token-1', platform: 'android' }));
    expect(registerPushDevice.mock.calls[0]![0].label).toMatch(/^Dek app on Android/);
    expect(await nativePushStatus()).toMatchObject({ state: 'registered', deviceId: 'dev-fcm-token-1', provider: 'fcm' });
  });

  it('stops at a denial and points to system settings', async () => {
    perm = 'denied';
    const f = android(true);
    const res = await enableNativePush(USER);
    expect(res).toMatchObject({ ok: false, reason: 'denied' });
    expect(f.called('PushNotifications', 'register')).toBe(0);
    expect((await nativePushStatus()).state).toBe('denied');
  });

  it('reports a registration error with its reason', async () => {
    perm = 'granted';
    android(true, {
      'PushNotifications.register': () => {
        setTimeout(() => fake?.emit('PushNotifications', 'registrationError', { error: 'SERVICE_NOT_AVAILABLE' }), 0);
      },
    });
    const res = await enableNativePush(USER);
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    expect((res as { message: string }).message).toContain('SERVICE_NOT_AVAILABLE');
    expect((await nativePushStatus()).state).toBe('error');
  });

  it('treats a missing APNs entitlement on iOS as not configured and registers apns otherwise', async () => {
    perm = 'granted';
    fake = installFakeCapacitor({
      platform: 'ios',
      plugins: ['PushNotifications', 'App'],
      handlers: {
        'PushNotifications.checkPermissions': () => ({ receive: perm }),
        'PushNotifications.register': () => {
          setTimeout(() => fake?.emit('PushNotifications', 'registrationError', { error: 'no valid "aps-environment" entitlement string found for application' }), 0);
        },
      },
    });
    offListeners = installPushListeners(openUrl);
    expect(await enableNativePush(USER)).toEqual({ ok: false, reason: 'unsupported', message: NOT_CONFIGURED });
    expect((await nativePushStatus()).state).toBe('not_configured');
  });
});

describe('sign-in, token refresh and sign-out', () => {
  it('registers silently at sign-in when already allowed, and never prompts', async () => {
    const f = android(true);
    await ensureNativePushOnLogin(USER);
    expect(f.called('PushNotifications', 'requestPermissions')).toBe(0);
    expect(registerPushDevice).not.toHaveBeenCalled();
    perm = 'granted';
    await ensureNativePushOnLogin(USER);
    expect(registerPushDevice).toHaveBeenCalledTimes(1);
  });

  it('re-registers on token refresh and retires the old endpoint', async () => {
    perm = 'granted';
    const f = android(true);
    await enableNativePush(USER);
    f.emit('PushNotifications', 'registration', { value: 'fcm-token-2' });
    await flush();
    await flush();
    expect(unregisterPushDevice).toHaveBeenCalledWith({ endpoint: 'fcm-token-1' });
    expect(registerPushDevice).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: 'fcm-token-2' }));
  });

  it('unregisters the device, deletes the token and clears notifications at sign-out', async () => {
    perm = 'granted';
    const f = android(true);
    await enableNativePush(USER);
    await disableNativePush(USER, { unregister: true });
    expect(unregisterPushDevice).toHaveBeenCalledWith({ endpoint: 'fcm-token-1' });
    expect(f.called('PushNotifications', 'removeAllDeliveredNotifications')).toBe(1);
    expect(f.called('PushNotifications', 'unregister')).toBe(1);
    expect(localStorage.getItem('dek.native.push')).toBeNull();
  });

  it('still deletes the local token when the server call fails', async () => {
    perm = 'granted';
    const f = android(true);
    await enableNativePush(USER);
    unregisterPushDevice.mockRejectedValue(new Error('network'));
    await disableNativePush(USER, { unregister: true });
    expect(f.called('PushNotifications', 'unregister')).toBe(1);
  });
});

describe('taps, foreground pushes and per-conversation clearing', () => {
  it('routes a notification tap through its url', () => {
    const f = android(true);
    f.emit('PushNotifications', 'pushNotificationActionPerformed', { actionId: 'tap', notification: { data: { url: '/o/x/c/y' } } });
    expect(openUrl).toHaveBeenCalledWith('/o/x/c/y');
  });

  it('hands a foreground push to listeners instead of the OS', () => {
    const f = android(true);
    const seen = vi.fn();
    const off = onNativePushReceived(seen);
    f.emit('PushNotifications', 'pushNotificationReceived', { title: 'Asha', body: 'hi', data: { tag: 'c:1' } });
    expect(seen).toHaveBeenCalledWith({ title: 'Asha', body: 'hi', data: { tag: 'c:1' } });
    off();
  });

  it('removes only the opened conversation from the notification shade', async () => {
    const f = android(true, {
      'PushNotifications.getDeliveredNotifications': () => ({
        notifications: [
          { id: '1', tag: 'c:chan-a' },
          { id: '2', tag: 'c:chan-b' },
          { id: '3', data: { tag: 't:root-a' } },
        ],
      }),
    });
    expect(await clearConversationNotifications('chan-a', 'root-a')).toBe(2);
    const removed = f.calls.find((c) => c.method === 'removeDeliveredNotifications');
    expect((removed?.options.notifications as { id: string }[]).map((n) => n.id)).toEqual(['1', '3']);
  });
});
