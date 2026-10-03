import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Attachment, Message } from '../../src/api/types';

const mint = vi.fn(async (paths: string[], expiresIn: number) => ({
  data: paths.map((p) => ({ path: p, error: null, signedURL: `/object/sign/media/${p}?token=t`, signedUrl: `https://sb.test/storage/v1/object/sign/media/${p}?token=t&exp=${expiresIn}` })),
  error: null,
}));

vi.mock('../../src/api/client', () => ({
  supabase: () => ({
    storage: { from: () => ({ createSignedUrls: mint }) },
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
  }),
  rpc: async () => { throw new Error('no rpc in tests'); },
}));

const { MessageAttachments, PendingUploads } = await import('../../src/features/media');
const { uploader } = await import('../../src/features/media/hooks');

const att = (over: Partial<Attachment>): Attachment => ({
  id: 'a1', file_name: 'photo.jpg', mime_type: 'image/jpeg', size_bytes: 120_000, width: 1600, height: 900, duration_ms: null,
  path: 'org/chan/a1/photo.jpg', thumb_path: 'org/chan/a1/thumb.webp', status: 'ready', ...over,
});

const message = (attachments: Attachment[]): Message => ({
  id: 'm1', org_id: 'org', channel_id: 'chan', seq: 1, thread_root_id: null, author_id: 'u1', kind: 'user', body: '',
  mentions: [], mention_all: false, client_id: null, created_at: '2026-10-03T10:00:00Z', edited_at: null, deleted_at: null,
  updated_at: '2026-10-03T10:00:00Z', reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments,
  pinned: false, also_in_channel: false, meta: {},
});

beforeEach(() => {
  mint.mockClear();
});
afterEach(() => {
  cleanup();
  uploader.reset();
});

async function sweep() {
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

describe('MessageAttachments (DEK11)', () => {
  test('one batched mint for everything on screen; thumbnails in the grid; boxes reserved before load', async () => {
    const atts = [
      att({ id: 'a1' }),
      att({ id: 'a2', file_name: 'b.png', mime_type: 'image/png', path: 'org/chan/a2/b.png', thumb_path: null, width: 800, height: 800 }),
      att({ id: 'a3', file_name: 'Budget Q3.pdf', mime_type: 'application/pdf', path: 'org/chan/a3/Budget_Q3.pdf', thumb_path: null, width: null, height: null }),
      att({ id: 'a4', file_name: 'voice-note-0m07s.webm', mime_type: 'audio/webm', path: 'org/chan/a4/voice.webm', thumb_path: null, duration_ms: 7000, width: null, height: null }),
    ];
    render(
      <>
        <MessageAttachments message={message(atts)} attachments={atts} />
        <MessageAttachments message={{ ...message([]), id: 'm2' }} attachments={[att({ id: 'b1', path: 'org/chan/b1/x.jpg', thumb_path: 'org/chan/b1/thumb.webp' })]} />
      </>,
    );
    await sweep();
    expect(mint).toHaveBeenCalledTimes(1);
    const [paths, ttl] = mint.mock.calls[0] as [string[], number];
    expect(ttl).toBe(900);
    expect(paths.sort()).toEqual([
      'org/chan/a1/thumb.webp', 'org/chan/a2/b.png', 'org/chan/a3/Budget_Q3.pdf', 'org/chan/a4/voice.webm', 'org/chan/b1/thumb.webp',
    ].sort());
    const imgs = screen.getAllByRole('img', { name: 'photo.jpg' });
    expect(imgs[0]?.getAttribute('src')).toBe('https://sb.test/storage/v1/object/sign/media/org/chan/a1/thumb.webp?token=t&exp=900');
    // two photos: a two-tile grid of squares
    expect(screen.getByRole('group', { name: '2 photos' }).className).toContain('dm-grid--2');
    // the PDF opens in a new tab and downloads under its real name
    const open = screen.getByRole('link', { name: 'Open Budget Q3.pdf in a new tab' });
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: 'Download Budget Q3.pdf' }).getAttribute('href')).toContain('&download=Budget%20Q3.pdf');
    // voice notes say what they are
    expect(screen.getByText('Voice note')).toBeTruthy();
    expect(screen.getByText('0:07')).toBeTruthy();
    // a lone photo reserves its true shape
    const lone = document.querySelector('[data-message="m2"] .dm-tile') as HTMLElement;
    expect(lone.style.aspectRatio).toMatch(/^1\.7777/);
    // nothing is ever a public URL
    expect(document.body.innerHTML).not.toContain('/object/public/');
  });

  test('a second render of the same message mints nothing new', async () => {
    const atts = [att({ id: 'c1', path: 'org/chan/c1/p.jpg', thumb_path: 'org/chan/c1/thumb.webp' })];
    const { unmount } = render(<MessageAttachments message={message(atts)} attachments={atts} />);
    await sweep();
    unmount();
    render(<MessageAttachments message={message(atts)} attachments={atts} />);
    await sweep();
    expect(mint).toHaveBeenCalledTimes(1);
  });

  test('a broken image re-mints once, then shows an honest broken state', async () => {
    const atts = [att({ id: 'd1', path: 'org/chan/d1/p.jpg', thumb_path: 'org/chan/d1/thumb.webp' })];
    render(<MessageAttachments message={message(atts)} attachments={atts} />);
    await sweep();
    fireEvent.error(screen.getByRole('img', { name: 'photo.jpg' }));
    await sweep();
    expect(mint).toHaveBeenCalledTimes(2);
    fireEvent.error(screen.getByRole('img', { name: 'photo.jpg' }));
    await sweep();
    expect(screen.getByText('Cannot show this image')).toBeTruthy();
    expect(mint).toHaveBeenCalledTimes(2);
  });

  test('pending and rejected files show a status, never a link', async () => {
    const atts = [att({ id: 'e1', status: 'pending', mime_type: 'application/pdf', file_name: 'x.pdf' }), att({ id: 'e2', status: 'rejected', mime_type: 'application/pdf', file_name: 'y.pdf' })];
    render(<MessageAttachments message={message(atts)} attachments={atts} />);
    await sweep();
    expect(screen.getByText('Still being checked')).toBeTruthy();
    expect(screen.getByText('Removed: it did not pass the file check')).toBeTruthy();
    expect(mint).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('PendingUploads', () => {
  test('progress, a refusal with only Remove, a retryable failure with Retry; the text box is not ours to touch', () => {
    uploader.store.setState({
      byKey: {
        k: [
          { localId: 'l1', fileName: 'photo.jpg', progress: 42, status: 'uploading', attachmentId: 'a', error: null, previewUrl: null },
          { localId: 'l2', fileName: 'holiday.jpg', progress: 0, status: 'failed', attachmentId: null, error: 'holiday.jpg is really a Windows program disguised as a photo. Dek does not accept programs.', previewUrl: null, retryable: false },
          { localId: 'l3', fileName: 'notes.pdf', progress: 30, status: 'failed', attachmentId: 'b', error: 'The connection dropped during the upload. Retry when you are back online.', previewUrl: null, retryable: true },
        ],
      },
    });
    render(<PendingUploads uploadKey="k" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('Uploading 42%')).toBeTruthy();
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'holiday.jpg is really a Windows program disguised as a photo. Dek does not accept programs.',
      'The connection dropped during the upload. Retry when you are back online.',
    ]);
    expect(screen.queryByRole('button', { name: 'Retry holiday.jpg' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry notes.pdf' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove holiday.jpg' }));
    expect(uploader.items('k').map((i) => i.localId)).toEqual(['l1', 'l3']);
  });
});
