import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Channel, Message } from '../../src/api/types';

vi.mock('../../src/api/rpc', () => ({
  api: {
    listActivityInbox: vi.fn(), setActivityState: vi.fn(), listSaved: vi.fn(), unreadFeed: vi.fn(),
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
  v: 2, user: ALICE, org: ORG, kind:kind==='threads'?'thread' as const:'mention' as const, view:'unread' as const, order: 'activity-desc-id-desc', at, id,
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
  setState({orgId:ORG,session:{status:'signed_in',userId:ALICE,email:null,setup:null},connection:{online:true,realtime:'idle',leader:false}});
  vi.mocked(api.setActivityState).mockReset();
  vi.mocked(api.listActivityInbox).mockReset();
  vi.mocked(api.listSaved).mockReset();
  vi.mocked(api.listActivityInbox).mockReset();
  vi.mocked(api.unreadFeed).mockReset();
  vi.mocked(api.markRead).mockReset();
  vi.mocked(api.setActivityState).mockReset();
  vi.mocked(api.markAllRead).mockReset();
  // Counters refresh after mark-read; the store's real action is not under test.
  registerActions({ refreshBootstrap: vi.fn().mockResolvedValue(undefined), ensureProfiles: vi.fn() });
});
afterEach(cleanup);

describe('Mentions', () => {
  it('marks a tagged thread reply through its exact snapshot without marking the main channel', async()=>{
    const root=message(1,'root'), tagged={message:{...message(4,'tagged reply'),thread_root_id:root.id},channel,activity:{revision:0,cleared:false,through_seq:4},read:false};
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({items:[tagged],has_more:false,next_cursor:null}).mockResolvedValueOnce({items:[],has_more:false,next_cursor:null});
    vi.mocked(api.setActivityState).mockResolvedValueOnce({revision:1,cleared:false,through_seq:4,read:true,operation_id:'op'});
    render(<MentionsView orgId={ORG} layout="phone" />);await screen.findByText('tagged reply');
    fireEvent.click(screen.getByRole('button',{name:'Mark read'}));await screen.findByText('You are caught up');
    expect(api.setActivityState).toHaveBeenCalledWith('mention',tagged.message.id,'read',0,expect.any(String),4);expect(api.markRead).not.toHaveBeenCalled();
  });
  it('pages with the created_at of the last mention and marks unread ones', async () => {
    const page1 = [
      { message: message(2, 'second mention', '2026-10-02T12:00:00Z'), channel, activity:{revision:0,cleared:false,through_seq:4}, read: false },
      { message: message(1, 'first mention', '2026-10-02T11:00:00Z'), channel, activity:{revision:0,cleared:false,through_seq:4}, read: false },
    ];
    vi.mocked(api.listActivityInbox)
      .mockResolvedValueOnce({ items: page1, has_more: true, next_cursor: inboxCursor('mentions', page1[1]!.message.created_at, page1[1]!.message.id) })
      .mockResolvedValueOnce({ items: [{ message: message(0, 'oldest mention', '2026-10-01T09:00:00Z'), channel, activity:{revision:0,cleared:false,through_seq:4}, read: false }], has_more: false, next_cursor:null });
    render(<MentionsView orgId={ORG} layout="desktop" />);
    await screen.findByText('second mention');
    expect(vi.mocked(api.listActivityInbox).mock.calls[0]).toEqual([ORG, 'mention', 'unread', null, 30]);
    expect(document.querySelectorAll('.dk-activity-row.is-unread')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('oldest mention');
    expect(vi.mocked(api.listActivityInbox).mock.calls[1]).toEqual([ORG, 'mention', 'unread', inboxCursor('mentions', '2026-10-02T11:00:00Z', page1[1]!.message.id), 30]);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('offers a retry when the list fails', async () => {
    vi.mocked(api.listActivityInbox).mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<MentionsView orgId={ORG} layout="desktop" />);
    await screen.findByText('Mentions did not load');
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({ items: [], has_more: false, next_cursor:null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('You are caught up');
  });

  it('starts with unread mentions, switches to All, and refreshes that filter', async () => {
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({ items: [], has_more: false, next_cursor:null })
      .mockResolvedValueOnce({ items: [{ message: message(4, 'already read'), channel, activity:{revision:0,cleared:false,through_seq:4}, read: true }], has_more: false, next_cursor:null })
      .mockResolvedValueOnce({ items: [], has_more: false, next_cursor:null });
    render(<MentionsView orgId={ORG} layout="phone" />);
    await screen.findByText('You are caught up');
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    await screen.findByText('already read');
    expect(api.listActivityInbox).toHaveBeenLastCalledWith(ORG, 'mention', 'all', null, 30);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('No mentions yet');
    expect(api.listActivityInbox).toHaveBeenLastCalledWith(ORG, 'mention', 'all', null, 30);
  });

  it('marks only through the chosen mention and keeps later messages after server confirmation', async () => {
    const first = { message: message(4, 'first to read'), channel, activity:{revision:0,cleared:false,through_seq:4}, read: false };
    const later = { message: message(5, 'later stays unread'), channel, activity:{revision:0,cleared:false,through_seq:4}, read: false };
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({ items: [first, later], has_more: false, next_cursor:null })
      .mockResolvedValueOnce({ items: [later], has_more: false, next_cursor:null });
    vi.mocked(api.setActivityState).mockResolvedValueOnce({revision:1,cleared:false,through_seq:4,read:true,operation_id:'op'});
    render(<MentionsView orgId={ORG} layout="phone" />);
    await screen.findByText('first to read');
    const row = screen.getByText('first to read').closest('article')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Mark read' }));
    await vi.waitFor(() => expect(screen.queryByText('first to read')).toBeNull());
    expect(api.setActivityState).toHaveBeenCalledWith('mention',first.message.id,'read',0,expect.any(String),4);expect(api.markRead).not.toHaveBeenCalled();
    expect(screen.getByText('later stays unread')).toBeTruthy();
  });

  it('ignores a previous organization response after the organization switches', async () => {
    let previous!: (r: Awaited<ReturnType<typeof api.listActivityInbox>>) => void;
    vi.mocked(api.listActivityInbox).mockImplementationOnce(() => new Promise(resolve => { previous = resolve; }))
      .mockResolvedValueOnce({ items: [], has_more: false, next_cursor:null });
    const view = render(<MentionsView orgId={ORG} layout="phone" />);
    setState({orgId:'0f000000-0000-4000-8000-000000000002'});
    view.rerender(<MentionsView orgId="0f000000-0000-4000-8000-000000000002" layout="phone" />);
    await screen.findByText('You are caught up');
    previous({ items: [{ message: message(4, 'old organization'), channel, activity:{revision:0,cleared:false,through_seq:4}, read: false }], has_more: false, next_cursor:null });
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
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({ items: [{ root, channel, activity:{revision:0,cleared:false,through_seq:14}, unread_replies: 2, last_reply_at: '2026-10-02T14:00:00Z', activity_at: '2026-10-02T14:00:00Z', last_reply_seq: 8 }], has_more: false, next_cursor:null });
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('2 new replies');
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(window.location.pathname).toBe(`/o/${ORG}/c/${CHAN}/t/${root.id}`);
  });

  it('pages older followed threads with the exact activity timestamp and root id', async () => {
    const first = { root: message(8, 'first root'), channel, activity:{revision:0,cleared:false,through_seq:14}, unread_replies: 1, activity_at: '2026-10-02T14:00:00.123456Z', last_reply_at: '2026-10-02T14:00:00.123456Z', last_reply_seq: 9 };
    const older = { ...first, root: message(7, 'older root'), unread_replies: 1 };
    const cursor = inboxCursor('threads', first.activity_at, first.root.id);
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({ items: [first], has_more: true, next_cursor: cursor })
      .mockResolvedValueOnce({ items: [older], has_more: false, next_cursor:null });
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('first root');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('older root');
    expect(api.listActivityInbox).toHaveBeenLastCalledWith(ORG, 'thread', 'unread', cursor, 30);
  });

  it('marks only the listed reply snapshot read after confirmation', async () => {
    const item = { root: message(8, 'waiting thread'), channel, activity:{revision:0,cleared:false,through_seq:14}, unread_replies: 1, activity_at: '2026-10-02T14:00:00Z', last_reply_at: '2026-10-02T14:00:00Z', last_reply_seq: 14 };
    let confirm!: (r: {revision:number;cleared:boolean;through_seq:number;read:boolean;operation_id:string}) => void;
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({ items: [item], has_more: false, next_cursor:null })
      .mockResolvedValueOnce({ items: [], has_more: false, next_cursor:null });
    vi.mocked(api.setActivityState).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('waiting thread');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(screen.getByText('waiting thread')).toBeTruthy();
    expect(api.setActivityState).toHaveBeenCalledWith('thread',item.root.id,'read',0,expect.any(String),14);
    confirm({revision:1,cleared:false,through_seq:14,read:true,operation_id:'op'});
    await screen.findByText('You are caught up');
  });

  it('keeps the thread when marking read fails and permits another attempt', async () => {
    const item = { root: message(8, 'keep thread'), channel, activity:{revision:0,cleared:false,through_seq:14}, unread_replies: 1, activity_at: '2026-10-02T14:00:00Z', last_reply_at: '2026-10-02T14:00:00Z', last_reply_seq: 14 };
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({ items: [item], has_more: false, next_cursor:null })
      .mockResolvedValueOnce({ items: [], has_more: false, next_cursor:null });
    vi.mocked(api.setActivityState).mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce({revision:1,cleared:false,through_seq:14,read:true,operation_id:'op'});
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('keep thread');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Mark read' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('keep thread')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await screen.findByText('You are caught up');
  });

  it('reloads after a snapshot read so a later reply and older unread roots stay reachable', async () => {
    const item = { root: message(8, 'still unread thread'), channel, activity:{revision:0,cleared:false,through_seq:14}, unread_replies: 1, activity_at: '2026-10-02T14:00:00Z', last_reply_at: '2026-10-02T14:00:00Z', last_reply_seq: 14 };
    const older = { ...item, root: message(2, 'older unread thread') };
    const cursor = inboxCursor('threads', item.activity_at, item.root.id);
    vi.mocked(api.listActivityInbox).mockResolvedValueOnce({ items: [item], has_more: true, next_cursor: cursor })
      .mockResolvedValueOnce({ items: [{ ...item, last_reply_seq: 15 }, older], has_more: false, next_cursor:null });
    vi.mocked(api.setActivityState).mockResolvedValueOnce({revision:1,cleared:false,through_seq:14,read:true,operation_id:'op'});
    render(<ThreadsView orgId={ORG} layout="desktop" />);
    await screen.findByText('still unread thread');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await screen.findByText('older unread thread');
    expect(screen.getByText('still unread thread')).toBeTruthy();
    expect(screen.queryByText('You are caught up')).toBeNull();
    expect(api.listActivityInbox).toHaveBeenLastCalledWith(ORG, 'thread', 'unread', null, 30);
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
