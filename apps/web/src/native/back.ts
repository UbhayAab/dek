// OWNER: native builder. The Android back button (APP03 navigation).
//
// 1. A cancelable `dek:back` event goes to window first: an open sheet or menu
//    closes itself and calls preventDefault(), and nothing else happens.
// 2. The topmost open <dialog> gets the same cancel event Escape sends; the kit's
//    Modal and the photo viewer close on it (a non-dismissable one stays).
// 3. At a root screen (home, an organization's root, sign-in) the app exits.
// 4. Otherwise the router's own in-app back: history when the app went deeper
//    (navigateDeeper), else the screen's parent, so back never leaves the app
//    mid-conversation and behaves like the in-app back arrows.
//
// The plugin's `canGoBack` is not used: the Android WebView reports false for
// history entries made with pushState (measured on the API 36 emulator,
// WebView 133, 2026-10-04), so it says nothing about in-app history.
import { back, currentRoute, type Route } from '../app/router';
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

function cancelTopDialog(): boolean {
  const open = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  const top = open[open.length - 1];
  if (!top) return false;
  // dispatchEvent is false when a listener called preventDefault (it closes itself).
  if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
  return true;
}

export function handleBack(): 'handled' | 'dialog' | 'exit' | 'back' {
  const ev = new CustomEvent(BACK_EVENT, { cancelable: true });
  window.dispatchEvent(ev);
  if (ev.defaultPrevented) return 'handled';
  if (cancelTopDialog()) return 'dialog';
  const route = currentRoute();
  if (isRootRoute(route)) {
    void callNative('App', 'exitApp').catch(() => undefined);
    return 'exit';
  }
  back(parentRoute(route));
  return 'back';
}

export function installBackButton(): () => void {
  return listenNative('App', 'backButton', () => {
    handleBack();
  });
}
