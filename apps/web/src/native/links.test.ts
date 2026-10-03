import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACK_EVENT, handleBack, isRootRoute, parentRoute } from './back';
import { installFakeCapacitor, type FakeCapacitor } from './fakeCapacitor';
import { inAppPath, openInApp } from './links';
import { currentRoute, navigate, parse } from '../app/router';

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
    expect(handleBack(true)).toBe('handled');
    window.removeEventListener(BACK_EVENT, close);
    expect(currentRoute()).toMatchObject({ name: 'channel', channelId: CH });
  });

  it('exits the app at a root screen', async () => {
    fake = installFakeCapacitor({ platform: 'android', plugins: ['App'] });
    navigate(`/o/${ORG}`);
    expect(handleBack(true)).toBe('exit');
    await Promise.resolve();
    expect(fake.called('App', 'exitApp')).toBe(1);
  });

  it('goes back through in-app history when there is some', () => {
    navigate(`/o/${ORG}/c/${CH}`);
    const spy = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    expect(handleBack(true)).toBe('history');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('goes to the parent screen after a deep link with no history', () => {
    navigate(`/o/${ORG}/c/${CH}/t/${TH}`);
    expect(handleBack(false)).toBe('parent');
    expect(currentRoute()).toMatchObject({ name: 'channel', channelId: CH, threadId: null });
    expect(handleBack(false)).toBe('parent');
    expect(currentRoute()).toEqual({ name: 'org', orgId: ORG });
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
