import { describe, expect, it } from 'vitest';
import { dateRangeError, dayStartIso, nextDayStartIso, parseDateInput, toDateInput } from '../../src/features/search/dates';
import { fileIcon, fileKind, fileKindLabel, humanSize } from '../../src/features/search/files';

describe('search date filters', () => {
  it('parses real calendar dates only', () => {
    expect(parseDateInput('2026-10-03')).toEqual({ y: 2026, m: 10, d: 3 });
    expect(parseDateInput(' 2028-02-29 ')).toEqual({ y: 2028, m: 2, d: 29 });
    expect(parseDateInput('2026-02-29')).toBeNull();
    expect(parseDateInput('2026-04-31')).toBeNull();
    expect(parseDateInput('2026-13-01')).toBeNull();
    expect(parseDateInput('2026-00-10')).toBeNull();
    expect(parseDateInput('03/10/2026')).toBeNull();
    expect(parseDateInput('')).toBeNull();
    expect(parseDateInput('0099-01-01')).toBeNull();
  });

  it('sends the start of the local day for "on or after"', () => {
    // Built from local wall-clock parts, so the expectation holds in any time zone.
    expect(dayStartIso('2026-10-03')).toBe(new Date(2026, 9, 3).toISOString());
    expect(dayStartIso('nope')).toBeNull();
  });

  it('sends the start of the next local day for "on or before", across month and year ends', () => {
    expect(nextDayStartIso('2026-10-03')).toBe(new Date(2026, 9, 4).toISOString());
    expect(nextDayStartIso('2026-10-31')).toBe(new Date(2026, 10, 1).toISOString());
    expect(nextDayStartIso('2026-12-31')).toBe(new Date(2027, 0, 1).toISOString());
    expect(nextDayStartIso('2028-02-28')).toBe(new Date(2028, 1, 29).toISOString());
    expect(nextDayStartIso('bad')).toBeNull();
  });

  it('includes the chosen day at both ends', () => {
    const lo = Date.parse(dayStartIso('2026-10-03')!);
    const hi = Date.parse(nextDayStartIso('2026-10-03')!);
    const noon = new Date(2026, 9, 3, 12).getTime();
    const lateEvening = new Date(2026, 9, 3, 23, 59, 59).getTime();
    expect(noon > lo && noon < hi).toBe(true);
    expect(lateEvening < hi).toBe(true);
    expect(new Date(2026, 9, 4, 0, 0, 1).getTime() < hi).toBe(false);
  });

  it('formats a local date for the max attribute', () => {
    expect(toDateInput(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('explains ranges that cannot be searched', () => {
    expect(dateRangeError('', '')).toBeNull();
    expect(dateRangeError('2026-10-01', '2026-10-03')).toBeNull();
    expect(dateRangeError('2026-10-03', '2026-10-03')).toBeNull();
    expect(dateRangeError('2026-10-04', '2026-10-03')).toMatch(/start date is after/);
    expect(dateRangeError('2026-02-30', '')).toMatch(/start date/);
    expect(dateRangeError('', '2026-02-30')).toMatch(/end date/);
  });
});

describe('file result labels', () => {
  it('maps MIME types to kinds, icons and labels', () => {
    expect(fileKind('image/png')).toBe('image');
    expect(fileKind('IMAGE/HEIC')).toBe('image');
    expect(fileKind('video/mp4')).toBe('video');
    expect(fileKind('audio/ogg')).toBe('audio');
    expect(fileKind('application/pdf')).toBe('pdf');
    expect(fileKind('text/csv')).toBe('file');
    expect(fileKind(null)).toBe('file');
    expect(fileIcon('audio')).toBe('headphones');
    expect(fileIcon('pdf')).toBe('file');
    expect(fileKindLabel('pdf')).toBe('PDF');
  });

  it('prints sizes people can read', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(812)).toBe('812 B');
    expect(humanSize(1536)).toBe('1.5 KB');
    expect(humanSize(12 * 1024)).toBe('12 KB');
    expect(humanSize(1024 * 1024)).toBe('1.0 MB');
    expect(humanSize(1023.9 * 1024)).toBe('1.0 MB');
    expect(humanSize(25 * 1024 * 1024)).toBe('25 MB');
    expect(humanSize(1.25 * 1024 * 1024 * 1024)).toBe('1.3 GB');
    expect(humanSize(-1)).toBe('');
    expect(humanSize(Number.NaN)).toBe('');
  });
});
