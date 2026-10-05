// A stand-in RTCPeerConnection that enforces the JSEP signaling state machine the
// way browsers do (an offer applied in have-local-offer throws unless the side
// rolled back first; an answer outside have-local-offer throws; a candidate before
// any remote description throws), plus hand-driven timers. Enough to prove the
// negotiation logic without a browser.
import type { Timers } from '../../src/features/calls/link';

const tick = () => Promise.resolve();

function invalidState(message: string): DOMException {
  return new DOMException(message, 'InvalidStateError');
}

export class FakeSender {
  track: MediaStreamTrack | null;
  replaced: (MediaStreamTrack | null)[] = [];
  constructor(track: MediaStreamTrack | null) { this.track = track; }
  async replaceTrack(t: MediaStreamTrack | null): Promise<void> { this.track = t; this.replaced.push(t); }
  setStreams(): void { /* noop */ }
}

export class FakeTransceiver {
  readonly sender: FakeSender;
  readonly receiver: { track: MediaStreamTrack | null } = { track: null };
  private dir: RTCRtpTransceiverDirection;
  init: RTCRtpTransceiverInit | undefined;
  // Assigned when an offer is applied (local) or read from a remote offer, as browsers do.
  mid: string | null = null;
  stopped = false;
  constructor(readonly kind: string, track: MediaStreamTrack | null, direction: RTCRtpTransceiverDirection, private readonly pc: FakePC) {
    this.sender = new FakeSender(track);
    this.dir = direction;
  }
  get direction(): RTCRtpTransceiverDirection { return this.dir; }
  set direction(d: RTCRtpTransceiverDirection) { this.dir = d; this.pc.needNegotiation(); }
  // Stopping ends the received track at once; the m-line goes at the next negotiation.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.dir = 'stopped';
    this.receiver.track?.stop();
    this.pc.needNegotiation();
  }
}

export class FakePC {
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  private stableLocal: RTCSessionDescriptionInit | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((e: { candidate: { candidate: string; sdpMid: string; sdpMLineIndex: number; toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  readonly transceivers: FakeTransceiver[] = [];
  readonly added: RTCIceCandidateInit[] = [];
  readonly log: string[] = [];
  closed = false;
  restarts = 0;
  config: RTCConfiguration;
  candidatesPerDescription = 0;
  iceGatheringState: RTCIceGatheringState = 'complete';
  onicegatheringstatechange: (() => void) | null = null;
  // What getStats() reports (tests that read upload and download fill it).
  statsReport = new Map<string, unknown>();
  private offers = 0;
  private nextMid = 0;
  private negotiationQueued = false;

  constructor(readonly name: string, config: RTCConfiguration = {}) {
    this.config = config;
  }

  async createOffer(opts?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    await tick();
    this.offers += 1;
    this.log.push('createOffer');
    return { type: 'offer', sdp: `offer:${this.name}:${this.offers}${opts?.iceRestart || this.restarts ? ':restart' : ''}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    await tick();
    if (this.signalingState !== 'have-remote-offer') throw invalidState('createAnswer without a remote offer');
    this.log.push('createAnswer');
    return { type: 'answer', sdp: `answer:${this.name}` };
  }

  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    await tick();
    if (this.closed) throw invalidState('closed');
    if (d.type === 'rollback') {
      if (this.signalingState === 'stable') throw invalidState('nothing to roll back');
      this.log.push('rollback');
      this.signalingState = 'stable';
      this.localDescription = this.stableLocal;
      return;
    }
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw invalidState(`SLD(offer) in ${this.signalingState}`);
      this.signalingState = 'have-local-offer';
      this.localDescription = d;
      this.log.push('SLD:offer');
      for (const t of this.transceivers) if (t.mid === null && !t.stopped) t.mid = String(this.nextMid++);
    } else if (d.type === 'answer') {
      if (this.signalingState !== 'have-remote-offer') throw invalidState(`SLD(answer) in ${this.signalingState}`);
      this.signalingState = 'stable';
      this.localDescription = d;
      this.stableLocal = d;
      this.log.push('SLD:answer');
      this.dropStopped();
    }
    this.gather();
  }

  // Negotiation finished: stopped transceivers leave the list, as in browsers.
  private dropStopped(): void {
    for (let i = this.transceivers.length - 1; i >= 0; i -= 1) if (this.transceivers[i]?.stopped) this.transceivers.splice(i, 1);
  }

  // A remote offer naming media sections "mid:<mid>:<kind>" (how the tests play an
  // SFU offering tracks) adds a receive-only transceiver per new mid, its track
  // announced through ontrack while the description is applied.
  private remoteSections(sdp: string): void {
    for (const m of sdp.matchAll(/mid:([A-Za-z0-9_-]+):(audio|video)/g)) {
      const [, mid, kind] = m;
      if (!mid || !kind || this.transceivers.some((t) => t.mid === mid)) continue;
      const t = new FakeTransceiver(kind, null, 'recvonly', this);
      t.mid = mid;
      const track = fakeTrack(kind as 'audio' | 'video', `rx-${this.name}-${mid}`);
      t.receiver.track = track;
      this.transceivers.push(t);
      this.ontrack?.({ track, streams: [], transceiver: t });
    }
  }

  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    await tick();
    if (this.closed) throw invalidState('closed');
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw invalidState(`SRD(offer) in ${this.signalingState}`);
      this.signalingState = 'have-remote-offer';
      this.remoteDescription = d;
      this.log.push(`SRD:offer:${d.sdp}`);
      this.remoteSections(d.sdp ?? '');
      return;
    }
    if (d.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw invalidState(`SRD(answer) in ${this.signalingState}`);
      this.signalingState = 'stable';
      this.remoteDescription = d;
      this.stableLocal = this.localDescription;
      this.log.push(`SRD:answer:${d.sdp}`);
      this.dropStopped();
    }
  }

  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
    await tick();
    if (!this.remoteDescription) throw invalidState('addIceCandidate before a remote description');
    this.added.push(c);
  }

  addTrack(track: MediaStreamTrack): FakeSender {
    const t = new FakeTransceiver(track.kind, track, 'sendrecv', this);
    this.transceivers.push(t);
    this.needNegotiation();
    return t.sender;
  }

  addTransceiver(kindOrTrack: string | MediaStreamTrack, init?: RTCRtpTransceiverInit): FakeTransceiver {
    const track = typeof kindOrTrack === 'string' ? null : kindOrTrack;
    const kind = typeof kindOrTrack === 'string' ? kindOrTrack : kindOrTrack.kind;
    const t = new FakeTransceiver(kind, track, init?.direction ?? 'sendrecv', this);
    t.init = init;
    this.transceivers.push(t);
    this.needNegotiation();
    return t;
  }

  getTransceivers(): FakeTransceiver[] {
    return this.transceivers;
  }

  restartIce(): void {
    this.restarts += 1;
    this.needNegotiation();
  }

  setConfiguration(c: RTCConfiguration): void {
    this.config = c;
  }

  close(): void {
    this.closed = true;
    this.signalingState = 'closed';
    this.connectionState = 'closed';
  }

  async getStats(): Promise<Map<string, unknown>> {
    return new Map(this.statsReport);
  }

  // Browsers fire negotiationneeded asynchronously, and only when stable.
  needNegotiation(): void {
    if (this.negotiationQueued) return;
    this.negotiationQueued = true;
    queueMicrotask(() => {
      this.negotiationQueued = false;
      if (!this.closed && this.signalingState === 'stable') this.onnegotiationneeded?.();
    });
  }

  setConnection(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  emitCandidate(n: number): void {
    const candidate = `candidate:${n} 1 udp 2122260223 192.0.2.${n} 5${n}000 typ host`;
    this.onicecandidate?.({ candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0, toJSON: () => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 }) } });
  }

  private gather(): void {
    for (let i = 1; i <= this.candidatesPerDescription; i += 1) this.emitCandidate(i);
  }
}

// Tracks and streams with real events (mute, unmute, ended, removetrack), like
// the browser's: stop() ends a track without firing 'ended' (only the source
// ending does that, e.g. the browser's own "Stop sharing" bar).
export interface FakeTrack extends MediaStreamTrack {
  setMuted(muted: boolean): void;
  endFromSource(): void;
}

export function fakeTrack(kind: 'audio' | 'video', id = `${kind}-1`): FakeTrack {
  const t = new EventTarget() as unknown as FakeTrack & Record<string, unknown>;
  const state = { readyState: 'live' as MediaStreamTrackState, muted: false };
  Object.defineProperties(t, {
    kind: { value: kind },
    id: { value: id },
    readyState: { get: () => state.readyState },
    muted: { get: () => state.muted },
  });
  Object.assign(t, {
    enabled: true,
    contentHint: '',
    stop() { state.readyState = 'ended'; },
    setMuted(m: boolean) {
      state.muted = m;
      t.dispatchEvent(new Event(m ? 'mute' : 'unmute'));
    },
    endFromSource() {
      state.readyState = 'ended';
      t.dispatchEvent(new Event('ended'));
    },
  });
  return t;
}

let streamSeq = 0;

export function fakeStream(...tracks: MediaStreamTrack[]): MediaStream {
  const list = [...tracks];
  streamSeq += 1;
  const s = new EventTarget() as unknown as MediaStream & Record<string, unknown>;
  Object.assign(s, {
    id: `stream-${streamSeq}`,
    getTracks: () => list.slice(),
    getAudioTracks: () => list.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => list.filter((t) => t.kind === 'video'),
    addTrack: (t: MediaStreamTrack) => { list.push(t); },
    removeTrack: (t: MediaStreamTrack) => { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); },
  });
  return s;
}

// What the browser does on the receiving side when a sender stops (after the
// renegotiation): the track is muted and taken out of its stream.
export function removeRemoteTrack(stream: MediaStream, track: FakeTrack): void {
  stream.removeTrack(track);
  stream.dispatchEvent(new Event('removetrack'));
  track.setMuted(true);
}

// Timers the test advances by hand.
export class ManualTimers implements Timers {
  private now = 0;
  private seq = 0;
  private readonly jobs = new Map<number, { at: number; fn: () => void }>();

  set(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.jobs.set(this.seq, { at: this.now + ms, fn });
    return this.seq;
  }

  clear(h: unknown): void {
    this.jobs.delete(h as number);
  }

  pending(): number {
    return this.jobs.size;
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.jobs) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.jobs.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
}

export async function flush(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
