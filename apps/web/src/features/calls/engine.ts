// The call engine: one call at a time per tab, from the first click to the last
// track stopped (DEK21 to DEK24). The server is the single writer of call state
// (0410_calls.sql); this follows it:
//
//   start (dm, group dm): microphone first, then api.start_call (the server rings
//     the others and gives the caller a session); a call that already exists in
//     the conversation is answered instead.
//   answer: microphone, then api.answer_call with a new session id.
//   join (audio channel): microphone, then api.join_room with a new session id;
//     a reconnect with a new session updates the same participant row (DEKA13).
//   in the call: one PeerLink per other joined session (mesh.ts), signaling on
//     call:<id> through the realtime hub, call_heartbeat every 30 s, a keepalive
//     leave on pagehide. A group call the server routes through the SFU (Call.sfu:
//     rooms and direct calls of three or more, migration 0914) has one connection to
//     Cloudflare instead (sfu.ts); a 1:1 call is always direct. The call screen sees
//     the same peers either way.
//   end: leave_call, or the server says ended / declined / missed, or the session
//     moved to another device. Every way out runs teardown(): links closed, bye
//     sent, tracks stopped, the AudioContext closed.
//
// Nothing records anything. Dependencies are injected so the flows run in tests.
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Call, CallParticipant } from '../../api/types';
import { DekError } from '../../api/errors';
import type { CallSignal } from '../../realtime/types';
import {
  MediaAccessError, audioConstraints, describeMediaError, videoConstraints,
  type DeviceLists, type GetUserMedia, type MediaProblem, type OpenRequest, type Opened,
} from './devices';
import type { IceInfo, IceProvider } from './ice';
import { PeerLink, SCREEN_MAX_FPS, realTimers, type LinkSignalKind, type LinkState, type Timers } from './link';
import { CallMesh, MAX_PEERS, type Member } from './mesh';
import { SfuConnection, type RemoteRole, type SfuAction, type SfuPeer, type SfuReply } from './sfu';

export type CallStatus =
  | 'idle' | 'starting' | 'ringing' | 'connecting' | 'connected' | 'reconnecting'
  | 'ended' | 'declined' | 'unavailable';

export interface PeerView {
  sessionId: string;
  userId: string;
  state: LinkState;
  speaking: boolean;
  stream: MediaStream | null;
  video: boolean;
  // A screen this person is sharing (its own stream, no audio), or null.
  screen: MediaStream | null;
  version: number;
}

export type PendingAction = { action: 'start'; channelId: string; media: 'audio' | 'video' }
  | { action: 'answer'; callId: string; media: 'audio' | 'video' }
  | { action: 'join'; channelId: string };

export interface Problem extends MediaProblem {
  pending: PendingAction;
  canListenOnly: boolean;
}

export interface CallView {
  status: CallStatus;
  // true once the call is over for this tab (ended, declined, unavailable).
  final: boolean;
  callId: string | null;
  channelId: string | null;
  kind: 'direct' | 'room' | null;
  media: 'audio' | 'video';
  sessionId: string | null;
  call: Call | null;
  startedByMe: boolean;
  peers: Record<string, PeerView>;
  local: MediaStream | null;
  localVersion: number;
  muted: boolean;
  cameraOn: boolean;
  listenOnly: boolean;
  speakingSelf: boolean;
  relay: boolean | null;
  relayWarning: boolean;
  connectedAt: number | null;
  endTitle: string | null;
  endBody: string | null;
  notice: string | null;
  problem: Problem | null;
  busy: null | 'start' | 'answer' | 'join' | 'leave';
  devices: DeviceLists;
  inputId: string | null;
  outputId: string | null;
  cameraId: string | null;
  // This person's own shared screen, while sharing.
  sharing: boolean;
  localScreen: MediaStream | null;
}

export interface CallApi {
  startCall(channel: string, media: 'audio' | 'video'): Promise<Call>;
  answerCall(call: string, session: string): Promise<Call>;
  declineCall(call: string): Promise<Call>;
  joinRoom(channel: string, session: string): Promise<Call>;
  leaveCall(call: string): Promise<Call>;
  callHeartbeat(call: string, session: string): Promise<{ ok: boolean }>;
  getCall(call: string): Promise<Call>;
}

export interface SignalTransport {
  joinCall(callId: string): void;
  leaveCall(callId: string): void;
  sendSignal(callId: string, signal: CallSignal): void;
  onSignal(callId: string, handler: (signal: CallSignal) => void): () => void;
}

export interface Meter {
  add(id: string, stream: MediaStream): void;
  remove(id: string): void;
  stop(): void;
}

export interface EngineDeps {
  api: CallApi;
  transport: SignalTransport;
  ice: IceProvider;
  me: () => string | null;
  serverCall: (callId: string) => Call | undefined;
  watchServerCall: (callId: string, fn: (c: Call) => void) => () => void;
  activeCallInChannel: (channelId: string) => Call | undefined;
  openMedia: (req: OpenRequest) => Promise<Opened>;
  getUserMedia: GetUserMedia;
  // Missing where the browser cannot capture a screen (iOS, the app WebViews).
  getDisplayMedia?: (c: DisplayMediaStreamOptions) => Promise<MediaStream>;
  createPeerConnection: (cfg: RTCConfiguration) => RTCPeerConnection;
  newSession: () => string;
  leaveKeepalive: (callId: string) => void;
  onPageHide: (fn: () => void) => () => void;
  forceRelay: () => boolean;
  listDevices: () => Promise<DeviceLists>;
  makeMeter: (onChange: (id: string, speaking: boolean) => void) => Meter;
  notify: (title: string, body?: string) => void;
  timers?: Timers;
  log?: (message: string, error?: unknown) => void;
  // The sfu Edge Function (CONTRACT 5). Without it every call stays direct.
  sfu?: (callId: string, sessionId: string, action: SfuAction, body: Record<string, unknown>) => Promise<SfuReply>;
  // A MediaStream for the remote tracks the SFU path puts together.
  createStream?: () => MediaStream;
  // How long the SFU connection's first offer may wait for ICE candidates.
  sfuGatherMs?: number;
}

// What the call details and the end-to-end tests read about the media path: upload and
// download per connection, whichever path the call takes.
export interface TransportStats {
  path: 'mesh' | 'sfu' | null;
  connections: number;
  bytesSent: number;
  bytesReceived: number;
  outbound: { kind: string; bytesSent: number }[];
  inbound: { userId: string | null; kind: string; bytesReceived: number; trackId: string | null }[];
}

export interface PeerStat {
  sessionId: string;
  userId: string;
  connectionState: string;
  localTypes: string[];
  gathered: string[];
  turnServers: number;
  selected: { local: string | null; remote: string | null };
}

// Which kinds of local candidates a connection has, the pair it chose (host, srflx, or
// relay through TURN), and how many TURN servers it was given.
async function connectionFacts(pc: RTCPeerConnection): Promise<Pick<PeerStat, 'localTypes' | 'turnServers' | 'selected'>> {
  const localTypes = new Set<string>();
  const candidates = new Map<string, string>();
  let pairLocal: string | null = null;
  let pairRemote: string | null = null;
  let selectedPairId: string | null = null;
  try {
    const report = await pc.getStats();
    report.forEach((r: { type: string; id: string; candidateType?: string; selectedCandidatePairId?: string }) => {
      if (r.type === 'local-candidate' && r.candidateType) localTypes.add(r.candidateType);
      if ((r.type === 'local-candidate' || r.type === 'remote-candidate') && r.candidateType) candidates.set(r.id, r.candidateType);
      if (r.type === 'transport' && r.selectedCandidatePairId) selectedPairId = r.selectedCandidatePairId;
    });
    report.forEach((r: { type: string; id: string; nominated?: boolean; state?: string; localCandidateId?: string; remoteCandidateId?: string }) => {
      if (r.type !== 'candidate-pair') return;
      const chosen = selectedPairId ? r.id === selectedPairId : r.nominated && r.state === 'succeeded';
      if (chosen) {
        pairLocal = r.localCandidateId ? candidates.get(r.localCandidateId) ?? null : null;
        pairRemote = r.remoteCandidateId ? candidates.get(r.remoteCandidateId) ?? null : null;
      }
    });
  } catch {
    // stats unavailable
  }
  let turnServers = 0;
  try {
    turnServers = (pc.getConfiguration().iceServers ?? [])
      .filter((sv) => (Array.isArray(sv.urls) ? sv.urls : [sv.urls]).some((u) => /^turns?:/.test(u))).length;
  } catch {
    // configuration unavailable
  }
  return { localTypes: [...localTypes], turnServers, selected: { local: pairLocal, remote: pairRemote } };
}

export const HEARTBEAT_MS = 30_000;
export const RING_TIMEOUT_MS = 45_000;
export const FINAL_DISMISS_MS = 6000;
const REFRESH_DEBOUNCE_MS = 300;
const REJOIN_COOLDOWN_MS = 60_000;
const AUTO_REBUILD_MS = 4000;

const EMPTY_DEVICES: DeviceLists = { audioinput: [], audiooutput: [], videoinput: [] };

export function initialView(): CallView {
  return {
    status: 'idle', final: false, callId: null, channelId: null, kind: null, media: 'audio', sessionId: null, call: null,
    startedByMe: false, peers: {}, local: null, localVersion: 0, muted: false, cameraOn: false, listenOnly: false,
    speakingSelf: false, relay: null, relayWarning: false, connectedAt: null, endTitle: null, endBody: null, notice: null,
    problem: null, busy: null, devices: EMPTY_DEVICES, inputId: null, outputId: null, cameraId: null,
    sharing: false, localScreen: null,
  };
}

const LIVE: ReadonlySet<CallStatus> = new Set(['starting', 'ringing', 'connecting', 'connected', 'reconnecting']);

function participant(call: Call | null, userId: string | null): CallParticipant | undefined {
  if (!call || !userId) return undefined;
  return call.participants.find((p) => p.user_id === userId);
}

function joinedMembers(call: Call, me: string | null): Member[] {
  const seen = new Set<string>();
  const out: Member[] = [];
  for (const p of call.participants) {
    if (p.state !== 'joined' || !p.session_id || p.user_id === me || seen.has(p.user_id)) continue;
    seen.add(p.user_id);
    out.push({ userId: p.user_id, sessionId: p.session_id });
  }
  return out;
}

// The same people with what each publishes through the SFU.
function sfuPeers(call: Call, me: string | null): SfuPeer[] {
  const seen = new Set<string>();
  const out: SfuPeer[] = [];
  for (const p of call.participants) {
    if (p.state !== 'joined' || !p.session_id || p.user_id === me || seen.has(p.user_id)) continue;
    seen.add(p.user_id);
    out.push({ userId: p.user_id, sessionId: p.session_id, sfuSession: p.sfu_session ?? null, tracks: p.sfu_tracks ?? [] });
    if (out.length >= MAX_PEERS) break;
  }
  return out;
}

function isCall(v: unknown): v is Call {
  return !!v && typeof v === 'object' && typeof (v as Call).id === 'string' && Array.isArray((v as Call).participants);
}

// Since 0914 every call.upd carries a version; an older copy (another topic, a slow
// RPC answer) never replaces a newer one.
function isOlder(incoming: Call, current: Call | null): boolean {
  return !!current && current.id === incoming.id && typeof incoming.version === 'number'
    && typeof current.version === 'number' && incoming.version < current.version;
}

function errorSentence(e: unknown, fallback: string): string {
  if (e instanceof DekError) return e.hint.replace(/^p_[a-z_]+:\s*/i, '');
  return fallback;
}

// The server turns a ninth person away from any call with conflict 'This call is
// full (8 people).' (rooms said 'This room is full (8 people). ...' first).
export function isCallFull(e: unknown): boolean {
  return e instanceof DekError && e.code === 'conflict' && /\bfull\b/i.test(e.hint);
}

interface Ending {
  status: CallStatus;
  title: string;
  body: string | null;
}

// What a refused join or answer tells the person. A full call shows the
// server's own sentence as the title.
export function joinRefusal(e: unknown, kind: 'direct' | 'room'): Ending {
  if (isCallFull(e)) {
    const sentence = errorSentence(e, 'This call is full (8 people).');
    const [first, ...rest] = sentence.split(/(?<=\.)\s+/);
    return { status: 'unavailable', title: first ?? sentence, body: rest.join(' ') || 'Try again when someone leaves.' };
  }
  if (e instanceof DekError && (e.code === 'conflict' || e.code === 'not_found')) {
    return { status: 'ended', title: 'This call has ended', body: e.code === 'conflict' ? errorSentence(e, '') || null : 'It ended before you could join.' };
  }
  return {
    status: 'unavailable',
    title: kind === 'room' ? 'Could not join the room' : 'Could not join the call',
    body: errorSentence(e, 'Check the connection and try again.'),
  };
}

export class CallEngine {
  readonly store: StoreApi<CallView>;
  private readonly deps: EngineDeps;
  private readonly timers: Timers;
  private gen = 0;
  private callId: string | null = null;
  private sessionId: string | null = null;
  private channelId: string | null = null;
  private kind: 'direct' | 'room' | null = null;
  private media: 'audio' | 'video' = 'audio';
  private call: Call | null = null;
  private local: MediaStream | null = null;
  private mesh: CallMesh | null = null;
  private sfu: SfuConnection | null = null;
  private meter: Meter | null = null;
  private ice: IceInfo | null = null;
  private unsubs: (() => void)[] = [];
  private heartbeat: unknown = null;
  private ringTimer: unknown = null;
  private refreshTimer: unknown = null;
  private dismissTimer: unknown = null;
  private beats = 0;
  private lastRejoin = 0;
  private screen: { stream: MediaStream; track: MediaStreamTrack } | null = null;
  private pickingScreen = false;
  private readonly watchedTracks = new WeakSet<MediaStreamTrack>();
  private readonly watchedStreams = new WeakSet<MediaStream>();
  private readonly remoteStreams = new WeakMap<MediaStreamTrack, MediaStream>();
  // What a remote track is, when the path knows (the SFU path always does).
  private readonly trackRoles = new WeakMap<MediaStreamTrack, RemoteRole>();
  private declined = new Set<string>();

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
    this.store = createStore<CallView>(() => initialView());
  }

  get view(): CallView {
    return this.store.getState();
  }

  private set(p: Partial<CallView>): void {
    this.store.setState(p);
  }

  isLive(): boolean {
    return LIVE.has(this.view.status);
  }

  isInCall(callId: string): boolean {
    return this.callId === callId && this.isLive();
  }

  wasDeclinedHere(callId: string): boolean {
    return this.declined.has(callId);
  }

  // ---------------------------------------------------------------- actions

  async startDirect(channelId: string, media: 'audio' | 'video' = 'audio'): Promise<void> {
    if (this.isLive()) {
      if (this.channelId !== channelId) this.deps.notify('You are already in a call', 'Leave it before starting another.');
      return;
    }
    // A call already going on in this conversation (a group call, or this person
    // on another device): join it rather than start a second one.
    const existing = this.deps.activeCallInChannel(channelId);
    if (existing && !existing.ended_at) {
      await this.answer(existing.id);
      return;
    }
    const gen = this.begin({ channelId, kind: 'direct', media, busy: 'start' });
    const ice = this.deps.ice.get();
    if (!(await this.acquire(media, { action: 'start', channelId, media }, gen))) return;
    let call: Call;
    try {
      call = await this.deps.api.startCall(channelId, media);
    } catch (e) {
      if (gen !== this.gen) return;
      this.finish('unavailable', 'The call could not start', errorSentence(e, 'Check the connection and try again.'));
      return;
    }
    if (gen !== this.gen) {
      this.deps.api.leaveCall(call.id).catch(() => undefined);
      return;
    }
    const uid = this.deps.me();
    const mine = participant(call, uid);
    let session = mine?.state === 'joined' && call.started_by === uid ? mine.session_id : null;
    if (!session || call.ended_at) {
      // Someone else's call in this conversation (both pressed call at once): answer it.
      session = this.deps.newSession();
      try {
        call = await this.deps.api.answerCall(call.id, session);
      } catch (e) {
        if (gen !== this.gen) return;
        const r = joinRefusal(e, 'direct');
        this.finish(r.status, r.title, r.body);
        return;
      }
      if (gen !== this.gen) {
        // ended while the answer was in flight: do not stay joined on the server
        this.deps.api.leaveCall(call.id).catch(() => undefined);
        return;
      }
    }
    await this.enter(call, session, await ice, gen);
  }

  async answer(callId: string, opts: { listenOnly?: boolean } = {}): Promise<void> {
    if (this.isLive()) {
      if (this.callId === callId) return;
      await this.leave();
    }
    let call = this.deps.serverCall(callId);
    if (!call) {
      try {
        call = await this.deps.api.getCall(callId);
      } catch (e) {
        this.finish('ended', 'This call has ended', errorSentence(e, ''));
        return;
      }
    }
    const media = call.media;
    const gen = this.begin({ channelId: call.channel_id, kind: call.kind, media, busy: 'answer' });
    const ice = this.deps.ice.get();
    if (!opts.listenOnly && !(await this.acquire(media, { action: 'answer', callId, media }, gen))) return;
    if (opts.listenOnly) this.set({ listenOnly: true });
    const session = this.deps.newSession();
    let answered: Call;
    try {
      answered = call.kind === 'room'
        ? await this.deps.api.joinRoom(call.channel_id, session)
        : await this.deps.api.answerCall(callId, session);
    } catch (e) {
      if (gen !== this.gen) return;
      const r = joinRefusal(e, call.kind);
      this.finish(r.status, r.title, r.body);
      return;
    }
    if (gen !== this.gen) {
      // Accept then End while the answer was in flight: leave, or the server keeps this
      // person joined (a stuck "connecting" for the caller, a lost room seat) for 90 s.
      this.deps.api.leaveCall(answered.id).catch(() => undefined);
      return;
    }
    await this.enter(answered, session, await ice, gen);
  }

  async decline(callId: string): Promise<void> {
    this.declined.add(callId);
    try {
      await this.deps.api.declineCall(callId);
    } catch {
      // already over for this person
    }
  }

  async joinRoom(channelId: string, opts: { listenOnly?: boolean } = {}): Promise<void> {
    if (this.isLive()) {
      if (this.channelId === channelId) return;
      await this.leave();
    }
    const gen = this.begin({ channelId, kind: 'room', media: 'audio', busy: 'join' });
    const ice = this.deps.ice.get();
    if (!opts.listenOnly && !(await this.acquire('audio', { action: 'join', channelId }, gen))) return;
    if (opts.listenOnly) this.set({ listenOnly: true });
    const session = this.deps.newSession();
    let call: Call;
    try {
      call = await this.deps.api.joinRoom(channelId, session);
    } catch (e) {
      if (gen !== this.gen) return;
      const r = joinRefusal(e, 'room');
      this.finish(r.status, r.title, r.body);
      return;
    }
    if (gen !== this.gen) {
      this.deps.api.leaveCall(call.id).catch(() => undefined);
      return;
    }
    await this.enter(call, session, await ice, gen);
  }

  async leave(): Promise<void> {
    const callId = this.callId;
    if (!callId) {
      // Still asking for the microphone: just stop.
      if (this.isLive()) this.reset();
      return;
    }
    this.set({ busy: 'leave' });
    const wasRinging = this.view.status === 'ringing';
    this.teardown(true);
    let final: Call | null = null;
    try {
      final = await this.deps.api.leaveCall(callId);
    } catch {
      final = null;
    }
    const title = this.kind === 'room' ? 'You left the room' : wasRinging ? 'Call cancelled' : 'Call ended';
    this.showFinal('ended', title, final ? this.durationLine(final) : null, final);
  }

  // The dialog after a refused microphone: try again, or join without one.
  async retryProblem(listenOnly = false): Promise<void> {
    const p = this.view.problem;
    if (!p) return;
    this.set({ problem: null });
    const pending = p.pending;
    if (pending.action === 'start') await this.startDirect(pending.channelId, pending.media);
    else if (pending.action === 'answer') await this.answer(pending.callId, { listenOnly });
    else await this.joinRoom(pending.channelId, { listenOnly });
  }

  dismissProblem(): void {
    this.set({ problem: null });
  }

  dismissFinal(): void {
    if (this.view.final) this.reset();
  }

  toggleMute(): void {
    if (!this.local) return;
    const muted = !this.view.muted;
    for (const t of this.local.getAudioTracks()) t.enabled = !muted;
    this.set({ muted });
  }

  async toggleCamera(): Promise<void> {
    if (!this.isLive() || this.media !== 'video') return;
    const stream = this.local ?? new MediaStream();
    const track = stream.getVideoTracks()[0];
    if (track && track.readyState === 'live') {
      // Off means off: the camera is released, so its light goes out.
      track.stop();
      stream.removeTrack(track);
      await this.replaceEverywhere('video', null, stream);
      this.set({ cameraOn: false, localVersion: this.view.localVersion + 1 });
      return;
    }
    try {
      const s = await this.deps.getUserMedia({ video: videoConstraints(this.view.cameraId), audio: false });
      const t = s.getVideoTracks()[0];
      if (!t || !this.isLive()) {
        s.getTracks().forEach((x) => x.stop());
        return;
      }
      stream.addTrack(t);
      this.local = stream;
      await this.replaceEverywhere('video', t, stream);
      this.set({ cameraOn: true, local: stream, localVersion: this.view.localVersion + 1, notice: null });
    } catch (e) {
      const p = describeMediaError(e, 'camera');
      this.set({ notice: `${p.title}. ${p.steps[0] ?? p.body}` });
    }
  }

  async setInput(deviceId: string): Promise<void> {
    if (!this.local || this.view.listenOnly) {
      this.set({ inputId: deviceId });
      return;
    }
    try {
      const s = await this.deps.getUserMedia({ audio: audioConstraints(deviceId), video: false });
      const t = s.getAudioTracks()[0];
      if (!t || !this.local) {
        // the call ended while the device was opening: release it, or the microphone
        // stays on with the recording indicator showing
        s.getTracks().forEach((x) => x.stop());
        return;
      }
      t.enabled = !this.view.muted;
      const old = this.local.getAudioTracks()[0];
      if (old) {
        this.local.removeTrack(old);
        old.stop();
      }
      this.local.addTrack(t);
      await this.replaceEverywhere('audio', t, this.local);
      this.meter?.add('self', this.local);
      this.set({ inputId: deviceId, localVersion: this.view.localVersion + 1 });
    } catch (e) {
      const p = describeMediaError(e, 'microphone');
      this.set({ notice: `${p.title}. ${p.body}` });
    }
  }

  // Share this person's screen with everyone in the call (DEK21; restored from the
  // legacy rooms). Called straight from the click: the browser shows its picker
  // only inside the gesture, so nothing is awaited before getDisplayMedia.
  async startScreenShare(): Promise<void> {
    if (!this.isLive() || this.screen || this.pickingScreen) return;
    const getDisplayMedia = this.deps.getDisplayMedia;
    if (!getDisplayMedia) return;
    const gen = this.gen;
    this.pickingScreen = true;
    let stream: MediaStream;
    try {
      stream = await getDisplayMedia({ video: { frameRate: { ideal: SCREEN_MAX_FPS, max: SCREEN_MAX_FPS } }, audio: false });
    } catch (e) {
      this.pickingScreen = false;
      const name = (e as { name?: string } | null)?.name;
      // Closing the picker is the common way out, not an error worth a word.
      if (name !== 'NotAllowedError' && name !== 'AbortError' && gen === this.gen) {
        this.set({ notice: 'Your screen could not be shared. Try again, or allow this browser to record the screen in your system settings.' });
      }
      return;
    }
    this.pickingScreen = false;
    const track = stream.getVideoTracks()[0];
    if (!track || gen !== this.gen || !this.isLive() || this.screen) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    try {
      track.contentHint = 'detail';   // text stays sharp; frame rate gives way
    } catch {
      // older browsers
    }
    // The browser's own "Stop sharing" bar ends the track (only this share's).
    track.addEventListener('ended', () => {
      if (this.screen?.track === track) void this.stopScreenShare();
    });
    this.screen = { stream, track };
    this.set({ sharing: true, localScreen: stream, notice: null });
    for (const { link } of this.mesh?.sessions() ?? []) {
      try {
        await link.shareScreen(track, stream);
      } catch (e) {
        this.deps.log?.('share screen failed', e);
      }
    }
    if (this.sfu) await this.sfu.shareScreen(track, stream);
  }

  // Stop sharing: Stop pressed, the browser's own bar, or the track ending.
  async stopScreenShare(): Promise<void> {
    const s = this.screen;
    if (!s) return;
    this.screen = null;
    this.set({ sharing: false, localScreen: null });
    for (const t of s.stream.getTracks()) t.stop();
    for (const { link } of this.mesh?.sessions() ?? []) {
      try {
        await link.stopScreen();
      } catch (e) {
        this.deps.log?.('stop screen failed', e);
      }
    }
    if (this.sfu) await this.sfu.stopScreen();
  }

  async setCamera(deviceId: string): Promise<void> {
    this.set({ cameraId: deviceId });
    if (!this.view.cameraOn) return;
    const old = this.local?.getVideoTracks()[0];
    if (old) {
      old.stop();
      this.local?.removeTrack(old);
    }
    this.set({ cameraOn: false });
    await this.toggleCamera();
  }

  setOutput(deviceId: string): void {
    this.set({ outputId: deviceId });
  }

  async refreshDevices(): Promise<void> {
    const devices = await this.deps.listDevices();
    this.set({ devices });
  }

  // "Try again" after links gave up.
  reconnect(): void {
    if (this.sfu) {
      this.sfu.reconnect();
      this.set({ relayWarning: false });
      this.updateStatus();
      return;
    }
    if (!this.mesh) return;
    for (const s of this.mesh.sessions()) if (s.link.state === 'failed') this.mesh.rebuild(s.sessionId);
    this.set({ relayWarning: false });
    this.updateStatus();
  }

  // Per-peer transport facts: used by the call screen's details and by tests to
  // prove which path a call took (host, srflx, or relay through TURN).
  // On the SFU path there is one connection: every person reports it, with their own
  // state (connected once their microphone arrives).
  async stats(): Promise<PeerStat[]> {
    if (this.sfu) {
      const pc = this.sfu.connection;
      const facts = pc ? await connectionFacts(pc) : { localTypes: [], turnServers: 0, selected: { local: null, remote: null } };
      return this.sfu.members().map(({ sessionId, userId }) => ({
        sessionId, userId, connectionState: this.view.peers[sessionId]?.state ?? 'new', gathered: facts.localTypes, ...facts,
      }));
    }
    if (!this.mesh) return [];
    const out: PeerStat[] = [];
    for (const { sessionId, userId, link } of this.mesh.sessions()) {
      const facts = await connectionFacts(link.pc);
      out.push({ sessionId, userId, connectionState: link.pc.connectionState, gathered: [...link.gathered], ...facts });
    }
    return out;
  }

  // Bytes up and down on every connection of this call (getStats outbound-rtp and
  // inbound-rtp): what the mesh and the SFU cost each person.
  async transportStats(): Promise<TransportStats> {
    const out: TransportStats = { path: this.sfu ? 'sfu' : this.mesh ? 'mesh' : null, connections: 0, bytesSent: 0, bytesReceived: 0, outbound: [], inbound: [] };
    const conns: { pc: RTCPeerConnection; userId: string | null }[] = this.sfu
      ? (this.sfu.connection ? [{ pc: this.sfu.connection, userId: null }] : [])
      : (this.mesh?.sessions() ?? []).map(({ link, userId }) => ({ pc: link.pc, userId }));
    for (const { pc, userId } of conns) {
      out.connections += 1;
      try {
        const report = await pc.getStats();
        report.forEach((r: { type: string; kind?: string; mediaType?: string; bytesSent?: number; bytesReceived?: number; trackIdentifier?: string }) => {
          const kind = r.kind ?? r.mediaType ?? 'unknown';
          if (r.type === 'outbound-rtp') {
            out.outbound.push({ kind, bytesSent: r.bytesSent ?? 0 });
            out.bytesSent += r.bytesSent ?? 0;
          } else if (r.type === 'inbound-rtp') {
            const trackId = r.trackIdentifier ?? null;
            const owner = userId ?? (trackId ? this.sfu?.ownerOf(trackId)?.userId ?? null : null);
            out.inbound.push({ userId: owner, kind, bytesReceived: r.bytesReceived ?? 0, trackId });
            out.bytesReceived += r.bytesReceived ?? 0;
          }
        });
      } catch {
        // stats unavailable
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- lifecycle

  private begin(p: { channelId: string; kind: 'direct' | 'room'; media: 'audio' | 'video'; busy: CallView['busy'] }): number {
    if (this.dismissTimer !== null) this.timers.clear(this.dismissTimer);
    this.dismissTimer = null;
    this.gen += 1;
    // A new call starts from nothing: the last call (perhaps ended by the far side)
    // must not stand in for this one.
    this.call = null;
    this.channelId = p.channelId;
    this.kind = p.kind;
    this.media = p.media;
    this.set({
      ...initialView(),
      devices: this.view.devices, inputId: this.view.inputId, outputId: this.view.outputId, cameraId: this.view.cameraId,
      status: 'starting', channelId: p.channelId, kind: p.kind, media: p.media, busy: p.busy,
    });
    return this.gen;
  }

  private async acquire(media: 'audio' | 'video', pending: PendingAction, gen: number): Promise<boolean> {
    try {
      const opened = await this.deps.openMedia({ audio: true, video: media === 'video', audioDevice: this.view.inputId, videoDevice: this.view.cameraId });
      if (gen !== this.gen) {
        opened.stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.local = opened.stream;
      const cameraOn = opened.stream.getVideoTracks().length > 0;
      this.set({
        local: opened.stream, localVersion: this.view.localVersion + 1, muted: false, cameraOn,
        notice: opened.cameraProblem ? `${opened.cameraProblem.title}. The call goes ahead with audio only.` : null,
      });
      void this.refreshDevices();
      return true;
    } catch (e) {
      if (gen !== this.gen) return false;
      const problem = e instanceof MediaAccessError ? e.problem : describeMediaError(e, 'microphone');
      this.reset();
      this.set({ problem: { ...problem, pending, canListenOnly: pending.action !== 'start' } });
      return false;
    }
  }

  private async enter(call: Call, session: string, ice: IceInfo, gen: number): Promise<void> {
    if (gen !== this.gen) return;
    const uid = this.deps.me();
    this.callId = call.id;
    this.sessionId = session;
    this.channelId = call.channel_id;
    this.kind = call.kind;
    this.media = call.media;
    this.ice = ice;
    this.meter = this.deps.makeMeter((id, speaking) => this.onSpeaking(id, speaking));
    if (this.local) this.meter.add('self', this.local);
    if (this.wantsSfu(call)) this.sfu = this.createSfu(call.id, session);
    else this.mesh = this.createMesh(call.id, session, uid);
    this.deps.transport.joinCall(call.id);
    this.unsubs.push(this.deps.transport.onSignal(call.id, (sig) => this.onSignal(sig)));
    this.unsubs.push(this.deps.watchServerCall(call.id, (c) => this.applyCall(c)));
    this.unsubs.push(this.deps.onPageHide(() => this.onPageHide()));
    this.set({
      callId: call.id, sessionId: session, channelId: call.channel_id, kind: call.kind, media: call.media,
      startedByMe: call.started_by === uid, relay: ice.relay, busy: null, status: 'connecting',
    });
    this.heartbeat = this.timers.set(() => this.beat(), HEARTBEAT_MS);
    if (call.kind === 'direct' && call.started_by === uid) {
      this.ringTimer = this.timers.set(() => {
        if (this.view.status === 'ringing') void this.leave();
      }, RING_TIMEOUT_MS);
    }
    this.mesh?.announce({ media: call.media });
    this.sfu?.start(this.localMedia());
    // Which view of the call is newest. Events can beat the RPC answer here (the
    // far side declined while start_call was still on its way back): an event
    // saying the call ended always wins, since an ended call never comes back; one
    // that already shows this session joined is at least as new as the answer;
    // otherwise the answer is the newest there is. Applied last, so an ending
    // tears down the timers armed above.
    const seen = this.deps.serverCall(call.id);
    const mineInSeen = participant(seen ?? null, uid);
    const start = seen && (seen.ended_at || (mineInSeen?.state === 'joined' && mineInSeen.session_id === session)) ? seen : call;
    this.applyCall(start);
  }

  // ---------------------------------------------------------------- paths

  private wantsSfu(call: Call): boolean {
    return call.sfu === true && !!this.deps.sfu;
  }

  private createMesh(callId: string, session: string, uid: string | null): CallMesh {
    return new CallMesh({
      localUser: uid ?? '',
      localSession: session,
      maxPeers: MAX_PEERS,
      timers: this.timers,
      send: (sig) => this.deps.transport.sendSignal(callId, sig),
      createLink: (member, polite, send) => this.createLink(member, polite, send),
      onUnknownSession: () => this.scheduleRefresh(),
      onChange: () => this.syncPeers(),
    });
  }

  private createSfu(callId: string, session: string): SfuConnection {
    const request = this.deps.sfu;
    return new SfuConnection({
      request: (action, body) => (request ? request(callId, session, action, body) : Promise.reject(new Error('no sfu'))),
      createPeerConnection: (cfg) => this.deps.createPeerConnection(cfg),
      config: () => this.freshConfig() ?? { iceServers: [], iceTransportPolicy: this.deps.forceRelay() ? 'relay' : 'all', bundlePolicy: 'max-bundle' },
      createStream: this.deps.createStream ?? (() => new MediaStream()),
      timers: this.timers,
      ...(this.deps.sfuGatherMs !== undefined ? { gatherMs: this.deps.sfuGatherMs } : {}),
      ...(this.deps.log ? { log: this.deps.log } : {}),
      onPeer: (member, state) => this.onSfuPeer(member, state),
      onPeerGone: (sessionId) => this.dropPeer(sessionId),
      onTrack: (member, track, stream, role) => this.onRemoteTrack(member, track, stream, role),
      onTrackGone: (member, track) => this.refreshRemote(member.sessionId, track),
      onState: () => this.updateStatus(),
      onFailure: () => this.onFailure(),
      onConflict: () => this.scheduleRefresh(),
      onCall: (c) => {
        if (isCall(c)) this.applyCall(c);
      },
    });
  }

  private localMedia(): { stream: MediaStream | null; listenOnly: boolean; screen: { track: MediaStreamTrack; stream: MediaStream } | null } {
    return {
      stream: this.view.listenOnly ? null : this.local,
      listenOnly: this.view.listenOnly,
      screen: this.screen ? { track: this.screen.track, stream: this.screen.stream } : null,
    };
  }

  // The server moved the call between the mesh and the SFU (the switch, sfu_enabled,
  // changed while it was going on): everyone in it moves at the same call.upd.
  private ensurePath(call: Call): void {
    const sfu = this.wantsSfu(call);
    const callId = this.callId;
    const session = this.sessionId;
    if (sfu === (this.sfu !== null) || !callId || !session) return;
    this.mesh?.close(true);
    this.mesh = null;
    this.sfu?.close();
    this.sfu = null;
    this.dropAllPeers();
    if (sfu) {
      this.sfu = this.createSfu(callId, session);
      this.sfu.start(this.localMedia());
    } else {
      this.mesh = this.createMesh(callId, session, this.deps.me());
      this.mesh.announce({ media: this.media });
    }
  }

  private onSignal(sig: CallSignal): void {
    if (this.mesh) {
      this.mesh.handle(sig);
      return;
    }
    // Nobody signals on the SFU path: a hello is someone on the mesh. Read the call
    // again, in case the server moved it there.
    if (this.sfu && sig && sig.kind === 'hello' && sig.from_session && sig.from_session !== this.sessionId) this.scheduleRefresh();
  }

  private onSfuPeer(member: Member, state: LinkState): void {
    const prev = this.view.peers[member.sessionId];
    if (!prev) {
      this.patchPeer(member.sessionId, { sessionId: member.sessionId, userId: member.userId, state, speaking: false, stream: null, video: false, screen: null });
    } else if (prev.state !== state) {
      this.patchPeer(member.sessionId, { state });
    }
    if (state === 'connected' && !this.view.connectedAt) this.set({ connectedAt: Date.now() });
    this.updateStatus();
  }

  private dropPeer(sessionId: string): void {
    if (!this.view.peers[sessionId]) return;
    const peers = { ...this.view.peers };
    delete peers[sessionId];
    this.meter?.remove(sessionId);
    this.set({ peers });
    this.updateStatus();
  }

  private dropAllPeers(): void {
    for (const id of Object.keys(this.view.peers)) this.meter?.remove(id);
    this.set({ peers: {} });
  }

  private createLink(member: Member, polite: boolean, send: (kind: LinkSignalKind, data: unknown) => void): PeerLink {
    const cfg: RTCConfiguration = {
      iceServers: this.ice?.iceServers ?? [],
      iceTransportPolicy: this.deps.forceRelay() ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    };
    const pc = this.deps.createPeerConnection(cfg);
    const link = new PeerLink({
      pc,
      polite,
      send,
      timers: this.timers,
      log: this.deps.log,
      freshConfig: () => this.freshConfig(),
      onTrack: (track, stream) => this.onRemoteTrack(member, track, stream),
      onState: (state) => this.onLinkState(member.sessionId, state),
      onFailure: () => this.onFailure(),
      onGiveUp: () => this.onGiveUp(member.sessionId),
    });
    link.attach(this.view.listenOnly ? null : this.local, this.media === 'video');
    // Someone joining while this person shares sees the screen too.
    if (this.screen) void link.shareScreen(this.screen.track, this.screen.stream).catch((e) => this.deps.log?.('share to a new peer failed', e));
    this.patchPeer(member.sessionId, {
      sessionId: member.sessionId, userId: member.userId, state: 'connecting', speaking: false, stream: null, video: false, screen: null,
    });
    return link;
  }

  private freshConfig(): RTCConfiguration | null {
    const cached = this.deps.ice.peek();
    if (cached) this.ice = cached;
    else void this.deps.ice.get().then((i) => { this.ice = i; });
    return this.ice ? { iceServers: this.ice.iceServers, iceTransportPolicy: this.deps.forceRelay() ? 'relay' : 'all', bundlePolicy: 'max-bundle' } : null;
  }

  private applyCall(call: Call): void {
    if (!this.callId || call.id !== this.callId) return;
    // an ended call never comes back (this call: a previous call's end says nothing)
    if (this.call?.id === call.id && this.call.ended_at && !call.ended_at) return;
    if (isOlder(call, this.call)) return;
    this.call = call;
    this.set({ call });
    if (call.ended_at) {
      this.onEnded(call);
      return;
    }
    const uid = this.deps.me();
    const me = participant(call, uid);
    if (!me) {
      this.endHere('ended', 'You are no longer in this call', null);
      return;
    }
    if (me.state === 'joined' && me.session_id && me.session_id !== this.sessionId) {
      this.endHere('ended', 'The call moved to another device', 'You joined it somewhere else, so it ended here.');
      return;
    }
    if (me.state === 'left') {
      void this.rejoin();
      return;
    }
    if (me.state === 'declined' || me.state === 'missed') {
      this.endHere('ended', 'Call ended', null);
      return;
    }
    if (me.state === 'ringing') return;   // an event from before this tab answered
    this.ensurePath(call);
    if (this.sfu) this.sfu.setRoster(sfuPeers(call, uid), { sfuSession: me.sfu_session ?? null });
    else this.mesh?.setRoster(joinedMembers(call, uid));
    this.updateStatus();
  }

  private onEnded(call: Call): void {
    const uid = this.deps.me();
    const startedByMe = call.started_by === uid;
    const reason = call.end_reason ?? 'completed';
    if (call.kind === 'direct' && startedByMe && reason === 'declined') {
      this.endHere('declined', 'Call declined', 'They could not take the call. Send a message instead.');
    } else if (call.kind === 'direct' && startedByMe && reason === 'missed') {
      this.endHere('unavailable', 'No answer', 'Nobody picked up. Try again later or send a message.');
    } else {
      this.endHere('ended', call.kind === 'room' ? 'The room closed' : 'Call ended', this.durationLine(call));
    }
  }

  private durationLine(call: Call): string | null {
    const connected = this.view.connectedAt;
    if (!connected) return null;
    const end = call.ended_at ? Date.parse(call.ended_at) : Date.now();
    const secs = Math.max(0, Math.round((Math.min(end, Date.now()) - connected) / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m ? `${m} min ${s} s` : `${s} s`;
  }

  // The server ended it (or moved it): nothing to tell the far side.
  private endHere(status: CallStatus, title: string, body: string | null): void {
    const call = this.call;
    this.teardown(false);
    this.showFinal(status, title, body, call);
  }

  private finish(status: CallStatus, title: string, body: string | null): void {
    this.teardown(false);
    this.showFinal(status, title, body, this.call);
  }

  private showFinal(status: CallStatus, title: string, body: string | null, call: Call | null): void {
    this.set({
      status, final: true, endTitle: title, endBody: body, busy: null, peers: {}, local: null,
      speakingSelf: false, call, problem: this.view.problem, sharing: false, localScreen: null,
    });
    if (this.dismissTimer !== null) this.timers.clear(this.dismissTimer);
    this.dismissTimer = this.timers.set(() => {
      this.dismissTimer = null;
      if (this.view.final) this.reset();
    }, FINAL_DISMISS_MS);
  }

  private reset(): void {
    this.teardown(false);
    const keep = { devices: this.view.devices, inputId: this.view.inputId, outputId: this.view.outputId, cameraId: this.view.cameraId, problem: this.view.problem };
    this.store.setState({ ...initialView(), ...keep }, true);
  }

  // Every way out ends here: idempotent.
  private teardown(sayBye: boolean): void {
    this.gen += 1;
    for (const t of [this.heartbeat, this.ringTimer, this.refreshTimer]) if (t !== null) this.timers.clear(t);
    this.heartbeat = null;
    this.ringTimer = null;
    this.refreshTimer = null;
    for (const u of this.unsubs.splice(0)) {
      try { u(); } catch { /* best effort */ }
    }
    this.mesh?.close(sayBye);
    this.mesh = null;
    // The SFU connection closes with nothing left sending or receiving; leave_call
    // (or the reaper) clears this person's tracks for everyone else.
    this.sfu?.close();
    this.sfu = null;
    if (this.callId) this.deps.transport.leaveCall(this.callId);
    for (const t of this.local?.getTracks() ?? []) t.stop();
    this.local = null;
    // A shared screen ends with the call: no capture left running, and the
    // browser's "sharing your screen" bar goes away.
    for (const t of this.screen?.stream.getTracks() ?? []) t.stop();
    this.screen = null;
    this.meter?.stop();
    this.meter = null;
    this.callId = null;
    this.sessionId = null;
  }

  private onPageHide(): void {
    const callId = this.callId;
    if (!callId) return;
    this.teardown(true);
    this.deps.leaveKeepalive(callId);
  }

  private beat(): void {
    this.heartbeat = null;
    const callId = this.callId;
    const session = this.sessionId;
    if (!callId || !session) return;
    const gen = this.gen;
    // On the SFU path only call.upd says who publishes what (the mesh also hears
    // hellos): read the call every other beat, in case an event never arrived.
    this.beats += 1;
    if (this.sfu && this.beats % 2 === 0) this.refresh();
    this.deps.api.callHeartbeat(callId, session).then(() => undefined, (e: unknown) => {
      if (gen !== this.gen) return;
      if (e instanceof DekError && (e.code === 'conflict' || e.code === 'not_found')) this.refresh();
    }).finally(() => {
      if (gen === this.gen && this.callId === callId) this.heartbeat = this.timers.set(() => this.beat(), HEARTBEAT_MS);
    });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null || !this.callId) return;
    this.refreshTimer = this.timers.set(() => {
      this.refreshTimer = null;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private refresh(): void {
    const callId = this.callId;
    if (!callId) return;
    const gen = this.gen;
    this.deps.api.getCall(callId).then((c) => {
      if (gen === this.gen) this.applyCall(c);
    }, (e: unknown) => {
      if (gen === this.gen && e instanceof DekError && e.code === 'not_found') this.endHere('ended', 'Call ended', null);
    });
  }

  // The server stopped counting this session (90 s without a heartbeat, e.g. a
  // laptop lid). Same session, same participant row: no duplicate (DEKA13).
  private async rejoin(): Promise<void> {
    const callId = this.callId;
    const session = this.sessionId;
    const channel = this.channelId;
    if (!callId || !session || !channel) return;
    const now = Date.now();
    if (now - this.lastRejoin < REJOIN_COOLDOWN_MS) {
      this.endHere('ended', 'You were disconnected', 'The connection dropped for too long. Join again when you are back online.');
      return;
    }
    this.lastRejoin = now;
    const gen = this.gen;
    try {
      const c = this.kind === 'room' ? await this.deps.api.joinRoom(channel, session) : await this.deps.api.answerCall(callId, session);
      if (gen !== this.gen) return;
      // Realtime decided what this person may send on call:<id> when the topic was
      // joined, and the session was "left" for a while since: join it again now
      // that the server lists it as joined, so sending is allowed for certain.
      this.deps.transport.leaveCall(callId);
      this.deps.transport.joinCall(callId);
      this.applyCall(c);
      this.mesh?.announce({ media: this.media });
      // The server cleared this person's SFU tracks when it stopped counting them:
      // publish again on a new SFU session.
      this.sfu?.restart();
    } catch {
      if (gen === this.gen) this.endHere('ended', 'You were disconnected', 'Join again when you are back online.');
    }
  }

  // ---------------------------------------------------------------- peers

  private patchPeer(sessionId: string, p: Partial<PeerView>): void {
    const peers = this.view.peers;
    const prev = peers[sessionId];
    if (!prev && !p.userId) return;
    const base: PeerView = prev ?? { sessionId, userId: p.userId ?? '', state: 'new', speaking: false, stream: null, video: false, screen: null, version: 0 };
    this.set({ peers: { ...peers, [sessionId]: { ...base, ...p, version: base.version + 1 } } });
  }

  private syncPeers(): void {
    if (!this.mesh) return;
    const live = new Set(this.mesh.sessions().map((s) => s.sessionId));
    const peers = { ...this.view.peers };
    let changed = false;
    for (const id of Object.keys(peers)) {
      if (!live.has(id)) {
        delete peers[id];
        this.meter?.remove(id);
        changed = true;
      }
    }
    if (changed) this.set({ peers });
    this.updateStatus();
  }

  // A camera always travels in the same stream as that person's microphone (one
  // local stream, link.attach); a shared screen comes in a stream of its own with
  // no audio (link.shareScreen). So a video track whose stream has no audio is a
  // shared screen, in a video call as much as in an audio room. The SFU path says
  // what each track is (role), so nothing is guessed there.
  private onRemoteTrack(member: Member, track: MediaStreamTrack, stream: MediaStream, role?: RemoteRole): void {
    // A track comes back through ontrack each time a share restarts, possibly in
    // a new stream object: listeners go on once, and always read the latest stream.
    this.remoteStreams.set(track, stream);
    if (role) this.trackRoles.set(track, role);
    const refresh = () => this.refreshRemote(member.sessionId, track);
    if (!this.watchedTracks.has(track)) {
      this.watchedTracks.add(track);
      track.addEventListener('mute', refresh);
      track.addEventListener('unmute', refresh);
      track.addEventListener('ended', refresh);
    }
    if (!this.watchedStreams.has(stream)) {
      this.watchedStreams.add(stream);
      stream.addEventListener('removetrack', refresh);
      stream.addEventListener('addtrack', refresh);
    }
    if (track.kind === 'audio') this.meter?.add(member.sessionId, stream);
    refresh();
  }

  private refreshRemote(sessionId: string, track: MediaStreamTrack): void {
    const stream = this.remoteStreams.get(track);
    const known = this.mesh ? !!this.mesh.link(sessionId) : !!this.sfu?.has(sessionId);
    if (!stream || !known) return;
    const live = (t: MediaStreamTrack) => t.readyState === 'live' && !t.muted;
    const role = this.trackRoles.get(track);
    if (role ? role === 'screen' : track.kind === 'video' && stream.getAudioTracks().length === 0) {
      // Ended, muted, or taken out of its stream (the sharer stopped and the
      // renegotiation removed it): no screen any more.
      const showing = live(track) && stream.getVideoTracks().includes(track);
      const now = this.view.peers[sessionId]?.screen ?? null;
      if (showing && now !== stream) this.patchPeer(sessionId, { screen: stream });
      else if (!showing && now !== null && (now === stream || !now.getVideoTracks().some(live))) this.patchPeer(sessionId, { screen: null });
      return;
    }
    this.patchPeer(sessionId, { stream, video: stream.getVideoTracks().some(live) });
  }

  private onLinkState(sessionId: string, state: LinkState): void {
    if (!this.mesh?.link(sessionId)) return;
    this.patchPeer(sessionId, { state });
    if (state === 'connected' && !this.view.connectedAt) this.set({ connectedAt: Date.now() });
    this.updateStatus();
  }

  // Without a relay, restrictive networks (carrier NAT, office firewalls) cannot
  // connect at all: say so instead of "connecting" forever.
  private onFailure(): void {
    if (this.ice && !this.ice.relay && !this.view.relayWarning) this.set({ relayWarning: true });
  }

  private onGiveUp(sessionId: string): void {
    this.onFailure();
    this.updateStatus();
    const gen = this.gen;
    this.timers.set(() => {
      if (gen === this.gen && this.mesh?.link(sessionId)?.state === 'failed') this.mesh.rebuild(sessionId);
    }, AUTO_REBUILD_MS);
  }

  private onSpeaking(id: string, speaking: boolean): void {
    if (id === 'self') {
      if (this.view.speakingSelf !== speaking) this.set({ speakingSelf: speaking });
      return;
    }
    if (this.view.peers[id]) this.patchPeer(id, { speaking });
  }

  private async replaceEverywhere(kind: 'audio' | 'video', track: MediaStreamTrack | null, stream: MediaStream): Promise<void> {
    for (const { link } of this.mesh?.sessions() ?? []) {
      try {
        await link.replaceTrack(kind, track, stream);
      } catch (e) {
        this.deps.log?.('replaceTrack failed', e);
      }
    }
    if (this.sfu) {
      try {
        await this.sfu.replaceTrack(kind, track, stream);
      } catch (e) {
        this.deps.log?.('replaceTrack failed', e);
      }
    }
  }

  private updateStatus(): void {
    if (!this.call || this.view.final) return;
    const uid = this.deps.me();
    const others = this.call.participants.filter((p) => p.user_id !== uid);
    const joined = others.filter((p) => p.state === 'joined');
    const ringing = others.some((p) => p.state === 'ringing');
    const states = Object.values(this.view.peers).map((p) => p.state);
    let status: CallStatus;
    if (this.call.kind === 'direct' && joined.length === 0) status = ringing ? 'ringing' : 'connecting';
    else if (states.includes('connected')) status = 'connected';
    else if (states.includes('reconnecting')) status = 'reconnecting';
    else if (states.length > 0 && states.every((s) => s === 'failed')) status = 'unavailable';
    else if (this.call.kind === 'room' && joined.length === 0) status = 'connected';
    else status = 'connecting';
    if (status === 'connected' && !this.view.connectedAt) this.set({ connectedAt: Date.now() });
    if (status !== 'ringing' && this.ringTimer !== null) {
      this.timers.clear(this.ringTimer);
      this.ringTimer = null;
    }
    if (status !== this.view.status) this.set({ status });
  }
}
