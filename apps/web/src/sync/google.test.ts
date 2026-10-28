import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  active: vi.fn(), accept: vi.fn(), authorize: vi.fn(), exchange: vi.fn(),
  native: false, plugins: ['Browser', 'SecureStorage'], call: vi.fn(), listen: vi.fn(),
  options: null as unknown, authStorage: null as Storage | null,
}));
vi.mock('../api/client', () => ({
  supabase: () => ({ auth: { getSession: m.active } }),
  acceptGoogleSession: (...args: unknown[]) => m.accept(...args),
  googleStorage: () => m.authStorage ?? sessionStorage,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: (_u: unknown, _k: unknown, options: unknown) => {
  m.options = options;
  return { auth: { signInWithOAuth: m.authorize, exchangeCodeForSession: m.exchange } };
} }));
vi.mock('../native/bridge', () => ({
  isNativeApp: () => m.native, hasPlugin: (p: string) => m.plugins.includes(p),
  callNative: (...args: unknown[]) => m.call(...args), listenNative: (...args: unknown[]) => m.listen(...args),
}));
let g: typeof import('./google');
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); sessionStorage.clear(); m.authStorage = null;
  m.native = true; m.plugins = ['Browser', 'SecureStorage'];
  m.active.mockResolvedValue({ data: { session: null }, error: null });
  m.accept.mockResolvedValue(undefined);
  m.authorize.mockImplementation(async ({ options }: { options: { redirectTo: string } }) => {
    const callback = new URL(options.redirectTo);
    callback.searchParams.set('sb_flow_id', '11111111111141118111111111111111');
    return { data: { url: 'https://nxljuctnauhgzekvmftp.supabase.co/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(callback.href) }, error: null };
  });
  m.exchange.mockResolvedValue({ data: { session: { user: { id: 'approved' }, access_token: 'sample-a', refresh_token: 'sample-r' } }, error: null });
  m.call.mockResolvedValue(undefined); m.listen.mockReturnValue(() => undefined);
  history.replaceState(null, '', '/signin');
  g = await import('./google');
});
async function callback(extra = 'code=synthetic-code&sb_flow_id=11111111111141118111111111111111') {
  await g.startGoogle();
  const intent = JSON.parse(sessionStorage.getItem('dek.google.intent')!);
  return `dek://auth/google?intent=${intent.nonce}&${extra}`;
}
describe('Google identity sign-in', () => {
  it('uses PKCE, minimal scopes, account chooser and the native system browser', async () => {
    await g.startGoogle();
    expect(m.authorize).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google', options: expect.objectContaining({ scopes: 'openid email profile', skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } }) }));
    expect(m.call).toHaveBeenCalledWith('Browser', 'open', expect.objectContaining({ url: expect.stringContaining('/auth/v1/authorize') }));
    expect(m.options).toMatchObject({ auth: { flowType: 'pkce', detectSessionInUrl: false, autoRefreshToken: false } });
  });
  it('exchanges duplicate cold/warm callbacks once, retains the safe invite and consumes intent', async () => {
    history.replaceState(null, '', '/invite/abcdefgh');
    const url = await callback();
    expect(g.handleGoogleCallback(url)).toBe(true);
    expect(g.handleGoogleCallback(url)).toBe(true);
    await g.googleCallbackSettled();
    expect(m.exchange).toHaveBeenCalledExactlyOnceWith('synthetic-code', { flowId: '11111111111141118111111111111111' });
    expect(m.accept).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('dek.google.intent')).toBeNull();
    expect(location.pathname).toBe('/invite/abcdefgh');
    expect(g.googleSnapshot()).toEqual({ busy: false, message: null });
    g.handleGoogleCallback(url); await g.googleCallbackSettled();
    expect(m.exchange).toHaveBeenCalledOnce();
  });
  it('persists verifier entries but never provider/session tokens from the exchange client', async () => {
    await g.startGoogle();
    const storage = (m.options as { auth: { storage: Storage } }).auth.storage;
    storage.setItem('dek.google.pkce-code-verifier', 'synthetic-verifier');
    storage.setItem('dek.google.pkce', 'synthetic-token');
    expect(sessionStorage.getItem('dek.google.pkce-code-verifier')).toBe('synthetic-verifier');
    expect(sessionStorage.getItem('dek.google.pkce')).toBeNull();
  });
  it.each(['https://evil.example/auth/google', 'dek://evil/google', 'dek://auth/google/extra', 'dek://user@auth/google'])('ignores foreign or malformed callback %s', async (url) => {
    expect(g.handleGoogleCallback(url)).toBe(false); expect(m.exchange).not.toHaveBeenCalled();
  });
  it('scrubs browser callback query/hash before any asynchronous storage read', async () => {
    m.native = false;
    history.replaceState(null, '', '/auth/google?code=synthetic-secret#error_description=private');
    expect(g.handleGoogleCallback(location.href)).toBe(true);
    expect(location.pathname + location.search + location.hash).toBe('/signin');
    await g.googleCallbackSettled(); expect(m.exchange).not.toHaveBeenCalled();
  });
  it.each(['error=access_denied', 'error=provider_failure', '', 'code=a&code=b', 'access_token=unused', 'code=x#access_token=unused'])('rejects denied or invalid callback %s without accepting tokens', async (extra) => {
    const url = await callback(extra); g.handleGoogleCallback(url); await g.googleCallbackSettled();
    expect(m.exchange).not.toHaveBeenCalled(); expect(m.accept).not.toHaveBeenCalled();
    expect(g.googleSnapshot().message).toBeTruthy();
  });
  it.each(['expired', 'future', 'mismatch', 'missing'])('rejects a %s intent', async (mode) => {
    const url = await callback();
    const intent = JSON.parse(sessionStorage.getItem('dek.google.intent')!);
    if (mode === 'expired') intent.at -= 11 * 60_000;
    if (mode === 'future') intent.at += 60_000;
    if (mode === 'mismatch') intent.nonce = crypto.randomUUID();
    sessionStorage.setItem('dek.google.intent', JSON.stringify(intent));
    if (mode === 'missing') sessionStorage.removeItem('dek.google.intent');
    g.handleGoogleCallback(url); await g.googleCallbackSettled(); expect(m.exchange).not.toHaveBeenCalled();
  });
  it('preserves an account that signed in while Google was open', async () => {
    const url = await callback(); m.active.mockResolvedValue({ data: { session: { user: { id: 'different' } } }, error: null });
    g.handleGoogleCallback(url); await g.googleCallbackSettled();
    expect(m.exchange).not.toHaveBeenCalled(); expect(m.accept).not.toHaveBeenCalled();
  });
  it('rejects a flow ID belonging to another pending exchange', async () => {
    const url = await callback('code=synthetic-code&sb_flow_id=22222222222242228222222222222222');
    g.handleGoogleCallback(url); await g.googleCallbackSettled();
    expect(m.exchange).not.toHaveBeenCalled();
  });
  it('does not accept a session after cancellation during exchange', async () => {
    const url = await callback();
    let release!: (v: unknown) => void;
    m.exchange.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    g.handleGoogleCallback(url);
    await vi.waitFor(() => expect(m.exchange).toHaveBeenCalledOnce());
    await g.cancelGoogle();
    release({ data: { session: { user: { id: 'approved' } } }, error: null });
    await g.googleCallbackSettled(); expect(m.accept).not.toHaveBeenCalled();
  });
  it('shows recovery after an offline/missing-verifier exchange and never retries the code', async () => {
    const url = await callback(); m.exchange.mockRejectedValue(new Error('private provider description'));
    g.handleGoogleCallback(url); await g.googleCallbackSettled();
    expect(g.googleSnapshot().message).toContain('password or email code');
    expect(g.googleSnapshot().message).not.toContain('private provider');
    g.handleGoogleCallback(url); await g.googleCallbackSettled(); expect(m.exchange).toHaveBeenCalledOnce();
  });
  it('does not navigate to an untrusted authorize URL', async () => {
    m.authorize.mockResolvedValue({ data: { url: 'https://evil.example/' }, error: null });
    await g.startGoogle(); expect(m.call).not.toHaveBeenCalled(); expect(g.googleSnapshot().message).toBeTruthy();
  });
  it('old installed builds keep an explicit password/code fallback', async () => {
    m.plugins = ['SecureStorage']; await g.startGoogle();
    expect(m.authorize).not.toHaveBeenCalled(); expect(g.googleSnapshot().message).toContain('updated Dek app');
  });
  it('deduplicates rapid starts', async () => {
    await Promise.all([g.startGoogle(), g.startGoogle()]); expect(m.authorize).toHaveBeenCalledOnce();
  });
  it('explicit sign-out invalidates the pending Google tab without a stale notice', async () => {
    const url = await callback(); await g.resetGoogle();
    expect(g.googleSnapshot()).toEqual({ busy: false, message: null });
    g.handleGoogleCallback(url); await g.googleCallbackSettled();
    expect(m.exchange).not.toHaveBeenCalled();
  });
  it.each(['//evil.example', '/\\evil.example', '/%2f%2fevil.example', '/%5cevil.example', '/auth/google', '/signin?next=/', '/x/../auth/google', '/%0aevil', 'https://evil.example', '/bad%ZZ'])('rejects unsafe return %s', (path) => {
    expect(g.googleNext(path)).toBe('/');
  });
  it('preserves valid app destinations', () => {
    expect(g.googleNext('/settings/account')).toBe('/settings/account');
    expect(g.googleNext('/invite/abcdefgh')).toBe('/invite/abcdefgh');
  });
});
