// Fixes from the pre-cutover review: legacy exchange failures that are "not now"
// keep the key and the legacy outbox; a stored session is read without the server;
// kick() finds a message a closed tab left; sign-out clears the notification tray.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/api/types';
import { isGenuineRefusal, legacyOutboxPlan } from '../../src/sync/legacy';
import { Outbox, type OutboxRecord } from '../../src/sync/outbox';
import { memoryOutboxStorage } from '../../src/sync/outbox-storage';
import { parseStoredSession } from '../../src/sync/session';

describe('legacy exchange: refused only when the server means it', () => {
  it.each([
    ['400 invalid refresh token', { status: 400, message: 'Invalid Refresh Token: Refresh Token Not Found' }, true],
    ['401', { status: 401 }, true],
    ['429 (reported as 503 by api/client)', { status: 503 }, false],
    ['429 as such', { status: 429 }, false],
    ['500', { status: 500 }, false],
    ['502', { status: 502 }, false],
    ['offline', { status: 0, message: 'Failed to fetch' }, false],
    ['AuthRetryableFetchError', { name: 'AuthRetryableFetchError', status: 400 }, false],
    ['timeout', { status: 408 }, false],
    ['no status', { message: 'something' }, false],
  ])('%s', (_label, error, refused) => {
    expect(isGenuineRefusal(error)).toBe(refused);
  });

  it('the legacy outbox is migrated for its owner, deleted only after a genuine refusal, kept otherwise', () => {
    const base = { exchanged: null, refused: null, refusedHere: false, pendingTokenUser: null };
    expect(legacyOutboxPlan('u1', { ...base, exchanged: 'u1' })).toBe('migrate');
    expect(legacyOutboxPlan('u1', { ...base, pendingTokenUser: 'u1' })).toBe('migrate');   // postponed exchange, same person signed in
    expect(legacyOutboxPlan('u1', { ...base, refused: 'u1', refusedHere: true })).toBe('migrate');
    expect(legacyOutboxPlan('u2', { ...base, refused: 'u1', refusedHere: true })).toBe('delete');
    expect(legacyOutboxPlan('u2', { ...base, pendingTokenUser: 'u1' })).toBe('keep');      // someone else, exchange postponed
    expect(legacyOutboxPlan('u2', base)).toBe('keep');
  });
});

describe('stored session', () => {
  it('reads the user from what auth-js stores, and nothing from junk', () => {
    expect(parseStoredSession(JSON.stringify({ access_token: 'x', refresh_token: 'y', user: { id: 'u1', email: 'a@b.c' } }))).toEqual({ user: { id: 'u1', email: 'a@b.c' } });
    expect(parseStoredSession(JSON.stringify({ currentSession: { user: { id: 'u2' } } }))).toEqual({ user: { id: 'u2', email: null } });
    expect(parseStoredSession('{"user":{}}')).toBeNull();
    expect(parseStoredSession('not json')).toBeNull();
    expect(parseStoredSession(null)).toBeNull();
  });
});

describe('outbox: kick() reads storage again', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a message a closed tab left after this tab loaded', async () => {
    const storage = memoryOutboxStorage();
    const sent: string[] = [];
    const outbox = new Outbox({
      storage,
      send: async (rec: OutboxRecord) => { sent.push(rec.clientId); return { id: rec.clientId } as unknown as Message; },
      onUpdate: () => undefined,
      onAccepted: () => undefined,
      tabId: 'me',
      isTabAlive: async (t) => t === 'me',
      now: () => Date.now(),
      random: () => 0,
    });
    await outbox.load();
    // another tab wrote this, then closed
    await storage.save({
      clientId: 'left-behind', orgId: 'o1', channelId: 'c1', threadRootId: null, body: 'x', attachmentIds: [], alsoInChannel: false,
      status: 'retrying', attempts: 1, createdAt: Date.now(), nextAttemptAt: 0, error: null, statusVisible: true, ownerTab: 'closed-tab',
    });
    outbox.kick();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual(['left-behind']);
    expect(storage.rows.size).toBe(0);
    outbox.kick();                                   // a second kick does not send it again
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toEqual(['left-behind']);
  });
});

describe('sign-out clears the notification tray', () => {
  it('closes every notification the worker shows', async () => {
    vi.resetModules();
    const close = vi.fn();
    vi.doMock('../../src/sw/register', () => ({
      getRegistration: async () => ({
        getNotifications: async () => [{ close }, { close }],
        pushManager: { getSubscription: async () => null },
      }),
      registerServiceWorker: async () => null,
    }));
    vi.doMock('../../src/native', () => ({ isNativeApp: () => false }));
    const { disablePush } = await import('../../src/push/push');
    await disablePush('u1', { unregister: true });
    expect(close).toHaveBeenCalledTimes(2);
    vi.doUnmock('../../src/sw/register');
    vi.doUnmock('../../src/native');
  });
});
