// Notification health (DEK19): every link in the chain from this browser to the
// server's device record and the last 20 delivery attempts, a user-initiated test
// that tells "accepted" apart from "displayed", and plain help per platform.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/rpc';
import { humanError } from '../../api/errors';
import type { Delivery, Device } from '../../api/types';
import { config } from '../../config';
import { detect, deviceLabel, type PlatformInfo } from '../../lib/platform';
import { useInstallPrompt } from '../../push/install';
import {
  currentSubscription, endpointHost, enablePush, keysMatch, permission, pushSupport, storedDevice, subscribeAndRegister,
  urlBase64ToUint8Array, type Permission, type PushSupport,
} from '../../push/push';
import { getRegistration, onSwMessage, workerVersion } from '../../sw/register';
import { useDek } from '../../store';
import { Banner, Button, Spinner } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/icons';
import { BlockedHelp, IosInstallSteps, TROUBLESHOOTING } from './steps';
import { isFinal, testVerdict, verdictText, WATCH_MS, type Verdict } from './verdict';

const POLL_MS = 3_000;

interface LocalFacts {
  platform: PlatformInfo;
  support: PushSupport;
  permission: Permission;
  sw: 'unsupported' | 'none' | 'installing' | 'waiting' | 'active';
  swVersion: string | null;
  subscribed: boolean;
  host: string | null;
  keyOk: boolean | null;
  endpoint: string | null;
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
    endpoint: sub?.endpoint ?? null,
  };
}

type Tone = 'ok' | 'warn' | 'bad' | 'info';
const ICON: Record<Tone, IconName> = { ok: 'check', warn: 'alert', bad: 'alert', info: 'info' };

function Row({ tone, label, detail, children }: { tone: Tone; label: string; detail: string; children?: React.ReactNode }) {
  return (
    <li className="dk-health__row">
      <span className={`dk-health__icon is-${tone}`} aria-hidden="true"><Icon name={ICON[tone]} size={20} /></span>
      <div>
        <div className="dk-health__label">
          <span className="sr-only">{tone === 'ok' ? 'OK: ' : tone === 'info' ? 'Note: ' : 'Needs attention: '}</span>
          {label}
        </div>
        <div className="dk-health__detail">{detail}</div>
        {children ? <div className="dk-health__action">{children}</div> : null}
      </div>
    </li>
  );
}

function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString();
}

function statusClass(status: string): string {
  if (status === 'sent') return 'dk-health__status-ok';
  if (status === 'skipped') return 'dk-health__status-skip';
  return 'dk-health__status-bad';
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'watching' | 'done'; since: number; verdict: Verdict }
  | { phase: 'error'; message: string };

export function NotificationHealth() {
  const userId = useDek((s) => s.session.userId);
  const install = useInstallPrompt();
  const [local, setLocal] = useState<LocalFacts | null>(null);
  const [server, setServer] = useState<{ devices: Device[]; recent: Delivery[] } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const shownAt = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    setLocal(await gatherLocal());
    try {
      setServer(await api.notificationHealth());
      setServerError(null);
    } catch (e) {
      setServerError(humanError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onSwMessage('push-shown', (d) => {
    if (d.kind === 'test') shownAt.current = typeof d.at === 'number' ? d.at : Date.now();
  }), []);

  const stored = userId ? storedDevice(userId) : null;
  const myDevice = server?.devices.find((d) => d.id === stored?.id) ?? null;
  const deviceId = myDevice?.id ?? null;

  // Watch notification_health for 30 s after a test.
  useEffect(() => {
    if (test.phase !== 'watching') return;
    let stop = false;
    const since = test.since;
    const tick = async () => {
      if (stop) return;
      let recent: Delivery[] = [];
      try {
        const h = await api.notificationHealth();
        recent = h.recent;
        setServer(h);
      } catch {
        /* keep watching; a single failed poll is not an answer */
      }
      if (stop) return;
      const verdict = testVerdict({ deliveries: recent, since, deviceId, shownAt: shownAt.current, elapsedMs: Date.now() - since });
      if (isFinal(verdict)) setTest({ phase: 'done', since, verdict });
      else {
        setTest({ phase: 'watching', since, verdict });
        timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    let timer = setTimeout(() => void tick(), 1_500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test.phase === 'watching' ? test.since : 0]);

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

  const sendTest = async () => {
    setTest({ phase: 'sending' });
    shownAt.current = null;
    const since = Date.now();
    try {
      await api.sendTestNotification(deviceId);
      setTest({ phase: 'watching', since, verdict: { kind: 'waiting' } });
    } catch (e) {
      setTest({ phase: 'error', message: humanError(e) });
    }
  };

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

  const serverRow = serverError
    ? <Row tone="warn" label="Could not reach Dek" detail={serverError}><Button variant="ghost" onClick={() => void refresh()}>Try again</Button></Row>
    : !myDevice
      ? (
        <Row tone={local.subscribed ? 'bad' : 'info'} label="Dek has no record of this device" detail={local.subscribed ? 'Register it so Dek knows where to send.' : 'Turn notifications on first.'}>
          {local.subscribed ? <Button variant="primary" loading={busy === 'fix'} onClick={() => void fix()}>Register this device</Button> : null}
        </Row>
      )
      : (
        <Row
          tone={!myDevice.enabled ? 'bad' : myDevice.failure_count > 0 ? 'warn' : 'ok'}
          label={`Dek's record: ${myDevice.label ?? 'this device'}`}
          detail={`${myDevice.enabled ? 'Enabled' : 'Disabled'}. Last delivered ${when(myDevice.last_success_at)}. Last attempt ${when(myDevice.last_attempt_at)}${myDevice.last_status ? ` (${myDevice.last_status})` : ''}. Failures in a row: ${myDevice.failure_count}.`}
        />
      );

  const labels = new Map(server?.devices.map((d) => [d.id, d.label ?? d.kind]) ?? []);
  const verdict = test.phase === 'watching' || test.phase === 'done' ? verdictText(test.verdict) : null;

  return (
    <section className="dk-health" aria-labelledby="dk-health-title">
      <div>
        <h2 id="dk-health-title" className="dk-health__h">Notification health</h2>
        <p className="dk-health__intro">
          Unread counts inside Dek work without any of this. Notifications outside Dek reach this device only when every line below is green.
        </p>
      </div>

      <ul className="dk-health__list">
        {supportRow}
        {permRow}
        {installRow}
        {swRow}
        {subRow}
        {serverRow}
      </ul>
      {actionError ? <Banner tone="danger">{actionError}</Banner> : null}

      <div className="dk-health__test">
        <div>
          <h3 className="dk-health__h">Send a test notification</h3>
          <p className="dk-health__detail">
            Accepted means the browser's push service took it. Displayed means this browser showed it. Dek watches both for {WATCH_MS / 1000} seconds.
          </p>
        </div>
        <div>
          <Button
            variant="primary"
            loading={test.phase === 'sending' || test.phase === 'watching'}
            onClick={() => void sendTest()}
            disabled={test.phase === 'watching'}
          >
            Send test notification
          </Button>
        </div>
        {test.phase === 'error' ? <Banner tone="danger">{test.message}</Banner> : null}
        {verdict ? (
          <Banner tone={verdict.tone}>
            <strong>{verdict.title}</strong>
            <div>{verdict.body}</div>
          </Banner>
        ) : null}
      </div>

      <div>
        <h3 className="dk-health__h">Recent deliveries</h3>
        {server && server.recent.length > 0 ? (
          <div className="dk-health__table-wrap">
            <table className="dk-health__table">
              <thead>
                <tr><th scope="col">When</th><th scope="col">Device</th><th scope="col">Result</th><th scope="col">Detail</th></tr>
              </thead>
              <tbody>
                {server.recent.map((d, i) => (
                  <tr key={`${d.created_at}-${i}`}>
                    <td>{when(d.created_at)}</td>
                    <td>{(d.device_id && labels.get(d.device_id)) ?? d.kind ?? 'device'}</td>
                    <td className={statusClass(d.status)}>{d.status === 'sent' ? 'accepted' : d.status.replace('_', ' ')}</td>
                    <td>{d.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dk-health__detail">{server ? 'No delivery attempts yet.' : 'Loading.'}</p>
        )}
      </div>

      {server && server.devices.length > 0 ? (
        <div>
          <h3 className="dk-health__h">Your devices</h3>
          <ul className="dk-health__list">
            {server.devices.map((d) => (
              <Row
                key={d.id}
                tone={!d.enabled ? 'bad' : d.failure_count > 0 ? 'warn' : 'ok'}
                label={`${d.label ?? d.kind}${d.id === stored?.id ? ' (this device)' : ''}`}
                detail={`Last delivered ${when(d.last_success_at)}. ${d.enabled ? 'Enabled' : 'Disabled'}.`}
              />
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <h3 className="dk-health__h">If notifications still do not arrive</h3>
        {TROUBLESHOOTING.map((t) => (
          <details key={t.id} open={(t.id === 'iphone' && p.isIOS) || (t.id === 'android' && p.isAndroid) || undefined}>
            <summary>{t.title}</summary>
            <ul>{t.points.map((x) => <li key={x}>{x}</li>)}</ul>
          </details>
        ))}
      </div>
    </section>
  );
}
