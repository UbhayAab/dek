// The SFU path of the call engine (sfu.ts, migration 0914): group calls the server
// routes through Cloudflare (Call.sfu) use one connection per person, push their own
// tracks once and pull everyone else's; 1:1 calls stay direct. The fake below plays the
// sfu Edge Function, Cloudflare and the database's record of who publishes what.
import { describe, expect, test, vi } from 'vitest';
import { DekError } from '../../src/api/errors';
import type { Call, CallParticipant } from '../../src/api/types';
import { MediaAccessError, describeMediaError } from '../../src/features/calls/devices';
import { CallEngine, HEARTBEAT_MS, type CallApi, type EngineDeps } from '../../src/features/calls/engine';
import { IceProvider } from '../../src/features/calls/ice';
import {
  SFU_DROP_GRACE_MS, SFU_GRACE_MS, SFU_LOST_MS, SFU_PULL_FAILURES, SFU_PULL_RETRY_MS, SFU_REBUILD_MS, SfuError, type SfuAction, type SfuReply,
} from '../../src/features/calls/sfu';
import type { CallSignal } from '../../src/realtime/types';
import { FakePC, ManualTimers, fakeStream, fakeTrack, flush, type FakeTransceiver } from './fakeRtc';

const T0 = '2026-10-05T10:00:00.000Z';
const settle = () => flush(400);

type Part = CallParticipant & { sfu_session?: string | null; sfu_tracks?: string[] };
const J = (user_id: string, session_id: string, sfu_session: string | null = null, sfu_tracks: string[] = []): Part =>
  ({ user_id, state: 'joined', session_id, joined_at: T0, sfu_session, sfu_tracks });
const R = (user_id: string): Part => ({ user_id, state: 'ringing', session_id: null, joined_at: null, sfu_session: null, sfu_tracks: [] });

function room(participants: Part[], over: Partial<Call> = {}): Call {
  return {
    id: 'room-1', org_id: 'org-1', channel_id: 'huddle', kind: 'room', media: 'audio', started_by: 'ravi',
    created_at: T0, ended_at: null, end_reason: null, sfu: true, version: 1, participants, ...over,
  };
}

interface Req { action: SfuAction; body: Record<string, unknown>; callId: string; sessionId: string }

// The function, Cloudflare and the database in one: sessions are numbered, pulled
// tracks get mids r1, r2, ...; what alice publishes is recorded on the call (a new
// version each time), the way svc_sfu_publish does.
class FakeSfu {
  readonly requests: Req[] = [];
  sessions = 0;
  private mids = 0;
  readonly pullErrors = new Map<string, string>();
  // Pushed track names Cloudflare does not take (an errorCode in its answer).
  readonly pushErrors = new Set<string>();
  // One refusal, or a list used up one request at a time.
  refuse: Partial<Record<SfuAction, SfuError | SfuError[]>> = {};
  hold: Partial<Record<SfuAction, Promise<void>>> = {};
  constructor(private readonly server: Record<string, Call>, private readonly me = 'alice') {}

  actions(): string[] {
    return this.requests.map((r) => r.action);
  }

  last(action: SfuAction): Req | undefined {
    return [...this.requests].reverse().find((r) => r.action === action);
  }

  private publish(callId: string, sfu: string | null, change: { add?: string[]; remove?: string[]; fresh?: boolean }): Call | undefined {
    const c = this.server[callId];
    if (!c) return undefined;
    const participants = c.participants.map((p) => {
      if (p.user_id !== this.me) return p;
      const base = change.fresh ? [] : (p.sfu_tracks ?? []);
      const tracks = [...new Set([...base, ...(change.add ?? [])])].filter((n) => !(change.remove ?? []).includes(n)).sort();
      return { ...p, sfu_session: sfu, sfu_tracks: tracks };
    });
    const next = { ...c, participants, version: (c.version ?? 0) + 1 };
    this.server[callId] = next;
    return next;
  }

  handle = async (callId: string, sessionId: string, action: SfuAction, body: Record<string, unknown>): Promise<SfuReply> => {
    this.requests.push({ action, body, callId, sessionId });
    const held = this.hold[action];
    if (held) await held;
    const refusal = this.refuse[action];
    if (refusal) {
      const one = Array.isArray(refusal) ? refusal.shift() : refusal;
      if (!Array.isArray(refusal) || refusal.length === 0) delete this.refuse[action];
      if (one) throw one;
    }
    const tracks = (body.tracks ?? []) as { mid?: string; name?: string; session?: string }[];
    const pushed = tracks.map((t) => (this.pushErrors.has(t.name as string)
      ? { mid: t.mid as string, trackName: t.name as string, errorCode: 'invalid_params' }
      : { mid: t.mid as string, trackName: t.name as string }));
    const taken = pushed.filter((t) => !('errorCode' in t)).map((t) => t.trackName);
    if (action === 'session') {
      this.sessions += 1;
      const s = `cf-${this.me}-${this.sessions}`;
      return {
        sfu_session: s, answer: body.offer ? { type: 'answer', sdp: `answer-from-${s}` } : null,
        tracks: pushed, call: this.publish(callId, s, { add: taken, fresh: true }),
      };
    }
    if (action === 'push') {
      return {
        answer: { type: 'answer', sdp: 'answer-push' }, tracks: pushed,
        call: this.publish(callId, body.sfu_session as string, { add: taken }),
      };
    }
    if (action === 'close') {
      const names = (body.names ?? []) as string[];
      return {
        answer: body.offer ? { type: 'answer', sdp: 'answer-close' } : null,
        tracks: ((body.mids ?? []) as string[]).map((mid) => ({ mid })),
        call: names.length ? this.publish(callId, body.sfu_session as string, { remove: names }) : undefined,
      };
    }
    if (action === 'pull') {
      const results = tracks.map((t) => {
        const key = `${t.session}/${t.name}`;
        const err = this.pullErrors.get(key);
        if (err) {
          this.pullErrors.delete(key);
          return { sessionId: t.session as string, trackName: t.name as string, errorCode: err };
        }
        this.mids += 1;
        return { mid: `r${this.mids}`, sessionId: t.session as string, trackName: t.name as string };
      });
      const ok = results.filter((r) => 'mid' in r && r.mid);
      const kind = (name: string) => (name.startsWith('mic-') ? 'audio' : 'video');
      return {
        offer: ok.length ? { type: 'offer', sdp: `sfu-offer ${ok.map((r) => `mid:${(r as { mid: string }).mid}:${kind(r.trackName)}`).join(' ')}` } : null,
        renegotiate: ok.length > 0, tracks: results, refused: [],
      };
    }
    return {};
  };
}

function setup(over: { api?: Partial<CallApi>; openMedia?: EngineDeps['openMedia']; getUserMedia?: EngineDeps['getUserMedia']; display?: EngineDeps['getDisplayMedia'] } = {}) {
  const timers = new ManualTimers();
  const pcs: FakePC[] = [];
  const sent: CallSignal[] = [];
  const handlers = new Map<string, (s: CallSignal) => void>();
  const watchers = new Map<string, (c: Call) => void>();
  const server: Record<string, Call> = {};
  const meter = { added: [] as string[], removed: [] as string[], add(id: string) { this.added.push(id); }, remove(id: string) { this.removed.push(id); }, stop() { /* noop */ } };
  const stopped: string[] = [];
  const mic = fakeTrack('audio', 'mic');
  const micStop = mic.stop.bind(mic);
  (mic as unknown as { stop: () => void }).stop = () => { stopped.push('mic'); micStop(); };
  const sfu = new FakeSfu(server);
  let sessions = 0;
  const withMe = (c: Call, s: string): Call => ({
    ...c, version: (c.version ?? 0) + 1,
    participants: [...c.participants.filter((p) => p.user_id !== 'alice'), J('alice', s)],
  });
  const api: CallApi = {
    startCall: vi.fn(async () => server['grp-call'] as Call),
    answerCall: vi.fn(async (id: string, s: string) => { server[id] = withMe(server[id] as Call, s); return server[id] as Call; }),
    declineCall: vi.fn(async (id: string) => server[id] as Call),
    joinRoom: vi.fn(async (_channel: string, s: string) => { server['room-1'] = withMe(server['room-1'] as Call, s); return server['room-1'] as Call; }),
    leaveCall: vi.fn(async (id: string) => ({ ...(server[id] as Call), ended_at: T0, end_reason: 'completed' })),
    callHeartbeat: vi.fn(async () => ({ ok: true })),
    getCall: vi.fn(async (id: string) => server[id] as Call),
    ...over.api,
  };
  const engine = new CallEngine({
    api,
    transport: {
      joinCall: () => undefined,
      leaveCall: () => undefined,
      sendSignal: (_id, s) => sent.push(s),
      onSignal: (id, h) => { handlers.set(id, h); return () => handlers.delete(id); },
    },
    ice: new IceProvider(async () => ({ iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }], relay: true })),
    me: () => 'alice',
    serverCall: (id) => server[id],
    watchServerCall: (id, fn) => { watchers.set(id, fn); return () => watchers.delete(id); },
    activeCallInChannel: () => undefined,
    openMedia: over.openMedia ?? (async () => ({ stream: fakeStream(mic), cameraProblem: null })),
    getUserMedia: over.getUserMedia ?? (async () => fakeStream(fakeTrack('audio', 'mic2'))),
    getDisplayMedia: over.display ?? (async () => fakeStream(fakeTrack('video', 'screen'))),
    createPeerConnection: (cfg) => {
      const pc = new FakePC(`pc${pcs.length}`, cfg);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    newSession: () => `my-sess-${++sessions}`,
    leaveKeepalive: () => undefined,
    onPageHide: () => () => undefined,
    forceRelay: () => false,
    listDevices: async () => ({ audioinput: [], audiooutput: [], videoinput: [] }),
    makeMeter: () => meter,
    notify: () => undefined,
    timers,
    sfu: sfu.handle,
    createStream: () => fakeStream(),
    sfuGatherMs: 0,
  });
  // A call.upd: the store has it, the engine hears it.
  const emit = (c: Call) => { server[c.id] = c; watchers.get(c.id)?.(c); };
  const pc = () => pcs[pcs.length - 1] as FakePC;
  const tx = (p: FakePC, mid: string) => p.getTransceivers().find((x) => x.mid === mid) as FakeTransceiver | undefined;
  return { engine, api, timers, pcs, pc, tx, sent, handlers, watchers, server, meter, stopped, sfu, emit, mic };
}

// ravi publishes his microphone; bob his microphone and camera.
const othersInRoom = (version = 3) => room([J('ravi', 'ravi-sess', 'cf-ravi-1', ['mic-1']), J('bob', 'bob-sess', 'cf-bob-01', ['cam-1', 'mic-1'])], { version });

// This side's connection to the SFU comes up (Cloudflare serves pulls on a connected session).
async function online(t: ReturnType<typeof setup>) {
  t.pc().setConnection('connected');
  await settle();
}

async function inRoom() {
  const t = setup();
  t.server['room-1'] = othersInRoom();
  await t.engine.joinRoom('huddle');
  await settle();
  await online(t);
  return t;
}

describe('the SFU path (0914)', () => {
  test('a room through the SFU: one connection, the microphone sent once, everyone else pulled and heard', async () => {
    const t = setup();
    t.server['room-1'] = othersInRoom();
    await t.engine.joinRoom('huddle');
    await settle();
    expect(t.pcs).toHaveLength(1);   // one connection, however many people
    expect(t.sent).toHaveLength(0);  // no mesh signaling
    expect(t.sfu.actions()).toEqual(['session']);   // pulls wait for this side's connection
    expect(t.engine.view.status).toBe('connecting');
    expect(t.engine.view.peers['ravi-sess']?.state).toBe('connecting');
    await online(t);
    expect(t.sfu.actions()).toEqual(['session', 'pull', 'renegotiate']);
    const session = t.sfu.requests[0]!;
    expect(session.callId).toBe('room-1');
    expect(session.sessionId).toBe('my-sess-1');
    expect(session.body.tracks).toEqual([{ mid: '0', name: 'mic-1' }]);
    expect((session.body.offer as RTCSessionDescriptionInit).type).toBe('offer');
    const micTx = t.tx(t.pc(), '0')!;
    expect(micTx.direction).toBe('sendonly');
    expect(micTx.sender.track).toBe(t.mic);
    expect(t.pc().log).toContain('SRD:answer:answer-from-cf-alice-1');

    const pull = t.sfu.last('pull')!;
    expect(pull.body.sfu_session).toBe('cf-alice-1');
    expect(pull.body.tracks).toEqual(expect.arrayContaining([
      { session: 'cf-ravi-1', name: 'mic-1' }, { session: 'cf-bob-01', name: 'mic-1' }, { session: 'cf-bob-01', name: 'cam-1' },
    ]));
    expect((pull.body.tracks as unknown[]).length).toBe(3);
    expect((t.sfu.last('renegotiate')!.body.answer as RTCSessionDescriptionInit).type).toBe('answer');

    // each person's microphone (and bob's camera) arrives in their own stream
    const ravi = t.engine.view.peers['ravi-sess']!;
    const bob = t.engine.view.peers['bob-sess']!;
    expect(ravi.stream?.getAudioTracks()).toHaveLength(1);
    expect(bob.stream?.getAudioTracks()).toHaveLength(1);
    expect(bob.stream?.getVideoTracks()).toHaveLength(1);
    expect(bob.video).toBe(true);
    expect(bob.screen).toBeNull();
    expect(t.meter.added).toEqual(expect.arrayContaining(['self', 'ravi-sess', 'bob-sess']));

    expect(t.engine.view.peers['ravi-sess']?.state).toBe('connected');
    expect(t.engine.view.status).toBe('connected');
    const stats = await t.engine.stats();
    expect(stats.map((s) => [s.userId, s.connectionState]).sort()).toEqual([['bob', 'connected'], ['ravi', 'connected']]);
  });

  test('1:1 calls never take the SFU path, even if the server said so by mistake', async () => {
    const t = setup();
    t.server['dm-call'] = { ...room([J('bob', 'bob-sess'), R('alice')]), id: 'dm-call', kind: 'direct', channel_id: 'dm-1', started_by: 'bob', sfu: false };
    await t.engine.answer('dm-call');
    await settle();
    expect(t.sfu.requests).toHaveLength(0);
    expect(t.sent.some((s) => s.kind === 'hello')).toBe(true);   // the mesh
  });

  test('joins and leaves: a newcomer is pulled, someone who left has their tracks closed (stop, offer, close)', async () => {
    const t = await inRoom();
    t.pc().setConnection('connected');
    const base = t.server['room-1']!;
    t.emit({ ...base, version: (base.version ?? 0) + 1, participants: [...base.participants, J('carol', 'carol-sess', 'cf-carol-1', ['mic-1'])] });
    await settle();
    expect(t.sfu.last('pull')!.body.tracks).toEqual([{ session: 'cf-carol-1', name: 'mic-1' }]);
    expect(t.engine.view.peers['carol-sess']?.stream?.getAudioTracks()).toHaveLength(1);

    // ravi leaves: gone from the next version; closed after the drop grace
    const raviMid = t.pc().getTransceivers().find((x) => x.receiver.track && t.engine.view.peers['ravi-sess']?.stream?.getTracks().includes(x.receiver.track))?.mid;
    expect(raviMid).toBeTruthy();
    const now = t.server['room-1']!;
    t.emit({ ...now, version: (now.version ?? 0) + 1, participants: now.participants.filter((p) => p.user_id !== 'ravi') });
    await settle();
    expect(t.sfu.last('close')).toBeUndefined();
    t.timers.advance(SFU_DROP_GRACE_MS);
    await settle();
    const close = t.sfu.last('close')!;
    expect(close.body.mids).toEqual([raviMid]);
    expect((close.body.offer as RTCSessionDescriptionInit).type).toBe('offer');
    expect(t.engine.view.peers['ravi-sess']).toBeUndefined();
    expect(t.meter.removed).toContain('ravi-sess');
    expect(t.tx(t.pc(), raviMid as string)).toBeUndefined();   // stopped and gone after the answer
    expect(t.pc().signalingState).toBe('stable');
  });

  test('a track Cloudflare cannot serve yet (the publisher is still connecting) is pulled again with backoff', async () => {
    const t = setup();
    t.server['room-1'] = othersInRoom();
    t.sfu.pullErrors.set('cf-ravi-1/mic-1', 'not_found_track_error');
    await t.engine.joinRoom('huddle');
    await settle();
    await online(t);
    expect(t.engine.view.peers['ravi-sess']?.state).toBe('connecting');
    expect(t.engine.view.peers['bob-sess']?.state).toBe('connected');
    const pulls = () => t.sfu.requests.filter((r) => r.action === 'pull').length;
    expect(pulls()).toBe(1);
    t.timers.advance((SFU_PULL_RETRY_MS[0] as number) - 1);
    await settle();
    expect(pulls()).toBe(1);
    t.timers.advance(1);
    await settle();
    expect(pulls()).toBe(2);
    expect(t.sfu.last('pull')!.body.tracks).toEqual([{ session: 'cf-ravi-1', name: 'mic-1' }]);
    expect(t.engine.view.peers['ravi-sess']?.state).toBe('connected');
    expect(t.engine.view.peers['ravi-sess']?.stream?.getAudioTracks()).toHaveLength(1);
  });

  test('Cloudflare\'s offer is answered (renegotiate) before the next change starts: one exchange at a time', async () => {
    const t = setup();
    t.server['room-1'] = othersInRoom();
    let release!: () => void;
    t.sfu.hold.renegotiate = new Promise<void>((r) => { release = r; });
    await t.engine.joinRoom('huddle');
    await settle();
    await online(t);
    expect(t.sfu.actions()).toEqual(['session', 'pull', 'renegotiate']);
    // carol joins while the answer is still on its way: nothing else starts meanwhile
    const base = t.server['room-1']!;
    t.emit({ ...base, version: (base.version ?? 0) + 1, participants: [...base.participants, J('carol', 'carol-sess', 'cf-carol-1', ['mic-1'])] });
    await settle();
    expect(t.sfu.actions()).toEqual(['session', 'pull', 'renegotiate']);
    delete t.sfu.hold.renegotiate;
    release();
    await settle();
    expect(t.sfu.actions()).toEqual(['session', 'pull', 'renegotiate', 'pull', 'renegotiate']);
    expect(t.pc().signalingState).toBe('stable');
  });

  test('camera off closes it for everyone, on pushes a new one; a device change is a replaceTrack', async () => {
    const cam = fakeTrack('video', 'cam');
    const cam2 = fakeTrack('video', 'cam2');
    const t = setup({
      openMedia: async () => ({ stream: fakeStream(fakeTrack('audio', 'mic'), cam), cameraProblem: null }),
      getUserMedia: async (c) => (c.video ? fakeStream(cam2) : fakeStream(fakeTrack('audio', 'mic2'))),
    });
    t.server['grp-call'] = { ...room([J('alice', 'srv-sess'), R('bob'), R('ravi')]), id: 'grp-call', kind: 'direct', media: 'video', channel_id: 'grp-1', started_by: 'alice' };
    await t.engine.startDirect('grp-1', 'video');
    await settle();
    expect(t.engine.view.status).toBe('ringing');
    expect(t.sfu.requests[0]?.body.tracks).toEqual([{ mid: '0', name: 'mic-1' }, { mid: '1', name: 'cam-2' }]);
    expect(t.server['grp-call']?.participants.find((p) => p.user_id === 'alice')?.sfu_tracks).toEqual(['cam-2', 'mic-1']);

    await t.engine.toggleCamera();   // off, before the connection is up: done once it is
    await settle();
    expect(t.sfu.last('close')).toBeUndefined();
    await online(t);
    const off = t.sfu.last('close')!;
    expect(off.body).toMatchObject({ mids: ['1'], names: ['cam-2'], sfu_session: 'cf-alice-1' });
    expect(cam.readyState).toBe('ended');
    expect(t.engine.view.cameraOn).toBe(false);

    await t.engine.toggleCamera();   // on: a new camera track, a new name
    await settle();
    const on = t.sfu.last('push')!;
    expect(on.body.tracks).toEqual([{ mid: '2', name: 'cam-3' }]);
    expect(t.tx(t.pc(), '2')?.sender.track).toBe(cam2);
    expect(t.server['grp-call']?.participants.find((p) => p.user_id === 'alice')?.sfu_tracks).toEqual(['cam-3', 'mic-1']);

    // a new microphone: the same SFU track, no negotiation
    const before = t.sfu.requests.length;
    await t.engine.setInput('other-mic');
    await settle();
    expect(t.sfu.requests.length).toBe(before);
    expect(t.tx(t.pc(), '0')?.sender.track?.id).toBe('mic2');
  });

  test('screen sharing pushes the screen as its own track and Stop closes it; nothing keeps running after leaving', async () => {
    const screen = fakeTrack('video', 'screen');
    const t = setup({ display: async () => fakeStream(screen) });
    t.server['room-1'] = othersInRoom();
    await t.engine.joinRoom('huddle');
    await settle();
    await online(t);
    await t.engine.startScreenShare();
    await settle();
    const push = t.sfu.last('push')!;
    expect(push.body.tracks).toEqual([{ mid: '1', name: 'screen-2' }]);
    const screenTx = t.tx(t.pc(), '1')!;
    expect(screenTx.sender.track).toBe(screen);
    expect(screenTx.init?.sendEncodings?.[0]?.maxBitrate).toBeGreaterThan(0);
    await t.engine.stopScreenShare();
    await settle();
    expect(t.sfu.last('close')!.body).toMatchObject({ mids: ['1'], names: ['screen-2'] });
    expect(screen.readyState).toBe('ended');

    await t.engine.startScreenShare();
    await settle();
    expect(t.sfu.last('push')!.body.tracks).toEqual([{ mid: '2', name: 'screen-3' }]);
    const pc = t.pc();
    await t.engine.leave();
    expect(pc.closed).toBe(true);
    expect(t.stopped).toContain('mic');
    const after = t.sfu.requests.length;
    t.timers.advance(60_000);
    await settle();
    expect(t.sfu.requests.length).toBe(after);   // no retry, no rebuild: nothing left running
    expect(t.engine.view.peers).toEqual({});
  });

  test('receiving a shared screen: its own stream, shown as a screen; closed, it is gone', async () => {
    const t = await inRoom();
    t.pc().setConnection('connected');
    const base = t.server['room-1']!;
    const withScreen = base.participants.map((p) => (p.user_id === 'ravi' ? { ...p, sfu_tracks: ['mic-1', 'screen-4'] } : p));
    t.emit({ ...base, version: (base.version ?? 0) + 1, participants: withScreen });
    await settle();
    const ravi = t.engine.view.peers['ravi-sess']!;
    expect(ravi.screen?.getVideoTracks()).toHaveLength(1);
    expect(ravi.screen?.getAudioTracks()).toHaveLength(0);
    expect(ravi.stream?.getVideoTracks()).toHaveLength(0);
    expect(ravi.video).toBe(false);
    const now = t.server['room-1']!;
    t.emit({ ...now, version: (now.version ?? 0) + 1, participants: base.participants });
    await settle();
    expect(t.engine.view.peers['ravi-sess']?.screen).toBeNull();
    expect(t.sfu.last('close')).toBeTruthy();
  });

  test('a camera that arrives before the microphone is still a camera (roles, not guesses)', async () => {
    const t = setup();
    t.server['room-1'] = room([J('bob', 'bob-sess', 'cf-bob-01', ['cam-1', 'mic-1'])], { version: 3 });
    t.sfu.pullErrors.set('cf-bob-01/mic-1', 'empty_track_error');
    await t.engine.joinRoom('huddle');
    await settle();
    await online(t);
    const bob = t.engine.view.peers['bob-sess']!;
    expect(bob.stream?.getVideoTracks()).toHaveLength(1);
    expect(bob.stream?.getAudioTracks()).toHaveLength(0);
    expect(bob.video).toBe(true);
    expect(bob.screen).toBeNull();
  });

  test('a failed connection is rebuilt on a new SFU session; after the last try it gives up; Try again starts over', async () => {
    const t = await inRoom();
    const first = t.pc();
    first.setConnection('connected');
    first.setConnection('failed');
    expect(first.closed).toBe(true);
    expect(t.engine.view.peers['ravi-sess']?.state).toBe('reconnecting');
    expect(t.engine.view.peers['ravi-sess']?.stream?.getTracks()).toHaveLength(0);   // the old tracks went with it
    t.timers.advance(SFU_REBUILD_MS[0]);
    await settle();
    expect(t.pcs).toHaveLength(2);
    expect(t.sfu.actions().filter((a) => a === 'session')).toHaveLength(2);
    await online(t);
    expect(t.sfu.last('pull')!.body.sfu_session).toBe('cf-alice-2');
    expect(t.engine.view.peers['ravi-sess']?.stream?.getAudioTracks()).toHaveLength(1);

    // from here it never connects again: one try after each pause, then it says so
    for (const ms of SFU_REBUILD_MS) {
      t.pc().setConnection('failed');
      t.timers.advance(ms);
      await settle();
    }
    expect(t.pcs).toHaveLength(6);
    t.pc().setConnection('failed');
    await settle();
    expect(t.engine.view.status).toBe('unavailable');
    expect(t.engine.view.peers['ravi-sess']?.state).toBe('failed');
    t.timers.advance(60_000);
    await settle();
    expect(t.pcs).toHaveLength(6);

    t.engine.reconnect();
    await settle();
    expect(t.pcs).toHaveLength(7);
    await online(t);
    expect(t.engine.view.status).toBe('connected');
  });

  test('a moment of "disconnected" gets a grace period before anything is rebuilt', async () => {
    const t = await inRoom();
    t.pc().setConnection('connected');
    t.pc().setConnection('disconnected');
    expect(t.engine.view.status).toBe('reconnecting');
    t.timers.advance(SFU_GRACE_MS - 1);
    t.pc().setConnection('connected');
    t.timers.advance(SFU_GRACE_MS * 3);
    await settle();
    expect(t.pcs).toHaveLength(1);
    expect(t.engine.view.status).toBe('connected');

    t.pc().setConnection('disconnected');
    t.timers.advance(SFU_GRACE_MS);
    await settle();
    expect(t.pcs[0]?.closed).toBe(true);
    t.timers.advance(SFU_REBUILD_MS[0]);
    await settle();
    expect(t.pcs).toHaveLength(2);
  });

  test('an error from the function rebuilds; a call that changed underneath is read again', async () => {
    const t = setup();
    t.server['room-1'] = othersInRoom();
    t.sfu.refuse.pull = new SfuError(502, 'sfu_error', 'session gone', 410);
    await t.engine.joinRoom('huddle');
    await settle();
    await online(t);
    expect(t.pcs[0]?.closed).toBe(true);
    t.timers.advance(SFU_REBUILD_MS[0]);
    await settle();
    await online(t);
    expect(t.sfu.actions()).toEqual(['session', 'pull', 'session', 'pull', 'renegotiate']);

    t.sfu.refuse.pull = new SfuError(409, 'conflict', 'You are no longer in this call.');
    const base = t.server['room-1']!;
    t.emit({ ...base, version: (base.version ?? 0) + 1, participants: [...base.participants, J('carol', 'carol-sess', 'cf-carol-1', ['mic-1'])] });
    await settle();
    t.timers.advance(400);
    await settle();
    expect(t.api.getCall).toHaveBeenCalledWith('room-1');
  });

  test('Cloudflare saying "not connected yet" (425) to a pull is a wait, not a rebuild', async () => {
    const t = setup();
    t.server['room-1'] = othersInRoom();
    t.sfu.refuse.pull = new SfuError(502, 'sfu_error', 'wait for the connection', 425);
    await t.engine.joinRoom('huddle');
    await settle();
    await online(t);
    expect(t.pcs).toHaveLength(1);
    expect(t.pcs[0]?.closed).toBe(false);
    t.timers.advance(SFU_PULL_RETRY_MS[0] as number);
    await settle();
    expect(t.sfu.actions()).toEqual(['session', 'pull', 'pull', 'renegotiate']);
    expect(t.engine.view.peers['ravi-sess']?.state).toBe('connected');
  });

  test('Cloudflare busy on a pull (5xx, 429) waits and tries again; only failures in a row start over', async () => {
    const busy = () => new SfuError(502, 'sfu_error', 'busy', 500, 'internal_error');
    const t = setup();
    t.server['room-1'] = othersInRoom();
    t.sfu.refuse.pull = [busy()];
    await t.engine.joinRoom('huddle');
    await settle();
    await online(t);
    expect(t.pcs).toHaveLength(1);
    t.timers.advance(SFU_PULL_RETRY_MS[0] as number);
    await settle();
    expect(t.pcs).toHaveLength(1);
    expect(t.engine.view.peers['ravi-sess']?.state).toBe('connected');

    const u = setup();
    u.server['room-1'] = othersInRoom();
    u.sfu.refuse.pull = Array.from({ length: SFU_PULL_FAILURES + 1 }, busy);
    await u.engine.joinRoom('huddle');
    await settle();
    await online(u);
    for (const ms of SFU_PULL_RETRY_MS) {
      u.timers.advance(ms);
      await settle();
    }
    expect(u.pcs[0]?.closed).toBe(true);   // the sixth in a row: a new session
    u.timers.advance(SFU_REBUILD_MS[0]);
    await settle();
    await online(u);
    expect(u.pcs).toHaveLength(2);
    expect(u.engine.view.peers['bob-sess']?.state).toBe('connected');
  });

  test('a pull still on its way when its person leaves is closed once it lands (no subscription left behind)', async () => {
    const t = setup();
    t.server['room-1'] = othersInRoom();
    let release!: () => void;
    t.sfu.hold.pull = new Promise<void>((r) => { release = r; });
    await t.engine.joinRoom('huddle');
    await settle();
    await online(t);
    expect(t.sfu.actions()).toEqual(['session', 'pull']);
    const base = t.server['room-1']!;
    t.emit({ ...base, version: (base.version ?? 0) + 1, participants: base.participants.filter((p) => p.user_id !== 'ravi') });
    t.timers.advance(SFU_DROP_GRACE_MS);
    await settle();
    expect(t.engine.view.peers['ravi-sess']).toBeUndefined();
    delete t.sfu.hold.pull;
    release();
    await settle();
    expect(t.sfu.actions()).toEqual(['session', 'pull', 'renegotiate', 'close']);
    expect((t.sfu.last('close')!.body.mids as string[])).toHaveLength(1);
    expect(t.engine.view.peers['ravi-sess']).toBeUndefined();
    expect(t.engine.view.peers['bob-sess']?.state).toBe('connected');
    expect(t.pc().getTransceivers().filter((x) => x.direction === 'recvonly')).toHaveLength(2);   // bob's two
  });

  test('a camera Cloudflare does not take is dropped, not retried; the microphone carries on', async () => {
    const cam = fakeTrack('video', 'cam');
    const cam2 = fakeTrack('video', 'cam2');
    const t = setup({
      openMedia: async () => ({ stream: fakeStream(fakeTrack('audio', 'mic'), cam), cameraProblem: null }),
      getUserMedia: async (c) => (c.video ? fakeStream(cam2) : fakeStream(fakeTrack('audio', 'mic2'))),
    });
    t.sfu.pushErrors.add('cam-2');
    t.server['grp-call'] = { ...room([J('alice', 'srv-sess'), R('bob'), R('ravi')]), id: 'grp-call', kind: 'direct', media: 'video', channel_id: 'grp-1', started_by: 'alice' };
    await t.engine.startDirect('grp-1', 'video');
    await settle();
    await online(t);
    expect(t.pcs).toHaveLength(1);
    expect(t.pcs[0]?.closed).toBe(false);
    expect(t.server['grp-call']?.participants.find((p) => p.user_id === 'alice')?.sfu_tracks).toEqual(['mic-1']);
    expect(t.tx(t.pc(), '1')?.sender.track).toBeNull();   // the refused camera sends nothing
    t.timers.advance(20_000);   // (under the 45 s ring timeout: still ringing the others)
    await settle();
    expect(t.sfu.actions().filter((a) => a === 'push')).toHaveLength(0);   // not offered again
    await t.engine.toggleCamera();   // off
    await t.engine.toggleCamera();   // on: a new camera is offered
    await settle();
    expect(t.sfu.last('push')?.body.tracks).toEqual([{ mid: '2', name: 'cam-3' }]);
    expect(t.server['grp-call']?.participants.find((p) => p.user_id === 'alice')?.sfu_tracks).toEqual(['cam-3', 'mic-1']);
  });

  test('every other heartbeat on the SFU path reads the call again, in case a call.upd never arrived', async () => {
    const t = await inRoom();
    const reads = () => (t.api.getCall as ReturnType<typeof vi.fn>).mock.calls.length;
    const before = reads();
    t.timers.advance(HEARTBEAT_MS);
    await settle();
    expect(reads()).toBe(before);
    t.timers.advance(HEARTBEAT_MS);
    await settle();
    expect(reads()).toBe(before + 1);
    // a person whose call.upd was lost is picked up from that read
    const base = t.server['room-1']!;
    t.server['room-1'] = { ...base, version: (base.version ?? 0) + 1, participants: [...base.participants, J('carol', 'carol-sess', 'cf-carol-1', ['mic-1'])] };
    t.timers.advance(HEARTBEAT_MS);   // each beat is armed again once the last one answered
    await settle();
    t.timers.advance(HEARTBEAT_MS);
    await settle();
    expect(t.engine.view.peers['carol-sess']?.stream?.getAudioTracks()).toHaveLength(1);
  });

  test('my SFU session missing on the server: asked once, then published again on a new session', async () => {
    const t = await inRoom();
    t.pc().setConnection('connected');
    const base = t.server['room-1']!;
    const forgotten = base.participants.map((p) => (p.user_id === 'alice' ? { ...p, sfu_session: null, sfu_tracks: [] } : p));
    t.emit({ ...base, version: (base.version ?? 0) + 1, participants: forgotten });
    await settle();
    t.timers.advance(SFU_LOST_MS);
    await settle();
    t.timers.advance(400);   // the refresh (debounced)
    await settle();
    expect(t.api.getCall).toHaveBeenCalled();
    expect(t.pcs).toHaveLength(1);
    t.timers.advance(SFU_LOST_MS);
    await settle();
    expect(t.pcs).toHaveLength(2);
    expect(t.sfu.actions().filter((a) => a === 'session')).toHaveLength(2);
    expect(t.server['room-1']?.participants.find((p) => p.user_id === 'alice')?.sfu_session).toBe('cf-alice-2');
  });

  test('a rejoin after the server stopped counting this session publishes again on a new SFU session', async () => {
    const t = setup({ api: { callHeartbeat: vi.fn(async () => { throw new DekError('conflict', 'You are no longer in this call.'); }) } });
    t.server['room-1'] = othersInRoom();
    await t.engine.joinRoom('huddle');
    await settle();
    const base = t.server['room-1']!;
    t.server['room-1'] = { ...base, version: (base.version ?? 0) + 1, participants: base.participants.map((p) => (p.user_id === 'alice' ? { ...p, state: 'left' as const, sfu_session: null, sfu_tracks: [] } : p)) };
    t.timers.advance(HEARTBEAT_MS);
    await settle();
    expect(t.api.joinRoom).toHaveBeenLastCalledWith('huddle', 'my-sess-1');
    expect(t.pcs).toHaveLength(2);
    expect(t.pcs[0]?.closed).toBe(true);
    expect(t.sfu.actions().filter((a) => a === 'session')).toHaveLength(2);
  });

  test('listening without a microphone: nothing is pushed, everyone is still heard', async () => {
    const denied = new MediaAccessError(describeMediaError(new DOMException('no', 'NotAllowedError'), 'microphone'));
    const t = setup({ openMedia: async () => { throw denied; } });
    t.server['room-1'] = othersInRoom();
    await t.engine.joinRoom('huddle');
    await t.engine.retryProblem(true);
    await settle();
    expect(t.engine.view.listenOnly).toBe(true);
    expect(t.sfu.requests[0]?.body).toMatchObject({ offer: null, tracks: [] });
    expect(t.pc().getTransceivers().filter((x) => x.direction === 'sendonly')).toHaveLength(0);
    expect(t.engine.view.peers['ravi-sess']?.stream?.getAudioTracks()).toHaveLength(1);
  });

  test('the switch: when the server moves a live call off the SFU, everyone goes back to the mesh at that call.upd', async () => {
    const t = await inRoom();
    const sfuPc = t.pc();
    const base = t.server['room-1']!;
    t.emit({ ...base, version: (base.version ?? 0) + 1, sfu: false });
    await settle();
    expect(sfuPc.closed).toBe(true);
    expect(t.sent.some((s) => s.kind === 'hello' && s.to_session === null)).toBe(true);
    expect(t.pcs.length).toBe(3);   // one direct link per person now
    expect(Object.keys(t.engine.view.peers).sort()).toEqual(['bob-sess', 'ravi-sess']);
  });

  test('and back: a stamped call the switch returns to the SFU leaves the mesh at that call.upd', async () => {
    const t = setup();
    t.server['room-1'] = { ...othersInRoom(), sfu: false };
    await t.engine.joinRoom('huddle');
    await settle();
    expect(t.sfu.requests).toHaveLength(0);
    const meshLinks = [...t.pcs];
    expect(meshLinks).toHaveLength(2);
    const base = t.server['room-1']!;
    t.emit({ ...base, version: (base.version ?? 0) + 1, sfu: true });
    await settle();
    expect(meshLinks.every((p) => p.closed)).toBe(true);
    expect(t.sent.some((s) => s.kind === 'bye')).toBe(true);
    expect(t.pcs).toHaveLength(3);
    expect(t.sfu.actions()).toEqual(['session']);
    await online(t);
    expect(t.engine.view.peers['ravi-sess']?.stream?.getAudioTracks()).toHaveLength(1);
    expect(t.engine.view.status).toBe('connected');
  });

  test('on the SFU path a mesh hello (someone the switch moved, or an old app) makes it read the call again', async () => {
    const t = await inRoom();
    const before = (t.api.getCall as ReturnType<typeof vi.fn>).mock.calls.length;
    t.handlers.get('room-1')?.({ from_user: 'ravi', from_session: 'ravi-sess', to_session: null, kind: 'hello', data: null });
    t.handlers.get('room-1')?.({ from_user: 'ravi', from_session: 'ravi-sess', to_session: 'my-sess-1', kind: 'offer', data: { type: 'offer', sdp: 'x' } });
    t.timers.advance(400);
    await settle();
    expect((t.api.getCall as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
    expect(t.pcs).toHaveLength(1);   // nothing built for the offer
  });

  test('an older copy of the call (another topic, a slow answer) never replaces a newer one', async () => {
    const t = await inRoom();
    t.pc().setConnection('connected');
    const base = t.server['room-1']!;
    const v = base.version ?? 0;
    const newer = { ...base, version: v + 2, participants: [...base.participants, J('carol', 'carol-sess', 'cf-carol-1', ['mic-1'])] };
    t.emit(newer);
    await settle();
    t.emit({ ...base, version: v + 1 });
    t.timers.advance(SFU_DROP_GRACE_MS * 2);
    await settle();
    expect(t.engine.view.peers['carol-sess']?.state).toBe('connected');
    expect(t.sfu.last('close')).toBeUndefined();
    expect(t.engine.view.call?.version).toBe(v + 2);
  });

  test('upload and download per connection: one connection, the inbound tracks attributed to people', async () => {
    const t = await inRoom();
    const pc = t.pc();
    const raviTrack = t.engine.view.peers['ravi-sess']?.stream?.getAudioTracks()[0];
    pc.statsReport.set('o1', { type: 'outbound-rtp', kind: 'audio', bytesSent: 4000 });
    pc.statsReport.set('i1', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 3000, trackIdentifier: raviTrack?.id });
    const s = await t.engine.transportStats();
    expect(s).toMatchObject({ path: 'sfu', connections: 1, bytesSent: 4000, bytesReceived: 3000 });
    expect(s.inbound[0]?.userId).toBe('ravi');
  });
});

describe('a second call in the same tab', () => {
  test('connects after the first one was ended by the far side (the ended call no longer stands in for it)', async () => {
    const t = setup();
    const dm = (id: string, parts: Part[], over: Partial<Call> = {}): Call =>
      ({ ...room(parts), id, kind: 'direct', channel_id: 'dm-1', started_by: 'alice', sfu: false, version: undefined, ...over });
    t.server['grp-call'] = dm('call-1', [J('alice', 'srv-1'), R('bob')]);
    await t.engine.startDirect('dm-1', 'audio');
    t.emit(dm('call-1', [{ ...J('alice', 'srv-1'), state: 'left' }, { ...R('bob'), state: 'declined' }], { ended_at: T0, end_reason: 'declined' }));
    expect(t.engine.view.endTitle).toBe('Call declined');
    t.engine.dismissFinal();
    t.server['grp-call'] = dm('call-2', [J('alice', 'srv-2'), R('bob')]);
    await t.engine.startDirect('dm-1', 'audio');
    await settle();
    expect(t.engine.view.status).toBe('ringing');
    t.emit(dm('call-2', [J('alice', 'srv-2'), J('bob', 'bob-sess')]));
    await settle();
    expect(t.pcs).toHaveLength(1);
    expect(t.engine.view.peers['bob-sess']).toBeTruthy();
  });
});
