// Sign-in flows and the session lifecycle.
//
// Auth (LESSONS "Auth"): real password forms with a one-time trimmed retry on
// "invalid login" (Android long-press copy adds a trailing space); 6-digit email
// codes that fail gracefully while the auth-email hook is not enabled; after a code
// sign-in for an account without a password, an offer to set one (skippable).
//
// Session start: me(), pick the organization (route, else last used, else first),
// bootstrap, the realtime hub, the outbox, the service worker, push re-register.
// Session end (sign-out or a session that ended): unsubscribe and unregister web
// push, delete this person's IndexedDB and dek.* keys, wipe the worker's media
// cache, reset the store. Nothing from one person survives for the next.
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../api/client';
import { DekError, toDekError } from '../api/errors';
import { api } from '../api/rpc';
import type { MeResult, Message } from '../api/types';
import { channelRoute, currentRoute, navigate } from '../app/router';
import { backoffDelay, START_BACKOFF } from '../lib/backoff';
import { clearBrand } from '../lib/color';
import { deleteUserDbs, openUserDb } from '../lib/idb';
import { removeUserKeys } from '../lib/storage';
import { disablePush, ensurePushOnLogin } from '../push/push';
import { hub } from '../realtime/hub';
import { getState, resetState, setState } from '../store/state';
import { toast } from '../ui/kit';
import { registerServiceWorker, wipeMedia } from '../sw/register';
import { noteGap, resetChannels } from './channels';
import { takeLegacyOutbox } from './legacy';
import { cancelLocalWrites, lastOrg, loadLocal } from './local';
import { pickOrg, readMeta, refreshMe, resetOrg, routeOrgId, selectOrg, setStartHook } from './org';
import { Outbox } from './outbox';
import { createOutboxStorage } from './outbox-storage';
import { loadProfileCache, mergeProfiles, resetProfiles } from './profiles';
import { resetReads } from './read';
import { applyNewMessage, dropPendingByClientId } from './reducers';
import {
  clearOpen, currentSessionGen, holdTabLock, isTabAlive, nextOrgGen, nextSessionGen, onScreen, runtime, setRuntime, tabId,
} from './runtime';
import { resetThreads } from './threads';
import { resetTyping } from './typing';

export const CODE_MAIL_DOWN = 'We could not email a code right now. Sign in with your password, or try again later.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEND_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- auth errors

interface AuthErrorLike {
  message?: string;
  code?: string;
  status?: number;
  name?: string;
}

function isInvalidLogin(e: AuthErrorLike): boolean {
  return e.code === 'invalid_credentials' || /invalid login credentials/i.test(e.message ?? '');
}

export function authError(e: AuthErrorLike | null | undefined, fallback: string): DekError {
  if (!e) return new DekError('unknown', fallback);
  const msg = e.message ?? '';
  if (isInvalidLogin(e)) return new DekError('invalid_input', 'That email and password do not match.');
  if (e.code === 'email_not_confirmed') return new DekError('invalid_input', 'This email address is not confirmed yet. Sign in with an email code instead.');
  if (e.code === 'user_banned') return new DekError('forbidden', 'This account is blocked. Ask your administrator.');
  if (e.code === 'weak_password' || /password should be/i.test(msg)) return new DekError('invalid_input', 'Choose a stronger password: at least 8 characters.');
  if (e.code === 'otp_expired' || /token has expired|invalid.*(otp|token)/i.test(msg)) {
    return new DekError('invalid_input', 'That code is wrong or has expired. Check the latest email, or send a new code.');
  }
  if (e.status === 429 || /rate limit|too many/i.test(msg) || e.code?.startsWith('over_')) {
    return new DekError('rate_limited', 'Too many attempts. Wait a minute and try again.');
  }
  if (e.status === 0 || e.name === 'AuthRetryableFetchError' || toDekError(e).code === 'network') {
    return new DekError('network', 'You are offline or the connection dropped. Check it and try again.');
  }
  return new DekError('unknown', fallback);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hasPassword(user: User): boolean {
  const m = (user.user_metadata ?? {}) as Record<string, unknown>;
  return m.password_set === true || m.password_setup_complete === true;
}

// ---------------------------------------------------------------- auth actions

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw new DekError('invalid_input', 'Enter a valid email address.');
  if (!password) throw new DekError('invalid_input', 'Enter your password.');
  const sb = supabase();
  let res = await sb.auth.signInWithPassword({ email: e, password });
  if (res.error && isInvalidLogin(res.error) && password.trim() !== password && password.trim().length > 0) {
    res = await sb.auth.signInWithPassword({ email: e, password: password.trim() });
  }
  if (res.error || !res.data.user) throw authError(res.error, 'Could not sign you in. Try again.');
  // Remember that this account has a password, so a later code sign-in does not
  // offer to set one.
  if (!hasPassword(res.data.user)) void sb.auth.updateUser({ data: { password_set: true } }).catch(() => undefined);
}

const codePurpose = new Map<string, 'signin' | 'reset'>();
let codeFlow: { purpose: 'signin' | 'reset'; email: string; at: number } | null = null;

export async function sendEmailCode(email: string, opts: { create?: boolean; purpose?: 'signin' | 'reset' } = {}): Promise<void> {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw new DekError('invalid_input', 'Enter a valid email address.');
  const create = opts.create ?? opts.purpose !== 'reset';
  let error: AuthErrorLike | null = null;
  try {
    ({ error } = await supabase().auth.signInWithOtp({ email: e, options: { shouldCreateUser: create } }));
  } catch (err) {
    error = err as AuthErrorLike;
  }
  if (error) {
    if (!create && /signups? not allowed|not found/i.test(error.message ?? '')) {
      throw new DekError('not_found', 'We could not find a Dek account for that email address. Check it, or ask your admin for an invite.');
    }
    if (error.status === 0 || toDekError(error).code === 'network') {
      throw new DekError('network', 'You are offline. Check your connection, or sign in with your password.');
    }
    // The mailer (auth-email hook) is not available, a limit was hit, or anything
    // else on the sending side: one honest sentence with a way forward.
    throw new DekError('server', CODE_MAIL_DOWN);
  }
  codePurpose.set(e, opts.purpose ?? (create ? 'signin' : 'reset'));
}

export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const e = normalizeEmail(email);
  const token = code.replace(/\D/g, '');
  if (token.length !== 6) throw new DekError('invalid_input', 'Enter the 6-digit code from the email.');
  // Read by the auth listener when the new session arrives (it runs after this
  // promise settles), so the flag is consumed there, not cleared here.
  codeFlow = { purpose: codePurpose.get(e) ?? 'signin', email: e, at: Date.now() };
  const { data, error } = await supabase().auth.verifyOtp({ email: e, token, type: 'email' });
  if (error || !data.session) {
    codeFlow = null;
    throw authError(error, 'That code is wrong or has expired. Check the latest email, or send a new code.');
  }
}

function consumeCodeFlow(user: User): 'password' | 'reset' | null {
  const flow = codeFlow;
  codeFlow = null;
  if (!flow || Date.now() - flow.at > 120_000 || flow.email !== (user.email ?? '').toLowerCase()) return null;
  if (flow.purpose === 'reset') return 'reset';
  return hasPassword(user) ? null : 'password';
}

export async function setPassword(password: string): Promise<void> {
  const p = password.trim();
  if (p.length < 8) throw new DekError('invalid_input', 'Use at least 8 characters.');
  if (p.length > 72) throw new DekError('invalid_input', 'Use at most 72 characters.');
  const { error } = await supabase().auth.updateUser({ password: p, data: { password_set: true } });
  if (error && error.code !== 'same_password') throw authError(error, 'Could not save that password. Try again.');
  finishSetup();
}

export function skipSetup(): void {
  finishSetup();
}

function finishSetup(): void {
  const s = getState().session;
  if (s.userId) setState({ session: { ...s, status: 'signed_in', setup: null } });
}

export async function signOut(): Promise<void> {
  const uid = getState().session.userId;
  // Push first: unregistering needs the session.
  await disablePush(uid, { unregister: true }).catch(() => undefined);
  try {
    await supabase().auth.signOut({ scope: 'local' });
  } catch {
    /* the local wipe below still happens */
  }
  await endSession();
}

// ---------------------------------------------------------------- auth listener

let authQueue: Promise<void> = Promise.resolve();

export function listenToAuth(): void {
  supabase().auth.onAuthStateChange((event, session) => {
    // Never await supabase calls inside this callback (auth-js holds its lock).
    setTimeout(() => {
      authQueue = authQueue.then(() => onAuth(event, session)).catch(() => undefined);
    }, 0);
  });
}

async function onAuth(event: string, session: Session | null): Promise<void> {
  const user = session?.user ?? null;
  const cur = getState().session;
  if (user) {
    if (cur.userId === user.id && runtime()) {
      if (event === 'USER_UPDATED' && user.email && user.email !== cur.email) setState({ session: { ...cur, email: user.email } });
      return;
    }
    if (cur.userId && cur.userId !== user.id) await endSession();
    const setup = consumeCodeFlow(user);
    setState({ session: { status: setup ? 'signed_out' : 'signed_in', userId: user.id, email: user.email ?? null, setup } });
    await beginSession(user);
    return;
  }
  if (runtime() || cur.userId) await endSession();
  else setState({ session: { status: 'signed_out', userId: null, email: null, setup: null } });
}

// ---------------------------------------------------------------- session start

let legacyChecked = false;
setStartHook(() => startData());
let startDone = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

async function beginSession(user: User): Promise<void> {
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
  if (orgId) {
    await selectOrg(orgId, { force: getState().orgId !== orgId || getState().bootstrap.status !== 'ready' });
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
  if (orgId) await selectOrg(orgId, { force: true });
  else setState({ bootstrap: { status: 'error', error: hint, at: null } });
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

async function chooseOrg(me: MeResult): Promise<string | null> {
  const uid = me.user_id;
  const r = currentRoute();
  if (r.name === 'legacyChannel') {
    const resolved = await resolveLegacyLink(me, r.channelId, r.messageId);
    if (resolved) return resolved;
  }
  const fromRoute = routeOrgId();
  const picked = pickOrg(me.orgs, fromRoute, lastOrg(uid));
  if (fromRoute && picked !== fromRoute) {
    toast({ kind: 'info', title: 'You do not have access to that organization.' });
    navigate(picked ? { name: 'org', orgId: picked } : { name: 'home' }, { replace: true });
  }
  return picked;
}

// Old links (/c/<channel>, #/c/<channel>/m/<message>, notifications from the old
// app) open the same conversation here: ids were kept by the migration.
async function resolveLegacyLink(me: MeResult, channelId: string, messageId: string | null): Promise<string | null> {
  if (messageId) {
    try {
      const ctx = await api.getMessageContext(messageId);
      navigate(channelRoute(ctx.channel.org_id, ctx.channel.id, { messageId }), { replace: true });
      return ctx.channel.org_id;
    } catch {
      /* fall through to the channel */
    }
  }
  for (const o of me.orgs) {
    try {
      const b = await api.bootstrap(o.id);
      if (b.channels.some((c) => c.id === channelId)) {
        navigate(channelRoute(o.id, channelId), { replace: true });
        return o.id;
      }
    } catch {
      /* try the next organization */
    }
  }
  toast({ kind: 'info', title: 'That conversation is not available to you.' });
  navigate({ name: 'home' }, { replace: true });
  return null;
}

// ---------------------------------------------------------------- session end

let ending: Promise<void> | null = null;

export function endSession(): Promise<void> {
  if (ending) return ending;
  ending = doEnd().finally(() => {
    ending = null;
  });
  return ending;
}

async function doEnd(): Promise<void> {
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
  if (rt) {
    try {
      (await rt.db).close();
    } catch {
      /* already closed */
    }
  }
  await deleteUserDbs(uid);
  if (uid) removeUserKeys(uid);
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
