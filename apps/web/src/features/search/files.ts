// How file results are labelled: a kind from the MIME type (with its icon) and a
// human size.
import type { IconName } from '../../ui/icons';

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

export function fileKind(mime: string | null | undefined): FileKind {
  const m = (mime ?? '').toLowerCase().trim();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  return 'file';
}

const ICONS: Record<FileKind, IconName> = { image: 'image', video: 'video', audio: 'headphones', pdf: 'file', file: 'file' };
const LABELS: Record<FileKind, string> = { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', file: 'File' };

export function fileIcon(kind: FileKind): IconName {
  return ICONS[kind];
}

export function fileKindLabel(kind: FileKind): string {
  return LABELS[kind];
}

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

// 0 B, 812 B, 1.5 KB, 25 MB, 1.2 GB. One decimal below 10, whole numbers above.
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes / 1024;
  let i = 0;
  // Round up a unit early so 1023.9 KB reads as 1.0 MB, not 1024 KB.
  while (v >= 1023.5 && i < UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 9.95 ? v.toFixed(1) : String(Math.round(v))} ${UNITS[i]}`;
}
