import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FunctionResult } from '../../src/features/media/transfer';

const invoke = vi.fn<(name: string, body: unknown) => Promise<FunctionResult>>();
vi.mock('../../src/features/media/transfer', () => ({ invokeFunction: (name: string, body: unknown) => invoke(name, body) }));

const { mintSignedUrls, SignError } = await import('../../src/features/media/sign');

beforeEach(() => invoke.mockReset());

describe('mintSignedUrls: the one way media links are made', () => {
  test('asks media-sign for the paths and maps its answer', async () => {
    invoke.mockResolvedValue({ ok: true, data: { urls: { 'o/c/a/1.jpg': 'https://x/sign/1?token=t' }, expires_at: '2026-10-04T10:15:00.000Z' } });
    const r = await mintSignedUrls(['o/c/a/1.jpg', 'o/c/b/2.jpg']);
    expect(invoke).toHaveBeenCalledWith('media-sign', { paths: ['o/c/a/1.jpg', 'o/c/b/2.jpg'] });
    expect(r.map((x) => x.url)).toEqual(['https://x/sign/1?token=t', null]);
  });

  test('401 means the session ended; a dropped connection and server errors are told apart', async () => {
    invoke.mockResolvedValueOnce({ ok: false, kind: 'http', status: 401, body: {} });
    await expect(mintSignedUrls(['a'])).rejects.toMatchObject({ code: 'auth' });
    invoke.mockResolvedValueOnce({ ok: false, kind: 'network' });
    await expect(mintSignedUrls(['a'])).rejects.toMatchObject({ code: 'network' });
    invoke.mockResolvedValueOnce({ ok: false, kind: 'http', status: 502, body: {} });
    await expect(mintSignedUrls(['a'])).rejects.toBeInstanceOf(SignError);
  });

  test('never more than 100 paths in one call, and nothing to sign is no call at all', async () => {
    await expect(mintSignedUrls(Array.from({ length: 101 }, (_, i) => `p/${i}`))).rejects.toBeInstanceOf(SignError);
    expect(await mintSignedUrls([])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
