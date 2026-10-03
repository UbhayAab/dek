// Small store selectors the shell and screens reuse. Selectors return stored
// references (never fresh arrays) so zustand does not re-render in a loop.
import type { OrgRole, OrgSettings, OrgSummary } from '../../api/types';
import { useDek } from '../../store';

export function useMeId(): string | null {
  return useDek((s) => s.session.userId ?? s.me?.user_id ?? null);
}

export function useOrgSummary(orgId: string | null): OrgSummary | null {
  const fromBootstrap = useDek((s) => (s.org && s.org.id === orgId ? s.org : null));
  const fromList = useDek((s) => (orgId ? s.orgs.find((o) => o.id === orgId) ?? null : null));
  return fromBootstrap ?? fromList;
}

export function useOrgRole(orgId: string | null): OrgRole | null {
  return useOrgSummary(orgId)?.my_role ?? null;
}

export function useOrgSettings(orgId: string | null): OrgSettings | null {
  return useDek((s) => (s.org && s.org.id === orgId ? s.org.settings : null));
}
