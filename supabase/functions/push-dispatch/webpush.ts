// Web Push adapter (browsers and installed PWAs, device kind 'webpush'), on the same
// library and VAPID key pair the legacy app used, so the 135 subscriptions people
// already granted keep working. Deno only (npm: import); the error mapping it relies
// on is webpushOutcome in lib.ts, which the Node tests cover.
import webpush from 'npm:web-push@3.6.7';
import { webpushOutcome, type Sender } from './lib.ts';

export function makeWebPushSender(subject: string, publicKey: string, privateKey: string, timeoutMs: number): Sender {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return async (d, payload, opt) => {
    try {
      const res = await webpush.sendNotification(
        { endpoint: d.device.endpoint, keys: { p256dh: d.device.p256dh ?? '', auth: d.device.auth ?? '' } },
        JSON.stringify(payload),
        { TTL: opt.ttl, urgency: opt.urgency, topic: opt.topic, timeout: timeoutMs },
      );
      return { status: 'sent', reason: null, http_status: res.statusCode };
    } catch (e) {
      return webpushOutcome(e);
    }
  };
}
