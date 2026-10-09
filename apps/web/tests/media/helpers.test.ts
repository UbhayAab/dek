import { describe, expect, test } from 'vitest';
import type { Attachment } from '../../src/api/types';
import { MediaAccessError, describeMediaError, openMedia, permissionSteps } from '../../src/features/calls/devices';
import { ICE_CACHE_MAX_MS, IceProvider, STUN_FALLBACK, parseIce } from '../../src/features/calls/ice';
import { aspectRatio, exactRatio, formatDuration, groupAttachments, isVoiceNote, singleBox } from '../../src/features/media/layout';
import { classifyStorageFailure, parseFinalize, rejectionSentence, TransferError } from '../../src/features/media/transfer';
import { fakeStream, fakeTrack } from './fakeRtc';

describe('ICE servers from the turn function', () => {
  const NOW = 1_000_000;

  test('Cloudflare shapes (array or object) parse; relay follows the TURN urls', () => {
    const arr = parseIce({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }], relay: true }, NOW);
    expect(arr?.relay).toBe(true);
    expect(arr?.iceServers).toHaveLength(2);
    const obj = parseIce({ iceServers: { urls: 'turn:t:3478', username: 'u', credential: 'c' } }, NOW);
    expect(obj?.relay).toBe(true);
    const stunOnly = parseIce({ iceServers: [{ urls: 'stun:s:3478' }], relay: false }, NOW);
    expect(stunOnly?.relay).toBe(false);
    // "relay: true" without any TURN url is not believed
    expect(parseIce({ iceServers: [{ urls: 'stun:s:3478' }], relay: true }, NOW)?.relay).toBe(false);
    expect(parseIce({ nothing: true }, NOW)).toBeNull();
  });

  test('cached for at most an hour, and never past the credentials', () => {
    expect(parseIce({ iceServers: [{ urls: 'turn:t' }] }, NOW)?.expiresAt).toBe(NOW + ICE_CACHE_MAX_MS);
    const short = parseIce({ iceServers: [{ urls: 'turn:t' }], ttl: 600 }, NOW);
    expect(short?.expiresAt).toBe(NOW + 600_000 - 300_000);
  });

  test('the provider reuses a fresh answer, refetches after expiry, and falls back to STUN (relay false) on failure', async () => {
    let now = NOW;
    let calls = 0;
    let fail = false;
    const p = new IceProvider(async () => {
      calls += 1;
      if (fail) throw new Error('function down');
      return { iceServers: [{ urls: 'turn:t:3478', username: 'u', credential: 'c' }], relay: true };
    }, () => now);
    const [a, b] = await Promise.all([p.get(), p.get()]);
    expect(calls).toBe(1);   // concurrent asks share one request
    expect(a).toBe(b);
    now += ICE_CACHE_MAX_MS - 1;
    await p.get();
    expect(calls).toBe(1);
    now += 2;
    fail = true;
    const fallback = await p.get();
    expect(calls).toBe(2);
    expect(fallback.relay).toBe(false);
    expect(fallback.fromServer).toBe(false);
    expect(fallback.iceServers).toBe(STUN_FALLBACK);
  });
});

describe('microphone and camera problems (DEK24)', () => {
  const chrome = { ios: false, android: false, standalone: false, firefox: false, safari: false, mac: false, windows: true };
  const iphone = { ...chrome, ios: true, windows: false };

  test('a denial explains how to allow access in this browser', () => {
    const p = describeMediaError(new DOMException('denied', 'NotAllowedError'), 'microphone', chrome);
    expect(p.kind).toBe('denied');
    expect(p.title).toBe('Dek is not allowed to use your microphone');
    expect(p.body).toMatch(/Chat keeps working/);
    expect(p.steps[0]).toMatch(/address bar/);
    expect(p.steps[1]).toMatch(/Windows Settings/);
    expect(permissionSteps('camera', iphone)[0]).toMatch(/aA button/);
    expect(permissionSteps('microphone', { ...iphone, standalone: true })[0]).toMatch(/Settings app/);
  });

  test('missing and busy devices get their own sentences', () => {
    expect(describeMediaError(new DOMException('x', 'NotFoundError'), 'microphone', chrome).kind).toBe('missing');
    expect(describeMediaError(new DOMException('x', 'NotReadableError'), 'camera', chrome).title).toBe('Your camera is busy');
  });

  test('a video call whose camera fails goes ahead with audio and says why', async () => {
    const asked: MediaStreamConstraints[] = [];
    const opened = await openMedia({ audio: true, video: true }, async (c) => {
      asked.push(c);
      if (c.video) throw new DOMException('no camera', 'NotFoundError');
      return fakeStream(fakeTrack('audio'));
    });
    expect(asked).toHaveLength(2);
    expect(opened.cameraProblem?.kind).toBe('missing');
    expect(opened.stream.getAudioTracks()).toHaveLength(1);
  });

  test('a microphone that fails throws the explanation', async () => {
    await expect(openMedia({ audio: true, video: false }, async () => { throw new DOMException('no', 'NotAllowedError'); }))
      .rejects.toBeInstanceOf(MediaAccessError);
  });
});

describe('attachment layout', () => {
  const att = (over: Partial<Attachment>): Attachment => ({
    id: 'a', file_name: 'f', mime_type: 'image/jpeg', size_bytes: 10, width: null, height: null, duration_ms: null,
    path: 'o/c/a/f', thumb_path: null, status: 'ready', ...over,
  });

  test('the reserved box comes from validated numbers only', () => {
    expect(aspectRatio(1600, 900)).toBeCloseTo(16 / 9);
    expect(aspectRatio(100, 1000)).toBe(0.4);   // clamped
    expect(aspectRatio('1600" onload="x', 900)).toBeCloseTo(4 / 3);   // junk falls back
    expect(aspectRatio(-5, 10)).toBeCloseTo(4 / 3);
    expect(aspectRatio(1e9, 10)).toBeCloseTo(4 / 3);
    expect(singleBox(900, 1600)).toEqual({ width: 203, ratio: 900 / 1600 });
    expect(singleBox(1600, 900).width).toBe(360);
    // the viewer keeps the real shape, still as a plain bounded number
    expect(exactRatio(1600, 1067)).toBe(1.4995);
    expect(exactRatio(10, 100_000)).toBe(0.05);
    expect(exactRatio('1600)*99;x', 900)).toBeNull();
    expect(exactRatio(null, 900)).toBeNull();
  });

  test('groups: photos, video, audio, files; pending and rejected never get a URL', () => {
    const g = groupAttachments([
      att({ id: '1' }), att({ id: '2', mime_type: 'video/mp4' }), att({ id: '3', mime_type: 'audio/webm' }),
      att({ id: '4', mime_type: 'application/pdf' }), att({ id: '5', mime_type: 'image/heic' }),
      att({ id: '6', mime_type: 'image/heic', thumb_path: 'o/c/6/thumb.webp' }), att({ id: '7', status: 'pending' }),
      att({ id: '8', status: 'rejected' }),
    ]);
    expect(g.images.map((a) => a.id)).toEqual(['1', '6']);
    expect(g.videos.map((a) => a.id)).toEqual(['2']);
    expect(g.audio.map((a) => a.id)).toEqual(['3']);
    expect(g.files.map((a) => a.id)).toEqual(['4', '5']);
    expect(g.pending.map((a) => a.id)).toEqual(['7']);
    expect(g.rejected.map((a) => a.id)).toEqual(['8']);
  });

  test('voice notes and durations', () => {
    expect(isVoiceNote({ file_name: 'voice-note-0m12s.webm', mime_type: 'audio/webm' })).toBe(true);
    expect(isVoiceNote({ file_name: 'song.mp3', mime_type: 'audio/mpeg' })).toBe(false);
    expect(formatDuration(12_400)).toBe('0:12');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('');
  });

});

describe('storage and finalize answers', () => {
  test('storage failures map to what the person can do', () => {
    expect(classifyStorageFailure(400, JSON.stringify({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }))).toBe('exists');
    const rls = classifyStorageFailure(400, JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }));
    expect(rls).toBeInstanceOf(TransferError);
    expect((rls as TransferError).code).toBe('denied');
    expect((classifyStorageFailure(400, JSON.stringify({ statusCode: '400', error: 'InvalidJWT', message: 'jwt expired' })) as TransferError).code).toBe('auth');
    expect((classifyStorageFailure(413, '') as TransferError).retryable).toBe(false);
    expect((classifyStorageFailure(503, 'oops') as TransferError).retryable).toBe(true);
  });

  test('finalize envelopes', () => {
    expect(parseFinalize({ attachment: { id: 'a', path: 'p', status: 'ready' } }).status).toBe('ready');
    expect(parseFinalize({ id: 'a', path: 'p', status: 'ready' }).attachment?.id).toBe('a');
    expect(parseFinalize({ status: 'rejected', reject_reason: 'executable' })).toEqual({ status: 'rejected', reason: 'executable', attachment: null });
    expect(rejectionSentence('executable')).toBe('This file is a program. Dek does not accept programs.');
    expect(rejectionSentence('p_mime: The file is really an executable.')).toBe('The file is really an executable.');
    expect(rejectionSentence('weird_code')).toBe('Dek could not accept this file (weird_code).');
  });
});
