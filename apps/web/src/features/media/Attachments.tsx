// Attachments under a message (DEK11): photos in a one to four tile grid with the
// box reserved from width and height, thumbnails first and full size in the
// lightbox, video with a poster, audio players (voice notes labelled as such), and
// file cards. Every URL is a 15 minute signed URL from the batched cache; a media
// error re-mints once, then shows an honest broken state with a download link.
import { useMemo, useRef, useState } from 'react';
import type { Attachment, Message } from '../../api/types';
import { Icon } from '../../ui/icons';
import { familyIcon } from './Composer';
import { useFreshUrls, useMediaUrls, urlCache } from './hooks';
import { MIcon } from './icons';
import { GRID_MAX, formatDuration, groupAttachments, isPdf, isVoiceNote, singleBox, typeLabel } from './layout';
import { Lightbox } from './Lightbox';
import { openLinkProps, opensWhere, saveLinkProps } from './fileLinks';
import { formatBytes, familyOf } from './validate';
import './media.css';

// One re-mint per element: the first error may be an expired URL; a second one is
// the file itself (a format this browser cannot show).
function useErrorBudget(path: string) {
  const errors = useRef(0);
  const [broken, setBroken] = useState(false);
  const onError = (failedUrl: string | null) => {
    errors.current += 1;
    if (errors.current === 1) urlCache.invalidate(path, failedUrl);
    else setBroken(true);
  };
  return { broken, onError };
}

function ImageTile({ att, url, index, single, extra, onOpen }: {
  att: Attachment; url: string | null; index: number; single: boolean; extra: number; onOpen: (i: number, el: HTMLElement) => void;
}) {
  const path = att.thumb_path ?? att.path;
  const { broken, onError } = useErrorBudget(path);
  const [loaded, setLoaded] = useState(false);
  const box = single ? singleBox(att.width, att.height) : null;
  const style = box ? { width: `min(100%, ${box.width}px)`, aspectRatio: String(box.ratio) } : undefined;
  return (
    <button
      type="button"
      className={`dm-tile${loaded ? ' is-loaded' : ''}${broken ? ' is-broken' : ''}`}
      style={style}
      data-tile={index}
      aria-label={extra ? `Open ${att.file_name} and ${extra} more` : `Open ${att.file_name}`}
      onClick={(e) => onOpen(index, e.currentTarget)}
    >
      {url && !broken ? (
        <img
          src={url}
          alt={att.file_name}
          width={att.width ?? undefined}
          height={att.height ?? undefined}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => onError(url)}
        />
      ) : null}
      {broken ? <span className="dm-tile__broken"><MIcon name="imageOff" size={22} /><span>Cannot show this image</span></span> : null}
      {extra ? <span className="dm-tile__more" aria-hidden="true">+{extra}</span> : null}
    </button>
  );
}

function ImageGrid({ images, urls, onOpen }: { images: Attachment[]; urls: Record<string, string | null>; onOpen: (i: number, el: HTMLElement) => void }) {
  const shown = images.slice(0, GRID_MAX);
  const extra = images.length - shown.length;
  const single = shown.length === 1;
  return (
    <div className={`dm-grid dm-grid--${shown.length}`} role="group" aria-label={`${images.length} ${images.length === 1 ? 'photo' : 'photos'}`}>
      {shown.map((a, i) => (
        <ImageTile
          key={a.id}
          att={a}
          index={i}
          single={single}
          url={urls[a.thumb_path ?? a.path] ?? null}
          extra={i === shown.length - 1 ? extra : 0}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function FileCard({ att, url, note }: { att: Attachment; url: string | null; note?: string }) {
  const pdf = isPdf(att.mime_type);
  return (
    <div className="dm-file" data-attachment={att.id}>
      <span className="dm-file__icon" aria-hidden="true"><MIcon name={familyIcon(familyOf(att.mime_type), att.mime_type)} size={22} /></span>
      <span className="dm-file__meta">
        <span className="dm-file__name" dir="auto" title={att.file_name}>{att.file_name}</span>
        <span className="dm-file__sub">{note ?? `${typeLabel(att.mime_type)}, ${formatBytes(att.size_bytes)}`}</span>
      </span>
      <span className="dm-file__actions">
        {url ? (
          <>
            {pdf ? (
              <a className="dm-file__action" {...openLinkProps(url)} aria-label={`Open ${att.file_name} ${opensWhere()}`}>
                <Icon name="external" size={18} /><span>Open</span>
              </a>
            ) : null}
            <a className="dm-file__action" {...saveLinkProps(url, att.file_name)} aria-label={`Download ${att.file_name}`}>
              <Icon name="download" size={18} /><span>{pdf ? 'Save' : 'Download'}</span>
            </a>
          </>
        ) : urlCache.failed(att.path) ? (
          <span className="dm-file__sub">Not available</span>
        ) : (
          <span className="dm-file__sub" aria-live="polite">Preparing link</span>
        )}
      </span>
    </div>
  );
}

function VideoBox({ att, url, poster, link }: { att: Attachment; url: string | null; poster: string | null; link: string | null }) {
  const { broken, onError } = useErrorBudget(att.path);
  const box = singleBox(att.width, att.height);
  if (broken) return <FileCard att={att} url={link} note="This video cannot play here. Download it instead." />;
  return (
    <div className="dm-video" style={{ width: `min(100%, ${box.width}px)`, aspectRatio: String(box.ratio) }}>
      {url ? (
        <video
          controls
          playsInline
          preload="metadata"
          poster={poster ?? undefined}
          src={url}
          aria-label={att.file_name}
          onError={() => onError(url)}
        />
      ) : <span className="dm-video__ph" aria-hidden="true"><MIcon name="play" size={28} /></span>}
    </div>
  );
}

function AudioBox({ att, url, link }: { att: Attachment; url: string | null; link: string | null }) {
  const { broken, onError } = useErrorBudget(att.path);
  const resume = useRef(false);
  const voice = isVoiceNote(att);
  const length = formatDuration(att.duration_ms);
  if (broken) return <FileCard att={att} url={link} note="This audio cannot play here. Download it instead." />;
  return (
    <div className="dm-audio" data-attachment={att.id}>
      <span className="dm-audio__head">
        <span className="dm-audio__icon" aria-hidden="true"><MIcon name={voice ? 'speaker' : 'music'} size={18} /></span>
        <span className="dm-audio__name" dir="auto">{voice ? 'Voice note' : att.file_name}</span>
        {length ? <span className="dm-audio__len">{length}</span> : null}
      </span>
      {url ? (
        <audio
          controls
          preload="metadata"
          src={url}
          aria-label={voice ? `Voice note${length ? `, ${length}` : ''}` : att.file_name}
          onPlay={() => { resume.current = false; }}
          onError={(e) => {
            // A URL that expired while the page sat open: re-mint and carry on
            // playing if that is what the person asked for.
            resume.current = !e.currentTarget.paused;
            onError(url);
          }}
          onLoadedMetadata={(e) => { if (resume.current) void e.currentTarget.play().catch(() => undefined); }}
        />
      ) : <span className="dm-audio__ph">Loading</span>}
    </div>
  );
}

function StatusCard({ att, text }: { att: Attachment; text: string }) {
  return (
    <div className="dm-file is-muted" data-attachment={att.id}>
      <span className="dm-file__icon" aria-hidden="true"><MIcon name={familyIcon(familyOf(att.mime_type), att.mime_type)} size={22} /></span>
      <span className="dm-file__meta">
        <span className="dm-file__name" dir="auto">{att.file_name}</span>
        <span className="dm-file__sub">{text}</span>
      </span>
    </div>
  );
}

export function MessageAttachments({ message, attachments }: { message: Message; attachments: Attachment[] }) {
  const list = attachments ?? message.attachments ?? [];
  const g = useMemo(() => groupAttachments(list), [list]);
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // Everything this message shows, in one request with the rest of the screen.
  const mediaPaths = useMemo(() => [
    ...g.images.slice(0, GRID_MAX).map((a) => a.thumb_path ?? a.path),
    ...g.videos.flatMap((a) => [a.path, a.thumb_path]),
    ...g.audio.map((a) => a.path),
  ], [g]);
  const linkPaths = useMemo(() => [...g.files, ...g.videos, ...g.audio].map((a) => a.path), [g]);
  const urls = useMediaUrls(mediaPaths);
  const links = useFreshUrls(linkPaths);

  if (!list.length) return null;
  return (
    <div className="dm-atts" data-message={message.id}>
      {g.images.length ? (
        <ImageGrid images={g.images} urls={urls} onOpen={(i, el) => { opener.current = el; setOpen(i); }} />
      ) : null}
      {g.videos.map((a) => (
        <VideoBox key={a.id} att={a} url={urls[a.path] ?? null} poster={a.thumb_path ? urls[a.thumb_path] ?? null : null} link={links[a.path] ?? null} />
      ))}
      {g.audio.map((a) => <AudioBox key={a.id} att={a} url={urls[a.path] ?? null} link={links[a.path] ?? null} />)}
      {g.files.map((a) => <FileCard key={a.id} att={a} url={links[a.path] ?? null} />)}
      {g.pending.map((a) => <StatusCard key={a.id} att={a} text="Still being checked" />)}
      {g.rejected.map((a) => <StatusCard key={a.id} att={a} text="Removed: it did not pass the file check" />)}
      {open !== null ? (
        <Lightbox
          items={g.images}
          index={Math.min(open, g.images.length - 1)}
          onIndex={setOpen}
          onClose={() => {
            setOpen(null);
            opener.current?.focus();
          }}
          thumbUrls={urls}
        />
      ) : null}
    </div>
  );
}

