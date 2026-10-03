import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMentions, convertScope, cardText, quoteLine, normalizeLegacy, normalizeNew, cardInner } from '../lib/text.mjs';
import { uuidv5, tsKey, safeFileName, plain, contrastWithWhite, safeError, maxTs } from '../lib/util.mjs';
import { deviceLabel } from '../lib/ua.mjs';
import { mapCursor } from '../lib/transform-state.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const people = new Map([[A, { username: 'asha', display_name: 'Asha Kumar' }], [B, { username: 'ram', display_name: 'Ram' }]]);

test('mentions convert by longest match at word edges, only for the given ids', () => {
  const r = convertMentions('Hi @Asha Kumar and @asha, cc @ramesh, @Ram. mail x@asha.com', [A, B], people);
  assert.equal(r.text, `Hi <@${A}> and <@${A}>, cc @ramesh, <@${B}>. mail x@asha.com`);
  assert.deepEqual([...r.matched].sort(), [A, B]);
});

test('a character whose lowercase is longer does not shift the replacement', () => {
  // U+0130 lowercases to two code units; the text around the mention must survive intact.
  assert.equal(convertMentions('İstanbul @Ram ok', [B], people).text, `İstanbul <@${B}> ok`);
});

test('a mention of someone not in mention_user_ids stays plain text', () => {
  assert.equal(convertMentions('ask @ram', [A], people).text, 'ask @ram');
});

test('mention matching is case-insensitive and keeps the rest of the text', () => {
  assert.equal(convertMentions('@ASHA KUMAR: done', [A], people).text, `<@${A}>: done`);
});

test('@here and @channel become scope tokens only at word boundaries', () => {
  assert.equal(convertScope('@here now, @channel; not@here @hereby'), '<!here> now, <!channel>; not@here @hereby');
});

test('form and poll cards become readable text', () => {
  assert.deepEqual(cardText({ type: 'form', title: 'Intake' }, 'Intake'), { kind: 'form', text: 'Form: Intake (form retired)' });
  assert.equal(cardText({ text: 'hi' }, 'hi'), null);
  assert.equal(cardInner({ type: 'form', title: 'Intake' }, 'x'), 'Intake');
});

test('quote lines follow the legacy preview rules', () => {
  assert.equal(quoteLine({ body_text: '**Hi**   there > x', attachments: [] }, 'Ram'), '> Ram: Hi there x');
  assert.equal(quoteLine({ body_text: '', attachments: [{}] }, 'Ram'), '> Ram: [attachment]');
  assert.equal(quoteLine({ body_text: 'x', deleted_at: '2026-01-01' }, 'Ram'), '> Ram: (deleted message)');
  assert.equal(quoteLine(null, null), '> (original message unavailable)');
  assert.equal(plain('a'.repeat(100), 90).length, 90);
});

test('normalised legacy and new text hash the same', () => {
  const legacy = normalizeLegacy('hello @Asha Kumar @here', [A], people);
  const fresh = normalizeNew(`> Ram: earlier\nhello <@${A}> <!here>`, { legacy: { reply_to: B } });
  assert.equal(legacy, fresh);
  assert.equal(normalizeNew('Form: Intake (form retired)', { legacy: { card: 'form' } }), 'Intake');
});

test('uuid v5 is stable and well formed', () => {
  const a = uuidv5('x', 'fa7ada46-c9d2-4262-9b01-874a53974e97');
  assert.equal(a, uuidv5('x', 'fa7ada46-c9d2-4262-9b01-874a53974e97'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, uuidv5('y', 'fa7ada46-c9d2-4262-9b01-874a53974e97'));
});

test('timestamp keys order every PostgreSQL output form', () => {
  assert.ok(tsKey('2026-09-26 17:13:02+00') < tsKey('2026-09-26 17:13:02.1+00'));
  assert.ok(tsKey('2026-09-26T17:13:02.30805+00:00') < tsKey('2026-09-26 17:13:02.308055+00'));
  assert.equal(tsKey('2026-09-26 17:13:02.5+00'), tsKey('2026-09-26T17:13:02.500000+00:00'));
  assert.equal(maxTs(null, '2026-01-02 00:00:00+00', '2026-01-01 00:00:00+00'), '2026-01-02 00:00:00+00');
});

test('file names become storage safe', () => {
  assert.equal(safeFileName('Report (final) é.PDF'), 'Report-final-e.PDF');
  assert.equal(safeFileName('', 'jpg'), 'file.jpg');
  assert.equal(safeFileName('voice note', 'webm'), 'voice-note.webm');
  assert.ok(safeFileName(`${'a'.repeat(300)}.png`).length <= 100);
});

test('brand colors pass 4.5:1 with white text', () => {
  assert.ok(contrastWithWhite('#0F766E') >= 4.5);
  assert.ok(contrastWithWhite('#7C3AED') >= 4.5);
  assert.ok(contrastWithWhite('#FFFF00') < 4.5);
});

test('errors never carry row data or addresses', () => {
  const s = safeError({ code: '23505', message: 'dup key a@b.com', detail: 'Key (email)=(a@b.com) exists', constraint: 'x' });
  assert.ok(!s.includes('a@b.com'));
  assert.ok(!s.includes('Key (email)'));
});

test('device labels name browser and OS only', () => {
  const android = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
  assert.deepEqual(deviceLabel(android, 'https://fcm.googleapis.com/fcm/send/x'), { label: 'Chrome on Android', platform: 'android' });
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  assert.deepEqual(deviceLabel(iphone, 'https://web.push.apple.com/x'), { label: 'Safari on iOS', platform: 'ios' });
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0';
  assert.equal(deviceLabel(edge, '').label, 'Edge on Windows');
  assert.equal(deviceLabel(null, 'https://updates.push.services.mozilla.com/x').label, 'Firefox');
});

test('read cursors map to the highest new seq at or below the legacy cursor', () => {
  // legacy seqs with gaps: 2, 5, 9 -> new 1, 2, 3
  const order = [{ src: 'c', legacySeq: 2, seq: 1 }, { src: 'c', legacySeq: 5, seq: 2 }, { src: 'c', legacySeq: 9, seq: 3 }];
  assert.equal(mapCursor(order, () => 0), 0);
  assert.equal(mapCursor(order, () => 4), 1);
  assert.equal(mapCursor(order, () => 5), 2);
  assert.equal(mapCursor(order, () => 100), 3);
});

test('a merged DM cursor is the longest prefix read in both conversations', () => {
  const order = [{ src: 'x', legacySeq: 1, seq: 1 }, { src: 'y', legacySeq: 1, seq: 2 }, { src: 'x', legacySeq: 2, seq: 3 }];
  assert.equal(mapCursor(order, (s) => ({ x: 2, y: 0 })[s]), 1);
  assert.equal(mapCursor(order, (s) => ({ x: 2, y: 1 })[s]), 3);
  assert.equal(mapCursor(order, (s) => ({ x: 1, y: 1 })[s]), 2);
});
