// Time labels for the conversation UI. Pure functions over ISO strings so they are
// testable; everything is shown in the viewer's local time zone.
import { limits } from '../../config';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fullDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const shortDateYearFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toDate(v: string | number | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

// Local calendar day, used to place day separators.
export function dayKey(v: string | number | Date): string {
  const d = toDate(v);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// "Today", "Yesterday", "Monday, 29 September", or "29 September 2025".
export function dayLabel(v: string | number | Date, now: Date = new Date()): string {
  const d = toDate(v);
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return weekdayFmt.format(d);
  return fullDateFmt.format(d);
}

export function timeLabel(v: string | number | Date): string {
  return timeFmt.format(toDate(v));
}

export function fullTimeLabel(v: string | number | Date): string {
  return fullFmt.format(toDate(v));
}

// Compact relative time for lists: "now", "5m", "3h", "Yesterday", "29 Sep".
export function relativeShort(v: string | number | Date, now: Date = new Date()): string {
  const d = toDate(v);
  const diff = now.getTime() - d.getTime();
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (days === 0) return `${Math.floor(diff / HOUR)}h`;
  if (days === 1) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return shortDateFmt.format(d);
  return shortDateYearFmt.format(d);
}

// Spoken form for buttons and labels: "5 minutes ago", "Yesterday at 4:00 PM".
export function relativeLong(v: string | number | Date, now: Date = new Date()): string {
  const d = toDate(v);
  const diff = now.getTime() - d.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
  if (days === 0) {
    const h = Math.floor(diff / HOUR);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  if (days === 1) return `Yesterday at ${timeLabel(d)}`;
  return `${dayLabel(d, now)} at ${timeLabel(d)}`;
}

// Presence is Profile.last_active_at: "active" within 10 minutes (CONTRACT 0).
export function isActive(lastActiveAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastActiveAt) return false;
  const t = Date.parse(lastActiveAt);
  return Number.isFinite(t) && now - t < limits.activeWindowMs;
}

export function minutesBetween(a: string | number, b: string | number): number {
  const ta = typeof a === 'number' ? a : Date.parse(a);
  const tb = typeof b === 'number' ? b : Date.parse(b);
  return Math.abs(tb - ta) / MINUTE;
}
