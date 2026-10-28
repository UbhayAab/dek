// The signed-in application frame (DEK04). Desktop (1100 px and up): sidebar,
// conversation, optional right pane. Tablet (768 to 1099): sidebar, main, with the
// pane as an overlay. There is no rail: the sidebar header switches organization and
// the sidebar already lists every server (Fixboard #19). Phone: one layer at a time with a
// bottom tab bar on root layers. The route decides the screen; the organization
// in the route decides the context (DEK01), selected deliberately and branded.
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { humanError } from '../../api/errors';
import { navigate, useRoute, type Route } from '../../app/router';
import { actions, useDek } from '../../store';
import { Skeleton, Spinner } from '../../ui/kit';
import { CallLayer } from '../calls';
import { Conversation } from '../conversation/Conversation';
import { SearchScreen } from '../search';
import { ViewScreen } from '../views';

// Admin, server and channel settings, Browse and Settings are opened by few people and
// rarely: they load on first use (a separate chunk the service worker precaches), so
// the first download of the app stays small (docs/LOAD.md, performance).
const admin = () => import('../admin');
const AdminScreen = lazy(() => admin().then((m) => ({ default: m.AdminScreen })));
const BrowseScreen = lazy(() => admin().then((m) => ({ default: m.BrowseScreen })));
const ChannelSettingsScreen = lazy(() => admin().then((m) => ({ default: m.ChannelSettingsScreen })));
const ServerSettingsScreen = lazy(() => admin().then((m) => ({ default: m.ServerSettingsScreen })));
const SettingsScreen = lazy(() => import('../settings').then((m) => ({ default: m.SettingsScreen })));
import { brandVars } from './branding';
import { ConnectionBanner } from './ConnectionBanner';
import { DmPicker } from './DmPicker';
import { useMeId, useOrgSummary } from './hooks';
import { useLayout, type Layout } from './layout';
import {
  BootstrapError, CallRouteScreen, HomeScreen, LegacyMessageRedirect, LegacyPlaceRedirect, LegacyRedirect, NoOrgScreen,
  NotFoundScreen, NotMemberScreen, OrgHome,
} from './screens';
import { Sidebar } from './Sidebar';
import { TabBar, tabOf } from './TabBar';
import { lastOrg, rememberOrg } from './ui-store';
import { run } from '../conversation/safe';
import './shell.css';
import '../conversation/conversation.css';

function routeOrg(route: Route): string | null {
  return 'orgId' in route ? route.orgId : null;
}

function activeChannelOf(route: Route): string | null {
  return route.name === 'channel' || route.name === 'channelSettings' ? route.channelId : null;
}

function screenFor(route: Route, orgId: string, layout: Layout): ReactNode {
  switch (route.name) {
    case 'channel':
      return <Conversation key={route.channelId} orgId={orgId} channelId={route.channelId} messageId={route.messageId}
        threadId={route.threadId} threadMessageId={route.threadMessageId} />;
    case 'org':
      return layout === 'phone' ? <HomeScreen orgId={orgId} /> : <OrgHome orgId={orgId} />;
    case 'view':
      return <ViewScreen key={`${orgId}:${route.view}`} orgId={orgId} view={route.view} layout={layout} />;
    case 'search':
      return <SearchScreen key={orgId} orgId={orgId} q={route.q} scope={route.scope} layout={layout} />;
    case 'browse':
      return <BrowseScreen orgId={orgId} serverId={route.serverId} />;
    // Keyed so that switching to another server, channel or organization starts a fresh
    // form: an unkeyed form kept server A's values and Save wrote them to server B.
    case 'serverSettings':
      return <ServerSettingsScreen key={`${orgId}:${route.serverId}`} orgId={orgId} serverId={route.serverId} />;
    case 'channelSettings':
      return <ChannelSettingsScreen key={`${orgId}:${route.channelId}`} orgId={orgId} channelId={route.channelId} />;
    case 'admin':
      return <AdminScreen key={orgId} orgId={orgId} section={route.section} />;
    case 'settings':
      return <SettingsScreen section={route.section} />;
    case 'call':
      return <CallRouteScreen orgId={orgId} callId={route.callId} />;
    case 'legacyChannel':
      return <LegacyRedirect channelId={route.channelId} messageId={route.messageId} />;
    case 'notFound':
      return <NotFoundScreen orgId={orgId} />;
    // Old link shapes (docs/migration/LEGACY-URLS.md)
    case 'legacyMessage':
      return <LegacyMessageRedirect channelId={route.channelId} legacySeq={route.legacySeq} />;
    case 'legacyView':
      return <LegacyPlaceRedirect orgId={orgId} place={{ kind: 'view', view: route.view }} />;
    case 'legacyAdmin':
      return <LegacyPlaceRedirect orgId={orgId} place={{ kind: 'admin', section: route.section }} />;
    case 'legacyServer':
      return <LegacyPlaceRedirect orgId={orgId} place={{ kind: 'server', serverId: route.serverId }} />;
    default:
      return <div className="dk-center"><Spinner size={22} label="Loading" /></div>;
  }
}

export function AppShell() {
  const route = useRoute();
  const layout = useLayout();
  const meId = useMeId();
  const meLoaded = useDek((s) => s.me !== null);
  const orgs = useDek((s) => s.orgs);
  const storeOrgId = useDek((s) => s.orgId);
  const bootstrap = useDek((s) => s.bootstrap);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const fromRoute = routeOrg(route);
  const remembered = lastOrg(meId);
  const orgId = fromRoute
    ?? (storeOrgId && orgs.some((o) => o.id === storeOrgId) ? storeOrgId : null)
    ?? (remembered && orgs.some((o) => o.id === remembered) ? remembered : null)
    ?? orgs[0]?.id
    ?? null;
  const known = !!orgId && orgs.some((o) => o.id === orgId);
  const org = useOrgSummary(orgId);

  // Signed in on /signin or at the root: go to the organization.
  useEffect(() => {
    if (route.name === 'signin') {
      navigate(route.next ?? (orgId ? { name: 'org', orgId } : { name: 'home' }), { replace: true });
    } else if (route.name === 'home' && orgId && known) {
      navigate({ name: 'org', orgId }, { replace: true });
    }
  }, [route, orgId, known]);

  // Switching organization is deliberate: the route names it, the store loads it.
  const requested = useRef<string | null>(null);
  useEffect(() => {
    if (!orgId || !meLoaded || !known) return;
    const key = `${orgId}:${attempt}`;
    if (requested.current === key) return;
    requested.current = key;
    rememberOrg(meId, orgId);
    // Already selected (the store may restore the last organization itself).
    if (attempt === 0 && storeOrgId === orgId && bootstrap.status !== 'idle') return;
    setSelectError(null);
    run(() => actions.selectOrg(orgId)).catch((e: unknown) => setSelectError(humanError(e)));
  }, [orgId, storeOrgId, meLoaded, known, bootstrap.status, meId, attempt]);

  // Browse and the settings screens live in a lazy chunk. Fetch it once the app is idle,
  // so the first tap on Browse channels does not wait for a download (Fixboard #19).
  useEffect(() => {
    if (!meLoaded) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const load = () => { void admin().catch(() => undefined); };
    if (w.requestIdleCallback) w.requestIdleCallback(load);
    else setTimeout(load, 3000);
  }, [meLoaded]);

  const retry = () => {
    setSelectError(null);
    setAttempt((n) => n + 1);
  };

  if (!meLoaded) {
    return <div className="dk-center"><Spinner size={22} label="Loading your organizations" /></div>;
  }
  if (!orgs.length) return <NoOrgScreen />;
  if (!orgId) return <NoOrgScreen />;
  if (fromRoute && !known) return <NotMemberScreen />;

  const loading = storeOrgId !== orgId || bootstrap.status === 'loading' || bootstrap.status === 'idle';
  const failed = (storeOrgId === orgId && bootstrap.status === 'error') || !!selectError;
  const spinner = <div className="dk-center"><Spinner size={22} label="Loading" /></div>;
  const content = failed
    ? <BootstrapError message={selectError ?? bootstrap.error} onRetry={retry} />
    : loading && route.name !== 'settings'
      ? spinner
      : <Suspense fallback={spinner}>{screenFor(route, orgId, layout)}</Suspense>;

  if (layout === 'phone') {
    const showTabs = tabOf(route) !== null || route.name === 'notFound' || route.name === 'legacyChannel';
    return (
      <div className="dk-shell" data-layout="phone" style={brandVars(org?.brand_color)}>
        <ConnectionBanner />
        <div className={`dk-main${showTabs ? ' has-tabs' : ''}`}>{content}</div>
        {showTabs ? <TabBar orgId={orgId} route={route} /> : null}
        <DmPicker orgId={orgId} />
        <CallLayer />
      </div>
    );
  }

  return (
    <div className="dk-shell" data-layout={layout} style={brandVars(org?.brand_color)}>
      {loading && !failed ? <SidebarSkeleton /> : <Sidebar orgId={orgId} route={route} activeChannelId={activeChannelOf(route)} />}
      <main className="dk-main" id="dk-main">
        <ConnectionBanner />
        <div className="dk-main__screen">{content}</div>
      </main>
      <DmPicker orgId={orgId} />
      <CallLayer />
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <aside className="dk-sidebar" aria-label="Conversations" aria-busy="true">
      <div className="dk-orghead"><span className="dk-orghead__skeleton" /></div>
      <div className="dk-sidebar__scroll">
        <Skeleton lines={1} avatar={false} />
        <Skeleton lines={4} avatar={false} />
        <Skeleton lines={3} avatar={false} />
      </div>
    </aside>
  );
}
