// Profile picture: crop to a square, resize to 256 px in a canvas, save as WebP
// (JPEG where the browser cannot write WebP, which is Safari), upload to the public
// avatars bucket at <user id>/<random>.<ext>. The math is pure and unit tested;
// the canvas and storage parts run in the browser only.
import { DekError } from '../../api/errors';
import { supabase } from '../../api/client';

export const AVATAR_PX = 256;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

// x and y: where the image's top left corner sits inside the square viewport
// (0 or negative: the image always covers the whole square).
export interface CropState {
  zoom: number;
  x: number;
  y: number;
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : MIN_ZOOM));
}

// Scale at zoom 1: the short side fills the viewport.
export function coverScale(w: number, h: number, view: number): number {
  return view / Math.min(w, h);
}

export function clampOffset(w: number, h: number, view: number, zoom: number, x: number, y: number): { x: number; y: number } {
  const s = coverScale(w, h, view) * clampZoom(zoom);
  const minX = view - w * s;
  const minY = view - h * s;
  return { x: Math.min(0, Math.max(minX, x)), y: Math.min(0, Math.max(minY, y)) };
}

export function centered(w: number, h: number, view: number, zoom = 1): CropState {
  const z = clampZoom(zoom);
  const s = coverScale(w, h, view) * z;
  return { zoom: z, x: (view - w * s) / 2, y: (view - h * s) / 2 };
}

// Zoom around the middle of the viewport, so what is in the middle stays there.
export function zoomTo(w: number, h: number, view: number, prev: CropState, nextZoom: number): CropState {
  const z = clampZoom(nextZoom);
  const base = coverScale(w, h, view);
  const s0 = base * prev.zoom;
  const s1 = base * z;
  const c = view / 2;
  const ix = (c - prev.x) / s0;
  const iy = (c - prev.y) / s0;
  return { zoom: z, ...clampOffset(w, h, view, z, c - ix * s1, c - iy * s1) };
}

export function panBy(w: number, h: number, view: number, prev: CropState, dx: number, dy: number): CropState {
  return { zoom: prev.zoom, ...clampOffset(w, h, view, prev.zoom, prev.x + dx, prev.y + dy) };
}

// The square of the original picture that is visible.
export function sourceRect(w: number, h: number, view: number, st: CropState): { sx: number; sy: number; size: number } {
  const s = coverScale(w, h, view) * clampZoom(st.zoom);
  const size = Math.min(view / s, w, h);
  const sx = Math.min(Math.max(0, -st.x / s), w - size);
  const sy = Math.min(Math.max(0, -st.y / s), h - size);
  return { sx, sy, size };
}

export function checkPicture(file: Pick<File, 'type' | 'size'>): string | null {
  if (!file.type.startsWith('image/')) return 'Pick a picture (JPEG, PNG, WebP or GIF).';
  if (file.size > MAX_SOURCE_BYTES) return 'That picture is larger than 20 MB. Pick a smaller one.';
  return null;
}

export interface LoadedPicture {
  image: HTMLImageElement;
  width: number;
  height: number;
  url: string;
  release: () => void;
}

export async function loadPicture(file: File): Promise<LoadedPicture> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new DekError('invalid_input', 'This picture cannot be opened here. Try a JPEG or PNG.');
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new DekError('invalid_input', 'This picture is empty.');
  }
  return { image, width: image.naturalWidth, height: image.naturalHeight, url, release: () => URL.revokeObjectURL(url) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export interface RenderedAvatar {
  blob: Blob;
  ext: 'webp' | 'jpg';
  type: 'image/webp' | 'image/jpeg';
}

export async function renderAvatar(image: CanvasImageSource, rect: { sx: number; sy: number; size: number }, px = AVATAR_PX): Promise<RenderedAvatar> {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new DekError('unknown', 'This browser cannot prepare pictures.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, rect.sx, rect.sy, rect.size, rect.size, 0, 0, px, px);
  const webp = await toBlob(canvas, 'image/webp', 0.86);
  if (webp && webp.type === 'image/webp') return { blob: webp, ext: 'webp', type: 'image/webp' };
  // Safari writes PNG when asked for WebP: use JPEG on a white background instead.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  const jpg = await toBlob(canvas, 'image/jpeg', 0.88);
  if (jpg) return { blob: jpg, ext: 'jpg', type: 'image/jpeg' };
  throw new DekError('unknown', 'This browser could not save the picture.');
}

function randomName(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function avatarPath(userId: string, ext: string): string {
  return `${userId}/${randomName()}.${ext}`;
}

interface StorageErrorLike { message?: string; statusCode?: string | number; status?: number; name?: string }

function storageError(e: StorageErrorLike | null | undefined): DekError {
  const status = Number(e?.statusCode ?? e?.status ?? 0);
  const msg = String(e?.message ?? '');
  if (status === 401) return new DekError('auth_required', null, status);
  if (status === 403) return new DekError('forbidden', 'Pictures can only go into your own folder.', status);
  if (status === 413 || /too large|maximum allowed size/i.test(msg)) return new DekError('invalid_input', 'The picture is too large.', status);
  if (status === 415 || /mime type/i.test(msg)) return new DekError('invalid_input', 'That picture type is not allowed.', status);
  if (status >= 500) return new DekError('server', 'The upload service had a problem. Try again.', status);
  if (!status || /fetch|network/i.test(msg)) return new DekError('network', 'The upload did not reach the server. Check the connection and try again.', null);
  return new DekError('unknown', msg || 'The upload failed.', status);
}

export async function uploadAvatar(userId: string, pic: RenderedAvatar): Promise<string> {
  const path = avatarPath(userId, pic.ext);
  let res: { error: StorageErrorLike | null };
  try {
    res = await supabase().storage.from('avatars').upload(path, pic.blob, { contentType: pic.type, upsert: false, cacheControl: '31536000' });
  } catch (e) {
    throw storageError(e as StorageErrorLike);
  }
  if (res.error) throw storageError(res.error);
  return path;
}

// Best effort: an old picture nobody points at any more.
export async function removeAvatarObject(userId: string, path: string | null | undefined): Promise<void> {
  if (!path || !path.startsWith(`${userId}/`)) return;
  try {
    await supabase().storage.from('avatars').remove([path]);
  } catch {
    // an orphaned picture costs a few kilobytes; never block the profile on it
  }
}
