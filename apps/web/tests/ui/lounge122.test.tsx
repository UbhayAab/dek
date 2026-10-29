import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Server } from '../../src/api/types';
import { ChannelTree } from '../../src/features/shell/ChannelTree';
import { initialState } from '../../src/store/state';
import { setState } from '../../src/store';

const org = 'fictional-org122', sid = 'fictional-server122', uid = 'fictional-user122';
const server: Server = { id: sid, org_id: org, name: 'Fictional team122', description: null, icon_emoji: null, position: 0, join_policy: 'invite', archived: false, my_role: 'member', member_count: 2, access: 'member' };
const channel: Channel = { id: 'lounge122', org_id: org, server_id: sid, kind: 'audio', name: 'lounge', topic: null, description: null, visibility: 'public', posting_policy: 'everyone', allow_replies: true, allow_reactions: true, auto_join: true, archived: false, position: 1, category: null, created_by: uid, created_at: '2026-10-28T00:00:00Z', member: true, my_role: 'member', notify: 'default', muted_until: null, last_seq: 0, last_read_seq: 0, unread: 0, mentions: 0, last_message_at: null, member_count: 2, dm_user_ids: null };
const open = vi.fn();
beforeEach(() => {
  localStorage.clear(); setState(initialState()); open.mockReset();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  setState({ session: { status: 'signed_in', userId: uid, email: null, setup: null }, servers: { [sid]: server }, channels: { [channel.id]: channel } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('discoverable server lounges122', () => {
  for (const variant of ['sidebar', 'home'] as const) it(`shows a labelled lounge in ${variant} without joining a call`, () => {
    render(<ChannelTree orgId={org} activeChannelId={null} onOpen={open} variant={variant} />);
    const list = screen.getByRole('list', { name: server.name + ' channels' });
    expect(within(list).getByRole('heading', { name: 'Voice lounges' })).toBeTruthy();
    expect(within(list).getByText('Open a room, then choose Join room.')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(list).getByRole('link', { name: /lounge/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith(channel.id);
  });
  it('keeps unjoined, archived and other-organisation rooms out, including a partial server', () => {
    setState({ servers: { [sid]: { ...server, my_role: null, access: 'partial' } }, channels: {
      joined: { ...channel, id: 'joined', name: 'Assigned voice', visibility: 'private' },
      unjoined: { ...channel, id: 'unjoined', name: 'Private hidden', visibility: 'private', member: false },
      publicHidden: { ...channel, id: 'publicHidden', name: 'Not joined', member: false },
      old: { ...channel, id: 'old', name: 'Archived room', archived: true },
      foreign: { ...channel, id: 'foreign', name: 'Other org', org_id: 'other' },
    } });
    render(<ChannelTree orgId={org} activeChannelId={null} onOpen={open} variant="sidebar" />);
    const list = screen.getByRole('list', { name: server.name + ' channels' });
    expect(list.querySelectorAll('a')).toHaveLength(1);
    expect(within(list).getByRole('link', { name: /Assigned voice/ })).toBeTruthy();
    expect(screen.queryByText('Private hidden')).toBeNull();
  });
  it('respects server collapse and does not advertise a room that is not present', () => {
    render(<ChannelTree orgId={org} activeChannelId={channel.id} onOpen={open} variant="home" />);
    fireEvent.click(screen.getByRole('button', { name: server.name }));
    expect(screen.queryByRole('heading', { name: 'Voice lounges' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: server.name }));
    expect(screen.getByRole('heading', { name: 'Voice lounges' })).toBeTruthy();
    act(() => setState({ channels: {} }));
    expect(screen.queryByRole('heading', { name: 'Voice lounges' })).toBeNull();
  });
});
