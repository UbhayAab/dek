// Who is looking, in which organization, with which role. Reads the shared store
// first (the shell keeps it current); when a screen opens before the store has the
// answer (a deep link, a cold start), it asks the server once and shares the answer
// between screens. Everything here is memory only and wiped when the signed-in
// person changes (shared phones).
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../../../api/rpc';
import { config } from '../../../config';
import { DekError, toDekError } from '../../../api/errors';
import type { MeResult, OrgRole, OrgSettings, OrgSummary, Profile, Server } from '../../../api/types';
import { actions, getState, setState, useDek } from '../../../store';
import { clearLoadCache, useLoad, type Load } from './load';
import { clearProfileCache, rememberProfiles } from './people';

// Links people share leave the app, so they always point at the public web origin
// (a native shell's own origin is not reachable from another phone).
export const PUBLIC_ORIGIN: string = config.publicOrigin;

export function inviteUrl(code: string): string {
  return `${PUBLIC_ORIGIN}/invite/${encodeURIComponent(code)}`;
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  edit_window_minutes: null,
  allow_guests: true,
  member_can_create_channels: true,
  member_can_invite: false,
  default_invite_hours: 168,
};

// ------------------------------------------------------------------ me

interface MeState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  me: MeResult | null;
  error: DekError | null;
}

let meState: MeState = { status: 'idle', me: null, error: null };
const meListeners = new Set<() => void>();
let meInflight: Promise<MeResult | null> | null = null;

function setMeState(next: MeState): void {
  meState = next;
  for (const l of meListeners) l();
}

function subscribeMe(l: () => void): () => void {
  meListeners.add(l);
  return () => { meListeners.delete(l); };
}

export function loadMe(force = false): Promise<MeResult | null> {
  if (meInflight && !force) return meInflight;
  setMeState({ ...meState, status: 'loading', error: null });
  const p = api.me().then(
    (me) => {
      setMeState({ status: 'ready', me, error: null });
      rememberProfiles([me.profile]);
      return me;
    },
    (err: unknown) => {
      setMeState({ status: 'error', me: meState.me, error: toDekError(err) });
      return null;
    },
  );
  meInflight = p;
  void p.finally(() => { if (meInflight === p) meInflight = null; });
  return p;
}

export interface MeInfo {
  me: MeResult | null;
  status: 'loading' | 'ready' | 'error';
  error: DekError | null;
  retry: () => void;
}

const retryMe = () => { void loadMe(true); };

export function useMe(): MeInfo {
  const storeMe = useDek((s) => s.me);
  const local = useSyncExternalStore(subscribeMe, () => meState, () => meState);
  useEffect(() => {
    if (!storeMe && local.status === 'idle') void loadMe();
  }, [storeMe, local.status]);
  if (storeMe) return { me: storeMe, status: 'ready', error: null, retry: retryMe };
  return {
    me: local.me,
    status: local.status === 'ready' ? 'ready' : local.status === 'error' ? 'error' : 'loading',
    error: local.error,
    retry: retryMe,
  };
}

export function useMyId(): string | null {
  const fromSession = useDek((s) => s.session.userId);
  const { me } = useMe();
  return fromSession ?? me?.user_id ?? null;
}

// After update_profile or set_status: the shell, message rows and this feature all
// show the confirmed profile at once.
export function patchMyProfile(p: Profile): void {
  setState((s) => ({
    me: s.me && s.me.user_id === p.id ? { ...s.me, profile: p } : s.me,
    profiles: { ...s.profiles, [p.id]: p },
  }));
  if (meState.me && meState.me.user_id === p.id) setMeState({ ...meState, me: { ...meState.me, profile: p } });
  rememberProfiles([p]);
}

// ------------------------------------------------------------------ organization

export interface OrgInfo {
  summary: OrgSummary | null;
  settings: OrgSettings;
  role: OrgRole | null;
  status: 'loading' | 'ready' | 'error';
  error: DekError | null;
  retry: () => void;
}

export function useOrg(orgId: string): OrgInfo {
  const boot = useDek((s) => (s.org && s.org.id === orgId ? s.org : null));
  const orgs = useDek((s) => s.orgs);
  const meInfo = useMe();
  const summary = boot ?? orgs.find((o) => o.id === orgId) ?? meInfo.me?.orgs.find((o) => o.id === orgId) ?? null;
  const settings = boot?.settings ? { ...DEFAULT_ORG_SETTINGS, ...boot.settings } : DEFAULT_ORG_SETTINGS;
  if (summary) {
    return { summary, settings, role: summary.my_role, status: 'ready', error: null, retry: meInfo.retry };
  }
  if (meInfo.status === 'ready') {
    return {
      summary: null, settings, role: null, status: 'error',
      error: new DekError('not_found', 'This organization does not exist or you are not an active member of it.'),
      retry: meInfo.retry,
    };
  }
  return { summary: null, settings, role: null, status: meInfo.status, error: meInfo.error, retry: meInfo.retry };
}

export function isOrgAdmin(role: OrgRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

// Every team server the caller can see in the org, cached per org.
export function useServers(orgId: string): Load<Server[]> {
  return useLoad(() => api.listServers(orgId), [orgId], { key: `servers:${orgId}` });
}

// me() again after a change to the caller's own memberships or role (leaving an
// organization, an owner changing their own role). The core's refreshMe keeps the
// store current; without it this feature refreshes its own copy and the store's.
export async function refreshMeEverywhere(): Promise<void> {
  try {
    await actions.refreshMe();
    return;
  } catch {
    // not registered in this build, or it failed: fall back below
  }
  const me = await loadMe(true);
  if (me && getState().me) setState({ me, orgs: me.orgs });
}

// The shell's sidebar (bootstrap) after a change that adds or removes servers or
// channels. Best effort: the realtime events cover most of it.
export function refreshShell(): void {
  try {
    const p = actions.refreshBootstrap();
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => undefined);
  } catch {
    // the core builder's actions are not registered in this build
  }
}

// ------------------------------------------------------------------ layout

const PHONE_QUERY = '(max-width: 767px)';

function subscribePhone(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const m = window.matchMedia(PHONE_QUERY);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

export function isPhoneNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

// The width of the screen itself decides one layer or two columns: next to the
// shell's rail and sidebar a tablet leaves too little room for two columns even
// above the phone breakpoint. The screen on display reports its state here.
let narrowNow: boolean | null = null;

export function setNarrowNow(v: boolean | null): void {
  narrowNow = v;
}

export function isNarrowNow(): boolean {
  return narrowNow ?? isPhoneNow();
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhoneNow, () => false);
}

// ------------------------------------------------------------------ hygiene

export function resetFeatureCaches(): void {
  clearLoadCache();
  clearProfileCache();
  meInflight = null;
  setMeState({ status: 'idle', me: null, error: null });
}

let lastUser: string | null = getState().session.userId;
useDek.subscribe((s) => {
  if (s.session.userId !== lastUser) {
    lastUser = s.session.userId;
    resetFeatureCaches();
  }
});
