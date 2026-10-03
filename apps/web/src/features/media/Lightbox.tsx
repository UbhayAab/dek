// Full-size photos. A native modal <dialog>: focus is trapped and Escape closes it
// for free. Arrow keys and a horizontal swipe move between photos; Download asks
// Storage for an attachment response; on iPhone and iPad, Share hands the file to
// the system sheet (navigator.share with files), which is how iOS saves a photo.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Attachment } from '../../api/types';
import { Icon } from '../../ui/icons';
import { IconButton } from '../../ui/kit';
import { useFreshUrls, useMediaUrls, urlCache } from './hooks';
import { downloadUrl } from './signedUrls';
import './media.css';

export function isAppleTouch(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

interface Props {
  items: Attachment[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  thumbUrls: Record<string, string | null>;
}

const SWIPE_PX = 48;

export function Lightbox({ items, index, onIndex, onClose, thumbUrls }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const item = items[index];
  const count = items.length;
  const full = useMediaUrls([item?.path]);
  const fresh = useFreshUrls([item?.path]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState(0);
  const [shareBlob, setShareBlob] = useState<Blob | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const canShare = isAppleTouch() && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

  useLayoutEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      try { d.showModal(); } catch { d.setAttribute('open', ''); }
    }
    closeBtn.current?.focus();
    return () => { if (d?.open) d.close(); };
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, [onClose]);

  useEffect(() => {
    setFailed(0);
    setShareBlob(null);
    setShareError(null);
  }, [index]);

  // Arrow keys work wherever focus sits while the viewer is open (a modal dialog
  // can leave it on the body).
  const step = useRef<(delta: number) => void>(() => undefined);
  const inst = useRef(Math.random().toString(36).slice(2, 6));
  ((window as unknown as { __lbDebug?: unknown[] }).__lbDebug ??= []).push({ render: inst.current, index, items: items.map((i) => i.file_name) });
  useEffect(() => {
    ((window as unknown as { __lbDebug?: unknown[] }).__lbDebug ??= []).push({ effect: inst.current });
    const onKey = (e: KeyboardEvent) => {
      ((window as unknown as { __lbDebug?: unknown[] }).__lbDebug ??= []).push({ key: inst.current, prevented: e.defaultPrevented });
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      step.current(e.key === 'ArrowRight' ? 1 : -1);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      ((window as unknown as { __lbDebug?: unknown[] }).__lbDebug ??= []).push({ cleanup: inst.current });
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const fullUrl = item ? full[item.path] ?? null : null;

  // iOS only allows navigator.share inside the tap, so the bytes are fetched ahead.
  useEffect(() => {
    if (!canShare || !fullUrl) return undefined;
    let alive = true;
    fetch(fullUrl).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (alive && b) setShareBlob(b); }).catch(() => undefined);
    return () => { alive = false; };
  }, [canShare, fullUrl]);

  if (!item) return null;
  const go = (delta: number) => {
    ((window as unknown as { __lbDebug?: unknown[] }).__lbDebug ??= []).push({ index, count, delta, ts: Date.now() });
    if (count < 2) return;
    onIndex((index + delta + count) % count);
  };
  step.current = go;
  const thumb = item.thumb_path ? thumbUrls[item.thumb_path] ?? null : null;
  const showFull = fullUrl && failed < 2;
  const link = fresh[item.path] ?? fullUrl;

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    else if (dy > SWIPE_PX * 2 && Math.abs(dy) > Math.abs(dx) * 2) onClose();
  };

  const share = async () => {
    if (!shareBlob) return;
    const file = new File([shareBlob], item.file_name, { type: shareBlob.type || item.mime_type });
    try {
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: item.file_name });
      else setShareError('Sharing is not available here. Use Download instead.');
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') setShareError('Sharing did not work. Use Download instead.');
    }
  };

  return (
    <dialog
      ref={ref}
      className="dm-lightbox"
      aria-label={`Photo ${index + 1} of ${count}: ${item.file_name}`}
    >
      <div className="dm-lightbox__bar">
        <span className="dm-lightbox__title" dir="auto">{item.file_name}</span>
        {count > 1 ? <span className="dm-lightbox__count" aria-live="polite">{index + 1} / {count}</span> : null}
        <span className="dm-lightbox__tools">
          {canShare ? (
            <button type="button" className="dm-lightbox__btn" onClick={() => { void share(); }} disabled={!shareBlob} aria-label={`Share ${item.file_name}`}>
              <Icon name="share" size={20} />
            </button>
          ) : null}
          {link ? (
            <a className="dm-lightbox__btn" href={downloadUrl(link, item.file_name)} download={item.file_name} aria-label={`Download ${item.file_name}`}>
              <Icon name="download" size={20} />
            </a>
          ) : null}
          <button ref={closeBtn} type="button" className="dm-lightbox__btn" onClick={onClose} aria-label="Close photo viewer">
            <Icon name="x" size={22} />
          </button>
        </span>
      </div>
      <div
        className="dm-lightbox__stage"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { start.current = null; }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        {thumb && loaded !== item.path ? <img className="dm-lightbox__img is-thumb" src={thumb} alt="" aria-hidden="true" /> : null}
        {showFull ? (
          <img
            key={item.path}
            className={`dm-lightbox__img${loaded === item.path ? ' is-ready' : ''}`}
            src={fullUrl}
            alt={item.file_name}
            draggable={false}
            onLoad={() => setLoaded(item.path)}
            onError={() => {
              if (failed === 0) urlCache.invalidate(item.path, fullUrl);
              setFailed((n) => n + 1);
            }}
          />
        ) : null}
        {failed >= 2 ? <p className="dm-lightbox__msg" role="alert">This photo could not be shown. Download it instead.</p> : null}
        {shareError ? <p className="dm-lightbox__msg" role="alert">{shareError}</p> : null}
      </div>
      {count > 1 ? (
        <>
          <IconButton icon="chevronLeft" label="Previous photo" className="dm-lightbox__nav dm-lightbox__nav--prev" onClick={() => go(-1)} />
          <IconButton icon="chevronRight" label="Next photo" className="dm-lightbox__nav dm-lightbox__nav--next" onClick={() => go(1)} />
        </>
      ) : null}
    </dialog>
  );
}
