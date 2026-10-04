// OWNER: core platform builder. startApp(): the legacy session exchange, the auth
// listener, the realtime hub, the outbox, the service worker, the keyboard inset
// and connectivity; registers the real DekActions.
import { supabase } from '../api/client';
import { api } from '../api/rpc';
import { DekError } from '../api/errors';
import { limits } from '../config';
import { readString, writeString } from '../lib/storage';
import { installKeyboardInset } from '../lib/viewport';
import { attachInstallListeners } from '../push/install';
import { ensurePushOnLogin } from '../push/push';
import { hub } from '../realtime/hub';
import { actions, registerActions } from '../store/actions';
import type { SendInput } from '../store/actions';
import { getState, setState, useDek } from '../store/state';
import {
  applyUpdate, installChunkRecovery, listenToWorker, onSwMessage, registerServiceWorker, setUpdateSafetyCheck,
} from '../sw/register';
import { closeChannel, healOpenChannels, loadNewer, loadOlder, openChannel } from './channels';
import { handleEvent } from './events';
import { cleanupLegacy, exchangeLegacySession } from './legacy';
import { flushLocal, rememberScroll, setDraft } from './local';
import { deleteMessage, editMessage, pinMessage, toggleReaction } from './messages';
import { joinChannel, leaveChannel, openDm, setChannelNotify } from './membership';
import { setSaved } from './saved';
import { refreshBootstrap, refreshMe, routeOrgId, scheduleBootstrapRefresh, selectOrg } from './org';
import { ensureProfiles } from './profiles';
import { flushReads, markRead, markThreadRead, markUnread, setCounterRefreshHook } from './read';
import { openChannels, runtime } from './runtime';
import { sendEmailCode, setPassword, signInWithPassword, skipSetup, verifyEmailCode } from './auth';
import { listenToAuth, resumeStart, signOut } from './session';
import { followThread, healThreads, loadThreadMore, openThread } from './threads';
import { notifyTyping, onTypingSignal } from './typing';

function sendMessage(input: SendInput): string {
  const rt = runtime();
  if (!rt) throw new DekError('auth_required');
  const body = input.body.trim();
  const attachmentIds = input.attachmentIds ?? [];
  if (!body && attachmentIds.length === 0) throw new DekError('invalid_input', 'Write a message first.');
  if (body.length > limits.bodyMax) throw new DekError('invalid_input', `A message can be at most ${limits.bodyMax} characters.`);
  const s = getState();
  return rt.outbox.enqueue({
    orgId: s.channels[input.channelId]?.org_id ?? s.orgId ?? '',
    channelId: input.channelId,
    threadRootId: input.threadRootId ?? null,
    body,
    attachmentIds,
    alsoInChannel: input.alsoInChannel ?? false,
  });
}

function registerAll(): void {
  registerActions({
    signInWithPassword,
    sendEmailCode,
    verifyEmailCode,
    setPassword,
    skipSetup,
    signOut,
    refreshMe: async () => { await refreshMe(); },
    applyUpdate,
    selectOrg: (orgId) => selectOrg(orgId),
    refreshBootstrap,
    openChannel,
    closeChannel,
    loadOlder,
    loadNewer,
    markRead,
    markUnread,
    setChannelNotify,
    joinChannel,
    leaveChannel,
    openDm,
    sendMessage,
    retrySend: (clientId) => runtime()?.outbox.retry(clientId),
    discardPending: (clientId) => runtime()?.outbox.discard(clientId),
    editMessage,
    deleteMessage,
    toggleReaction,
    pinMessage,
    saveMessage: (messageId, saved) => setSaved(messageId, saved),
    openThread,
    loadThreadMore,
    followThread,
    markThreadRead,
    notifyTyping,
    ensureProfiles,
    setDraft,
    rememberScroll,
  });
}

// "Safe to reload for an update": nothing typed in an open conversation, no open
// dialog, not in a call.
function updateIsSafe(): boolean {
  if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) return false;
  const s = getState();
  const open = openChannels();
  for (const [key, text] of Object.entries(s.drafts)) {
    const channelId = key.split(':')[0]!;
    if (open.includes(channelId) && text.trim()) return false;
  }
  const me = s.session.userId;
  for (const call of Object.values(s.calls)) {
    if (!call.ended_at && call.participants.some((p) => p.user_id === me && p.state === 'joined')) return false;
  }
  return true;
}

function followRouteOrg(): void {
  const org = routeOrgId();
  const s = getState();
  if (org && s.session.status === 'signed_in' && org !== s.orgId && s.orgs.some((o) => o.id === org)) void selectOrg(org);
}

// A legacy exchange postponed by the network (offline, 429, 5xx) runs again when
// the network returns, as long as nobody has signed in meanwhile.
let legacyPostponed = false;
const RECONNECT_SPREAD_MS = 10_000;
let reconnectReload: ReturnType<typeof setTimeout> | null = null;
function retryLegacyExchange(): void {
  if (!legacyPostponed || getState().session.status === 'signed_in') return;
  legacyPostponed = false;
  void exchangeLegacySession().then((r) => { legacyPostponed = r === 'offline'; }).catch(() => { legacyPostponed = true; });
}

// The old app's leftovers (keys, cache databases) are removed once per device, after
// the auth listener: deleting a database can take seconds when IndexedDB hangs, and
// the Splash must not wait for it.
const LEGACY_CLEANED_KEY = 'dek.legacy.cleaned';
async function cleanupLegacyOnce(): Promise<void> {
  if (readString(LEGACY_CLEANED_KEY) === '1') return;
  await cleanupLegacy();
  writeString(LEGACY_CLEANED_KEY, '1');
}

function wireEnvironment(): void {
  installChunkRecovery();
  installKeyboardInset();
  attachInstallListeners();
  listenToWorker();
  setUpdateSafetyCheck(updateIsSafe);
  setCounterRefreshHook(() => scheduleBootstrapRefresh());

  window.addEventListener('online', () => {
    setState({ connection: { ...getState().connection, online: true } });
    retryLegacyExchange();
    resumeStart();
    runtime()?.outbox.kick();
    flushReads();
    if (getState().bootstrap.error) void refreshBootstrap();
  });
  window.addEventListener('offline', () => {
    setState({ connection: { ...getState().connection, online: false } });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Android may kill a backgrounded PWA: write drafts and reads now.
      flushLocal();
      flushReads();
    } else {
      const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      void nav.clearAppBadge?.().catch(() => undefined);
    }
  });
  window.addEventListener('pagehide', () => {
    flushLocal();
    flushReads();
  });
  window.addEventListener('popstate', followRouteOrg);

  hub.onEvent(handleEvent);
  hub.onTyping(onTypingSignal);
  hub.onStatus((status) => setState({ connection: { ...getState().connection, realtime: status } }));
  hub.onLeaderChange((leader) => setState({ connection: { ...getState().connection, leader } }));
  hub.onReconnected((reason) => {
    runtime()?.outbox.kick();
    flushReads();
    void healOpenChannels();
    if (reason !== 'initial') {
      // A realtime restart drops every socket at once; spreading the sidebar and thread
      // reload over 0 to 10 s keeps hundreds of clients from asking for bootstrap in the
      // same second. The open conversation (above) heals at once.
      if (reconnectReload) clearTimeout(reconnectReload);
      reconnectReload = setTimeout(() => {
        reconnectReload = null;
        void healThreads();
        void refreshBootstrap();
      }, Math.random() * RECONNECT_SPREAD_MS);
    }
  });

  onSwMessage('navigate', () => followRouteOrg());
  onSwMessage('push-resubscribe', () => {
    const uid = getState().session.userId;
    if (uid) void ensurePushOnLogin(uid);
  });
}

function installDevHooks(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  (window as unknown as { __dek: unknown }).__dek = {
    useDek,
    actions,
    hub,
    api,
    outbox: () => runtime()?.outbox.snapshot() ?? [],
    // Tests end a session "on its own" through this (dev builds only).
    supabase,
    runtime: () => {
      const rt = runtime();
      return rt ? { userId: rt.userId, gen: rt.gen } : null;
    },
  };
}

let started = false;

export function startApp(): void {
  if (started) return;
  started = true;
  registerAll();
  installDevHooks();
  wireEnvironment();
  void (async () => {
    try {
      // Before the auth listener: a person with a legacy session must not see
      // the sign-in screen flash while their session is exchanged. Without a
      // legacy key this returns at once.
      legacyPostponed = (await exchangeLegacySession()) === 'offline';
    } catch {
      legacyPostponed = true;
    }
    listenToAuth();
    try {
      await cleanupLegacyOnce();
    } catch {
      /* leftovers are harmless; the next start tries again */
    }
  })();
  // The worker (offline shell, updates, push) also serves the sign-in screen; it
  // registers once the page has loaded so it never competes with the first paint.
  const registerWorkerSoon = () => setTimeout(() => void registerServiceWorker(), 1_500);
  if (document.readyState === 'complete') registerWorkerSoon();
  else window.addEventListener('load', registerWorkerSoon, { once: true });
}
