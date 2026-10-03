// Channel notification levels and mute durations (set_channel_notify).
import type { Channel, NotifyLevel } from '../../api/types';
import { humanError } from '../../api/errors';
import { actions } from '../../store';
import { toast } from '../../ui/kit';
import { run } from './safe';

export const LEVELS: { level: NotifyLevel; label: string; hint: string }[] = [
  { level: 'all', label: 'All messages', hint: 'Every new message notifies you' },
  { level: 'mentions', label: 'Mentions only', hint: 'Only @mentions of you, @channel and @here' },
  { level: 'none', label: 'Nothing (muted)', hint: 'No notifications; unread still shows in the list' },
  { level: 'default', label: 'Your default', hint: 'Follow your notification settings' },
];

export const MUTES: { label: string; minutes: number }[] = [
  { label: 'Mute for 1 hour', minutes: 60 },
  { label: 'Mute for 8 hours', minutes: 8 * 60 },
  { label: 'Mute for 24 hours', minutes: 24 * 60 },
  { label: 'Mute for a week', minutes: 7 * 24 * 60 },
];

export function levelLabel(level: NotifyLevel): string {
  return LEVELS.find((l) => l.level === level)?.label ?? 'Your default';
}

// Resolves after the server answered and the store holds its reply; only then
// does the confirmation show.
export async function setNotify(channel: Channel, level: NotifyLevel, mutedUntil: string | null, success: string): Promise<void> {
  try {
    await run(() => actions.setChannelNotify(channel.id, level, mutedUntil));
    toast({ kind: 'success', title: success });
  } catch (e) {
    toast({ kind: 'error', title: 'Notification setting not changed', body: humanError(e) });
  }
}

export function muteUntil(minutes: number, now: number = Date.now()): string {
  return new Date(now + minutes * 60_000).toISOString();
}
