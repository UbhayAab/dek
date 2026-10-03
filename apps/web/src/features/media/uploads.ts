// The upload state machine, one list per composer key (DEK10, DEKA11).
//
//   validate (name, type, size; then the first bytes) -> prepare (downscale,
//   thumbnail, probe) -> begin (api.begin_upload reserves the path) -> upload
//   (XHR with progress) -> thumb (best effort) -> finalize (media-finalize reads
//   the real bytes) -> ready
//
// A failure records the stage it happened in; Retry resumes there (a re-upload to
// the same reserved path is idempotent: Storage answers "already exists" when an
// earlier try did land). Remove aborts the request and the reservation. Nothing in
// here touches the composer's text, so a failed or refused file can never cost
// anyone their draft. Dependencies are injected so the whole machine runs in unit
// tests without a browser or a network.
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DekError } from '../../api/errors';
import type { UploadTicket } from '../../api/types';
import { isAbort, type Prepared } from './prepare';
import { TransferError, rejectionSentence, type FinalizeMeta, type FinalizeResult } from './transfer';
import {
  MAX_ATTACHMENTS, SNIFF_BYTES, canonicalMime, checkContent, cleanName, sniffBytes, validateFile, type MediaFamily,
} from './validate';

export type UploadStatus = 'preparing' | 'uploading' | 'finalizing' | 'ready' | 'failed';

// The contract with the conversation UI (features/media/index.tsx). progress is a
// whole percent, 0 to 100.
export interface UploadItem {
  localId: string;
  fileName: string;
  progress: number;
  status: UploadStatus;
  attachmentId: string | null;
  error: string | null;
  previewUrl: string | null;
  // Additions (optional for consumers).
  size?: number;
  mime?: string;
  family?: MediaFamily | null;
  retryable?: boolean;
  queued?: boolean;
}

export interface UploadState {
  byKey: Record<string, UploadItem[]>;
}

export interface UploadDeps {
  readHead(file: Blob, bytes: number): Promise<Uint8Array>;
  prepare(file: File, name: string, mime: string, family: MediaFamily, signal: AbortSignal): Promise<Prepared>;
  beginUpload(channelId: string, name: string, mime: string, size: number, withThumb: boolean): Promise<UploadTicket>;
  abortUpload(attachmentId: string): Promise<unknown>;
  put(path: string, blob: Blob, contentType: string, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void>;
  finalize(attachmentId: string, meta: FinalizeMeta): Promise<FinalizeResult>;
  previewUrl(file: Blob, family: MediaFamily | null): string | null;
  revokeUrl(url: string): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  newId(): string;
  notify(message: string): void;
}

type Stage = 'validate' | 'prepare' | 'begin' | 'upload' | 'thumb' | 'finalize' | 'done';

interface Job {
  localId: string;
  key: string;
  channelId: string;
  file: File;
  stage: Stage;
  mime: string | null;
  family: MediaFamily | null;
  prepared: Prepared | null;
  ticket: UploadTicket | null;
  abort: AbortController;
  autoRetries: number;
  removed: boolean;
  running: boolean;
}

const BUSY: ReadonlySet<UploadStatus> = new Set(['preparing', 'uploading', 'finalizing']);
const EMPTY: UploadItem[] = [];
export const AUTO_RETRY_DELAY_MS = 1500;

// begin_upload answers with the type it recorded (ticket.mime), and the media
// bucket only accepts allow-listed types: the bytes go up with exactly that
// Content-Type (audio/webm;codecs=opus is recorded as audio/webm, a .csv from
// Excel as text/csv). A ticket from an older server without it gets the canonical
// form of ours.
export function uploadType(ticket: UploadTicket, preparedMime: string): string {
  return ticket.mime || canonicalMime(preparedMime);
}

// "p_size: Video files can be up to 100 MB." -> the sentence.
export function humanHint(hint: string): string {
  return hint.replace(/^p_[a-z_]+:\s*/i, '');
}

interface Failure {
  message: string;
  retryable: boolean;
  // Where Retry starts again, when not the stage that failed.
  resumeAt?: Stage;
}

function describe(e: unknown, stage: Stage): Failure {
  if (e instanceof TransferError) {
    if (e.code === 'denied') return { message: e.message, retryable: true, resumeAt: 'begin' };
    if (e.code === 'missing') return { message: e.message, retryable: true, resumeAt: 'upload' };
    return { message: e.message, retryable: e.retryable };
  }
  if (e instanceof DekError) {
    const message = humanHint(e.hint);
    if (stage === 'begin' && (e.code === 'not_found' || e.code === 'forbidden' || e.code === 'archived')) {
      return { message: `You cannot add files to this conversation. ${message}`, retryable: false };
    }
    return { message, retryable: e.retryable };
  }
  return { message: 'Something went wrong with this file. Retry, or remove it.', retryable: true };
}

export class Uploader {
  readonly store: StoreApi<UploadState>;
  private readonly jobs = new Map<string, Job>();
  private readonly channels = new Map<string, string>();
  private readonly waiting: Job[] = [];
  private active = 0;

  constructor(private readonly deps: UploadDeps, private readonly concurrency = 2) {
    this.store = createStore<UploadState>(() => ({ byKey: {} }));
  }

  // The composer key is a draft key: "<channel>" or "<channel>:<thread root>"
  // (store/state.ts draftKey). AttachmentButton registers the channel explicitly.
  setChannel(key: string, channelId: string): void {
    this.channels.set(key, channelId);
  }

  channelFor(key: string): string {
    return this.channels.get(key) ?? key.split(':')[0] ?? key;
  }

  items(key: string): UploadItem[] {
    return this.store.getState().byKey[key] ?? EMPTY;
  }

  readyIds(key: string): string[] {
    return this.items(key).filter((i) => i.status === 'ready' && i.attachmentId).map((i) => i.attachmentId as string);
  }

  busy(key: string): boolean {
    return this.items(key).some((i) => BUSY.has(i.status));
  }

  add(key: string, files: File[], channelId?: string): string[] {
    if (channelId) this.setChannel(key, channelId);
    const channel = this.channelFor(key);
    const room = MAX_ATTACHMENTS - this.items(key).filter((i) => i.status !== 'failed').length;
    const accepted = files.slice(0, Math.max(0, room));
    if (accepted.length < files.length) {
      this.deps.notify(`A message can carry at most ${MAX_ATTACHMENTS} files. ${files.length - accepted.length} were not added.`);
    }
    const ids: string[] = [];
    for (const file of accepted) {
      const localId = this.deps.newId();
      const job: Job = {
        localId, key, channelId: channel, file, stage: 'validate', mime: null, family: null, prepared: null, ticket: null,
        abort: new AbortController(), autoRetries: 0, removed: false, running: false,
      };
      this.jobs.set(localId, job);
      this.put(key, [...this.items(key), {
        localId, fileName: cleanName(file.name) || 'file', progress: 0, status: 'preparing', attachmentId: null, error: null,
        previewUrl: null, size: file.size, mime: file.type || undefined, family: null, retryable: false, queued: true,
      }]);
      this.schedule(job);
      ids.push(localId);
    }
    return ids;
  }

  remove(key: string, localId: string): void {
    const job = this.jobs.get(localId);
    const item = this.items(key).find((i) => i.localId === localId);
    if (job) this.dispose(job, item?.status !== 'ready');
    if (item?.previewUrl) this.deps.revokeUrl(item.previewUrl);
    this.put(key, this.items(key).filter((i) => i.localId !== localId));
  }

  retry(key: string, localId: string): void {
    const job = this.jobs.get(localId);
    const item = this.items(key).find((i) => i.localId === localId);
    if (!job || !item || item.status !== 'failed' || !item.retryable) return;
    job.abort = new AbortController();
    job.autoRetries = 0;
    this.patch(job, { status: 'preparing', error: null, retryable: false, queued: true, progress: job.stage === 'upload' ? item.progress : 0 });
    this.schedule(job);
  }

  // After a send: the sent (ready) files and the failed ones go; anything still
  // on its way stays for the next message.
  clear(key: string): void {
    for (const item of this.items(key)) {
      if (BUSY.has(item.status)) continue;
      const job = this.jobs.get(item.localId);
      if (job) this.dispose(job, item.status === 'failed');
      if (item.previewUrl) this.deps.revokeUrl(item.previewUrl);
    }
    const left = this.items(key).filter((i) => BUSY.has(i.status));
    this.put(key, left);
  }

  // Sign-out or account switch: everything stops and is forgotten.
  reset(): void {
    for (const job of this.jobs.values()) this.dispose(job, true);
    for (const list of Object.values(this.store.getState().byKey)) {
      for (const i of list) if (i.previewUrl) this.deps.revokeUrl(i.previewUrl);
    }
    this.waiting.length = 0;
    this.channels.clear();
    this.store.setState({ byKey: {} }, true);
  }

  // ---------------------------------------------------------------- internals

  private put(key: string, list: UploadItem[]): void {
    const byKey = { ...this.store.getState().byKey };
    if (list.length) byKey[key] = list;
    else delete byKey[key];
    this.store.setState({ byKey });
  }

  private patch(job: Job, p: Partial<UploadItem>): void {
    if (job.removed) return;
    const list = this.items(job.key);
    const i = list.findIndex((x) => x.localId === job.localId);
    if (i < 0) return;
    const next = list.slice();
    next[i] = { ...list[i]!, ...p };
    this.put(job.key, next);
  }

  private dispose(job: Job, abortReservation: boolean): void {
    job.removed = true;
    job.abort.abort();
    this.jobs.delete(job.localId);
    const at = this.waiting.indexOf(job);
    if (at >= 0) this.waiting.splice(at, 1);
    if (abortReservation && job.ticket && job.stage !== 'done') {
      this.deps.abortUpload(job.ticket.attachment_id).catch(() => undefined);
    }
  }

  private schedule(job: Job): void {
    if (this.active < this.concurrency) {
      void this.start(job);
    } else {
      this.waiting.push(job);
    }
  }

  private async start(job: Job): Promise<void> {
    this.active += 1;
    job.running = true;
    try {
      await this.run(job);
    } finally {
      job.running = false;
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) void this.start(next);
    }
  }

  private fail(job: Job, f: Failure): void {
    if (f.resumeAt) job.stage = f.resumeAt;
    this.patch(job, { status: 'failed', error: f.message, retryable: f.retryable, queued: false });
  }

  private async run(job: Job): Promise<void> {
    const signal = job.abort.signal;
    try {
      this.patch(job, { queued: false });
      if (job.stage === 'validate') {
        const v = validateFile(job.file);
        if (!v.ok) return this.fail(job, { message: v.message, retryable: false });
        const head = await this.deps.readHead(job.file, SNIFF_BYTES);
        const checked = checkContent(job.file.name, v, sniffBytes(head));
        if (!checked.ok) return this.fail(job, { message: checked.message, retryable: false });
        job.mime = checked.mime;
        job.family = checked.family;
        this.patch(job, { mime: checked.mime, family: checked.family, previewUrl: this.deps.previewUrl(job.file, checked.family) });
        job.stage = 'prepare';
      }
      if (job.stage === 'prepare') {
        this.patch(job, { status: 'preparing', progress: 0 });
        const name = cleanName(job.file.name) || 'file';
        job.prepared = await this.deps.prepare(job.file, name, job.mime as string, job.family as MediaFamily, signal);
        job.stage = 'begin';
      }
      const prep = job.prepared as Prepared;
      if (job.stage === 'begin') {
        this.patch(job, { status: 'preparing' });
        if (job.ticket) this.deps.abortUpload(job.ticket.attachment_id).catch(() => undefined);
        job.ticket = await this.deps.beginUpload(job.channelId, prep.name, prep.mime, prep.blob.size, !!prep.thumb);
        if (signal.aborted) return;
        this.patch(job, { attachmentId: job.ticket.attachment_id, size: prep.blob.size });
        job.stage = 'upload';
      }
      const ticket = job.ticket as UploadTicket;
      if (job.stage === 'upload') {
        this.patch(job, { status: 'uploading', progress: 0 });
        await this.deps.put(ticket.path, prep.blob, uploadType(ticket, prep.mime), (f) => {
          this.patch(job, { progress: Math.min(99, Math.round(f * 100)) });
        }, signal);
        job.stage = 'thumb';
      }
      if (job.stage === 'thumb') {
        if (ticket.thumb_path && prep.thumb) {
          try {
            await this.deps.put(ticket.thumb_path, prep.thumb, 'image/webp', () => undefined, signal);
          } catch (e) {
            if (isAbort(e)) throw e;
            // A missing thumbnail only means the full image is shown instead.
          }
        }
        job.stage = 'finalize';
      }
      if (job.stage === 'finalize') {
        this.patch(job, { status: 'finalizing', progress: 99 });
        const r = await this.deps.finalize(ticket.attachment_id, {
          width: prep.width, height: prep.height, duration_ms: prep.durationMs,
        });
        if (signal.aborted) return;
        if (r.status !== 'ready') {
          job.stage = 'done';
          return this.fail(job, { message: r.message ?? rejectionSentence(r.reason), retryable: false });
        }
        job.stage = 'done';
        this.patch(job, { status: 'ready', progress: 100, error: null, retryable: false });
      }
    } catch (e) {
      if (job.removed || isAbort(e)) return;
      const f = describe(e, job.stage);
      // One quiet retry for a dropped connection before asking the person.
      if (f.retryable && job.autoRetries < 1 && !(e instanceof DekError && e.code === 'rate_limited')) {
        job.autoRetries += 1;
        if (f.resumeAt) job.stage = f.resumeAt;
        try {
          await this.deps.sleep(AUTO_RETRY_DELAY_MS, signal);
        } catch {
          return;
        }
        if (job.removed) return;
        return this.run(job);
      }
      this.fail(job, f);
    }
  }
}
