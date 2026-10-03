// Plain instructions per browser and platform (DEK16, DEK19, DEKA08, DEKA09). The
// browser cannot re-ask after a denial, so the only honest help is where to click.
import type { PlatformInfo } from '../../lib/platform';

export function IosInstallSteps({ platform }: { platform: PlatformInfo }) {
  if (platform.isIOS && !platform.isIOSSafari) {
    return (
      <ol className="dk-notif__steps">
        <li>Open this page in <strong>Safari</strong>. Other browsers on iPhone cannot add Dek to the Home Screen with notifications.</li>
        <li>Then follow the Safari steps that appear there.</li>
      </ol>
    );
  }
  return (
    <ol className="dk-notif__steps">
      <li>Tap the <strong>Share</strong> button (the square with an arrow pointing up) in Safari.</li>
      <li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
      <li>Open <strong>Dek</strong> from your Home Screen and sign in.</li>
      <li>Tap <strong>Turn on notifications</strong> there and choose <strong>Allow</strong>.</li>
      <li className="dk-notif__muted">This needs iOS 16.4 or later. A Safari tab on its own cannot receive notifications.</li>
    </ol>
  );
}

export function BlockedHelp({ platform }: { platform: PlatformInfo }) {
  const { os, browser, isStandalone } = platform;
  let steps: string[];
  if (os === 'ios' || os === 'ipados') {
    steps = ['Open the Settings app.', 'Tap Notifications, then Dek.', 'Turn on Allow Notifications.'];
  } else if (os === 'android' && isStandalone) {
    steps = ['Open Android Settings, then Apps, then Dek.', 'Tap Notifications and turn them on.', 'Come back to Dek.'];
  } else if (os === 'android' && browser === 'Samsung Internet') {
    steps = ['Tap the menu, then Settings, then Sites and downloads.', 'Tap Notifications and allow this site.', 'Reload Dek.'];
  } else if (os === 'android') {
    steps = ['Tap the three dots, then the (i) info icon or Site settings.', 'Tap Notifications (or Permissions) and choose Allow.', 'Reload Dek.'];
  } else if (browser === 'Firefox') {
    steps = ['Click the lock icon left of the address.', 'Next to Send notifications (Blocked), click the x to clear it.', 'Reload Dek and turn notifications on again.'];
  } else if (browser === 'Safari') {
    steps = ['In the Safari menu, open Settings, then Websites.', 'Choose Notifications on the left.', 'Find this site and set it to Allow.'];
  } else if (browser === 'Edge') {
    steps = ['Click the lock icon left of the address.', 'Open Permissions for this site.', 'Set Notifications to Allow, then reload Dek.'];
  } else {
    steps = ['Click the icon left of the address (a lock or sliders).', 'Open Site settings.', 'Set Notifications to Allow, then reload Dek.'];
  }
  return (
    <ol className="dk-notif__steps">
      {steps.map((s) => <li key={s}>{s}</li>)}
    </ol>
  );
}

export interface TroubleSection {
  id: string;
  title: string;
  points: string[];
}

export const TROUBLESHOOTING: TroubleSection[] = [
  {
    id: 'android',
    title: 'Android with Chrome',
    points: [
      'Install Dek (menu, Install app or Add to Home screen) for the most reliable delivery.',
      'Android Settings, Apps, Chrome (or Dek), Notifications: make sure they are on and the Dek channel is not silenced.',
      'Battery: set Chrome (or Dek) to Unrestricted. Xiaomi, Samsung, Oppo and Vivo phones stop background apps hard; allow Autostart where offered.',
      'Force stopping Chrome or Dek stops all notifications until you open it again.',
    ],
  },
  {
    id: 'iphone',
    title: 'iPhone or iPad (Home Screen app)',
    points: [
      'Notifications only work in the Dek app added to the Home Screen from Safari, on iOS 16.4 or later.',
      'Settings, Notifications, Dek: Allow Notifications, and choose Lock Screen and Banners.',
      'If Dek was added before iOS 16.4, delete it from the Home Screen and add it again.',
    ],
  },
  {
    id: 'chrome',
    title: 'Chrome on Windows, Mac or Linux',
    points: [
      'Chrome must be running (it can be minimised). Closed Chrome cannot show notifications on Windows unless "Continue running background apps" is on.',
      'Windows: Settings, System, Notifications: Chrome must be allowed. Mac: System Settings, Notifications, Google Chrome.',
    ],
  },
  {
    id: 'edge',
    title: 'Microsoft Edge',
    points: [
      'Edge, Settings, Cookies and site permissions, Notifications: Dek must be under Allow, and "Quieter notification requests" must not hide it.',
      'Windows Settings, System, Notifications: Microsoft Edge must be allowed.',
    ],
  },
  {
    id: 'firefox',
    title: 'Firefox',
    points: [
      'Firefox, Settings, Privacy and Security, Permissions, Notifications: Dek must be allowed.',
      'Firefox must be running to receive notifications.',
    ],
  },
  {
    id: 'safari',
    title: 'Safari on a Mac',
    points: [
      'Safari, Settings, Websites, Notifications: allow Dek.',
      'System Settings, Notifications, Safari: allow notifications.',
    ],
  },
  {
    id: 'android-app',
    title: 'The Dek app on Android',
    points: [
      'Android Settings, Apps, Dek, Notifications: turn them on, and keep the Messages and Calls categories on.',
      'Battery: set Dek to Unrestricted. Xiaomi, Samsung, Oppo and Vivo phones stop background apps hard; allow Autostart where offered.',
      'Force stopping Dek stops all notifications until you open it again.',
    ],
  },
  {
    id: 'ios-app',
    title: 'The Dek app on iPhone',
    points: [
      'Settings, Notifications, Dek: Allow Notifications, and choose Lock Screen and Banners.',
      'Scheduled Summary can hold Dek notifications for later: leave Dek out of it.',
    ],
  },
  {
    id: 'focus',
    title: 'Focus modes and Do Not Disturb',
    points: [
      'Do Not Disturb, Focus (iPhone and Mac), Focus assist (Windows) and bedtime modes hold notifications back silently. Dek cannot see them.',
      'Dek quiet hours (in notification settings) also hold back notifications on purpose; the health list shows these as skipped.',
      'A notification the push service accepted can still be delayed by the phone saving battery or by a weak network.',
    ],
  },
];
