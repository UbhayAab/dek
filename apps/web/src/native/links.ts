// OWNER: native builder. Deep links into the app (DEK18): App Links and Universal
// Links on https://dek-7o4.pages.dev, the dek:// fallback scheme, and the `url` a
// push notification carries. Every link ends up as an in-app path that the router
// recognises; anything else is ignored, never navigated to.
import { navigate, parse } from '../app/router';

export const WEB_ORIGIN = 'https://dek-7o4.pages.dev';
const WEB_HOST = new URL(WEB_ORIGIN).host;

export function inAppPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let path: string;
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return null;
    path = raw;
  } else {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.protocol === 'https:' && u.host === WEB_HOST) {
      path = u.pathname + u.search + u.hash;
    } else if (u.protocol === 'dek:') {
      // dek://o/<org>/c/<channel> parses with host "o"; dek:///o/... with an empty host.
      const rest = [u.host, u.pathname.replace(/^\/+/, '')].filter(Boolean).join('/');
      path = `/${rest}${u.search}${u.hash}`;
    } else {
      return null;
    }
  }
  return parse(path).name === 'notFound' ? null : path;
}

// Opens a link inside the app. When the person is signed out the app shows the
// sign-in screen on top of this route, so the link opens after authentication.
export function openInApp(raw: unknown): boolean {
  const path = inAppPath(raw);
  if (!path) return false;
  navigate(path);
  return true;
}
