// docs/CONTRACT.md section 3 as types, and the hub interface every feature uses.
// The hub owns the single socket per browser (leader tab, relayed to other tabs).
// Every server payload also carries v: 1 and eid (the event id the hub
// de-duplicates by; since migration 0900 `id` is the scope id again).
import type { Call, ChannelBase, Message, NotifyLevel, OrgSettings, Server } from '../api/types';

// server.upd: the server without per-user fields (my_role, member_count, access).
export type ServerPatch = Pick<Server, 'id' | 'org_id'>
  & Partial<Pick<Server, 'name' | 'description' | 'icon_emoji' | 'position' | 'join_policy' | 'archived' | 'permission_version'>>;

// org.upd: to every active member of the organization.
export interface OrgPatch {
  id: string;
  name: string;
  short_name: string | null;
  brand_color: string;
  logo_path: string | null;
  settings: OrgSettings;
  archived: boolean;
}

export type ServerEvent =
  | {event:'activity.upd';payload:{org_id:string;kind:'mention'|'thread';target_id:string;revision:number}}
  | { event: 'msg.new'; payload: { message: Message } }
  | { event: 'msg.upd'; payload: { message: Message } }
  | { event: 'read'; payload: { channel_id?: string; last_read_seq?: number; root_id?: string; last_read_reply_seq?: number } }
  | { event: 'chan.upd'; payload: { channel: ChannelBase } }
  | { event: 'member.upd'; payload: { scope: 'org' | 'server' | 'channel'; id: string; user_id: string; change: 'added' | 'removed' | 'role' | 'moderation' } }
  | { event: 'access.revoked'; payload: { scope: 'org' | 'server' | 'channel'; id: string } }
  | { event: 'call.ring'; payload: { call: Call; from: string } }
  | { event: 'call.upd'; payload: { call: Call } }
  | { event: 'server.upd'; payload: { server: ServerPatch } }
  | { event: 'org.upd'; payload: { org: OrgPatch } }
  // My own notify, mute and hidden settings for a channel, changed on another device.
  | { event: 'chan.self'; payload: { channel_id: string; notify: NotifyLevel; muted_until: string | null; hidden: boolean } }
  // A save or unsave of mine, on any device (migration 0907).
  | { event: 'saved.upd'; payload: { org_id: string; message_id: string; saved: boolean } }
  // A request to join a locked channel: new (to its approvers), or decided or withdrawn
  // (to the approvers and the person who asked) (migration 0916).
  | { event: 'join.req'; payload: { org_id: string; channel_id: string; request_id: string; user_id: string; change: 'new' | 'withdrawn' | 'approved' | 'rejected' } };

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

// Why onReconnected fired: the first join of this page's topics ('initial'), a
// topic rejoined after an error or close ('rejoin'), this tab took over the socket
// from a leader tab that closed ('takeover'), or a forced reconnect after the
// device slept or came back online ('resume').
export type ReconnectReason = 'initial' | 'rejoin' | 'takeover' | 'resume';

export interface HubDebug {
  tabId: string;
  leader: boolean;
  status: ConnStatus;
  socketConnected: boolean;   // this tab owns an open realtime socket
  wanted: string[];           // topics this tab asked for
  joined: string[];           // leader only: topics joined on the socket
  tabs: number;               // leader only: tabs whose topics it serves (itself included)
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
  onReconnected(handler: (reason: ReconnectReason) => void): () => void;
  // The signed-in user (typing payloads; tabs of another user are ignored).
  setIdentity(userId: string | null): void;
  // True in the one tab that owns the socket for this browser.
  isLeader(): boolean;
  // The access token was refreshed: rejoin every topic that is not joined now.
  retryNow(): void;
  onLeaderChange(handler: (leader: boolean) => void): () => void;
  debug(): HubDebug;
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
