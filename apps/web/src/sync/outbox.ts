// The durable outbox (DEK06, DEKA03, LESSONS "Durable sending").
//
// - A send is written to storage (IndexedDB, localStorage fallback) BEFORE the
//   network is touched, so a reload, a killed tab or a dropped connection cannot
//   lose it, and every replay uses the ORIGINAL client id (the server returns the
//   same row for a repeated (author, client_id)).
// - Per channel FIFO with one request in flight per channel: the server assigns
//   seq at insert, so the flush order is the message order.
// - Network errors, timeouts, server errors, 429 and auth_required retry with
//   backoff 2 s to 120 s plus jitter; anything else becomes `failed` with the
//   server's hint, and the person chooses Try again or Delete.
// - Delivery state becomes visible only after 900 ms; a terminal failure at once.
// - Records belong to the tab that wrote them; a tab adopts records whose owner tab
//   is gone, so two open tabs never both retry the same message.
import type { Message } from '../api/types';
import { toDekError } from '../api/errors';
import { backoffDelay, SEND_BACKOFF } from '../lib/backoff';
import { newId } from '../lib/uuid';
import type { PendingMessage } from '../store/state';

export const STATUS_DELAY_MS = 900;

export interface OutboxRecord extends PendingMessage {
  ownerTab: string | null;
}

export interface OutboxInput {
  orgId: string;
  channelId: string;
  threadRootId: string | null;
  body: string;
  attachmentIds: string[];
  alsoInChannel: boolean;
}

export interface OutboxStorage {
  load(): Promise<OutboxRecord[]>;
  save(rec: OutboxRecord): Promise<void>;
  remove(clientId: string): Promise<void>;
}

export interface OutboxDeps {
  storage: OutboxStorage;
  send(rec: OutboxRecord): Promise<Message>;
  onUpdate(clientId: string, rec: PendingMessage | null): void;
  onAccepted(clientId: string, msg: Message): void;
  tabId: string;
  isTabAlive?(tabId: string): Promise<boolean>;
  now?(): number;
  random?(): number;
}

type Timer = ReturnType<typeof setTimeout>;

const byAge = (a: OutboxRecord, b: OutboxRecord) => a.createdAt - b.createdAt || a.clientId.localeCompare(b.clientId);

export class Outbox {
  private readonly recs = new Map<string, OutboxRecord>();
  private readonly writing = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<string, string>();   // channelId -> clientId
  private readonly wakeTimers = new Map<string, Timer>();
  private readonly revealTimers = new Map<string, Timer>();
  private readonly discardAfterFlight = new Set<string>();
  private readonly accessDropped = new Set<string>();
  private readonly droppedChannels = new Set<string>();
  // Seen delivered (realtime msg.new with this client id) while our own request
  // was still out: hidden at once, and done whatever that request answers.
  private readonly settledInFlight = new Set<string>();
  private gen = 0;
  private stopped = false;
  // Strictly increasing creation stamps: two sends in the same millisecond must
  // keep the order they were typed in (the FIFO sorts by createdAt).
  private lastCreatedAt = 0;

  constructor(private readonly deps: OutboxDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ------------------------------------------------------------ public

  // Load what an earlier page or tab left behind and start flushing it. Single
  // flight: kick() calls it too, and two reads at once must not add a row twice.
  private loading: Promise<void> | null = null;
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.loadOnce().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async loadOnce(): Promise<void> {
    const gen = this.gen;
    const rows = (await this.deps.storage.load()).slice().sort(byAge);
    if (gen !== this.gen || this.stopped) return;
    const touched = new Set<string>();
    for (const row of rows) {
      if(this.recs.has(row.clientId))continue;
      if(this.droppedChannels.has(row.channelId)) {void this.unstore(row.clientId);continue;}
      this.lastCreatedAt = Math.max(this.lastCreatedAt, row.createdAt);
      const mine = row.ownerTab === this.deps.tabId;
      const orphan = !row.ownerTab || (!mine && !(await this.alive(row.ownerTab)));
      if (gen !== this.gen || this.stopped) return;
      if(this.droppedChannels.has(row.channelId)) {void this.unstore(row.clientId);continue;}
      // It has waited longer than 900 ms already: show its state at once. A record
      // that was mid-attempt when the page died is simply tried again now.
      const rec: OutboxRecord = {
        ...row,
        statusVisible: true,
        status: row.status === 'failed' ? 'failed' : row.attempts > 0 ? 'retrying' : 'pending',
        nextAttemptAt: row.status === 'failed' ? null : 0,
        ownerTab: mine || orphan ? this.deps.tabId : row.ownerTab,
      };
      this.recs.set(rec.clientId, rec);
      this.deps.onUpdate(rec.clientId, rec);
      if (orphan) void this.persist(rec);
      touched.add(rec.channelId);
    }
    for (const ch of touched) this.pump(ch);
  }

  enqueue(input: OutboxInput, clientId: string = newId()): string {
    const createdAt = Math.max(this.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    const rec: OutboxRecord = {
      clientId,
      orgId: input.orgId,
      channelId: input.channelId,
      threadRootId: input.threadRootId,
      body: input.body,
      attachmentIds: input.attachmentIds.slice(),
      alsoInChannel: input.alsoInChannel,
      status: 'pending',
      attempts: 0,
      createdAt,
      nextAttemptAt: null,
      error: null,
      statusVisible: false,
      ownerTab: this.deps.tabId,
    };
    this.recs.set(clientId, rec);
    this.deps.onUpdate(clientId, rec);
    this.scheduleReveal(clientId);
    // Durable first, network second.
    void this.persist(rec).then(() => this.pump(rec.channelId));
    return clientId;
  }

  retry(clientId: string): void {
    const rec = this.recs.get(clientId);
    if (!rec || this.isInFlight(clientId)) return;
    const next: OutboxRecord = { ...rec, status: 'pending', attempts: 0, nextAttemptAt: null, error: null, statusVisible: true, ownerTab: this.deps.tabId };
    this.recs.set(clientId, next);
    this.deps.onUpdate(clientId, next);
    void this.persist(next).then(() => this.pump(next.channelId));
  }

  discard(clientId: string): void {
    const rec = this.recs.get(clientId);
    if (!rec) return;
    if (this.isInFlight(clientId)) {
      // Already on the wire: if it lands it is a real message; if it fails it goes.
      this.discardAfterFlight.add(clientId);
      return;
    }
    this.forget(clientId);
    void this.unstore(clientId);
    this.pump(rec.channelId);
  }

  // Connectivity is back (online event, realtime rejoined): retry now, not at the
  // end of a long backoff. Also reads storage again (a tab that closed may have left
  // a message this tab has never seen) and adopts records of closed tabs.
  kick(): void {
    if (this.stopped) return;
    for (const [id, rec] of this.recs) {
      if (rec.status === 'retrying' && !this.isInFlight(id)) {
        this.recs.set(id, { ...rec, nextAttemptAt: 0 });
      }
    }
    for (const t of this.wakeTimers.values()) clearTimeout(t);
    this.wakeTimers.clear();
    void this.load()
      .then(() => this.adoptOrphans())
      .then(() => {
        for (const ch of this.channels()) this.pump(ch);
      });
  }

  // A message accepted elsewhere (realtime msg.new with my client id, another tab).
  settle(clientId: string): void {
    if (!this.recs.has(clientId)) return;
    if (this.isInFlight(clientId)) {
      if (this.settledInFlight.has(clientId)) return;
      this.settledInFlight.add(clientId);
      const t = this.revealTimers.get(clientId);
      if (t) clearTimeout(t);
      this.revealTimers.delete(clientId);
      this.deps.onUpdate(clientId, null);
      return;
    }
    const rec = this.recs.get(clientId)!;
    this.forget(clientId);
    void this.unstore(clientId);
    this.pump(rec.channelId);
  }

  // Drop records for channels the person lost access to.
  dropChannels(channelIds: ReadonlySet<string>): void {
    for(const id of channelIds)this.droppedChannels.add(id);
    for (const [id, rec] of this.recs) {
      if (!channelIds.has(rec.channelId)) continue;
      if (this.isInFlight(id)) this.accessDropped.add(id);
      this.forget(id);
      void this.unstore(id);
    }
  }

  stop(): void {
    this.stopped = true;
    this.gen += 1;
    for (const t of this.wakeTimers.values()) clearTimeout(t);
    for (const t of this.revealTimers.values()) clearTimeout(t);
    this.wakeTimers.clear();
    this.revealTimers.clear();
    this.recs.clear();
    this.inFlight.clear();
    this.writing.clear();
    this.discardAfterFlight.clear();
    this.accessDropped.clear();
    this.droppedChannels.clear();
    this.settledInFlight.clear();
  }

  snapshot(): OutboxRecord[] {
    return Array.from(this.recs.values()).sort(byAge);
  }

  // ------------------------------------------------------------ engine

  private channels(): Set<string> {
    return new Set(Array.from(this.recs.values(), (r) => r.channelId));
  }

  private isInFlight(clientId: string): boolean {
    for (const id of this.inFlight.values()) if (id === clientId) return true;
    return false;
  }

  private async alive(tabId: string): Promise<boolean> {
    if (!this.deps.isTabAlive) return false;
    try {
      return await this.deps.isTabAlive(tabId);
    } catch {
      return false;
    }
  }

  private async adoptOrphans(): Promise<void> {
    for (const [id, rec] of this.recs) {
      if (rec.ownerTab === this.deps.tabId) continue;
      if (rec.ownerTab && (await this.alive(rec.ownerTab))) continue;
      const cur = this.recs.get(id);
      if (!cur) continue;
      const next = { ...cur, ownerTab: this.deps.tabId };
      this.recs.set(id, next);
      void this.persist(next);
    }
  }

  // Storage writes for one record run in order, so a delete can never land before
  // the save it follows (which would bring a sent message back on the next load).
  private chain(clientId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.writing.get(clientId) ?? Promise.resolve();
    const p: Promise<void> = prev
      .then(op)
      .catch(() => undefined)
      .finally(() => {
        if (this.writing.get(clientId) === p) this.writing.delete(clientId);
      });
    this.writing.set(clientId, p);
    return p;
  }

  private persist(rec: OutboxRecord): Promise<void> {
    return this.chain(rec.clientId, () => this.deps.storage.save(rec));
  }

  private unstore(clientId: string): Promise<void> {
    return this.chain(clientId, () => this.deps.storage.remove(clientId));
  }

  private forget(clientId: string): void {
    this.recs.delete(clientId);
    const t = this.revealTimers.get(clientId);
    if (t) clearTimeout(t);
    this.revealTimers.delete(clientId);
    this.discardAfterFlight.delete(clientId);
    const hidden = this.settledInFlight.delete(clientId);
    if (!hidden) this.deps.onUpdate(clientId, null);
  }

  private scheduleReveal(clientId: string): void {
    const t = setTimeout(() => {
      this.revealTimers.delete(clientId);
      const rec = this.recs.get(clientId);
      if (!rec || rec.statusVisible) return;
      const next = { ...rec, statusVisible: true };
      this.recs.set(clientId, next);
      this.deps.onUpdate(clientId, next);
    }, STATUS_DELAY_MS);
    this.revealTimers.set(clientId, t);
  }

  // The oldest record of the channel that this tab may send. A failed one is out
  // of the line (the person decides), so later messages are not held hostage.
  private head(channelId: string): OutboxRecord | null {
    let best: OutboxRecord | null = null;
    for (const r of this.recs.values()) {
      if (r.channelId !== channelId || r.status === 'failed' || r.ownerTab !== this.deps.tabId) continue;
      if (!best || byAge(r, best) < 0) best = r;
    }
    return best;
  }

  private pump(channelId: string): void {
    if (this.stopped || this.inFlight.has(channelId)) return;
    const rec = this.head(channelId);
    if (!rec) return;
    if (this.writing.has(rec.clientId)) {
      void this.writing.get(rec.clientId)!.then(() => this.pump(channelId));
      return;
    }
    const wait = (rec.nextAttemptAt ?? 0) - this.now();
    if (wait > 0) {
      this.wake(channelId, wait);
      return;
    }
    this.inFlight.set(channelId, rec.clientId);
    void this.attempt(rec.clientId);
  }

  private wake(channelId: string, delay: number): void {
    const old = this.wakeTimers.get(channelId);
    if (old) clearTimeout(old);
    this.wakeTimers.set(channelId, setTimeout(() => {
      this.wakeTimers.delete(channelId);
      this.pump(channelId);
    }, delay));
  }

  private async attempt(clientId: string): Promise<void> {
    const gen = this.gen;
    const start = this.recs.get(clientId);
    if (!start) {
      this.inFlight.forEach((id, ch) => { if (id === clientId) this.inFlight.delete(ch); });
      return;
    }
    const sending: OutboxRecord = { ...start, attempts: start.attempts + 1 };
    this.recs.set(clientId, sending);
    try {
      const msg = await this.deps.send(sending);
      if (gen !== this.gen) return;
      this.inFlight.delete(sending.channelId);
      const accessDropped=this.accessDropped.delete(clientId);
      this.forget(clientId);
      void this.unstore(clientId);
      if(!accessDropped)this.deps.onAccepted(clientId, msg);
    } catch (e) {
      if (gen !== this.gen) return;
      this.inFlight.delete(sending.channelId);
      this.accessDropped.delete(clientId);
      const cur = this.recs.get(clientId);
      if (cur && (this.discardAfterFlight.has(clientId) || this.settledInFlight.has(clientId))) {
        // Discarded meanwhile, or already delivered (the answer was lost, not the message).
        this.forget(clientId);
        void this.unstore(clientId);
      } else if (cur) {
        const err = toDekError(e);
        if (err.retryable) {
          const delay = backoffDelay(cur.attempts, { ...SEND_BACKOFF, random: this.deps.random ?? Math.random });
          const next: OutboxRecord = { ...cur, status: 'retrying', nextAttemptAt: this.now() + delay, error: { code: err.code, hint: err.hint } };
          this.recs.set(clientId, next);
          this.deps.onUpdate(clientId, next);
          void this.persist(next);
        } else {
          const next: OutboxRecord = { ...cur, status: 'failed', nextAttemptAt: null, error: { code: err.code, hint: err.hint }, statusVisible: true };
          this.recs.set(clientId, next);
          this.deps.onUpdate(clientId, next);
          void this.persist(next);
        }
      }
    }
    this.pump(sending.channelId);
  }
}
