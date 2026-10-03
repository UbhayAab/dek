// Small platform pieces: brand contrast (DEK01), backoff, the legacy session and
// key cleanup, platform detection for push and install copy, the VAPID guard, the
// test notification verdict, the keyboard inset, org selection.
import { describe, expect, it } from 'vitest';
import { backoffDelay, REJOIN_BACKOFF, SEND_BACKOFF } from '../../src/lib/backoff';
import { brandVars, contrastRatio, foregroundFor, normalizeHex, ON_DARK, ON_LIGHT } from '../../src/lib/color';
import { LruSet } from '../../src/lib/lru';
import { isUserKey } from '../../src/lib/storage';
import { detect, deviceLabel, platformCode, type EnvSnapshot } from '../../src/lib/platform';
import { keyboardInset } from '../../src/lib/viewport';
import { keysMatch, urlBase64ToUint8Array } from '../../src/push/push';
import { convertLegacyRows, legacyKeysToRemove, parseLegacySession } from '../../src/sync/legacy';
import { pickOrg } from '../../src/sync/org';
import { testVerdict } from '../../src/features/notifications/verdict';
import type { OrgSummary } from '../../src/api/types';

describe('brand colors', () => {
  it('validates hex and refuses anything else', () => {
    expect(normalizeHex('#0F766E')).toBe('#0f766e');
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#0F766E; background:url(x)')).toBeNull();
    expect(brandVars('nonsense').org).toBe('#4f46e5');
  });

  it('picks white or near-black, whichever reads better', () => {
    expect(foregroundFor('#0F766E')).toBe(ON_DARK);    // Dek QA teal
    expect(foregroundFor('#7C3AED')).toBe(ON_DARK);    // QA Other violet
    expect(foregroundFor('#FACC15')).toBe(ON_LIGHT);   // yellow
    expect(foregroundFor('#FFFFFF')).toBe(ON_LIGHT);
    for (const c of ['#0F766E', '#7C3AED', '#FACC15', '#4F46E5', '#22C55E', '#E11D48']) {
      expect(contrastRatio(c, foregroundFor(c))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('backoff', () => {
  it('doubles from the base to the cap and adds bounded jitter', () => {
    const zero = { ...SEND_BACKOFF, random: () => 0 };
    expect([1, 2, 3, 7, 8, 50].map((n) => backoffDelay(n, zero))).toEqual([2_000, 4_000, 8_000, 120_000, 120_000, 120_000]);
    expect(backoffDelay(1, { ...SEND_BACKOFF, random: () => 1 })).toBe(3_000);
    expect(backoffDelay(9, { ...SEND_BACKOFF, random: () => 1 })).toBe(150_000);
    expect(backoffDelay(1, { ...REJOIN_BACKOFF, random: () => 0 })).toBe(1_000);
    expect(backoffDelay(10, { ...REJOIN_BACKOFF, random: () => 0 })).toBe(30_000);
  });
});

describe('sign-out key wipe', () => {
  it('matches every dek.* key carrying the user id as a segment, and nothing else', () => {
    const uid = '0a0a0a0a-0000-4000-8000-000000000001';
    expect(isUserKey(`dek.drafts.${uid}`, uid)).toBe(true);
    expect(isUserKey(`dek.lastChannel.${uid}.org-1`, uid)).toBe(true);
    expect(isUserKey(`dek.push.device.${uid}`, uid)).toBe(true);
    expect(isUserKey('dek.auth', uid)).toBe(false);
    expect(isUserKey(`dek.drafts.${uid}x`, uid)).toBe(false);
    expect(isUserKey(`other.${uid}`, uid)).toBe(false);
  });
});

describe('LRU set', () => {
  it('remembers the newest ids only', () => {
    const s = new LruSet(2);
    expect(s.add('a')).toBe(true);
    expect(s.add('b')).toBe(true);
    expect(s.add('a')).toBe(false);   // refreshes a
    expect(s.add('c')).toBe(true);    // evicts b
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
  });
});

describe('legacy move', () => {
  it('reads the refresh token from the v2 and v1 session formats', () => {
    expect(parseLegacySession(JSON.stringify({ access_token: 'x', refresh_token: 'rt-12345678', user: { id: 'u1' } }))).toEqual({ refreshToken: 'rt-12345678', userId: 'u1' });
    expect(parseLegacySession(JSON.stringify({ currentSession: { refresh_token: 'rt-abcdefgh', user: { id: 'u2' } } }))).toEqual({ refreshToken: 'rt-abcdefgh', userId: 'u2' });
    expect(parseLegacySession('{"refresh_token":""}')).toBeNull();
    expect(parseLegacySession('not json')).toBeNull();
    expect(parseLegacySession(null)).toBeNull();
  });

  it('removes the old app\'s keys and never a dek.* key', () => {
    const keys = [
      'sb-ybddogqphinruyunnuwx-auth-token', 'dak.lastChannel', 'dak.cat.servers', 'Dek.drafts.v1', 'Dek.outbox.v1',
      'dek-backend.media', 'dek.auth', 'dek.drafts.u1', 'dek.scroll.u1', 'theme', 'supabase.auth.token',
    ];
    expect(legacyKeysToRemove(keys).sort()).toEqual([
      'Dek.drafts.v1', 'Dek.outbox.v1', 'dak.cat.servers', 'dak.lastChannel', 'dek-backend.media',
      'sb-ybddogqphinruyunnuwx-auth-token', 'supabase.auth.token',
    ]);
  });

  it('keeps unsent legacy text as failed sends, skipping what cannot be carried over', () => {
    const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
    const rows = convertLegacyRows([
      { nonce: id(1), scope_id: id(2), text: 'hello', created_at: 5, state: 'queued' },
      { nonce: id(3), scope_id: id(2), text: 'with file', attachments: [{ path: 'x' }] },
      { nonce: id(4), scope_id: id(2), text: 'reply', thread_id: id(5) },
      { nonce: id(6), scope_id: id(2), text: 'already sent', state: 'sent' },
      { nonce: 'not-a-uuid', scope_id: id(2), text: 'bad id' },
      { nonce: id(7), scope_id: id(2), text: '   ' },
    ], 'tab');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: id(1), channelId: id(2), body: 'hello', status: 'failed', statusVisible: true, createdAt: 5 });
  });
});

describe('platform detection', () => {
  const snap = (ua: string, extra: Partial<EnvSnapshot> = {}): EnvSnapshot => ({
    ua, platform: '', maxTouchPoints: 0, navigatorStandalone: false, displayModeStandalone: false, ...extra,
  });

  it('iPhone Safari tab: WebKit, needs install for push', () => {
    const p = detect(snap('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'));
    expect(p).toMatchObject({ os: 'ios', browser: 'Safari', engine: 'webkit', isIOS: true, isIOSSafari: true, iosVersion: 17.2, isStandalone: false });
    expect(deviceLabel(p)).toBe('Safari on iPhone');
  });

  it('iPadOS reports a Mac with touch points', () => {
    const p = detect(snap('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', { platform: 'MacIntel', maxTouchPoints: 5, navigatorStandalone: true }));
    expect(p).toMatchObject({ os: 'ipados', isIOS: true, iosVersion: 17.4, isStandalone: true });
    expect(platformCode(p)).toBe('ios');
  });

  it('Chrome on iPhone cannot install: open in Safari', () => {
    const p = detect(snap('Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1'));
    expect(p).toMatchObject({ isIOS: true, isIOSSafari: false, browser: 'Chrome', engine: 'webkit' });
  });

  it('Android Chrome, Windows Edge, Firefox, installed apps', () => {
    expect(deviceLabel(detect(snap('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36')))).toBe('Chrome on Android');
    expect(deviceLabel(detect(snap('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')))).toBe('Edge on Windows');
    expect(detect(snap('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'))).toMatchObject({ browser: 'Firefox', engine: 'gecko', os: 'linux' });
    expect(deviceLabel(detect(snap('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36', { displayModeStandalone: true })))).toBe('Chrome on Android (installed)');
  });
});

describe('VAPID guard', () => {
  it('matches the subscription key byte for byte', () => {
    const key = 'BMOAGjdDdmNngOJeTZvTnap0xG7U_QpGdo19fnvcPWXFQygmPW484rruKsGETRW77ad-D2RwoeYUtE3EdNNXJHs';
    const bytes = urlBase64ToUint8Array(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);   // uncompressed P-256 point
    expect(keysMatch(bytes.slice().buffer, bytes)).toBe(true);
    const other = bytes.slice();
    other[10] = (other[10]! + 1) % 256;
    expect(keysMatch(other.buffer, bytes)).toBe(false);
    expect(keysMatch(null, bytes)).toBe(false);
  });
});

describe('test notification verdict (provider accepted is not displayed)', () => {
  const since = Date.parse('2026-10-03T12:00:00Z');
  const at = (s: number) => new Date(since + s * 1000).toISOString();
  const d = (status: string, sec: number, device = 'dev-1', reason: string | null = null) => ({ created_at: at(sec), status, reason, device_id: device, kind: 'webpush' });

  it('displayed only when this browser showed it', () => {
    expect(testVerdict({ deliveries: [d('sent', 1)], since, deviceId: 'dev-1', shownAt: since + 1500, elapsedMs: 2_000 }).kind).toBe('displayed');
  });

  it('accepted but not shown after 30 s is reported as such', () => {
    expect(testVerdict({ deliveries: [d('sent', 1)], since, deviceId: 'dev-1', shownAt: null, elapsedMs: 5_000 }).kind).toBe('waiting');
    expect(testVerdict({ deliveries: [d('sent', 1)], since, deviceId: 'dev-1', shownAt: null, elapsedMs: 30_000 })).toMatchObject({ kind: 'accepted', otherDevice: false });
  });

  it('refusals, quiet hours and silence', () => {
    expect(testVerdict({ deliveries: [d('failed', 1, 'dev-1', 'http 410')], since, deviceId: 'dev-1', shownAt: null, elapsedMs: 3_000 })).toMatchObject({ kind: 'refused', reason: 'http 410' });
    expect(testVerdict({ deliveries: [d('skipped', 1, 'dev-1', 'quiet_hours')], since, deviceId: 'dev-1', shownAt: null, elapsedMs: 3_000 }).kind).toBe('skipped');
    expect(testVerdict({ deliveries: [d('sent', -600)], since, deviceId: 'dev-1', shownAt: null, elapsedMs: 30_000 }).kind).toBe('nothing');
  });
});

describe('keyboard inset and org choice', () => {
  it('only counts a real keyboard', () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
    expect(keyboardInset(844, 820, 0)).toBe(0);      // a toolbar, not a keyboard
    expect(keyboardInset(844, 508, 0)).toBe(336);
  });

  it('route org, else the remembered one, else the first', () => {
    const org = (id: string) => ({ id } as OrgSummary);
    const orgs = [org('a'), org('b'), org('c')];
    expect(pickOrg(orgs, 'c', 'b')).toBe('c');
    expect(pickOrg(orgs, 'zzz', 'b')).toBe('b');
    expect(pickOrg(orgs, null, 'gone')).toBe('a');
    expect(pickOrg([], null, null)).toBeNull();
  });
});
