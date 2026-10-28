import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACK_EVENT, handleBack, installBackButton, isRootRoute, parentRoute } from './back';
import { installFakeCapacitor, type FakeCapacitor } from './fakeCapacitor';
import { inAppPath, openInApp } from './links';
import { currentRoute, navigate, navigateDeeper, parse } from '../app/router';

const ORG = '11111111-1111-4111-8111-111111111111';
const CH = '22222222-2222-4222-8222-222222222222';
const TH = '33333333-3333-4333-8333-333333333333';
const MSG = '44444444-4444-4444-8444-444444444444';

describe('deep links into the app', () => {
  it('accepts App Links on the Dek site', () => {
    expect(inAppPath(`https://dek-7o4.pages.dev/o/${ORG}/c/${CH}/m/${MSG}`)).toBe(`/o/${ORG}/c/${CH}/m/${MSG}`);
    expect(inAppPath('https://dek-7o4.pages.dev/invite/AbCdEfGh1234')).toBe('/invite/AbCdEfGh1234');
  });

  it('accepts the dek:// fallback scheme with or without an empty host', () => {
    expect(inAppPath(`dek://o/${ORG}/c/${CH}/t/${TH}`)).toBe(`/o/${ORG}/c/${CH}/t/${TH}`);
    expect(inAppPath(`dek:///o/${ORG}`)).toBe(`/o/${ORG}`);
  });

  it('accepts the relative url a push carries', () => {
    expect(inAppPath(`/o/${ORG}/c/${CH}/t/${TH}/m/${MSG}`)).toBe(`/o/${ORG}/c/${CH}/t/${TH}/m/${MSG}`);
  });

  it('refuses other hosts, plain http, protocol-relative, script urls and unknown routes', () => {
    expect(inAppPath(`https://evil.example/o/${ORG}`)).toBeNull();
    expect(inAppPath(`http://dek-7o4.pages.dev/o/${ORG}`)).toBeNull();
    expect(inAppPath(`//evil.example/o/${ORG}`)).toBeNull();
    expect(inAppPath(`/\evil.example/o/${ORG}`)).toBeNull();
    expect(inAppPath('javascript:alert(1)')).toBeNull();
    expect(inAppPath('/o/not-a-uuid')).toBeNull();
    expect(inAppPath('/definitely/unknown')).toBeNull();
    expect(inAppPath(undefined)).toBeNull();
    expect(inAppPath(42)).toBeNull();
    expect(inAppPath(`/o/${ORG}/${'x'.repeat(3000)}`)).toBeNull();
  });

  it('keeps a hostile sign-in destination out', () => {
    const path = inAppPath('dek://signin?next=//evil.example');
    expect(path).toBe('/signin?next=//evil.example');
    expect(parse(path!)).toEqual({ name: 'signin', next: null });
  });

  it('navigates the router for a valid link and ignores an invalid one', () => {
    navigate('/');
    expect(openInApp(`dek://o/${ORG}/c/${CH}`)).toBe(true);
    expect(currentRoute()).toMatchObject({ name: 'channel', orgId: ORG, channelId: CH });
    expect(openInApp('https://evil.example/x')).toBe(false);
    expect(currentRoute()).toMatchObject({ name: 'channel', channelId: CH });
  });
});

describe('Android back button', () => {
  let fake: FakeCapacitor | null = null;
  afterEach(() => {
    fake?.uninstall();
    fake = null;
  });

  it('lets an open sheet or dialog consume back first', () => {
    navigate(`/o/${ORG}/c/${CH}`);
    const close = (e: Event) => e.preventDefault();
    window.addEventListener(BACK_EVENT, close);
    expect(handleBack()).toBe('handled');
    window.removeEventListener(BACK_EVENT, close);
    expect(currentRoute()).toMatchObject({ name: 'channel', channelId: CH });
  });

  it('closes the topmost open dialog the way Escape does, and stays on the screen', () => {
    navigate(`/o/${ORG}/c/${CH}`);
    const viewer = document.createElement('dialog');
    viewer.setAttribute('open', '');
    let cancelled = 0;
    viewer.addEventListener('cancel', (e) => {
      e.preventDefault();
      cancelled += 1;
      viewer.removeAttribute('open');
    });
    document.body.appendChild(viewer);
    expect(handleBack()).toBe('dialog');
    expect(cancelled).toBe(1);
    expect(currentRoute()).toMatchObject({ name: 'channel', channelId: CH });
    viewer.remove();
  });

  it('exits the app at a root screen', async () => {
    fake = installFakeCapacitor({ platform: 'android', plugins: ['App'] });
    navigate(`/o/${ORG}`);
    expect(handleBack()).toBe('exit');
    await Promise.resolve();
    expect(fake.called('App', 'exitApp')).toBe(1);
  });

  it('walks in-app history when the app went deeper', () => {
    navigate(`/o/${ORG}`);
    navigateDeeper(`/o/${ORG}/c/${CH}`);
    const spy = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    expect(handleBack()).toBe('back');
    expect(spy).toHaveBeenCalledOnce();
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  it('goes to the parent screen after a deep link with no in-app history', () => {
    navigate(`/o/${ORG}/c/${CH}/t/${TH}`);
    const spy = vi.spyOn(window.history, 'back');
    expect(handleBack()).toBe('back');
    expect(currentRoute()).toMatchObject({ name: 'channel', channelId: CH, threadId: null });
    expect(handleBack()).toBe('back');
    expect(currentRoute()).toEqual({ name: 'org', orgId: ORG });
    expect(spy).not.toHaveBeenCalled();
  });

  it('reacts to the plugin event whatever canGoBack says', () => {
    fake = installFakeCapacitor({ platform: 'android', plugins: ['App'] });
    const off = installBackButton();
    navigate(`/o/${ORG}/c/${CH}`);
    fake.emit('App', 'backButton', { canGoBack: false });
    expect(currentRoute()).toEqual({ name: 'org', orgId: ORG });
    off();
  });

  it('knows the roots and parents of every screen kind', () => {
    expect(isRootRoute({ name: 'home' })).toBe(true);
    expect(isRootRoute({ name: 'signin', next: null })).toBe(true);
    expect(isRootRoute({ name: 'view', orgId: ORG, view: 'unread' })).toBe(false);
    expect(parentRoute({ name: 'search', orgId: ORG, q: 'x' })).toEqual({ name: 'org', orgId: ORG });
    expect(parentRoute({ name: 'channelSettings', orgId: ORG, channelId: CH })).toMatchObject({ name: 'channel', channelId: CH });
    expect(parentRoute({ name: 'settings', section: 'notifications' })).toEqual({ name: 'home' });
  });
});
