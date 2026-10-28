import { parse, type SearchRouteScope } from '../../app/router';
import type { Profile } from '../../api/types';
import { NO_FILTERS, type HasFilter, type SearchFilters } from './Filters';
import { dateRangeError } from './dates';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type SearchTab = 'messages' | 'files';

export function scopeError(scope: SearchRouteScope | undefined, orgId: string): string | null {
  if (!scope) return null;
  if (scope.v !== '1') return 'This search link uses an unsupported version.';
  if (!['messages', 'files'].includes(scope.tab)) return 'Choose Messages or Files to search.';
  if (scope.in && !UUID.test(scope.in)) return 'The conversation in this search link is invalid. Choose a conversation in Filters.';
  if (scope.from && !UUID.test(scope.from)) return 'The person in this search link is invalid. Choose a person in Filters.';
  if (!['', 'file', 'link', 'pin'].includes(scope.has)) return 'The Has filter in this search link is invalid.';
  const dates = dateRangeError(scope.after, scope.before);
  if (dates) return dates;
  if (scope.back) {
    const route = parse(scope.back);
    if (!scope.back.startsWith('/') || scope.back.startsWith('//') || route.name !== 'channel' || route.orgId !== orgId || route.channelId !== scope.in) {
      return 'The return conversation in this search link is invalid.';
    }
  }
  return null;
}

export function filtersFromScope(scope: SearchRouteScope | undefined, profiles: Record<string, Profile>): SearchFilters {
  if (!scope) return NO_FILTERS;
  return {
    channel: scope.in,
    author: scope.from ? profiles[scope.from] ?? { id: scope.from, display_name: 'Selected person', avatar_path: null } : null,
    after: scope.after, before: scope.before, has: scope.has as HasFilter,
  };
}

export function scopeFromFilters(filters: SearchFilters, tab: SearchTab, back = ''): SearchRouteScope {
  return { v: '1', tab, in: filters.channel, from: filters.author?.id ?? '', after: filters.after,
    before: filters.before, has: filters.has, back };
}
