// The actions every screen calls. The INTERFACE is fixed by the lead so the UI
// builders and the core builder can work at the same time; the core builder owns
// the implementation (in src/sync/*, wired in by registerActions()).
export interface SendInput {
  channelId: string;
  body: string;
  threadRootId?: string | null;
  attachmentIds?: string[];
  alsoInChannel?: boolean;
}

export interface DekActions {
  // Auth (DEK login flows; see docs/legacy-reuse/LESSONS.md "Auth")
  signInWithPassword(email: string, password: string): Promise<void>;
  sendEmailCode(email: string): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<void>;
  setPassword(password: string): Promise<void>;
  signOut(): Promise<void>;

  // Organization context (DEK01: switching is deliberate, nothing leaks across)
  selectOrg(orgId: string): Promise<void>;
  refreshBootstrap(): Promise<void>;

  // Channels and history (DEK07, DEK08)
  openChannel(channelId: string, opts?: { aroundMessageId?: string | null }): Promise<void>;
  closeChannel(channelId: string): void;
  loadOlder(channelId: string): Promise<void>;
  loadNewer(channelId: string): Promise<void>;
  markRead(channelId: string, seq?: number): void;
  markUnread(channelId: string, seq: number): Promise<void>;

  // Messages (DEK06, DEK09). sendMessage returns the client id immediately; the
  // pending entry shows until the server accepts it.
  sendMessage(input: SendInput): string;
  retrySend(clientId: string): void;
  discardPending(clientId: string): void;
  editMessage(messageId: string, body: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  toggleReaction(messageId: string, emoji: string): Promise<void>;
  pinMessage(messageId: string, pinned: boolean): Promise<void>;
  saveMessage(messageId: string, saved: boolean): Promise<void>;

  // Threads
  openThread(rootId: string): Promise<void>;
  loadThreadMore(rootId: string): Promise<void>;
  followThread(rootId: string, follow: boolean): Promise<void>;
  markThreadRead(rootId: string): void;

  // Typing (DEK12: transient, throttled)
  notifyTyping(channelId: string, threadRootId?: string | null): void;

  // Profiles: fetch any not yet known (batched, deduplicated)
  ensureProfiles(ids: string[]): void;

  // Composer drafts (DEK09) and scroll memory (DEK04)
  setDraft(key: string, text: string): void;
  rememberScroll(channelId: string, anchorId: string | null, offset: number, atBottom: boolean): void;
}

function notReady(name: string): never {
  throw new Error(`actions.${name} is not implemented yet`);
}

const placeholder: DekActions = {
  signInWithPassword: () => notReady('signInWithPassword'),
  sendEmailCode: () => notReady('sendEmailCode'),
  verifyEmailCode: () => notReady('verifyEmailCode'),
  setPassword: () => notReady('setPassword'),
  signOut: () => notReady('signOut'),
  selectOrg: () => notReady('selectOrg'),
  refreshBootstrap: () => notReady('refreshBootstrap'),
  openChannel: () => notReady('openChannel'),
  closeChannel: () => notReady('closeChannel'),
  loadOlder: () => notReady('loadOlder'),
  loadNewer: () => notReady('loadNewer'),
  markRead: () => notReady('markRead'),
  markUnread: () => notReady('markUnread'),
  sendMessage: () => notReady('sendMessage'),
  retrySend: () => notReady('retrySend'),
  discardPending: () => notReady('discardPending'),
  editMessage: () => notReady('editMessage'),
  deleteMessage: () => notReady('deleteMessage'),
  toggleReaction: () => notReady('toggleReaction'),
  pinMessage: () => notReady('pinMessage'),
  saveMessage: () => notReady('saveMessage'),
  openThread: () => notReady('openThread'),
  loadThreadMore: () => notReady('loadThreadMore'),
  followThread: () => notReady('followThread'),
  markThreadRead: () => notReady('markThreadRead'),
  notifyTyping: () => notReady('notifyTyping'),
  ensureProfiles: () => notReady('ensureProfiles'),
  setDraft: () => notReady('setDraft'),
  rememberScroll: () => notReady('rememberScroll'),
};

export const actions: DekActions = { ...placeholder };

// The core builder calls this once at startup with the real implementation.
export function registerActions(impl: Partial<DekActions>): void {
  Object.assign(actions, impl);
}
