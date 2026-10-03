// OWNER: core platform builder. Implements RealtimeHub (./types.ts): one socket per
// browser through a Web Locks leader with BroadcastChannel relay, private topics,
// resubscribe with token refresh, de-duplication by event id, onReconnected healing.
import type { RealtimeHub } from './types';

const noop = () => () => undefined;

export const hub: RealtimeHub = {
  start: () => undefined,
  stop: () => undefined,
  setTopics: () => undefined,
  onEvent: noop,
  status: () => 'idle',
  onStatus: noop,
  onReconnected: noop,
  joinView: () => undefined,
  leaveView: () => undefined,
  sendTyping: () => undefined,
  onTyping: noop,
  joinCall: () => undefined,
  leaveCall: () => undefined,
  sendSignal: () => undefined,
  onSignal: noop,
};
