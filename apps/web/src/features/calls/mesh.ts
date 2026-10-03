// The peer links of one call: one per other joined session (a direct call has
// one, an audio room up to seven). It routes CallSignal messages from the call
// topic to the right link and decides who may have a link at all.
//
// The server's roster is the authority. A link is only built for a session the
// server lists as joined, so somebody who can read an audio channel but has not
// joined its room cannot quietly connect and listen. Signals from a session the
// roster does not know yet (the roster event is a moment behind the far side's
// offer) are held, bounded, and the owner is asked to refresh the roster; they are
// released in arrival order the moment the link exists (LESSONS: a dropped offer
// is one person hearing nothing, forever).
//
// Protocol on call:<id> (CONTRACT 3, realtime/types.ts CallSignal):
//   hello  to everyone on join, and to one session when a link to it is built,
//          so the far side builds its end even if its roster is behind
//   offer, answer  an RTCSessionDescriptionInit
//   ice    an array of RTCIceCandidateInit (batched every 150 ms by the link)
//   bye    the sender is leaving; the link closes without waiting for the server
import type { CallSignal } from '../../realtime/types';
import { realTimers, type LinkSignalKind, type PeerLink, type Timers } from './link';

export interface Member {
  userId: string;
  sessionId: string;
}

export interface MeshOptions {
  localUser: string;
  localSession: string;
  maxPeers?: number;
  send: (signal: CallSignal) => void;
  createLink: (member: Member, polite: boolean, send: (kind: LinkSignalKind, data: unknown) => void) => PeerLink;
  onUnknownSession?: (sessionId: string) => void;
  onChange?: () => void;
  holdPerSession?: number;
  holdSessions?: number;
  // A session missing from one roster update is dropped only if it is still
  // missing this long after: roster answers and events can arrive out of order,
  // and tearing down a healthy link for a stale snapshot costs a reconnect.
  dropGraceMs?: number;
  timers?: Timers;
}

export const DROP_GRACE_MS = 1500;

export const MAX_PEERS = 7;

// The polite peer gives way on glare. Comparing session ids is consistent and
// opposite on the two ends, which is all the rule needs.
export function isPolite(localSession: string, remoteSession: string): boolean {
  return localSession > remoteSession;
}

export class CallMesh {
  private readonly links = new Map<string, { link: PeerLink; userId: string }>();
  private readonly held = new Map<string, CallSignal[]>();
  private roster = new Map<string, string>();
  private readonly dropping = new Map<string, unknown>();
  private closed = false;
  private readonly opts: MeshOptions;
  private readonly timers: Timers;

  constructor(opts: MeshOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
  }

  get localSession(): string {
    return this.opts.localSession;
  }

  sessions(): { sessionId: string; userId: string; link: PeerLink }[] {
    return [...this.links.entries()].map(([sessionId, e]) => ({ sessionId, userId: e.userId, link: e.link }));
  }

  link(sessionId: string): PeerLink | null {
    return this.links.get(sessionId)?.link ?? null;
  }

  knows(sessionId: string): boolean {
    return this.roster.has(sessionId);
  }

  heldCount(sessionId?: string): number {
    if (sessionId) return this.held.get(sessionId)?.length ?? 0;
    let n = 0;
    for (const q of this.held.values()) n += q.length;
    return n;
  }

  // The joined members the server reports, me excluded. Links follow it: new
  // sessions get one, sessions that left (or were replaced by a reconnect with a
  // new session id) lose theirs.
  setRoster(members: Member[]): void {
    if (this.closed) return;
    const next = new Map<string, string>();
    const max = this.opts.maxPeers ?? MAX_PEERS;
    for (const m of members) {
      if (!m.sessionId || m.sessionId === this.opts.localSession || m.userId === this.opts.localUser) continue;
      if (next.size >= max) break;
      next.set(m.sessionId, m.userId);
    }
    this.roster = next;
    let changed = false;
    for (const [session, entry] of [...this.links]) {
      const user = next.get(session);
      if (user === entry.userId) {
        this.cancelDrop(session);
      } else if (user !== undefined) {
        this.dropLink(session);   // same session id, another person: never trusted
        changed = true;
      } else if (!this.dropping.has(session)) {
        this.dropping.set(session, this.timers.set(() => {
          this.dropping.delete(session);
          if (!this.closed && !this.roster.has(session) && this.links.has(session)) {
            this.dropLink(session);
            this.opts.onChange?.();
          }
        }, this.opts.dropGraceMs ?? DROP_GRACE_MS));
      }
    }
    for (const [session, userId] of next) {
      if (!this.links.has(session)) {
        this.connect(session, userId);
        changed = true;
      }
    }
    if (changed) this.opts.onChange?.();
  }

  // Rebuild one link from scratch (it gave up, or the far side rebuilt theirs).
  rebuild(sessionId: string): void {
    const userId = this.roster.get(sessionId);
    if (!userId || this.closed) return;
    this.dropLink(sessionId);
    this.connect(sessionId, userId);
    this.opts.onChange?.();
  }

  handle(sig: CallSignal): void {
    if (this.closed || !sig || typeof sig !== 'object') return;
    const from = sig.from_session;
    if (!from || from === this.opts.localSession) return;
    if (sig.to_session && sig.to_session !== this.opts.localSession) return;
    const entry = this.links.get(from);
    // Somebody else's session id under another name: not trusted.
    if (entry && sig.from_user !== entry.userId) return;
    switch (sig.kind) {
      case 'bye':
        this.held.delete(from);
        if (entry) {
          this.dropLink(from);
          this.opts.onChange?.();
        }
        this.opts.onUnknownSession?.(from);
        return;
      case 'hello':
        if (entry) {
          if (entry.link.state === 'failed' || entry.link.isClosed) this.rebuild(from);
        } else if (!this.roster.has(from)) {
          this.opts.onUnknownSession?.(from);
        }
        return;
      case 'offer':
      case 'answer':
      case 'ice':
        if (entry) {
          void entry.link.handle(sig.kind, sig.data);
        } else {
          this.hold(from, sig);
          if (!this.roster.has(from)) this.opts.onUnknownSession?.(from);
        }
        return;
      default:
        return;
    }
  }

  // A hello to everyone: who I am, now.
  announce(data: unknown = null): void {
    if (this.closed) return;
    this.opts.send(this.signal(null, 'hello', data));
  }

  // Leaving: a bye to everyone, then every link closes.
  close(sayBye = true): void {
    if (this.closed) return;
    if (sayBye) {
      try { this.opts.send(this.signal(null, 'bye', null)); } catch { /* the page may be going away */ }
    }
    this.closed = true;
    for (const session of [...this.links.keys()]) this.dropLink(session);
    this.held.clear();
    this.roster.clear();
  }

  // ---------------------------------------------------------------- internals

  private signal(to: string | null, kind: CallSignal['kind'], data: unknown): CallSignal {
    return { from_user: this.opts.localUser, from_session: this.opts.localSession, to_session: to, kind, data };
  }

  private connect(session: string, userId: string): void {
    const link = this.opts.createLink(
      { userId, sessionId: session },
      isPolite(this.opts.localSession, session),
      (kind, data) => {
        if (!this.closed) this.opts.send(this.signal(session, kind, data));
      },
    );
    this.links.set(session, { link, userId });
    this.opts.send(this.signal(session, 'hello', null));
    const q = this.held.get(session);
    this.held.delete(session);
    if (q) {
      for (const sig of q) {
        if (sig.kind === 'offer' || sig.kind === 'answer' || sig.kind === 'ice') void link.handle(sig.kind, sig.data);
      }
    }
  }

  private cancelDrop(session: string): void {
    const t = this.dropping.get(session);
    if (t !== undefined) {
      this.timers.clear(t);
      this.dropping.delete(session);
    }
  }

  private dropLink(session: string): void {
    this.cancelDrop(session);
    const entry = this.links.get(session);
    if (!entry) return;
    this.links.delete(session);
    entry.link.close();
  }

  private hold(session: string, sig: CallSignal): void {
    const perSession = this.opts.holdPerSession ?? 60;
    const sessions = this.opts.holdSessions ?? 16;
    let q = this.held.get(session);
    if (!q) {
      if (this.held.size >= sessions) return;
      q = [];
      this.held.set(session, q);
    }
    if (q.length < perSession) q.push(sig);
  }
}
