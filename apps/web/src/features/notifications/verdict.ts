// What a test notification did, from the server's delivery rows and what this
// browser saw (DEK19): "the push service accepted it" is not "it was displayed".
import type { Delivery } from '../../api/types';

export const WATCH_MS = 30_000;
const CLOCK_SLACK_MS = 10_000;

export type Verdict =
  | { kind: 'waiting' }
  | { kind: 'displayed'; acceptedAt: string | null; shownAt: number }
  | { kind: 'accepted'; acceptedAt: string; otherDevice: boolean }   // accepted, not (yet) seen here
  | { kind: 'refused'; reason: string | null }
  | { kind: 'expired' }
  | { kind: 'skipped'; reason: string | null }
  | { kind: 'not_configured' }
  | { kind: 'nothing' };

export interface VerdictInput {
  deliveries: readonly Delivery[];
  since: number;              // when the person pressed the button (client clock)
  deviceId: string | null;    // this browser's device record, if known
  shownAt: number | null;     // the service worker reported showing it here
  elapsedMs: number;
}

export function testVerdict(i: VerdictInput): Verdict {
  const fresh = i.deliveries.filter((d) => Date.parse(d.created_at) >= i.since - CLOCK_SLACK_MS);
  const mine = i.deviceId ? fresh.filter((d) => d.device_id === i.deviceId) : fresh;
  const pick = mine.length ? mine : fresh;
  const sent = pick.find((d) => d.status === 'sent');
  if (i.shownAt !== null) return { kind: 'displayed', acceptedAt: sent?.created_at ?? null, shownAt: i.shownAt };
  const failed = pick.find((d) => d.status === 'failed');
  if (failed && !sent) return { kind: 'refused', reason: failed.reason };
  const expired = pick.find((d) => d.status === 'expired');
  if (expired && !sent) return { kind: 'expired' };
  const skipped = pick.find((d) => d.status === 'skipped');
  if (skipped && !sent) return { kind: 'skipped', reason: skipped.reason };
  const nc = pick.find((d) => d.status === 'not_configured');
  if (nc && !sent) return { kind: 'not_configured' };
  if (sent) {
    // Give this browser a few seconds to show it before calling it "accepted only".
    if (i.elapsedMs >= WATCH_MS || (i.deviceId && sent.device_id !== i.deviceId)) {
      return { kind: 'accepted', acceptedAt: sent.created_at, otherDevice: !!i.deviceId && sent.device_id !== i.deviceId };
    }
    return { kind: 'waiting' };
  }
  return i.elapsedMs >= WATCH_MS ? { kind: 'nothing' } : { kind: 'waiting' };
}

export function isFinal(v: Verdict): boolean {
  return v.kind !== 'waiting';
}

export function verdictText(v: Verdict): { tone: 'success' | 'warning' | 'danger' | 'info'; title: string; body: string } {
  switch (v.kind) {
    case 'waiting':
      return { tone: 'info', title: 'Watching for the test notification', body: 'This takes a few seconds.' };
    case 'displayed':
      return { tone: 'success', title: 'Delivered and shown on this device', body: 'The push service accepted it and this browser displayed it.' };
    case 'accepted':
      return v.otherDevice
        ? { tone: 'info', title: 'Sent to your other device', body: 'The push service accepted it for another of your devices. Turn notifications on here to test this one.' }
        : {
            tone: 'warning',
            title: 'Accepted by the push service, not shown here yet',
            body: 'Dek handed it over, but this device has not displayed it. A focus mode, Do Not Disturb, battery saving or the operating system\'s notification settings may be holding it back. See the steps below.',
          };
    case 'refused':
      return { tone: 'danger', title: 'The push service refused it', body: v.reason ? `Reason: ${v.reason}. Turn notifications off and on again on this device.` : 'Turn notifications off and on again on this device.' };
    case 'expired':
      return { tone: 'danger', title: 'This device\'s subscription has expired', body: 'Use Fix below to subscribe again.' };
    case 'skipped':
      return { tone: 'warning', title: 'Held back on purpose', body: v.reason === 'quiet_hours' ? 'Your quiet hours are on right now.' : `Reason: ${v.reason ?? 'a notification setting'}.` };
    case 'not_configured':
      return { tone: 'warning', title: 'Dek cannot send to this kind of device yet', body: 'Native app notifications are not set up on the server yet.' };
    case 'nothing':
      return { tone: 'danger', title: 'Nothing was sent within 30 seconds', body: 'The sending service may be busy or down. Try again in a few minutes; messages inside Dek are not affected.' };
  }
}
