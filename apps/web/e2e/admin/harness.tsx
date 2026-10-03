// Test harness for the admin and settings screens (served by the Vite dev server at
// /e2e/admin/harness.html, never built or deployed). It does what the shell does
// for these screens, nothing more: reads the stored session (the tests sign in as
// QA users and hand the session over as storage state), loads me() and the org's
// bootstrap into the real store, then renders the screen for the route given in
// ?route=. Everything else is the real code: the api wrappers, the store, the kit.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/ui/tokens.css';
import '../../src/ui/base.css';
import { supabase } from '../../src/api/client';
import { api } from '../../src/api/rpc';
import { useRoute } from '../../src/app/router';
import { getState, registerActions, resetState, setState, useDek } from '../../src/store';
import { Spinner, Toaster } from '../../src/ui/kit';
import { AdminScreen, BrowseScreen, ChannelSettingsScreen, ServerSettingsScreen } from '../../src/features/admin';
import { applyStoredTheme, SettingsScreen } from '../../src/features/settings';

declare global {
  interface Window {
    dekHarness: {
      ready: boolean;
      api: typeof api;
      userId: string | null;
      listAvatars: () => Promise<string[]>;
    };
  }
}

applyStoredTheme();

async function loadOrg(orgId: string): Promise<void> {
  const b = await api.bootstrap(orgId);
  setState({
    orgId,
    org: b.org,
    servers: Object.fromEntries(b.servers.map((s) => [s.id, s])),
    channels: Object.fromEntries(b.channels.map((c) => [c.id, c])),
    profiles: Object.fromEntries(b.profiles.map((p) => [p.id, p])),
    topics: b.topics,
    bootstrap: { status: 'ready', error: null, at: Date.now() },
  });
}

function Screen() {
  const route = useRoute();
  const status = useDek((s) => s.session.status);
  if (status === 'unknown') return <div style={{ padding: 24 }}><Spinner label="Starting" /></div>;
  if (status !== 'signed_in') return <main data-testid="harness-signed-out" style={{ padding: 24 }}>Signed out.</main>;
  switch (route.name) {
    case 'admin': return <AdminScreen orgId={route.orgId} section={route.section} />;
    case 'serverSettings': return <ServerSettingsScreen orgId={route.orgId} serverId={route.serverId} />;
    case 'channelSettings': return <ChannelSettingsScreen orgId={route.orgId} channelId={route.channelId} />;
    case 'browse': return <BrowseScreen orgId={route.orgId} serverId={route.serverId} />;
    case 'settings': return <SettingsScreen section={route.section} />;
    default: return <main data-testid="harness-elsewhere" style={{ padding: 24 }}>Left the admin screens: {route.name}</main>;
  }
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const route = params.get('route') ?? '/settings/profile';
  window.dekHarness = {
    ready: false,
    api,
    userId: null,
    listAvatars: async () => {
      const uid = window.dekHarness.userId;
      if (!uid) return [];
      const { data, error } = await supabase().storage.from('avatars').list(uid, { limit: 100 });
      if (error) throw error;
      return (data ?? []).map((o) => `${uid}/${o.name}`);
    },
  };
  const { data } = await supabase().auth.getSession();
  const session = data.session;
  if (session) {
    window.dekHarness.userId = session.user.id;
    setState((s) => ({ session: { ...s.session, status: 'signed_in', userId: session.user.id, email: session.user.email ?? null } }));
    const me = await api.me();
    setState({ me, orgs: me.orgs });
    const m = /^\/o\/([0-9a-f-]{36})/.exec(route);
    if (m?.[1]) await loadOrg(m[1]).catch(() => undefined);
  } else {
    setState((s) => ({ session: { ...s.session, status: 'signed_out' } }));
  }
  registerActions({
    refreshBootstrap: async () => {
      const id = getState().orgId;
      if (id) await loadOrg(id);
    },
    signOut: async () => {
      await supabase().auth.signOut({ scope: 'local' });
      resetState();
      setState((s) => ({ session: { ...s.session, status: 'signed_out' } }));
    },
  });
  window.history.replaceState(null, '', route);
  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <Screen />
        <Toaster />
      </StrictMode>,
    );
  }
  window.dekHarness.ready = true;
}

void boot();
