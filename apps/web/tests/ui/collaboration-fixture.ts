import type { Channel, Server } from '../../src/api/types';
export const ORG = '0f000000-0000-4000-8000-000000000001';
export const USER = '0a000000-0000-4000-8000-000000000001';
export const CHAN = '0c000000-0000-4000-8000-000000000001';
export const SERVER = '0b000000-0000-4000-8000-000000000001';
export const server: Server = { id: SERVER, org_id: ORG, name: 'Care team', description: null, icon_emoji: null,
  position: 0, join_policy: 'invite', archived: false, my_role: 'member', member_count: 3, access: 'member' };
export const channel: Channel = { id: CHAN, org_id: ORG, server_id: SERVER, kind: 'text', name: 'coordination',
  topic: null, description: null, visibility: 'private', posting_policy: 'everyone', allow_replies: true,
  allow_reactions: true, auto_join: false, archived: false, position: 0, category: 'Projects', created_by: USER,
  created_at: '2026-10-01T00:00:00Z', member: true, my_role: 'member', notify: 'default', muted_until: null,
  last_seq: 3, last_read_seq: 1, unread: 2, mentions: 1, last_message_at: null, member_count: 3, dm_user_ids: null };
