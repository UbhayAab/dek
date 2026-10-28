// Startup order: the auth listener never waits for the old app's cleanup (deleting
// its databases can hang for seconds), and that cleanup runs once per device.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let finishCleanup: () => void = () => undefined;

vi.mock('../../src/sync/legacy', () => ({
  exchangeLegacySession: vi.fn(async () => { calls.push('exchange'); return 'none'; }),
  cleanupLegacy: vi.fn(() => { calls.push('cleanup'); return new Promise<string[]>((r) => { finishCleanup = () => r([]); }); }),
}));
vi.mock('../../src/sync/session', () => ({
  listenToAuth: vi.fn(() => { calls.push('listen'); }),
  resumeStart: vi.fn(),
  signOut: vi.fn(),
}));

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => vi.clearAllMocks());

async function start(): Promise<void> {
  const { startApp } = await import('../../src/sync/index');
  startApp();
}

describe('startApp', () => {
  it('listens for auth right after the legacy exchange, before the cleanup finishes', async () => {
    await start();
    await vi.waitFor(() => expect(calls).toEqual(['exchange', 'listen', 'cleanup']));
    expect(localStorage.getItem('dek.legacy.cleaned')).toBeNull();   // the cleanup is still running
    finishCleanup();
    await vi.waitFor(() => expect(localStorage.getItem('dek.legacy.cleaned')).toBe('1'));
  });

  it('does not clean up again on a device that already did', async () => {
    localStorage.setItem('dek.legacy.cleaned', '1');
    await start();
    await vi.waitFor(() => expect(calls).toEqual(['exchange', 'listen']));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(['exchange', 'listen']);
  });
});
