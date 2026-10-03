// The small push banner the shell renders: the ask only ever comes from a click;
// after a denial, never the browser prompt again, only where to allow it (DEKA09);
// on an iPhone Safari tab, the Add to Home Screen steps instead of "unsupported"
// (DEK16, DEKA08). Dismissing hides it for 30 days on this device for this person.
// ("New version ready" is the shell's ConnectionBanner, from store.app.updateReady.)
import { useEffect, useState, useSyncExternalStore } from 'react';
import { detect } from '../../lib/platform';
import { readJson, userKey, writeJson } from '../../lib/storage';
import { enablePush, permission, pushSupport, type EnableResult, type Permission } from '../../push/push';
import { useDek } from '../../store';
import { Banner, Button } from '../../ui/kit';
import { BlockedHelp, IosInstallSteps } from './steps';

const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

function snoozed(userId: string): boolean {
  const at = readJson<number>(userKey('push.prompt', userId), 0);
  return typeof at === 'number' && Date.now() - at < SNOOZE_MS;
}

// The shell may render this banner in more than one place (sidebar and home):
// one "Not now" hides every copy, and a permission change shows in every copy.
let version = 0;
const listeners = new Set<() => void>();
function bump(): void {
  version += 1;
  for (const l of listeners) l();
}
function useShared(): number {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => version, () => 0);
}

export function NotificationPrompt() {
  const status = useDek((s) => s.session.status);
  const userId = useDek((s) => s.session.userId);
  if (status !== 'signed_in' || !userId) return null;
  return <PushBanner userId={userId} />;
}

function PushBanner({ userId }: { userId: string }) {
  useShared();
  const perm: Permission = permission();
  const hidden = snoozed(userId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnableResult | null>(null);
  const [help, setHelp] = useState(false);
  const support = pushSupport();
  const platform = detect();

  // The person may allow or block it in browser settings while Dek is open.
  useEffect(() => {
    window.addEventListener('focus', bump);
    return () => window.removeEventListener('focus', bump);
  }, []);

  useEffect(() => {
    if (result?.ok) {
      const t = setTimeout(() => setResult(null), 5_000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [result]);

  const dismiss = () => {
    writeJson(userKey('push.prompt', userId), Date.now());
    bump();
  };

  const turnOn = async () => {
    setBusy(true);
    const r = await enablePush(userId);
    setBusy(false);
    bump();
    setResult(r);
    if (!r.ok && (r.reason === 'denied' || r.reason === 'ios-needs-install')) setHelp(true);
  };

  if (result?.ok) {
    return (
      <div className="dk-notif-prompt">
        <Banner tone="success" onClose={() => setResult(null)}>Notifications are on for this device.</Banner>
      </div>
    );
  }
  if (hidden) return null;

  if (support === 'ios-needs-install') {
    return (
      <div className="dk-notif-prompt">
        <Banner tone="info" icon="bell" onClose={dismiss}>
          <div>
            <strong>Get notifications on this {platform.os === 'ipados' ? 'iPad' : 'iPhone'}</strong>
            <div>Add Dek to your Home Screen, then turn notifications on there.</div>
            {help ? <IosInstallSteps platform={platform} /> : (
              <div className="dk-notif-prompt__actions">
                <Button variant="primary" onClick={() => setHelp(true)}>Show me how</Button>
              </div>
            )}
          </div>
        </Banner>
      </div>
    );
  }

  if (support !== 'supported') return null;   // the health screen explains the rest

  if (perm === 'denied') {
    return (
      <div className="dk-notif-prompt">
        <Banner tone="warning" icon="bellOff" onClose={dismiss}>
          <div>
            <strong>Notifications are blocked for Dek in this browser.</strong>
            <div>Unread counts still work inside Dek. To get notifications, allow them in the browser:</div>
            {help ? <BlockedHelp platform={platform} /> : (
              <div className="dk-notif-prompt__actions">
                <Button variant="secondary" onClick={() => setHelp(true)}>How to allow</Button>
              </div>
            )}
          </div>
        </Banner>
      </div>
    );
  }

  if (perm === 'default') {
    const failed = result && !result.ok ? result.message : null;
    return (
      <div className="dk-notif-prompt">
        <Banner tone="info" icon="bell">
          <div>
            <strong>Turn on notifications</strong>
            <div>Hear about mentions and direct messages when Dek is not open.</div>
            {failed ? <div role="alert">{failed}</div> : null}
            <div className="dk-notif-prompt__actions">
              <Button variant="primary" loading={busy} onClick={() => void turnOn()}>Turn on notifications</Button>
              <Button variant="ghost" onClick={dismiss} disabled={busy}>Not now</Button>
            </div>
          </div>
        </Banner>
      </div>
    );
  }
  return null;   // granted: subscribed silently at sign-in
}
