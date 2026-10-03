import { describe, expect, it } from 'vitest';
import type { Channel, Server } from '../../src/api/types';
import { badgeCount, dmChannels, orgCounts, serverAccess, serverSections } from '../../src/features/shell/model';
import { brandVars, contrast, onColor, orgInitials, safeColor } from '../../src/features/shell/branding';

const ORG = 'o1';
const OTHER = 'o2';

function server(id: string, extra: Partial<Server> = {}): Server {
  return { id, org_id: ORG, name: id, description: null, icon_emoji: null, position: 0, join_policy: 'invite', archived: false, my_role: 'member', member_count: 3, access: extra.my_role === null ? 'partial' : 'member', ...extra };
}

function chan(id: string, extra: Partial<Channel> = {}): Channel {
  return {
    id, org_id: ORG, server_id: 's1', kind: 'text', name: id, topic: null, description: null, visibility: 'public',
    posting_policy: 'everyone', allow_replies: true, allow_reactions: true, auto_join: false, archived: false, position: 0,
    category: null, created_by: null, created_at: '2026-10-01T00:00:00Z', member: true, my_role: 'member', notify: 'default',
    muted_until: null, last_seq: 0, last_read_seq: 0, unread: 0, mentions: 0, last_message_at: null, member_count: 4, dm_user_ids: null,
    ...extra,
  };
}

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

describe('server sections', () => {
  it('shows only channels the person is in, grouped by category, archived ones left out', () => {
    const servers = byId([server('s1')]);
    const channels = byId([
      chan('general', { position: 1 }),
      chan('announcements', { position: 0 }),
      chan('browse-only', { member: false }),
      chan('old', { archived: true }),
      chan('design', { category: 'Projects' }),
      chan('budget', { category: 'Projects', position: -1 }),
    ]);
    const [sec] = serverSections(ORG, servers, channels);
    expect(sec!.partial).toBe(false);
    expect(sec!.groups.map((g) => [g.category, g.channels.map((c) => c.id)])).toEqual([
      [null, ['announcements', 'general']],
      ['Projects', ['budget', 'design']],
    ]);
  });

  it('marks a partial server and hides one with nothing the person can open (DEK02)', () => {
    const servers = byId([server('s1', { my_role: null }), server('s2', { my_role: null, position: 1 })]);
    const channels = byId([chan('grants', { visibility: 'private' }), chan('secret', { server_id: 's2', member: false })]);
    const sections = serverSections(ORG, servers, channels);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.partial).toBe(true);
    expect(sections[0]!.groups[0]!.channels.map((c) => c.id)).toEqual(['grants']);
  });

  it('uses the server access field: partial shows, browse stays out of the sidebar', () => {
    const servers = byId([
      { ...server('s1'), access: 'partial' } as never,
      { ...server('s2', { my_role: null, position: 1 }), access: 'browse' } as never,
    ]);
    const channels = byId([chan('grants'), chan('open', { server_id: 's2', member: false })]);
    const sections = serverSections(ORG, servers, channels);
    expect(sections.map((x) => [x.server.id, x.partial])).toEqual([['s1', true]]);
    expect(serverAccess(server('s3'))).toBe('member');
    expect(serverAccess(server('s4', { my_role: null }))).toBe('partial');
  });

  it('never mixes organizations', () => {
    const servers = byId([server('s1'), server('x1', { org_id: OTHER })]);
    expect(serverSections(ORG, servers, {}).map((s) => s.server.id)).toEqual(['s1']);
    expect(serverSections(null, servers, {})).toEqual([]);
  });
});

describe('DMs and counts', () => {
  it('orders DMs by latest activity and leaves hidden ones out', () => {
    const channels = byId([
      chan('d1', { kind: 'dm', server_id: null, last_message_at: '2026-10-02T10:00:00Z' }),
      chan('d2', { kind: 'group_dm', server_id: null, last_message_at: '2026-10-03T10:00:00Z' }),
      chan('d3', { kind: 'dm', server_id: null, hidden: true }),
      chan('d4', { kind: 'dm', server_id: null, org_id: OTHER }),
    ]);
    expect(dmChannels(ORG, channels).map((c) => c.id)).toEqual(['d2', 'd1']);
  });

  it('counts unread channels without the muted ones, mentions always, DMs apart', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const channels = byId([
      chan('a', { unread: 3, mentions: 1 }),
      chan('b', { unread: 5, notify: 'none', mentions: 2 }),
      chan('c', { unread: 1, muted_until: '2026-10-03T13:00:00Z' }),
      chan('d', { kind: 'dm', server_id: null, unread: 4 }),
      chan('e', { unread: 9, org_id: OTHER }),
    ]);
    expect(orgCounts(ORG, channels, now)).toEqual({ unreadChannels: 1, mentions: 3, dmUnread: 4 });
    expect(badgeCount(channels.d!)).toBe(4);
    expect(badgeCount(channels.a!)).toBe(1);
  });
});

describe('branding', () => {
  it('accepts only hex colors, so nothing else reaches a style attribute', () => {
    expect(safeColor('#0F766E')).toBe('#0f766e');
    expect(safeColor('#abc')).toBe('#aabbcc');
    expect(safeColor('red;background:url(javascript:alert(1))')).toBe('#4f46e5');
    expect(safeColor('expression(alert(1))')).toBe('#4f46e5');
    expect(safeColor(null)).toBe('#4f46e5');
  });

  it('picks readable text on the brand color', () => {
    expect(onColor('#0f766e')).toBe('#ffffff');
    expect(onColor('#facc15')).toBe('#111114');
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
    const vars = brandVars('#7c3aed') as Record<string, string>;
    expect(vars['--org']).toBe('#7c3aed');
    expect(contrast(vars['--org']!, vars['--org-fg']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('makes short initials', () => {
    expect(orgInitials('Dek QA')).toBe('DQ');
    expect(orgInitials('Jarurat Care Foundation', 'JCF')).toBe('JC');
    expect(orgInitials('Tech')).toBe('TE');
  });
});
