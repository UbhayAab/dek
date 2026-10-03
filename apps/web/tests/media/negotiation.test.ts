import { describe, expect, test } from 'vitest';
import { PeerLink, type LinkSignalKind, type LinkState } from '../../src/features/calls/link';
import { FakePC, ManualTimers, fakeStream, fakeTrack, flush } from './fakeRtc';

interface Msg { from: 'A' | 'B'; kind: LinkSignalKind; data: unknown }

// Two links back to back. Messages either go straight across (wired) or wait in
// a queue the test releases in the order it wants (glare, early candidates).
function pair(opts: { wired?: boolean; initialWaitMs?: number } = {}) {
  const timers = new ManualTimers();
  const pcA = new FakePC('A');
  const pcB = new FakePC('B');
  const queue: Msg[] = [];
  const sent: Msg[] = [];
  const states: { A: LinkState[]; B: LinkState[] } = { A: [], B: [] };
  let a!: PeerLink;
  let b!: PeerLink;
  const route = (m: Msg) => {
    sent.push(m);
    if (opts.wired === false) queue.push(m);
    else void (m.from === 'A' ? b : a).handle(m.kind, m.data);
  };
  a = new PeerLink({
    pc: pcA as unknown as RTCPeerConnection, polite: false, timers, initialWaitMs: opts.initialWaitMs,
    send: (kind, data) => route({ from: 'A', kind, data }), onState: (s) => states.A.push(s),
  });
  b = new PeerLink({
    pc: pcB as unknown as RTCPeerConnection, polite: true, timers, initialWaitMs: opts.initialWaitMs,
    send: (kind, data) => route({ from: 'B', kind, data }), onState: (s) => states.B.push(s),
  });
  const deliver = async (pick: (m: Msg) => boolean = () => true) => {
    const take = queue.filter(pick);
    for (const m of take) queue.splice(queue.indexOf(m), 1);
    for (const m of take) await (m.from === 'A' ? b : a).handle(m.kind, m.data);
    await flush();
  };
  return { a, b, pcA, pcB, timers, queue, sent, states, deliver };
}

const audio = () => fakeStream(fakeTrack('audio'));

describe('perfect negotiation (PeerLink)', () => {
  test('the impolite side offers first; the polite side waits and answers: no glare in the common case', async () => {
    const p = pair();
    p.a.attach(audio(), false);
    p.b.attach(audio(), false);
    await flush();
    expect(p.sent.map((m) => `${m.from}:${m.kind}`)).toEqual(['A:offer', 'B:answer']);
    expect(p.pcA.signalingState).toBe('stable');
    expect(p.pcB.signalingState).toBe('stable');
    expect(p.pcA.remoteDescription?.sdp).toBe('answer:B');
    expect(p.pcB.remoteDescription?.sdp).toBe('offer:A:1');
    expect(p.pcB.log).not.toContain('createOffer');
    expect(p.timers.pending()).toBe(0);   // the polite wait was cancelled by the offer
  });

  test('the polite side offers after a short wait when the impolite side is silent', async () => {
    const p = pair({ wired: false, initialWaitMs: 2500 });
    p.b.attach(audio(), false);
    await flush();
    expect(p.queue).toHaveLength(0);
    p.timers.advance(2500);
    await flush();
    expect(p.queue.map((m) => `${m.from}:${m.kind}`)).toEqual(['B:offer']);
  });

  test('glare: both offer at once; the impolite side ignores, the polite side rolls back and answers', async () => {
    const p = pair({ wired: false, initialWaitMs: 10 });
    p.a.attach(audio(), false);
    p.b.attach(audio(), false);
    await flush();
    p.timers.advance(10);   // the polite side stops waiting and offers too
    await flush();
    expect(p.queue.map((m) => `${m.from}:${m.kind}`)).toEqual(['A:offer', 'B:offer']);
    // Both offers cross on the wire.
    await p.deliver((m) => m.kind === 'offer');
    await p.deliver();   // B's answer to A
    expect(p.pcB.log).toContain('rollback');
    expect(p.pcA.log.some((l) => l.startsWith('SRD:offer'))).toBe(false);   // impolite ignored the colliding offer
    expect(p.pcA.signalingState).toBe('stable');
    expect(p.pcB.signalingState).toBe('stable');
    expect(p.pcA.remoteDescription?.sdp).toBe('answer:B');
    expect(p.pcB.remoteDescription?.sdp).toBe('offer:A:1');
  });

  test('candidates that beat their offer are held, then applied once the description is set', async () => {
    const p = pair({ wired: false });
    p.pcA.candidatesPerDescription = 3;
    p.a.attach(audio(), false);
    p.b.attach(audio(), false);
    await flush();
    p.timers.advance(150);   // A's batch goes out
    await flush();
    expect(p.queue.map((m) => `${m.from}:${m.kind}`)).toEqual(['A:offer', 'A:ice']);
    // Deliver the candidates first: there is no remote description yet.
    await p.deliver((m) => m.kind === 'ice');
    expect(p.pcB.added).toHaveLength(0);
    await p.deliver((m) => m.kind === 'offer');
    expect(p.pcB.added.map((c) => c.candidate)).toHaveLength(3);
  });

  test('local candidates go out in batches every 150 ms, and before any new description', async () => {
    const p = pair({ wired: false });
    p.a.attach(audio(), false);
    await flush();
    p.queue.length = 0;
    for (let i = 1; i <= 5; i += 1) p.pcA.emitCandidate(i);
    expect(p.queue).toHaveLength(0);
    p.timers.advance(149);
    expect(p.queue).toHaveLength(0);
    p.timers.advance(1);
    expect(p.queue).toHaveLength(1);
    expect(p.queue[0]?.kind).toBe('ice');
    expect(p.queue[0]?.data as unknown[]).toHaveLength(5);
    // End of candidates flushes at once.
    p.pcA.emitCandidate(6);
    p.pcA.onicecandidate?.({ candidate: null });
    expect(p.queue).toHaveLength(2);
  });

  test('renegotiation is serialized: a second need while an offer is out waits for stable', async () => {
    const p = pair({ wired: false });
    p.a.attach(audio(), false);
    await flush();
    p.pcA.onnegotiationneeded?.();
    p.pcA.onnegotiationneeded?.();
    await flush();
    expect(p.pcA.log.filter((l) => l === 'createOffer')).toHaveLength(1);
    expect(p.pcA.signalingState).toBe('have-local-offer');
    await p.a.handle('answer', { type: 'answer', sdp: 'answer:B' });
    expect(p.pcA.signalingState).toBe('stable');
    p.pcA.onnegotiationneeded?.();
    await flush();
    expect(p.pcA.log.filter((l) => l === 'createOffer')).toHaveLength(2);
  });

  test('an offer lost on the wire (sent before the far side joined the topic) is sent again until answered', async () => {
    const p = pair({ wired: false });
    p.a.attach(audio(), false);
    p.b.attach(audio(), false);
    await flush();
    expect(p.queue.map((m) => `${m.from}:${m.kind}`)).toEqual(['A:offer']);
    p.queue.length = 0;   // lost
    p.timers.advance(2000);
    await flush();
    expect(p.queue.map((m) => `${m.from}:${m.kind}`)).toEqual(['A:offer']);
    expect((p.queue[0]?.data as RTCSessionDescriptionInit).sdp).toBe('offer:A:1');   // the same offer, not a new one
    await p.deliver();
    await p.deliver();
    expect(p.pcA.signalingState).toBe('stable');
    p.timers.advance(20_000);
    await flush();
    expect(p.queue).toHaveLength(0);   // answered: no more resends
  });

  test('a late duplicate answer is ignored instead of breaking the connection', async () => {
    const p = pair();
    p.a.attach(audio(), false);
    p.b.attach(audio(), false);
    await flush();
    await p.a.handle('answer', { type: 'answer', sdp: 'answer:B' });
    expect(p.pcA.signalingState).toBe('stable');
    expect(p.pcA.log.filter((l) => l.startsWith('SRD:answer'))).toHaveLength(1);
  });

  test('disconnected gets 6 s of grace; a recovery inside it restarts nothing', async () => {
    const p = pair();
    p.a.attach(audio(), false);
    p.b.attach(audio(), false);
    await flush();
    p.pcA.setConnection('connected');
    p.pcA.setConnection('disconnected');
    expect(p.a.state).toBe('reconnecting');
    p.timers.advance(5999);
    expect(p.pcA.restarts).toBe(0);
    p.pcA.setConnection('connected');
    expect(p.a.state).toBe('connected');
    p.timers.advance(10_000);
    expect(p.pcA.restarts).toBe(0);
    // Still disconnected after the grace: an ICE restart, renegotiated with a new offer.
    p.pcA.setConnection('disconnected');
    p.timers.advance(6000);
    expect(p.pcA.restarts).toBe(1);
    await flush();
    expect(p.pcA.log.filter((l) => l === 'createOffer')).toHaveLength(2);
    expect(p.pcB.log.some((l) => l.includes(':restart'))).toBe(true);
  });

  test('failed restarts at once, up to three times, then the link gives up and says so', async () => {
    const timers = new ManualTimers();
    const pc = new FakePC('A');
    let gaveUp = 0;
    let failures = 0;
    const link = new PeerLink({
      pc: pc as unknown as RTCPeerConnection, polite: false, timers, send: () => undefined,
      onGiveUp: () => { gaveUp += 1; }, onFailure: () => { failures += 1; },
      freshConfig: () => ({ iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }] }),
    });
    link.attach(audio(), false);
    await flush();
    for (let i = 1; i <= 3; i += 1) {
      pc.setConnection('failed');
      expect(pc.restarts).toBe(i);
      expect(link.state).toBe('reconnecting');
    }
    expect(pc.config.iceServers?.[0]?.urls).toBe('turn:turn.example:3478');   // fresh credentials applied
    pc.setConnection('failed');
    expect(pc.restarts).toBe(3);
    expect(link.state).toBe('failed');
    expect(gaveUp).toBe(1);
    expect(failures).toBe(4);
  });

  test('a camera that was receive-only starts sending without tearing the link down', async () => {
    const p = pair();
    p.a.attach(audio(), true);   // video call, no camera yet: a receive-only video transceiver
    p.b.attach(audio(), true);
    await flush();
    const video = p.pcA.getTransceivers().find((t) => t.kind === 'video');
    expect(video?.direction).toBe('recvonly');
    const cam = fakeTrack('video', 'cam');
    await p.a.replaceTrack('video', cam, fakeStream(fakeTrack('audio'), cam));
    await flush();
    expect(video?.direction).toBe('sendrecv');
    expect(video?.sender.track).toBe(cam);
    // the direction change renegotiated
    expect(p.pcA.log.filter((l) => l === 'createOffer')).toHaveLength(2);
  });

  test('close() stops timers, closes the connection and ignores what arrives later', async () => {
    const p = pair({ wired: false });
    p.a.attach(audio(), false);
    await flush();
    p.pcA.emitCandidate(1);
    p.a.close();
    expect(p.pcA.closed).toBe(true);
    expect(p.a.state).toBe('closed');
    p.timers.advance(1000);
    expect(p.queue.filter((m) => m.kind === 'ice')).toHaveLength(0);
    await p.a.handle('offer', { type: 'offer', sdp: 'offer:B:9' });
    expect(p.pcA.log.some((l) => l.includes('offer:B:9'))).toBe(false);
  });
});
