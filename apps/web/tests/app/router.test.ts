import { describe, expect, test } from 'vitest';
import { href, parse, type Route } from '../../src/app/router';

const C = '01a0ae59-ff4c-72da-abf5-d55672599f7c';
const S = '019f993c-604d-7129-af26-e406dd9da295';
const M = '01a0e7cc-80f1-74af-9a46-7c4f35e3a49c';

describe('legacy fragment links (docs/migration/LEGACY-URLS.md)', () => {
  const cases: [string, Route][] = [
    [`/#/c/${C}`, { name: 'legacyChannel', channelId: C, messageId: null }],
    [`./#/d/${C}`, { name: 'legacyChannel', channelId: C, messageId: null }],
    [`/#/m/${C}/42`, { name: 'legacyMessage', channelId: C, legacySeq: 42 }],
    ['/#/join/Ab3_x-Yz9Q2w8E7r6T5y4U3i', { name: 'invite', code: 'Ab3_x-Yz9Q2w8E7r6T5y4U3i' }],
    ['/#/join-org/0123456789abcdef0123456789abcdef', { name: 'invite', code: '0123456789abcdef0123456789abcdef' }],
    ['/#/threads', { name: 'legacyView', view: 'threads' }],
    ['/#/search', { name: 'legacyView', view: 'search' }],
    ['/#/admin', { name: 'legacyAdmin', section: null }],
    ['/#/admin/requests', { name: 'legacyAdmin', section: 'requests' }],
    [`/#/s/${S}`, { name: 'legacyServer', serverId: S }],
    ['/#/leave', { name: 'home' }],
    [`/#/snippet/${M}`, { name: 'home' }],
    [`/#/u/${M}`, { name: 'home' }],
    ['/#access_token=abc&type=recovery', { name: 'home' }],
    ['/#error=x&error_description=y', { name: 'home' }],
    ['/?source=pwa', { name: 'home' }],
  ];
  test.each(cases)('%s', (link, want) => {
    expect(parse(link)).toEqual(want);
  });

  test('legacy routes round-trip through href', () => {
    for (const [, r] of cases) expect(parse(href(r))).toEqual(r);
  });

  test('rejects malformed pieces instead of guessing', () => {
    expect(parse('/#/m/not-a-uuid/4')).toEqual({ name: 'home' });
    expect(parse(`/#/m/${C}/4x`)).toEqual({ name: 'home' });
    expect(parse('/#/join/<script>')).toEqual({ name: 'home' });
    expect(parse('/#/admin/../../x')).toEqual({ name: 'legacyAdmin', section: null });
  });

  test('a malformed %-escape does not throw', () => {
    expect(() => parse('/o/%E0%A4%A/c')).not.toThrow();
    expect(() => parse('/#/join/%E0%A4%A')).not.toThrow();
  });
});

describe('current routes', () => {
  test('invite codes accept base62 and base64url', () => {
    expect(parse('/invite/aB3dE5gH7jK9mN1pQ3sT5v')).toEqual({ name: 'invite', code: 'aB3dE5gH7jK9mN1pQ3sT5v' });
    expect(parse('/invite/Ab3_x-Yz9Q2w8E7r6T5y4U3i')).toEqual({ name: 'invite', code: 'Ab3_x-Yz9Q2w8E7r6T5y4U3i' });
  });

  test('channel deep links round-trip', () => {
    const r: Route = { name: 'channel', orgId: S, channelId: C, messageId: null, threadId: M, threadMessageId: C };
    expect(parse(href(r))).toEqual(r);
  });

  test('sign-in next only allows same-app paths', () => {
    expect(parse('/signin?next=%2F%2Fevil.example')).toEqual({ name: 'signin', next: null });
    expect(parse('/signin?next=https%3A%2F%2Fevil.example')).toEqual({ name: 'signin', next: null });
    expect(parse(`/signin?next=%2Fo%2F${S}`)).toEqual({ name: 'signin', next: `/o/${S}` });
  });
});
