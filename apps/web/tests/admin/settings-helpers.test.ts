import { afterEach, describe, expect, test } from 'vitest';
import type { Device } from '../../src/api/types';
import { centered, checkPicture, clampOffset, coverScale, panBy, sourceRect, zoomTo, MAX_ZOOM } from '../../src/features/settings/crop';
import { deviceState } from '../../src/features/settings/sections/Devices';
import { statusUntil } from '../../src/features/settings/status';
import { applyTheme, readTheme, setTheme, THEME_KEY } from '../../src/features/settings/theme';
import { filterTimezones, modernZone, orderTimezones, tzLabel, tzOffset } from '../../src/features/settings/timezones';

describe('status clear times', () => {
  const now = new Date(2026, 9, 3, 15, 0, 0);
  test('fixed durations', () => {
    expect(statusUntil('30m', now)).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
    expect(statusUntil('1h', now)).toBe(new Date(now.getTime() + 3_600_000).toISOString());
    expect(statusUntil('4h', now)).toBe(new Date(now.getTime() + 4 * 3_600_000).toISOString());
    expect(statusUntil('never', now)).toBeNull();
  });
  test('today ends at local midnight, and is always in the future', () => {
    expect(statusUntil('today', now)).toBe(new Date(2026, 9, 3, 23, 59, 59, 999).toISOString());
    const late = new Date(2026, 9, 3, 23, 59, 59, 990);
    expect(Date.parse(statusUntil('today', late) as string)).toBeGreaterThanOrEqual(late.getTime() + 60_000);
  });
});

describe('theme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });
  test('a theme sets data-theme; auto removes it', () => {
    const el = document.createElement('html');
    applyTheme('dark', el);
    expect(el.getAttribute('data-theme')).toBe('dark');
    applyTheme('classic', el);
    expect(el.getAttribute('data-theme')).toBe('classic');
    applyTheme('auto', el);
    expect(el.hasAttribute('data-theme')).toBe(false);
  });
  test('the choice is stored under dek.theme; auto clears it', () => {
    setTheme('contrast');
    expect(localStorage.getItem(THEME_KEY)).toBe('contrast');
    expect(document.documentElement.getAttribute('data-theme')).toBe('contrast');
    setTheme('auto');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
  test('a saved light or dark from before the shared themes still reads', () => {
    expect(readTheme({ getItem: () => 'dark' })).toBe('dark');
    expect(readTheme({ getItem: () => 'light' })).toBe('light');
  });
  test('broken or blocked storage falls back to auto', () => {
    expect(readTheme({ getItem: () => 'purple' })).toBe('auto');
    expect(readTheme({ getItem: () => { throw new Error('denied'); } })).toBe('auto');
    expect(readTheme(null)).toBe('auto');
  });
});

describe('time zones', () => {
  const all = ['UTC', 'America/New_York', 'Asia/Kolkata', 'Europe/London', 'Asia/Kathmandu'];
  test('the device zone comes first, then the current choice, then A to Z', () => {
    expect(orderTimezones(all, 'Asia/Kolkata', 'Europe/London')).toEqual(['Asia/Kolkata', 'Europe/London', 'America/New_York', 'Asia/Kathmandu', 'UTC']);
    expect(orderTimezones(all, null, null)[0]).toBe('America/New_York');
  });
  test('search by city, region words, or a country people type', () => {
    expect(filterTimezones(all, 'kolkata')).toEqual(['Asia/Kolkata']);
    expect(filterTimezones(all, 'india')).toEqual(['Asia/Kolkata']);
    expect(filterTimezones(all, 'new york')).toEqual(['America/New_York']);
    expect(filterTimezones(all, 'asia')).toEqual(['Asia/Kolkata', 'Asia/Kathmandu']);
    expect(filterTimezones(all, '')).toEqual(all);
  });
  test('old zone names some browsers still report become the current ones', () => {
    expect(modernZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(modernZone('Asia/Katmandu')).toBe('Asia/Kathmandu');
    expect(modernZone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(modernZone('Asia/Kolkata')).toBe('Asia/Kolkata');
  });
  test('labels and offsets', () => {
    expect(tzLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires (America, Argentina)');
    expect(tzLabel('UTC')).toBe('UTC');
    expect(tzOffset('Asia/Kolkata', new Date('2026-01-01T00:00:00Z'))).toBe('GMT+5:30');
  });
});

describe('picture crop math', () => {
  test('the short side fills the square at zoom 1', () => {
    expect(coverScale(800, 400, 200)).toBe(0.5);
    const c = centered(800, 400, 200);
    expect(c).toEqual({ zoom: 1, x: -100, y: 0 });
    expect(sourceRect(800, 400, 200, c)).toEqual({ sx: 200, sy: 0, size: 400 });
  });
  test('the picture always covers the square', () => {
    expect(clampOffset(800, 400, 200, 1, 50, 50)).toEqual({ x: 0, y: 0 });
    expect(clampOffset(800, 400, 200, 1, -1000, -1000)).toEqual({ x: -200, y: 0 });
  });
  test('zooming keeps the middle in the middle and stays inside the picture', () => {
    const z = zoomTo(400, 400, 200, centered(400, 400, 200), 2);
    expect(z.zoom).toBe(2);
    const r = sourceRect(400, 400, 200, z);
    expect(r.size).toBe(200);
    expect(r.sx + r.size / 2).toBeCloseTo(200);
    expect(r.sy + r.size / 2).toBeCloseTo(200);
    expect(zoomTo(400, 400, 200, z, 99).zoom).toBe(MAX_ZOOM);
    const panned = panBy(400, 400, 200, z, -1000, -1000);
    const pr = sourceRect(400, 400, 200, panned);
    expect(pr.sx + pr.size).toBeLessThanOrEqual(400);
    expect(pr.sy + pr.size).toBeLessThanOrEqual(400);
  });
  test('only pictures under 20 MB', () => {
    expect(checkPicture({ type: 'image/png', size: 1000 })).toBeNull();
    expect(checkPicture({ type: 'application/pdf', size: 1000 })).toMatch(/picture/);
    expect(checkPicture({ type: 'image/jpeg', size: 21 * 1024 * 1024 })).toMatch(/20 MB/);
  });
});

describe('device status', () => {
  const d = (over: Partial<Device>): Device => ({
    id: 'd', kind: 'webpush', label: null, platform: null, created_at: '2026-10-01T00:00:00Z', last_seen_at: null,
    last_attempt_at: null, last_success_at: null, last_status: null, failure_count: 0, enabled: true, ...over,
  });
  test('off, failing, working, ready', () => {
    expect(deviceState(d({ enabled: false, last_status: 'expired' })).label).toBe('Off');
    expect(deviceState(d({ last_attempt_at: '2026-10-03T10:00:00Z', last_success_at: '2026-10-02T10:00:00Z', failure_count: 2, last_status: '410 Gone' }))).toMatchObject({ label: 'Failing', tone: 'danger' });
    expect(deviceState(d({ last_attempt_at: '2026-10-03T10:00:00Z', last_success_at: '2026-10-03T10:00:00Z' })).label).toBe('Working');
    expect(deviceState(d({})).label).toBe('Ready');
  });
});

describe('account deletion answers', () => {
  test('each status of the account-delete function becomes a clear refusal', async () => {
    const { deletionError } = await import('../../src/features/settings/sections/Account');
    expect(deletionError(401, null).code).toBe('auth_required');
    expect(deletionError(409, 'You are the last owner of Dek QA.')).toMatchObject({ code: 'conflict', hint: 'You are the last owner of Dek QA.' });
    expect(deletionError(500, 'Your data is removed, but the sign-in account could not be closed. Try again.')).toMatchObject({ code: 'server', retryable: true });
    expect(deletionError(503, null).hint).toMatch(/not available/);
    expect(deletionError(404, null).hint).toMatch(/not on the server yet/);
    expect(deletionError(null, null).code).toBe('network');
  });
});
