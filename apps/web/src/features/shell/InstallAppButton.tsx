// "Install the Dek app" where people actually look: the sidebar (the home layer on
// phones). Shown only while it can do something (Fixboard #1, "Need an app too"):
// - Chromium on Android and desktop: the browser's own install dialog (the stashed
//   beforeinstallprompt event, src/push/install.ts).
// - iPhone or iPad in Safari: the Add to Home Screen steps in Settings, Install.
// - iPhone in another browser: the same page, which says to open Dek in Safari first.
// Never inside the installed app or the native shells. "Not now" hides it on this
// device for 14 days.
import { useState } from 'react';
import { navigate } from '../../app/router';
import { isNativeApp } from '../../native';
import { useInstallPrompt } from '../../push/install';
import { Icon } from '../../ui/icons';

const DISMISS_KEY = 'dek.installDismissedAt';
const QUIET_MS = 14 * 24 * 60 * 60 * 1000;

function dismissedRecently(): boolean {
  try {
    const at = Number(window.localStorage.getItem(DISMISS_KEY) ?? 0);
    return Number.isFinite(at) && at > 0 && Date.now() - at < QUIET_MS;
  } catch {
    return false;
  }
}

export function InstallAppButton() {
  const install = useInstallPrompt();
  const [hidden, setHidden] = useState(dismissedRecently);
  const [busy, setBusy] = useState(false);

  if (hidden || isNativeApp() || install.installed) return null;
  const steps = install.showIosSteps || install.iosOtherBrowser;
  if (!install.canPrompt && !steps) return null;

  const go = async () => {
    if (install.canPrompt) {
      setBusy(true);
      try {
        await install.prompt();
      } finally {
        setBusy(false);
      }
      return;
    }
    navigate({ name: 'settings', section: 'install' });
  };

  const notNow = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // storage unavailable: hide for this page view only
    }
    setHidden(true);
  };

  return (
    <div className="dk-install" role="group" aria-label="Install Dek">
      <button type="button" className="dk-install__go" onClick={() => void go()} disabled={busy}>
        <Icon name={install.canPrompt ? 'download' : 'smartphone'} size={18} />
        <span className="dk-install__text">
          <span className="dk-install__title">Install the Dek app</span>
          <span className="dk-install__sub">
            {install.canPrompt ? 'Opens like an app, with notifications' : 'Add Dek to your Home Screen'}
          </span>
        </span>
      </button>
      <button type="button" className="dk-install__close" onClick={notNow} aria-label="Not now">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
