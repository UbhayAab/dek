import { describe, expect, test } from 'vitest';
import {
  charCount, hasErrors, hhmmLabel, isEmail, normalizeHandle, validateChannel, validateInvite, validateProfile,
  validateQuietHours, validateReason, validateServer, validateStatus, wholeNumber,
} from '../../src/features/admin/common/validation';

describe('server and channel forms', () => {
  test('a server needs a name of at most 80 characters on one line', () => {
    expect(validateServer({ name: '  ', description: '', icon_emoji: '' }).name).toBe('Name is required.');
    expect(validateServer({ name: 'x'.repeat(81), description: '', icon_emoji: '' }).name).toMatch(/at most 80/);
    expect(validateServer({ name: 'Tech\nTeam', description: '', icon_emoji: '' }).name).toMatch(/single line/);
    expect(hasErrors(validateServer({ name: 'Medical Partnerships', description: 'line one\nline two', icon_emoji: '🩺' }))).toBe(false);
  });

  test('channel limits follow the contract: topic 250, description 1000, category 40', () => {
    const ok = { name: 'grants', topic: '', description: '', category: '' };
    expect(hasErrors(validateChannel(ok))).toBe(false);
    expect(validateChannel({ ...ok, topic: 't'.repeat(251) }).topic).toMatch(/250/);
    expect(validateChannel({ ...ok, description: 'd'.repeat(1001) }).description).toMatch(/1000/);
    expect(validateChannel({ ...ok, category: 'c'.repeat(41) }).category).toMatch(/40/);
    expect(validateChannel({ ...ok, name: '' }).name).toBe('Name is required.');
  });

  test('lengths count characters the way the database does, not UTF-16 units', () => {
    expect(charCount('👍👍')).toBe(2);
    expect(validateServer({ name: '👍'.repeat(80), description: '', icon_emoji: '' }).name).toBeUndefined();
  });
});

describe('invite form', () => {
  const base = { email: '', expiresHours: 168, maxUses: '', channelCount: 0 };

  test('empty optional fields are fine', () => {
    expect(validateInvite(base)).toEqual({});
  });

  test('email must look like an address', () => {
    expect(validateInvite({ ...base, email: 'not-an-email' }).email).toBeTruthy();
    expect(validateInvite({ ...base, email: 'asha@jarurat.care' }).email).toBeUndefined();
    expect(isEmail(' asha@jarurat.care ')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
  });

  test('expiry from 1 hour to 30 days, uses from 1 to 10000, at most 20 channels', () => {
    expect(validateInvite({ ...base, expiresHours: 0 }).expires).toBeTruthy();
    expect(validateInvite({ ...base, expiresHours: 721 }).expires).toBeTruthy();
    expect(validateInvite({ ...base, expiresHours: 720 }).expires).toBeUndefined();
    expect(validateInvite({ ...base, maxUses: '0' }).max_uses).toBeTruthy();
    expect(validateInvite({ ...base, maxUses: '10001' }).max_uses).toBeTruthy();
    expect(validateInvite({ ...base, maxUses: '2.5' }).max_uses).toBeTruthy();
    expect(validateInvite({ ...base, maxUses: ' 25 ' }).max_uses).toBeUndefined();
    expect(validateInvite({ ...base, channelCount: 21 }).channels).toBeTruthy();
  });

  test('whole numbers only', () => {
    expect(wholeNumber('12')).toBe(12);
    expect(wholeNumber('-1')).toBeNull();
    expect(wholeNumber('1e3')).toBeNull();
    expect(wholeNumber('')).toBeNull();
  });
});

describe('profile and status', () => {
  test('handles are normalised like the server does', () => {
    expect(normalizeHandle('@Asha.R')).toBe('asha.r');
    expect(normalizeHandle('   ')).toBeNull();
  });

  test('profile rules', () => {
    const ok = { display_name: 'Asha', handle: '', title: '' };
    expect(validateProfile(ok)).toEqual({});
    expect(validateProfile({ ...ok, display_name: ' ' }).display_name).toBeTruthy();
    expect(validateProfile({ ...ok, handle: 'a' }).handle).toBeTruthy();
    expect(validateProfile({ ...ok, handle: '-asha' }).handle).toBeTruthy();
    expect(validateProfile({ ...ok, handle: '@asha_r' }).handle).toBeUndefined();
    expect(validateProfile({ ...ok, title: 't'.repeat(81) }).title).toBeTruthy();
  });

  test('status text at most 100 characters after collapsing spaces', () => {
    expect(validateStatus({ text: 'In a meeting', emoji: '📅' })).toEqual({});
    expect(validateStatus({ text: 'x'.repeat(101), emoji: '' }).text).toBeTruthy();
    expect(validateStatus({ text: `${'a '.repeat(50)}`, emoji: '' }).text).toBeUndefined();
  });

  test('reasons and notes have a length cap', () => {
    expect(validateReason('r'.repeat(500))).toBeUndefined();
    expect(validateReason('r'.repeat(501))).toBeTruthy();
    expect(validateReason('n'.repeat(901), 900)).toBeTruthy();
  });
});

describe('quiet hours', () => {
  test('off needs nothing', () => {
    expect(validateQuietHours({ enabled: false, start: '', end: '' })).toEqual({});
  });

  test('both times, 24 hour HH:MM, and different', () => {
    expect(validateQuietHours({ enabled: true, start: '22:00', end: '07:00' })).toEqual({});
    expect(validateQuietHours({ enabled: true, start: '', end: '07:00' }).quiet_start).toBeTruthy();
    expect(validateQuietHours({ enabled: true, start: '24:00', end: '07:00' }).quiet_start).toBeTruthy();
    expect(validateQuietHours({ enabled: true, start: '07:00', end: '07:00' }).quiet_end).toBeTruthy();
  });

  test('labels read as clock times', () => {
    expect(hhmmLabel('22:30', 'en-US')).toBe('10:30 PM');
    expect(hhmmLabel('bad')).toBe('');
  });
});

describe('organization settings', () => {
  const ok = { name: 'Dek QA', short_name: 'DQ', brand_color: '#0F766E', edit_window_minutes: null, default_invite_hours: 168 };
  test('a valid form has no errors', async () => {
    const { validateOrg } = await import('../../src/features/admin/common/validation');
    expect(validateOrg(ok)).toEqual({});
  });
  test('name required, short name at most 24, a hex brand color, sane limits', async () => {
    const { validateOrg } = await import('../../src/features/admin/common/validation');
    expect(validateOrg({ ...ok, name: ' ' }).name).toBe('Name is required.');
    expect(validateOrg({ ...ok, short_name: 'x'.repeat(25) }).short_name).toMatch(/24/);
    expect(validateOrg({ ...ok, brand_color: 'teal' }).brand_color).toBeTruthy();
    expect(validateOrg({ ...ok, brand_color: '#abc' }).brand_color).toBeUndefined();
    expect(validateOrg({ ...ok, edit_window_minutes: 43201 }).edit_window_minutes).toBeTruthy();
    expect(validateOrg({ ...ok, edit_window_minutes: 0 }).edit_window_minutes).toBeUndefined();
    expect(validateOrg({ ...ok, default_invite_hours: 0 }).default_invite_hours).toBeTruthy();
  });
  test('colors are normalised the way people type them', async () => {
    const { normalizeHexColor, isHexColor } = await import('../../src/features/admin/common/validation');
    expect(normalizeHexColor('0f766e')).toBe('#0F766E');
    expect(normalizeHexColor('#abc')).toBe('#AABBCC');
    expect(normalizeHexColor(' purple ')).toBe('purple');
    expect(isHexColor('#0F766E')).toBe(true);
    expect(isHexColor('#0F766')).toBe(false);
  });
});
