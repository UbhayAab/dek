// The composer's file controls: the attach button and the list of files on their
// way. They own no text: the draft lives in the composer and nothing here clears
// it, so a refused or failed file never costs anyone what they typed (DEKA11).
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../../ui/kit';
import { uploader, useUploads } from './hooks';
import { MIcon, type MediaIconName } from './icons';
import type { UploadItem } from './uploads';
import { ACCEPT, formatBytes, type MediaFamily } from './validate';
import './media.css';

export function AttachmentButton({ uploadKey, channelId, disabled }: { uploadKey: string; channelId: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    uploader.setChannel(uploadKey, channelId);
  }, [uploadKey, channelId]);
  return (
    <>
      <IconButton
        icon="paperclip"
        label="Attach files"
        className="dm-attach"
        disabled={disabled}
        onClick={() => input.current?.click()}
      />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        data-upload-key={uploadKey}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = '';
          if (files.length) uploader.add(uploadKey, files, channelId);
        }}
      />
    </>
  );
}

export function familyIcon(family: MediaFamily | null | undefined, mime?: string | null): MediaIconName {
  if (family === 'video' || mime?.startsWith('video/')) return 'fileVideo';
  if (family === 'audio' || mime?.startsWith('audio/')) return 'fileAudio';
  if (family === 'archive' || mime === 'application/zip') return 'fileZip';
  if (mime && /sheet|excel|csv/.test(mime)) return 'fileSheet';
  if (mime && /presentation|powerpoint/.test(mime)) return 'fileSlides';
  return 'fileText';
}

function statusLine(item: UploadItem): string {
  switch (item.status) {
    case 'preparing': return item.queued ? 'Waiting' : 'Preparing';
    case 'uploading': return `Uploading ${item.progress}%`;
    case 'finalizing': return 'Checking the file';
    case 'ready': {
      const quality = item.family === 'image' ? ', original quality' : '';
      return `Ready${quality}${item.size ? `, ${formatBytes(item.size)}` : ''}`;
    }
    case 'failed': return item.error ?? 'This file could not be added.';
  }
}

function UploadRow({ item, onRemove, onRetry }: { item: UploadItem; onRemove: () => void; onRetry: () => void }) {
  const [broken, setBroken] = useState(false);
  const moving = item.status === 'preparing' || item.status === 'uploading' || item.status === 'finalizing';
  const pct = item.status === 'ready' ? 100 : item.progress;
  return (
    <li className={`dm-upload is-${item.status}`} data-status={item.status} data-local-id={item.localId}>
      <span className="dm-upload__thumb" aria-hidden="true">
        {item.previewUrl && !broken
          ? <img src={item.previewUrl} alt="" onError={() => setBroken(true)} />
          : <MIcon name={familyIcon(item.family, item.mime)} size={20} />}
      </span>
      <span className="dm-upload__body">
        <span className="dm-upload__name" dir="auto" title={item.fileName}>{item.fileName}</span>
        <span className="dm-upload__status" role={item.status === 'failed' ? 'alert' : undefined}>{statusLine(item)}</span>
        {moving ? (
          <span
            className="dm-upload__bar"
            role="progressbar"
            aria-label={`${item.fileName}: ${statusLine(item)}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <span style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />
          </span>
        ) : null}
      </span>
      <span className="dm-upload__actions">
        {item.status === 'failed' && item.retryable
          ? <IconButton icon="refresh" label={`Retry ${item.fileName}`} onClick={onRetry} className="dm-upload__btn" />
          : null}
        <IconButton icon="x" label={`Remove ${item.fileName}`} onClick={onRemove} className="dm-upload__btn" />
      </span>
    </li>
  );
}

export function PendingUploads({ uploadKey }: { uploadKey: string }) {
  const { items, remove, retry } = useUploads(uploadKey);
  if (!items.length) return null;
  return (
    <ul className="dm-uploads" aria-label="Files for this message">
      {items.map((item) => (
        <UploadRow key={item.localId} item={item} onRemove={() => remove(item.localId)} onRetry={() => retry(item.localId)} />
      ))}
    </ul>
  );
}
