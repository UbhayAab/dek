import { describe, expect, test } from 'vitest';
import type { LinkSignalKind, LinkState, PeerLink } from '../../src/features/calls/link';
import { CallMesh, isPolite, type Member } from '../../src/features/calls/mesh';
import type { CallSignal } from '../../src/realtime/types';
import { ManualTimers } from './fakeRtc';

class StubLink {
  readonly handled: [LinkSignalKind, unknown][] = [];
  state: LinkState = 'connecting';
  isClosed = false;
  constructor(readonly member: Member, readonly polite: boolean, readonly send: (k: LinkSignalKind, d: unknown) => void) {}
  handle(kind: LinkSignalKind, data: unknown): Promise<void> {
    this.handled.push([kind, data]);
    return Promise.resolve();
  }
  close(): void {
    this.isClosed = true;
    this.state = 'closed';
  }
}

const ME = { user: 'user-alice', session: 'sess-5' };

function setup(maxPeers?: number) {
  const timers = new ManualTimers();
  const sent: CallSignal[] = [];
  const links: StubLink[] = [];
  const unknown: string[] = [];
  let changes = 0;
  const mesh = new CallMesh({
    localUser: ME.user,
    localSession: ME.session,
    maxPeers,
    timers,
    send: (s) => sent.push(s),
    createLink: (member, polite, send) => {
      const l = new StubLink(member, polite, send);
      links.push(l);
      return l as unknown as PeerLink;
    },
    onUnknownSession: (s) => unknown.push(s),
    onChange: () => { changes += 1; },
  });
  const link = (session: string) => links.filter((l) => l.member.sessionId === session).pop();
  return { mesh, timers, sent, links, link, unknown, changes: () => changes };
}

const sig = (from_session: string, from_user: string, kind: CallSignal['kind'], data: unknown = null, to_session: string | null = ME.session): CallSignal =>
  ({ from_user, from_session, to_session, kind, data });

describe('call mesh: links follow the server roster', () => {
  test('one link per other joined session; me excluded; polite decided by session ids; a hello to each', () => {
    const t = setup();
    t.mesh.setRoster([
      { userId: ME.user, sessionId: ME.session },
      { userId: 'user-bob', sessionId: 'sess-2' },
      { userId: 'user-ravi', sessionId: 'sess-9' },
    ]);
    expect(t.links.map((l) => l.member.userId)).toEqual(['user-bob', 'user-ravi']);
    expect(t.link('sess-2')?.polite).toBe(true);    // 'sess-5' > 'sess-2'
    expect(t.link('sess-9')?.polite).toBe(false);   // 'sess-5' < 'sess-9'
    expect(isPolite('sess-5', 'sess-2')).toBe(!isPolite('sess-2', 'sess-5'));
    expect(t.sent.map((s) => `${s.kind}>${s.to_session}`)).toEqual(['hello>sess-2', 'hello>sess-9']);
    expect(t.sent[0]).toMatchObject({ from_user: ME.user, from_session: ME.session });
  });

  test('a link sends its signals to its own session only', () => {
    const t = setup();
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }]);
    t.link('sess-2')?.send('offer', { type: 'offer', sdp: 'x' });
    expect(t.sent[t.sent.length - 1]).toEqual({ from_user: ME.user, from_session: ME.session, to_session: 'sess-2', kind: 'offer', data: { type: 'offer', sdp: 'x' } });
  });

  test('signals routed by session; mine, and those for other sessions, are ignored', () => {
    const t = setup();
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }]);
    t.mesh.handle(sig('sess-2', 'user-bob', 'offer', { type: 'offer', sdp: 'o' }));
    t.mesh.handle(sig('sess-2', 'user-bob', 'ice', [{ candidate: 'c1' }], null));   // broadcast is fine
    t.mesh.handle(sig('sess-2', 'user-bob', 'answer', { type: 'answer', sdp: 'a' }, 'sess-other'));
    t.mesh.handle(sig(ME.session, ME.user, 'offer', { type: 'offer', sdp: 'echo' }));
    expect(t.link('sess-2')?.handled.map(([k]) => k)).toEqual(['offer', 'ice']);
  });

  test('a known session speaking under another person\'s name is not trusted', () => {
    const t = setup();
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }]);
    t.mesh.handle(sig('sess-2', 'user-mallory', 'offer', { type: 'offer', sdp: 'evil' }));
    expect(t.link('sess-2')?.handled).toEqual([]);
  });

  test('signals from a session the roster does not know yet are held, the roster refreshed, then released in order', () => {
    const t = setup();
    t.mesh.handle(sig('sess-7', 'user-ravi', 'offer', { type: 'offer', sdp: 'o7' }));
    t.mesh.handle(sig('sess-7', 'user-ravi', 'ice', [{ candidate: 'c1' }]));
    t.mesh.handle(sig('sess-7', 'user-ravi', 'ice', [{ candidate: 'c2' }]));
    expect(t.links).toHaveLength(0);   // nobody connects without the server saying they joined
    expect(t.unknown).toEqual(['sess-7', 'sess-7', 'sess-7']);
    expect(t.mesh.heldCount('sess-7')).toBe(3);
    t.mesh.setRoster([{ userId: 'user-ravi', sessionId: 'sess-7' }]);
    expect(t.link('sess-7')?.handled).toEqual([
      ['offer', { type: 'offer', sdp: 'o7' }], ['ice', [{ candidate: 'c1' }]], ['ice', [{ candidate: 'c2' }]],
    ]);
    expect(t.mesh.heldCount()).toBe(0);
  });

  test('a hello from an unknown session asks for the roster; it does not build a link by itself', () => {
    const t = setup();
    t.mesh.handle(sig('sess-8', 'user-x', 'hello', null, null));
    expect(t.unknown).toEqual(['sess-8']);
    expect(t.links).toHaveLength(0);
  });

  test('held signals are bounded per session and in total', () => {
    const timers = new ManualTimers();
    const mesh = new CallMesh({
      localUser: ME.user, localSession: ME.session, timers, holdPerSession: 3, holdSessions: 2,
      send: () => undefined, createLink: () => ({ handle: () => Promise.resolve(), close() {}, state: 'new', isClosed: false }) as unknown as PeerLink,
    });
    for (let i = 0; i < 10; i += 1) mesh.handle(sig('sess-a', 'u-a', 'ice', [{ candidate: `c${i}` }]));
    mesh.handle(sig('sess-b', 'u-b', 'ice', []));
    mesh.handle(sig('sess-c', 'u-c', 'ice', []));
    expect(mesh.heldCount('sess-a')).toBe(3);
    expect(mesh.heldCount('sess-b')).toBe(1);
    expect(mesh.heldCount('sess-c')).toBe(0);
  });

  test('bye closes the link at once', () => {
    const t = setup();
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }]);
    const before = t.changes();
    t.mesh.handle(sig('sess-2', 'user-bob', 'bye', null, null));
    expect(t.link('sess-2')?.isClosed).toBe(true);
    expect(t.mesh.sessions()).toHaveLength(0);
    expect(t.changes()).toBe(before + 1);
  });

  test('someone missing from one roster snapshot keeps the link through the grace; gone for good, it closes', () => {
    const t = setup();
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }]);
    t.mesh.setRoster([]);   // a stale snapshot
    t.timers.advance(1000);
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }]);   // back
    t.timers.advance(5000);
    expect(t.link('sess-2')?.isClosed).toBe(false);
    expect(t.links).toHaveLength(1);
    t.mesh.setRoster([]);
    t.timers.advance(1500);
    expect(t.link('sess-2')?.isClosed).toBe(true);
  });

  test('a reconnect with a new session id: a new link at once, the old one closed (DEKA13)', () => {
    const t = setup();
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }, { userId: 'user-ravi', sessionId: 'sess-9' }]);
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-3' }, { userId: 'user-ravi', sessionId: 'sess-9' }]);
    expect(t.link('sess-3')?.isClosed).toBe(false);
    expect(t.link('sess-9')?.isClosed).toBe(false);   // others continue untouched
    t.timers.advance(1500);
    expect(t.link('sess-2')?.isClosed).toBe(true);
    expect(t.mesh.sessions().map((s) => s.userId).sort()).toEqual(['user-bob', 'user-ravi']);
  });

  test('a link that gave up is rebuilt when the far side says hello again', () => {
    const t = setup();
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }]);
    const first = t.link('sess-2') as StubLink;
    first.state = 'failed';
    t.mesh.handle(sig('sess-2', 'user-bob', 'hello', null));
    expect(first.isClosed).toBe(true);
    expect(t.links).toHaveLength(2);
    expect(t.link('sess-2')?.isClosed).toBe(false);
  });

  test('a room mesh holds at most seven peers', () => {
    const t = setup();
    t.mesh.setRoster(Array.from({ length: 10 }, (_, i) => ({ userId: `u${i}`, sessionId: `s${i}` })));
    expect(t.mesh.sessions()).toHaveLength(7);
  });

  test('close() says bye to everyone and closes every link', () => {
    const t = setup();
    t.mesh.setRoster([{ userId: 'user-bob', sessionId: 'sess-2' }, { userId: 'user-ravi', sessionId: 'sess-9' }]);
    t.mesh.close(true);
    expect(t.sent[t.sent.length - 1]).toEqual({ from_user: ME.user, from_session: ME.session, to_session: null, kind: 'bye', data: null });
    expect(t.links.every((l) => l.isClosed)).toBe(true);
    t.mesh.handle(sig('sess-2', 'user-bob', 'offer', {}));
    expect(t.links.every((l) => l.handled.length === 0)).toBe(true);
  });
});
