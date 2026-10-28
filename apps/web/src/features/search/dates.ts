// Date filters for search. <input type="date"> gives "YYYY-MM-DD" in the viewer's
// calendar; the server compares instants. "On or after" sends the instant the
// local day starts; "On or before" sends the instant the NEXT local day starts,
// so the chosen day is included at both ends.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  y: number;
  m: number; // 1 to 12
  d: number;
}

export function parseDateInput(value: string): DateParts | null {
  const match = DATE.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Rejects days a month does not have (31 April, 29 February in common years).
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return { y, m, d };
}

export function dayStartIso(value: string): string | null {
  const p = parseDateInput(value);
  return p ? new Date(p.y, p.m - 1, p.d).toISOString() : null;
}

export function nextDayStartIso(value: string): string | null {
  const p = parseDateInput(value);
  return p ? new Date(p.y, p.m - 1, p.d + 1).toISOString() : null;
}

// "YYYY-MM-DD" for a local date (the max attribute of the date inputs).
export function toDateInput(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// A human sentence when the range cannot be searched, otherwise null.
export function dateRangeError(after: string, before: string): string | null {
  if (after && !parseDateInput(after)) return 'The start date is not a real date.';
  if (before && !parseDateInput(before)) return 'The end date is not a real date.';
  // Valid "YYYY-MM-DD" strings compare correctly as text.
  if (after && before && after > before) return 'The start date is after the end date.';
  return null;
}
