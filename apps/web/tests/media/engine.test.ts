import { describe, expect, test, vi } from 'vitest';
import { DekError } from '../../src/api/errors';
import type { Call, CallParticipant } from '../../src/api/types';
import { MediaAccessError, describeMediaError } from '../../src/features/calls/devices';
import { CallEngine, HEARTBEAT_MS, RING_TIMEOUT_MS, type CallApi, type EngineDeps } from '../../src/features/calls/engine';
import { IceProvider } from '../../src/features/calls/ice';
import type { CallSignal } from '../../src/realtime/types';
import { FakePC, ManualTimers, fakeStream, fakeTrack, flush, removeRemoteTrack } from './fakeRtc';

const T0 = '2026-10-03T10:00:00.000Z';
const P = (user_id: string, state: CallParticipant['state'], session_id: string | null = null): CallParticipant =>
  ({ user_id, state, session_id, joined_at: state === 'joined' ? T0 : null });

function call(over: Partial<Call> & { participants: CallParticipant[] }): Call {
  return {
    id: 'call-1', org_id: 'org-1', channel_id: 'dm-1', kind: 'direct', media: 'audio', started_by: 'alice',
    created_at: T0, ended_at: null, end_reason: null, ...over,
  };
}

function setup(over: { relay?: boolean; openMedia?: EngineDeps['openMedia']; api?: Partial<CallApi>; display?: EngineDeps['getDisplayMedia'] | null } = {}) {
  const timers = new ManualTimers();
  const pcs: FakePC[] = [];
  const sent: CallSignal[] = [];
  const handlers = new Map<string, (s: CallSignal) => void>();
  const joined: string[] = [];
  const left: string[] = [];
  const keepalive: string[] = [];
  const watchers = new Map<string, (c: Call) => void>();
  const server: Record<string, Call> = {};
  let pagehide: (() => void) | null = null;
  const stopped: string[] = [];
  const meter = { added: [] as string[], stopped: 0, add(id: string) { this.added.push(id); }, remove() { /* noop */ }, stop() { this.stopped += 1; } };
  let sessions = 0;
  const mic = fakeTrack('audio', 'mic');
  (mic as unknown as { stop: () => void }).stop = () => { stopped.push('mic'); };
  const api: CallApi = {
    startCall: vi.fn(async () => call({ participants: [P('alice', 'joined', 'srv-sess'), P('bob', 'ringing')] })),
    answerCall: vi.fn(async (id: string, s: string) => call({ id, started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess'), P('alice', 'joined', s)] })),
    declineCall: vi.fn(async (id: string) => call({ id, participants: [] })),
    joinRoom: vi.fn(async (channel: string, s: string) => call({ id: 'room-1', kind: 'room', channel_id: channel, participants: [P('alice', 'joined', s), P('ravi', 'joined', 'ravi-sess')] })),
    leaveCall: vi.fn(async (id: string) => call({ id, ended_at: T0, end_reason: 'completed', participants: [] })),
    callHeartbeat: vi.fn(async () => ({ ok: true })),
    getCall: vi.fn(async (id: string) => server[id] ?? call({ id, participants: [] })),
    ...over.api,
  };
  const engine = new CallEngine({
    api,
    transport: {
      joinCall: (id) => joined.push(id),
      leaveCall: (id) => left.push(id),
      sendSignal: (_id, s) => sent.push(s),
      onSignal: (id, h) => { handlers.set(id, h); return () => handlers.delete(id); },
    },
    ice: new IceProvider(async () => ({
      iceServers: over.relay === false ? [{ urls: 'stun:stun.example:3478' }] : [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }],
      relay: over.relay !== false,
    })),
    me: () => 'alice',
    serverCall: (id) => server[id],
    watchServerCall: (id, fn) => { watchers.set(id, fn); return () => watchers.delete(id); },
    activeCallInChannel: () => undefined,
    openMedia: over.openMedia ?? (async () => ({ stream: fakeStream(mic), cameraProblem: null })),
    getUserMedia: async () => fakeStream(fakeTrack('audio', 'mic2')),
    ...(over.display === null ? {} : { getDisplayMedia: over.display ?? (async () => fakeStream(fakeTrack('video', 'screen'))) }),
    createPeerConnection: (cfg) => {
      const pc = new FakePC(`pc${pcs.length}`, cfg);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    newSession: () => `my-sess-${++sessions}`,
    leaveKeepalive: (id) => keepalive.push(id),
    onPageHide: (fn) => { pagehide = fn; return () => { pagehide = null; }; },
    forceRelay: () => false,
    listDevices: async () => ({ audioinput: [], audiooutput: [], videoinput: [] }),
    makeMeter: () => meter,
    notify: () => undefined,
    timers,
  });
  const emit = (c: Call) => { server[c.id] = c; watchers.get(c.id)?.(c); };
  return { engine, api, timers, pcs, sent, handlers, joined, left, keepalive, watchers, server, meter, stopped, emit, pagehide: () => pagehide };
}

describe('call engine flows', () => {
  test('starting a call: microphone first, then start_call; ringing; signaling joined; hello sent', async () => {
    const order: string[] = [];
    const t = setup({
      openMedia: async () => { order.push('mic'); return { stream: fakeStream(fakeTrack('audio')), cameraProblem: null }; },
      api: { startCall: vi.fn(async () => { order.push('start_call'); return call({ participants: [P('alice', 'joined', 'srv-sess'), P('bob', 'ringing')] }); }) },
    });
    await t.engine.startDirect('dm-1', 'audio');
    await flush();
    expect(order).toEqual(['mic', 'start_call']);
    expect(t.engine.view.status).toBe('ringing');
    expect(t.engine.view.sessionId).toBe('srv-sess');   // the caller uses the session the server made
    expect(t.joined).toEqual(['call-1']);
    expect(t.sent[0]).toMatchObject({ kind: 'hello', to_session: null, from_session: 'srv-sess', from_user: 'alice' });
    expect(t.pcs).toHaveLength(0);   // nobody to connect to yet
  });

  test('the callee joins: a link is built, then connected; the talk timer starts', async () => {
    const t = setup();
    await t.engine.startDirect('dm-1', 'audio');
    t.emit(call({ participants: [P('alice', 'joined', 'srv-sess'), P('bob', 'joined', 'bob-sess')] }));
    await flush();
    expect(t.pcs).toHaveLength(1);
    expect(t.pcs[0]?.config.iceServers?.[0]?.urls).toEqual(['turn:turn.example:3478']);
    expect(t.engine.view.status).toBe('connecting');
    expect(t.engine.view.peers['bob-sess']?.userId).toBe('bob');
    t.pcs[0]?.setConnection('connected');
    expect(t.engine.view.status).toBe('connected');
    expect(t.engine.view.connectedAt).not.toBeNull();
  });

  test('a declined call ends with its own state and everything is released', async () => {
    const t = setup();
    await t.engine.startDirect('dm-1', 'audio');
    t.emit(call({ ended_at: T0, end_reason: 'declined', participants: [P('alice', 'left', 'srv-sess'), P('bob', 'declined')] }));
    expect(t.engine.view.status).toBe('declined');
    expect(t.engine.view.final).toBe(true);
    expect(t.engine.view.endTitle).toBe('Call declined');
    expect(t.stopped).toEqual(['mic']);
    expect(t.left).toEqual(['call-1']);
    expect(t.meter.stopped).toBe(1);
    expect(t.engine.isLive()).toBe(false);
  });

  test('a decline that arrives before start_call answers still ends the call, with nothing left running', async () => {
    const declined = call({ ended_at: T0, end_reason: 'declined', participants: [P('alice', 'left', 'srv-sess'), P('bob', 'declined')] });
    let server!: Record<string, Call>;
    const t = setup({
      api: {
        startCall: vi.fn(async () => {
          server['call-1'] = declined;   // the call.upd event landed in the store first
          return call({ participants: [P('alice', 'joined', 'srv-sess'), P('bob', 'ringing')] });
        }),
      },
    });
    server = t.server;
    await t.engine.startDirect('dm-1', 'audio');
    expect(t.engine.view.status).toBe('declined');
    expect(t.engine.view.endTitle).toBe('Call declined');
    expect(t.stopped).toEqual(['mic']);
    t.timers.advance(RING_TIMEOUT_MS + HEARTBEAT_MS);
    await flush();
    expect(t.api.callHeartbeat).not.toHaveBeenCalled();
    expect(t.api.leaveCall).not.toHaveBeenCalled();
  });

  test('no answer is "unavailable" for the caller', async () => {
    const t = setup();
    await t.engine.startDirect('dm-1', 'audio');
    t.emit(call({ ended_at: T0, end_reason: 'missed', participants: [P('alice', 'left', 'srv-sess'), P('bob', 'missed')] }));
    expect(t.engine.view.status).toBe('unavailable');
    expect(t.engine.view.endTitle).toBe('No answer');
  });

  test('ringing too long hangs up (45 s)', async () => {
    const t = setup();
    await t.engine.startDirect('dm-1', 'audio');
    t.timers.advance(RING_TIMEOUT_MS);
    await flush();
    expect(t.api.leaveCall).toHaveBeenCalledWith('call-1');
    expect(t.engine.view.endTitle).toBe('Call cancelled');
  });

  test('a refused microphone leaves chat alone: no call is started, an explanation is shown (DEK24)', async () => {
    const denied = new MediaAccessError(describeMediaError(new DOMException('no', 'NotAllowedError'), 'microphone'));
    const t = setup({ openMedia: async () => { throw denied; } });
    await t.engine.startDirect('dm-1', 'audio');
    expect(t.api.startCall).not.toHaveBeenCalled();
    expect(t.engine.view.status).toBe('idle');
    expect(t.engine.view.problem?.kind).toBe('denied');
    expect(t.engine.view.problem?.steps.length).toBeGreaterThan(0);
    expect(t.engine.view.problem?.canListenOnly).toBe(false);
    t.engine.dismissProblem();
    expect(t.engine.view.problem).toBeNull();
  });

  test('answering without a microphone is possible for listening (rooms and calls)', async () => {
    const denied = new MediaAccessError(describeMediaError(new DOMException('no', 'NotAllowedError'), 'microphone'));
    const t = setup({ openMedia: async () => { throw denied; } });
    await t.engine.joinRoom('huddle');
    expect(t.engine.view.problem?.canListenOnly).toBe(true);
    await t.engine.retryProblem(true);
    await flush();
    expect(t.api.joinRoom).toHaveBeenCalled();
    expect(t.engine.view.listenOnly).toBe(true);
    // a receive-only audio transceiver so the room can still be heard
    expect(t.pcs[0]?.getTransceivers()[0]?.direction).toBe('recvonly');
  });

  test('answering: a new session id each time, then the link to the caller', async () => {
    const t = setup();
    t.server['call-9'] = call({ id: 'call-9', started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess'), P('alice', 'ringing')] });
    await t.engine.answer('call-9');
    await flush();
    expect(t.api.answerCall).toHaveBeenCalledWith('call-9', 'my-sess-1');
    expect(t.engine.view.sessionId).toBe('my-sess-1');
    expect(t.pcs).toHaveLength(1);
    expect(t.engine.view.peers['bob-sess']).toBeTruthy();
  });

  test('the same person answering on another device ends it here, cleanly', async () => {
    const t = setup();
    await t.engine.startDirect('dm-1', 'audio');
    t.emit(call({ participants: [P('alice', 'joined', 'other-device'), P('bob', 'joined', 'bob-sess')] }));
    expect(t.engine.view.final).toBe(true);
    expect(t.engine.view.endTitle).toBe('The call moved to another device');
  });

  test('heartbeat every 30 s; when the server reaped this session, it rejoins with the SAME session (no duplicate, DEKA13)', async () => {
    const t = setup({
      api: {
        callHeartbeat: vi.fn(async () => { throw new DekError('conflict', 'You are no longer in this call.'); }),
      },
    });
    await t.engine.joinRoom('huddle');
    await flush();
    expect(t.engine.view.sessionId).toBe('my-sess-1');
    t.server['room-1'] = call({ id: 'room-1', kind: 'room', channel_id: 'huddle', participants: [P('alice', 'left', 'my-sess-1'), P('ravi', 'joined', 'ravi-sess')] });
    t.timers.advance(HEARTBEAT_MS);
    await flush();
    expect(t.api.callHeartbeat).toHaveBeenCalledWith('room-1', 'my-sess-1');
    expect(t.api.getCall).toHaveBeenCalledWith('room-1');
    expect(t.api.joinRoom).toHaveBeenLastCalledWith('huddle', 'my-sess-1');
    // the call topic is joined again once the server lists the session as joined,
    // so Realtime re-decides sending rights against the fresh state
    expect(t.joined).toEqual(['room-1', 'room-1']);
    expect(t.left).toEqual(['room-1']);
  });

  test('the call topic is only joined after the server says this session is joined', async () => {
    const order: string[] = [];
    const t = setup({
      api: {
        answerCall: vi.fn(async (id: string, s: string) => {
          order.push('answer_call');
          return call({ id, started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess'), P('alice', 'joined', s)] });
        }),
      },
    });
    t.server['call-9'] = call({ id: 'call-9', started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess'), P('alice', 'ringing')] });
    const origJoin = t.joined.push.bind(t.joined);
    t.joined.push = (...ids: string[]) => { order.push('join call:'); return origJoin(...ids); };
    await t.engine.answer('call-9');
    expect(order).toEqual(['answer_call', 'join call:']);
  });

  test('leaving: bye to everyone, leave_call, the ended state', async () => {
    const t = setup();
    await t.engine.joinRoom('huddle');
    await flush();
    await t.engine.leave();
    expect(t.sent[t.sent.length - 1]).toMatchObject({ kind: 'bye', to_session: null });
    expect(t.api.leaveCall).toHaveBeenCalledWith('room-1');
    expect(t.engine.view.status).toBe('ended');
    expect(t.engine.view.endTitle).toBe('You left the room');
    expect(t.pcs[0]?.closed).toBe(true);
    expect(t.left).toEqual(['room-1']);
  });

  test('closing the page leaves with a keepalive request', async () => {
    const t = setup();
    await t.engine.joinRoom('huddle');
    await flush();
    t.pagehide()?.();
    expect(t.keepalive).toEqual(['room-1']);
    expect(t.sent[t.sent.length - 1]).toMatchObject({ kind: 'bye' });
    expect(t.stopped).toEqual(['mic']);
  });

  test('a full room says so instead of failing quietly', async () => {
    const t = setup({ api: { joinRoom: vi.fn(async () => { throw new DekError('conflict', 'This room is full (8 people). Try again when someone leaves.'); }) } });
    await t.engine.joinRoom('huddle');
    expect(t.engine.view.status).toBe('unavailable');
    expect(t.engine.view.endTitle).toBe('This room is full (8 people).');
    expect(t.engine.view.endBody).toBe('Try again when someone leaves.');
    expect(t.stopped).toEqual(['mic']);
  });

  test('without a relay, a failed connection says the relay is unavailable', async () => {
    const t = setup({ relay: false });
    await t.engine.joinRoom('huddle');
    await flush();
    expect(t.engine.view.relay).toBe(false);
    t.pcs[0]?.setConnection('failed');
    expect(t.engine.view.relayWarning).toBe(true);
  });

  test('with a relay, a failed connection retries without the relay warning', async () => {
    const t = setup({ relay: true });
    await t.engine.joinRoom('huddle');
    await flush();
    t.pcs[0]?.setConnection('failed');
    expect(t.engine.view.relayWarning).toBe(false);
    expect(t.pcs[0]?.restarts).toBe(1);
  });
});

describe('screen sharing (DEK21)', () => {
  const inRoom = async (t: ReturnType<typeof setup>) => {
    await t.engine.joinRoom('huddle');
    await flush();
    return t.pcs[0]!;
  };

  test('sharing adds the screen to every peer as its own track; Stop ends the capture and the sending', async () => {
    const screen = fakeTrack('video', 'screen');
    const display = vi.fn(async (_c: DisplayMediaStreamOptions) => fakeStream(screen));
    const t = setup({ display });
    const pc = await inRoom(t);
    await t.engine.startScreenShare();
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0]?.[0]).toMatchObject({ audio: false });
    expect(t.engine.view.sharing).toBe(true);
    expect(t.engine.view.localScreen?.getVideoTracks()[0]).toBe(screen);
    expect(screen.contentHint).toBe('detail');
    const screenTx = pc.getTransceivers().find((x) => x.sender.track === screen);
    expect(screenTx).toBeTruthy();

    await t.engine.stopScreenShare();
    await flush();
    expect(t.engine.view.sharing).toBe(false);
    expect(t.engine.view.localScreen).toBeNull();
    expect(screen.readyState).toBe('ended');   // the capture is released
    expect(screenTx!.sender.track).toBeNull();
    expect(screenTx!.direction).toBe('recvonly');
  });

  test('the browser\'s own "Stop sharing" ends it the same way', async () => {
    const screen = fakeTrack('video', 'screen');
    const t = setup({ display: async () => fakeStream(screen) });
    const pc = await inRoom(t);
    await t.engine.startScreenShare();
    await flush();
    screen.endFromSource();
    await flush();
    expect(t.engine.view.sharing).toBe(false);
    expect(pc.getTransceivers().find((x) => x.kind === 'video')?.sender.track).toBeNull();
  });

  test('sharing again reuses the same sender (replaceTrack), no new transceiver', async () => {
    const tracks = [fakeTrack('video', 's1'), fakeTrack('video', 's2')];
    let n = 0;
    const t = setup({ display: async () => fakeStream(tracks[n++]!) });
    const pc = await inRoom(t);
    await t.engine.startScreenShare();
    await flush();
    await t.engine.stopScreenShare();
    await flush();
    await t.engine.startScreenShare();
    await flush();
    const video = pc.getTransceivers().filter((x) => x.kind === 'video');
    expect(video).toHaveLength(1);
    expect(video[0]!.sender.track).toBe(tracks[1]);
    expect(video[0]!.direction).toBe('sendrecv');
  });

  test('someone joining while the screen is shared receives it too', async () => {
    const screen = fakeTrack('video', 'screen');
    const t = setup({ display: async () => fakeStream(screen) });
    await inRoom(t);
    await t.engine.startScreenShare();
    await flush();
    t.emit(call({ id: 'room-1', kind: 'room', channel_id: 'huddle', participants: [P('alice', 'joined', 'my-sess-1'), P('ravi', 'joined', 'ravi-sess'), P('bob', 'joined', 'bob-sess')] }));
    await flush();
    expect(t.pcs).toHaveLength(2);
    expect(t.pcs[1]!.getTransceivers().some((x) => x.sender.track === screen)).toBe(true);
  });

  test('ending the call leaves no capture running', async () => {
    const screen = fakeTrack('video', 'screen');
    const t = setup({ display: async () => fakeStream(screen) });
    await inRoom(t);
    await t.engine.startScreenShare();
    await flush();
    await t.engine.leave();
    expect(screen.readyState).toBe('ended');
    expect(t.engine.view.sharing).toBe(false);
    expect(t.engine.view.localScreen).toBeNull();
  });

  test('a closed picker is no error; a refused capture says so; a second click while picking asks once', async () => {
    const cancelled = setup({ display: async () => { throw new DOMException('closed', 'NotAllowedError'); } });
    await inRoom(cancelled);
    await cancelled.engine.startScreenShare();
    expect(cancelled.engine.view.sharing).toBe(false);
    expect(cancelled.engine.view.notice).toBeNull();

    const failed = setup({ display: async () => { throw new DOMException('no', 'NotReadableError'); } });
    await inRoom(failed);
    await failed.engine.startScreenShare();
    expect(failed.engine.view.notice).toMatch(/could not be shared/);

    let release!: (s: MediaStream) => void;
    const display = vi.fn(() => new Promise<MediaStream>((r) => { release = r; }));
    const slow = setup({ display });
    await inRoom(slow);
    void slow.engine.startScreenShare();
    void slow.engine.startScreenShare();
    expect(display).toHaveBeenCalledTimes(1);
    release(fakeStream(fakeTrack('video', 'screen')));
    await flush();
    expect(slow.engine.view.sharing).toBe(true);
  });

  test('a screen picked after the call ended is released at once', async () => {
    let release!: (s: MediaStream) => void;
    const t = setup({ display: () => new Promise<MediaStream>((r) => { release = r; }) });
    await inRoom(t);
    void t.engine.startScreenShare();
    await t.engine.leave();
    const screen = fakeTrack('video', 'screen');
    release(fakeStream(screen));
    await flush();
    expect(screen.readyState).toBe('ended');
    expect(t.engine.view.sharing).toBe(false);
  });

  test('nothing to share where the browser cannot capture a screen', async () => {
    const t = setup({ display: null });
    await inRoom(t);
    await t.engine.startScreenShare();
    expect(t.engine.view.sharing).toBe(false);
  });

  test('receiving: a video track without the person\'s audio is their shared screen; muted or removed, it is gone', async () => {
    const t = setup();
    const pc = await inRoom(t);
    // ravi's microphone, in ravi's own stream
    const raviMic = fakeTrack('audio', 'ravi-mic');
    const raviMain = fakeStream(raviMic);
    pc.ontrack?.({ track: raviMic, streams: [raviMain] });
    expect(t.engine.view.peers['ravi-sess']?.stream).toBe(raviMain);
    expect(t.engine.view.peers['ravi-sess']?.screen).toBeNull();
    // ravi shares: a video track in a stream of its own
    const raviScreen = fakeTrack('video', 'ravi-screen');
    const screenStream = fakeStream(raviScreen);
    pc.ontrack?.({ track: raviScreen, streams: [screenStream] });
    expect(t.engine.view.peers['ravi-sess']?.screen).toBe(screenStream);
    expect(t.engine.view.peers['ravi-sess']?.stream).toBe(raviMain);   // the main stream is untouched
    // ravi stops: the renegotiation mutes it and takes it out of the stream
    removeRemoteTrack(screenStream, raviScreen);
    expect(t.engine.view.peers['ravi-sess']?.screen).toBeNull();
    // and shares again: the same track comes back through ontrack
    screenStream.addTrack(raviScreen);
    raviScreen.setMuted(false);
    pc.ontrack?.({ track: raviScreen, streams: [screenStream] });
    expect(t.engine.view.peers['ravi-sess']?.screen).toBe(screenStream);
  });

  test('receiving: a screen shared again can come back in a new stream object, and still shows', async () => {
    const t = setup();
    const pc = await inRoom(t);
    const raviScreen = fakeTrack('video', 'ravi-screen');
    const first = fakeStream(raviScreen);
    pc.ontrack?.({ track: raviScreen, streams: [first] });
    removeRemoteTrack(first, raviScreen);
    expect(t.engine.view.peers['ravi-sess']?.screen).toBeNull();
    // Chrome re-adds the same track, in a fresh MediaStream, still muted until
    // the first frames arrive
    const second = fakeStream(raviScreen);
    pc.ontrack?.({ track: raviScreen, streams: [second] });
    expect(t.engine.view.peers['ravi-sess']?.screen).toBeNull();
    raviScreen.setMuted(false);
    expect(t.engine.view.peers['ravi-sess']?.screen).toBe(second);
  });

  test('receiving: a camera travels with the microphone, so it stays a camera', async () => {
    const v = setup();
    v.server['call-v'] = call({ id: 'call-v', media: 'video', started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess'), P('alice', 'ringing')] });
    await v.engine.answer('call-v');
    await flush();
    const pc = v.pcs[0]!;
    const mic = fakeTrack('audio', 'bob-mic');
    const cam = fakeTrack('video', 'bob-cam');
    const main = fakeStream(mic, cam);
    pc.ontrack?.({ track: mic, streams: [main] });
    pc.ontrack?.({ track: cam, streams: [main] });
    expect(v.engine.view.peers['bob-sess']?.screen).toBeNull();
    expect(v.engine.view.peers['bob-sess']?.video).toBe(true);
  });
});

describe('a full call (server cap of 8)', () => {
  const FULL = new DekError('conflict', 'This call is full (8 people).');

  test('answering a full call shows the server\'s sentence', async () => {
    const t = setup({ api: { answerCall: vi.fn(async () => { throw FULL; }) } });
    t.server['call-9'] = call({ id: 'call-9', started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess'), P('alice', 'ringing')] });
    await t.engine.answer('call-9');
    expect(t.engine.view.status).toBe('unavailable');
    expect(t.engine.view.endTitle).toBe('This call is full (8 people).');
    expect(t.engine.view.endBody).toBe('Try again when someone leaves.');
    expect(t.stopped).toEqual(['mic']);
  });

  test('joining a full room shows the server\'s sentence', async () => {
    const t = setup({ api: { joinRoom: vi.fn(async () => { throw FULL; }) } });
    await t.engine.joinRoom('huddle');
    expect(t.engine.view.endTitle).toBe('This call is full (8 people).');
  });

  test('starting a call where a full one is already going shows it too', async () => {
    const t = setup({
      api: {
        startCall: vi.fn(async () => call({ started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess')] })),
        answerCall: vi.fn(async () => { throw FULL; }),
      },
    });
    await t.engine.startDirect('dm-1', 'audio');
    expect(t.engine.view.endTitle).toBe('This call is full (8 people).');
  });

  test('an ended call and a dropped connection read differently', async () => {
    const ended = setup({ api: { answerCall: vi.fn(async () => { throw new DekError('conflict', 'This call has ended.'); }) } });
    ended.server['call-9'] = call({ id: 'call-9', started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess'), P('alice', 'ringing')] });
    await ended.engine.answer('call-9');
    expect(ended.engine.view.status).toBe('ended');
    expect(ended.engine.view.endTitle).toBe('This call has ended');

    const offline = setup({ api: { answerCall: vi.fn(async () => { throw new DekError('network'); }) } });
    offline.server['call-9'] = call({ id: 'call-9', started_by: 'bob', participants: [P('bob', 'joined', 'bob-sess'), P('alice', 'ringing')] });
    await offline.engine.answer('call-9');
    expect(offline.engine.view.endTitle).toBe('Could not join the call');
    expect(offline.engine.view.endBody).toMatch(/offline|connection/i);
  });
});
