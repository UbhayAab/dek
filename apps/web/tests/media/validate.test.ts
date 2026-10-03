import { describe, expect, test } from 'vitest';
import {
  FILE_MAX_BYTES, MB, VIDEO_MAX_BYTES, checkContent, extensionOf, formatBytes, resolveMime, sniffBytes, validateFile,
  type Accepted,
} from '../../src/features/media/validate';

const f = (name: string, type: string, size = 1000) => ({ name, type, size });

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
}

function pe(): Uint8Array {
  const b = new Uint8Array(256);
  b[0] = 0x4d; b[1] = 0x5a;
  b[0x3c] = 0x80;
  b.set([0x50, 0x45, 0x00, 0x00], 0x80);
  return b;
}

describe('validateFile: name, type and size before any byte is read', () => {
  test('accepts the CONTRACT 2.7 allow-list', () => {
    for (const [name, type] of [
      ['photo.jpg', 'image/jpeg'], ['shot.PNG', 'image/png'], ['a.gif', 'image/gif'], ['a.webp', 'image/webp'],
      ['IMG_1.HEIC', 'image/heic'], ['clip.mp4', 'video/mp4'], ['clip.webm', 'video/webm'], ['clip.mov', 'video/quicktime'],
      ['song.mp3', 'audio/mpeg'], ['note.m4a', 'audio/mp4'], ['v.ogg', 'audio/ogg'], ['voice-note.webm', 'audio/webm;codecs=opus'],
      ['a.wav', 'audio/wav'], ['a.aac', 'audio/aac'], ['report.pdf', 'application/pdf'], ['notes.txt', 'text/plain'],
      ['data.csv', 'text/csv'], ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['old.doc', 'application/msword'], ['bundle.zip', 'application/zip'],
    ] as const) {
      const v = validateFile(f(name, type));
      expect(v.ok, name).toBe(true);
    }
  });

  test('names the type from the extension when the browser did not, and undoes Excel calling csv a spreadsheet', () => {
    expect(resolveMime('scan.pdf', '')).toBe('application/pdf');
    expect(resolveMime('photo.heic', 'application/octet-stream')).toBe('image/heic');
    expect(resolveMime('list.csv', 'application/vnd.ms-excel')).toBe('text/csv');
    const v = validateFile(f('IMG_2.heic', ''));
    expect(v.ok && v.family).toBe('image');
  });

  test('refuses programs, scripts, web pages and macro documents by extension, whatever the type says', () => {
    for (const name of ['setup.exe', 'invoice.pdf.exe', 'run.bat', 'x.ps1', 'app.apk', 'page.html', 'logo.svg', 'budget.xlsm', 'tool.msi', 'a.js', 'disk.iso']) {
      const v = validateFile(f(name, 'application/pdf'));
      expect(v.ok, name).toBe(false);
      if (!v.ok) {
        expect(v.reason).toBe('blocked');
        expect(v.message).toMatch(/program, script or web page/);
      }
    }
  });

  test('a right-to-left override cannot dress an exe up as a jpg', () => {
    const v = validateFile(f('photo‮gpj.exe', 'image/jpeg'));
    expect(v.ok).toBe(false);
    expect(extensionOf('photo‮gpj.exe')).toBe('exe');
  });

  test('refuses blocked types even with a harmless name', () => {
    expect(validateFile(f('readme', 'application/x-msdownload')).ok).toBe(false);
    expect(validateFile(f('note.txt', 'text/html')).ok).toBe(false);
  });

  test('refuses types outside the allow-list with the sentence of what is accepted', () => {
    const v = validateFile(f('design.psd', 'image/vnd.adobe.photoshop'));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('unsupported');
      expect(v.message).toContain('Dek takes photos, videos, audio, PDF');
    }
    expect(validateFile(f('archive.tar.gz', 'application/gzip')).ok).toBe(false);
  });

  test('size limits: 25 MB for files, 100 MB for video, empty refused', () => {
    expect(validateFile(f('big.pdf', 'application/pdf', FILE_MAX_BYTES)).ok).toBe(true);
    const over = validateFile(f('big.pdf', 'application/pdf', FILE_MAX_BYTES + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe('too_large');
      expect(over.message).toContain('25 MB');
    }
    expect(validateFile(f('long.mp4', 'video/mp4', VIDEO_MAX_BYTES)).ok).toBe(true);
    const vid = validateFile(f('long.mp4', 'video/mp4', VIDEO_MAX_BYTES + 1));
    expect(!vid.ok && vid.message).toContain('100 MB');
    // A 30 MB photo is refused before it is read (LESSONS: no reading over-size files).
    expect(validateFile(f('huge.jpg', 'image/jpeg', 30 * MB)).ok).toBe(false);
    const empty = validateFile(f('empty.txt', 'text/plain', 0));
    expect(!empty.ok && empty.reason).toBe('empty');
    const unnamed = validateFile(f('   ', 'text/plain'));
    expect(!unnamed.ok && unnamed.reason).toBe('unnamed');
  });

  test('formatBytes reads like a person wrote it', () => {
    expect(formatBytes(12)).toBe('12 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB');
    expect(formatBytes(42 * MB)).toBe('42 MB');
  });
});

describe('sniffBytes: what the first bytes really are', () => {
  test('images, video, documents', () => {
    expect(sniffBytes(bytes([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(sniffBytes(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ kind: 'image', mime: 'image/png' });
    expect(sniffBytes(bytes('GIF89a'))).toEqual({ kind: 'image', mime: 'image/gif' });
    expect(sniffBytes(bytes('RIFF', [0, 0, 0, 0], 'WEBP'))).toEqual({ kind: 'image', mime: 'image/webp' });
    expect(sniffBytes(bytes([0, 0, 0, 24], 'ftypheic'))).toEqual({ kind: 'image', mime: 'image/heic' });
    expect(sniffBytes(bytes([0, 0, 0, 24], 'ftypavif'))).toEqual({ kind: 'image', mime: 'image/avif' });
    expect(sniffBytes(bytes([0, 0, 0, 24], 'ftypisom'))).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(sniffBytes(bytes([0, 0, 0, 20], 'ftypqt  '))).toEqual({ kind: 'video', mime: 'video/quicktime' });
    expect(sniffBytes(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toEqual({ kind: 'video', mime: 'video/webm' });
    expect(sniffBytes(bytes('%PDF-1.7'))).toEqual({ kind: 'pdf' });
    expect(sniffBytes(bytes([0x50, 0x4b, 0x03, 0x04]))).toEqual({ kind: 'zip' });
  });

  test('programs and scripts', () => {
    expect(sniffBytes(pe())).toEqual({ kind: 'program', label: 'a Windows program' });
    expect(sniffBytes(bytes([0x7f], 'ELF', [2, 1, 1]))).toEqual({ kind: 'program', label: 'a Linux program' });
    expect(sniffBytes(bytes([0xcf, 0xfa, 0xed, 0xfe]))).toMatchObject({ kind: 'program' });
    expect(sniffBytes(bytes([0x00, 0x61, 0x73, 0x6d]))).toMatchObject({ kind: 'program' });
    expect(sniffBytes(bytes('#!/bin/sh\nrm -rf /'))).toEqual({ kind: 'script' });
    expect(sniffBytes(bytes([0xef, 0xbb, 0xbf], '  <!DOCTYPE html><html>'))).toEqual({ kind: 'webpage' });
    expect(sniffBytes(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toEqual({ kind: 'webpage' });
    expect(sniffBytes(bytes('Just some notes'))).toEqual({ kind: 'unknown' });
  });
});

describe('checkContent: the bytes must agree with the name', () => {
  const jpeg = validateFile(f('holiday.jpg', 'image/jpeg')) as Accepted;
  const pdf = validateFile(f('report.pdf', 'application/pdf')) as Accepted;
  const txt = validateFile(f('notes.txt', 'text/plain')) as Accepted;

  test('a Windows program renamed photo.jpg is refused and the message says so', () => {
    const v = checkContent('holiday.jpg', jpeg, sniffBytes(pe()));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('blocked');
      expect(v.message).toBe('holiday.jpg is really a Windows program disguised as a photo. Dek does not accept programs.');
    }
  });

  test('programs disguised as documents and scripts disguised as text are refused', () => {
    expect(checkContent('report.pdf', pdf, sniffBytes(pe())).ok).toBe(false);
    expect(checkContent('notes.txt', txt, sniffBytes(bytes('#!/usr/bin/env python'))).ok).toBe(false);
    expect(checkContent('notes.txt', txt, sniffBytes(bytes('<html><script>alert(1)</script>'))).ok).toBe(false);
  });

  test('a PNG saved as .jpg goes up under its real type', () => {
    const v = checkContent('holiday.jpg', jpeg, sniffBytes(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    expect(v.ok && v.mime).toBe('image/png');
  });

  test('something that is not an image at all is not uploaded as a photo', () => {
    const v = checkContent('holiday.jpg', jpeg, sniffBytes(bytes('hello there')));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/not a photo Dek can read/);
  });

  test('ordinary documents pass untouched', () => {
    expect(checkContent('report.pdf', pdf, sniffBytes(bytes('%PDF-1.4')))).toEqual(pdf);
    expect(checkContent('notes.txt', txt, sniffBytes(bytes('Meeting at 4 pm')))).toEqual(txt);
  });
});
