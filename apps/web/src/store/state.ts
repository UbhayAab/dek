// The client's single source of truth. Plain data keyed by contract ids; every
// update replaces objects (never mutates), so React and zustand see changes.
// Owner after scaffold: the core builder (src/store, src/sync, src/realtime).
import { create } from 'zustand';
import type {
  BootstrapResult, Call, Channel, MeResult, Message, OrgSummary, Profile, Server,
} from '../api/types';
import type { ConnStatus } from '../realtime/types';

export type SessionStatus = 'unknown' | 'signed_out' | 'signed_in';
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type PendingStatus = 'pending' | 'retrying' | 'failed';

// A message the server has not accepted yet (DEK06). Lives in IndexedDB too, so a
// reload or a killed tab cannot lose it; replayed with the SAME client id.
export interface PendingMessage {
  clientId: string;
  orgId: string;
  channelId: string;
  threadRootId: string | null;
  body: string;
  attachmentIds: string[];
  alsoInChannel: boolean;
  status: PendingStatus;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number | null;
  error: { code: string; hint: string } | null;
  // Delivery state shows only after 900 ms (a fast send never flashes "Sending");
  // a terminal failure shows at once because the person has to act on it.
  statusVisible: boolean;
}

export interface Timeline {
  ids: string[];                // message ids in the timeline, ascending by seq
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;        // true while showing a window around an old message
  status: LoadStatus;
  error: string | null;
  lastSeq: number;              // highest seq known to be included (cursor for sync)
  syncedAt: string | null;      // server time of the last successful load or sync
  fromCache: boolean;           // painted from IndexedDB; the network page has not landed yet
  olderStatus: LoadStatus;      // loadOlder in progress or failed (spinner / retry at the top)
  newerStatus: LoadStatus;      // loadNewer in progress or failed (while hasMoreAfter)
}

export interface ThreadView {
  rootId: string;
  channelId: string;
  replyIds: string[];
  status: LoadStatus;
  error: string | null;
  hasMore: boolean;
  following: boolean;
  lastReadReplySeq: number;
}

export interface TypingEntry {
  userId: string;
  threadRootId: string | null;
  until: number;
}

export interface ScrollMemory {
  anchorId: string | null;
  offset: number;
  atBottom: boolean;
}

// A step the auth screen still shows after the session exists: the offer to set a
// password after a code sign-in, or the new password after "forgot password".
// While it is set, session.status stays 'signed_out' so the auth screen stays up.
export type SessionSetup = 'password' | 'reset' | null;

export interface DekState {
  session: { status: SessionStatus; userId: string | null; email: string | null; setup: SessionSetup };
  me: MeResult | null;
  orgs: OrgSummary[];
  orgId: string | null;
  org: BootstrapResult['org'] | null;
  bootstrap: { status: LoadStatus; error: string | null; at: number | null };
  topics: string[];
  servers: Record<string, Server>;
  channels: Record<string, Channel>;
  profiles: Record<string, Profile>;
  messages: Record<string, Message>;
  timelines: Record<string, Timeline>;
  threads: Record<string, ThreadView>;
  pending: Record<string, PendingMessage>;
  typing: Record<string, TypingEntry[]>;
  calls: Record<string, Call>;
  connection: { realtime: ConnStatus; online: boolean; leader: boolean };
  drafts: Record<string, string>;
  scroll: Record<string, ScrollMemory>;
  // Service worker: a newer version is installed and waiting (the "New version
  // ready" banner), and the version this page runs.
  app: { updateReady: boolean; version: string | null };
}

export function initialState(): DekState {
  return {
    session: { status: 'unknown', userId: null, email: null, setup: null },
    me: null,
    orgs: [],
    orgId: null,
    org: null,
    bootstrap: { status: 'idle', error: null, at: null },
    topics: [],
    servers: {},
    channels: {},
    profiles: {},
    messages: {},
    timelines: {},
    threads: {},
    pending: {},
    typing: {},
    calls: {},
    connection: { realtime: 'idle', online: typeof navigator === 'undefined' ? true : navigator.onLine, leader: false },
    drafts: {},
    scroll: {},
    app: { updateReady: false, version: null },
  };
}

export const useDek = create<DekState>()(() => initialState());

export const getState = useDek.getState;
export const setState = useDek.setState;

// Wipes everything a person's session put in memory (sign-out, org removal).
export function resetState(): void {
  useDek.setState(initialState(), true);
}

export function draftKey(channelId: string, threadRootId: string | null = null): string {
  return threadRootId ? `${channelId}:${threadRootId}` : channelId;
}
