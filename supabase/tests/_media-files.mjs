// Real media bytes for the media tests, made in code so no binary fixtures live in the
// repo. Owner: [media]. The JPEG is a genuine baseline JPEG (a mid-grey picture,
// decodable by any viewer); the containers carry exactly the headers the sniffer
// reads (supabase/functions/media-finalize/sniff.ts).
import { deflateSync, crc32 } from 'node:zlib';

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const bytes = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'latin1'));

// ------------------------------------------------------------------ images

// Add a genuine IFD0 orientation without re-encoding any JPEG pixels.
export function exifJpeg(jpegBytes, orientation, bigEndian = false) {
  const payload = Buffer.alloc(32);
  payload.write('Exif\0\0', 0, 'latin1');
  payload.write(bigEndian ? 'MM' : 'II', 6, 'latin1');
  const short = (n, at) => bigEndian ? payload.writeUInt16BE(n, at) : payload.writeUInt16LE(n, at);
  const long = (n, at) => bigEndian ? payload.writeUInt32BE(n, at) : payload.writeUInt32LE(n, at);
  short(42, 8); long(8, 10); short(1, 14);
  short(0x0112, 16); short(3, 18); long(1, 20); short(orientation, 24);
  return Buffer.concat([jpegBytes.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 34]), payload, jpegBytes.subarray(2)]);
}

// Grey baseline JPEG, width and height multiples of 8. Each 8x8 block is "DC
// difference 0, end of block", two bits with one-symbol Huffman tables. `padding`
// bytes of comment segments push the frame header later in the file, the way a big
// EXIF block does on phone photos.
export function jpeg(width = 64, height = 48, { padding = 0 } = {}) {
  const seg = (marker, payload) => Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])));
  for (let left = padding; left > 0; left -= 60000) parts.push(seg(0xfe, Buffer.alloc(Math.min(60000, left), 0x20)));
  parts.push(seg(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)])));
  parts.push(seg(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])));
  const table = (cls) => Buffer.concat([Buffer.from([cls, 1]), Buffer.alloc(15, 0), Buffer.from([0x00])]);
  parts.push(seg(0xc4, Buffer.concat([table(0x00), table(0x10)])));
  parts.push(seg(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])));
  const bits = (width / 8) * (height / 8) * 2;
  const data = Buffer.alloc(Math.ceil(bits / 8), 0);
  const pad = data.length * 8 - bits;
  if (pad) data[data.length - 1] |= (1 << pad) - 1;
  parts.push(data, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

export function png(width = 32, height = 24) {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([u32(data.length), td, u32(crc32(td))]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * row + 1 + x * 3;
      raw[o] = (x * 8) & 255;
      raw[o + 1] = (y * 10) & 255;
      raw[o + 2] = 128;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function gif(width = 10, height = 7) {
  const b = Buffer.alloc(32, 0);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

export function webp(width = 300, height = 200) {
  const b = Buffer.alloc(30 + 64, 0);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

// ------------------------------------------------------------------ ISO media

const box = (type, ...payload) => {
  const p = Buffer.concat(payload.map(bytes));
  return Buffer.concat([u32(8 + p.length), Buffer.from(type, 'latin1'), p]);
};

export function heic(width = 4032, height = 3024, brand = 'heic') {
  return Buffer.concat([
    box('ftyp', brand, u32(0), 'mif1', brand),
    box('meta', u32(0), box('iprp', box('ipco', box('ispe', u32(0), u32(width), u32(height))))),
    Buffer.alloc(200)]);
}

export function mp4({ major = 'isom', compat = ['isom', 'iso2', 'avc1', 'mp41'], width = 640, height = 360,
                      timescale = 1000, duration = 12345 } = {}) {
  const mvhd = Buffer.alloc(100, 0);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(duration, 16);
  const tkhd = Buffer.alloc(84, 0);
  tkhd.writeUInt32BE(width * 65536, 76);
  tkhd.writeUInt32BE(height * 65536, 80);
  return Buffer.concat([
    box('ftyp', major, u32(0), ...compat),
    box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd))),
    box('mdat', Buffer.alloc(256, 7))]);
}

// ------------------------------------------------------------------ other containers

const vsize = (n) => (n < 127 ? Buffer.from([0x80 | n]) : Buffer.from([0x40 | (n >> 8), n & 0xff]));
const el = (id, data) => { const d = bytes(data); return Buffer.concat([Buffer.from(id), vsize(d.length), d]); };

export function webm({ doctype = 'webm', durationMs = 5000 } = {}) {
  const f = Buffer.alloc(8);
  f.writeDoubleBE(durationMs);
  return Buffer.concat([
    el([0x1a, 0x45, 0xdf, 0xa3], Buffer.concat([el([0x42, 0x86], Buffer.from([1])), el([0x42, 0x82], doctype)])),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    el([0x15, 0x49, 0xa9, 0x66], Buffer.concat([el([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])), el([0x44, 0x89], f)])),
    Buffer.alloc(100)]);
}

export function wav(ms = 2000, rate = 8000) {
  const dataLen = (rate * ms) / 1000;
  const b = Buffer.alloc(44 + dataLen, 128);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(dataLen, 40);
  return b;
}

export function ogg(codec = 'opus') {
  const packet = Buffer.from(codec === 'theora' ? '\x80theora' : 'OpusHead\x01\x01', 'latin1');
  const h = Buffer.alloc(27, 0);
  h.write('OggS', 0, 'latin1');
  h[5] = 2;
  h[26] = 1;
  return Buffer.concat([h, Buffer.from([packet.length]), packet, Buffer.alloc(64)]);
}

export function mp3({ tag = true } = {}) {
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
  const id3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0a', 'latin1'), Buffer.alloc(10)]);
  return Buffer.concat([tag ? id3 : Buffer.alloc(0), frame, frame]);
}

export function aac() {
  return Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), Buffer.alloc(64)]);
}

export function pdf() {
  return Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
}

export function ole() {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
}

// A stored (uncompressed) zip with a central directory: a real zip file.
export function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = bytes(content);
    const n = Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8');   // raw bytes: old code-page names
    const h = Buffer.alloc(30, 0);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc32(data), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    parts.push(h, n, data);
    const c = Buffer.alloc(46, 0);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22, 0);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export const docx = (extra = []) => zip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'], ['_rels/.rels', '<Relationships/>'],
  ['word/document.xml', '<w:document/>'], ...extra]);

export const odt = () => zip([
  ['mimetype', 'application/vnd.oasis.opendocument.text'], ['content.xml', '<office:document-content/>'],
  ['META-INF/manifest.xml', '<manifest/>']]);

// ------------------------------------------------------------------ things to refuse

// The start of a Windows program: an MZ header pointing at a PE signature.
export function exe() {
  const b = Buffer.alloc(1024, 0);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('This program cannot be run in DOS mode.', 0x4e, 'latin1');
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(0x14c, 0x84);
  return b;
}

export function elf() {
  return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), Buffer.alloc(57)]);
}

export function macho() {
  return Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), Buffer.alloc(56)]);
}
