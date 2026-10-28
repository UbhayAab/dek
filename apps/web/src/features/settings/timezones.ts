// Time zones for the profile and quiet hours: the browser's list, the device's
// own zone first, searchable by city, region or a few country names people type
// (India finds Asia/Kolkata). Pure except deviceTimezone and allTimezones.

const FALLBACK: readonly string[] = [
  'UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Colombo', 'Asia/Karachi', 'Asia/Dubai', 'Asia/Singapore',
  'Asia/Tokyo', 'Asia/Shanghai', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Africa/Nairobi', 'Africa/Lagos',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney',
];

const ALIASES: Readonly<Record<string, string>> = {
  india: 'Asia/Kolkata',
  ist: 'Asia/Kolkata',
  calcutta: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata',
  bengaluru: 'Asia/Kolkata',
  nepal: 'Asia/Kathmandu',
  bangladesh: 'Asia/Dhaka',
  'sri lanka': 'Asia/Colombo',
  pakistan: 'Asia/Karachi',
  uae: 'Asia/Dubai',
  uk: 'Europe/London',
  britain: 'Europe/London',
  germany: 'Europe/Berlin',
  france: 'Europe/Paris',
  kenya: 'Africa/Nairobi',
  nigeria: 'Africa/Lagos',
  japan: 'Asia/Tokyo',
  china: 'Asia/Shanghai',
  gmt: 'UTC',
};

// Chromium still answers with the old names (Asia/Calcutta for India, the zone
// most Dek people are in); people search for and recognise the current ones.
const MODERN: Readonly<Record<string, string>> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Uzhgorod': 'Europe/Kyiv',
  'Europe/Zaporozhye': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'America/Godthab': 'America/Nuuk',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'Africa/Asmera': 'Africa/Asmara',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Enderbury': 'Pacific/Kanton',
};

export function modernZone(zone: string): string {
  return MODERN[zone] ?? zone;
}

export function deviceTimezone(): string | null {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z ? modernZone(z) : null;
  } catch {
    return null;
  }
}

export function allTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let list: string[] = [];
  try {
    list = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    list = [];
  }
  if (!list.length) list = [...FALLBACK];
  return Array.from(new Set(['UTC', ...list.map(modernZone)]));
}

// The device's zone first, then the current choice, then A to Z.
export function orderTimezones(all: readonly string[], device: string | null, current: string | null): string[] {
  const head: string[] = [];
  if (device) head.push(device);
  if (current && current !== device) head.push(current);
  const rest = all.filter((z) => !head.includes(z)).sort((a, b) => a.localeCompare(b));
  return [...head, ...rest];
}

// "America/Argentina/Buenos_Aires" -> "Buenos Aires (America, Argentina)"
export function tzLabel(zone: string): string {
  const parts = zone.split('/');
  if (parts.length === 1) return zone.replace(/_/g, ' ');
  const city = parts[parts.length - 1]!.replace(/_/g, ' ');
  return `${city} (${parts.slice(0, -1).join(', ').replace(/_/g, ' ')})`;
}

function haystack(zone: string): string {
  return zone.toLowerCase().replace(/[_/]+/g, ' ');
}

export function filterTimezones(list: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ');
  if (!q) return [...list];
  const aliased = new Set(Object.entries(ALIASES).filter(([k]) => k.startsWith(q) || q.startsWith(k)).map(([, v]) => v));
  const words = q.split(' ');
  return list.filter((z) => aliased.has(z) || words.every((w) => haystack(z).includes(w)));
}

const offsets = new Map<string, string>();

// "GMT+5:30" for Asia/Kolkata (empty when the browser cannot tell). Without an
// explicit moment the answer is cached for the page's lifetime.
export function tzOffset(zone: string, at?: Date): string {
  if (!at && offsets.has(zone)) return offsets.get(zone) ?? '';
  let out = '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at ?? new Date());
    out = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    out = '';
  }
  if (!at) offsets.set(zone, out);
  return out;
}

export function isTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
