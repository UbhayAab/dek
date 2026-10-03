import { describe, expect, test } from 'vitest';
import type { AuditItem, InviteSummary } from '../../src/api/types';
import {
  auditExtras, auditSentence, expiryChoices, inviteStatus, readableBody, relTime, resolutionText, usesText, type AuditNames,
} from '../../src/features/admin/common/format';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const hours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function invite(over: Partial<InviteSummary> = {}): InviteSummary {
  return {
    id: 'i1', code: 'abcdefghijklmnopqrstuv', server_id: null, role: 'member', email: null, created_by: 'u1',
    created_at: hours(-1), expires_at: hours(24), max_uses: null, use_count: 0, revoked_at: null, requires_approval: false,
    ...over,
  };
}

describe('invite status', () => {
  test('active, expired, used up, revoked in the server order', () => {
    expect(inviteStatus(invite(), NOW)).toBe('active');
    expect(inviteStatus(invite({ expires_at: hours(-1) }), NOW)).toBe('expired');
    expect(inviteStatus(invite({ max_uses: 1, use_count: 1 }), NOW)).toBe('used_up');
    expect(inviteStatus(invite({ revoked_at: hours(-2), expires_at: hours(-1), max_uses: 1, use_count: 1 }), NOW)).toBe('revoked');
    expect(inviteStatus(invite({ expires_at: hours(-1), max_uses: 1, use_count: 1 }), NOW)).toBe('expired');
  });

  test('an invite to an archived team server no longer works', () => {
    expect(inviteStatus(invite({ server_id: 's1' }), NOW, new Set(['s1']))).toBe('revoked');
    expect(inviteStatus(invite({ server_id: 's2' }), NOW, new Set(['s1']))).toBe('active');
  });

  test('use counts read naturally', () => {
    expect(usesText(invite({ use_count: 1 }))).toBe('1 use, no limit');
    expect(usesText(invite({ use_count: 3, max_uses: 10 }))).toBe('3 of 10 used');
  });

  test('the organization default expiry is offered when it is not a standard choice', () => {
    expect(expiryChoices(168).map((c) => c.hours)).toEqual([1, 24, 72, 168, 336, 720]);
    const odd = expiryChoices(48);
    expect(odd.map((c) => c.hours)).toEqual([1, 24, 48, 72, 168, 336, 720]);
    expect(odd.find((c) => c.hours === 48)?.label).toMatch(/organization default/);
  });
});

describe('relative time', () => {
  test('recent, hours, days, then a date', () => {
    expect(relTime(hours(0), NOW, 'en')).toBe('just now');
    expect(relTime(new Date(NOW + 20_000).toISOString(), NOW, 'en')).toBe('just now');
    expect(relTime(new Date(NOW - 5 * 60_000).toISOString(), NOW, 'en')).toBe('5 minutes ago');
    expect(relTime(hours(3), NOW, 'en')).toBe('in 3 hours');
    expect(relTime(hours(-24), NOW, 'en')).toBe('yesterday');
    expect(relTime(hours(-24 * 10), NOW, 'en')).toMatch(/2026/);
    expect(relTime(null, NOW)).toBe('');
  });
});

describe('reports', () => {
  test('resolution codes read as sentences', () => {
    expect(resolutionText('dismiss')).toBe('Dismissed it');
    expect(resolutionText('remove_message: duplicate post')).toBe('Removed the message: duplicate post');
    expect(resolutionText(null)).toBe('');
  });

  test('mention tokens become names', () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    expect(readableBody(`<@${id}> look <!channel>`, () => 'Alice')).toBe('@Alice look @channel');
  });
});

describe('audit log sentences', () => {
  const names: AuditNames = {
    user: (id) => (id === 'bob' ? 'Bob' : 'someone'),
    server: (id) => (id === 's1' ? 'Tech' : 'a team server'),
    channel: () => '#grants',
  };
  const item = (action: string, details: Record<string, unknown> = {}, target_type: string | null = 'user', target_id: string | null = 'bob'): AuditItem => ({
    id: 1, actor: null, action, target_type, target_id, details, created_at: hours(0),
  });

  test('known actions read as plain sentences', () => {
    expect(auditSentence(item('org.role_changed', { from: 'member', to: 'admin' }), names)).toBe('changed the role of Bob from Member to Admin');
    expect(auditSentence(item('org.member_suspended'), names)).toBe('suspended Bob');
    expect(auditSentence(item('org.member_banned'), names)).toBe('removed and banned Bob');
    expect(auditSentence(item('server.created', { name: 'Tech' }, 'server', 's1'), names)).toBe('created the team server Tech');
    expect(auditSentence(item('server.members_added', { user_ids: ['a', 'b'] }, 'server', 's1'), names)).toBe('added 2 people to Tech');
    expect(auditSentence(item('invite.created', { server_id: 's1' }, 'invite', 'i1'), names)).toBe('created an invite link to Tech');
    expect(auditSentence(item('report.resolved', { action: 'remove_message' }, 'report', 'r1'), names)).toBe('resolved a report and removed the message');
    expect(auditSentence(item('channel.archived', {}, 'channel', 'c1'), names)).toBe('archived #grants');
  });

  test('unknown actions still read sensibly', () => {
    expect(auditSentence(item('server.something_new'), names)).toBe('something new (server)');
  });

  test('extras show reasons, notes and removed text', () => {
    expect(auditExtras(item('org.member_suspended', { reason: 'spam' }))).toEqual([{ label: 'Reason', value: 'spam' }]);
    expect(auditExtras(item('message.removed', { body: 'bad words', reason: 'report: spam' }, 'message', 'm1'))).toEqual([
      { label: 'Reason', value: 'report: spam' },
      { label: 'Removed text', value: 'bad words' },
    ]);
  });
});
