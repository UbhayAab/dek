// OWNER: core platform builder. Implements RealtimeHub (./types.ts).
//
// One realtime socket per browser (DEK07, DEKA10). Tabs elect a leader with the Web
// Locks API; the leader owns the Supabase private channels for the union of the
// topics every tab wants (bootstrap u:/s: topics, t: view topics, call: topics) and
// relays what arrives to the other tabs over BroadcastChannel('dek-realtime').
// Followers forward typing and call signals to the leader. When the leader tab
// closes its lock is released, the next tab takes over and rejoins. Without Web
// Locks or BroadcastChannel every tab simply connects on its own.
//
// The leader owns the resubscribe state machine: realtime-js drops an errored
// channel and never re-adds it (LESSONS "Realtime"). On CHANNEL_ERROR, TIMED_OUT or
// CLOSED a topic backs off 1 s to 30 s with jitter, refreshes the token first, and
// rejoins; visibility return and the online event force a fresh socket because a
// sleeping socket looks joined for about 35 s. onReconnected fires after every
// rejoin so the app heals by cursor. Server events are de-duplicated by payload.eid.
import { backoffDelay, REJOIN_BACKOFF } from '../lib/backoff';
import { LruSet } from '../lib/lru';
import { browserEnv, type BusLike, type HubEnv, type SubStatus, type Transport, type WireChannel, type WireMessage } from './env';
import type {
  CallSignal, ConnStatus, HubDebug, RealtimeHub, ReconnectReason, ServerEvent, ServerEventName, TypingSignal,
} from './types';

export type { BusLike, HubEnv, LocksLike, SubStatus, Transport, WireChannel, WireMessage } from './env';
export { browserEnv } from './env';

// ------------------------------------------------------------------ constants

const LOCK_NAME = 'dek-realtime-leader';
const DEDUPE_CAPACITY = 2_000;
const WANT_REFRESH_MS = 30_000;    // followers re-announce their topics
const WANT_TTL_MS = 75_000;        // a follower that stopped announcing is gone
const WAVE_MS = 2_000;             // joins this soon after taking over count as the takeover
const HEAL_DEBOUNCE_MS = 250;      // one onReconnected per wave of rejoins
const RESUME_AFTER_HIDDEN_MS = 30_000;
const DENIED_RETRY_MS = 120_000;   // a topic the server refuses is retried slowly
const RESET_COOLDOWN_MS = 5_000;
const DENIED_RE = /unauthori[sz]ed|not authori[sz]ed|permission|denied|forbidden/i;
// A join refused because the access token expired or is invalid is not a denial of
// the topic: it is retried on the normal schedule, and at once when the token is
// refreshed (retryNow).
const TOKEN_RE = /token|jwt|expired|claims/i;
const SERVER_EVENTS = new Set<ServerEventName>([
  'msg.new', 'msg.upd', 'read', 'chan.upd', 'member.upd', 'access.revoked', 'call.ring', 'call.upd',
  'server.upd', 'org.upd', 'chan.self', 'saved.upd', 'join.req',
]);

// ------------------------------------------------------------------ bus protocol

type BusBody =
  | { t: 'hello' }
  | { t: 'leader' }
  | { t: 'want'; topics: string[] }
  | { t: 'bye' }
  | { t: 'event'; topic: string; e: ServerEvent }
  | { t: 'typing'; channelId: string; signal: TypingSignal }
  | { t: 'signal'; callId: string; signal: CallSignal }
  | { t: 'status'; status: ConnStatus }
  | { t: 'reconnected'; reason: ReconnectReason }
  | { t: 'send-typing'; channelId: string; threadRootId: string | null }
  | { t: 'send-signal'; callId: string; signal: CallSignal }
  | { t: 'poke' };

type BusMessage = BusBody & { tab: string; uid: string | null };

interface TopicState {
  topic: string;
  ch: WireChannel | null;
  state: 'joining' | 'joined' | 'retrying' | 'denied' | 'leaving';
  attempts: number;
  gen: number;
  timer: ReturnType<typeof setTimeout> | null;
  removing: Promise<void> | null;
  heal: ReconnectReason | null;
}

type Role = 'stopped' | 'follower' | 'leader';

function topicId(topic: string, prefix: string): string | null {
  return topic.startsWith(prefix) ? topic.slice(prefix.length) : null;
}

function isServerEvent(m: WireMessage): m is WireMessage & { event: ServerEventName } {
  return SERVER_EVENTS.has(m.event as ServerEventName);
}

// The event id (migration 0900: "eid"; "id" is the scope id of access.revoked and
// member.upd, so it must never be used to de-duplicate).
function eventId(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'eid' in payload) {
    const id = (payload as { eid: unknown }).eid;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  }
  return null;
}

// Connection status follows the topics that carry messages (u:, s:). A view topic
// (typing) or a call topic that cannot join must not show "Reconnecting".
function carriesMessages(topic: string): boolean {
  return topic.startsWith('u:') || topic.startsWith('s:');
}

// ------------------------------------------------------------------ the hub

export class Hub implements RealtimeHub {
  private role: Role = 'stopped';
  private readonly tabId: string;
  private uid: string | null = null;
  private bus: BusLike | null = null;
  private lockAbort: AbortController | null = null;
  private releaseLock: (() => void) | null = null;
  private sawLeader = false;
  private lastStatus: ConnStatus = 'idle';
  private everOnline = false;
  private hiddenAt: number | null = null;
  private healTimer: ReturnType<typeof setTimeout> | null = null;
  private healReason: ReconnectReason | null = null;
  private wantTimer: ReturnType<typeof setInterval> | null = null;
  private waveUntil = 0;
  private waveReason: ReconnectReason = 'initial';
  private unlisten: (() => void)[] = [];
  private resetting = false;
  private lastResetAt = Number.NEGATIVE_INFINITY;
  private deferredReset: ReturnType<typeof setTimeout> | null = null;

  // what this tab wants
  private baseTopics: string[] = [];
  private readonly views = new Map<string, number>();
  private readonly calls = new Map<string, number>();

  // leader only
  private readonly wants = new Map<string, { topics: Set<string>; at: number }>();
  private readonly topics = new Map<string, TopicState>();
  // A dropped topic's channel is still leaving for a moment; supabase.channel()
  // would hand that same leaving channel back if the topic were joined again now.
  private readonly removals = new Map<string, Promise<void>>();
  private transportRef: Transport | null = null;

  private readonly seen = new LruSet(DEDUPE_CAPACITY);
  private readonly eventHandlers = new Set<(e: ServerEvent, topic: string) => void>();
  private readonly statusHandlers = new Set<(s: ConnStatus) => void>();
  private readonly reconnectHandlers = new Set<(reason: ReconnectReason) => void>();
  private readonly typingHandlers = new Set<(channelId: string, s: TypingSignal) => void>();
  private readonly signalHandlers = new Map<string, Set<(s: CallSignal) => void>>();
  private readonly leaderHandlers = new Set<(leader: boolean) => void>();

  constructor(private readonly env: HubEnv) {
    this.tabId = env.newTabId();
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.role !== 'stopped') return;
    this.role = 'follower';
    this.setStatus(this.env.online() ? 'connecting' : 'offline');
    const locks = this.env.locks();
    const bus = locks ? this.env.openBus() : null;
    this.listenToEnvironment();
    if (!locks || !bus) {
      bus?.close();
      this.becomeLeader('initial');
      return;
    }
    this.bus = bus;
    bus.addEventListener('message', (e) => this.onBus(e.data as BusMessage));
    this.post({ t: 'hello' });
    this.post({ t: 'want', topics: this.myTopics() });
    this.wantTimer = setInterval(() => {
      if (this.role === 'follower') this.post({ t: 'want', topics: this.myTopics() });
      else if (this.role === 'leader') this.reconcile();
    }, WANT_REFRESH_MS);
    const abort = new AbortController();
    this.lockAbort = abort;
    locks.request(LOCK_NAME, { signal: abort.signal }, () => new Promise<void>((release) => {
      if (this.role === 'stopped' || abort.signal.aborted) {
        release();
        return;
      }
      this.releaseLock = release;
      this.becomeLeader(this.sawLeader ? 'takeover' : 'initial');
    })).catch(() => undefined);
  }

  stop(): void {
    if (this.role === 'stopped') return;
    const wasLeader = this.role === 'leader';
    this.role = 'stopped';
    this.post({ t: 'bye' });
    for (const ts of this.topics.values()) this.dropTopic(ts);
    this.topics.clear();
    this.wants.clear();
    this.removals.clear();
    if (this.transportRef) {
      const t = this.transportRef;
      void t.reset().catch(() => undefined);
    }
    this.transportRef = null;
    this.lockAbort?.abort();
    this.lockAbort = null;
    this.releaseLock?.();
    this.releaseLock = null;
    if (this.wantTimer) clearInterval(this.wantTimer);
    this.wantTimer = null;
    if (this.healTimer) clearTimeout(this.healTimer);
    this.healTimer = null;
    this.healReason = null;
    if (this.deferredReset) clearTimeout(this.deferredReset);
    this.deferredReset = null;
    this.lastResetAt = Number.NEGATIVE_INFINITY;
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.bus?.close();
    this.bus = null;
    this.sawLeader = false;
    this.everOnline = false;
    this.seen.clear();
    this.baseTopics = [];
    this.views.clear();
    this.calls.clear();
    this.setStatus('idle');
    if (wasLeader) this.emitLeader(false);
  }

  setIdentity(userId: string | null): void {
    this.uid = userId;
  }

  // The access token changed (refreshed after being expired): every topic that is
  // not joined, including ones the server refused, tries again now instead of at
  // the end of its backoff. In a follower tab, the leader is asked to do it.
  retryNow(): void {
    if (this.role === 'follower') {
      this.post({ t: 'poke' });
      return;
    }
    if (this.role !== 'leader') return;
    if (Array.from(this.topics.values()).some((t) => t.state !== 'joined')) void this.forceReconnect('resume');
  }

  isLeader(): boolean {
    return this.role === 'leader';
  }

  // ---------------------------------------------------------------- wants

  setTopics(topics: string[]): void {
    this.baseTopics = Array.from(new Set(topics.filter((t) => typeof t === 'string' && t.length > 0)));
    this.wantsChanged();
  }

  joinView(channelId: string): void {
    this.views.set(channelId, (this.views.get(channelId) ?? 0) + 1);
    this.wantsChanged();
  }

  leaveView(channelId: string): void {
    const n = (this.views.get(channelId) ?? 0) - 1;
    if (n > 0) this.views.set(channelId, n);
    else this.views.delete(channelId);
    this.wantsChanged();
  }

  joinCall(callId: string): void {
    this.calls.set(callId, (this.calls.get(callId) ?? 0) + 1);
    this.wantsChanged();
  }

  leaveCall(callId: string): void {
    const n = (this.calls.get(callId) ?? 0) - 1;
    if (n > 0) this.calls.set(callId, n);
    else this.calls.delete(callId);
    this.wantsChanged();
  }

  private myTopics(): string[] {
    const out = new Set(this.baseTopics);
    for (const id of this.views.keys()) out.add(`t:${id}`);
    for (const id of this.calls.keys()) out.add(`call:${id}`);
    return Array.from(out);
  }

  private wantsChanged(): void {
    if (this.role === 'leader') {
      this.wants.set(this.tabId, { topics: new Set(this.myTopics()), at: this.env.now() });
      this.reconcile();
    } else if (this.role === 'follower') {
      this.post({ t: 'want', topics: this.myTopics() });
    }
  }

  // ---------------------------------------------------------------- sends

  sendTyping(channelId: string, threadRootId: string | null): void {
    if (this.role === 'leader') this.leaderSendTyping(channelId, threadRootId, this.uid);
    else if (this.role === 'follower') this.post({ t: 'send-typing', channelId, threadRootId });
  }

  sendSignal(callId: string, signal: CallSignal): void {
    if (this.role === 'leader') this.leaderSend(`call:${callId}`, 'signal', signal);
    else if (this.role === 'follower') this.post({ t: 'send-signal', callId, signal });
  }

  private leaderSendTyping(channelId: string, threadRootId: string | null, userId: string | null): void {
    if (!userId) return;
    const signal: TypingSignal = { user_id: userId, thread_root_id: threadRootId };
    this.leaderSend(`t:${channelId}`, 'typing', signal);
  }

  private leaderSend(topic: string, event: string, payload: unknown): void {
    const ts = this.topics.get(topic);
    if (!ts || ts.state !== 'joined' || !ts.ch) return;   // best effort, like typing itself
    void ts.ch.send(event, payload).catch(() => undefined);
  }

  // ---------------------------------------------------------------- subscriptions

  onEvent(handler: (e: ServerEvent, topic: string) => void): () => void {
    this.eventHandlers.add(handler);
    return () => { this.eventHandlers.delete(handler); };
  }

  status(): ConnStatus {
    return this.lastStatus;
  }

  onStatus(handler: (s: ConnStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => { this.statusHandlers.delete(handler); };
  }

  onReconnected(handler: (reason: ReconnectReason) => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => { this.reconnectHandlers.delete(handler); };
  }

  onTyping(handler: (channelId: string, signal: TypingSignal) => void): () => void {
    this.typingHandlers.add(handler);
    return () => { this.typingHandlers.delete(handler); };
  }

  onSignal(callId: string, handler: (signal: CallSignal) => void): () => void {
    let set = this.signalHandlers.get(callId);
    if (!set) {
      set = new Set();
      this.signalHandlers.set(callId, set);
    }
    set.add(handler);
    return () => {
      const s = this.signalHandlers.get(callId);
      s?.delete(handler);
      if (s && s.size === 0) this.signalHandlers.delete(callId);
    };
  }

  onLeaderChange(handler: (leader: boolean) => void): () => void {
    this.leaderHandlers.add(handler);
    return () => { this.leaderHandlers.delete(handler); };
  }

  debug(): HubDebug {
    const leader = this.role === 'leader';
    let socketConnected = false;
    if (leader && this.transportRef) {
      try {
        socketConnected = this.transportRef.isConnected();
      } catch {
        socketConnected = false;
      }
    }
    return {
      tabId: this.tabId,
      leader,
      status: this.lastStatus,
      socketConnected,
      wanted: this.myTopics().sort(),
      joined: leader ? Array.from(this.topics.values()).filter((t) => t.state === 'joined').map((t) => t.topic).sort() : [],
      tabs: leader ? this.wants.size : 0,
    };
  }

  // ---------------------------------------------------------------- leadership

  private becomeLeader(reason: ReconnectReason): void {
    if (this.role === 'stopped') return;
    this.role = 'leader';
    this.transportRef = this.env.transport();
    this.wants.set(this.tabId, { topics: new Set(this.myTopics()), at: this.env.now() });
    this.waveUntil = this.env.now() + WAVE_MS;
    this.waveReason = reason;
    this.post({ t: 'leader' });
    this.emitLeader(true);
    this.reconcile();
  }

  private emitLeader(leader: boolean): void {
    for (const h of this.leaderHandlers) {
      try { h(leader); } catch { /* a handler's bug must not break the hub */ }
    }
  }

  private transport(): Transport {
    if (!this.transportRef) this.transportRef = this.env.transport();
    return this.transportRef;
  }

  private desired(): Set<string> {
    const now = this.env.now();
    const out = new Set<string>();
    for (const [tab, w] of this.wants) {
      if (tab !== this.tabId && now - w.at > WANT_TTL_MS) {
        this.wants.delete(tab);
        continue;
      }
      for (const t of w.topics) out.add(t);
    }
    return out;
  }

  private reconcile(): void {
    if (this.role !== 'leader') return;
    this.wants.set(this.tabId, { topics: new Set(this.myTopics()), at: this.env.now() });
    const want = this.desired();
    for (const topic of want) {
      if (!this.topics.has(topic)) {
        const heal = this.env.now() <= this.waveUntil ? this.waveReason : null;
        const leaving = this.removals.get(topic) ?? null;
        const ts: TopicState = { topic, ch: null, state: 'joining', attempts: 0, gen: 0, timer: null, removing: leaving, heal };
        this.topics.set(topic, ts);
        if (leaving) {
          void leaving.then(() => {
            ts.removing = null;
            if (this.topics.get(topic) === ts && ts.state === 'joining' && !ts.ch) this.connect(ts);
          });
        } else {
          this.connect(ts);
        }
      }
    }
    for (const [topic, ts] of this.topics) {
      if (!want.has(topic)) {
        this.topics.delete(topic);
        this.dropTopic(ts);
      }
    }
    this.updateStatus();
  }

  private dropTopic(ts: TopicState): void {
    ts.state = 'leaving';
    ts.gen += 1;
    if (ts.timer) clearTimeout(ts.timer);
    ts.timer = null;
    const ch = ts.ch;
    ts.ch = null;
    if (ch && this.transportRef) this.trackRemoval(ts.topic, ch);
  }

  // Remove a channel and remember it until it is gone, so a join of the same
  // topic waits for it instead of getting the leaving channel back.
  private trackRemoval(topic: string, ch: WireChannel): Promise<void> {
    const p: Promise<void> = this.transport().remove(ch).catch(() => undefined).finally(() => {
      if (this.removals.get(topic) === p) this.removals.delete(topic);
    });
    this.removals.set(topic, p);
    return p;
  }

  private connect(ts: TopicState): void {
    if (this.role !== 'leader' || this.topics.get(ts.topic) !== ts) return;
    ts.gen += 1;
    const gen = ts.gen;
    ts.state = 'joining';
    let ch: WireChannel;
    try {
      ch = this.transport().channel(ts.topic);
    } catch {
      this.retry(ts, false);
      return;
    }
    ts.ch = ch;
    ch.onMessage((m) => {
      if (this.topics.get(ts.topic) === ts && ts.gen === gen) this.onWire(ts.topic, m);
    });
    ch.subscribe((status, err) => this.onSubscribe(ts, gen, status, err));
  }

  private onSubscribe(ts: TopicState, gen: number, status: SubStatus, err?: Error): void {
    if (this.role !== 'leader' || this.topics.get(ts.topic) !== ts || ts.gen !== gen || ts.state === 'leaving') return;
    if (status === 'SUBSCRIBED') {
      ts.state = 'joined';
      ts.attempts = 0;
      if (ts.heal) this.queueHeal(ts.heal);
      ts.heal = null;
      this.updateStatus();
      return;
    }
    // A call topic is refused until answer_call or join_room commits, which can race
    // the join: keep it on the normal backoff instead of the slow denied schedule.
    const msg = err?.message ?? '';
    const denied = status === 'CHANNEL_ERROR' && DENIED_RE.test(msg) && !TOKEN_RE.test(msg) && !ts.topic.startsWith('call:');
    ts.heal = ts.heal ?? 'rejoin';
    this.retry(ts, denied);
  }

  private retry(ts: TopicState, denied: boolean): void {
    if (ts.timer) clearTimeout(ts.timer);
    ts.gen += 1;
    const old = ts.ch;
    ts.ch = null;
    ts.state = denied ? 'denied' : 'retrying';
    ts.attempts += 1;
    ts.removing = old ? this.trackRemoval(ts.topic, old) : null;
    const delay = denied ? DENIED_RETRY_MS : backoffDelay(ts.attempts, { ...REJOIN_BACKOFF, random: this.env.random });
    ts.timer = setTimeout(() => {
      ts.timer = null;
      void this.rejoin(ts);
    }, delay);
    this.updateStatus();
  }

  private async rejoin(ts: TopicState): Promise<void> {
    if (this.role !== 'leader' || this.topics.get(ts.topic) !== ts) return;
    if (!this.env.online()) {
      // Offline: wait for the online event, which forces a reconnect.
      ts.state = 'retrying';
      this.updateStatus();
      return;
    }
    const gen = ts.gen;
    if (ts.removing) await ts.removing;
    ts.removing = null;
    try {
      await this.transport().refreshAuth();   // an expired token is the usual reason a join fails
    } catch {
      /* join anyway; a failure comes back as CHANNEL_ERROR and backs off */
    }
    if (this.topics.get(ts.topic) !== ts || ts.gen !== gen) return;
    this.connect(ts);
  }

  // Tear every topic down, open a fresh socket, rejoin all (sleep, network change).
  private async forceReconnect(reason: ReconnectReason): Promise<void> {
    if (this.role !== 'leader') return;
    // Every tab hears 'online' and pokes the leader: one reset per burst is enough,
    // but a reset asked for during the cooldown still happens when it ends.
    const wait = this.lastResetAt + RESET_COOLDOWN_MS - this.env.now();
    if (this.resetting || wait > 0) {
      if (!this.deferredReset) {
        this.deferredReset = setTimeout(() => {
          this.deferredReset = null;
          void this.forceReconnect(reason);
        }, Math.max(wait, 500));
      }
      return;
    }
    this.resetting = true;
    this.lastResetAt = this.env.now();
    try {
      const removals: Promise<void>[] = [];
      for (const ts of this.topics.values()) {
        if (ts.timer) clearTimeout(ts.timer);
        ts.timer = null;
        ts.gen += 1;
        ts.attempts = 0;
        ts.state = 'retrying';
        ts.heal = reason;
        if (ts.ch) removals.push(this.trackRemoval(ts.topic, ts.ch));
        ts.ch = null;
        ts.removing = null;
      }
      this.updateStatus();
      await Promise.all(removals);
      try {
        await this.transport().reset();
      } catch {
        /* the next join opens a socket anyway */
      }
      try {
        await this.transport().refreshAuth();
      } catch {
        /* see rejoin */
      }
      if (this.role !== 'leader') return;
      for (const ts of this.topics.values()) {
        if (ts.state === 'retrying' && !ts.ch && !ts.timer) this.connect(ts);
      }
    } finally {
      this.resetting = false;
    }
  }

  private queueHeal(reason: ReconnectReason): void {
    // 'initial' only stands when nothing stronger is queued with it.
    if (!this.healReason || this.healReason === 'initial') this.healReason = reason;
    if (this.healTimer) return;
    this.healTimer = setTimeout(() => {
      this.healTimer = null;
      const r = this.healReason ?? 'rejoin';
      this.healReason = null;
      this.fireReconnected(r);
      this.post({ t: 'reconnected', reason: r });
    }, HEAL_DEBOUNCE_MS);
  }

  private fireReconnected(reason: ReconnectReason): void {
    for (const h of this.reconnectHandlers) {
      try { h(reason); } catch { /* keep going */ }
    }
  }

  private updateStatus(): void {
    if (this.role !== 'leader') return;
    if (!this.env.online()) {
      this.setStatus('offline');
      return;
    }
    const live = Array.from(this.topics.values()).filter((t) => t.state !== 'denied' && carriesMessages(t.topic));
    if (live.length === 0) {
      // Nothing asked for yet (before bootstrap): not online in any useful sense.
      this.setStatus(this.everOnline ? 'online' : 'connecting');
      return;
    }
    const allJoined = live.every((t) => t.state === 'joined');
    if (allJoined) {
      this.everOnline = true;
      this.setStatus('online');
    } else {
      this.setStatus(this.everOnline ? 'reconnecting' : 'connecting');
    }
  }

  private setStatus(s: ConnStatus): void {
    if (s === this.lastStatus) return;
    this.lastStatus = s;
    if (this.role === 'leader') this.post({ t: 'status', status: s });
    for (const h of this.statusHandlers) {
      try { h(s); } catch { /* keep going */ }
    }
  }

  // ---------------------------------------------------------------- inbound

  // What each topic may carry. t: and call: are writable by every client that may
  // read them (RLS cannot filter by event name), so nothing that arrives there is
  // trusted as a server event: a reader could otherwise broadcast access.revoked,
  // org.upd or a msg.new with someone else's author id. Server events come only
  // from u: and s:, which no client can write (call.upd reaches participants on
  // their u: topic and room audiences through the channel's own topic).
  private onWire(topic: string, m: WireMessage): void {
    if (topic.startsWith('t:')) {
      if (m.event !== 'typing') return;
      const channelId = topicId(topic, 't:');
      const signal = m.payload as TypingSignal | null;
      if (!channelId || !signal || typeof signal.user_id !== 'string') return;
      const clean: TypingSignal = { user_id: signal.user_id, thread_root_id: typeof signal.thread_root_id === 'string' ? signal.thread_root_id : null };
      this.deliverTyping(channelId, clean);
      this.post({ t: 'typing', channelId, signal: clean });
      return;
    }
    if (topic.startsWith('call:')) {
      if (m.event !== 'signal') return;
      const callId = topicId(topic, 'call:');
      if (!callId || !m.payload || typeof m.payload !== 'object') return;
      const signal = m.payload as CallSignal;
      this.deliverSignal(callId, signal);
      this.post({ t: 'signal', callId, signal });
      return;
    }
    if (!carriesMessages(topic) || !isServerEvent(m)) return;
    const e = { event: m.event, payload: m.payload } as ServerEvent;
    if (this.deliverEvent(e, topic)) this.post({ t: 'event', topic, e });
  }

  // Returns false for a duplicate.
  private deliverEvent(e: ServerEvent, topic: string): boolean {
    const id = eventId(e.payload);
    if (id !== null && !this.seen.add(id)) return false;
    for (const h of this.eventHandlers) {
      try { h(e, topic); } catch { /* one screen's bug must not starve the others */ }
    }
    return true;
  }

  private deliverTyping(channelId: string, signal: TypingSignal): void {
    for (const h of this.typingHandlers) {
      try { h(channelId, signal); } catch { /* keep going */ }
    }
  }

  private deliverSignal(callId: string, signal: CallSignal): void {
    const set = this.signalHandlers.get(callId);
    if (!set) return;
    for (const h of set) {
      try { h(signal); } catch { /* keep going */ }
    }
  }

  private post(body: BusBody): void {
    if (!this.bus) return;
    try {
      this.bus.postMessage({ ...body, tab: this.tabId, uid: this.uid } satisfies BusMessage);
    } catch {
      /* channel closed */
    }
  }

  private onBus(m: BusMessage | null | undefined): void {
    if (!m || typeof m !== 'object' || m.tab === this.tabId || this.role === 'stopped') return;
    if (m.uid !== this.uid) return;   // another person's tab (mid sign-in switch): ignore
    switch (m.t) {
      case 'hello':
        if (this.role === 'leader') {
          this.post({ t: 'leader' });
          this.post({ t: 'status', status: this.lastStatus });
        }
        return;
      case 'leader':
        this.sawLeader = true;
        if (this.role === 'follower') this.post({ t: 'want', topics: this.myTopics() });
        return;
      case 'want':
        if (this.role === 'leader') {
          this.wants.set(m.tab, { topics: new Set(m.topics), at: this.env.now() });
          this.reconcile();
          this.post({ t: 'status', status: this.lastStatus });
        }
        return;
      case 'bye':
        if (this.role === 'leader' && this.wants.delete(m.tab)) this.reconcile();
        return;
      case 'event':
        if (this.role === 'follower' && typeof m.topic === 'string' && carriesMessages(m.topic)) {
          this.sawLeader = true;
          this.deliverEvent(m.e, m.topic);
        }
        return;
      case 'typing':
        if (this.role === 'follower') this.deliverTyping(m.channelId, m.signal);
        return;
      case 'signal':
        if (this.role === 'follower') this.deliverSignal(m.callId, m.signal);
        return;
      case 'status':
        if (this.role === 'follower') {
          this.sawLeader = true;
          this.setStatus(m.status);
        }
        return;
      case 'reconnected':
        if (this.role === 'follower') this.fireReconnected(m.reason);
        return;
      case 'send-typing':
        if (this.role === 'leader') this.leaderSendTyping(m.channelId, m.threadRootId, m.uid);
        return;
      case 'send-signal':
        if (this.role === 'leader') this.leaderSend(`call:${m.callId}`, 'signal', m.signal);
        return;
      case 'poke':
        if (this.role === 'leader') this.checkHealth(true);
        return;
    }
  }

  // ---------------------------------------------------------------- environment

  private listenToEnvironment(): void {
    this.unlisten.push(this.env.listen('window', 'online', () => {
      if (this.role === 'leader') {
        void this.forceReconnect('resume');
      } else if (this.role === 'follower') {
        this.post({ t: 'poke' });
      }
    }));
    this.unlisten.push(this.env.listen('window', 'offline', () => {
      if (this.role === 'leader') this.updateStatus();
      else if (this.role === 'follower') this.setStatus('offline');
    }));
    this.unlisten.push(this.env.listen('document', 'visibilitychange', () => {
      if (this.env.hidden()) {
        this.hiddenAt = this.env.now();
        return;
      }
      const sleptLong = this.hiddenAt !== null && this.env.now() - this.hiddenAt >= RESUME_AFTER_HIDDEN_MS;
      this.hiddenAt = null;
      if (this.role === 'leader') this.checkHealth(sleptLong);
      else if (this.role === 'follower' && sleptLong) this.post({ t: 'poke' });
    }));
    this.unlisten.push(this.env.listen('window', 'pagehide', () => {
      this.post({ t: 'bye' });
    }));
  }

  private checkHealth(force: boolean): void {
    if (this.role !== 'leader' || !this.env.online()) return;
    let connected = true;
    try {
      connected = this.transport().isConnected();
    } catch {
      connected = false;
    }
    // A join in flight is normal (it times out on its own); a topic waiting out a
    // backoff is what the person should not have to wait for after coming back.
    const broken = Array.from(this.topics.values()).some((t) => t.state === 'retrying' && carriesMessages(t.topic));
    if (force || !connected || broken) void this.forceReconnect('resume');
  }
}

export function createHub(env: HubEnv = browserEnv()): Hub {
  return new Hub(env);
}

export const hub: Hub = createHub();
