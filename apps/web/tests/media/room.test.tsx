import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Call, Channel } from '../../src/api/types';

vi.mock('../../src/api/client', () => ({
  supabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({}) },
  }),
  rpc: async () => { throw new Error('no rpc in tests'); },
}));
vi.mock('../../src/api/rpc', () => ({
  api: { activeCalls: async () => [], getProfiles: async () => [] },
}));

const { setState, resetState } = await import('../../src/store');
const { AudioRoomPanel, CallButton } = await import('../../src/features/calls');

const CH = 'room-chan';
const channel = (over: Partial<Channel> = {}): Channel => ({
  id: CH, org_id: 'org', server_id: 's', kind: 'audio', name: 'huddle', topic: null, description: null, visibility: 'public',
  posting_policy: 'everyone', allow_replies: true, allow_reactions: true, auto_join: false, archived: false, position: 0,
  category: null, created_by: null, created_at: '2026-10-03T10:00:00Z', member: true, my_role: 'member', notify: 'default',
  muted_until: null, last_seq: 0, last_read_seq: 0, unread: 0, mentions: 0, last_message_at: null, member_count: 9,
  dm_user_ids: null, ...over,
});

function room(joined: number): Call {
  return {
    id: 'call-r', org_id: 'org', channel_id: CH, kind: 'room', media: 'audio', started_by: 'u0', created_at: '2026-10-03T10:00:00Z',
    ended_at: null, end_reason: null,
    participants: Array.from({ length: joined }, (_, i) => ({ user_id: `u${i}`, state: 'joined' as const, session_id: `s${i}`, joined_at: `2026-10-03T10:0${i}:00Z` })),
  };
}

function world(joined: number, over: Partial<Channel> = {}) {
  resetState();
  setState({
    session: { status: 'signed_in', userId: 'me', email: 'me@x', setup: null },
    orgId: 'org',
    channels: { [CH]: channel(over) },
    calls: joined ? { 'call-r': room(joined) } : {},
  });
}

afterEach(() => cleanup());

describe('audio room panel (DEK21, DEK23)', () => {
  test('nobody yet: an invitation to join', () => {
    world(0);
    render(<AudioRoomPanel channelId={CH} />);
    expect(screen.getByText('Nobody is here yet')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Join room' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('seven people: room for one more, each listed once', () => {
    world(7);
    render(<AudioRoomPanel channelId={CH} />);
    expect(screen.getByText('7 of 8 people here')).toBeTruthy();
    expect(document.querySelectorAll('.dc-room__person')).toHaveLength(7);
    expect((screen.getByRole('button', { name: 'Join room' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('eight people: the room says it is full instead of offering a join the server would refuse', () => {
    world(8);
    render(<AudioRoomPanel channelId={CH} />);
    expect(screen.getByText('8 of 8 people here')).toBeTruthy();
    const join = screen.getByRole('button', { name: 'Room is full' }) as HTMLButtonElement;
    expect(join.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/8 people, the most a room can hold/);
    render(<CallButton channelId={CH} />);
    expect((screen.getByRole('button', { name: 'The audio room is full' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a reconnect listed twice by a stale roster still shows the person once (DEKA13)', () => {
    world(0);
    const c = room(2);
    c.participants.push({ user_id: 'u1', state: 'joined', session_id: 's1-new', joined_at: '2026-10-03T10:09:00Z' });
    setState({ calls: { 'call-r': c } });
    render(<AudioRoomPanel channelId={CH} />);
    expect(document.querySelectorAll('.dc-room__person[data-user="u1"]')).toHaveLength(1);
    expect(screen.getByText('2 of 8 people here')).toBeTruthy();
  });

  test('an archived channel has no room to join', () => {
    world(0, { archived: true });
    render(<AudioRoomPanel channelId={CH} />);
    expect((screen.getByRole('button', { name: 'Join room' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/archived/)).toBeTruthy();
  });
});
