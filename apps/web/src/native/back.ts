// OWNER: native builder. The Android back button (APP03 navigation).
//
// 1. A cancelable `dek:back` event goes to window first: an open sheet, dialog or
//    menu closes itself and calls preventDefault(), and nothing else happens.
// 2. At a root screen (home, an organization's root, sign-in) the app exits.
// 3. With in-app history, go back; without it (opened from a link or a push),
//    go to the screen's parent so back never leaves the app mid-conversation.
import { currentRoute, navigate, type Route } from '../app/router';
import { callNative, listenNative } from './bridge';

export const BACK_EVENT = 'dek:back';

export function isRootRoute(r: Route): boolean {
  return r.name === 'home' || r.name === 'org' || r.name === 'signin';
}

export function parentRoute(r: Route): Route {
  switch (r.name) {
    case 'channel':
      if (r.threadId) return { ...r, threadId: null, threadMessageId: null, messageId: null };
      return { name: 'org', orgId: r.orgId };
    case 'call':
    case 'view':
    case 'search':
    case 'browse':
    case 'admin':
      return { name: 'org', orgId: r.orgId };
    case 'serverSettings':
      return { name: 'browse', orgId: r.orgId, serverId: r.serverId };
    case 'channelSettings':
      return { name: 'channel', orgId: r.orgId, channelId: r.channelId, messageId: null, threadId: null, threadMessageId: null };
    default:
      return { name: 'home' };
  }
}

export function handleBack(canGoBack: boolean): 'handled' | 'exit' | 'history' | 'parent' {
  const ev = new CustomEvent(BACK_EVENT, { cancelable: true });
  window.dispatchEvent(ev);
  if (ev.defaultPrevented) return 'handled';
  const route = currentRoute();
  if (isRootRoute(route)) {
    void callNative('App', 'exitApp').catch(() => undefined);
    return 'exit';
  }
  if (canGoBack) {
    window.history.back();
    return 'history';
  }
  navigate(parentRoute(route), { replace: true });
  return 'parent';
}

export function installBackButton(): () => void {
  return listenNative<{ canGoBack: boolean }>('App', 'backButton', (e) => {
    handleBack(e?.canGoBack === true);
  });
}
