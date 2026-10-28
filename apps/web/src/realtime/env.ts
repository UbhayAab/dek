// The realtime hub's seams and its real browser environment: the Supabase
// transport (one private channel per topic), Web Locks, BroadcastChannel, and the
// window and document events. Tests replace all of it with fakes (hub.test.ts).
import { supabase } from '../api/client';
import { newId } from '../lib/uuid';

// ------------------------------------------------------------------ seams (tests inject fakes)

export type SubStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export interface WireMessage {
  event: string;
  payload: unknown;
}

export interface WireChannel {
  onMessage(cb: (m: WireMessage) => void): void;
  subscribe(cb: (status: SubStatus, err?: Error) => void): void;
  send(event: string, payload: unknown): Promise<string>;
}

export interface Transport {
  channel(topic: string): WireChannel;
  remove(ch: WireChannel): Promise<void>;
  refreshAuth(): Promise<void>;
  reset(): Promise<void>;          // drop the socket so the next join opens a fresh one
  isConnected(): boolean;
}

export interface BusLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  close(): void;
}

export interface LocksLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>;
}

export interface HubEnv {
  transport: () => Transport;
  locks: () => LocksLike | null;
  openBus: () => BusLike | null;
  online: () => boolean;
  hidden: () => boolean;
  listen: (target: 'window' | 'document', type: string, fn: () => void) => () => void;
  now: () => number;
  random: () => number;
  newTabId: () => string;
}

export const BUS_NAME = 'dek-realtime';

// ------------------------------------------------------------------ the real environment

function supabaseTransport(): Transport {
  const sb = supabase();
  type Raw = ReturnType<typeof sb.channel>;
  const raw = new WeakMap<WireChannel, Raw>();
  return {
    channel(topic: string): WireChannel {
      const ch = sb.channel(topic, { config: { private: true, broadcast: { self: false, ack: false } } });
      const wire: WireChannel = {
        onMessage(cb) {
          ch.on('broadcast', { event: '*' }, (m: { event: string; payload: unknown }) => cb({ event: m.event, payload: m.payload }));
        },
        subscribe(cb) {
          ch.subscribe((status, err) => cb(status as SubStatus, err));
        },
        async send(event, payload) {
          return ch.send({ type: 'broadcast', event, payload });
        },
      };
      raw.set(wire, ch);
      return wire;
    },
    async remove(wire) {
      const ch = raw.get(wire);
      if (ch) await sb.removeChannel(ch);
    },
    async refreshAuth() {
      await sb.auth.getSession();
      await sb.realtime.setAuth();
    },
    async reset() {
      await Promise.race([sb.realtime.disconnect(), new Promise((r) => setTimeout(r, 3_000))]);
    },
    isConnected() {
      return sb.realtime.isConnected();
    },
  };
}

export function browserEnv(): HubEnv {
  return {
    transport: supabaseTransport,
    locks: () => (typeof navigator !== 'undefined' && navigator.locks ? (navigator.locks as unknown as LocksLike) : null),
    openBus: () => {
      try {
        return typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(BUS_NAME) as unknown as BusLike);
      } catch {
        return null;
      }
    },
    online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    listen: (target, type, fn) => {
      if (typeof window === 'undefined') return () => undefined;
      const t: EventTarget = target === 'document' ? document : window;
      t.addEventListener(type, fn);
      return () => t.removeEventListener(type, fn);
    },
    now: () => Date.now(),
    random: () => Math.random(),
    newTabId: newId,
  };
}
