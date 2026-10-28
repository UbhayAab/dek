// Pure layout decisions for attachments: which group each file belongs to, the
// box an image or video reserves before it loads, and the labels people read.
// Width and height come from whoever uploaded the file, so they are validated as
// numbers and clamped before they reach a style (LESSONS: a raw number in a style
// attribute was an XSS in the legacy app).
import type { Attachment } from '../../api/types';
import { canonicalMime, familyOf } from './validate';

export const SINGLE_MAX_W = 360;
export const SINGLE_MAX_H = 360;
export const GRID_MAX = 4;

export interface Groups {
  images: Attachment[];
  videos: Attachment[];
  audio: Attachment[];
  files: Attachment[];
  pending: Attachment[];
  rejected: Attachment[];
}

const BROWSER_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

export function groupAttachments(list: readonly Attachment[]): Groups {
  const g: Groups = { images: [], videos: [], audio: [], files: [], pending: [], rejected: [] };
  for (const a of list) {
    if (a.status === 'pending') { g.pending.push(a); continue; }
    if (a.status === 'rejected') { g.rejected.push(a); continue; }
    const mime = canonicalMime(a.mime_type);
    const fam = familyOf(mime);
    // HEIC that was not converted cannot be shown by most browsers: offer it as a file.
    if (fam === 'image' && (BROWSER_IMAGES.has(mime) || a.thumb_path)) g.images.push(a);
    else if (fam === 'video') g.videos.push(a);
    else if (fam === 'audio') g.audio.push(a);
    else g.files.push(a);
  }
  return g;
}

export function dimension(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n >= 1 && n <= 100_000 ? Math.round(n) : null;
}

// Width over height, clamped so a panorama or a long screenshot keeps a sane box.
export function aspectRatio(width: unknown, height: unknown, fallback = 4 / 3): number {
  const w = dimension(width);
  const h = dimension(height);
  const r = w && h ? w / h : fallback;
  return Math.min(2.5, Math.max(0.4, r));
}

// The photo's own shape for the full-size viewer (null when unknown), rounded and
// bounded so it is always a plain finite number.
export function exactRatio(width: unknown, height: unknown): number | null {
  const w = dimension(width);
  const h = dimension(height);
  if (!w || !h) return null;
  return Math.round(Math.min(20, Math.max(0.05, w / h)) * 10_000) / 10_000;
}

// The reserved box of a lone image or video: the true ratio inside 360 x 360.
export function singleBox(width: unknown, height: unknown): { width: number; ratio: number } {
  const ratio = aspectRatio(width, height);
  return { width: Math.round(Math.min(SINGLE_MAX_W, SINGLE_MAX_H * ratio)), ratio };
}

export function isVoiceNote(a: Pick<Attachment, 'file_name' | 'mime_type'>): boolean {
  return /^voice[-_ ]?(note|message|memo)/i.test(a.file_name) && a.mime_type.startsWith('audio/');
}

export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const TYPE_LABELS: [RegExp, string][] = [
  [/^application\/pdf$/, 'PDF'],
  [/wordprocessing|msword|opendocument\.text/, 'Document'],
  [/spreadsheet|ms-excel/, 'Spreadsheet'],
  [/presentation|powerpoint/, 'Presentation'],
  [/^text\/csv$/, 'CSV'],
  [/^text\//, 'Text'],
  [/zip/, 'Zip archive'],
  [/^image\//, 'Image'],
  [/^video\//, 'Video'],
  [/^audio\//, 'Audio'],
];

export function typeLabel(mime: string): string {
  const m = canonicalMime(mime);
  for (const [re, label] of TYPE_LABELS) if (re.test(m)) return label;
  return 'File';
}

export function isPdf(mime: string): boolean {
  return canonicalMime(mime) === 'application/pdf';
}
