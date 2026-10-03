import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Attachment, Channel, Message } from '../../src/api/types';

vi.mock('../../src/api/rpc', () => ({
  api: { search: vi.fn(), searchFiles: vi.fn(), listOrgMembers: vi.fn() },
}));
vi.mock('../../src/features/media', () => ({ MessageAttachments: () => null }));

import { api } from '../../src/api/rpc';
import { DekError } from '../../src/api/errors';
import { SearchScreen } from '../../src/features/search';
import { NO_FILTERS } from '../../src/features/search/Filters';
import { searchArgs } from '../../src/features/search/MessageResults';

const ORG = '0f000000-0000-4000-8000-000000000001';
const CHAN = '0c000000-0000-4000-8000-000000000001';
const ALICE = '0a000000-0000-4000-8000-000000000001';

const channel: Channel = {
  id: CHAN, org_id: ORG, server_id: null, kind: 'text', name: 'grants', topic: null, description: null,
  visibility: 'private', posting_policy: 'everyone', allow_replies: true, allow_reactions: true, auto_join: false,
  archived: false, position: 0, category: null, created_by: null, created_at: '2026-10-01T00:00:00Z',
  member: true, my_role: 'member', notify: 'default', muted_until: null, last_seq: 30, last_read_seq: 30,
  unread: 0, mentions: 0, last_message_at: null, member_count: 3, dm_user_ids: null,
};

function message(n: number, body: string): Message {
  return {
    id: `0e000000-0000-4000-8000-${String(n).padStart(12, '0')}`, org_id: ORG, channel_id: CHAN, seq: n,
    thread_root_id: null, author_id: ALICE, kind: 'user', body, mentions: [], mention_all: false, client_id: null,
    created_at: '2026-10-02T10:00:00Z', edited_at: null, deleted_at: null, updated_at: '2026-10-02T10:00:00Z',
    reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments: [], pinned: false,
    also_in_channel: false, meta: {},
  };
}

const searchMock = vi.mocked(api.search);
const filesMock = vi.mocked(api.searchFiles);

beforeEach(() => {
  searchMock.mockReset();
  filesMock.mockReset();
  window.history.replaceState(null, '', `/o/${ORG}/search`);
});
afterEach(cleanup);

function box(): HTMLElement {
  return screen.getByRole('searchbox', { name: 'Search messages' });
}

describe('SearchScreen', () => {
  it('waits for a submit and explains how to search', () => {
    render(<SearchScreen orgId={ORG} q="" layout="desktop" />);
    expect(screen.getByText(/Type words to find messages/)).toBeTruthy();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('asks for words, a conversation or a person before calling the server', () => {
    render(<SearchScreen orgId={ORG} q="" layout="desktop" />);
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText(/Type at least one word/)).toBeTruthy();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('runs on submit with the contract arguments, puts the words in the URL and highlights them', async () => {
    searchMock.mockResolvedValueOnce({ items: [{ message: message(1, 'The grant budget draft is ready'), channel }], has_more: false });
    render(<SearchScreen orgId={ORG} q="" layout="desktop" />);
    fireEvent.change(box(), { target: { value: 'grant budget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('1 message');
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0]![0]).toEqual({
      org: ORG, query: 'grant budget', channel: null, author: null, after: null, before: null, has: null, limit: 20, offset: 0,
    });
    expect(new URLSearchParams(window.location.search).get('q')).toBe('grant budget');
    const marked = [...document.querySelectorAll('mark.dk-md-hl')].map((m) => m.textContent?.toLowerCase());
    expect(marked).toEqual(expect.arrayContaining(['grant', 'budget']));
  });

  it('starts from the URL query and loads the next page by offset', async () => {
    const first = Array.from({ length: 20 }, (_, i) => ({ message: message(i + 1, `history line ${i + 1}`), channel }));
    searchMock
      .mockResolvedValueOnce({ items: first, has_more: true })
      .mockResolvedValueOnce({ items: [{ message: message(21, 'history line 21'), channel }], has_more: false });
    render(<SearchScreen orgId={ORG} q="history" layout="desktop" />);
    await screen.findByText('20+ messages');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('21 messages');
    expect(searchMock.mock.calls[1]![0].offset).toBe(20);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows the server hint and a retry when searches are rate limited', async () => {
    searchMock.mockRejectedValueOnce(new DekError('rate_limited', 'Too many searches. Try again in a minute.'));
    render(<SearchScreen orgId={ORG} q="grants" layout="desktop" />);
    await screen.findByText('Too many searches. Try again in a minute.');
    searchMock.mockResolvedValueOnce({ items: [], has_more: false });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No messages match');
    expect(searchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the newest files on the Files tab, then searches file names', async () => {
    const att: Attachment = {
      id: '0d000000-0000-4000-8000-000000000001', file_name: 'grant-budget.pdf', mime_type: 'application/pdf',
      size_bytes: 1536, width: null, height: null, duration_ms: null, path: 'x', thumb_path: null, status: 'ready',
    };
    filesMock.mockResolvedValue({ items: [{ attachment: att, message: message(5, ''), channel }], has_more: false });
    render(<SearchScreen orgId={ORG} q="" layout="desktop" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    await screen.findByText('Newest files');
    expect(filesMock.mock.calls[0]).toEqual([ORG, null, null, 30, 0]);
    expect(screen.getByText('1.5 KB')).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'budget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('1 file');
    expect(filesMock.mock.calls.at(-1)).toEqual([ORG, 'budget', null, 30, 0]);
    // The rate-limited message search runs only once Messages is on screen.
    expect(searchMock).not.toHaveBeenCalled();
    searchMock.mockResolvedValueOnce({ items: [], has_more: false });
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    await screen.findByText('No messages match');
    expect(searchMock.mock.calls[0]![0].query).toBe('budget');
  });

  it('folds the filters behind a button on phones', () => {
    render(<SearchScreen orgId={ORG} q="" layout="phone" />);
    const toggle = screen.getByRole('button', { name: 'Filters' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('In')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('In')).toBeTruthy();
    expect(screen.getByLabelText('On or after')).toBeTruthy();
  });
});

describe('search arguments', () => {
  it('sends local day bounds, the conversation and the kind of content', () => {
    const args = searchArgs(ORG, {
      query: 'x', run: 1,
      filters: { ...NO_FILTERS, channel: CHAN, after: '2026-10-01', before: '2026-10-03', has: 'file' },
    }, 40);
    expect(args).toEqual({
      org: ORG, query: 'x', channel: CHAN, author: null,
      after: new Date(2026, 9, 1).toISOString(), before: new Date(2026, 9, 4).toISOString(),
      has: 'file', limit: 20, offset: 40,
    });
  });
});
