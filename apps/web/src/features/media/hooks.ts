// The browser wiring of the upload machine and the signed URL cache: real
// dependencies, one instance each per page, and the hooks components use. Both are
// wiped when the signed-in person changes (shared phones, LESSONS).
import { useCallback, useEffect, useMemo, useReducer, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { supabase } from '../../api/client';
import { api } from '../../api/rpc';
import { useDek } from '../../store';
import { toast } from '../../ui/kit';
import { abortError, prepareFile } from './prepare';
import { SignedUrlCache, supabaseMinter } from './signedUrls';
import { accessToken, finalizeUpload, putObject } from './transfer';
import { Uploader, type UploadDeps, type UploadItem } from './uploads';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const browserDeps: UploadDeps = {
  readHead: async (file, bytes) => new Uint8Array(await file.slice(0, bytes).arrayBuffer()),
  prepare: (file, name, mime, family, signal) => prepareFile(file, name, mime, family, signal),
  beginUpload: (channelId, name, mime, size, withThumb) => api.beginUpload(channelId, name, mime, size, withThumb),
  abortUpload: (attachmentId) => api.abortUpload(attachmentId),
  put: async (path, blob, contentType, onProgress, signal) =>
    putObject(path, blob, contentType, { token: await accessToken(), onProgress, signal }),
  finalize: (attachmentId, meta) => finalizeUpload(attachmentId, meta),
  previewUrl: (file, family) => (family === 'image' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null),
  revokeUrl: (url) => {
    try { URL.revokeObjectURL(url); } catch { /* already released */ }
  },
  sleep,
  newId: () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `u${Date.now()}${Math.random()}`),
  notify: (message) => { toast({ kind: 'error', title: 'Some files were not added', body: message }); },
};

export const uploader = new Uploader(browserDeps);
export const urlCache = new SignedUrlCache({ mint: supabaseMinter(() => supabase()) });

// One subscription for the page: a different person (or nobody) means wipe.
let lastUser: string | null | undefined;
useDek.subscribe((s) => {
  const user = s.session.status === 'signed_in' ? s.session.userId : null;
  if (lastUser !== undefined && user !== lastUser) {
    uploader.reset();
    urlCache.clear();
  }
  lastUser = user;
});

const EMPTY: UploadItem[] = [];

export interface UploadsApi {
  items: UploadItem[];
  readyIds: string[];
  busy: boolean;
  add: (files: File[]) => void;
  remove: (localId: string) => void;
  retry: (localId: string) => void;
  clear: () => void;
}

export function useUploads(key: string, channelId?: string): UploadsApi {
  const items = useStore(uploader.store, (s) => s.byKey[key] ?? EMPTY);
  const readyIds = useMemo(
    () => items.filter((i) => i.status === 'ready' && i.attachmentId).map((i) => i.attachmentId as string),
    [items],
  );
  const busy = useMemo(() => items.some((i) => i.status === 'preparing' || i.status === 'uploading' || i.status === 'finalizing'), [items]);
  const add = useCallback((files: File[]) => { uploader.add(key, files, channelId); }, [key, channelId]);
  const remove = useCallback((localId: string) => uploader.remove(key, localId), [key]);
  const retry = useCallback((localId: string) => uploader.retry(key, localId), [key]);
  const clear = useCallback(() => uploader.clear(key), [key]);
  return { items, readyIds, busy, add, remove, retry, clear };
}

// ------------------------------------------------------------------ signed URLs

function useUrlCacheVersion(): number {
  return useSyncExternalStore(
    (cb) => urlCache.subscribe(cb),
    () => urlCache.getVersion(),
    () => 0,
  );
}

const REFRESH_TICK_MS = 30_000;

// URLs for media elements: the last minted URL per path (even near expiry, so a
// loaded image is not downloaded again), requested in one batch per render sweep.
export function useMediaUrls(paths: (string | null | undefined)[]): Record<string, string | null> {
  useUrlCacheVersion();
  const key = paths.filter(Boolean).join('|');
  useEffect(() => {
    if (key) urlCache.request(key.split('|'));
  }, [key]);
  const out: Record<string, string | null> = {};
  for (const p of paths) if (p) out[p] = urlCache.current(p);
  return out;
}

// URLs for links people tap later (download, open): kept fresh while on screen.
export function useFreshUrls(paths: (string | null | undefined)[]): Record<string, string | null> {
  useUrlCacheVersion();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const key = paths.filter(Boolean).join('|');
  useEffect(() => {
    if (!key) return undefined;
    const list = key.split('|');
    urlCache.request(list);
    const t = setInterval(() => {
      if (urlCache.hasStale(list)) {
        urlCache.request(list);
        tick();
      }
    }, REFRESH_TICK_MS);
    return () => clearInterval(t);
  }, [key]);
  const out: Record<string, string | null> = {};
  for (const p of paths) if (p) out[p] = urlCache.peek(p) ?? urlCache.current(p);
  return out;
}

export function mediaFailed(path: string): boolean {
  return urlCache.failed(path);
}
