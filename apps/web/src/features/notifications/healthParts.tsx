// The parts of notification health (DEK19) shared by the browser and the Android
// and iOS apps: the status row, Dek's record of this device, the test notification
// that tells "accepted" apart from "displayed", recent deliveries, devices, and help.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/rpc';
import { humanError } from '../../api/errors';
import type { Delivery, Device } from '../../api/types';
import type { PlatformInfo } from '../../lib/platform';
import { Banner, Button } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/icons';
import { TROUBLESHOOTING } from './steps';
import { isFinal, testVerdict, verdictText, WATCH_MS, type Verdict } from './verdict';

const POLL_MS = 3_000;

export type Tone = 'ok' | 'warn' | 'bad' | 'info';
const ICON: Record<Tone, IconName> = { ok: 'check', warn: 'alert', bad: 'alert', info: 'info' };

export function Row({ tone, label, detail, children }: { tone: Tone; label: string; detail: string; children?: ReactNode }) {
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

export function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString();
}

function statusClass(status: string): string {
  if (status === 'sent') return 'dk-health__status-ok';
  if (status === 'skipped') return 'dk-health__status-skip';
  return 'dk-health__status-bad';
}

export interface ServerHealth {
  devices: Device[];
  recent: Delivery[];
}

export function useServerHealth(): { server: ServerHealth | null; error: string | null; refresh: () => Promise<void>; set: (h: ServerHealth) => void } {
  const [server, setServer] = useState<ServerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setServer(await api.notificationHealth());
      setError(null);
    } catch (e) {
      setError(humanError(e));
    }
  }, []);
  return { server, error, refresh, set: setServer };
}

// Dek's record of this device (the server side of the chain).
export function ServerRecordRow({ device, error, onRetry, missing }: { device: Device | null; error: string | null; onRetry: () => void; missing: ReactNode }) {
  if (error) return <Row tone="warn" label="Could not reach Dek" detail={error}><Button variant="ghost" onClick={onRetry}>Try again</Button></Row>;
  if (!device) return <>{missing}</>;
  return (
    <Row
      tone={!device.enabled ? 'bad' : device.failure_count > 0 ? 'warn' : 'ok'}
      label={`Dek's record: ${device.label ?? 'this device'}`}
      detail={`${device.enabled ? 'Enabled' : 'Disabled'}. Last delivered ${when(device.last_success_at)}. Last attempt ${when(device.last_attempt_at)}${device.last_status ? ` (${device.last_status})` : ''}. Failures in a row: ${device.failure_count}.`}
    />
  );
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'watching' | 'done'; since: number; verdict: Verdict }
  | { phase: 'error'; message: string };

// observeShown: subscribe to "this device showed or received the test"; returns an
// unsubscribe. shownLabel: how that second half reads on this platform.
export function TestNotification({ deviceId, observeShown, onServer, explain, displayedText }: {
  deviceId: string | null;
  observeShown: (onShown: (at: number) => void) => () => void;
  onServer: (h: ServerHealth) => void;
  explain: string;
  displayedText?: { title: string; body: string };
}) {
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const shownAt = useRef<number | null>(null);

  useEffect(() => observeShown((at) => { shownAt.current = at; }), [observeShown]);

  // Watch notification_health for 30 s after a test.
  useEffect(() => {
    if (test.phase !== 'watching') return undefined;
    let stop = false;
    const since = test.since;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      let recent: Delivery[] = [];
      try {
        const h = await api.notificationHealth();
        recent = h.recent;
        onServer(h);
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
    timer = setTimeout(() => void tick(), 1_500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [test.phase === 'watching' ? test.since : 0, deviceId, onServer]);   // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
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

  const base = test.phase === 'watching' || test.phase === 'done' ? verdictText(test.verdict) : null;
  const verdict = base && (test.phase === 'watching' || test.phase === 'done') && test.verdict.kind === 'displayed' && displayedText
    ? { ...base, ...displayedText }
    : base;
  return (
    <div className="dk-health__test">
      <div>
        <h3 className="dk-health__h">Send a test notification</h3>
        <p className="dk-health__detail">{explain} Dek watches both for {WATCH_MS / 1000} seconds.</p>
      </div>
      <div>
        <Button variant="primary" loading={test.phase === 'sending' || test.phase === 'watching'} onClick={() => void send()} disabled={test.phase === 'watching'}>
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
  );
}

export function RecentDeliveries({ server }: { server: ServerHealth | null }) {
  const labels = new Map(server?.devices.map((d) => [d.id, d.label ?? d.kind]) ?? []);
  return (
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
  );
}

export function YourDevices({ server, currentId }: { server: ServerHealth | null; currentId: string | null }) {
  if (!server || server.devices.length === 0) return null;
  return (
    <div>
      <h3 className="dk-health__h">Your devices</h3>
      <ul className="dk-health__list">
        {server.devices.map((d) => (
          <Row
            key={d.id}
            tone={!d.enabled ? 'bad' : d.failure_count > 0 ? 'warn' : 'ok'}
            label={`${d.label ?? d.kind}${d.id === currentId ? ' (this device)' : ''}`}
            detail={`Last delivered ${when(d.last_success_at)}. ${d.enabled ? 'Enabled' : 'Disabled'}.`}
          />
        ))}
      </ul>
    </div>
  );
}

export function Troubleshooting({ platform, only }: { platform: PlatformInfo; only?: readonly string[] }) {
  const sections = only ? TROUBLESHOOTING.filter((t) => only.includes(t.id)) : TROUBLESHOOTING;
  return (
    <div>
      <h3 className="dk-health__h">If notifications still do not arrive</h3>
      {sections.map((t) => (
        <details key={t.id} open={(t.id === 'iphone' && platform.isIOS) || (t.id === 'android' && platform.isAndroid) || undefined}>
          <summary>{t.title}</summary>
          <ul>{t.points.map((x) => <li key={x}>{x}</li>)}</ul>
        </details>
      ))}
    </div>
  );
}
