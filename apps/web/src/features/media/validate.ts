// What Dek accepts, decided before a file is read (CONTRACT 2.7, the same lists
// api.begin_upload and media-finalize enforce in 0400_media_uploads.sql), and a
// look at the first bytes so a program renamed photo.jpg is refused here with a
// clear sentence instead of after an upload. The server stays the authority: this
// only gives faster, kinder answers.

export type MediaFamily = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'office' | 'archive';

export const MB = 1024 * 1024;
export const VIDEO_MAX_BYTES = 100 * MB;
export const FILE_MAX_BYTES = 25 * MB;
// send_message refuses more than 10 attachment ids (0210_messages.sql).
export const MAX_ATTACHMENTS = 10;
// How many leading bytes the content check reads (enough for a PE header offset).
export const SNIFF_BYTES = 4096;

const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png',
  'image/heic-sequence': 'image/heic', 'image/heif-sequence': 'image/heif',
  'video/x-m4v': 'video/mp4',
  'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/mpeg3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg',
  'audio/mpg': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/x-mp4': 'audio/mp4',
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'audio/x-pn-wav': 'audio/wav',
  'audio/x-aac': 'audio/aac', 'audio/aacp': 'audio/aac',
  'application/x-pdf': 'application/pdf',
  'text/x-csv': 'text/csv', 'application/csv': 'text/csv', 'text/comma-separated-values': 'text/csv',
  'application/x-zip-compressed': 'application/zip', 'application/x-zip': 'application/zip', 'multipart/x-zip': 'application/zip',
};

const FAMILIES: Record<string, MediaFamily> = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'image/heic': 'image', 'image/heif': 'image', 'image/avif': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/ogg': 'audio', 'audio/webm': 'audio', 'audio/wav': 'audio', 'audio/aac': 'audio',
  'application/pdf': 'pdf',
  'text/plain': 'text', 'text/csv': 'text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'office',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'office',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'office',
  'application/msword': 'office', 'application/vnd.ms-excel': 'office', 'application/vnd.ms-powerpoint': 'office',
  'application/vnd.oasis.opendocument.text': 'office', 'application/vnd.oasis.opendocument.spreadsheet': 'office',
  'application/vnd.oasis.opendocument.presentation': 'office',
  'application/zip': 'archive',
};

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', zip: 'application/zip',
};

// Programs, scripts, installers, disk images, web pages and macro documents
// (dek.media_blocked_ext). Malware scanning is not available on this stack, so
// these never get in at all.
const BLOCKED_EXT = new Set([
  'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'msp', 'mst', 'scr', 'pif', 'cpl', 'msc', 'sys', 'drv', 'ocx',
  'jar', 'class', 'js', 'jse', 'mjs', 'cjs', 'vbs', 'vbe', 'vb', 'wsf', 'wsh', 'ws', 'wsc', 'sct',
  'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psm1', 'psd1',
  'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'command', 'tool', 'run', 'bin', 'elf', 'so', 'dylib', 'out',
  'app', 'apk', 'aab', 'xapk', 'ipa', 'xap', 'appx', 'appxbundle', 'msix', 'msixbundle',
  'dmg', 'pkg', 'mpkg', 'deb', 'rpm', 'snap', 'flatpak', 'appimage',
  'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pl', 'pm', 'rb', 'php', 'phtml', 'php3', 'php4', 'php5', 'phar',
  'asp', 'aspx', 'jsp', 'cgi', 'lua', 'tcl', 'awk',
  'html', 'htm', 'xhtml', 'shtml', 'xht', 'mht', 'mhtml', 'hta', 'svg', 'svgz', 'xsl', 'xslt',
  'lnk', 'url', 'scf', 'reg', 'inf', 'ins', 'isp', 'gadget', 'application', 'appref-ms', 'chm', 'hlp',
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'xla', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
  'iso', 'img', 'vhd', 'vhdx', 'vmdk', 'swf', 'wasm',
]);

const BLOCKED_MIME = new Set([
  'application/x-msdos-program', 'application/x-msi', 'application/x-ms-installer',
  'application/x-dosexec', 'application/x-elf', 'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable', 'application/x-sh', 'application/x-csh',
  'application/x-bat', 'application/x-msdos-batch', 'application/hta',
  'application/java-archive', 'application/x-java-archive', 'application/java-vm',
  'application/vnd.android.package-archive', 'application/x-apple-diskimage',
  'application/x-python', 'application/x-python-code', 'text/x-python', 'application/x-perl', 'text/x-perl',
  'application/x-php', 'application/x-httpd-php', 'text/x-php', 'application/x-ruby', 'text/x-ruby',
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/x-shockwave-flash',
  'application/wasm', 'application/x-iso9660-image', 'application/x-ms-shortcut',
]);
const BLOCKED_MIME_PARTS = ['macroenabled', 'javascript', 'ecmascript', 'shellscript', 'executable', 'msdownload'];

// The file input's accept list: a hint for pickers, never the check itself.
export const ACCEPT = [
  'image/*', 'video/*', 'audio/*', '.pdf', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.zip', '.heic', '.heif',
].join(',');

// Control and bidirectional override characters, which can make
// "photo<RLO>gpj.exe" display as "photoexe.jpg" (dek.media_display_name).
const HIDDEN_CHARS = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

export function cleanName(name: string): string {
  return name.replace(HIDDEN_CHARS, '').replace(/^.*[/\\]/, '').trim();
}

export function extensionOf(name: string): string | null {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(cleanName(name));
  return m ? m[1]!.toLowerCase() : null;
}

export function canonicalMime(mime: string | null | undefined): string {
  const m = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return ALIASES[m] ?? m;
}

export function familyOf(mime: string): MediaFamily | null {
  return FAMILIES[canonicalMime(mime)] ?? null;
}

export function maxBytesFor(family: MediaFamily): number {
  return family === 'video' ? VIDEO_MAX_BYTES : FILE_MAX_BYTES;
}

export function isBlockedMime(mime: string): boolean {
  const m = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return BLOCKED_MIME.has(m) || BLOCKED_MIME_PARTS.some((p) => m.includes(p));
}

// The type the server will record: the browser's when it named one, the
// extension's when it did not, with Excel's habit of calling .csv a spreadsheet undone.
export function resolveMime(name: string, declared: string): string {
  const ext = extensionOf(name);
  let mime = canonicalMime(declared);
  if (mime === '' || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    mime = (ext && EXT_MIME[ext]) || mime;
  }
  if (ext === 'csv' && (mime === 'application/vnd.ms-excel' || mime === 'text/plain')) mime = 'text/csv';
  return mime;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} bytes`;
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / MB;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export type RefusalReason = 'blocked' | 'unsupported' | 'too_large' | 'empty' | 'unnamed';

export interface Accepted {
  ok: true;
  mime: string;
  family: MediaFamily;
  maxBytes: number;
}

export interface Refused {
  ok: false;
  reason: RefusalReason;
  message: string;
}

export type Validation = Accepted | Refused;

const KINDS_SENTENCE = 'Dek takes photos, videos, audio, PDF, text, CSV, Office documents and zip files.';

function refuse(reason: RefusalReason, message: string): Refused {
  return { ok: false, reason, message };
}

// Name, type and size only: nothing here reads the file (LESSONS: reject over-size
// files before reading them).
export function validateFile(f: { name: string; type: string; size: number }): Validation {
  const name = cleanName(f.name ?? '');
  if (!name) return refuse('unnamed', 'This file has no name, so it cannot be shared.');
  const ext = extensionOf(name);
  if ((ext && BLOCKED_EXT.has(ext)) || isBlockedMime(f.type)) {
    return refuse('blocked', `${name} is a program, script or web page. Dek does not accept those, because they can harm the people who open them.`);
  }
  const mime = resolveMime(name, f.type);
  const family = familyOf(mime);
  if (!family) return refuse('unsupported', `${name} cannot be shared. ${KINDS_SENTENCE}`);
  if (!Number.isFinite(f.size) || f.size < 1) return refuse('empty', `${name} is empty.`);
  const maxBytes = maxBytesFor(family);
  if (f.size > maxBytes) {
    return refuse('too_large', `${name} is ${formatBytes(f.size)}. ${family === 'video' ? 'Videos' : 'Files like this'} can be up to ${maxBytes / MB} MB.`);
  }
  return { ok: true, mime, family, maxBytes };
}

// ------------------------------------------------------------------ content

export type Sniffed =
  | { kind: 'program'; label: string }
  | { kind: 'script' }
  | { kind: 'webpage' }
  | { kind: 'image'; mime: string }
  | { kind: 'video'; mime: string }
  | { kind: 'pdf' }
  | { kind: 'zip' }
  | { kind: 'ole' }
  | { kind: 'unknown' };

const ascii = (b: Uint8Array, from: number, to: number) => {
  let s = '';
  for (let i = from; i < Math.min(to, b.length); i += 1) s += String.fromCharCode(b[i]!);
  return s;
};

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'miaf', 'MiHE', 'MiHA', 'MiHB']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function isPe(b: Uint8Array): boolean {
  if (b.length < 0x40) return false;
  const off = (b[0x3c]! | (b[0x3d]! << 8) | (b[0x3e]! << 16)) >>> 0;
  return off > 0 && off + 4 <= b.length && startsWith(b, [0x50, 0x45, 0x00, 0x00], off);
}

// What the leading bytes say the file really is.
export function sniffBytes(b: Uint8Array): Sniffed {
  if (b.length === 0) return { kind: 'unknown' };
  if (startsWith(b, [0x4d, 0x5a])) return isPe(b) ? { kind: 'program', label: 'a Windows program' } : { kind: 'program', label: 'a DOS program' };
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return { kind: 'program', label: 'a Linux program' };
  if (startsWith(b, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(b, [0xfe, 0xed, 0xfa, 0xcf])
    || startsWith(b, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xcf, 0xfa, 0xed, 0xfe])
    || startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) return { kind: 'program', label: 'a Mac or Java program' };
  if (startsWith(b, [0x00, 0x61, 0x73, 0x6d])) return { kind: 'program', label: 'a WebAssembly program' };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png' };
  const head6 = ascii(b, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { kind: 'image', mime: 'image/gif' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (HEIC_BRANDS.has(brand)) return { kind: 'image', mime: 'image/heic' };
    if (AVIF_BRANDS.has(brand)) return { kind: 'image', mime: 'image/avif' };
    if (HEIF_BRANDS.has(brand)) return { kind: 'image', mime: 'image/heif' };
    return { kind: 'video', mime: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4' };
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', mime: 'video/webm' };
  if (ascii(b, 0, 5) === '%PDF-') return { kind: 'pdf' };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return { kind: 'zip' };
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { kind: 'ole' };
  // Text-like: skip a UTF-8 byte order mark and leading white space.
  let i = startsWith(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i += 1;
  const text = ascii(b, i, i + 64).toLowerCase();
  if (text.startsWith('#!')) return { kind: 'script' };
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<script') || text.startsWith('<svg')
    || (text.startsWith('<?xml') && ascii(b, i, Math.min(b.length, 1024)).toLowerCase().includes('<svg'))) {
    return { kind: 'webpage' };
  }
  return { kind: 'unknown' };
}

const FAMILY_WORD: Record<MediaFamily, string> = {
  image: 'a photo', video: 'a video', audio: 'audio', pdf: 'a PDF', text: 'a text file', office: 'a document', archive: 'a zip file',
};

// The final word before upload: the name passed, now the bytes must agree.
// Programs, scripts and web pages are refused whatever they are called; a photo
// saved with the wrong extension is uploaded under its real type.
export function checkContent(name: string, accepted: Accepted, sniffed: Sniffed): Validation {
  const shown = cleanName(name);
  if (sniffed.kind === 'program') {
    return refuse('blocked', `${shown} is really ${sniffed.label} disguised as ${FAMILY_WORD[accepted.family]}. Dek does not accept programs.`);
  }
  if (sniffed.kind === 'script') {
    return refuse('blocked', `${shown} is really a script disguised as ${FAMILY_WORD[accepted.family]}. Dek does not accept scripts.`);
  }
  if (sniffed.kind === 'webpage') {
    return refuse('blocked', `${shown} is really a web page disguised as ${FAMILY_WORD[accepted.family]}. Dek does not accept web pages.`);
  }
  if (accepted.family === 'image') {
    if (sniffed.kind === 'image') return { ...accepted, mime: sniffed.mime };
    const container = sniffed.kind === 'video' && /^image\/(heic|heif|avif)$/.test(accepted.mime);
    if (!container) return refuse('unsupported', `${shown} is not a photo Dek can read. It may be another kind of file renamed.`);
  }
  return accepted;
}
