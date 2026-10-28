// OWNER: native builder. Session storage for the native shells (APP03).
//
// supabase-js keeps the session (access and refresh token) in the storage it is
// given. In the apps that is the Android Keystore (AES-GCM key that never leaves
// the device, ciphertext in private SharedPreferences) or the iOS Keychain
// (accessible after first unlock, this device only, never synced to iCloud),
// through @aparajita/capacitor-secure-storage. Never localStorage.
import type { SupportedStorage } from '@supabase/supabase-js';
import { callNative } from './bridge';

const PLUGIN = 'SecureStorage';
const KEY_PREFIX = 'dek_';
// KeychainSwiftAccessOptions.accessibleAfterFirstUnlockThisDeviceOnly
const IOS_ACCESS_AFTER_FIRST_UNLOCK_THIS_DEVICE = 3;

type Call = <T>(plugin: string, method: string, options?: Record<string, unknown>) => Promise<T>;

export interface SecureSessionStorage extends SupportedStorage {
  // Last storage failure, for the diagnostics in notification health.
  lastError(): string | null;
}

export function createSecureStorage(call: Call = callNative): SecureSessionStorage {
  // One web view per app process, so an in-memory copy is always current and
  // saves a bridge round trip on every auth read.
  const cache = new Map<string, string | null>();
  let lastError: string | null = null;
  const fail = (op: string, e: unknown) => {
    lastError = `${op}: ${e instanceof Error ? e.message : String(e)}`;
  };

  return {
    async getItem(key: string): Promise<string | null> {
      if (cache.has(key)) return cache.get(key) ?? null;
      try {
        const res = await call<{ data?: unknown }>(PLUGIN, 'internalGetItem', { prefixedKey: KEY_PREFIX + key, sync: false });
        const value = typeof res?.data === 'string' ? res.data : null;
        cache.set(key, value);
        return value;
      } catch (e) {
        // Unreadable (an OS restore without the Keystore key, a reset Keychain): no
        // session, the person signs in again. Never crash the app over it.
        fail('read', e);
        cache.set(key, null);
        return null;
      }
    },
    async setItem(key: string, value: string): Promise<void> {
      cache.set(key, value);
      try {
        await call(PLUGIN, 'internalSetItem', {
          prefixedKey: KEY_PREFIX + key,
          data: value,
          sync: false,
          access: IOS_ACCESS_AFTER_FIRST_UNLOCK_THIS_DEVICE,
        });
      } catch (e) {
        // The session still works for this run (memory); it will not survive a
        // restart. Recorded so notification health can show it.
        fail('write', e);
      }
    },
    async removeItem(key: string): Promise<void> {
      cache.set(key, null);
      try {
        await call(PLUGIN, 'internalRemoveItem', { prefixedKey: KEY_PREFIX + key, sync: false });
      } catch (e) {
        fail('remove', e);
      }
    },
    lastError: () => lastError,
  };
}
