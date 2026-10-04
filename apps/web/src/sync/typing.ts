// Typing (DEK12): transient, never stored. Outgoing at most once per 3 s per
// conversation through the hub (broadcast on t:<channel>); incoming entries expire
// after 6 s and clear when that person's message arrives (reducers.applyNewMessage).
import { limits } from '../config';
import { hub } from '../realtime/hub';
import type { TypingSignal } from '../realtime/types';
import { getState, setState } from '../store/state';
import { applyTyping, expireTyping } from './reducers';

const lastSent = new Map<string, number>();
let sweep: ReturnType<typeof setInterval> | null = null;

// In a big channel "X is typing" is noise and every keystroke burst fans out to every
// member: above this many members the indicator is not sent (still shown when received).
export const TYPING_MAX_MEMBERS = 50;

export function notifyTyping(channelId: string, threadRootId: string | null = null): void {
  const members = getState().channels[channelId]?.member_count ?? 0;
  if (members > TYPING_MAX_MEMBERS) return;
  const key = `${channelId}:${threadRootId ?? ''}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < limits.typingThrottleMs) return;
  lastSent.set(key, now);
  hub.sendTyping(channelId, threadRootId);
}

export function onTypingSignal(channelId: string, signal: TypingSignal): void {
  const s = getState();
  const patch = applyTyping(s, channelId, signal.user_id, signal.thread_root_id, s.session.userId, Date.now() + limits.typingExpiryMs);
  if (!patch) return;
  setState(patch);
  ensureSweep();
}

function ensureSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => {
    const patch = expireTyping(getState(), Date.now());
    if (patch) setState(patch);
    if (Object.keys(getState().typing).length === 0 && sweep) {
      clearInterval(sweep);
      sweep = null;
    }
  }, 1_000);
}

export function resetTyping(): void {
  lastSent.clear();
  if (sweep) clearInterval(sweep);
  sweep = null;
}
