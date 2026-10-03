import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Channel, Message } from '../../src/api/types';

vi.mock('../../src/api/rpc', () => ({
  api: {
    listMentions: vi.fn(), listSaved: vi.fn(), listThreads: vi.fn(), unreadFeed: vi.fn(),
    markRead: vi.fn(), markAllRead: vi.fn(), saveMessage: vi.fn(),
  },
}));
vi.mock('../../src/features/media', () => ({ MessageAttachments: () => null }));

import { api } from '../../src/api/rpc';
import { registerActions, setState, useDek } from '../../src/store';
import { DmsView, MentionsView, SavedView, ThreadsView, UnreadView } from '../../src/features/views';
import { useUi } from '../../src/features/shell/ui-store';

const ORG = '0f000000-0000-4000-8000-000000000001';
const CHAN = '0c000000-0000-4000-8000-000000000001';
const ALICE = '0a000000-0000-4000-8000-000000000001';

const channel: Channel = {
  id: CHAN, org_id: ORG, server_id: null, kind: 'text', name: 'general', topic: null, description: null,
  visibility: 'public', posting_policy: 'everyone', allow_replies: true, allow_reactions: true, auto_join: true,
  archived: false, position: 0, category: null, created_by: null, created_at: '2026-10-01T00:00:00Z',
  member: true, my_role: 'member', notify: 'default', muted_until: null, last_seq: 40, last_read_seq: 30,
  unread: 3, mentions: 1, last_message_at: null, member_count: 4, dm_user_ids: null,
};

function message(n: number, body: string, created = `2026-10-02T10:${String(n % 60).padStart(2, '0')}:00Z`): Message {
  return {
    id: `0e000000-0000-4000-8000-${String(n).padStart(12, '0')}`, org_id: ORG, channel_id: CHAN, seq: n,
    thread_root_id: null, author_id: ALICE, kind: 'user', body, mentions: [], mention_all: false, client_id: null,
    created_at: created, edited_at: null, deleted_at: null, updated_at: created,
    reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments: [], pinned: false,
    also_in_channel: false, meta: {},
  };
}

beforeEach(() => {
  vi.mocked(api.listMentions).mockReset();
  vi.mocked(api.listSaved).mockReset();
  vi.mocked(api.listThreads).mockReset();
  vi.mocked(api.unreadFeed).mockReset();
  vi.mocked(api.markRead).mockReset();
  vi.mocked(api.markAllRead).mockReset();
  // Counters refresh after mark-read; the store's real action is not under test.
  registerActions({ refreshBootstrap: vi.fn().mockResolvedValue(undefined), ensureProfiles: vi.fn() });
});
afterEach(cleanup);

describe('Mentions', () => {
  it('pages with the created_at of the last mention and marks unread ones', async () => {
    const page1 = [
      { message: message(2, 'second mention', '2026-10-02T12:00:00Z'), channel, read: false },
      { message: message(1, 'first mention', '2026-10-02T11:00:00Z'), channel, read: true },
    ];
    vi.mocked(api.listMentions)
      .mockResolvedValueOnce({ items: page1, has_more: true })
      .mockResolvedValueOnce({ items: [{ message: message(0, 'oldest mention', '2026-10-01T09:00:00Z'), channel, read: true }], has_more: false });
    render(<MentionsView orgId={ORG} layout="desktop" />);
    await screen.findByText('second mention');
    expect(vi.mocked(api.listMentions).mock.calls[0]).toEqual([ORG, null, 30]);
    expect(document.querySelectorAll('.dk-card.is-unread')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('oldest mention');
    expect(vi.mocked(api.listMentions).mock.calls[1]).toEqual([ORG, '2026-10-02T11:00:00Z', 30]);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('offers a retry when the list fails', async () => {
    vi.mocked(api.listMentions).mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<MentionsView orgId={ORG} layout="desktop" />);
    await screen.findByText('Mentions did not load');
    vi.mocked(api.listMentions).mockResolvedValueOnce({ items: [], has_more: false });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No mentions yet');
  });
});

describe('Saved', () => {
  // Saved state lives in the store (src/sync/saved.ts): it needs a session.
  beforeEach(() => {
    setState({ session: { status: 'signed_in', userId: ALICE, email: null, setup: null }, saved: {} });
  });

  it('removes a saved message only after the server confirms', async () => {
    const m = message(7, 'keep this one');
    setState({ saved: { [m.id]: true } });
    vi.mocked(api.saveMessage).mockResolvedValueOnce({ message_id: m.id, saved: false });
    vi.mocked(api.listSaved).mockResolvedValueOnce({ items: [{ message: m, channel, saved_at: '2026-10-02T13:00:00Z' }], has_more: false });
    render(<SavedView orgId={ORG} layout="desktop" />);
    await screen.findByText('keep this one');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('Nothing saved yet');
    expect(api.saveMessage).toHaveBeenCalledWith(m.id, false);
    expect(useDek.getState().saved[m.id]).toBeUndefined();
  });

  it('keeps the message, and the bookmark, when removing fails', async () => {
    const m = message(8, 'still here');
    setState({ saved: { [m.id]: true } });
    vi.mocked(api.saveMessage).mockRejectedValueOnce(new Error('Failed to fetch'));
    vi.mocked(api.listSaved).mockResolvedValueOnce({ items: [{ message: m, channel, saved_at: '2026-10-02T13:00:00Z' }], has_more: false });
    render(<SavedView orgId={ORG} layout="desktop" />);
    await screen.findByText('still here');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Remove' }).getAttribute('aria-busy')).toBeNull());
    expect(screen.getByText('still here')).toBeTruthy();
    expect(useDek.getState().saved[m.id]).toBe(true);
  });
});

describe('Unread', () => {
  it('marks one conversation read up to its newest message and drops the group', async () => {
    vi.mocked(api.unreadFeed).mockResolvedValueOnce({ channels: [{ channel, messages: [message(39, 'news one'), message(41, 'news two')] }] });
    vi.mocked(api.markRead).mockResolvedValueOnce({ channel_id: CHAN, last_read_seq: 41 });
    render(<UnreadView orgId={ORG} layout="desktop" />);
    const group = (await screen.findByText('news one')).closest('li.dk-ugroup') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Mark read: #general' }));
    await screen.findByText('You are all caught up');
    expect(vi.mocked(api.markRead).mock.calls[0]).toEqual([CHAN, 41]);
  });

  it('says so when everything is read', async () => {
    vi.mocked(api.unreadFeed).mockResolvedValueOnce({ channels: [] });
    render(<UnreadView orgId={ORG} layout="desktop" />);
    await screen.findByText('You are all caught up');
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });
});

describe('Threads', () => {
  it('shows how many replies are new and opens the thread', async () => {
    const root = { ...message(3, 'thread root'), reply_count: 5 };
    vi.mocked(api.listThreads).mockResolvedValueOnce({ threads: [{ root, channel, unread_replies: 2, last_reply_at: '2026-10-02T14:00:00Z' }] });
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('2 new replies');
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(window.location.pathname).toBe(`/o/${ORG}/c/${CHAN}/t/${root.id}`);
  });
});

describe('DMs', () => {
  it('invites a first conversation when there are none', () => {
    render(<DmsView orgId={ORG} layout="phone" />);
    expect(screen.getByText('No direct messages yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start a conversation' }));
    expect(useUi.getState().dmPickerOpen).toBe(true);
  });
});
