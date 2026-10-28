// The SFU path of a group call (an audio room, or a direct call of three or more): one
// RTCPeerConnection per person to Cloudflare Realtime, through the sfu Edge Function
// (CONTRACT 5, migration 0914). Each person sends their microphone (camera, screen)
// once and receives everyone else's tracks from the SFU, instead of one link per other
// person (mesh.ts), so a phone in a call of six uploads one stream, not five.
//
//   setup     sendonly transceivers for what this person sends, one offer, the
//             function's 'session' action: Cloudflare's answer, and this person's SFU
//             session and track names recorded for everyone (call.upd carries
//             participants[].sfu_session and sfu_tracks).
//   roster    every other joined person's published tracks (setRoster). New ones are
//             pulled in one request; Cloudflare offers them and this side answers
//             through 'renegotiate'. Tracks nobody publishes any more are closed (stop
//             the transceivers, offer, 'close', apply the answer). A pull Cloudflare
//             cannot serve yet (the publisher is still connecting) is tried again with
//             backoff.
//   local     camera on and screen sharing push a new track, camera off and stop
//             sharing close it, a device change is a replaceTrack (no negotiation).
//   order     Cloudflare needs one offer/answer exchange finished before the next change
//             on a session, so every change runs through one queue.
//   failure   'disconnected' gets a grace period; 'failed', an error from the function
//             or a session the server forgot rebuild everything on a new session, with
//             backoff, then the connection gives up and says so (Try again: reconnect()).
//
// Remote tracks are put together per person: microphone and camera in one stream, a
// shared screen in a stream of its own, each reported with its role so the call screen
// never has to guess. Nothing here knows about the UI.
import { SCREEN_MAX_BITRATE, SCREEN_MAX_FPS, realTimers, type LinkState, type Timers } from './link';
import type { Member } from './mesh';

export type SfuAction = 'session' | 'push' | 'pull' | 'renegotiate' | 'close';
export type RemoteRole = 'audio' | 'camera' | 'screen';

export interface SfuTrackResult {
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
}

// What the sfu function answers (CONTRACT 5).
export interface SfuReply {
  sfu_session?: string;
  answer?: RTCSessionDescriptionInit | null;
  offer?: RTCSessionDescriptionInit | null;
  renegotiate?: boolean;
  tracks?: SfuTrackResult[];
  refused?: { session: string; name: string }[];
  call?: unknown;
}

// One request to the function for this call and session.
export type SfuRequest = (action: SfuAction, body: Record<string, unknown>) => Promise<SfuReply>;

// A refusal from the function: status is its HTTP status (null when it was not
// reached), code its error, and for sfu_error Cloudflare's own status and code.
export class SfuError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly cfStatus: number | null;
  readonly cfCode: string | null;
  constructor(status: number | null, code: string, message?: string, cfStatus: number | null = null, cfCode: string | null = null) {
    super(message ?? code);
    this.name = 'SfuError';
    this.status = status;
    this.code = code;
    this.cfStatus = cfStatus;
    this.cfCode = cfCode;
  }

  // The SFU session itself is gone or out of step: only a new one helps.
  get sessionLost(): boolean {
    if (this.code !== 'sfu_error' || this.cfStatus === 425) return false;
    return this.cfStatus === 410 || this.cfCode === 'session_error' || this.cfCode === 'invalid_session_description';
  }
}

// Each connection's setup carries a number that only grows in this page, so a setup
// still on its way from a connection that was replaced cannot overwrite the newer
// one's record (svc_sfu_publish compares them).
let lastEpoch = 0;
function nextEpoch(): number {
  lastEpoch = Math.max(lastEpoch + 1, Date.now());
  return lastEpoch;
}

// One other joined person and what they publish, from the call (sfu_session, sfu_tracks).
export interface SfuPeer extends Member {
  sfuSession: string | null;
  tracks: string[];
}

export interface SfuLocal {
  stream: MediaStream | null;
  listenOnly: boolean;
  screen: { track: MediaStreamTrack; stream: MediaStream } | null;
}

export interface SfuOptions {
  request: SfuRequest;
  createPeerConnection: (cfg: RTCConfiguration) => RTCPeerConnection;
  // The configuration for a new connection (fresh TURN credentials on a rebuild).
  config: () => RTCConfiguration;
  createStream: () => MediaStream;
  timers?: Timers;
  // How long the first offer may wait for ICE candidates (Cloudflare asks for them).
  gatherMs?: number;
  log?: (message: string, error?: unknown) => void;
  onPeer: (member: Member, state: LinkState) => void;
  onPeerGone: (sessionId: string) => void;
  onTrack: (member: Member, track: MediaStreamTrack, stream: MediaStream, role: RemoteRole) => void;
  onTrackGone: (member: Member, track: MediaStreamTrack, stream: MediaStream) => void;
  onState?: (state: LinkState) => void;
  // The connection failed (the call screen's relay warning, as for the mesh).
  onFailure?: () => void;
  // The server refused because the call changed (left, ended, moved, switched): read it again.
  onConflict?: () => void;
  // The call as the function recorded it (newer than the realtime event that follows).
  onCall?: (call: unknown) => void;
}

export const SFU_GATHER_MS = 1000;
export const SFU_GRACE_MS = 5000;
export const SFU_PULL_RETRY_MS = [1000, 2000, 4000, 8000, 15000] as const;
export const SFU_REBUILD_MS = [500, 2000, 5000, 10000] as const;
export const SFU_RATE_WAIT_MS = 15000;
export const SFU_DROP_GRACE_MS = 1500;
export const SFU_LOST_MS = 3000;
// Pull requests that failed in a row (Cloudflare busy, the network) before the whole
// connection starts over.
export const SFU_PULL_FAILURES = 5;

const SFU_ID = /^[A-Za-z0-9_-]{8,64}$/;

type LocalRole = 'mic' | 'cam' | 'screen';

export function roleOf(name: string): LocalRole | null {
  const m = /^(mic|cam|screen)-[a-z0-9]{1,16}$/.exec(name);
  return m ? (m[1] as LocalRole) : null;
}

interface Out {
  name: string;
  tx: RTCRtpTransceiver;
  track: MediaStreamTrack | null;
}

interface Remote {
  member: Member;
  sfuSession: string | null;
  published: string[];
  pulls: Map<string, Pull>;
  main: MediaStream | null;
  screen: MediaStream | null;
  state: LinkState | null;
  drop: unknown;
}

interface Pull {
  remote: Remote;
  name: string;
  session: string;
  mid: string | null;
  status: 'pending' | 'active' | 'waiting';
  attempts: number;
  due: boolean;
  timer: unknown;
  track: MediaStreamTrack | null;
  stream: MediaStream | null;
}

// An operation that belongs to a connection that was replaced meanwhile.
class Stale extends Error {}

function liveTrack(stream: MediaStream | null, kind: 'audio' | 'video'): MediaStreamTrack | null {
  if (!stream) return null;
  const list = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
  return list.find((t) => t.readyState === 'live') ?? null;
}

function describe(local: RTCSessionDescription | RTCSessionDescriptionInit | null, fallback: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  return local ? { type: local.type, sdp: local.sdp ?? '' } : { type: fallback.type, sdp: fallback.sdp ?? '' };
}

function pcState(pc: RTCPeerConnection): string {
  const cs = (pc as { connectionState?: string }).connectionState;
  if (cs) return cs;
  const ice = pc.iceConnectionState;
  return ice === 'completed' ? 'connected' : ice === 'checking' ? 'connecting' : ice;
}

// Whether Cloudflare took a pushed track (no answer about it at all counts as taken).
function accepted(results: SfuTrackResult[] | undefined, o: Out): boolean {
  if (!Array.isArray(results)) return true;
  return results.some((t) => (t.mid === o.tx.mid || t.trackName === o.name) && !t.errorCode);
}

export class SfuConnection {
  private readonly opts: SfuOptions;
  private readonly timers: Timers;
  private pc: RTCPeerConnection | null = null;
  private sfuSession: string | null = null;
  private gen = 0;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private current: LinkState = 'new';
  private everConnected = false;
  private settingUp = false;
  private failures = 0;
  private rebuildTimer: unknown = null;
  private graceTimer: unknown = null;
  private lostTimer: unknown = null;
  private lostStrikes = 0;
  private reconcileQueued = false;
  private localQueued: Promise<void> | null = null;
  private names = 0;
  private stream: MediaStream | null = null;
  private listenOnly = false;
  private screen: { track: MediaStreamTrack; stream: MediaStream } | null = null;
  private out: { mic: Out | null; cam: Out | null; screen: Out | null } = { mic: null, cam: null, screen: null };
  private readonly remotes = new Map<string, Remote>();
  private listed = new Set<string>();
  private readonly byMid = new Map<string, Pull>();
  private orphans: Pull[] = [];
  private mine: { sfuSession: string | null } | null = null;
  private epoch = 0;
  private pullFailures = 0;
  // Local tracks Cloudflare did not take: not offered again (a new camera is a new track).
  private readonly refusedTracks = new WeakSet<MediaStreamTrack>();

  constructor(opts: SfuOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? realTimers;
  }

  get state(): LinkState {
    return this.current;
  }

  get connection(): RTCPeerConnection | null {
    return this.pc;
  }

  get session(): string | null {
    return this.sfuSession;
  }

  // The names this person publishes now (for tests and diagnostics).
  get publishing(): string[] {
    return [this.out.mic, this.out.cam, this.out.screen].filter((o): o is Out => !!o).map((o) => o.name);
  }

  has(sessionId: string): boolean {
    return this.remotes.has(sessionId);
  }

  members(): Member[] {
    return [...this.remotes.values()].map((r) => r.member);
  }

  // Who sent the remote track with this id (getStats' trackIdentifier), for the call details.
  ownerOf(trackId: string): Member | null {
    for (const r of this.remotes.values()) {
      for (const p of r.pulls.values()) if (p.track?.id === trackId) return r.member;
    }
    return null;
  }

  start(local: SfuLocal): void {
    if (this.closed || this.pc) return;
    this.stream = local.stream;
    this.listenOnly = local.listenOnly;
    this.screen = local.screen;
    this.connect();
  }

  // The other joined people (me excluded) and my own row's SFU session as the server
  // has it. Called with every version of the call.
  setRoster(list: SfuPeer[], mine: { sfuSession: string | null } | null): void {
    if (this.closed) return;
    this.mine = mine;
    const next = new Map<string, SfuPeer>();
    for (const m of list) if (m.sessionId && !next.has(m.sessionId)) next.set(m.sessionId, m);
    for (const [sid, r] of [...this.remotes]) {
      const m = next.get(sid);
      if (m && m.userId !== r.member.userId) {
        this.dropRemote(sid);   // the same session id for another person: never trusted
        continue;
      }
      if (m) {
        if (r.drop !== null) this.timers.clear(r.drop);
        r.drop = null;
        continue;
      }
      // Gone from this version. Dropped only if still gone a moment later: the newest
      // version wins anyway, but a dropped person costs everyone a pull to come back.
      if (r.drop === null) {
        r.drop = this.timers.set(() => {
          r.drop = null;
          if (this.remotes.get(sid) === r && !this.listed.has(sid)) {
            this.dropRemote(sid);
            this.scheduleReconcile();
          }
        }, SFU_DROP_GRACE_MS);
      }
    }
    this.listed = new Set(next.keys());
    for (const m of next.values()) {
      let r = this.remotes.get(m.sessionId);
      if (!r) {
        r = { member: { userId: m.userId, sessionId: m.sessionId }, sfuSession: null, published: [], pulls: new Map(), main: null, screen: null, state: null, drop: null };
        this.remotes.set(m.sessionId, r);
      }
      r.sfuSession = m.sfuSession && SFU_ID.test(m.sfuSession) ? m.sfuSession : null;
      r.published = [...new Set((m.tracks ?? []).filter((n) => roleOf(n) !== null))];
      this.report(r);
    }
    this.checkMine();
    this.scheduleReconcile();
  }

  // The microphone or the camera changed (device change, camera on or off).
  async replaceTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null, stream: MediaStream | null): Promise<void> {
    if (this.closed) return;
    if (stream) this.stream = stream;
    const o = kind === 'audio' ? this.out.mic : this.out.cam;
    if (track && o && o.track !== track) {
      // The same SFU track from a new source: nothing to negotiate.
      await o.tx.sender.replaceTrack(track);
      o.track = track;
      return;
    }
    await this.scheduleLocal();
  }

  shareScreen(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.screen = { track, stream };
    return this.scheduleLocal();
  }

  stopScreen(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.screen = null;
    return this.scheduleLocal();
  }

  // "Try again" after the connection gave up.
  reconnect(): void {
    this.restart();
  }

  // Start over on a new SFU session now (a rejoin: the server forgot the old one).
  restart(): void {
    if (this.closed) return;
    this.failures = 0;
    if (this.rebuildTimer !== null) this.timers.clear(this.rebuildTimer);
    this.rebuildTimer = null;
    this.retire(true);
    this.connect();
  }

  close(): void {
    if (this.closed) return;
    this.retire(false);
    this.closed = true;
    for (const t of [this.rebuildTimer, this.lostTimer]) if (t !== null) this.timers.clear(t);
    this.rebuildTimer = null;
    this.lostTimer = null;
    for (const r of this.remotes.values()) if (r.drop !== null) this.timers.clear(r.drop);
    this.remotes.clear();
    this.listed.clear();
    this.current = 'closed';
  }

  // ---------------------------------------------------------------- connection

  private connect(): void {
    if (this.closed) return;
    this.gen += 1;
    const gen = this.gen;
    this.epoch = nextEpoch();
    this.pullFailures = 0;
    this.everConnected = false;
    this.settingUp = true;
    this.reconcileQueued = false;
    this.localQueued = null;
    this.chain = Promise.resolve();
    this.setState(this.failures > 0 ? 'reconnecting' : 'connecting');
    let pc: RTCPeerConnection;
    try {
      pc = this.opts.createPeerConnection(this.opts.config());
    } catch (e) {
      this.opts.log?.('sfu: no peer connection', e);
      this.fail(gen);
      return;
    }
    this.pc = pc;
    pc.ontrack = (e) => this.onTrack(gen, e);
    pc.onconnectionstatechange = () => this.onPcState(gen);
    pc.oniceconnectionstatechange = () => {
      if (!(pc as { connectionState?: string }).connectionState) this.onPcState(gen);
    };
    void this.enqueue(gen, () => this.setup(gen, pc));
  }

  private async setup(gen: number, pc: RTCPeerConnection): Promise<void> {
    const sending: Out[] = [];
    const mic = this.wanted('audio');
    const cam = this.wanted('video');
    if (mic && this.stream) sending.push(this.out.mic = this.addOut(pc, 'mic', mic, this.stream));
    if (cam && this.stream) sending.push(this.out.cam = this.addOut(pc, 'cam', cam, this.stream));
    if (this.screen && !this.refusedTracks.has(this.screen.track)) {
      sending.push(this.out.screen = this.addOut(pc, 'screen', this.screen.track, this.screen.stream));
    }
    const offer = sending.length ? await this.localOffer(gen, pc) : null;
    const reply = await this.opts.request('session', {
      offer, tracks: sending.map((o) => ({ mid: o.tx.mid, name: o.name })), epoch: this.epoch,
    });
    this.check(gen);
    if (typeof reply.sfu_session !== 'string' || !SFU_ID.test(reply.sfu_session)) throw new SfuError(null, 'sfu_error', 'The media server gave no session.');
    this.sfuSession = reply.sfu_session;
    this.settingUp = false;
    if (offer) {
      if (!reply.answer) throw new SfuError(null, 'sfu_error', 'The media server gave no answer.');
      await pc.setRemoteDescription(reply.answer);
      this.check(gen);
    }
    await this.dropRefused(sending, reply.tracks);
    this.opts.onCall?.(reply.call);
    this.checkMine();
    this.scheduleReconcile();
  }

  // What this person sends of a kind now, unless Cloudflare refused that very track.
  private wanted(kind: 'audio' | 'video'): MediaStreamTrack | null {
    const t = this.listenOnly ? null : liveTrack(this.stream, kind);
    return t && !this.refusedTracks.has(t) ? t : null;
  }

  // Tracks Cloudflare did not take: without the microphone the call is pointless, so
  // start over; a camera or a screen is dropped (and not offered again) instead.
  private async dropRefused(sent: Out[], results: SfuTrackResult[] | undefined): Promise<void> {
    for (const o of sent) {
      if (accepted(results, o)) continue;
      if (o === this.out.mic) throw new SfuError(null, 'sfu_error', 'The media server did not take the microphone.');
      if (o.track) this.refusedTracks.add(o.track);
      if (this.out.cam === o) this.out.cam = null;
      if (this.out.screen === o) this.out.screen = null;
      try { await o.tx.sender.replaceTrack(null); } catch { /* nothing to send anyway */ }
      this.opts.log?.(`sfu: ${o.name} was not taken`);
    }
  }

  private addOut(pc: RTCPeerConnection, role: LocalRole, track: MediaStreamTrack, stream: MediaStream): Out {
    const init: RTCRtpTransceiverInit = { direction: 'sendonly', streams: [stream] };
    // One upload however many watch it, but often on a couple of megabits: capped, as on the mesh.
    if (role === 'screen') init.sendEncodings = [{ maxBitrate: SCREEN_MAX_BITRATE, maxFramerate: SCREEN_MAX_FPS }];
    const tx = pc.addTransceiver(track, init);
    this.names += 1;
    return { name: `${role}-${this.names}`, tx, track };
  }

  // A local offer, set, with candidates (bounded) on a connection that never connected.
  private async localOffer(gen: number, pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
    const offer = await pc.createOffer();
    this.check(gen);
    await pc.setLocalDescription(offer);
    this.check(gen);
    await this.gathered(pc);
    this.check(gen);
    return describe(pc.localDescription, offer);
  }

  private gathered(pc: RTCPeerConnection): Promise<void> {
    const ms = this.opts.gatherMs ?? SFU_GATHER_MS;
    if (ms <= 0 || this.everConnected || pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: unknown = null;
      const done = () => {
        if (timer !== null) this.timers.clear(timer);
        timer = null;
        pc.onicegatheringstatechange = null;
        resolve();
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      timer = this.timers.set(done, ms);
    });
  }

  private check(gen: number): void {
    if (gen !== this.gen || this.closed) throw new Stale();
  }

  private enqueue(gen: number, op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      if (gen !== this.gen || this.closed) return;
      await op();
    }).catch((e: unknown) => this.onOpError(gen, e));
    this.chain = next;
    return next;
  }

  private onOpError(gen: number, e: unknown): void {
    if (e instanceof Stale || gen !== this.gen || this.closed) return;
    this.opts.log?.('sfu step failed', e);
    if (e instanceof SfuError && (e.status === 409 || e.status === 404)) this.opts.onConflict?.();
    if (e instanceof SfuError && e.status === 429) {
      // Too many requests: the same rebuild, later, and not counted as a failure.
      if (this.rebuildTimer !== null) return;
      this.retire(true);
      this.setState('reconnecting');
      this.rebuildTimer = this.timers.set(() => {
        this.rebuildTimer = null;
        this.connect();
      }, SFU_RATE_WAIT_MS);
      return;
    }
    this.fail(gen);
  }

  private onPcState(gen: number): void {
    const pc = this.pc;
    if (gen !== this.gen || !pc || this.closed) return;
    const s = pcState(pc);
    if (s === 'connected') {
      this.clearGrace();
      const first = !this.everConnected;
      this.everConnected = true;
      this.failures = 0;
      this.setState('connected');
      if (first) {
        // what waited for the connection: pulls, and a camera or screen changed meanwhile
        void this.scheduleLocal();
        this.scheduleReconcile();
      }
    } else if (s === 'disconnected') {
      // Often a moment on a moving phone: a grace period first.
      this.setState('reconnecting');
      if (this.graceTimer === null) {
        this.graceTimer = this.timers.set(() => {
          this.graceTimer = null;
          if (gen === this.gen && this.pc && pcState(this.pc) !== 'connected') this.fail(gen);
        }, SFU_GRACE_MS);
      }
    } else if (s === 'failed') {
      this.clearGrace();
      this.opts.onFailure?.();
      this.fail(gen);
    } else if ((s === 'connecting' || s === 'new') && this.current !== 'reconnecting') {
      this.setState('connecting');
    }
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) this.timers.clear(this.graceTimer);
    this.graceTimer = null;
  }

  // A new SFU session after a pause; after the last pause the connection gives up.
  private fail(gen: number): void {
    if (gen !== this.gen || this.closed || this.rebuildTimer !== null) return;
    this.failures += 1;
    this.retire(true);
    const delay = SFU_REBUILD_MS[this.failures - 1];
    if (delay === undefined) {
      this.setState('failed');
      return;
    }
    this.setState('reconnecting');
    this.rebuildTimer = this.timers.set(() => {
      this.rebuildTimer = null;
      this.connect();
    }, delay);
  }

  // The current connection is over: everything that belonged to it goes. People stay
  // (the roster is still true); their tracks are pulled again on the next session.
  private retire(notify: boolean): void {
    this.gen += 1;
    this.clearGrace();
    if (this.lostTimer !== null) this.timers.clear(this.lostTimer);
    this.lostTimer = null;
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      try { pc.close(); } catch { /* already closed */ }
    }
    this.sfuSession = null;
    this.settingUp = false;
    this.out = { mic: null, cam: null, screen: null };
    this.byMid.clear();
    this.orphans = [];
    this.reconcileQueued = false;
    this.localQueued = null;
    this.chain = Promise.resolve();
    for (const r of this.remotes.values()) {
      for (const p of r.pulls.values()) {
        if (p.timer !== null) this.timers.clear(p.timer);
        p.timer = null;
        this.detach(p, notify);
      }
      r.pulls.clear();
    }
  }

  private setState(s: LinkState): void {
    if (this.current === s) return;
    this.current = s;
    this.opts.onState?.(s);
    for (const r of this.remotes.values()) this.report(r);
  }

  // ---------------------------------------------------------------- my session

  // The server is the authority on my SFU session. If it lists none (or another) while
  // this side has one, ask it again once, then start over.
  private checkMine(): void {
    const mine = this.mine;
    if (!mine || !this.sfuSession || this.settingUp || mine.sfuSession === this.sfuSession) {
      if (this.lostTimer !== null) this.timers.clear(this.lostTimer);
      this.lostTimer = null;
      this.lostStrikes = 0;
      return;
    }
    if (this.lostTimer !== null) return;
    const gen = this.gen;
    this.lostTimer = this.timers.set(() => {
      this.lostTimer = null;
      if (gen !== this.gen || this.closed || this.mine?.sfuSession === this.sfuSession) return;
      this.lostStrikes += 1;
      if (this.lostStrikes < 2) {
        this.opts.onConflict?.();
        this.checkMine();
        return;
      }
      this.lostStrikes = 0;
      this.restart();
    }, SFU_LOST_MS);
  }

  // ---------------------------------------------------------------- remote tracks

  private report(r: Remote): void {
    const s = this.peerState(r);
    if (r.state === s) return;
    r.state = s;
    this.opts.onPeer(r.member, s);
  }

  // A person is connected once this connection is and their microphone (if they
  // publish one) arrives; a camera or a screen still on its way does not count.
  private peerState(r: Remote): LinkState {
    const c = this.current;
    if (c === 'failed' || c === 'closed' || c === 'reconnecting') return c;
    if (!r.sfuSession) return 'connecting';
    const mic = r.published.find((n) => roleOf(n) === 'mic');
    if (mic) {
      const p = r.pulls.get(mic);
      if (!p || p.status !== 'active' || p.session !== r.sfuSession) return 'connecting';
    }
    return c === 'connected' ? 'connected' : 'connecting';
  }

  private dropRemote(sid: string): void {
    const r = this.remotes.get(sid);
    if (!r) return;
    this.remotes.delete(sid);
    if (r.drop !== null) this.timers.clear(r.drop);
    r.drop = null;
    for (const p of r.pulls.values()) {
      if (p.timer !== null) this.timers.clear(p.timer);
      p.timer = null;
      this.detach(p, true);
      if (p.mid) this.orphans.push(p);
    }
    r.pulls.clear();
    this.opts.onPeerGone(sid);
  }

  private detach(p: Pull, notify: boolean): void {
    const { track, stream } = p;
    p.track = null;
    p.stream = null;
    if (!track || !stream) return;
    if (stream.getTracks().includes(track)) {
      stream.removeTrack(track);
      try { stream.dispatchEvent(new Event('removetrack')); } catch { /* nothing listens */ }
    }
    if (notify) this.opts.onTrackGone(p.remote.member, track, stream);
  }

  private onTrack(gen: number, e: RTCTrackEvent): void {
    if (gen !== this.gen || this.closed) return;
    const mid = e.transceiver?.mid ?? null;
    const p = mid ? this.byMid.get(mid) : undefined;
    if (!p || p.mid !== mid || this.remotes.get(p.remote.member.sessionId) !== p.remote) return;
    const role = roleOf(p.name);
    if (!role) return;
    const r = p.remote;
    const stream = role === 'screen' ? (r.screen ??= this.opts.createStream()) : (r.main ??= this.opts.createStream());
    if (p.track && p.track !== e.track) this.detach(p, true);
    if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
    p.track = e.track;
    p.stream = stream;
    this.opts.onTrack(r.member, e.track, stream, role === 'screen' ? 'screen' : role === 'cam' ? 'camera' : 'audio');
  }

  private scheduleReconcile(): void {
    if (this.reconcileQueued || this.closed || !this.pc) return;
    this.reconcileQueued = true;
    const gen = this.gen;
    void this.enqueue(gen, () => {
      this.reconcileQueued = false;
      return this.reconcile(gen);
    });
  }

  // Make the pulls match what the others publish now: close the old, pull the new.
  private async reconcile(gen: number): Promise<void> {
    const pc = this.pc;
    const s = this.sfuSession;
    if (!pc || !s) return;
    const closing = this.orphans.splice(0);
    for (const r of this.remotes.values()) {
      for (const [name, p] of [...r.pulls]) {
        if (p.session === r.sfuSession && r.published.includes(name)) continue;
        r.pulls.delete(name);
        if (p.timer !== null) this.timers.clear(p.timer);
        p.timer = null;
        this.detach(p, true);
        if (p.mid) closing.push(p);
      }
    }
    if (closing.length) await this.closePulls(gen, pc, s, closing);
    // Cloudflare serves pulls on a connected session (it holds a request up to 5 s for
    // the connection, then refuses): once something was negotiated, wait for it. With
    // nothing negotiated yet (listening only), the first pull is what sets it up.
    if (pc.remoteDescription && !this.everConnected) return;
    const wanted: Pull[] = [];
    for (const r of this.remotes.values()) {
      if (!r.sfuSession) continue;
      for (const name of r.published) {
        const had = r.pulls.get(name);
        if (had && !(had.status === 'waiting' && had.due)) continue;
        const p: Pull = had ?? {
          remote: r, name, session: r.sfuSession, mid: null, status: 'pending', attempts: 0, due: false, timer: null, track: null, stream: null,
        };
        p.status = 'pending';
        p.due = false;
        p.attempts += 1;
        r.pulls.set(name, p);
        wanted.push(p);
      }
    }
    if (wanted.length) await this.pull(gen, pc, s, wanted);
    for (const r of this.remotes.values()) this.report(r);
  }

  private async pull(gen: number, pc: RTCPeerConnection, s: string, wanted: Pull[]): Promise<void> {
    let reply: SfuReply;
    try {
      reply = await this.opts.request('pull', { sfu_session: s, tracks: wanted.map((p) => ({ session: p.session, name: p.name })) });
    } catch (e) {
      this.check(gen);
      // Nothing was negotiated, so these simply wait for another try: Cloudflare busy or
      // "not connected yet" (425), the network, a rate limit. A call that changed, a gone
      // session, or too many failures in a row go up (read the call again, or start over).
      const settled = e instanceof SfuError && (e.status === 409 || e.status === 404 || e.sessionLost);
      this.pullFailures += 1;
      if (settled || this.pullFailures > SFU_PULL_FAILURES) throw e;
      for (const p of wanted) if (this.isCurrent(p)) this.wait(p);
      return;
    }
    this.check(gen);
    this.pullFailures = 0;
    const results = Array.isArray(reply.tracks) ? reply.tracks : [];
    const refused = new Set((reply.refused ?? []).map((x) => `${x.session}/${x.name}`));
    const fresh: Pull[] = [];
    let orphaned = false;
    for (const p of wanted) {
      const res = refused.has(`${p.session}/${p.name}`) ? undefined
        : results.find((t) => t.sessionId === p.session && t.trackName === p.name);
      const got = !!res && !res.errorCode && !!res.mid;
      if (!this.isCurrent(p)) {
        // Its person left (or stopped publishing it) while the request was out: what
        // Cloudflare allocated is closed with the next reconcile.
        if (got && res?.mid) {
          p.mid = res.mid;
          this.orphans.push(p);
          orphaned = true;
        }
        continue;
      }
      if (!got || !res?.mid) {
        // Not published yet as far as the server or Cloudflare can tell (the publisher is
        // still connecting): again in a moment, unless the roster drops it first.
        this.wait(p);
        continue;
      }
      p.mid = res.mid;
      this.byMid.set(res.mid, p);
      fresh.push(p);
    }
    if (reply.offer) {
      await pc.setRemoteDescription(reply.offer);   // the new tracks arrive here (ontrack)
      this.check(gen);
      const answer = await pc.createAnswer();
      this.check(gen);
      await pc.setLocalDescription(answer);
      this.check(gen);
      await this.gathered(pc);
      this.check(gen);
      await this.opts.request('renegotiate', { sfu_session: s, answer: describe(pc.localDescription, answer) });
      this.check(gen);
    }
    for (const p of fresh) {
      if (p.status !== 'pending') continue;
      p.status = 'active';
      p.attempts = 0;
    }
    if (orphaned) this.scheduleReconcile();
  }

  // Still wanted: its person is in the roster and this is still their pull of that track.
  private isCurrent(p: Pull): boolean {
    return this.remotes.get(p.remote.member.sessionId) === p.remote && p.remote.pulls.get(p.name) === p;
  }

  private wait(p: Pull): void {
    p.status = 'waiting';
    p.due = false;
    if (p.mid) this.byMid.delete(p.mid);
    p.mid = null;
    const delay = SFU_PULL_RETRY_MS[Math.min(Math.max(p.attempts, 1), SFU_PULL_RETRY_MS.length) - 1] ?? 15000;
    if (p.timer !== null) this.timers.clear(p.timer);
    p.timer = this.timers.set(() => {
      p.timer = null;
      p.due = true;
      this.scheduleReconcile();
    }, delay);
  }

  private async closePulls(gen: number, pc: RTCPeerConnection, s: string, list: Pull[]): Promise<void> {
    const mids = [...new Set(list.map((p) => p.mid).filter((m): m is string => !!m))];
    if (!mids.length) return;
    for (const mid of mids) this.byMid.delete(mid);
    const txs = pc.getTransceivers().filter((t) => t.mid !== null && mids.includes(t.mid));
    if (!txs.length) {
      await this.opts.request('close', { sfu_session: s, mids });
      this.check(gen);
      return;
    }
    for (const t of txs) {
      try { t.stop(); } catch { /* already stopped */ }
    }
    const offer = await this.localOffer(gen, pc);
    const reply = await this.opts.request('close', { sfu_session: s, mids, offer });
    this.check(gen);
    if (reply.answer) {
      await pc.setRemoteDescription(reply.answer);
      this.check(gen);
    }
  }

  // ---------------------------------------------------------------- local tracks

  private scheduleLocal(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.localQueued) return this.localQueued;
    const gen = this.gen;
    const p = this.enqueue(gen, () => {
      this.localQueued = null;
      return this.syncLocal(gen);
    });
    this.localQueued = p;
    return p;
  }

  // Make what this connection sends match what this person sends now.
  private async syncLocal(gen: number): Promise<void> {
    const pc = this.pc;
    const s = this.sfuSession;
    if (!pc || !s) return;   // the setup sends what is wanted by then
    if (pc.remoteDescription && !this.everConnected) return;   // once connected (onPcState)
    const wantMic = this.wanted('audio');
    const wantCam = this.wanted('video');
    const wantScreen = this.screen && !this.refusedTracks.has(this.screen.track) ? this.screen : null;
    const stopping: Out[] = [];
    if (this.out.cam && !wantCam) {
      stopping.push(this.out.cam);
      this.out.cam = null;
    }
    if (this.out.screen && !wantScreen) {
      stopping.push(this.out.screen);
      this.out.screen = null;
    }
    if (stopping.length) {
      for (const o of stopping) {
        try { await o.tx.sender.replaceTrack(null); } catch { /* stopping anyway */ }
        try { o.tx.stop(); } catch { /* already stopped */ }
      }
      const offer = await this.localOffer(gen, pc);
      const mids = stopping.map((o) => o.tx.mid).filter((m): m is string => !!m);
      const reply = await this.opts.request('close', { sfu_session: s, mids, offer, names: stopping.map((o) => o.name) });
      this.check(gen);
      if (reply.answer) {
        await pc.setRemoteDescription(reply.answer);
        this.check(gen);
      }
      this.opts.onCall?.(reply.call);
    }
    const adding: Out[] = [];
    if (!this.out.mic && wantMic && this.stream) adding.push(this.out.mic = this.addOut(pc, 'mic', wantMic, this.stream));
    if (!this.out.cam && wantCam && this.stream) adding.push(this.out.cam = this.addOut(pc, 'cam', wantCam, this.stream));
    if (!this.out.screen && wantScreen) adding.push(this.out.screen = this.addOut(pc, 'screen', wantScreen.track, wantScreen.stream));
    if (adding.length) {
      const offer = await this.localOffer(gen, pc);
      const reply = await this.opts.request('push', { sfu_session: s, offer, tracks: adding.map((o) => ({ mid: o.tx.mid, name: o.name })) });
      this.check(gen);
      if (!reply.answer) throw new SfuError(null, 'sfu_error', 'The media server gave no answer.');
      await pc.setRemoteDescription(reply.answer);
      this.check(gen);
      await this.dropRefused(adding, reply.tracks);
      this.opts.onCall?.(reply.call);
    }
    // The same transceiver from another source (a device changed while queued).
    const swaps: [Out | null, MediaStreamTrack | null][] = [[this.out.mic, wantMic], [this.out.cam, wantCam], [this.out.screen, wantScreen?.track ?? null]];
    for (const [o, want] of swaps) {
      if (o && want && o.track !== want) {
        await o.tx.sender.replaceTrack(want);
        o.track = want;
      }
    }
  }
}
