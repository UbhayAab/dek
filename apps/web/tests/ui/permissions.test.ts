import { describe, expect, it } from 'vitest';
import type { Channel, Message, Server } from '../../src/api/types';
import {
  canDelete, canManageChannel, canMentionAll, canModerate, canPin, editState, postState, type Who,
} from '../../src/features/conversation/permissions';

const ME = 'me';

function chan(extra: Partial<Channel> = {}): Channel {
  return {
    id: 'c', org_id: 'o', server_id: 's', kind: 'text', name: 'general', topic: null, description: null, visibility: 'public',
    posting_policy: 'everyone', allow_replies: true, allow_reactions: true, auto_join: false, archived: false, position: 0,
    category: null, created_by: null, created_at: '2026-10-01T00:00:00Z', member: true, my_role: 'member', notify: 'default',
    muted_until: null, last_seq: 0, last_read_seq: 0, unread: 0, mentions: 0, last_message_at: null, member_count: 10, dm_user_ids: null,
    ...extra,
  };
}

function server(role: Server['my_role'], extra: Partial<Server> = {}): Server {
  return { id: 's', org_id: 'o', name: 'S', description: null, icon_emoji: null, position: 0, join_policy: 'invite', archived: false, my_role: role, member_count: 5, access: role ? 'member' : 'browse', ...extra };
}

const member: Who = { meId: ME, orgRole: 'member', server: server('member') };
const modWho: Who = { meId: ME, orgRole: 'member', server: server('moderator') };
const orgAdmin: Who = { meId: ME, orgRole: 'admin', server: server(null) };

function msg(extra: Partial<Message> = {}): Message {
  return {
    id: 'm', org_id: 'o', channel_id: 'c', seq: 1, thread_root_id: null, author_id: ME, kind: 'user', body: 'hi', mentions: [],
    mention_all: false, client_id: null, created_at: '2026-10-03T10:00:00Z', edited_at: null, deleted_at: null, updated_at: '2026-10-03T10:00:00Z',
    reply_count: 0, last_reply_at: null, reply_user_ids: [], reactions: {}, attachments: [], pinned: false, also_in_channel: false, meta: {},
    ...extra,
  };
}

describe('posting (mirrors dek.assert_post)', () => {
  it('allows members in ordinary channels', () => {
    expect(postState(chan(), member, false)).toEqual({ ok: true });
  });

  it('explains archived, announcement and not-a-member states', () => {
    expect(postState(chan({ archived: true }), member, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/archived/) });
    expect(postState(chan(), { ...member, server: server('member', { archived: true }) }, false)).toMatchObject({ ok: false });
    const announce = chan({ posting_policy: 'admins' });
    expect(postState(announce, member, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/Only admins/) });
    expect(postState(announce, modWho, false)).toEqual({ ok: true });
    // Announcements still take thread replies when replies are on.
    expect(postState(announce, member, true)).toEqual({ ok: true });
    expect(postState(chan({ posting_policy: 'admins', allow_replies: false }), member, true)).toMatchObject({ ok: false });
    expect(postState(chan({ member: false }), member, false)).toMatchObject({ ok: false, action: 'join' });
    expect(postState(chan({ member: false, visibility: 'private' }), member, false)).toMatchObject({ ok: false });
    expect(postState(undefined, member, false)).toMatchObject({ ok: false });
  });
});

describe('moderation and management', () => {
  it('follows dek.can_moderate_channel', () => {
    expect(canModerate(chan(), member)).toBe(false);
    expect(canModerate(chan(), modWho)).toBe(true);
    expect(canModerate(chan({ my_role: 'owner' }), member)).toBe(true);
    expect(canModerate(chan({ kind: 'dm', server_id: null }), modWho)).toBe(false);
    expect(canModerate(chan({ kind: 'dm', server_id: null }), orgAdmin)).toBe(true);
  });

  it('lets channel owners, server admins and org admins manage', () => {
    expect(canManageChannel(chan(), member)).toBe(false);
    expect(canManageChannel(chan(), modWho)).toBe(false);
    expect(canManageChannel(chan(), { ...member, server: server('admin') })).toBe(true);
    expect(canManageChannel(chan({ my_role: 'owner' }), member)).toBe(true);
    expect(canManageChannel(chan(), orgAdmin)).toBe(true);
  });

  it('offers @channel to moderators and in channels of 50 or fewer', () => {
    expect(canMentionAll(chan({ member_count: 50 }), member)).toBe(true);
    expect(canMentionAll(chan({ member_count: 51 }), member)).toBe(false);
    expect(canMentionAll(chan({ member_count: 51 }), modWho)).toBe(true);
    expect(canMentionAll(chan({ kind: 'dm', server_id: null }), orgAdmin)).toBe(false);
  });

  it('pins in announcement channels only for moderators', () => {
    expect(canPin(chan(), member)).toBe(true);
    expect(canPin(chan({ posting_policy: 'admins' }), member)).toBe(false);
    expect(canPin(chan({ posting_policy: 'admins' }), modWho)).toBe(true);
    expect(canPin(chan({ member: false }), member)).toBe(false);
  });
});

describe('editing and deleting', () => {
  const now = Date.parse('2026-10-03T10:30:00Z');

  it('edits own messages inside the edit window only', () => {
    expect(editState(msg(), ME, { edit_window_minutes: null, allow_guests: true, member_can_create_channels: true, member_can_invite: true, default_invite_hours: 72 }, now)).toEqual({ ok: true });
    expect(editState(msg(), ME, { edit_window_minutes: 15, allow_guests: true, member_can_create_channels: true, member_can_invite: true, default_invite_hours: 72 }, now))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/15 minutes/) });
    expect(editState(msg({ author_id: 'other' }), ME, null, now)).toMatchObject({ ok: false });
    expect(editState(msg({ deleted_at: '2026-10-03T10:10:00Z' }), ME, null, now)).toMatchObject({ ok: false });
  });

  it('deletes own messages, or any as a moderator', () => {
    expect(canDelete(msg(), ME, false)).toBe(true);
    expect(canDelete(msg({ author_id: 'other' }), ME, false)).toBe(false);
    expect(canDelete(msg({ author_id: 'other' }), ME, true)).toBe(true);
    expect(canDelete(msg({ kind: 'system' }), ME, true)).toBe(false);
  });
});
