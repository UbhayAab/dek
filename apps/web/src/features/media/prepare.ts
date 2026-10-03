// Getting a file ready in the browser before it is sent: big photos downscaled,
// a 640 px webp thumbnail for photos and a poster frame for videos, and the
// width, height and duration probed so the message can reserve its space before
// a single byte arrives. Every step here is an optimisation: a failure falls back
// to the original file and never fails the upload (LESSONS, Media). Only an abort
// (the person removed the file) propagates.
import type { MediaFamily } from './validate';

export const DOWNSCALE_MIN_BYTES = 400 * 1024;
export const MAX_EDGE = 1600;
export const THUMB_EDGE = 640;
export const QUALITY = 0.82;
export const THUMB_QUALITY = 0.8;
const PROBE_TIMEOUT_MS = 8000;

export interface Prepared {
  blob: Blob;
  name: string;
  mime: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumb: Blob | null;
}

export function abortError(): DOMException {
  return new DOMException('The upload was cancelled.', 'AbortError');
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

const EXT_FOR: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// photo.HEIC converted to JPEG is sent as photo.jpg, so the name tells the truth.
export function renameFor(name: string, mime: string): string {
  const ext = EXT_FOR[mime];
  if (!ext) return name;
  const base = name.replace(/\.[A-Za-z0-9]{1,10}$/, '');
  if (mime === 'image/jpeg' && /\.(jpe?g|jfif)$/i.test(name)) return name;
  return `${base || 'image'}.${ext}`;
}

function scaled(w: number, h: number, edge: number): { w: number; h: number } {
  const s = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// Draws a source into a canvas of the given size and encodes it. OffscreenCanvas
// where it exists, a detached DOM canvas otherwise. JPEG gets a white ground so a
// transparent source does not turn black.
export async function encodeImage(src: CanvasImageSource, w: number, h: number, type: string, quality: number): Promise<Blob | null> {
  const paint = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(src, 0, 0, w, h);
  };
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (ctx) {
        paint(ctx);
        return await c.convertToBlob({ type, quality });
      }
    } catch {
      // fall through to a DOM canvas
    }
  }
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  paint(ctx);
  return await new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality));
}

async function prepareImage(file: Blob, name: string, mime: string, signal?: AbortSignal): Promise<Prepared> {
  const base: Prepared = { blob: file, name, mime, width: null, height: null, durationMs: null, thumb: null };
  if (typeof createImageBitmap !== 'function') return base;
  let bmp: ImageBitmap;
  try {
    // from-image applies the EXIF orientation, so a phone photo is not sideways.
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return base;   // a format this browser cannot decode (HEIC outside Safari): send as is
  }
  try {
    throwIfAborted(signal);
    const width = bmp.width;
    const height = bmp.height;
    let out: Prepared = { ...base, width, height };
    const gif = mime === 'image/gif';
    // HEIC and HEIF are converted whatever their size: most browsers cannot show them.
    const convert = mime === 'image/heic' || mime === 'image/heif';
    if (!gif && (file.size >= DOWNSCALE_MIN_BYTES || convert)) {
      const t = scaled(width, height, MAX_EDGE);
      const type = mime === 'image/png' ? 'image/png' : mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
      const blob = await encodeImage(bmp, t.w, t.h, type, QUALITY);
      throwIfAborted(signal);
      // Keep the original when the result is not smaller (a small screenshot).
      if (blob && blob.type === type && (blob.size < file.size || convert)) {
        out = { ...out, blob, mime: type, name: renameFor(name, type), width: t.w, height: t.h };
      }
    }
    if (!gif && Math.max(width, height) > THUMB_EDGE) {
      const t = scaled(width, height, THUMB_EDGE);
      const thumb = await encodeImage(bmp, t.w, t.h, 'image/webp', THUMB_QUALITY).catch(() => null);
      throwIfAborted(signal);
      // Browsers that cannot encode webp hand back a PNG: no thumbnail then.
      if (thumb && thumb.type === 'image/webp') out = { ...out, thumb };
    }
    return out;
  } catch (e) {
    if (isAbort(e)) throw e;
    return base;
  } finally {
    bmp.close();
  }
}

interface ProbeResult {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  poster: Blob | null;
}

function finiteMs(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

// Width, height, duration and a poster frame from a video, without playing it.
function probeVideo(file: Blob, signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve({ width: null, height: null, durationMs: null, poster: null });
      return;
    }
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const meta: ProbeResult = { width: null, height: null, durationMs: null, poster: null };
    let done = false;
    const finish = (poster: Blob | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      v.removeAttribute('src');
      try { v.load(); } catch { /* released either way */ }
      URL.revokeObjectURL(url);
      resolve({ ...meta, poster });
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    const grab = async () => {
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return finish(null);
      const t = scaled(w, h, THUMB_EDGE);
      const poster = await encodeImage(v, t.w, t.h, 'image/webp', THUMB_QUALITY).catch(() => null);
      finish(poster && poster.type === 'image/webp' ? poster : null);
    };
    v.onloadedmetadata = () => {
      meta.width = v.videoWidth || null;
      meta.height = v.videoHeight || null;
      meta.durationMs = finiteMs(v.duration);
      const at = Number.isFinite(v.duration) && v.duration > 0.2 ? Math.min(1, v.duration / 3) : 0;
      if (at > 0) {
        v.onseeked = () => { void grab(); };
        try { v.currentTime = at; } catch { finish(null); }
      } else if (v.readyState >= 2) {
        void grab();
      } else {
        v.onloadeddata = () => { void grab(); };
      }
    };
    v.onerror = () => finish(null);
    v.src = url;
  });
}

// Duration of an audio file. Recordings made by MediaRecorder report an infinite
// duration until the element is asked to seek past the end.
function probeAudio(file: Blob, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('audio');
    a.preload = 'metadata';
    let done = false;
    const finish = (ms: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      a.removeAttribute('src');
      try { a.load(); } catch { /* released either way */ }
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration)) return finish(finiteMs(a.duration));
      a.ondurationchange = () => { if (Number.isFinite(a.duration)) finish(finiteMs(a.duration)); };
      try { a.currentTime = 1e7; } catch { finish(null); }
    };
    a.onerror = () => finish(null);
    a.src = url;
  });
}

export async function prepareFile(file: Blob, name: string, mime: string, family: MediaFamily, signal?: AbortSignal): Promise<Prepared> {
  throwIfAborted(signal);
  const base: Prepared = { blob: file, name, mime, width: null, height: null, durationMs: null, thumb: null };
  try {
    if (family === 'image') return await prepareImage(file, name, mime, signal);
    if (family === 'video') {
      const p = await probeVideo(file, signal);
      throwIfAborted(signal);
      return { ...base, width: p.width, height: p.height, durationMs: p.durationMs, thumb: p.poster };
    }
    if (family === 'audio') {
      const ms = await probeAudio(file, signal);
      throwIfAborted(signal);
      return { ...base, durationMs: ms };
    }
  } catch (e) {
    if (isAbort(e)) throw e;
  }
  return base;
}
