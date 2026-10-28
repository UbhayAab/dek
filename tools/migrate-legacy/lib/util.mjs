// Small pure helpers shared by transform, load and verify.
import { createHash } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// RFC 4122 version 5 (sha1, namespace + name): stable ids across runs.
export function uuidv5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(Buffer.concat([ns, Buffer.from(String(name), 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// Fixed-width sortable key for a PostgreSQL timestamp string in any of its output
// forms ('2026-09-26 17:13:02.308055+00', '2026-09-26T17:13:02.30805+00:00').
// Every connection runs with TimeZone=UTC, so the offset is always zero.
export function tsKey(ts) {
  if (ts == null) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(String(ts));
  if (!m) return String(ts);
  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}${(m[7] || '').padEnd(6, '0')}`;
}

export const maxTs = (...xs) => xs.filter((x) => x != null)
  .reduce((a, b) => (a == null || tsKey(b) > tsKey(a) ? b : a), null);

export function byKey(rows, key) {
  const out = new Map();
  for (const r of rows) out.set(typeof key === 'function' ? key(r) : r[key], r);
  return out;
}

export function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = typeof key === 'function' ? key(r) : r[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
export const clipOrNull = (s, n) => {
  const t = s == null ? '' : String(s).trim();
  return t ? t.slice(0, n) : null;
};

// The legacy client's quote preview text (dek-legacy/js/util.js plain()).
export function plain(text, n = 120) {
  const s = (text || '').replace(/[*_`~>#]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// A storage-safe file name: ASCII letters, digits, dot, dash, underscore.
export function safeFileName(name, fallbackExt = '') {
  const base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let s = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!s) s = 'file';
  const dot = s.lastIndexOf('.');
  let stem = dot > 0 ? s.slice(0, dot) : s;
  let ext = dot > 0 ? s.slice(dot + 1) : '';
  if (!ext && fallbackExt) ext = fallbackExt.replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
  ext = ext.slice(0, 10);
  stem = stem.slice(0, 100 - (ext ? ext.length + 1 : 0)) || 'file';
  return ext ? `${stem}.${ext}` : stem;
}

export const extOf = (key) => {
  const b = String(key || '').split('/').pop();
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};
export const baseName = (key) => String(key || '').split('/').pop();
export const baseMime = (m) => (m ? String(m).split(';')[0].trim().toLowerCase() : null);

// WCAG relative luminance contrast of a #RRGGBB color against white.
export function contrastWithWhite(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (l + 0.05);
}

// Never print row data: pg puts whole rows (bodies, emails) into error.detail.
export function safeError(e) {
  if (!e) return 'unknown error';
  const parts = [e.code, e.message, e.constraint && `constraint ${e.constraint}`,
    e.table && `table ${e.table}`, e.column && `column ${e.column}`].filter(Boolean);
  return parts.join(' | ').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
}

// A seeded PRNG (mulberry32) so a reconciliation sample can be reproduced.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample(list, n, rand) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
