// sniff.ts: what a file really is, from its first bytes. Owner: [media].
//
// Pure functions, no Deno and no network, so the Node tests import this file directly
// (supabase/tests/media-sniff.test.mjs). media-finalize/index.ts does the I/O.
//
//   sniff(head, total)  -> what the bytes are (with dimensions and duration when the
//                          header says), a blocked verdict (programs, scripts, macros,
//                          web pages), or unknown
//   judge(s, ...)       -> accept with the real type, or refuse with a reason
//
// The allow-list and limits mirror dek.media_family and dek.media_max_bytes in
// supabase/migrations/0400_media_uploads.sql; api.svc_finalize_upload re-checks them.

export type Family = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'office' | 'archive';

export type Reason =
  | 'executable' | 'macro' | 'web_page' | 'archive_program' | 'unknown_type' | 'not_allowed'
  | 'type_mismatch' | 'too_large' | 'content_type' | 'empty' | 'not_utf8';

export type Sniff =
  | { kind: 'match'; label: string; mimes: string[]; width?: number; height?: number; durationMs?: number; jpegNext?: number; jpegOrientation?: number }
  | { kind: 'blocked'; reason: Reason; label: string }
  | { kind: 'unknown'; reason: Reason; label: string };

export type Verdict =
  | { ok: true; mime: string; family: Family; width?: number; height?: number; durationMs?: number }
  | { ok: false; reason: Reason; message: string };

const MB = 1024 * 1024;
export const HEAD_BYTES = 64 * 1024;
export const THUMB_MAX_BYTES = 2 * MB;

export const MESSAGES: Record<Reason, string> = {
  executable: 'This is a program or a script. Programs cannot be shared in Dek.',
  macro: 'This document contains macros, which can run code. Save it without macros and try again.',
  web_page: 'Web pages and scripts cannot be shared as files.',
  archive_program: 'This zip file contains a program or a script, which cannot be shared in Dek.',
  unknown_type: 'Dek could not recognise this file. Photos, videos, audio, PDF, text, CSV, Office documents and zip files can be shared.',
  not_allowed: 'This kind of file cannot be shared in Dek.',
  type_mismatch: 'This file is not the kind of file its type says it is.',
  too_large: 'This file is larger than Dek allows for its type (100 MB for video, 25 MB for everything else).',
  content_type: 'The upload did not say what kind of file it was. Try again.',
  empty: 'The file is empty.',
  not_utf8: 'Text and CSV files must be saved as UTF-8 (in Excel: "CSV UTF-8").',
};

const FAMILY: Record<string, Family> = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'image/heic': 'image', 'image/heif': 'image', 'image/avif': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/ogg': 'audio', 'audio/webm': 'audio',
  'audio/wav': 'audio', 'audio/aac': 'audio',
  'application/pdf': 'pdf',
  'text/plain': 'text', 'text/csv': 'text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'office',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'office',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'office',
  'application/msword': 'office', 'application/vnd.ms-excel': 'office', 'application/vnd.ms-powerpoint': 'office',
  'application/vnd.oasis.opendocument.text': 'office',
  'application/vnd.oasis.opendocument.spreadsheet': 'office',
  'application/vnd.oasis.opendocument.presentation': 'office',
  'application/zip': 'archive',
};

const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png',
  'image/heic-sequence': 'image/heic', 'image/heif-sequence': 'image/heif', 'video/x-m4v': 'video/mp4',
  'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/mpeg3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg',
  'audio/mpg': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/x-mp4': 'audio/mp4',
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'audio/x-pn-wav': 'audio/wav',
  'audio/x-aac': 'audio/aac', 'audio/aacp': 'audio/aac', 'application/x-pdf': 'application/pdf',
  'text/x-csv': 'text/csv', 'application/csv': 'text/csv', 'text/comma-separated-values': 'text/csv',
  'application/x-zip-compressed': 'application/zip', 'application/x-zip': 'application/zip',
  'multipart/x-zip': 'application/zip',
};

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Programs and scripts that must not ride inside a zip file.
const PROGRAM_EXT = new Set([
  'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'msp', 'scr', 'pif', 'cpl', 'jar', 'js', 'jse', 'vbs', 'vbe',
  'wsf', 'wsh', 'hta', 'lnk', 'ps1', 'psm1', 'reg', 'sh', 'apk', 'app', 'dmg', 'pkg', 'deb', 'rpm',
  'iso', 'img', 'vhd', 'vhdx', 'docm', 'xlsm', 'pptm',
]);

export function canonicalMime(mime: string | null | undefined): string {
  const m = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return ALIASES[m] ?? m;
}

export function familyOf(mime: string | null | undefined): Family | null {
  return FAMILY[canonicalMime(mime)] ?? null;
}

export function maxBytes(family: Family): number {
  return family === 'video' ? 100 * MB : 25 * MB;
}

// ------------------------------------------------------------------ bytes

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = at; i < at + len && i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return s;
}
const u16be = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number): number => b[i] * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const u32le = (b: Uint8Array, i: number): number => b[i + 3] * 0x1000000 + ((b[i + 2] << 16) | (b[i + 1] << 8) | b[i]);

function has(b: Uint8Array, bytes: number[], at = 0): boolean {
  if (at + bytes.length > b.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (b[at + i] !== bytes[i]) return false;
  return true;
}

function find(b: Uint8Array, needle: number[] | string, from = 0, to = b.length): number {
  const n = typeof needle === 'string' ? [...needle].map((c) => c.charCodeAt(0)) : needle;
  const end = Math.min(to, b.length) - n.length;
  outer: for (let i = Math.max(0, from); i <= end; i += 1) {
    for (let j = 0; j < n.length; j += 1) if (b[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

const positive = (n: number | undefined): number | undefined =>
  n !== undefined && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;

// ------------------------------------------------------------------ programs

function program(b: Uint8Array): string | null {
  // A DOS or PE header always has NUL bytes in its first 64; a text file that happens
  // to start with "MZ" has none.
  if (has(b, [0x4d, 0x5a]) && b.subarray(0, 64).includes(0)) return 'Windows program';
  if (has(b, [0x7f, 0x45, 0x4c, 0x46])) return 'Linux program';
  if (b.length >= 4) {
    const m = u32be(b, 0);
    if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe) return 'Mac program';
    if (m === 0xcafebabe) return 'Mac or Java program';
  }
  const at = has(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  if (has(b, [0x23, 0x21], at)) return 'script';
  if (has(b, [0x64, 0x65, 0x78, 0x0a])) return 'Android program';
  if (has(b, [0x00, 0x61, 0x73, 0x6d])) return 'WebAssembly program';
  return null;
}

// ------------------------------------------------------------------ images

// Walks JPEG segments from `at`. Big EXIF blocks can push the frame header past the
// first 64 KB; then `next` says where (absolute offset) to read on from.
// Read only IFD0's orientation, within the APP1 segment. Never follow arbitrary
// TIFF offsets outside it or change the original bytes (including their EXIF).
function exifOrientation(b: Uint8Array, at: number, end: number): number | undefined {
  if (ascii(b, at, 6) !== 'Exif\0\0') return undefined;
  const t = at + 6;
  const limit = Math.min(end, b.length);
  if (t + 8 > limit) return undefined;
  const order = ascii(b, t, 2);
  if (order !== 'II' && order !== 'MM') return undefined;
  const short = order === 'II' ? u16le : u16be;
  const long = order === 'II' ? u32le : u32be;
  if (short(b, t + 2) !== 42) return undefined;
  const offset = long(b, t + 4);
  if (offset < 8 || offset > limit - t - 2) return undefined;
  const ifd = t + offset;
  const count = short(b, ifd);
  for (let n = 0, p = ifd + 2; n < count && p + 12 <= limit; n += 1, p += 12) {
    if (short(b, p) !== 0x0112 || short(b, p + 2) !== 3 || long(b, p + 4) !== 1) continue;
    const value = short(b, p + 8);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

export function jpegScan(b: Uint8Array, at: number, base = 0, orientation?: number): { width?: number; height?: number; next?: number; orientation?: number } {
  let i = at;
  const meta = () => orientation === undefined ? {} : { orientation };
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return {};
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return {};
    const len = u16be(b, i + 2);
    if (len < 2) return {};
    if (m === 0xe1) {
      // A segment beginning near the end of a range gets one aligned read, so
      // IFD0 is not lost simply because it straddled the first 64 KB.
      if (i > 0 && i + 2 + len > b.length) return { next: base + i, ...meta() };
      orientation ??= exifOrientation(b, i + 4, i + 2 + len);
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return { next: base + i, ...meta() };
      const w = positive(u16be(b, i + 7));
      const h = positive(u16be(b, i + 5));
      const swap = orientation !== undefined && orientation >= 5;
      return { width: swap ? h : w, height: swap ? w : h, ...meta() };
    }
    i += 2 + len;
  }
  return { next: base + i, ...meta() };
}

function webpSize(b: Uint8Array): { width?: number; height?: number } {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && has(b, [0x9d, 0x01, 0x2a], 23)) {
    return { width: positive(u16le(b, 26) & 0x3fff), height: positive(u16le(b, 28) & 0x3fff) };
  }
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    return {
      width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
      height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return {};
}

// HEIF and AVIF keep image sizes in 'ispe' boxes (the main image is the largest).
function ispeSize(b: Uint8Array): { width?: number; height?: number } {
  let best: { width?: number; height?: number } = {};
  let area = 0;
  for (let i = find(b, 'ispe'); i !== -1 && i + 16 <= b.length; i = find(b, 'ispe', i + 4)) {
    const w = u32be(b, i + 8);
    const h = u32be(b, i + 12);
    if (w > 0 && h > 0 && w <= 100000 && h <= 100000 && w * h > area) {
      area = w * h;
      best = { width: w, height: h };
    }
  }
  return best;
}

// ------------------------------------------------------------------ ISO media (ftyp)

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heif']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
const M4V_BRANDS = new Set(['M4V ', 'M4VH', 'M4VP', 'F4V ', 'F4P ']);
const GPP_BRANDS = new Set(['3gp4', '3gp5', '3gp6', '3gp7', '3gs7', '3ge6', '3ge7', '3gg6', '3g2a', '3g2b', '3g2c']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42',
  'mp71', 'avc1', 'dash', 'MSNV', 'NDAS', 'mmp4', 'XAVC', 'cmfc', 'cmf2', 'msnv']);

// Movie length from 'mvhd', picture size from the first 'tkhd' that has one.
function isoMovie(b: Uint8Array): { width?: number; height?: number; durationMs?: number } {
  const out: { width?: number; height?: number; durationMs?: number } = {};
  const mv = find(b, 'mvhd');
  if (mv !== -1 && mv + 36 <= b.length) {
    const v1 = b[mv + 4] === 1;
    const scale = u32be(b, mv + (v1 ? 24 : 16));
    const dur = v1 ? u32be(b, mv + 28) * 0x100000000 + u32be(b, mv + 32) : u32be(b, mv + 20);
    if (scale > 0 && dur > 0 && dur !== 0xffffffff) out.durationMs = positive((dur / scale) * 1000);
  }
  for (let t = find(b, 'tkhd'); t !== -1; t = find(b, 'tkhd', t + 4)) {
    const at = t + (b[t + 4] === 1 ? 92 : 80);
    if (at + 8 > b.length) break;
    const w = Math.floor(u32be(b, at) / 65536);
    const h = Math.floor(u32be(b, at + 4) / 65536);
    if (w > 0 && h > 0) { out.width = w; out.height = h; break; }
  }
  return out;
}

function ftyp(b: Uint8Array): Sniff {
  const size = u32be(b, 0);
  const major = ascii(b, 8, 4);
  const brands = [major];
  for (let i = 16; i + 4 <= Math.min(size, b.length, 256); i += 4) brands.push(ascii(b, i, 4));
  const any = (set: Set<string>): boolean => brands.some((x) => set.has(x));
  if (any(AVIF_BRANDS)) return { kind: 'match', label: 'AVIF image', mimes: ['image/avif'], ...ispeSize(b) };
  if (HEIC_BRANDS.has(major) || any(HEIC_BRANDS)) {
    return { kind: 'match', label: 'HEIC image', mimes: ['image/heic', 'image/heif'], ...ispeSize(b) };
  }
  if (HEIF_BRANDS.has(major)) return { kind: 'match', label: 'HEIF image', mimes: ['image/heif', 'image/heic'], ...ispeSize(b) };
  if (major === 'qt  ') return { kind: 'match', label: 'QuickTime video', mimes: ['video/quicktime'], ...isoMovie(b) };
  if (M4A_BRANDS.has(major)) return { kind: 'match', label: 'M4A audio', mimes: ['audio/mp4'], ...isoMovie(b) };
  if (M4V_BRANDS.has(major)) return { kind: 'match', label: 'MP4 video', mimes: ['video/mp4'], ...isoMovie(b) };
  if (GPP_BRANDS.has(major)) return { kind: 'match', label: '3GPP media', mimes: ['video/3gpp'] };
  if (MP4_BRANDS.has(major) || any(MP4_BRANDS)) {
    return { kind: 'match', label: 'MP4 media', mimes: ['video/mp4', 'audio/mp4'], ...isoMovie(b) };
  }
  return { kind: 'unknown', reason: 'unknown_type', label: `ISO media (${major.trim()})` };
}

// ------------------------------------------------------------------ Matroska and WebM

// EBML variable-length integer at i: [value, length].
function vint(b: Uint8Array, i: number): [number, number] {
  const first = b[i];
  if (first === undefined || first === 0) return [-1, 1];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1;
  let v = first & (0xff >> len);
  for (let k = 1; k < len; k += 1) v = v * 256 + (b[i + k] ?? 0);
  return [v, len];
}

function ebml(b: Uint8Array): Sniff {
  const dt = find(b, [0x42, 0x82], 4, 64);
  let doctype = '';
  if (dt !== -1) {
    const [n, l] = vint(b, dt + 2);
    if (n > 0 && n < 32) doctype = ascii(b, dt + 2 + l, n).replace(/\0+$/, '');
  }
  if (doctype !== 'webm') {
    return { kind: 'match', label: doctype === 'matroska' ? 'Matroska video' : 'EBML media', mimes: ['video/x-matroska'] };
  }
  let durationMs: number | undefined;
  const info = find(b, [0x15, 0x49, 0xa9, 0x66]);
  if (info !== -1) {
    let scale = 1000000;
    const ts = find(b, [0x2a, 0xd7, 0xb1], info, info + 256);
    if (ts !== -1) {
      const [n, l] = vint(b, ts + 3);
      if (n > 0 && n <= 8) {
        let v = 0;
        for (let k = 0; k < n; k += 1) v = v * 256 + b[ts + 3 + l + k];
        if (v > 0) scale = v;
      }
    }
    const d = find(b, [0x44, 0x89], info, info + 256);
    if (d !== -1) {
      const [n, l] = vint(b, d + 2);
      const at = d + 2 + l;
      if ((n === 4 || n === 8) && at + n <= b.length) {
        const view = new DataView(b.buffer, b.byteOffset + at, n);
        const units = n === 4 ? view.getFloat32(0) : view.getFloat64(0);
        durationMs = positive((units * scale) / 1e6);
      }
    }
  }
  return { kind: 'match', label: 'WebM media', mimes: ['video/webm', 'audio/webm'], durationMs };
}

// ------------------------------------------------------------------ audio

function riff(b: Uint8Array): Sniff {
  const form = ascii(b, 8, 4);
  if (form === 'WEBP') return { kind: 'match', label: 'WebP image', mimes: ['image/webp'], ...webpSize(b) };
  if (form !== 'WAVE') return { kind: 'unknown', reason: 'unknown_type', label: `RIFF ${form}` };
  let byteRate = 0;
  let durationMs: number | undefined;
  for (let i = 12; i + 8 <= b.length;) {
    const id = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    if (id === 'fmt ' && i + 16 <= b.length) byteRate = u32le(b, i + 16);
    if (id === 'data') {
      if (byteRate > 0 && size !== 0xffffffff) durationMs = positive((size / byteRate) * 1000);
      break;
    }
    i += 8 + size + (size % 2);
  }
  return { kind: 'match', label: 'WAV audio', mimes: ['audio/wav'], durationMs };
}

// MPEG audio frame (MP3) or ADTS frame (AAC) at i.
function audioFrame(b: Uint8Array, i: number): Sniff | null {
  if (b[i] !== 0xff || i + 4 > b.length) return null;
  const b1 = b[i + 1];
  if ((b1 & 0xf6) === 0xf0) return { kind: 'match', label: 'AAC audio', mimes: ['audio/aac'] };
  if ((b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  const bitrate = b[i + 2] >> 4;
  const rate = (b[i + 2] >> 2) & 3;
  // Layer I (bits 11) is not used in practice, and FF FE is also a UTF-16 byte order mark.
  if (version === 1 || layer === 0 || layer === 3 || bitrate === 0 || bitrate === 15 || rate === 3) return null;
  return { kind: 'match', label: 'MP3 audio', mimes: ['audio/mpeg'] };
}

function id3(b: Uint8Array): Sniff {
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const after = 10 + size + ((b[5] & 0x10) ? 10 : 0);
  return audioFrame(b, after) ?? { kind: 'match', label: 'MP3 audio', mimes: ['audio/mpeg', 'audio/aac'] };
}

function ogg(b: Uint8Array): Sniff {
  const segments = b[26] ?? 0;
  const packet = 27 + segments;
  if (ascii(b, packet + 1, 6) === 'theora') return { kind: 'match', label: 'Ogg video', mimes: ['video/ogg'] };
  return { kind: 'match', label: 'Ogg audio', mimes: ['audio/ogg'] };
}

// ------------------------------------------------------------------ zip and Office

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

// Local file headers visible in the first bytes (Office writes its parts first).
function zipEntries(b: Uint8Array): { names: string[]; odf: string } {
  const names: string[] = [];
  let odf = '';
  for (let i = find(b, [0x50, 0x4b, 0x03, 0x04]); i !== -1 && names.length < 2000; i = find(b, [0x50, 0x4b, 0x03, 0x04], i + 4)) {
    if (i + 30 > b.length) break;
    const nameLen = u16le(b, i + 26);
    const extraLen = u16le(b, i + 28);
    if (nameLen === 0 || i + 30 + nameLen > b.length) continue;
    // Old Windows zip tools write names in a code page, not UTF-8: read those byte for
    // byte so an "invoice.exe" in one is still seen.
    const name = utf8(b.subarray(i + 30, i + 30 + nameLen)) || ascii(b, i + 30, nameLen);
    if (/[\u0000-\u001f]/.test(name)) continue;
    names.push(name);
    if (name === 'mimetype' && names.length === 1 && u16le(b, i + 8) === 0) {
      const size = u32le(b, i + 18);
      const at = i + 30 + nameLen + extraLen;
      if (size > 0 && size < 100) odf = ascii(b, at, size);
    }
  }
  return { names, odf };
}

function zip(b: Uint8Array): Sniff {
  const { names, odf } = zipEntries(b);
  const lower = names.map((n) => n.toLowerCase());
  if (lower.includes('meta-inf/manifest.mf') || lower.some((n) => n.endsWith('.class'))) {
    return { kind: 'blocked', reason: 'executable', label: 'Java program' };
  }
  if (lower.includes('androidmanifest.xml') || lower.includes('classes.dex')) {
    return { kind: 'blocked', reason: 'executable', label: 'Android app' };
  }
  if (lower.some((n) => n.endsWith('vbaproject.bin') || n.endsWith('vbadata.xml'))) {
    return { kind: 'blocked', reason: 'macro', label: 'Office document with macros' };
  }
  const inside = lower.find((n) => PROGRAM_EXT.has(n.split('/').pop()!.split('.').pop() ?? ''));
  if (inside) return { kind: 'blocked', reason: 'archive_program', label: `zip containing ${inside}` };
  const z = 'application/zip';
  if (odf === 'application/vnd.oasis.opendocument.text'
    || odf === 'application/vnd.oasis.opendocument.spreadsheet'
    || odf === 'application/vnd.oasis.opendocument.presentation') {
    return { kind: 'match', label: 'OpenDocument file', mimes: [odf, z] };
  }
  if (lower.some((n) => n.startsWith('word/'))) return { kind: 'match', label: 'Word document', mimes: [DOCX, z] };
  if (lower.some((n) => n.startsWith('xl/'))) return { kind: 'match', label: 'Excel workbook', mimes: [XLSX, z] };
  if (lower.some((n) => n.startsWith('ppt/'))) return { kind: 'match', label: 'PowerPoint deck', mimes: [PPTX, z] };
  if (lower.includes('[content_types].xml')) return { kind: 'match', label: 'Office document', mimes: [DOCX, XLSX, PPTX, z] };
  return { kind: 'match', label: 'zip file', mimes: [z] };
}

// ------------------------------------------------------------------ text

const WEB_PAGE = /^\s*<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|script[\s>]|svg[\s>]|iframe[\s>]|\?xml[^>]*>\s*<(svg|html)[\s>])/i;

function text(b: Uint8Array, truncated: boolean): Sniff {
  if (has(b, [0xff, 0xfe]) || has(b, [0xfe, 0xff])) return { kind: 'unknown', reason: 'not_utf8', label: 'UTF-16 text' };
  if (b.includes(0)) return { kind: 'unknown', reason: 'unknown_type', label: 'binary data' };
  let s: string;
  try {
    // stream: a multi-byte character cut by the 64 KB read is not an error
    s = new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: truncated });
  } catch {
    return { kind: 'unknown', reason: 'not_utf8', label: 'text that is not UTF-8' };
  }
  let control = 0;
  for (let i = 0; i < b.length; i += 1) {
    const c = b[i];
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0x1a && c !== 0x1b) control += 1;
  }
  if (control > b.length / 200) return { kind: 'unknown', reason: 'unknown_type', label: 'binary data' };
  if (WEB_PAGE.test(s.replace(/^﻿/, '').slice(0, 2048))) return { kind: 'blocked', reason: 'web_page', label: 'web page' };
  return { kind: 'match', label: 'text', mimes: ['text/plain', 'text/csv'] };
}

// ------------------------------------------------------------------ sniff and judge

export function sniff(b: Uint8Array, total: number): Sniff {
  if (total <= 0 || b.length === 0) return { kind: 'unknown', reason: 'empty', label: 'empty file' };
  const prog = program(b);
  if (prog) return { kind: 'blocked', reason: 'executable', label: prog };
  if (has(b, [0xff, 0xd8, 0xff])) {
    const j = jpegScan(b, 2);
    return { kind: 'match', label: 'JPEG image', mimes: ['image/jpeg'], width: j.width, height: j.height, jpegNext: j.next,
      ...(j.orientation === undefined ? {} : { jpegOrientation: j.orientation }) };
  }
  if (has(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const ok = ascii(b, 12, 4) === 'IHDR';
    return { kind: 'match', label: 'PNG image', mimes: ['image/png'],
      width: ok ? positive(u32be(b, 16)) : undefined, height: ok ? positive(u32be(b, 20)) : undefined };
  }
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') {
    return { kind: 'match', label: 'GIF image', mimes: ['image/gif'], width: positive(u16le(b, 6)), height: positive(u16le(b, 8)) };
  }
  if (ascii(b, 0, 4) === 'RIFF') return riff(b);
  if (ascii(b, 4, 4) === 'ftyp') return ftyp(b);
  if (has(b, [0x1a, 0x45, 0xdf, 0xa3])) return ebml(b);
  if (ascii(b, 0, 4) === 'OggS') return ogg(b);
  if (find(b, '%PDF-', 0, 1024) !== -1) return { kind: 'match', label: 'PDF document', mimes: ['application/pdf'] };
  if (has(b, [0x50, 0x4b, 0x03, 0x04]) || has(b, [0x50, 0x4b, 0x05, 0x06])) return zip(b);
  if (has(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { kind: 'match', label: 'Office 97-2003 document',
      mimes: ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'] };
  }
  if (ascii(b, 0, 3) === 'ID3') return id3(b);
  const frame = audioFrame(b, 0);
  if (frame) return frame;
  return text(b, total > b.length);
}

// The declared type picks among the types the bytes allow; a different type of the
// same family is accepted under its real name (a PNG called .jpg is still a photo).
export function judge(s: Sniff, opts: { declared: string; size: number; storedType?: string | null }): Verdict {
  const refuse = (reason: Reason): Verdict => ({ ok: false, reason, message: MESSAGES[reason] });
  if (s.kind !== 'match') return refuse(s.reason);
  const declared = canonicalMime(opts.declared);
  const want = familyOf(declared);
  const allowed = s.mimes.filter((m) => FAMILY[m]);
  if (!allowed.length) return refuse('not_allowed');
  const mime = allowed.includes(declared) ? declared : allowed.find((m) => FAMILY[m] === want);
  if (!mime) return refuse('type_mismatch');
  const family = FAMILY[mime];
  if (opts.size > maxBytes(family)) return refuse('too_large');
  if (opts.size <= 0) return refuse('empty');
  // Storage serves the bytes with the type the upload declared: only allow-listed
  // types are ever served (never text/html or image/svg+xml).
  if (!familyOf(opts.storedType)) return refuse('content_type');
  const media = family === 'image' || family === 'video';
  return {
    ok: true, mime, family,
    width: media ? s.width : undefined,
    height: media ? s.height : undefined,
    durationMs: family === 'audio' || family === 'video' ? s.durationMs : undefined,
  };
}

// A thumbnail must be a small still image served as an image.
export function thumbOk(s: Sniff, size: number, storedType: string | null | undefined): boolean {
  return s.kind === 'match'
    && s.mimes.some((m) => m === 'image/webp' || m === 'image/jpeg' || m === 'image/png')
    && size > 0 && size <= THUMB_MAX_BYTES
    && familyOf(storedType) === 'image';
}
