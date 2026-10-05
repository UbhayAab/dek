// A loopback SFU in one page, for the SFU path's real-browser test (sfu-loopback.spec.ts).
// Each person's SfuConnection (src/features/calls/sfu.ts) talks to it with the same
// actions and shapes as the sfu Edge Function, and it answers the way Cloudflare's API
// does: a push is the endpoint's offer, answered; a pull is an offer from the SFU that
// the endpoint answers through renegotiate; a close is negotiated with the endpoint's
// offer. Its side of each session is a real RTCPeerConnection that forwards the tracks
// it receives, so Chromium's own SDP handling runs through every step of sfu.ts. The
// people are in one page; the "database" is a map of who publishes what, and every
// change reaches everyone at once (call.upd). Served by Vite; never part of a build.
import { SfuConnection, type RemoteRole, type SfuAction, type SfuPeer, type SfuReply } from '../../src/features/calls/sfu';

interface Side {
  pc: RTCPeerConnection;
  names: Map<string, string>;
  tracks: Map<string, MediaStreamTrack>;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 1500);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

class LoopSfu {
  readonly sides = new Map<string, Side>();
  readonly actions: string[] = [];
  readonly published = new Map<string, { sfuSession: string; tracks: string[] }>();
  onPublish: () => void = () => undefined;
  private n = 0;

  request(user: string) {
    return async (action: SfuAction, body: Record<string, unknown>): Promise<SfuReply> => {
      this.actions.push(`${user}:${action}`);
      return this.handle(user, action, body);
    };
  }

  private async answer(side: Side, offer: RTCSessionDescriptionInit, tracks: { mid: string; name: string }[]): Promise<RTCSessionDescriptionInit> {
    for (const t of tracks) side.names.set(t.mid, t.name);
    await side.pc.setRemoteDescription(offer);
    await side.pc.setLocalDescription(await side.pc.createAnswer());
    await gathered(side.pc);
    return side.pc.localDescription!.toJSON();
  }

  private publish(user: string, sfuSession: string, add: string[], remove: string[] = [], fresh = false): void {
    const prev = this.published.get(user);
    const base = fresh || !prev ? [] : prev.tracks;
    this.published.set(user, { sfuSession, tracks: [...new Set([...base, ...add])].filter((n) => !remove.includes(n)).sort() });
    this.onPublish();
  }

  private async handle(user: string, action: SfuAction, body: Record<string, unknown>): Promise<SfuReply> {
    const tracks = (body.tracks ?? []) as { mid: string; name: string; session: string }[];
    if (action === 'session') {
      this.n += 1;
      const id = `loop-session-${this.n}`;
      const side: Side = { pc: new RTCPeerConnection({ bundlePolicy: 'max-bundle' }), names: new Map(), tracks: new Map() };
      side.pc.ontrack = (e) => {
        const name = side.names.get(e.transceiver.mid ?? '');
        if (!name) return;
        side.tracks.set(name, e.track);
        // Chromium hands a received audio track's samples to another connection only
        // while it plays out somewhere: a muted element is enough (the page is silent).
        if (e.track.kind === 'audio') {
          const el = new Audio();
          el.muted = true;
          el.srcObject = new MediaStream([e.track]);
          void el.play().catch(() => undefined);
        }
      };
      this.sides.set(id, side);
      const answer = body.offer ? await this.answer(side, body.offer as RTCSessionDescriptionInit, tracks) : null;
      this.publish(user, id, tracks.map((t) => t.name), [], true);
      return { sfu_session: id, answer, tracks: tracks.map((t) => ({ mid: t.mid, trackName: t.name })) };
    }
    const id = body.sfu_session as string;
    const side = this.sides.get(id);
    if (!side) throw new Error(`unknown session ${id}`);
    if (action === 'push') {
      const answer = await this.answer(side, body.offer as RTCSessionDescriptionInit, tracks);
      this.publish(user, id, tracks.map((t) => t.name));
      return { answer, tracks: tracks.map((t) => ({ mid: t.mid, trackName: t.name })) };
    }
    if (action === 'pull') {
      const results: { sessionId: string; trackName: string; errorCode?: string; tx?: RTCRtpTransceiver }[] = [];
      for (const w of tracks) {
        const src = this.sides.get(w.session)?.tracks.get(w.name);
        if (!src || src.readyState !== 'live') {
          results.push({ sessionId: w.session, trackName: w.name, errorCode: 'not_found_track_error' });
          continue;
        }
        results.push({ sessionId: w.session, trackName: w.name, tx: side.pc.addTransceiver(src, { direction: 'sendonly' }) });
      }
      if (!results.some((r) => r.tx)) return { offer: null, renegotiate: false, tracks: results, refused: [] };
      await side.pc.setLocalDescription(await side.pc.createOffer());
      await gathered(side.pc);
      return {
        offer: side.pc.localDescription!.toJSON(), renegotiate: true, refused: [],
        tracks: results.map((r) => (r.tx ? { mid: r.tx.mid ?? '', sessionId: r.sessionId, trackName: r.trackName } : { sessionId: r.sessionId, trackName: r.trackName, errorCode: r.errorCode })),
      };
    }
    if (action === 'renegotiate') {
      await side.pc.setRemoteDescription(body.answer as RTCSessionDescriptionInit);
      return {};
    }
    const names = (body.names ?? []) as string[];
    const answer = body.offer ? await this.answer(side, body.offer as RTCSessionDescriptionInit, []) : null;
    if (names.length) this.publish(user, id, [], names);
    return { answer, tracks: ((body.mids ?? []) as string[]).map((mid) => ({ mid })) };
  }
}

interface Person {
  user: string;
  conn: SfuConnection;
  stream: MediaStream;
  screen: { track: MediaStreamTrack; stream: MediaStream } | null;
  received: Map<string, { track: MediaStreamTrack; role: RemoteRole; from: string }>;
  states: Map<string, string>;
  errors: string[];
  left: boolean;
}

const loop = new LoopSfu();
const people = new Map<string, Person>();

function roster(): void {
  for (const p of people.values()) {
    if (p.left) continue;
    const others: SfuPeer[] = [];
    for (const o of people.values()) {
      const pub = loop.published.get(o.user);
      if (o === p || o.left || !pub) continue;
      others.push({ userId: o.user, sessionId: `${o.user}-dek-session`, sfuSession: pub.sfuSession, tracks: pub.tracks });
    }
    p.conn.setRoster(others, { sfuSession: loop.published.get(p.user)?.sfuSession ?? null });
  }
}
loop.onPublish = () => queueMicrotask(roster);

async function join(user: string): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const p: Person = { user, stream, screen: null, received: new Map(), states: new Map(), errors: [], left: false, conn: null as unknown as SfuConnection };
  p.conn = new SfuConnection({
    request: loop.request(user),
    createPeerConnection: (cfg) => new RTCPeerConnection(cfg),
    config: () => ({ iceServers: [], bundlePolicy: 'max-bundle' }),
    createStream: () => new MediaStream(),
    log: (m, e) => p.errors.push(`${m}: ${e instanceof Error ? e.message : String(e)}`),
    onPeer: (member, state) => p.states.set(member.userId, state),
    onPeerGone: (sessionId) => p.states.delete(sessionId.replace('-dek-session', '')),
    onTrack: (member, track, _stream, role) => p.received.set(track.id, { track, role, from: member.userId }),
    onTrackGone: (_member, track) => p.received.delete(track.id),
  });
  people.set(user, p);
  p.conn.start({ stream, listenOnly: false, screen: null });
  roster();
}

function leave(user: string): void {
  const p = people.get(user);
  if (!p) return;
  p.left = true;
  p.conn.close();
  for (const t of p.stream.getTracks()) t.stop();
  loop.published.delete(user);
  roster();
}

async function camera(user: string, on: boolean): Promise<void> {
  const p = people.get(user);
  if (!p) return;
  if (on) {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
    const t = s.getVideoTracks()[0]!;
    p.stream.addTrack(t);
    await p.conn.replaceTrack('video', t, p.stream);
  } else {
    for (const t of p.stream.getVideoTracks()) {
      t.stop();
      p.stream.removeTrack(t);
    }
    await p.conn.replaceTrack('video', null, p.stream);
  }
}

async function screen(user: string, on: boolean): Promise<void> {
  const p = people.get(user);
  if (!p) return;
  if (on) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const g = canvas.getContext('2d')!;
    let x = 0;
    setInterval(() => { g.fillStyle = `hsl(${(x += 7) % 360} 70% 50%)`; g.fillRect(0, 0, 320, 180); }, 100);
    const s = canvas.captureStream(10);
    p.screen = { track: s.getVideoTracks()[0]!, stream: s };
    await p.conn.shareScreen(p.screen.track, p.screen.stream);
  } else {
    for (const t of p.screen?.stream.getTracks() ?? []) t.stop();
    p.screen = null;
    await p.conn.stopScreen();
  }
}

function restart(user: string): void {
  people.get(user)?.conn.restart();
}

// What each person has now: what they receive (by sender and role, live or not), the
// state they see for each other person, and what their connection says about bytes.
async function report() {
  const out: Record<string, unknown> = {};
  for (const p of people.values()) {
    if (p.left) continue;
    const inbound: { kind: string; bytes: number; from: string | null }[] = [];
    let sent = 0;
    let outbound = 0;
    const pc = p.conn.connection;
    if (pc) {
      const stats = await pc.getStats();
      stats.forEach((r: { type: string; kind?: string; bytesSent?: number; bytesReceived?: number; trackIdentifier?: string }) => {
        if (r.type === 'outbound-rtp') {
          sent += r.bytesSent ?? 0;
          outbound += 1;
        }
        if (r.type === 'inbound-rtp') inbound.push({ kind: r.kind ?? '', bytes: r.bytesReceived ?? 0, from: r.trackIdentifier ? p.conn.ownerOf(r.trackIdentifier)?.userId ?? null : null });
      });
    }
    out[p.user] = {
      state: p.conn.state,
      connectionState: pc?.connectionState ?? null,
      session: p.conn.session,
      publishing: p.conn.publishing,
      transceivers: pc?.getTransceivers().length ?? 0,
      received: [...p.received.values()].map((r) => ({ from: r.from, role: r.role, kind: r.track.kind, live: r.track.readyState === 'live' })),
      states: Object.fromEntries(p.states),
      inbound, sent, outbound,
      errors: p.errors,
    };
  }
  return out;
}

(window as unknown as Record<string, unknown>).__loop = { join, leave, camera, screen, restart, report, actions: () => loop.actions.slice() };
