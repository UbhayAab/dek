// One peer connection to one remote session, negotiated with the W3C "perfect
// negotiation" pattern, plus the lessons the legacy app paid for (LESSONS, Calls):
//
//   - the polite side is decided by comparing session ids (the caller passes it);
//     on glare the impolite side ignores the incoming offer and the polite side
//     rolls back its own and answers;
//   - every operation (making an offer, applying a description, adding a
//     candidate) runs through one promise chain, so renegotiation is serialized;
//   - remote ICE candidates wait until there is a remote description;
//   - local candidates are sent in batches every 150 ms, because an 8 person mesh
//     floods the realtime rate limit during setup;
//   - 'disconnected' is transient: 6 s of grace, then an ICE restart; 'failed'
//     restarts at once, up to a limit, then the link gives up and says so;
//   - the polite side lets the impolite side make the first offer (a short wait),
//     so the common case has no glare at all.
//
// Nothing here knows about calls, rooms, people or the DOM; the mesh owns those.

export type LinkState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';
export type LinkSignalKind = 'offer' | 'answer' | 'ice';

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface PeerLinkOptions {
  pc: RTCPeerConnection;
  polite: boolean;
  send: (kind: LinkSignalKind, data: unknown) => void;
  onTrack?: (track: MediaStreamTrack, stream: MediaStream) => void;
  onState?: (state: LinkState) => void;
  onGiveUp?: () => void;
  // Each time the connection reaches 'failed' (before any restart).
  onFailure?: () => void;
  // The latest ICE configuration (fresh TURN credentials) applied before a restart.
  freshConfig?: () => RTCConfiguration | null;
  timers?: Timers;
  iceBatchMs?: number;
  graceMs?: number;
  initialWaitMs?: number;
  maxRestarts?: number;
  offerRetryMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export const ICE_BATCH_MS = 150;
export const DISCONNECT_GRACE_MS = 6000;
export const INITIAL_OFFER_WAIT_MS = 2500;
export const MAX_RESTARTS = 3;
// Signaling is a broadcast with no history: an offer sent before the far side
// joined the topic is simply gone. An unanswered offer is sent again (its
// localDescription by then also carries the candidates gathered so far).
export const OFFER_RETRY_MS = 2000;
export const MAX_OFFER_RETRIES = 5;
const MAX_HELD_CANDIDATES = 200;

function isCandidate(v: unknown): v is RTCIceCandidateInit {
  return !!v && typeof v === 'object' && typeof (v as RTCIceCandidateInit).candidate === 'string'
    && (v as RTCIceCandidateInit).candidate !== '';
}

function isDescription(v: unknown): v is RTCSessionDescriptionInit {
  const t = (v as RTCSessionDescriptionInit | null)?.type;
  return !!v && typeof v === 'object' && (t === 'offer' || t === 'answer') && typeof (v as RTCSessionDescriptionInit).sdp === 'string';
}

export class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly polite: boolean;
  private readonly opts: PeerLinkOptions;
  private readonly timers: Timers;
  private chain: Promise<void> = Promise.resolve();
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private everRemote = false;
  private waitingFirstOffer: unknown = null;
  private deferredOffer = false;
  private heldRemote: RTCIceCandidateInit[] = [];
  private outgoing: RTCIceCandidateInit[] = [];
  private iceTimer: unknown = null;
  private graceTimer: unknown = null;
  private offerTimer: unknown = null;
  private offerRetries = 0;
  private restarts = 0;
  private closed = false;
  private current: LinkState = 'new';
  private readonly transceivers: Partial<Record<'audio' | 'video', RTCRtpTransceiver>> = {};
  // Every kind of local candidate gathered (host, srflx, relay): what this side
  // can offer the far side, for the call screen's details and for tests.
  readonly gathered = new Set<string>();

  constructor(opts: PeerLinkOptions) {
    this.opts = opts;
    this.pc = opts.pc;
    this.polite = opts.polite;
    this.timers = opts.timers ?? realTimers;
    const pc = this.pc;
    pc.onnegotiationneeded = () => { void this.enqueue(() => this.negotiate('event')); };
    pc.onicecandidate = (e) => this.queueCandidate(e.candidate);
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.opts.onTrack?.(e.track, stream);
    };
    pc.onconnectionstatechange = () => this.onPcState();
    pc.oniceconnectionstatechange = () => {
      // Browsers without connectionState (old Firefox) report through ICE only.
      if (!(pc as { connectionState?: string }).connectionState) this.onPcState();
    };
    if (this.polite) {
      this.waitingFirstOffer = this.timers.set(() => {
        this.waitingFirstOffer = null;
        if (!this.everRemote && this.deferredOffer) void this.enqueue(() => this.negotiate('timer'));
      }, opts.initialWaitMs ?? INITIAL_OFFER_WAIT_MS);
    }
  }

  get state(): LinkState {
    return this.current;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // Local media for this link. A missing track still gets a receive-only
  // transceiver so the far side's audio (and video) can arrive.
  attach(stream: MediaStream | null, wantVideo: boolean): void {
    const audio = stream?.getAudioTracks()[0] ?? null;
    const video = stream?.getVideoTracks()[0] ?? null;
    this.transceivers.audio = this.addKind('audio', audio, stream);
    if (wantVideo || video) this.transceivers.video = this.addKind('video', video, stream);
  }

  private addKind(kind: 'audio' | 'video', track: MediaStreamTrack | null, stream: MediaStream | null): RTCRtpTransceiver | undefined {
    if (track && stream) {
      const sender = this.pc.addTrack(track, stream);
      return this.pc.getTransceivers().find((t) => t.sender === sender);
    }
    return this.pc.addTransceiver(kind, { direction: 'recvonly' });
  }

  // Swap the microphone or camera without renegotiating (device change, camera
  // off and on). A transceiver that was receive-only starts sending: that one
  // change renegotiates through negotiationneeded.
  async replaceTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null, stream: MediaStream | null): Promise<void> {
    if (this.closed) return;
    const t = this.transceivers[kind];
    if (!t) {
      if (!track) return;
      if (stream) {
        const sender = this.pc.addTrack(track, stream);
        this.transceivers[kind] = this.pc.getTransceivers().find((x) => x.sender === sender);
      }
      return;
    }
    await t.sender.replaceTrack(track);
    if (track && (t.direction === 'recvonly' || t.direction === 'inactive')) {
      if (stream) {
        try { t.sender.setStreams?.(stream); } catch { /* older browsers */ }
      }
      t.direction = 'sendrecv';
    }
  }

  // A signal from the far side, in arrival order.
  handle(kind: LinkSignalKind, data: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      if (kind === 'ice') {
        await this.addRemoteCandidates(data);
        return;
      }
      if (!isDescription(data)) return;
      const desc = data;
      const pc = this.pc;
      const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.settingRemoteAnswer);
      const collision = desc.type === 'offer' && !readyForOffer;
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      if (desc.type === 'answer' && pc.signalingState !== 'have-local-offer') return;   // a late duplicate
      if (collision) {
        this.stopOfferRetry();
        await pc.setLocalDescription({ type: 'rollback' });
      }
      this.settingRemoteAnswer = desc.type === 'answer';
      try {
        await pc.setRemoteDescription(desc);
      } finally {
        this.settingRemoteAnswer = false;
      }
      this.everRemote = true;
      if (desc.type === 'answer') this.stopOfferRetry();
      if (this.waitingFirstOffer !== null) {
        this.timers.clear(this.waitingFirstOffer);
        this.waitingFirstOffer = null;
      }
      await this.drainHeld();
      if (desc.type === 'offer') {
        const answer = await pc.createAnswer();
        if (this.closed) return;
        await pc.setLocalDescription(answer);
        // The description first, then whatever candidates it already produced.
        this.opts.send('answer', this.describe(answer));
        this.flushCandidates();
      }
    });
  }

  // ICE restart, with fresh credentials when the caller has them.
  restart(): void {
    if (this.closed) return;
    this.restarts += 1;
    const cfg = this.opts.freshConfig?.();
    if (cfg) {
      try { this.pc.setConfiguration(cfg); } catch { /* keep the old configuration */ }
    }
    if (typeof this.pc.restartIce === 'function') {
      this.pc.restartIce();
    } else {
      void this.enqueue(() => this.negotiate('restart'));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of [this.iceTimer, this.graceTimer, this.waitingFirstOffer, this.offerTimer]) if (t !== null) this.timers.clear(t);
    this.iceTimer = null;
    this.graceTimer = null;
    this.waitingFirstOffer = null;
    this.offerTimer = null;
    this.outgoing = [];
    this.heldRemote = [];
    const pc = this.pc;
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    try { pc.close(); } catch { /* already closed */ }
    this.setState('closed');
  }

  // ---------------------------------------------------------------- internals

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(op).catch((e: unknown) => { this.opts.log?.('negotiation step failed', e); });
    this.chain = next;
    return next;
  }

  private describe(d: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    const local = this.pc.localDescription;
    return local ? { type: local.type, sdp: local.sdp } : { type: d.type, sdp: d.sdp ?? '' };
  }

  private async negotiate(source: 'event' | 'timer' | 'restart'): Promise<void> {
    if (this.closed) return;
    if (this.polite && !this.everRemote && source === 'event' && this.waitingFirstOffer !== null) {
      this.deferredOffer = true;   // the impolite side offers first
      return;
    }
    if (this.pc.signalingState !== 'stable') return;   // negotiationneeded fires again once stable
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer(source === 'restart' ? { iceRestart: true } : undefined);
      if (this.closed || this.pc.signalingState !== 'stable') return;
      await this.pc.setLocalDescription(offer);
      this.opts.send('offer', this.describe(offer));
      this.flushCandidates();
      this.offerRetries = 0;
      this.armOfferRetry();
    } finally {
      this.makingOffer = false;
    }
  }

  private armOfferRetry(): void {
    this.stopOfferRetry();
    this.offerTimer = this.timers.set(() => {
      this.offerTimer = null;
      const local = this.pc.localDescription;
      if (this.closed || this.pc.signalingState !== 'have-local-offer' || !local || local.type !== 'offer') return;
      if (this.offerRetries >= MAX_OFFER_RETRIES) return;
      this.offerRetries += 1;
      this.opts.send('offer', { type: local.type, sdp: local.sdp });
      this.armOfferRetry();
    }, this.opts.offerRetryMs ?? OFFER_RETRY_MS);
  }

  private stopOfferRetry(): void {
    if (this.offerTimer !== null) this.timers.clear(this.offerTimer);
    this.offerTimer = null;
  }

  private async addRemoteCandidates(data: unknown): Promise<void> {
    const list = (Array.isArray(data) ? data : [data]).filter(isCandidate);
    for (const c of list) {
      if (!this.pc.remoteDescription) {
        if (this.heldRemote.length < MAX_HELD_CANDIDATES) this.heldRemote.push(c);
        continue;
      }
      try {
        await this.pc.addIceCandidate(c);
      } catch (e) {
        if (!this.ignoreOffer) this.opts.log?.('candidate rejected', e);
      }
    }
  }

  private async drainHeld(): Promise<void> {
    const q = this.heldRemote;
    this.heldRemote = [];
    for (const c of q) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        // a candidate from an offer that was rolled back
      }
    }
  }

  private queueCandidate(c: RTCIceCandidate | null): void {
    if (this.closed) return;
    if (!c || !c.candidate) {
      this.flushCandidates();
      return;
    }
    const typ = / typ (\w+)/.exec(c.candidate)?.[1];
    if (typ) this.gathered.add(typ);
    this.outgoing.push(typeof c.toJSON === 'function' ? c.toJSON() : { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
    if (this.iceTimer === null) {
      this.iceTimer = this.timers.set(() => {
        this.iceTimer = null;
        this.flushCandidates();
      }, this.opts.iceBatchMs ?? ICE_BATCH_MS);
    }
  }

  private flushCandidates(): void {
    if (this.iceTimer !== null) {
      this.timers.clear(this.iceTimer);
      this.iceTimer = null;
    }
    if (!this.outgoing.length || this.closed) return;
    const batch = this.outgoing;
    this.outgoing = [];
    this.opts.send('ice', batch);
  }

  private setState(s: LinkState): void {
    if (this.current === s) return;
    this.current = s;
    this.opts.onState?.(s);
  }

  private connectionState(): string {
    const pc = this.pc;
    const cs = (pc as { connectionState?: string }).connectionState;
    if (cs) return cs;
    const ice = pc.iceConnectionState;
    return ice === 'completed' ? 'connected' : ice === 'checking' ? 'connecting' : ice;
  }

  private onPcState(): void {
    if (this.closed) return;
    const s = this.connectionState();
    if (s === 'connected') {
      if (this.graceTimer !== null) this.timers.clear(this.graceTimer);
      this.graceTimer = null;
      this.restarts = 0;
      this.setState('connected');
    } else if (s === 'disconnected') {
      this.setState('reconnecting');
      if (this.graceTimer === null) {
        this.graceTimer = this.timers.set(() => {
          this.graceTimer = null;
          const now = this.connectionState();
          if (now === 'disconnected' || now === 'failed') this.restartOrGiveUp();
        }, this.opts.graceMs ?? DISCONNECT_GRACE_MS);
      }
    } else if (s === 'failed') {
      if (this.graceTimer !== null) this.timers.clear(this.graceTimer);
      this.graceTimer = null;
      this.opts.onFailure?.();
      this.restartOrGiveUp();
    } else if (s === 'closed') {
      this.setState('closed');
    } else if (this.current !== 'reconnecting') {
      this.setState('connecting');
    }
  }

  private restartOrGiveUp(): void {
    if (this.restarts >= (this.opts.maxRestarts ?? MAX_RESTARTS)) {
      this.setState('failed');
      this.opts.onGiveUp?.();
      return;
    }
    this.setState('reconnecting');
    this.restart();
  }
}
