// docs/CONTRACT.md section 3 as types, and the hub interface every feature uses.
// The hub owns the single socket per browser (leader tab, relayed to other tabs).
import type { Call, ChannelBase, Message } from '../api/types';

export type ServerEvent =
  | { event: 'msg.new'; payload: { message: Message } }
  | { event: 'msg.upd'; payload: { message: Message } }
  | { event: 'read'; payload: { channel_id?: string; last_read_seq?: number; root_id?: string; last_read_reply_seq?: number } }
  | { event: 'chan.upd'; payload: { channel: ChannelBase } }
  | { event: 'member.upd'; payload: { scope: 'org' | 'server' | 'channel'; id: string; user_id: string; change: 'added' | 'removed' | 'role' } }
  | { event: 'access.revoked'; payload: { scope: 'org' | 'server' | 'channel'; id: string } }
  | { event: 'call.ring'; payload: { call: Call; from: string } }
  | { event: 'call.upd'; payload: { call: Call } };

export type ServerEventName = ServerEvent['event'];

export type ConnStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface TypingSignal {
  user_id: string;
  thread_root_id: string | null;
}

// WebRTC signaling between the sessions of one call (topic call:<id>).
export interface CallSignal {
  from_user: string;
  from_session: string;
  to_session: string | null;   // null = everyone in the call
  kind: 'hello' | 'offer' | 'answer' | 'ice' | 'bye';
  data: unknown;
}

export interface RealtimeHub {
  // Begin (or stop) owning the connection for this browser. Safe to call twice.
  start(): void;
  stop(): void;
  // The u: and s: topics bootstrap returned. Replaces the previous set.
  setTopics(topics: string[]): void;
  // Every server event from every joined topic, after de-duplication by event id.
  onEvent(handler: (e: ServerEvent, topic: string) => void): () => void;
  status(): ConnStatus;
  onStatus(handler: (s: ConnStatus) => void): () => void;
  // Fired after every (re)connect once topics are joined: the trigger to heal by cursor.
  onReconnected(handler: () => void): () => void;
  // Channel view topic t:<channel>: typing while the channel is on screen.
  joinView(channelId: string): void;
  leaveView(channelId: string): void;
  sendTyping(channelId: string, threadRootId: string | null): void;
  onTyping(handler: (channelId: string, signal: TypingSignal) => void): () => void;
  // Call topic call:<id>.
  joinCall(callId: string): void;
  leaveCall(callId: string): void;
  sendSignal(callId: string, signal: CallSignal): void;
  onSignal(callId: string, handler: (signal: CallSignal) => void): () => void;
}
