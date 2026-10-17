import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Channel, Message } from '../../src/api/types';

vi.mock('../../src/api/rpc', () => ({
  api: {
    listMentionInbox: vi.fn(), listSaved: vi.fn(), listThreadInbox: vi.fn(), unreadFeed: vi.fn(),
    markRead: vi.fn(), markThreadRead: vi.fn(), markAllRead: vi.fn(), saveMessage: vi.fn(),
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
const inboxCursor = (kind: 'threads' | 'mentions', at: string, id: string) => ({
  v: 1, user: ALICE, org: ORG, kind, unread: true, order: 'activity-desc-id-desc', at, id,
});

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
  vi.mocked(api.listMentionInbox).mockReset();
  vi.mocked(api.listSaved).mockReset();
  vi.mocked(api.listThreadInbox).mockReset();
  vi.mocked(api.unreadFeed).mockReset();
  vi.mocked(api.markRead).mockReset();
  vi.mocked(api.markThreadRead).mockReset();
  vi.mocked(api.markAllRead).mockReset();
  // Counters refresh after mark-read; the store's real action is not under test.
  registerActions({ refreshBootstrap: vi.fn().mockResolvedValue(undefined), ensureProfiles: vi.fn() });
});
afterEach(cleanup);

describe('Mentions', () => {
  it('pages with the created_at of the last mention and marks unread ones', async () => {
    const page1 = [
      { message: message(2, 'second mention', '2026-10-02T12:00:00Z'), channel, read: false },
      { message: message(1, 'first mention', '2026-10-02T11:00:00Z'), channel, read: false },
    ];
    vi.mocked(api.listMentionInbox)
      .mockResolvedValueOnce({ items: page1, has_more: true, next_cursor: inboxCursor('mentions', page1[1]!.message.created_at, page1[1]!.message.id) })
      .mockResolvedValueOnce({ items: [{ message: message(0, 'oldest mention', '2026-10-01T09:00:00Z'), channel, read: false }], has_more: false });
    render(<MentionsView orgId={ORG} layout="desktop" />);
    await screen.findByText('second mention');
    expect(vi.mocked(api.listMentionInbox).mock.calls[0]).toEqual([ORG, null, true, 30]);
    expect(document.querySelectorAll('.dk-card.is-unread')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('oldest mention');
    expect(vi.mocked(api.listMentionInbox).mock.calls[1]).toEqual([ORG, inboxCursor('mentions', '2026-10-02T11:00:00Z', page1[1]!.message.id), true, 30]);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('offers a retry when the list fails', async () => {
    vi.mocked(api.listMentionInbox).mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<MentionsView orgId={ORG} layout="desktop" />);
    await screen.findByText('Mentions did not load');
    vi.mocked(api.listMentionInbox).mockResolvedValueOnce({ items: [], has_more: false });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No unread mentions');
  });

  it('starts with unread mentions, switches to All, and refreshes that filter', async () => {
    vi.mocked(api.listMentionInbox).mockResolvedValueOnce({ items: [], has_more: false })
      .mockResolvedValueOnce({ items: [{ message: message(4, 'already read'), channel, read: true }], has_more: false })
      .mockResolvedValueOnce({ items: [], has_more: false });
    render(<MentionsView orgId={ORG} layout="phone" />);
    await screen.findByText('No unread mentions');
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    await screen.findByText('already read');
    expect(api.listMentionInbox).toHaveBeenLastCalledWith(ORG, null, false, 30);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('No mentions yet');
    expect(api.listMentionInbox).toHaveBeenLastCalledWith(ORG, null, false, 30);
  });

  it('marks only through the chosen mention and keeps later messages after server confirmation', async () => {
    const first = { message: message(4, 'first to read'), channel, read: false };
    const later = { message: message(5, 'later stays unread'), channel, read: false };
    vi.mocked(api.listMentionInbox).mockResolvedValueOnce({ items: [first, later], has_more: false })
      .mockResolvedValueOnce({ items: [later], has_more: false });
    vi.mocked(api.markRead).mockResolvedValueOnce({ channel_id: CHAN, last_read_seq: 4 });
    render(<MentionsView orgId={ORG} layout="phone" />);
    await screen.findByText('first to read');
    const row = screen.getByText('first to read').closest('article')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Mark read' }));
    await vi.waitFor(() => expect(screen.queryByText('first to read')).toBeNull());
    expect(api.markRead).toHaveBeenCalledWith(CHAN, 4);
    expect(screen.getByText('later stays unread')).toBeTruthy();
  });

  it('ignores a previous organization response after the organization switches', async () => {
    let previous!: (r: { items: { message: Message; channel: Channel; read: boolean }[]; has_more: boolean }) => void;
    vi.mocked(api.listMentionInbox).mockImplementationOnce(() => new Promise(resolve => { previous = resolve; }))
      .mockResolvedValueOnce({ items: [], has_more: false });
    const view = render(<MentionsView orgId={ORG} layout="phone" />);
    view.rerender(<MentionsView orgId="0f000000-0000-4000-8000-000000000002" layout="phone" />);
    await screen.findByText('No unread mentions');
    previous({ items: [{ message: message(4, 'old organization'), channel, read: false }], has_more: false });
    await vi.waitFor(() => expect(screen.queryByText('old organization')).toBeNull());
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
    vi.mocked(api.listThreadInbox).mockResolvedValueOnce({ items: [{ root, channel, unread_replies: 2, last_reply_at: '2026-10-02T14:00:00Z', activity_at: '2026-10-02T14:00:00Z', last_reply_seq: 8 }], has_more: false });
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('2 new replies');
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(window.location.pathname).toBe(`/o/${ORG}/c/${CHAN}/t/${root.id}`);
  });

  it('pages older followed threads with the exact activity timestamp and root id', async () => {
    const first = { root: message(8, 'first root'), channel, unread_replies: 1, activity_at: '2026-10-02T14:00:00.123456Z', last_reply_at: '2026-10-02T14:00:00.123456Z', last_reply_seq: 9 };
    const older = { ...first, root: message(7, 'older root'), unread_replies: 1 };
    const cursor = inboxCursor('threads', first.activity_at, first.root.id);
    vi.mocked(api.listThreadInbox).mockResolvedValueOnce({ items: [first], has_more: true, next_cursor: cursor })
      .mockResolvedValueOnce({ items: [older], has_more: false });
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('first root');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('older root');
    expect(api.listThreadInbox).toHaveBeenLastCalledWith(ORG, cursor, true, 30);
  });

  it('marks only the listed reply snapshot read after confirmation', async () => {
    const item = { root: message(8, 'waiting thread'), channel, unread_replies: 1, activity_at: '2026-10-02T14:00:00Z', last_reply_at: '2026-10-02T14:00:00Z', last_reply_seq: 14 };
    let confirm!: (r: { root_id: string; last_read_reply_seq: number }) => void;
    vi.mocked(api.listThreadInbox).mockResolvedValueOnce({ items: [item], has_more: false })
      .mockResolvedValueOnce({ items: [], has_more: false });
    vi.mocked(api.markThreadRead).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('waiting thread');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(screen.getByText('waiting thread')).toBeTruthy();
    expect(api.markThreadRead).toHaveBeenCalledWith(item.root.id, 14);
    confirm({ root_id: item.root.id, last_read_reply_seq: 14 });
    await screen.findByText('No unread replies');
  });

  it('keeps the thread when marking read fails and permits another attempt', async () => {
    const item = { root: message(8, 'keep thread'), channel, unread_replies: 1, activity_at: '2026-10-02T14:00:00Z', last_reply_at: '2026-10-02T14:00:00Z', last_reply_seq: 14 };
    vi.mocked(api.listThreadInbox).mockResolvedValueOnce({ items: [item], has_more: false })
      .mockResolvedValueOnce({ items: [], has_more: false });
    vi.mocked(api.markThreadRead).mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce({ root_id: item.root.id, last_read_reply_seq: 14 });
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('keep thread');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Mark read' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('keep thread')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await screen.findByText('No unread replies');
  });

  it('reloads after a snapshot read so a later reply and older unread roots stay reachable', async () => {
    const item = { root: message(8, 'still unread thread'), channel, unread_replies: 1, activity_at: '2026-10-02T14:00:00Z', last_reply_at: '2026-10-02T14:00:00Z', last_reply_seq: 14 };
    const older = { ...item, root: message(2, 'older unread thread') };
    const cursor = inboxCursor('threads', item.activity_at, item.root.id);
    vi.mocked(api.listThreadInbox).mockResolvedValueOnce({ items: [item], has_more: true, next_cursor: cursor })
      .mockResolvedValueOnce({ items: [{ ...item, last_reply_seq: 15 }, older], has_more: false });
    vi.mocked(api.markThreadRead).mockResolvedValueOnce({ root_id: item.root.id, last_read_reply_seq: 14 });
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('still unread thread');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await screen.findByText('older unread thread');
    expect(screen.getByText('still unread thread')).toBeTruthy();
    expect(screen.queryByText('No unread replies')).toBeNull();
    expect(api.listThreadInbox).toHaveBeenLastCalledWith(ORG, null, true, 30);
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
