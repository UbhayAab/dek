import { afterEach, expect, test, vi } from 'vitest';
import { prepareFile } from '../../src/features/media/prepare';

afterEach(() => vi.unstubAllGlobals());

function decoder() {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close })));
  const encode = vi.fn(async () => new Blob(['preview'], { type: 'image/webp' }));
  const sizes: number[][] = [];
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width: number, height: number) { sizes.push([width, height]); }
    getContext() { return { drawImage() {} }; }
    convertToBlob = encode;
  });
  return { encode, sizes, close };
}

test.each(['jpeg', 'png', 'webp', 'avif', 'heic', 'heif', 'gif'])(
  '%s retains the exact original Blob, format, name and full dimensions above the former compression threshold', async (format) => {
    const { encode, sizes, close } = decoder();
    const mime = `image/${format}`;
    const file = new Blob([new Uint8Array(500_000)], { type: mime });
    const result = await prepareFile(file, `art.${format}`, mime, 'image');
    expect(result.blob).toBe(file);
    expect(result.name).toBe(`art.${format}`);
    expect(result.mime).toBe(mime);
    expect([result.width, result.height]).toEqual([4000, 3000]);
    expect(close).toHaveBeenCalledOnce();
    if (format === 'gif') {
      expect(encode).not.toHaveBeenCalled();
      expect(result.thumb).toBeNull();
    } else {
      expect(sizes).toEqual([[640, 480]]);
      expect(encode).toHaveBeenCalledOnce();
      expect(result.thumb?.type).toBe('image/webp');
    }
  },
);

test('an unsupported decoder retains a downloadable original', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported format'); }));
  const file = new Blob(['HEIC original'], { type: 'image/heic' });
  const result = await prepareFile(file, 'phone.heic', file.type, 'image');
  expect(result.blob).toBe(file);
  expect(result.name).toBe('phone.heic');
  expect(result.mime).toBe('image/heic');
  expect(result.thumb).toBeNull();
});

test('a thumbnail encoder failure does not lose the original or prevent upload', async () => {
  const { encode } = decoder();
  encode.mockRejectedValue(new Error('out of memory'));
  // Prevent the encoder's DOM fallback from providing another canvas.
  vi.spyOn(document, 'createElement').mockImplementation(() => { throw new Error('canvas unavailable'); });
  const file = new Blob(['original'], { type: 'image/png' });
  const result = await prepareFile(file, 'design.png', file.type, 'image');
  expect(result.blob).toBe(file);
  expect([result.width, result.height]).toEqual([4000, 3000]);
  expect(result.thumb).toBeNull();
});

test('removing a file during decoding aborts preparation and releases the bitmap', async () => {
  const { close } = decoder();
  const controller = new AbortController();
  const pending = prepareFile(new Blob(['original']), 'design.png', 'image/png', 'image', controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(close).toHaveBeenCalledOnce();
});
