import { describe, expect, test } from 'vitest';
import { DekError } from '../../src/api/errors';
import type { UploadTicket } from '../../src/api/types';
import { TransferError, type FinalizeResult } from '../../src/features/media/transfer';
import { Uploader, uploadType, type UploadDeps, type UploadItem } from '../../src/features/media/uploads';
import { MB } from '../../src/features/media/validate';

const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PE_HEAD = (() => {
  const b = new Uint8Array(256);
  b[0] = 0x4d; b[1] = 0x5a; b[0x3c] = 0x80;
  b.set([0x50, 0x45, 0, 0], 0x80);
  return b;
})();

const heads = new WeakMap<Blob, Uint8Array>();
function file(name: string, type: string, head: Uint8Array = JPEG_HEAD, size = 2048): File {
  const f = new File([new Uint8Array(size)], name, { type });
  heads.set(f, head);
  return f;
}

interface Calls {
  begin: { channel: string; name: string; mime: string; size: number; withThumb: boolean }[];
  abort: string[];
  put: string[];
  types: string[];
  finalize: { id: string; meta: unknown }[];
  notify: string[];
  heads: number;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(over: Partial<UploadDeps> = {}, concurrency = 2) {
  const calls: Calls = { begin: [], abort: [], put: [], types: [], finalize: [], notify: [], heads: 0 };
  let n = 0;
  let ids = 0;
  const deps: UploadDeps = {
    readHead: async (f) => { calls.heads += 1; return heads.get(f) ?? new Uint8Array(); },
    prepare: async (f, name, mime) => ({
      blob: f, name, mime, width: 800, height: 600, durationMs: null,
      thumb: mime.startsWith('image/') ? new Blob(['thumb'], { type: 'image/webp' }) : null,
    }),
    beginUpload: async (channel, name, mime, size, withThumb): Promise<UploadTicket> => {
      calls.begin.push({ channel, name, mime, size, withThumb });
      n += 1;
      const id = `att-${n}`;
      // the server records the canonical type (parameters dropped, csv named csv)
      const recorded = mime.split(';')[0]!.trim() === 'application/vnd.ms-excel' && name.endsWith('.csv') ? 'text/csv' : mime.split(';')[0]!.trim();
      return { attachment_id: id, bucket: 'media', path: `org/${channel}/${id}/${name}`, thumb_path: withThumb ? `org/${channel}/${id}/thumb.webp` : null, max_bytes: 25 * MB, mime: recorded };
    },
    abortUpload: async (id) => { calls.abort.push(id); return { aborted: true }; },
    put: async (path, _blob, type, onProgress) => {
      calls.put.push(path);
      calls.types.push(type);
      onProgress(0.42);
      onProgress(1);
    },
    finalize: async (id, meta): Promise<FinalizeResult> => {
      calls.finalize.push({ id, meta });
      return { status: 'ready', reason: null, attachment: null };
    },
    previewUrl: (_f, family) => (family === 'image' ? 'blob:preview' : null),
    revokeUrl: () => undefined,
    sleep: async () => undefined,
    newId: () => `local-${++ids}`,
    notify: (m) => { calls.notify.push(m); },
    ...over,
  };
  const up = new Uploader(deps, concurrency);
  return { up, calls, deps };
}

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function watch(up: Uploader, key: string): string[] {
  const seen: string[] = [];
  up.store.subscribe((s) => {
    const it = s.byKey[key]?.[0];
    const label = it ? `${it.status}${it.status === 'uploading' ? `:${it.progress}` : ''}` : 'gone';
    if (seen[seen.length - 1] !== label) seen.push(label);
  });
  return seen;
}

const KEY = 'chan-1';

describe('upload state machine', () => {
  test('a photo goes preparing, uploading with percent, finalizing, ready; its id is ready to send', async () => {
    const { up, calls } = setup();
    const seen = watch(up, KEY);
    up.add(KEY, [file('Team photo.jpg', 'image/jpeg')]);
    await settle();
    expect(seen).toEqual(['preparing', 'uploading:0', 'uploading:42', 'uploading:99', 'finalizing', 'ready']);
    const item = up.items(KEY)[0] as UploadItem;
    expect(item.status).toBe('ready');
    expect(item.progress).toBe(100);
    expect(item.previewUrl).toBe('blob:preview');
    expect(up.readyIds(KEY)).toEqual(['att-1']);
    expect(up.busy(KEY)).toBe(false);
    expect(calls.begin).toEqual([{ channel: 'chan-1', name: 'Team photo.jpg', mime: 'image/jpeg', size: 2048, withThumb: true }]);
    // the bytes, then the thumbnail, then the check
    expect(calls.put).toEqual(['org/chan-1/att-1/Team photo.jpg', 'org/chan-1/att-1/thumb.webp']);
    expect(calls.finalize).toEqual([{ id: 'att-1', meta: { width: 800, height: 600, duration_ms: null } }]);
  });

  test('the bytes go up with exactly the type begin_upload recorded (the bucket allow-lists types)', async () => {
    const begun: string[] = [];
    const { up, calls } = setup({
      beginUpload: async (channel, name, mime, _size, withThumb): Promise<UploadTicket> => {
        begun.push(mime);
        // whatever the client sent, the server's recorded type is what counts
        return { attachment_id: 'att-x', bucket: 'media', path: `org/${channel}/att-x/${name}`, thumb_path: withThumb ? 'org/t.webp' : null, max_bytes: 25 * MB, mime: 'audio/ogg' };
      },
    });
    up.add(KEY, [file('voice-note.webm', 'audio/webm;codecs=opus', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))]);
    await settle();
    expect(begun).toEqual(['audio/webm']);
    expect(calls.types).toEqual(['audio/ogg']);
    // an older server without "mime": the canonical form of ours, never one with parameters
    expect(uploadType({ attachment_id: 'a', bucket: 'media', path: 'p', thumb_path: null, max_bytes: 1 } as never, 'audio/ogg; codecs=opus')).toBe('audio/ogg');
  });

  test('the channel comes from the draft key, or from AttachmentButton when it registered one', async () => {
    const { up, calls } = setup();
    up.add('chan-9:root-1', [file('a.jpg', 'image/jpeg')]);
    up.setChannel('custom-key', 'chan-7');
    up.add('custom-key', [file('b.jpg', 'image/jpeg')]);
    await settle();
    expect(calls.begin.map((b) => b.channel)).toEqual(['chan-9', 'chan-7']);
  });

  test('an executable is refused before a single byte is read or a slot reserved', async () => {
    const { up, calls } = setup();
    up.add(KEY, [file('invoice.pdf.exe', 'application/x-msdownload', PE_HEAD)]);
    await settle();
    const item = up.items(KEY)[0] as UploadItem;
    expect(item.status).toBe('failed');
    expect(item.retryable).toBe(false);
    expect(item.error).toMatch(/program, script or web page/);
    expect(calls.heads).toBe(0);
    expect(calls.begin).toHaveLength(0);
  });

  test('a program disguised as photo.jpg is refused by its bytes, with nothing reserved (DEKA11)', async () => {
    const { up, calls } = setup();
    up.add(KEY, [file('holiday.jpg', 'image/jpeg', PE_HEAD)]);
    await settle();
    const item = up.items(KEY)[0] as UploadItem;
    expect(item.status).toBe('failed');
    expect(item.error).toBe('holiday.jpg is really a Windows program disguised as a photo. Dek does not accept programs.');
    expect(item.retryable).toBe(false);
    expect(calls.begin).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
  });

  test('a dropped connection retries once quietly, then offers Retry, which resumes the same reservation', async () => {
    let failures = 2;
    const { up, calls } = setup({
      put: async (path, _b, _t, onProgress) => {
        calls.put.push(path);
        if (path.endsWith('.jpg') && failures > 0) {
          failures -= 1;
          onProgress(0.3);
          throw new TransferError('network', 'The connection dropped during the upload. Retry when you are back online.', true, 0);
        }
        onProgress(1);
      },
    });
    up.add(KEY, [file('a.jpg', 'image/jpeg')]);
    await settle();
    let item = up.items(KEY)[0] as UploadItem;
    expect(item.status).toBe('failed');
    expect(item.retryable).toBe(true);
    expect(item.error).toMatch(/connection dropped/);
    expect(calls.put.filter((p) => p.endsWith('.jpg'))).toHaveLength(2);   // first try plus one quiet retry
    up.retry(KEY, item.localId);
    await settle();
    item = up.items(KEY)[0] as UploadItem;
    expect(item.status).toBe('ready');
    expect(calls.begin).toHaveLength(1);   // the same reserved path, no second reservation
    expect(calls.abort).toHaveLength(0);
  });

  test('a closed upload slot (storage policy) resumes from a fresh reservation and releases the old one', async () => {
    let denied = 2;
    const { up, calls } = setup({
      put: async (path, _b, _t, onProgress) => {
        calls.put.push(path);
        if (path.endsWith('.pdf') && denied > 0) {
          denied -= 1;
          throw new TransferError('denied', 'This upload slot is no longer open. Retry to reserve a new one.', true, 403);
        }
        onProgress(1);
      },
    });
    up.add(KEY, [file('r.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.7'))]);
    await settle();
    expect((up.items(KEY)[0] as UploadItem).status).toBe('failed');
    up.retry(KEY, (up.items(KEY)[0] as UploadItem).localId);
    await settle();
    expect((up.items(KEY)[0] as UploadItem).status).toBe('ready');
    expect(calls.begin).toHaveLength(3);
    expect(calls.abort).toEqual(['att-1', 'att-2']);
  });

  test('media-finalize rejecting the bytes is a clear, final failure', async () => {
    const { up } = setup({ finalize: async () => ({ status: 'rejected', reason: 'type_mismatch', attachment: null }) });
    up.add(KEY, [file('a.jpg', 'image/jpeg')]);
    await settle();
    const item = up.items(KEY)[0] as UploadItem;
    expect(item.status).toBe('failed');
    expect(item.retryable).toBe(false);
    expect(item.error).toBe('The file is not what its name says it is, so Dek did not accept it.');
    expect(up.readyIds(KEY)).toEqual([]);
  });

  test('a refusal from begin_upload shows the server sentence without its field prefix', async () => {
    const { up } = setup({
      beginUpload: async () => { throw new DekError('invalid_input', 'p_size: Video files can be up to 100 MB.'); },
    });
    up.add(KEY, [file('clip.mp4', 'video/mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]))]);
    await settle();
    const item = up.items(KEY)[0] as UploadItem;
    expect(item.status).toBe('failed');
    expect(item.error).toBe('Video files can be up to 100 MB.');
    expect(item.retryable).toBe(false);
  });

  test('a channel the person can no longer post in says so', async () => {
    const { up } = setup({ beginUpload: async () => { throw new DekError('not_found', 'That channel does not exist.'); } });
    up.add(KEY, [file('a.jpg', 'image/jpeg')]);
    await settle();
    expect((up.items(KEY)[0] as UploadItem).error).toMatch(/^You cannot add files to this conversation/);
  });

  test('a failed thumbnail never fails the upload', async () => {
    const { up, calls } = setup({
      put: async (path, _b, _t, onProgress) => {
        calls.put.push(path);
        if (path.endsWith('thumb.webp')) throw new TransferError('server', 'nope', true, 500);
        onProgress(1);
      },
    });
    up.add(KEY, [file('a.jpg', 'image/jpeg')]);
    await settle();
    expect((up.items(KEY)[0] as UploadItem).status).toBe('ready');
    expect(calls.finalize).toHaveLength(1);
  });

  test('Remove during the upload aborts the request and the reservation', async () => {
    const gate = deferred<void>();
    let signalSeen: AbortSignal | null = null;
    const { up, calls } = setup({
      put: async (path, _b, _t, _p, signal) => {
        calls.put.push(path);
        signalSeen = signal;
        await Promise.race([gate.promise, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))))]);
      },
    });
    up.add(KEY, [file('a.jpg', 'image/jpeg')]);
    await settle();
    const item = up.items(KEY)[0] as UploadItem;
    expect(item.status).toBe('uploading');
    up.remove(KEY, item.localId);
    await settle();
    expect(up.items(KEY)).toEqual([]);
    expect((signalSeen as AbortSignal | null)?.aborted).toBe(true);
    expect(calls.abort).toEqual(['att-1']);
    expect(calls.finalize).toHaveLength(0);
  });

  test('clear() after a send drops sent and failed files and keeps the ones still on their way', async () => {
    const gate = deferred<void>();
    const { up, calls } = setup({
      put: async (path, _b, _t, onProgress) => {
        calls.put.push(path);
        if (path.includes('slow')) await gate.promise;
        onProgress(1);
      },
    });
    up.add(KEY, [file('done.jpg', 'image/jpeg'), file('slow.jpg', 'image/jpeg'), file('bad.exe', 'application/octet-stream')]);
    await settle();
    expect(up.items(KEY).map((i) => i.status)).toEqual(['ready', 'uploading', 'failed']);
    up.clear(KEY);
    expect(up.items(KEY).map((i) => i.fileName)).toEqual(['slow.jpg']);
    gate.resolve();
    await settle();
    expect(up.items(KEY).map((i) => i.status)).toEqual(['ready']);
  });

  test('at most 10 files per message; the rest are named in a notice', async () => {
    const { up, calls } = setup();
    up.add(KEY, Array.from({ length: 12 }, (_, i) => file(`p${i}.jpg`, 'image/jpeg')));
    await settle(80);
    expect(up.items(KEY)).toHaveLength(10);
    expect(calls.notify[0]).toMatch(/at most 10 files\. 2 were not added/);
  });

  test('two at a time: the third file waits its turn', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let started = 0;
    const { up } = setup({
      put: async (path, _b, _t, onProgress) => {
        if (path.endsWith('thumb.webp')) return;
        const g = gates[started];
        started += 1;
        await g?.promise;
        onProgress(1);
      },
    }, 2);
    up.add(KEY, [file('1.jpg', 'image/jpeg'), file('2.jpg', 'image/jpeg'), file('3.jpg', 'image/jpeg')]);
    await settle();
    expect(started).toBe(2);
    expect(up.items(KEY)[2]?.queued).toBe(true);
    gates[0]?.resolve();
    await settle();
    expect(started).toBe(3);
    gates[1]?.resolve();
    gates[2]?.resolve();
    await settle();
    expect(up.items(KEY).every((i) => i.status === 'ready')).toBe(true);
  });

  test('reset() (sign-out) stops everything and forgets every list', async () => {
    const gate = deferred<void>();
    const { up, calls } = setup({ put: async () => { await gate.promise; } });
    up.add(KEY, [file('a.jpg', 'image/jpeg')]);
    up.add('other', [file('b.jpg', 'image/jpeg')]);
    await settle();
    up.reset();
    expect(up.store.getState().byKey).toEqual({});
    expect(calls.abort.sort()).toEqual(['att-1', 'att-2']);
  });
});
