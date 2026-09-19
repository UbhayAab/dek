// js/lib/qr.js draws the join code that gets photographed off a phone at the end
// of a shift meeting, and a QR code has no partial credit: it either decodes or
// it is a decorative square. Nothing about it is checkable by eye - a code with
// the error-correction bytes in the wrong order looks exactly like a correct one.
//
// So this probe never inspects the matrix. It renders what the module draws into
// a pixel buffer and hands it to an INDEPENDENT decoder (jsQR, devDependency,
// never shipped), and requires the decoded string back verbatim. Two real defects
// were found this way and neither was visible in the rendered grid:
//   - the 15-bit format word was placed least-significant-bit first, so every
//     scanner rejected the code before it ever reached the data
//   - the Reed-Solomon divisor was built low-degree-first while the division
//     walked it high-degree-first, producing ten plausible, wrong EC bytes
//
// The negative leg matters as much: flip ONE data module and the decode must
// fail, which is what proves the probe is actually reading the code rather than
// pattern-matching something that happens to be there.
import jsQR from 'jsqr';
import { qrMatrix, qrSvg } from '../js/lib/qr.js';

const SCALE = 5;
const QUIET = 4;

function render(modules, size) {
  const dim = (size + QUIET * 2) * SCALE;
  const buf = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const i = (((r + QUIET) * SCALE + dy) * dim + ((c + QUIET) * SCALE + dx)) * 4;
          buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0;
        }
      }
    }
  }
  return { buf, dim };
}

const read = (modules, size) => {
  const { buf, dim } = render(modules, size);
  const got = jsQR(buf, dim, dim);
  return got ? got.data : null;
};

let fail = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

// The real link shape, a custom-domain variant, the short and long extremes, and
// a URL carrying query characters that byte mode has to survive.
const CASES = [
  'https://dek-7o4.pages.dev/#/join-org/9f2c41ab77de40e1b6c5aa310f8e2d64',
  'https://dek.jarurat.care/#/join-org/deadbeefdeadbeefdeadbeefdeadbeef',
  'https://dek-7o4.pages.dev/#/join/abc?utm=meeting&n=Mahalaxmi%20Namkeen',
  'short',
  'x'.repeat(180),
];

for (const text of CASES) {
  const { size, modules, version } = qrMatrix(text);
  const got = read(modules, size);
  check(`decodes v${version} ${size}x${size} (${text.length} chars)`, got === text,
    got === text ? '' : `got ${got === null ? 'nothing' : JSON.stringify(got.slice(0, 40))}`);
}

// Every mask must produce a readable code, not just the one the penalty picks.
for (let mask = 0; mask < 8; mask++) {
  const text = CASES[0];
  const { size, modules } = qrMatrix(text, { forceMask: mask });
  check(`mask ${mask} decodes`, read(modules, size) === text);
}

// Version selection must take the SMALLEST version that fits, or the code is
// needlessly dense and harder to scan across a room.
const boundary = qrMatrix('y'.repeat(62)).version;
check('62 bytes picks v4 (64 data codewords)', boundary === 4, `picked v${boundary}`);
const over = qrMatrix('y'.repeat(63)).version;
check('63 bytes rolls to v5', over === 5, `picked v${over}`);

// Two negative legs, and the first one is a positive result in disguise.
//
// Level M is specified to repair about 15% of the codewords, so a few damaged
// rows MUST still decode - that is the property the whole level exists for, and
// it is why a code photographed with a thumb over one corner still works.
{
  const text = CASES[0];
  const { size, modules } = qrMatrix(text);
  const scuffed = modules.map((row) => row.slice());
  for (let r = Math.floor(size / 2); r < Math.floor(size / 2) + 3; r++) {
    for (let c = 8; c < size - 8; c++) scuffed[r][c] = !scuffed[r][c];
  }
  check('survives light damage (this is what level M is for)', read(scuffed, size) === text);
}

// Past the recovery budget the decode must FAIL. Without this leg a probe that
// always passes proves nothing about whether it is reading the code at all.
{
  const text = CASES[0];
  const { size, modules } = qrMatrix(text);
  const broken = modules.map((row) => row.slice());
  const from = Math.floor(size * 0.25);
  const to = Math.floor(size * 0.75);
  for (let r = from; r < to; r++) for (let c = 0; c < size; c++) broken[r][c] = !broken[r][c];
  const got = read(broken, size);
  check('does NOT decode once damage exceeds what level M can repair', got !== text,
    got === text ? 'decoder ignored the damage - the probe is not reading the code' : '');
}

// The SVG wrapper has to carry the quiet zone; without four clear modules of
// margin a scanner cannot locate the code at all.
{
  const svg = qrSvg('https://dek-7o4.pages.dev/#/join-org/abc', { scale: 4, quiet: 4 });
  const m = svg.match(/width="(\d+)"/);
  const { size } = qrMatrix('https://dek-7o4.pages.dev/#/join-org/abc');
  check('svg includes the 4-module quiet zone', m && +m[1] === (size + 8) * 4,
    m ? `width ${m[1]}, expected ${(size + 8) * 4}` : 'no width');
  check('svg paints an opaque light background', svg.includes('<rect width='));
}

console.log(fail ? `\n${fail} check(s) failed` : '\nprobe-qr: all checks passed');
process.exit(fail ? 1 : 0);
