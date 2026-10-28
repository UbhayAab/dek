// The link a media element uses, kept for as long as it works.
//
// The URL cache mints a fresh link for a file well before the old one expires
// (the download buttons ask for that every 14 minutes). Handing the fresh link to
// a <video> or <audio> element would reload it: a voice note jumping back to the
// start, a paused video losing its place. So once an element has loaded, it keeps
// its link, and takes a new one only after it reports an error (the link
// expired); a player then resumes at the same moment, playing again if it was
// playing. A decode error, or a second failure within a minute of a fresh link,
// means the file itself cannot be shown here.
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { urlCache } from './hooks';

// MediaError.MEDIA_ERR_DECODE: the bytes arrived and are not playable.
const MEDIA_ERR_DECODE = 3;
export const REFRESH_COOLDOWN_MS = 60_000;

interface Resume {
  failed: string;
  at: number;
  play: boolean;
}

export interface StableSource {
  src: string | null;
  broken: boolean;
  // Handlers for the element (img, video or audio).
  onError: (e: SyntheticEvent<HTMLElement>) => void;
  onLoad: () => void;
  onLoadedMetadata: (e: SyntheticEvent<HTMLMediaElement>) => void;
  onPlay: () => void;
  onPause: () => void;
}

// play() returns a promise in browsers today and nothing in older ones.
export function playQuietly(el: HTMLMediaElement): void {
  try {
    const p = el.play() as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  } catch {
    // refused: the person presses play
  }
}

export function useStableSource(path: string, url: string | null, now: () => number = Date.now): StableSource {
  // A fresh link when the cache has one (a remount after a while), else the one given.
  const [src, setSrc] = useState<string | null>(() => urlCache.peek(path) ?? url);
  const [broken, setBroken] = useState(false);
  const resume = useRef<Resume | null>(null);
  const loaded = useRef(false);
  const lastFresh = useRef(0);
  const playing = useRef(false);

  useEffect(() => {
    if (!url || url === src) return;
    // Nothing loaded yet: the newest link costs nothing.
    if (src === null || !loaded.current) {
      setSrc(url);
      return;
    }
    // After an error: the first link that is not the one that failed.
    const r = resume.current;
    if (r && url !== r.failed) setSrc(url);
  }, [url, src]);

  // An element reports one error per load attempt, so every call is a real failure.
  const onError = (e: SyntheticEvent<HTMLElement>) => {
    if (!src) return;
    const el = e.currentTarget as HTMLElement & Partial<HTMLMediaElement>;
    const t = now();
    if (el.error?.code === MEDIA_ERR_DECODE || (lastFresh.current && t - lastFresh.current < REFRESH_COOLDOWN_MS)) {
      setBroken(true);
      return;
    }
    lastFresh.current = t;
    const at = typeof el.currentTime === 'number' && Number.isFinite(el.currentTime) ? el.currentTime : 0;
    resume.current = { failed: src, at, play: playing.current || el.paused === false };
    // A newer link the cache already holds, or a new one minted now.
    const fresh = urlCache.peek(path);
    if (fresh && fresh !== src) setSrc(fresh);
    else urlCache.invalidate(path);
  };

  const onLoad = () => {
    loaded.current = true;
    resume.current = null;
  };

  const onLoadedMetadata = (e: SyntheticEvent<HTMLMediaElement>) => {
    loaded.current = true;
    const r = resume.current;
    if (!r) return;
    resume.current = null;
    const el = e.currentTarget;
    if (r.at > 0) {
      try {
        el.currentTime = r.at;
      } catch {
        // not seekable: it starts over
      }
    }
    if (r.play) playQuietly(el);
  };

  return {
    src,
    broken,
    onError,
    onLoad,
    onLoadedMetadata,
    onPlay: () => { playing.current = true; },
    onPause: () => { playing.current = false; },
  };
}
