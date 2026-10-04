// The session lifecycle. (Sign-in flows: ./auth.ts.)
//
// Session start: me(), pick the organization (route, else last used, else first),
// bootstrap, the realtime hub, the outbox, the service worker, push re-register.
// Offline, the last copy of me and the organization is painted and the start is
// retried with backoff; recovery refreshes that copy in place.
//
// Sign-out (voluntary): unsent messages are flushed first, and the person is asked
// before any are thrown away; then web push is unsubscribed and unregistered, this
// person's IndexedDB and dek.* keys are deleted, the worker's media cache is wiped
// and the store reset. Nothing from one person survives for the next.
// A session that ends on its own keeps only the unsent messages and drafts.
import type { Session, User } from '@supabase/supabase-js';
import { AUTH_STORAGE_KEY, supabase } from '../api/client';
import { DekError, toDekError } from '../api/errors';
import { api } from '../api/rpc';
import type { MeResult, Message } from '../api/types';
import { navigate } from '../app/router';
import { backoffDelay, START_BACKOFF } from '../lib/backoff';
import { clearBrand } from '../lib/color';
import { deleteUserDbs, openUserDb } from '../lib/idb';
import { removeUserKeys, userKey } from '../lib/storage';
import { disablePush, ensurePushOnLogin } from '../push/push';
import { hub } from '../realtime/hub';
import { getState, resetState, setState } from '../store/state';
import { toast } from '../ui/kit';
import { registerServiceWorker, wipeMedia } from '../sw/register';
import { noteGap, resetChannels } from './channels';
import { takeLegacyOutbox } from './legacy';
import { cancelLocalWrites, lastOrg, loadLocal } from './local';
import { paintCachedOrg, pickOrg, readMeta, refreshBootstrap, refreshMe, resetOrg, routeOrgId, selectOrg, setStartHook } from './org';
import { consumeCodeFlow } from './auth';
import { Outbox } from './outbox';
import { createOutboxStorage } from './outbox-storage';
import { loadProfileCache, mergeProfiles, resetProfiles } from './profiles';
import { resetReads } from './read';
import { resetSaved } from './saved';
import { applyNewMessage, dropPendingByClientId } from './reducers';
import {
  clearOpen, currentSessionGen, holdTabLock, isTabAlive, nextOrgGen, nextSessionGen, onScreen, runtime, setRuntime, tabId,
} from './runtime';
import { resetThreads } from './threads';
import { resetTyping } from './typing';

const SEND_TIMEOUT_MS = 15_000;
const SIGN_OUT_DRAIN_MS = 5_000;

// ---------------------------------------------------------------- sign out

let signingOut = false;

// Give unsent messages a moment to go out; how many are still not sent.
async function drain(ms: number): Promise<number> {
  const rt = runtime();
  if (!rt) return 0;
  rt.outbox.kick();
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (rt.outbox.snapshot().length === 0) return 0;
    await new Promise((r) => setTimeout(r, 250));
  }
  return rt.outbox.snapshot().length;
}

// Sign-out wipes this person's data from the device (shared phones), so it never
// silently throws away a message that has not been sent: after a bounded flush, if
// some are left it refuses with `conflict` and offers "Sign out anyway" (force).
export async function signOut(opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force) {
    const left = await drain(SIGN_OUT_DRAIN_MS);
    if (left > 0) {
      const title = left === 1
        ? '1 message has not been sent yet. Signing out deletes it from this device.'
        : `${left} messages have not been sent yet. Signing out deletes them from this device.`;
      toast({ kind: 'error', title, duration: 15_000, action: { label: 'Sign out anyway', onClick: () => { void signOut({ force: true }).catch(() => undefined); } } });
      throw new DekError('conflict', title);
    }
  }
  signingOut = true;
  try {
    const uid = getState().session.userId;
    // Push first: unregistering needs the session.
    await disablePush(uid, { unregister: true }).catch(() => undefined);
    try {
      await supabase().auth.signOut({ scope: 'local' });
    } catch {
      /* the local wipe below still happens */
    }
    await endSession('voluntary');
  } finally {
    signingOut = false;
  }
}

// ---------------------------------------------------------------- auth listener

let authQueue: Promise<void> = Promise.resolve();
export const SPLASH_LIMIT_MS = 20_000;
const STORED_PAINT_MS = 3_000;

export function listenToAuth(): void {
  supabase().auth.onAuthStateChange((event, session) => {
    // Never await supabase calls inside this callback (auth-js holds its lock).
    setTimeout(() => {
      authQueue = authQueue.then(() => onAuth(event, session)).catch(() => undefined);
    }, 0);
  });
  // The Splash never stays up for long. auth-js can spend about 30 s retrying a
  // token refresh the server answers with 503 (or 429) before it reports anything,
  // and every API call waits for it: a stored session paints its last copy after
  // 3 s; with nothing stored, the sign-in screen shows after 20 s.
  setTimeout(() => {
    if (getState().session.status !== 'unknown') return;
    authQueue = authQueue.then(async () => {
      if (getState().session.status === 'unknown') await startStoredOffline();
    }).catch(() => undefined);
  }, STORED_PAINT_MS);
  setTimeout(() => {
    if (getState().session.status !== 'unknown') return;
    authQueue = authQueue.then(async () => {
      if (getState().session.status !== 'unknown') return;
      if (!(await startStoredOffline())) setState({ session: { status: 'signed_out', userId: null, email: null, setup: null } });
    }).catch(() => undefined);
  }, SPLASH_LIMIT_MS);
}

// The session auth-js keeps in its own storage (localStorage on the web, the
// Keystore or Keychain adapter in the apps), read without asking the server.
interface StoredSession { user: { id: string; email: string | null } }
export function parseStoredSession(raw: string | null | undefined): StoredSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { user?: { id?: unknown; email?: unknown }; currentSession?: { user?: { id?: unknown; email?: unknown } } };
    const u = v.user ?? v.currentSession?.user;
    if (!u || typeof u.id !== 'string' || u.id.length === 0) return null;
    return { user: { id: u.id, email: typeof u.email === 'string' ? u.email : null } };
  } catch {
    return null;
  }
}

async function peekStoredSession(): Promise<StoredSession | null> {
  const auth = supabase().auth as unknown as { storage?: { getItem(k: string): string | null | Promise<string | null> }; storageKey?: string };
  try {
    if (auth.storage && typeof auth.storage.getItem === 'function') {
      return parseStoredSession(await auth.storage.getItem(auth.storageKey ?? AUTH_STORAGE_KEY));
    }
  } catch {
    /* fall back to the default store below */
  }
  try {
    return parseStoredSession(typeof localStorage === 'undefined' ? null : localStorage.getItem(AUTH_STORAGE_KEY));
  } catch {
    return null;
  }
}

// An expired access token and a refresh that could not reach the server (offline,
// 503) make auth-js report "no session" while the session is still stored. That
// person is signed in: show their last copy, keep their outbox, and let the
// refresh take over when the network returns (TOKEN_REFRESHED). A session the
// server refuses ends with SIGNED_OUT and goes the normal way.
async function startStoredOffline(): Promise<boolean> {
  if (runtime()) return true;
  const stored = await peekStoredSession();
  if (!stored || runtime()) return !!stored;
  setState({ session: { status: 'signed_in', userId: stored.user.id, email: stored.user.email, setup: null } });
  await beginSession({ id: stored.user.id, email: stored.user.email ?? undefined } as User, { offlineFirst: true });
  return true;
}

async function onAuth(event: string, session: Session | null): Promise<void> {
  const user = session?.user ?? null;
  const cur = getState().session;
  if (user) {
    if (cur.userId === user.id && runtime()) {
      if (event === 'USER_UPDATED' && user.email && user.email !== cur.email) setState({ session: { ...cur, email: user.email } });
      // Back from an offline start: the token is good again, finish the start now,
      // and rejoin realtime topics a stale token could not join.
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        resumeStart();
        hub.retryNow();
      }
      return;
    }
    if (cur.userId && cur.userId !== user.id) await endSession('involuntary');
    const setup = consumeCodeFlow(user);
    setState({ session: { status: setup ? 'signed_out' : 'signed_in', userId: user.id, email: user.email ?? null, setup } });
    await beginSession(user);
    return;
  }
  if (runtime() || cur.userId) {
    // INITIAL_SESSION without a session for a page already running a session (a
    // retryable refresh failure at start): nothing ended, keep going.
    if (event === 'INITIAL_SESSION' && runtime()) return;
    await endSession(signingOut ? 'voluntary' : 'involuntary');
    return;
  }
  if (event === 'INITIAL_SESSION' && (await startStoredOffline())) return;
  setState({ session: { status: 'signed_out', userId: null, email: null, setup: null } });
}

// ---------------------------------------------------------------- session start

let legacyChecked = false;
setStartHook(() => startData());
let startDone = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

async function beginSession(user: User, opts: { offlineFirst?: boolean } = {}): Promise<void> {
  const gen = nextSessionGen();
  const uid = user.id;
  holdTabLock();
  hub.setIdentity(uid);
  const db = openUserDb(uid);
  const outbox = new Outbox({
    storage: createOutboxStorage(db, uid),
    send: (rec) => api.sendMessage({
      channel: rec.channelId, clientId: rec.clientId, body: rec.body, threadRoot: rec.threadRootId,
      attachmentIds: rec.attachmentIds, alsoInChannel: rec.alsoInChannel,
    }, { timeoutMs: SEND_TIMEOUT_MS }),
    onUpdate: (clientId, rec) => {
      const pending = { ...getState().pending };
      if (rec) pending[clientId] = rec;
      else delete pending[clientId];
      setState({ pending });
    },
    onAccepted: (clientId, msg) => accepted(clientId, msg),
    tabId,
    isTabAlive,
  });
  setRuntime({ userId: uid, gen, db, outbox });
  startDone = false;
  retryAttempt = 0;
  loadLocal(uid);
  void db.then((d) => (gen === currentSessionGen() ? loadProfileCache(d) : undefined));
  if (!legacyChecked) {
    legacyChecked = true;
    const old = await takeLegacyOutbox(uid, tabId).catch(() => []);
    const storage = createOutboxStorage(db, uid);
    for (const rec of old) await storage.save(rec);
  }
  if (gen !== currentSessionGen()) return;
  void outbox.load();
  if (opts.offlineFirst) await startOffline('Dek is reconnecting. You are seeing the last saved copy.');
  if (gen !== currentSessionGen()) return;
  await startData();
}

function accepted(clientId: string, msg: Message): void {
  const s = getState();
  if (msg.org_id !== s.orgId) {
    const pending = dropPendingByClientId(s.pending, clientId);
    if (pending !== s.pending) setState({ pending });
    return;
  }
  const { patch, gap } = applyNewMessage(s, msg, { me: s.session.userId, onScreen });
  if (patch.pending === undefined) patch.pending = dropPendingByClientId(s.pending, clientId);
  setState(patch);
  if (gap) noteGap(msg.channel_id, msg.seq);
}

// me(), the organization, bootstrap, the hub, the outbox, the worker. Safe to call
// again (Try again, the network came back).
export async function startData(): Promise<void> {
  const rt = runtime();
  if (!rt) return;
  const gen = rt.gen;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (getState().bootstrap.status !== 'ready') setState({ bootstrap: { status: 'loading', error: null, at: null } });
  let me: MeResult;
  try {
    me = await refreshMe();
  } catch (e) {
    if (gen !== currentSessionGen()) return;
    await startOffline(toDekError(e).hint);
    scheduleRetry();
    return;
  }
  if (gen !== currentSessionGen()) return;
  startDone = true;
  retryAttempt = 0;
  const orgId = await chooseOrg(me);
  if (gen !== currentSessionGen()) return;
  const shown = getState();
  if (orgId && shown.orgId === orgId && shown.bootstrap.status === 'ready') {
    // Already on screen (an offline copy, or the shell selected it first): refresh
    // in place so open conversations stay open, and only when the copy is stale.
    if (shown.bootstrap.at === null || shown.bootstrap.error) await refreshBootstrap();
  } else if (orgId) {
    await selectOrg(orgId, { force: true });
  } else {
    setState({ orgId: null, org: null, bootstrap: { status: 'ready', error: null, at: Date.now() } });
    hub.setTopics([`u:${rt.userId}`]);   // an invite accepted elsewhere still reaches this page
  }
  if (gen !== currentSessionGen()) return;
  hub.start();
  rt.outbox.kick();
  void registerServiceWorker();
  void ensurePushOnLogin(rt.userId);
}

// Offline cold start: paint the last copy of me and the organization, so queued
// messages and cached pages are usable without a network.
async function startOffline(hint: string): Promise<void> {
  const gen = currentSessionGen();
  const me = await readMeta<MeResult>('me');
  if (gen !== currentSessionGen()) return;
  if (!me) {
    setState({ bootstrap: { status: 'error', error: hint, at: null } });
    return;
  }
  setState({ me, orgs: me.orgs });
  mergeProfiles([me.profile], Date.now(), false);
  const uid = runtime()?.userId ?? null;
  const orgId = pickOrg(me.orgs, routeOrgId(), uid ? lastOrg(uid) : null);
  const shown = getState();
  if (orgId && shown.orgId === orgId && shown.bootstrap.status === 'ready') {
    // Every failed retry lands here: what is on screen stays as it is.
  } else if (orgId) {
    // The copy first, without the network (which may be the thing that is down);
    // with no copy, one real attempt.
    if (!(await paintCachedOrg(orgId, hint))) await selectOrg(orgId, { force: true });
  } else {
    setState({ bootstrap: { status: 'error', error: hint, at: null } });
  }
  hub.start();
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void startData();
  }, backoffDelay(retryAttempt, START_BACKOFF));
}

// The network came back: finish a start that could not reach the server.
export function resumeStart(): void {
  if (!runtime() || startDone) return;
  void startData();
}

// Route org, else last used, else first. Old link shapes (legacy routes) carry no
// organization: the shell resolves them (features/shell/legacy.ts), so nothing here
// navigates for them.
async function chooseOrg(me: MeResult): Promise<string | null> {
  const fromRoute = routeOrgId();
  const picked = pickOrg(me.orgs, fromRoute, lastOrg(me.user_id));
  if (fromRoute && picked !== fromRoute) {
    toast({ kind: 'info', title: 'You do not have access to that organization.' });
    navigate(picked ? { name: 'org', orgId: picked } : { name: 'home' }, { replace: true });
  }
  return picked;
}

// ---------------------------------------------------------------- session end

let ending: Promise<void> | null = null;

// 'voluntary': the person signed out here; everything of theirs leaves the device.
// 'involuntary': the session ended on its own (refresh refused, another tab signed
// out, another account signed in): unsent messages and drafts stay for this person
// (keyed by their id, sent when they sign in again), everything else goes. The next
// voluntary sign-out on this device removes those too.
export function endSession(mode: 'voluntary' | 'involuntary'): Promise<void> {
  if (ending) return ending;
  ending = doEnd(mode).finally(() => {
    ending = null;
  });
  return ending;
}

async function doEnd(mode: 'voluntary' | 'involuntary'): Promise<void> {
  const rt = runtime();
  const uid = rt?.userId ?? getState().session.userId;
  nextSessionGen();
  nextOrgGen();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  startDone = false;
  hub.stop();
  hub.setIdentity(null);
  rt?.outbox.stop();
  resetReads();
  resetSaved();
  resetTyping();
  resetProfiles();
  resetChannels();
  resetThreads();
  resetOrg();
  cancelLocalWrites();
  clearOpen();
  setRuntime(null);
  // A session that ended on its own (refresh refused): the subscription still goes
  // (the endpoint dies and push-dispatch prunes it), the server call cannot.
  await disablePush(uid, { unregister: false }).catch(() => undefined);
  if (mode === 'voluntary') {
    if (rt) {
      try {
        (await rt.db).close();
      } catch {
        /* already closed */
      }
    }
    await deleteUserDbs(uid);
    if (uid) removeUserKeys(uid);
  } else {
    if (rt) {
      try {
        const db = await rt.db;
        await db.clear('pages');
        await db.clear('profiles');
        await db.clear('meta');
        db.close();
      } catch {
        /* already closed: another tab is deleting it */
      }
    }
    if (uid) removeUserKeys(uid, [userKey('outbox', uid), userKey('drafts', uid)]);
  }
  await wipeMedia();
  clearBrand();
  const { app, connection } = getState();
  resetState();
  setState({
    session: { status: 'signed_out', userId: null, email: null, setup: null },
    app,
    connection: { ...connection, realtime: 'idle', leader: false },
  });
}
