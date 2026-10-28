// Opening and saving files inside the Android and iOS apps (docs/NATIVE.md): no
// blob or download links, the signed URL itself in the system browser.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Attachment, Message } from '../../src/api/types';

vi.mock('../../src/api/client', () => ({
  supabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    functions: {
      invoke: async (_name: string, opts: { body: { paths: string[] } }) => ({
        data: {
          urls: Object.fromEntries(opts.body.paths.map((p) => [p, `https://sb.test/storage/v1/object/sign/media/${p}?token=t`])),
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        },
        error: null,
      }),
    },
    storage: { from: () => ({}) },
  }),
  rpc: async () => { throw new Error('no rpc in tests'); },
  setAuthStorage: () => undefined,
}));

const { MessageAttachments } = await import('../../src/features/media');
const { openLinkProps, saveLinkProps, blobShareAllowed, opensWhere } = await import('../../src/features/media/fileLinks');
const { Lightbox } = await import('../../src/features/media/Lightbox');
const { urlCache } = await import('../../src/features/media/hooks');

// What the Capacitor shell injects before page scripts run (src/native/bridge.ts).
function nativeShell(platform: 'android' | 'ios'): () => void {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    PluginHeaders: [],
    nativePromise: async () => undefined,
  };
  return () => { delete (window as unknown as { Capacitor?: unknown }).Capacitor; };
}

const SIGNED = 'https://sb.test/storage/v1/object/sign/media/o/c/a/Budget_Q3.pdf?token=t';

const pdf: Attachment = {
  id: 'a1', file_name: 'Budget Q3.pdf', mime_type: 'application/pdf', size_bytes: 52_000, width: null, height: null,
  duration_ms: null, path: 'o/c/a/Budget_Q3.pdf', thumb_path: null, status: 'ready',
};
const photo: Attachment = {
  id: 'p1', file_name: 'site visit.jpg', mime_type: 'image/jpeg', size_bytes: 150_000, width: 1600, height: 1067,
  duration_ms: null, path: 'o/c/p/site_visit.jpg', thumb_path: 'o/c/p/thumb.webp', status: 'ready',
};
const message = (attachments: Attachment[]): Message => ({
  id: 'm1', org_id: 'o', channel_id: 'c', seq: 1, thread_root_id: null, author_id: 'u', kind: 'user', body: '', mentions: [],
  mention_all: false, client_id: null, created_at: '2026-10-04T10:00:00Z', edited_at: null, deleted_at: null,
  updated_at: '2026-10-04T10:00:00Z', reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments,
  pinned: false, also_in_channel: false, meta: {},
});

async function sweep() {
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

let undo: (() => void) | null = null;
afterEach(() => {
  cleanup();
  undo?.();
  undo = null;
  urlCache.clear();
});

describe('file links in a browser', () => {
  test('Download is a same-tab link Storage answers as an attachment; Open is a new tab', () => {
    expect(saveLinkProps(SIGNED, 'Budget Q3.pdf')).toEqual({ href: `${SIGNED}&download=Budget%20Q3.pdf`, download: 'Budget Q3.pdf' });
    expect(openLinkProps(SIGNED)).toEqual({ href: SIGNED, target: '_blank', rel: 'noopener noreferrer' });
    expect(opensWhere()).toBe('in a new tab');
    expect(blobShareAllowed()).toBe(true);
  });
});

describe('file links inside the Android and iOS apps', () => {
  test('saving goes to the system browser on the signed URL with download=<name>, never a download attribute', () => {
    undo = nativeShell('android');
    const props = saveLinkProps(SIGNED, 'Budget Q3.pdf');
    expect(props).toEqual({ href: `${SIGNED}&download=Budget%20Q3.pdf`, target: '_blank', rel: 'noopener noreferrer' });
    expect('download' in props).toBe(false);
    expect(openLinkProps(SIGNED)).toEqual({ href: SIGNED, target: '_blank', rel: 'noopener noreferrer' });
    expect(opensWhere()).toBe('in your browser');
    expect(blobShareAllowed()).toBe(false);
  });

  test('a file card opens and saves through the signed URL itself', async () => {
    undo = nativeShell('android');
    render(<MessageAttachments message={message([pdf])} attachments={[pdf]} />);
    await sweep();
    const open = screen.getByRole('link', { name: 'Open Budget Q3.pdf in your browser' });
    expect(open.getAttribute('href')).toBe(SIGNED);
    expect(open.getAttribute('target')).toBe('_blank');
    const save = screen.getByRole('link', { name: 'Download Budget Q3.pdf' });
    expect(save.getAttribute('href')).toBe(`${SIGNED}&download=Budget%20Q3.pdf`);
    expect(save.getAttribute('target')).toBe('_blank');
    expect(save.hasAttribute('download')).toBe(false);
    expect(document.body.innerHTML).not.toContain('blob:');
  });

  test('the photo viewer on an iPhone app saves through the browser and offers no blob share', async () => {
    undo = nativeShell('ios');
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
    const nav = navigator as unknown as { share?: unknown; canShare?: unknown };
    nav.share = vi.fn();
    nav.canShare = vi.fn(() => true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // jsdom has no showModal or close, like a WebView before iOS 15.4: the viewer
    // must still open and close without throwing.
    try {
      render(<Lightbox items={[photo]} index={0} onIndex={() => undefined} onClose={() => undefined} thumbUrls={{}} />);
      await sweep();
      const save = screen.getByRole('link', { name: 'Download site visit.jpg' });
      expect(save.textContent).toBe('Download');
      expect(screen.getByText('Full size, 1600 x 1067, 146 KB')).toBeTruthy();
      // Images beyond the four channel tiles have no pre-signed thumbnail.
      expect(document.querySelector('img.is-thumb')?.getAttribute('src')).toBe('https://sb.test/storage/v1/object/sign/media/o/c/p/thumb.webp?token=t');
      expect(save.getAttribute('href')).toBe('https://sb.test/storage/v1/object/sign/media/o/c/p/site_visit.jpg?token=t&download=site%20visit.jpg');
      expect(save.getAttribute('target')).toBe('_blank');
      expect(save.hasAttribute('download')).toBe(false);
      expect(screen.queryByRole('button', { name: /^Share/ })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();   // no bytes fetched for a blob
      cleanup();   // unmounting closes the viewer without dialog methods
      expect(document.querySelector('dialog.dm-lightbox')).toBeNull();
    } finally {
      ua.mockRestore();
      delete nav.share;
      delete nav.canShare;
    }
  });
});
