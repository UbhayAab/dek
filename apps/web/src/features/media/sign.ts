// THE one place Dek mints links for private media (DEK11). Everything that shows
// or downloads a file gets its URL from the cache in hooks.ts, which calls this,
// at most 100 paths per call. The media-sign function checks per path that the
// person may read the channel and answers with links that live 20 minutes (shared
// while 10 or more are left); paths it leaves out are not available to this
// person. Ready media is never signed through
// Storage directly (the storage read policy only lets the uploader of a pending
// object mint links).
import { invokeFunction } from './transfer';
import { BATCH_MAX, parseMediaSign, type MintResult } from './signedUrls';

export class SignError extends Error {
  readonly code: 'auth' | 'network' | 'server';

  constructor(code: 'auth' | 'network' | 'server', message: string) {
    super(message);
    this.name = 'SignError';
    this.code = code;
  }
}

export async function mintSignedUrls(paths: string[]): Promise<MintResult[]> {
  if (!paths.length) return [];
  if (paths.length > BATCH_MAX) throw new SignError('server', `At most ${BATCH_MAX} files at a time.`);
  const res = await invokeFunction('media-sign', { paths });
  if (res.ok) return parseMediaSign(paths, res.data);
  if (res.kind === 'network') throw new SignError('network', 'The connection dropped.');
  if (res.kind === 'http' && res.status === 401) throw new SignError('auth', 'Your session ended.');
  throw new SignError('server', 'Files could not be prepared.');
}
