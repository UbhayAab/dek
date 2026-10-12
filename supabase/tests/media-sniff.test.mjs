// The byte sniffer of media-finalize (supabase/functions/media-finalize/sniff.ts),
// run under Node directly (TypeScript types are stripped). Owner: [media]. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniff, judge, thumbOk, jpegScan, canonicalMime, familyOf, HEAD_BYTES } from '../functions/media-finalize/sniff.ts';
import * as files from './_media-files.mjs';

const head = (b) => new Uint8Array(b.subarray(0, HEAD_BYTES));
const look = (b) => sniff(head(b), b.length);
const verdict = (b, declared, storedType = declared) => judge(look(b), { declared, size: b.length, storedType });
const MB = 1024 * 1024;

test('images: type and size from the header', () => {
  assert.deepEqual(look(files.jpeg(64, 48)), { kind: 'match', label: 'JPEG image', mimes: ['image/jpeg'], width: 64, height: 48, jpegNext: undefined });
  const p = look(files.png(32, 24));
  assert.deepEqual([p.mimes, p.width, p.height], [['image/png'], 32, 24]);
  const g = look(files.gif(10, 7));
  assert.deepEqual([g.mimes, g.width, g.height], [['image/gif'], 10, 7]);
  const w = look(files.webp(300, 200));
  assert.deepEqual([w.mimes, w.width, w.height], [['image/webp'], 300, 200]);
  const h = look(files.heic(4032, 3024));
  assert.deepEqual([h.mimes, h.width, h.height], [['image/heic', 'image/heif'], 4032, 3024]);
  const a = look(files.heic(800, 600, 'avif'));
  assert.deepEqual([a.mimes, a.width, a.height], [['image/avif'], 800, 600]);
});

test('jpeg: a frame header past the first 64 KB is found by reading on', () => {
  const big = files.jpeg(320, 240, { padding: 90000 });
  const first = look(big);
  assert.equal(first.kind, 'match');
  assert.equal(first.width, undefined);
  assert.ok(first.jpegNext > HEAD_BYTES && first.jpegNext < big.length, 'says where to read on');
  const more = jpegScan(new Uint8Array(big.subarray(first.jpegNext, first.jpegNext + HEAD_BYTES)), 0, first.jpegNext);
  assert.deepEqual(more, { width: 320, height: 240 });
});

test('jpeg: dimensions follow all EXIF rotations in either byte order without rewriting bytes', () => {
  for (const bigEndian of [false, true]) {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const b = files.exifJpeg(files.jpeg(64, 48), orientation, bigEndian);
      const s = look(b);
      assert.deepEqual([s.width, s.height], orientation >= 5 ? [48, 64] : [64, 48]);
      assert.equal(s.jpegOrientation, orientation);
      assert.equal(verdict(b, 'image/jpeg').ok, true);
    }
  }
});

test('jpeg: malformed EXIF offsets, types, counts and orientations are ignored safely', () => {
  for (const mutate of [
    (b) => b.writeUInt32LE(0xffffffff, 16),
    (b) => b.writeUInt16LE(4, 24),
    (b) => b.writeUInt32LE(2, 26),
    (b) => b.writeUInt16LE(9, 30),
    (b) => b.write('ZZ', 12, 'latin1'),
    (b) => b.writeUInt16LE(0, 14),
  ]) {
    const b = files.exifJpeg(files.jpeg(64, 48), 6);
    mutate(b);
    assert.deepEqual([look(b).width, look(b).height], [64, 48]);
  }
});

test('jpeg: rotation survives range continuation and an APP1 split at the range edge', () => {
  const b = files.exifJpeg(files.jpeg(64, 48, { padding: 90000 }), 6);
  const first = look(b);
  const more = jpegScan(head(b.subarray(first.jpegNext)), 0, first.jpegNext, first.jpegOrientation);
  assert.deepEqual([more.width, more.height], [48, 64]);

  const photo = files.exifJpeg(files.jpeg(64, 48), 8);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, 0xe8]), Buffer.alloc(65510, 32)]);
  const split = Buffer.concat([photo.subarray(0, 2), comment, photo.subarray(2)]);
  const partial = look(split);
  const aligned = jpegScan(head(split.subarray(partial.jpegNext)), 0, partial.jpegNext);
  assert.deepEqual([aligned.width, aligned.height], [48, 64]);
});

test('video and audio containers, with duration and picture size where the header has them', () => {
  const m = look(files.mp4());
  assert.deepEqual([m.mimes, m.width, m.height, m.durationMs], [['video/mp4', 'audio/mp4'], 640, 360, 12345]);
  assert.deepEqual(look(files.mp4({ major: 'qt  ', compat: ['qt  '] })).mimes, ['video/quicktime']);
  assert.deepEqual(look(files.mp4({ major: 'M4A ', compat: ['M4A ', 'mp42', 'isom'] })).mimes, ['audio/mp4']);
  assert.deepEqual(look(files.mp4({ major: 'mp42', compat: ['isom'] })).mimes, ['video/mp4', 'audio/mp4']);
  const w = look(files.webm({ durationMs: 5000 }));
  assert.deepEqual([w.mimes, w.durationMs], [['video/webm', 'audio/webm'], 5000]);
  const wav = look(files.wav(2000));
  assert.deepEqual([wav.mimes, wav.durationMs], [['audio/wav'], 2000]);
  assert.deepEqual(look(files.ogg()).mimes, ['audio/ogg']);
  assert.deepEqual(look(files.mp3()).mimes, ['audio/mpeg']);
  assert.deepEqual(look(files.mp3({ tag: false })).mimes, ['audio/mpeg']);
  assert.deepEqual(look(files.aac()).mimes, ['audio/aac']);
});

test('documents: pdf, Office (new and 97-2003), OpenDocument, zip', () => {
  assert.deepEqual(look(files.pdf()).mimes, ['application/pdf']);
  assert.equal(look(files.docx()).mimes[0], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(look(files.zip([['[Content_Types].xml', 'x'], ['xl/workbook.xml', 'x']])).mimes[0],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(look(files.zip([['[Content_Types].xml', 'x'], ['ppt/presentation.xml', 'x']])).mimes[0],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(look(files.odt()).mimes[0], 'application/vnd.oasis.opendocument.text');
  assert.deepEqual(look(files.ole()).mimes, ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint']);
  assert.deepEqual(look(files.zip([['notes.txt', 'hello'], ['photos/a.jpg', files.jpeg()]])).mimes, ['application/zip']);
});

test('text: UTF-8 without NUL bytes, any language; a 64 KB cut inside a character is fine', () => {
  for (const s of ['hello, world\n', 'name,amount\nPriya,1200\n', '﻿with a BOM', 'नमस्ते दुनिया\n',
    'MZ is a postcode prefix, not a program\n']) {
    assert.deepEqual(look(Buffer.from(s, 'utf8')).mimes, ['text/plain', 'text/csv'], s);
  }
  const long = Buffer.from('न'.repeat(30000), 'utf8');   // 3 bytes each: the 64 KB read ends mid-character
  assert.equal(long.length > HEAD_BYTES, true);
  assert.equal(look(long).kind, 'match');
  assert.equal(look(Buffer.from([0x63, 0x61, 0x66, 0xc3, 0x28])).reason, 'not_utf8');
  assert.equal(look(Buffer.from('﻿hi', 'utf16le')).reason, 'not_utf8');
  assert.equal(look(Buffer.from([0x61, 0x00, 0x62])).reason, 'unknown_type');
  assert.equal(look(Buffer.alloc(0)).reason, 'empty');
});

test('programs, scripts, macros and web pages are blocked whatever they are called', () => {
  const blocked = (b, reason) => {
    const s = look(b);
    assert.equal(s.kind, 'blocked', s.label);
    assert.equal(s.reason, reason, s.label);
  };
  blocked(files.exe(), 'executable');
  blocked(files.elf(), 'executable');
  blocked(files.macho(), 'executable');
  blocked(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]), 'executable');
  blocked(Buffer.from('#!/bin/sh\nrm -rf ~\n'), 'executable');
  blocked(Buffer.from('﻿#!/usr/bin/env python\n'), 'executable');
  blocked(Buffer.from('dex\n035\0'), 'executable');
  blocked(files.zip([['META-INF/MANIFEST.MF', 'Main-Class: X'], ['X.class', 'x']]), 'executable');
  blocked(files.zip([['AndroidManifest.xml', 'x'], ['classes.dex', 'x']]), 'executable');
  blocked(files.docx([['word/vbaProject.bin', 'x']]), 'macro');
  blocked(files.zip([['invoice.pdf.exe', files.exe()]]), 'archive_program');
  blocked(files.zip([['docs/readme.txt', 'x'], ['docs/setup.js', 'x']]), 'archive_program');
  // an old Windows zip tool writes names in code page 437, not UTF-8 ("résumé.exe")
  blocked(files.zip([[Buffer.from([0x72, 0x82, 0x73, 0x75, 0x6d, 0x82, 0x2e, 0x65, 0x78, 0x65]), files.exe()]]), 'archive_program');
  blocked(Buffer.from('<!DOCTYPE html><html><script>alert(1)</script>'), 'web_page');
  blocked(Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">'), 'web_page');
  blocked(Buffer.from('<?xml version="1.0"?>\n<svg><script>x</script></svg>'), 'web_page');
});

test('judge: the declared type picks among what the bytes allow; families must match', () => {
  assert.deepEqual(verdict(files.png(32, 24), 'image/jpeg'),
    { ok: true, mime: 'image/png', family: 'image', width: 32, height: 24, durationMs: undefined }, 'a PNG called .jpg is still a photo');
  assert.equal(verdict(files.mp4(), 'audio/mp4').mime, 'audio/mp4');
  assert.deepEqual(verdict(files.mp4(), 'video/mp4'),
    { ok: true, mime: 'video/mp4', family: 'video', width: 640, height: 360, durationMs: 12345 });
  assert.equal(verdict(files.mp4(), 'video/quicktime').mime, 'video/mp4');
  const voice = verdict(files.webm(), 'audio/webm;codecs=opus');
  assert.deepEqual([voice.mime, voice.durationMs, voice.width], ['audio/webm', 5000, undefined]);
  assert.equal(verdict(Buffer.from('a,b\n1,2\n'), 'text/csv').mime, 'text/csv');
  assert.equal(verdict(files.docx(), 'application/zip').mime, 'application/zip');
  assert.equal(verdict(files.ole(), 'application/vnd.ms-excel').mime, 'application/vnd.ms-excel');
  assert.equal(verdict(files.heic(), 'image/heif').mime, 'image/heif');

  const refused = (v, reason) => { assert.equal(v.ok, false); assert.equal(v.reason, reason); assert.ok(v.message); };
  refused(verdict(files.jpeg(), 'application/pdf'), 'type_mismatch');
  refused(verdict(files.pdf(), 'image/png'), 'type_mismatch');
  refused(verdict(files.exe(), 'image/jpeg'), 'executable');
  refused(verdict(files.webm({ doctype: 'matroska' }), 'video/webm'), 'not_allowed');
  refused(verdict(files.mp4({ major: '3gp4', compat: ['3gp4'] }), 'video/mp4'), 'not_allowed');
  refused(verdict(files.ogg('theora'), 'audio/ogg'), 'not_allowed');
  refused(verdict(Buffer.from([1, 2, 3, 0, 4]), 'application/pdf'), 'unknown_type');
});

test('judge: size limits and the type Storage will serve', () => {
  const s = look(files.jpeg());
  assert.equal(judge(s, { declared: 'image/jpeg', size: 25 * MB, storedType: 'image/jpeg' }).ok, true);
  assert.equal(judge(s, { declared: 'image/jpeg', size: 25 * MB + 1, storedType: 'image/jpeg' }).reason, 'too_large');
  const v = look(files.mp4());
  assert.equal(judge(v, { declared: 'video/mp4', size: 100 * MB, storedType: 'video/mp4' }).ok, true);
  assert.equal(judge(v, { declared: 'video/mp4', size: 100 * MB + 1, storedType: 'video/mp4' }).reason, 'too_large');
  assert.equal(judge(v, { declared: 'audio/mp4', size: 30 * MB, storedType: 'audio/mp4' }).reason, 'too_large');
  // Storage serves with the upload's content type: never a web page or a script
  for (const t of ['text/html', 'image/svg+xml', 'application/javascript', 'application/octet-stream', null]) {
    assert.equal(judge(s, { declared: 'image/jpeg', size: 100, storedType: t }).reason, 'content_type', String(t));
  }
  assert.equal(judge(look(Buffer.from('x')), { declared: 'text/plain', size: 1, storedType: 'text/plain;charset=UTF-8' }).ok, true);
});

test('thumbnails: a small still image served as an image', () => {
  const small = files.png(16, 16);
  assert.equal(thumbOk(look(small), small.length, 'image/webp'), true);
  assert.equal(thumbOk(look(files.jpeg()), 2 * MB, 'image/jpeg'), true);
  assert.equal(thumbOk(look(files.jpeg()), 2 * MB + 1, 'image/jpeg'), false);
  assert.equal(thumbOk(look(small), small.length, 'text/html'), false);
  assert.equal(thumbOk(look(files.pdf()), 100, 'image/webp'), false);
  assert.equal(thumbOk(look(files.exe()), 100, 'image/webp'), false);
});

test('mime spelling: aliases fold, parameters drop, the allow-list matches the SQL one', () => {
  assert.equal(canonicalMime(' Audio/X-M4A; foo=bar'), 'audio/mp4');
  assert.equal(canonicalMime('image/jpg'), 'image/jpeg');
  assert.equal(familyOf('application/x-zip-compressed'), 'archive');
  assert.equal(familyOf('image/svg+xml'), null);
  assert.equal(familyOf('text/html'), null);
});
