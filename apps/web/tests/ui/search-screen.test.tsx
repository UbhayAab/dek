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
import { scopeFromFilters } from '../../src/features/search/scope';
import { href, navigate, parse, useRoute } from '../../src/app/router';

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
  it('runs an empty-term contextual search and restores scope from a copied URL', async () => {
    searchMock.mockResolvedValue({ items: [], has_more: false });
    const scope = scopeFromFilters({ ...NO_FILTERS, channel: CHAN, has: 'pin', after: '2026-10-01' }, 'messages');
    const link = href({ name: 'search', orgId: ORG, q: '', scope });
    const route = parse(link);
    expect(route.name).toBe('search');
    if (route.name !== 'search') throw new Error('Invalid fixture');
    render(<SearchScreen orgId={route.orgId} q={route.q} scope={route.scope} layout="desktop" />);
    await screen.findByText('No messages match');
    expect(searchMock.mock.calls[0]![0]).toMatchObject({ channel: CHAN, query: '', has: 'pin' });
    expect((screen.getByLabelText('In') as HTMLSelectElement).value).toBe(CHAN);
    expect((screen.getByLabelText('On or after') as HTMLInputElement).value).toBe('2026-10-01');
  });

  it('never broadens a revoked explicit channel even when it has left the local store', async () => {
    searchMock.mockRejectedValueOnce(new DekError('not_found', 'This conversation is unavailable.'));
    const scope = scopeFromFilters({ ...NO_FILTERS, channel: CHAN }, 'messages');
    render(<SearchScreen orgId={ORG} q="budget" scope={scope} layout="desktop" />);
    await screen.findByText('This conversation is unavailable.');
    expect(searchMock.mock.calls[0]![0].channel).toBe(CHAN);
    expect((screen.getByLabelText('In') as HTMLSelectElement).value).toBe(CHAN);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks malformed scope before any message or file request', async () => {
    const scope = { ...scopeFromFilters(NO_FILTERS, 'files'), in: 'invalid-channel' };
    render(<SearchScreen orgId={ORG} q="budget" scope={scope} layout="desktop" />);
    await screen.findByText('Check the search filters');
    expect(searchMock).not.toHaveBeenCalled();
    expect(filesMock).not.toHaveBeenCalled();
  });

  it('offers an explicit reset for malformed hidden file criteria before any broader request', async () => {
    searchMock.mockResolvedValue({ items: [], has_more: false });
    const scope = { ...scopeFromFilters({ ...NO_FILTERS, channel: CHAN }, 'files'), has: 'unknown' };
    render(<SearchScreen orgId={ORG} q="budget" scope={scope} layout="phone" />);
    await screen.findByText('Check the search filters');
    expect(searchMock).not.toHaveBeenCalled(); expect(filesMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    await screen.findByText('No messages match');
    expect(searchMock.mock.calls[0]![0].channel).toBeNull();
  });

  it('restores an externally changed scope and ignores the interrupted response', async () => {
    let old!: (r: {items:{message:Message;channel:Channel}[];has_more:boolean})=>void;
    searchMock.mockImplementationOnce(() => new Promise(resolve => { old=resolve; }))
      .mockResolvedValueOnce({items:[],has_more:false});
    const view=render(<SearchScreen orgId={ORG} q="old" layout="desktop" />);
    const scope=scopeFromFilters({...NO_FILTERS,channel:CHAN,has:'link'},'messages');
    view.rerender(<SearchScreen orgId={ORG} q="new" scope={scope} layout="desktop" />);
    await screen.findByText('No messages match');
    old({items:[{message:message(4,'stale result'),channel}],has_more:false});
    await vi.waitFor(() => expect(screen.queryByText('stale result')).toBeNull());
    expect((box() as HTMLInputElement).value).toBe('new');
    expect(searchMock.mock.calls.at(-1)![0]).toMatchObject({query:'new',channel:CHAN,has:'link'});
  });

  it('keeps unsupported file filters visibly parked and sends only the supported conversation scope', async () => {
    filesMock.mockResolvedValueOnce({ items: [], has_more: false });
    const scope = scopeFromFilters({ ...NO_FILTERS, channel: CHAN, after: '2026-10-01', has: 'pin' }, 'files');
    render(<SearchScreen orgId={ORG} q="budget" scope={scope} layout="phone" />);
    await screen.findByText('No files match');
    expect(filesMock).toHaveBeenCalledWith(ORG, 'budget', CHAN, 30, 0);
    expect(screen.getByText(/Person, date and Has filters are kept for Messages/)).toBeTruthy();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('performs one request per submit in the actual route-driven composition', async () => {
    searchMock.mockResolvedValue({ items: [], has_more: false });
    function Routed() {
      const route = useRoute();
      return route.name === 'search' ? <SearchScreen orgId={route.orgId} q={route.q} scope={route.scope} layout="desktop" /> : null;
    }
    render(<Routed />);
    fireEvent.change(box(), { target: { value: 'one search' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('No messages match');
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it('switches blank Files back to the Messages landing without issuing a message search', async () => {
    filesMock.mockResolvedValue({ items: [], has_more: false });
    const scope = scopeFromFilters(NO_FILTERS, 'files');
    render(<SearchScreen orgId={ORG} q="" scope={scope} layout="desktop" />);
    await screen.findByText('No files yet');
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    expect(screen.getByRole('tab', { name: 'Messages' }).getAttribute('aria-selected')).toBe('true');
    expect(searchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Check the search filters')).toBeNull();
  });

  it('keeps phone filters expanded and focused while a local filter updates the URL', async () => {
    searchMock.mockResolvedValue({ items: [], has_more: false });
    navigate({ name: 'search', orgId: ORG, q: '', scope: scopeFromFilters({ ...NO_FILTERS, channel: CHAN }, 'messages') });
    function Routed() {
      const route = useRoute();
      return route.name === 'search' ? <SearchScreen orgId={route.orgId} q={route.q} scope={route.scope} layout="phone" /> : null;
    }
    render(<Routed />);
    await screen.findByText('No messages match');
    const toggle = screen.getByRole('button', { name: /Filters/ });
    fireEvent.click(toggle);
    const has = screen.getByLabelText('Has');
    has.focus();
    fireEvent.change(has, { target: { value: 'file' } });
    await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get('has')).toBe('file'));
    expect(screen.getByRole('button', { name: /Filters/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Has')).toBe(has);
    expect(document.activeElement).toBe(has);
    expect(searchMock).toHaveBeenCalledTimes(2);
  });
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
