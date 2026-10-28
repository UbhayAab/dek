// Install Dek (DEK16): the browser's own install prompt when it offers one (the
// platform builder's useInstallPrompt), the steps for this browser when it does not,
// and the iPhone Home Screen steps that iPhone notifications depend on. Never "not
// supported" for an iPhone.
import { useState } from 'react';
import { Banner, Button, toast } from '../../../ui/kit';
import { Icon } from '../../../ui/icons';
import { PUBLIC_ORIGIN } from '../../admin/common/context';
import { Card, Section } from '../../admin/common/ui';
import { iosTooOldForPush, type PlatformInfo } from '../../../lib/platform';
import { useInstall } from '../install';

export function InstallSection() {
  const inst = useInstall();
  const p = inst.platform;
  const [busy, setBusy] = useState(false);
  const onInstall = async () => {
    setBusy(true);
    const out = await inst.prompt();
    setBusy(false);
    if (out === 'accepted') toast({ kind: 'success', title: 'Installing Dek', body: 'It appears with your apps in a moment.' });
    else if (out === 'dismissed') toast({ kind: 'info', title: 'Not installed', body: 'You can install it from here any time.' });
    else toast({ kind: 'error', title: 'The install did not start', body: 'Use the steps below instead.' });
  };

  return (
    <>
      <Section title="Install Dek" description="Dek runs in the browser. Installed, it opens in its own window like an app, and on an iPhone it can show notifications.">
        {inst.installed ? (
          <Banner tone="success">Dek is installed on this device. Open it from your Home Screen or app list.</Banner>
        ) : inst.canPrompt ? (
          <Card>
            <p className="ap-card__text">This browser can install Dek right away.</p>
            <div className="ap-form__actions ap-form__actions--start">
              <Button variant="primary" icon="download" onClick={onInstall} loading={busy}>Install Dek</Button>
            </div>
          </Card>
        ) : (
          <Card>
            <h3 className="ap-card__title">On this device</h3>
            <ThisDeviceSteps p={p} />
          </Card>
        )}
      </Section>
      <Section title="On an iPhone or iPad" description="iPhone notifications only work for Dek added to the Home Screen (iOS 16.4 or later).">
        <Card tone={p.isIOS && !inst.installed ? undefined : 'muted'}>
          <IphoneSteps p={p} />
        </Card>
      </Section>
    </>
  );
}

function ThisDeviceSteps({ p }: { p: PlatformInfo }) {
  if (p.isIOS) {
    return p.isIOSSafari
      ? <p className="ap-card__text">Follow the iPhone steps below.</p>
      : <p className="ap-card__text">{p.browser} on an iPhone cannot add Dek with notifications. Open <span className="ap-strong">{host()}</span> in Safari and follow the steps below.</p>;
  }
  if (p.isAndroid) {
    return (
      <ol className="set-steps">
        <li>Open the browser menu (the three dots).</li>
        <li>Tap <span className="ap-strong">Install app</span> or <span className="ap-strong">Add to Home screen</span>.</li>
        <li>Open Dek from its new icon.</li>
      </ol>
    );
  }
  if (p.browser === 'Firefox') {
    return <p className="ap-card__text">Firefox on a computer cannot install web apps. Dek works fully in a pinned tab, and notifications arrive while Firefox is open.</p>;
  }
  if (p.browser === 'Safari') {
    return (
      <ol className="set-steps">
        <li>In the menu bar choose <span className="ap-strong">File</span>, then <span className="ap-strong">Add to Dock</span> (macOS Sonoma or later).</li>
        <li>Open Dek from the Dock.</li>
      </ol>
    );
  }
  return (
    <ol className="set-steps">
      <li>Click the install icon at the right end of the address bar, or open the browser menu (the three dots).</li>
      <li>Choose <span className="ap-strong">Install Dek</span> (in Chrome it can sit under Cast, save and share).</li>
      <li>Dek opens in its own window and shows up with your apps.</li>
    </ol>
  );
}

function IphoneSteps({ p }: { p: PlatformInfo }) {
  return (
    <>
      <ol className="set-steps">
        <li>Open <span className="ap-strong">{host()}</span> in <span className="ap-strong">Safari</span>.</li>
        <li>
          Tap the Share button <span className="set-inline-icon" aria-hidden="true"><Icon name="share" size={16} /></span>
          {' '}(a square with an arrow, at the bottom of the screen; on an iPad at the top).
        </li>
        <li>Scroll down and tap <span className="ap-strong">Add to Home Screen</span>, then <span className="ap-strong">Add</span>.</li>
        <li>Open Dek from the new icon on your Home Screen and sign in.</li>
        <li>In Dek go to Settings, Notification health, and turn notifications on. Allow them when iOS asks.</li>
      </ol>
      {iosTooOldForPush(p) ? (
        <Banner tone="warning">This iPhone runs iOS {p.iosVersion}. Notifications need iOS 16.4 or later: Settings, General, Software Update.</Banner>
      ) : null}
    </>
  );
}

function host(): string {
  return PUBLIC_ORIGIN.replace(/^https?:\/\//, '');
}
