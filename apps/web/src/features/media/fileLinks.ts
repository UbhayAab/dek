// How a person opens or saves a file, in one place.
//
// In a browser: Open is a new tab on the signed URL; Download is a link to the
// signed URL with download=<file name>, which Storage answers with
// Content-Disposition: attachment, so the browser saves it under its real name.
//
// In the Android and iOS apps (docs/NATIVE.md) the WebView cannot save anything
// itself: a blob link or a download link does nothing in the Android WebView. So
// both go to the system browser, using the signed URL itself (with
// download=<file name> for saving). The shell hands every top-level navigation to
// another origin to the system browser and leaves the app where it was (Capacitor:
// Android Bridge.launchIntent starts an ACTION_VIEW intent; iOS
// WebViewDelegationHandler calls UIApplication.shared.open). A link with
// target=_blank and no download attribute is exactly that navigation.
import type { AnchorHTMLAttributes } from 'react';
import { isNativeApp } from '../../native';
import { downloadUrl } from './signedUrls';

export type FileLinkProps = Pick<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel' | 'download'>;

const ELSEWHERE = { target: '_blank', rel: 'noopener noreferrer' } as const;

// View the file: the signed URL itself.
export function openLinkProps(signedUrl: string): FileLinkProps {
  return { href: signedUrl, ...ELSEWHERE };
}

// Where Open takes the person, for the link's label.
export function opensWhere(): string {
  return isNativeApp() ? 'in your browser' : 'in a new tab';
}

// Save the file under its real name.
export function saveLinkProps(signedUrl: string, fileName: string): FileLinkProps {
  const href = downloadUrl(signedUrl, fileName);
  return isNativeApp() ? { href, ...ELSEWHERE } : { href, download: fileName };
}

// The system share sheet (iOS Safari) needs the bytes as a blob; inside the apps
// the save link above goes to the system browser instead, which can share too.
export function blobShareAllowed(): boolean {
  return !isNativeApp();
}
