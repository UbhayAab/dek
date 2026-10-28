// In the Android and iOS apps (isNativeApp): web push hands over to the native
// layer with the same arguments, the service worker is not registered, and opening
// a conversation or thread clears its notifications from the tray.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  isNativeApp: vi.fn(() => true),
  enableNativePush: vi.fn(async () => ({ ok: false as const, reason: 'denied' as const, message: 'denied' })),
  ensureNativePushOnLogin: vi.fn(async () => undefined),
  disableNativePush: vi.fn(async () => undefined),
  clearConversationNotifications: vi.fn(async () => 0),
  nativePushStatus: vi.fn(),
  onNativePushReceived: vi.fn(() => () => undefined),
  openNativeNotificationSettings: vi.fn(),
}));
vi.mock('../../src/native', () => native);

vi.mock('../../src/api/rpc', () => ({
  api: { unregisterPushDevice: vi.fn(), registerPushDevice: vi.fn(), listMessages: vi.fn(() => new Promise(() => undefined)) },
}));

import { api } from '../../src/api/rpc';
import { disablePush, enablePush, ensurePushOnLogin } from '../../src/push/push';
import { registerServiceWorker } from '../../src/sw/register';
import { clearNotificationsFor, closeChannel, openChannel } from '../../src/sync/channels';
import { resetState, setState } from '../../src/store/state';

beforeEach(() => {
  for (const f of Object.values(native)) f.mockClear();
  native.isNativeApp.mockReturnValue(true);
  resetState();
  setState({ session: { status: 'signed_in', userId: 'u1', email: null, setup: null }, orgId: 'o1' });
});

describe('push in the apps', () => {
  it('enable, ensure and disable go to the native layer with the same arguments', async () => {
    const r = await enablePush('u1');
    expect(native.enableNativePush).toHaveBeenCalledWith('u1');
    expect(r).toEqual({ ok: false, reason: 'denied', message: 'denied' });
    await ensurePushOnLogin('u1');
    expect(native.ensureNativePushOnLogin).toHaveBeenCalledWith('u1');
    await disablePush('u1', { unregister: true });
    expect(native.disableNativePush).toHaveBeenCalledWith('u1', { unregister: true });
    expect((api.unregisterPushDevice as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();   // the web path is not used
  });

  it('no service worker in the apps (a production build that would otherwise register)', async () => {
    vi.stubEnv('DEV', false);
    const register = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { value: { register, getRegistration: vi.fn(), addEventListener: vi.fn() }, configurable: true });
    try {
      expect(await registerServiceWorker()).toBeNull();
      expect(register).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('opening a conversation clears its notifications', () => {
  it('a channel: c:<channel>; a thread: t:<root>', async () => {
    void openChannel('c1');
    expect(native.clearConversationNotifications).toHaveBeenCalledWith('c1', null);
    closeChannel('c1');
    clearNotificationsFor('c1', 'root9');
    expect(native.clearConversationNotifications).toHaveBeenLastCalledWith('c1', 'root9');
  });

  it('in a browser the native helper is not called', () => {
    native.isNativeApp.mockReturnValue(false);
    clearNotificationsFor('c1');
    expect(native.clearConversationNotifications).not.toHaveBeenCalled();
  });
});
