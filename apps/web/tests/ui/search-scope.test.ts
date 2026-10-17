import { describe, expect, it } from 'vitest';
import { scopeError, scopeFromFilters } from '../../src/features/search/scope';
import { NO_FILTERS } from '../../src/features/search/Filters';

const ORG = '0f000000-0000-4000-8000-000000000001';
const CHAN = '0c000000-0000-4000-8000-000000000001';
const scope = scopeFromFilters({ ...NO_FILTERS, channel: CHAN }, 'messages', `/o/${ORG}/c/${CHAN}`);

describe('search scope validation', () => {
  it('accepts a supported conversation context', () => expect(scopeError(scope, ORG)).toBeNull());
  it.each([
    { v: '2' }, { tab: 'unknown' }, { in: 'invalid' }, { from: 'invalid' }, { has: 'unsupported' },
    { after: '2026-02-30' }, { after: '2026-10-18', before: '2026-10-01' },
    { back: '//evil.example/' }, { back: `/o/0f000000-0000-4000-8000-000000000002/c/${CHAN}` },
    { back: '/settings/profile' },
  ])('rejects malformed or foreign scope %j', patch => expect(scopeError({ ...scope, ...patch }, ORG)).not.toBeNull());
});
