// Notification health (DEK19): every link in the chain from this device to the
// server's device record and the last 20 delivery attempts, a user-initiated test
// that tells "accepted" apart from "displayed", and plain help per platform. In the
// Android and iOS apps the chain is the native one (FCM or APNs, docs/NATIVE.md).
import { useCallback, useEffect, useState } from 'react';
import { humanError } from '../../api/errors';
import { config } from '../../config';
import { detect, deviceLabel, type PlatformInfo } from '../../lib/platform';
import {
  isNativeApp, nativePushStatus, onNativePushReceived, openNativeNotificationSettings, type NativePushStatus,
} from '../../native';
import { useInstallPrompt } from '../../push/install';
import {
  currentSubscription, endpointHost, enablePush, keysMatch, permission, pushSupport, storedDevice, subscribeAndRegister,
  urlBase64ToUint8Array, type Permission, type PushSupport,
} from '../../push/push';
import { getRegistration, onSwMessage, workerVersion } from '../../sw/register';
import { useDek } from '../../store';
import { Banner, Button, Spinner } from '../../ui/kit';
import {
  RecentDeliveries, Row, ServerRecordRow, TestNotification, Troubleshooting, YourDevices, useServerHealth,
} from './healthParts';
import { BlockedHelp, IosInstallSteps } from './steps';

export function NotificationHealth() {
  return isNativeApp() ? <NativeHealth /> : <WebHealth />;
}

function Intro() {
  return (
    <div>
      <h2 id="dk-health-title" className="dk-health__h">Notification health</h2>
      <p className="dk-health__intro">
        Unread counts inside Dek work without any of this. Notifications outside Dek reach this device only when every line below is green.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- browser

interface LocalFacts {
  platform: PlatformInfo;
  support: PushSupport;
  permission: Permission;
  sw: 'unsupported' | 'none' | 'installing' | 'waiting' | 'active';
  swVersion: string | null;
  subscribed: boolean;
  host: string | null;
  keyOk: boolean | null;
}

async function gatherLocal(): Promise<LocalFacts> {
  const platform = detect();
  const support = pushSupport(platform);
  let sw: LocalFacts['sw'] = 'unsupported';
  let swVersion: string | null = null;
  if ('serviceWorker' in navigator) {
    const reg = await getRegistration();
    sw = !reg ? 'none' : reg.waiting ? 'waiting' : reg.active ? 'active' : reg.installing ? 'installing' : 'none';
    swVersion = await workerVersion();
  }
  const sub = await currentSubscription();
  return {
    platform,
    support,
    permission: permission(),
    sw,
    swVersion,
    subscribed: !!sub,
    host: endpointHost(sub?.endpoint),
    keyOk: sub ? keysMatch(sub.options.applicationServerKey, urlBase64ToUint8Array(config.vapidPublicKey)) : null,
  };
}

function WebHealth() {
  const userId = useDek((s) => s.session.userId);
  const install = useInstallPrompt();
  const [local, setLocal] = useState<LocalFacts | null>(null);
  const health = useServerHealth();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLocal(await gatherLocal());
    await health.refresh();
  }, [health.refresh]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const observeShown = useCallback((onShown: (at: number) => void) => onSwMessage('push-shown', (d) => {
    if (d.kind === 'test') onShown(typeof d.at === 'number' ? d.at : Date.now());
  }), []);

  const stored = userId ? storedDevice(userId) : null;
  const myDevice = health.server?.devices.find((d) => d.id === stored?.id) ?? null;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(humanError(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };
  const turnOn = () => run('on', async () => {
    if (!userId) return;
    const r = await enablePush(userId);
    if (!r.ok) setActionError(r.message);
  });
  const fix = () => run('fix', async () => {
    if (!userId) return;
    const r = await subscribeAndRegister(userId);
    if (!r.ok) setActionError(r.message);
  });

  if (!local) {
    return <section className="dk-health" aria-busy="true"><Spinner label="Checking notifications" /></section>;
  }
  const p = local.platform;

  const supportRow = (() => {
    switch (local.support) {
      case 'supported': return <Row tone="ok" label="This browser supports notifications" detail={`${deviceLabel(p)}.`} />;
      case 'ios-needs-install': return (
        <Row tone="warn" label="Add Dek to your Home Screen" detail="On iPhone and iPad, notifications work in the Home Screen app (iOS 16.4 or later), not in a Safari tab.">
          <IosInstallSteps platform={p} />
        </Row>
      );
      case 'ios-too-old': return <Row tone="bad" label="This iOS version cannot receive web notifications" detail="Update to iOS 16.4 or later, then add Dek to the Home Screen from Safari." />;
      case 'insecure': return <Row tone="bad" label="Not a secure page" detail="Notifications need Dek to be opened over https." />;
      default: return <Row tone="bad" label="This browser cannot show Dek notifications" detail="Use Chrome, Edge, Firefox or Safari, or the Dek app. Unread counts inside Dek still work." />;
    }
  })();

  const permRow = (() => {
    if (local.permission === 'granted') return <Row tone="ok" label="Permission: allowed" detail="This browser lets Dek show notifications." />;
    if (local.permission === 'denied') return (
      <Row tone="bad" label="Permission: blocked" detail="The browser will not ask again. Allow it in the browser's settings:">
        <BlockedHelp platform={p} />
      </Row>
    );
    if (local.permission === 'default') return (
      <Row tone="warn" label="Permission: not asked yet" detail="Dek asks only when you press the button.">
        {local.support === 'supported' ? <Button variant="primary" loading={busy === 'on'} onClick={() => void turnOn()}>Turn on notifications</Button> : null}
      </Row>
    );
    return <Row tone="info" label="Permission: not available" detail="This browser has no notification permission to give." />;
  })();

  const installRow = install.installed
    ? <Row tone="ok" label="Installed as an app" detail="Dek runs from your Home Screen or app list." />
    : (
      <Row tone={p.isIOS ? 'warn' : 'info'} label="Not installed" detail={p.isIOS ? 'Required for notifications on iPhone and iPad.' : 'Optional. Installed apps get notifications more reliably on phones.'}>
        {install.canPrompt ? <Button variant="secondary" onClick={() => void install.prompt()}>Install Dek</Button> : null}
      </Row>
    );

  const swRow = (() => {
    if (local.sw === 'active') return <Row tone="ok" label="Service worker running" detail={local.swVersion ? `Version ${local.swVersion}.` : 'Active.'} />;
    if (local.sw === 'waiting') return <Row tone="warn" label="An update is waiting" detail="Reload Dek to finish updating." />;
    if (local.sw === 'installing') return <Row tone="info" label="Service worker installing" detail="This takes a moment on the first visit." />;
    if (local.sw === 'none') {
      return <Row tone="bad" label="Service worker not running" detail={import.meta.env.DEV ? 'This is a development build; notifications need the built app.' : 'Reload Dek. If this stays, the browser may be blocking site data.'} />;
    }
    return <Row tone="bad" label="Service workers are not available" detail="Private browsing or browser settings can disable them." />;
  })();

  const subRow = !local.subscribed
    ? (
      <Row tone={local.permission === 'granted' ? 'bad' : 'info'} label="No subscription on this device" detail="This device is not set up to receive Dek notifications.">
        {local.permission === 'granted' ? <Button variant="primary" loading={busy === 'fix'} onClick={() => void fix()}>Fix</Button> : null}
      </Row>
    )
    : local.keyOk === false
      ? (
        <Row tone="bad" label="Subscribed with an old key" detail="Notifications sent now would be rejected. Fix replaces the subscription.">
          <Button variant="primary" loading={busy === 'fix'} onClick={() => void fix()}>Fix</Button>
        </Row>
      )
      : <Row tone="ok" label="Subscribed" detail={`Push service: ${local.host ?? 'unknown'}. Key matches.`} />;

  const missing = (
    <Row tone={local.subscribed ? 'bad' : 'info'} label="Dek has no record of this device" detail={local.subscribed ? 'Register it so Dek knows where to send.' : 'Turn notifications on first.'}>
      {local.subscribed ? <Button variant="primary" loading={busy === 'fix'} onClick={() => void fix()}>Register this device</Button> : null}
    </Row>
  );

  return (
    <section className="dk-health" aria-labelledby="dk-health-title">
      <Intro />
      <ul className="dk-health__list">
        {supportRow}
        {permRow}
        {installRow}
        {swRow}
        {subRow}
        <ServerRecordRow device={myDevice} error={health.error} onRetry={() => void refresh()} missing={missing} />
      </ul>
      {actionError ? <Banner tone="danger">{actionError}</Banner> : null}
      <TestNotification
        deviceId={myDevice?.id ?? null}
        observeShown={observeShown}
        onServer={health.set}
        explain="Accepted means the browser's push service took it. Displayed means this browser showed it."
      />
      <RecentDeliveries server={health.server} />
      <YourDevices server={health.server} currentId={stored?.id ?? null} />
      <Troubleshooting platform={p} only={['android', 'iphone', 'chrome', 'edge', 'firefox', 'safari', 'focus']} />
    </section>
  );
}

// ---------------------------------------------------------------- Android and iOS apps

function NativeHealth() {
  const userId = useDek((s) => s.session.userId);
  const [status, setStatus] = useState<NativePushStatus | null>(null);
  const health = useServerHealth();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const platform = detect();

  const refresh = useCallback(async () => {
    setStatus(await nativePushStatus());
    await health.refresh();
  }, [health.refresh]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void refresh();
    // Back from the system settings: read the permission again.
    const onResume = () => { void refresh(); };
    window.addEventListener('dek:resume', onResume);
    return () => window.removeEventListener('dek:resume', onResume);
  }, [refresh]);

  // With Dek open the system shows no banner: the app receiving it is the proof.
  const observeShown = useCallback((onShown: (at: number) => void) => onNativePushReceived((p) => {
    if (p.data?.kind === 'test') onShown(Date.now());
  }), []);

  if (!status) {
    return <section className="dk-health" aria-busy="true"><Spinner label="Checking notifications" /></section>;
  }

  const turnOn = async () => {
    if (!userId) return;
    setBusy(true);
    setActionError(null);
    const r = await enablePush(userId);
    setBusy(false);
    if (!r.ok) setActionError(r.message);
    void refresh();
  };

  const phone = status.platform === 'ios' ? 'iPhone' : 'phone';
  const provider = status.provider === 'apns' ? 'Apple Push Notification service' : status.provider === 'fcm' ? 'Firebase Cloud Messaging' : 'the push service';
  const stateRow = (() => {
    switch (status.state) {
      case 'registered':
        return <Row tone="ok" label={`This ${phone} receives Dek notifications`} detail={`${status.message} Through ${provider}.`} />;
      case 'registering':
        return <Row tone="info" label="Registering" detail={status.message} />;
      case 'denied':
        return (
          <Row tone="bad" label="Notifications are turned off for Dek" detail={status.message}>
            <Button variant="primary" onClick={() => void openNativeNotificationSettings()}>Open notification settings</Button>
          </Row>
        );
      case 'prompt':
        return (
          <Row tone="warn" label="Notifications are not on yet" detail={status.message}>
            <Button variant="primary" loading={busy} onClick={() => void turnOn()}>Turn on notifications</Button>
          </Row>
        );
      case 'not_configured':
        return <Row tone="bad" label="Push not configured on this build" detail="This build of the app cannot receive notifications yet. Messages inside Dek are not affected." />;
      case 'error':
        return (
          <Row tone="bad" label="This phone is not registered" detail={status.message}>
            <Button variant="primary" loading={busy} onClick={() => void turnOn()}>Try again</Button>
          </Row>
        );
      default:
        return <Row tone="bad" label="Notifications are not available" detail={status.message} />;
    }
  })();

  const myDevice = health.server?.devices.find((d) => d.id === status.deviceId) ?? null;
  const missing = (
    <Row tone={status.state === 'registered' ? 'bad' : 'info'} label="Dek has no record of this phone" detail={status.state === 'registered' ? 'Register it again so Dek knows where to send.' : 'Turn notifications on first.'}>
      {status.state === 'registered' ? <Button variant="primary" loading={busy} onClick={() => void turnOn()}>Register again</Button> : null}
    </Row>
  );

  return (
    <section className="dk-health" aria-labelledby="dk-health-title">
      <Intro />
      <ul className="dk-health__list">
        {stateRow}
        <ServerRecordRow device={myDevice} error={health.error} onRetry={() => void refresh()} missing={missing} />
      </ul>
      {actionError ? <Banner tone="danger">{actionError}</Banner> : null}
      <TestNotification
        deviceId={myDevice?.id ?? null}
        observeShown={observeShown}
        onServer={health.set}
        explain={`Accepted means ${provider} took it. Received means this ${phone} got it: with Dek open the system shows no banner, so close Dek right after pressing the button to see one.`}
        displayedText={{ title: `Delivered to this ${phone}`, body: `${provider} accepted it and this ${phone} received it.` }}
      />
      <RecentDeliveries server={health.server} />
      <YourDevices server={health.server} currentId={myDevice?.id ?? null} />
      <Troubleshooting platform={platform} only={[status.platform === 'ios' ? 'ios-app' : 'android-app', 'focus']} />
    </section>
  );
}
