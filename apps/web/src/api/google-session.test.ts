import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ options: null as unknown, active: null as unknown, beforeWrite: () => undefined }));
vi.mock('@supabase/supabase-js', () => ({ createClient: (_u: unknown, _k: unknown, o: unknown) => {
  m.options = o;
  return { auth: {
    getSession: async () => ({ data: { session: m.active }, error: null }),
    setSession: async (tokens: unknown) => {
      m.beforeWrite();
      await (o as { auth: { storage: Storage } }).auth.storage.setItem('dek.auth', JSON.stringify({ user: { id: 'google-user' }, tokens }));
      return { data: { session: { user: { id: 'google-user' } } }, error: null };
    },
  } };
} }));
beforeEach(() => { vi.resetModules(); localStorage.clear(); m.active = null; m.beforeWrite = () => undefined; });
const session = { user: { id: 'google-user' }, access_token: 'sample-a', refresh_token: 'sample-r' };
it('accepts an approved exchange into the normal persisted app session', async () => {
  const { acceptGoogleSession } = await import('./client');
  await acceptGoogleSession(session as never, () => true);
  expect(JSON.parse(localStorage.getItem('dek.auth')!).user.id).toBe('google-user');
});
it('rejects another active account before commit', async () => {
  m.active = { user: { id: 'different' } };
  const { acceptGoogleSession } = await import('./client');
  await expect(acceptGoogleSession(session as never, () => true)).rejects.toThrow('active account');
  expect(localStorage.getItem('dek.auth')).toBeNull();
});
it('rejects an account appearing in storage during the final SDK call', async () => {
  m.beforeWrite = () => { localStorage.setItem('dek.auth', JSON.stringify({ user: { id: 'other-tab' } })); };
  const { acceptGoogleSession } = await import('./client');
  await expect(acceptGoogleSession(session as never, () => true)).rejects.toThrow('active account');
  expect(JSON.parse(localStorage.getItem('dek.auth')!).user.id).toBe('other-tab');
});
it('rejects cancellation during the final SDK call', async () => {
  let valid = true; m.beforeWrite = () => { valid = false; };
  const { acceptGoogleSession } = await import('./client');
  await expect(acceptGoogleSession(session as never, () => valid)).rejects.toThrow('cancelled');
  expect(localStorage.getItem('dek.auth')).toBeNull();
});
