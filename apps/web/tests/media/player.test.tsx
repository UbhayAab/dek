// Players keep the link they loaded with (the audit: video and voice players
// reloaded every 14 minutes when the signed link was refreshed).
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Attachment, Message } from '../../src/api/types';

let minted = 0;
const invoke = vi.fn(async (_name: string, opts: { body: { paths: string[] } }) => {
  minted += 1;
  return {
    data: {
      urls: Object.fromEntries(opts.body.paths.map((p) => [p, `https://sb.test/sign/${p}?token=${minted}`])),
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    },
    error: null,
  };
});

vi.mock('../../src/api/client', () => ({
  supabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    functions: { invoke },
    storage: { from: () => ({}) },
  }),
  rpc: async () => { throw new Error('no rpc in tests'); },
  setAuthStorage: () => undefined,
}));

const { MessageAttachments } = await import('../../src/features/media');
const { urlCache } = await import('../../src/features/media/hooks');

const voice: Attachment = {
  id: 'a1', file_name: 'voice-note-0m40s.webm', mime_type: 'audio/webm', size_bytes: 80_000, width: null, height: null,
  duration_ms: 40_000, path: 'o/c/a1/voice.webm', thumb_path: null, status: 'ready',
};
const clip: Attachment = {
  id: 'v1', file_name: 'clip.mp4', mime_type: 'video/mp4', size_bytes: 3_000_000, width: 1280, height: 720,
  duration_ms: 90_000, path: 'o/c/v1/clip.mp4', thumb_path: null, status: 'ready',
};
const message = (attachments: Attachment[]): Message => ({
  id: 'm1', org_id: 'o', channel_id: 'c', seq: 1, thread_root_id: null, author_id: 'u', kind: 'user', body: '', mentions: [],
  mention_all: false, client_id: null, created_at: '2026-10-05T10:00:00Z', edited_at: null, deleted_at: null,
  updated_at: '2026-10-05T10:00:00Z', reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments,
  pinned: false, also_in_channel: false, meta: {},
});

async function sweep() {
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

// What a playing element reports; jsdom has no media pipeline.
function playing(el: HTMLMediaElement, at: number) {
  let time = at;
  Object.defineProperty(el, 'currentTime', { configurable: true, get: () => time, set: (v: number) => { time = v; } });
  Object.defineProperty(el, 'paused', { configurable: true, get: () => false });
  return () => time;
}

let clock = Date.parse('2026-10-05T10:00:00Z');
let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  minted = 0;
  invoke.mockClear();
  urlCache.clear();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a player keeps its link', () => {
  test('a fresher link minted for the same file does not reload a loaded voice note', async () => {
    render(<MessageAttachments message={message([voice])} attachments={[voice]} />);
    await sweep();
    const audio = document.querySelector('audio') as HTMLAudioElement;
    expect(audio.getAttribute('src')).toBe('https://sb.test/sign/o/c/a1/voice.webm?token=1');
    fireEvent.loadedMetadata(audio);
    playing(audio, 12);
    // 14 minutes later the download link is refreshed: a new link for the same path
    clock += 14 * 60_000;
    act(() => urlCache.invalidate(voice.path));
    await sweep();
    expect(urlCache.current(voice.path)).toMatch(/token=2$/);
    expect(audio.getAttribute('src')).toBe('https://sb.test/sign/o/c/a1/voice.webm?token=1');
  });

  test('an expired link is replaced on its error, and playback resumes at the same moment', async () => {
    render(<MessageAttachments message={message([voice])} attachments={[voice]} />);
    await sweep();
    const audio = document.querySelector('audio') as HTMLAudioElement;
    fireEvent.loadedMetadata(audio);
    fireEvent.play(audio);
    const time = playing(audio, 31.5);
    clock += 16 * 60_000;   // past the 15 minutes this fake signer gave the link
    fireEvent.error(audio);
    await sweep();
    expect(audio.getAttribute('src')).toBe('https://sb.test/sign/o/c/a1/voice.webm?token=2');
    play.mockClear();
    fireEvent.loadedMetadata(audio);
    expect(time()).toBe(31.5);
    expect(play).toHaveBeenCalledTimes(1);
  });

  test('a paused player is not started again after the refresh', async () => {
    render(<MessageAttachments message={message([clip])} attachments={[clip]} />);
    await sweep();
    const video = document.querySelector('video') as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    fireEvent.play(video);
    fireEvent.pause(video);
    let time = 70;
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => time, set: (v: number) => { time = v; } });
    clock += 16 * 60_000;
    fireEvent.error(video);
    await sweep();
    expect(video.getAttribute('src')).toMatch(/token=2$/);
    play.mockClear();
    fireEvent.loadedMetadata(video);
    expect(time).toBe(70);
    expect(play).not.toHaveBeenCalled();
  });

  test('each expiry is handled, an hour of playback means several fresh links', async () => {
    render(<MessageAttachments message={message([clip])} attachments={[clip]} />);
    await sweep();
    const video = document.querySelector('video') as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    for (const n of [2, 3, 4]) {
      clock += 16 * 60_000;
      fireEvent.error(video);
      await sweep();
      expect(video.getAttribute('src')).toMatch(new RegExp(`token=${n}$`));
      fireEvent.loadedMetadata(video);
    }
    expect(document.querySelector('.dm-file')).toBeNull();
  });

  test('a fresh link that fails again within a minute means the file cannot play here', async () => {
    render(<MessageAttachments message={message([voice])} attachments={[voice]} />);
    await sweep();
    const audio = document.querySelector('audio') as HTMLAudioElement;
    fireEvent.loadedMetadata(audio);
    clock += 16 * 60_000;
    fireEvent.error(audio);
    await sweep();
    clock += 5_000;
    fireEvent.error(document.querySelector('audio') as HTMLAudioElement);
    await sweep();
    expect(document.querySelector('audio')).toBeNull();
    expect(document.querySelector('.dm-file')?.textContent).toMatch(/cannot play here/);
  });

  test('a decode error is final at once, no new link is asked for', async () => {
    render(<MessageAttachments message={message([clip])} attachments={[clip]} />);
    await sweep();
    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 3 }) });
    const mintsBefore = invoke.mock.calls.length;
    fireEvent.error(video);
    await sweep();
    expect(document.querySelector('video')).toBeNull();
    expect(invoke.mock.calls.length).toBe(mintsBefore);
  });

  test('before anything loaded, the newest link is taken straight away', async () => {
    render(<MessageAttachments message={message([voice])} attachments={[voice]} />);
    await sweep();
    const audio = document.querySelector('audio') as HTMLAudioElement;
    act(() => urlCache.invalidate(voice.path));
    await sweep();
    expect(audio.getAttribute('src')).toMatch(/token=2$/);
  });
});
