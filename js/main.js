// Bootstrap: sign in, load the Space, wire the shell, register features.
import { sb, session, isIntentionalSignOut } from './sb.js';
import { api, tryRpc } from './api.js';
import { store, bus, nameOf } from './store.js';
import { $, el, esc, debounceLead, migrateLegacyKeys } from './util.js';
import ui, { toast, openPanel, closePanel, popPanel, renderHeaderButtons, modal, escDepth, wireEscLayers } from './ui.js';
import { initAuth, showAuth, showChat, needsPasswordSetup, showSetPassword } from './core/auth.js';
import { loadSpaces, switchWorkspace, spaceChooser, inviteDialog, copyInvite, extractToken, looksLikeOrgInvite } from './core/workspace.js';
import { openChannel, renderChannels, wireScroll, refreshUnread, jumpToSeq,
  paintLastChannelFromCache } from './core/channels.js';
import { initComposer, setReply, resolveMentions } from './core/composer.js';
import { initPresence } from './core/presence.js';
import { initVoice } from './core/voice.js';
import { initCall } from './core/call.js';
import { openThread, threadState } from './core/threads.js';
import { registerCoreActions, registerCoreHeader } from './core/actions.js';
import { openDM, startDM } from './core/dms.js';
import { jumpTo, buildMessage, initAvatarSweep, initNarrowWatcher } from './core/messages.js';
import { initPWA, paintInstallButton } from './pwa.js';
import { initTheme, openThemePicker } from './theme.js';
import { icon, logoMark } from './icons.js';
import { initShell, paintIdentity, paintChannelBar } from './shell.js';
import { registerFeatures } from './features/index.js';
import { initEmbed, embed, pinnedSpaceOf, notifyHost } from './embed.js';

// Any element carrying data-ico gets its SVG injected. Keeping the markup
// declarative means index.html stays readable and the icon set can change
// without touching the shell.
function hydrateIcons(root) {
  for (const n of root.querySelectorAll('[data-ico]')) {
    if (n.firstElementChild?.classList.contains('ico')) continue;
    n.insertAdjacentHTML('afterbegin', icon(n.dataset.ico));
  }
  for (const mark of root.querySelectorAll?.('#brandMark, #brandMarkCard') || []) {
    if (mark && !mark.firstElementChild) mark.innerHTML = logoMark(mark.id === 'brandMarkCard' ? 34 : 44);
  }
}

// ------------------------------------------------------------------ routing
function route() {
  const h = location.hash || '';
  let m;
  // An ORGANISATION link, which is the one the operator hands out. It places the
  // person in the org and every open server in it, then the directory shows them
  // the rest. Matched before #/join/ because that pattern would swallow it.
  if ((m = h.match(/#\/join-org\/([^/?#]+)/))) return { kind: 'joinOrg', token: decodeURIComponent(m[1]) };
  if ((m = h.match(/#\/join\/([^/?#]+)/))) return { kind: 'join', token: decodeURIComponent(m[1]) };
  if ((m = h.match(/#\/m\/([0-9a-f-]{36})\/(\d+)/i))) return { kind: 'message', channelId: m[1], seq: +m[2] };
  if ((m = h.match(/#\/c\/([0-9a-f-]{36})/i))) return { kind: 'channel', channelId: m[1] };
  // A DIRECT MESSAGE had no route at all, which meant a push notification about
  // one had nowhere to send you: tapping it could only open the app and leave
  // you to find the conversation yourself. The queued payload now carries
  // ./#/d/<conversation> (migration 0124) and this is the other half.
  if ((m = h.match(/#\/d\/([0-9a-f-]{36})/i))) return { kind: 'dm', conversationId: m[1] };
  // The PWA manifest shortcuts have pointed here since launch; the router never
  // matched them, so "Threads" and "Search" from an installed icon did nothing.
  if (/^#\/threads/i.test(h)) return { kind: 'panel', panel: 'threads-list' };
  if (/^#\/search/i.test(h)) return { kind: 'panel', panel: 'search' };
  // Leave. A push about a request waiting on you has to be tappable, or it is
  // half a notification - the same gap #/d/ was opened for in 0124.
  if (/^#\/leave/i.test(h)) return { kind: 'panel', panel: 'leave' };
  return { kind: 'none' };
}

async function applyRoute() {
  const r = route();
  if (r.kind === 'channel') {
    const c = store.channels.find((x) => x.id === r.channelId);
    if (c) await openChannel(c);
  } else if (r.kind === 'dm') {
    // Straight to openDM rather than through the store.dms lookup a click uses:
    // arriving cold from a notification, the conversation may not be in the
    // bootstrap's list yet, and openDM reads the messages itself.
    const { openDM } = await import('./core/dms.js');
    await openDM(r.conversationId);
  } else if (r.kind === 'message') {
    const c = store.channels.find((x) => x.id === r.channelId);
    if (c) await openChannel(c, { jumpSeq: r.seq });
  } else if (r.kind === 'panel') {
    // Shortcut targets land here only after boot has a UI to open into; during
    // enter() the panel layer is not ready yet, so defer to the next tick.
    setTimeout(() => import('./ui.js').then(({ openPanel }) => openPanel(r.panel)), 0);
  } else if (r.kind === 'joinOrg' || r.kind === 'join') {
    // An invite opened by somebody who is ALREADY signed in and has the app on
    // screen. A URL that differs only in its fragment does not reload the page,
    // so main() never runs again and enter()'s redeem never happens - the hash
    // just changed and nothing at all occurred. That is the ordinary case for
    // this product, because the link is pasted into a chat that people read on
    // the phone they are already signed in on, and it made the org links look
    // dead for exactly the people most likely to click one.
    await redeemFromRoute(r);
  }
  if (r.kind !== 'none') history.replaceState(null, '', location.pathname + location.search);
}

// One redeem path, used by the cold-start route in enter() and by a hash change
// on a running app.
async function redeemFromRoute(r) {
  try {
    if (r.kind === 'joinOrg') {
      const org = await api.rpc('redeem_org_invite', { p_token: extractToken(r.token) });
      await loadSpaces();
      const s = store.spaces.find((x) => x.org_id === org?.id);
      if (s && s.id !== store.ws?.id) await switchWorkspace(s);
      toast('You are in ' + (org?.name || 'the organisation'), 'success');
      if (org?.id) offerTheRest(org.id, org.name);
    } else {
      const ws = await api.redeemInvite(extractToken(r.token));
      await loadSpaces();
      const s = store.spaces.find((x) => x.id === ws?.id);
      if (s && s.id !== store.ws?.id) await switchWorkspace(s);
      toast('You are in ' + (ws?.name || 'the Space'), 'success');
    }
  } catch (e) {
    toast(inviteError(e), 'error');
  }
}

// Someone opening an invite link who is not signed in has to detour through
// email. The mail app usually opens the sign-in link in a NEW tab, and
// sessionStorage is per-tab, so the invite would be silently lost and they would
// land in the demo Space wondering where their organisation went. localStorage
// survives the round trip; the 30 minute TTL stops a stale token from hijacking
// an unrelated sign-in days later.
const INVITE_KEY = 'dak.pendingInvite';
const INVITE_TTL_MS = 30 * 60 * 1000;

function stashPendingInvite(token) {
  try {
    localStorage.setItem(INVITE_KEY, JSON.stringify({ token, at: Date.now() }));
  } catch { /* private mode: the in-URL token still works on this tab */ }
}

function takePendingInvite() {
  try {
    const raw = localStorage.getItem(INVITE_KEY);
    if (!raw) return null;
    localStorage.removeItem(INVITE_KEY);
    const { token, at } = JSON.parse(raw);
    return Date.now() - at < INVITE_TTL_MS ? token : null;
  } catch { return null; }
}

// The in-URL path reads its token from the hash and never calls
// takePendingInvite, so the copy main() stashed before sign-in survives and gets
// redeemed again on the next reload inside the TTL.
function clearPendingInvite() {
  try { localStorage.removeItem(INVITE_KEY); } catch { /* private mode */ }
}

// What somebody sees when a link has already been used. The raw value is a
// Postgres exception string - `invite_exhausted`, or a row-level-security
// message - shown for 3.2 seconds and then gone. It is not readable and it does
// not say what to do, and with one-use links this is now the ORDINARY failure
// rather than a rare one: it is what a forwarded link looks like.
function inviteError(e) {
  const m = String(e?.message || '');
  if (/exhaust|max_uses|already used|uses_exceeded|no_uses/i.test(m)) {
    return 'That invite link has already been used. Ask for a fresh one - each link lets one person in.';
  }
  if (/expire/i.test(m)) return 'That invite link has expired. Ask for a fresh one.';
  if (/revoke/i.test(m)) return 'That invite link was cancelled. Ask for a fresh one.';
  if (/not.?found|invalid|no rows/i.test(m)) return 'That invite link is not valid. Check you copied all of it.';
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return 'No connection, so the invite could not be checked. Try again when you are back online.';
  }
  return 'That invite link did not work. Ask whoever sent it for a fresh one.';
}

// ------------------------------------------------------------------ enter
async function enter() {
  const s = await session();
  if (!s) { showAuth(); return; }
  // Before ANY round trip: draw the conversation this person was last reading,
  // from this phone's own storage, into the shell that is about to be shown.
  // Everything below - the password check, redeem_invite, the profile, the
  // bootstrap, the message page - is between five and fifteen seconds of
  // waiting on a bad line, and none of it is needed to show what they already
  // had. Measured on Slow 3G / 4x CPU: 15.4s to a painted message without this.
  store.me = s.user.id;
  // iOS evicts IndexedDB caches after seven days of not being "important".
  // Offline drafts, the outbox and the cold-start page cache all live there, so
  // ask for persistence once, right after a real sign-in proves this is a real
  // user and not a drive-by tab.
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* no storage manager */ }
  // Showing the shell here is safe precisely because there IS a cached page:
  // only a user who has already signed in and finished any forced password
  // setup can have one. If the check below disagrees, showAuth() takes the
  // screen back.

  // A session restored from storage can still be sitting on the temporary
  // password it was provisioned with - reloading the page must not be a way
  // around the forced reset.
  if (await needsPasswordSetup()) { showAuth(); showSetPassword(s.user.email); return; }
  if (await paintLastChannelFromCache().catch(() => false)) showChat();
  sb.realtime.setAuth(s.access_token);

  // An invite in the URL is the whole multi-org story: open link, land in that
  // Space - or, for an organisation link, in that organisation and every open
  // server inside it.
  const r = route();
  const pendingRaw = (r.kind === 'join' || r.kind === 'joinOrg') ? r.token : takePendingInvite();
  const pendingIsOrg = r.kind === 'joinOrg' || (typeof pendingRaw === 'string' && pendingRaw.startsWith('org:'));
  const pending = pendingIsOrg && typeof pendingRaw === 'string'
    ? pendingRaw.replace(/^org:/, '') : pendingRaw;
  let joinedId = null;
  let joinedOrg = null;
  if (pending) {
    try {
      if (pendingIsOrg) {
        joinedOrg = await api.rpc('redeem_org_invite', { p_token: extractToken(pending) });
      } else {
        const wsRow = await api.redeemInvite(extractToken(pending));
        joinedId = wsRow?.id || null;
      }
    } catch (e) {
      toast(inviteError(e), 'error');
    }
    // SPEND THE TOKEN EXACTLY ONCE.
    //
    // The hash used to be left intact here, and applyRoute() further down this
    // same function matches `#/join/` and redeems again - so one human click on
    // one link called redeem_invite TWICE. A third time on any reload inside the
    // stash's 30 minute window, because the in-URL path never clears the stash
    // that main() wrote before sign-in.
    //
    // With an unlimited link nobody noticed: the second redeem was a no-op that
    // returned the same Space. The moment a link is good for one person, the
    // first call consumes it and the second fails, so the person joins
    // successfully and is then shown an error saying the link is not valid. If
    // the server counts attempts rather than successes it is worse than cosmetic
    // and the invite is genuinely burnt before anybody else can use it.
    //
    // Clearing the hash before applyRoute() sees it is the whole fix.
    history.replaceState(null, '', location.pathname + location.search);
    clearPendingInvite();
  }
  showChat();

  const { data: prof } = await sb.from('profiles')
    .select('*').eq('id', store.me).maybeSingle();
  signedInEmail = s.user?.email || '';
  store.myEmail = signedInEmail;
  // Names this person gave other people. One round trip, before the first paint,
  // because nameOf consults it on every rendered name and a late arrival would
  // mean every row painting the real name first and flickering to the nickname.
  try {
    const nicks = await api.rpc('my_nicknames', {});
    store.nicknames = new Map(Object.entries(nicks || {}));
  } catch { /* an older database: names simply render as they always did */ }
  store.myProfile = prof || { id: store.me, display_name: 'you' };
  store.profiles.set(store.me, store.myProfile);
  paintIdentity();

  subscribeUser(s.user.id);
  initPresence();

  await loadSpaces();

  // The demo Space is for someone who arrives cold with nowhere to go. It used
  // to be joined on EVERY sign-in that did not carry an invite token, which
  // meant a person provisioned into a real organisation was silently added to a
  // Space of 1571 strangers and, because the default below preferred the demo
  // slug, landed in it instead of their own. Only fall back to it when the
  // person genuinely belongs to nothing.
  // Somebody registered ahead of their organisation link - which is now the
  // normal way in, since accounts are created first and the org link is sent
  // after. Dropping them into a Space of 1571 strangers is worse than telling
  // them the truth, so the demo fallback is only for a session that has no
  // organisation either.
  // The demo Space used to catch anybody who belonged to nothing. It has 1770
  // members and 3095 messages, and dropping a new colleague into it was wrong
  // twice over: it is not their team, and it is by far the heaviest Space in the
  // project, so on a phone on mobile data the bootstrap for it is the slowest
  // thing the app ever does. When it did not finish, the shell had already
  // painted and the conversation had not - which is the blank screen people kept
  // reporting right after choosing their password. Somebody who belongs to
  // nothing now gets a screen that says so and can act on it.
  // An archived server, or one counting down to deletion, takes no new messages.
  // Opening into one is a dead room that reads as a broken app, and it is what
  // happened right after an admin deleted a server they were standing in.
  const live = (x) => !x.archived_at && !x.scheduled_delete_at;
  // Embedded, the host has already decided which room this is: a tech dashboard
  // docks the tech server. That beats every heuristic below, because those exist
  // to guess what somebody wanted and here nobody has to guess. It does NOT beat
  // an invite link the person just clicked - following a link they chose and
  // landing somewhere else is the one thing more confusing than a wrong default.
  const pinned = embed.active && !joinedId ? pinnedSpaceOf(store.spaces) : null;
  if (embed.active && embed.space && !pinned) {
    notifyHost('error', { where: 'pin', message: 'no Space matching ' + embed.space });
  }
  const active = pinned
    || store.spaces.find((x) => x.id === joinedId)
    // Straight into the organisation they just joined, not whichever Space is
    // oldest.
    || (joinedOrg ? store.spaces.find((x) => x.org_id === joinedOrg.id && live(x)) : null)
    || store.spaces.find((x) => x.slug !== 'demo' && live(x))
    || store.spaces.find(live)
    || store.spaces.find((x) => x.slug !== 'demo')
    || store.spaces[0];

  if (active) {
    document.body.classList.remove('no-team');
    await switchWorkspace(active);
    // A channel the host named in the iframe src, resolved once its Space is
    // loaded. Written into the hash so applyRoute() opens it by the one path
    // every other route uses.
    if (embed.active && embed.channel && !location.hash) {
      const c = store.channels.find((x) => x.id === embed.channel)
        || store.channels.find((x) => (x.name || '').toLowerCase() === String(embed.channel).toLowerCase());
      if (c) location.hash = '#/c/' + c.id;
    }
    await applyRoute();
  } else {
    renderChannels();
    // A route may still be pending - somebody who opened an org link, was sent
    // to sign in, and came back. Redeem it before concluding they have nothing.
    await applyRoute();
    if (!store.spaces.length) showNoTeam();
  }
  bus.emit('auth');
  paintInstallButton();
}

// An organisation invite joins you to every OPEN server, which in most orgs here
// is exactly one. Landing in a single room with no hint that five more exist is
// how "I only got added to one channel" happens, and there is nothing on screen
// that would ever tell you otherwise. So say so, once, right when the link has
// just been used, and open the index if they want it.
async function offerTheRest(orgId, orgName) {
  try {
    const [rows] = await tryRpc('list_org_spaces', { p_org: orgId });
    const list = (Array.isArray(rows) ? rows : []).filter((x) => !x.archived_at && !x.is_member);
    if (!list.length) return;
    const open = list.filter((x) => x.join_policy === 'open').length;
    const t = toast(
      open
        ? `${orgName} has ${open} more server${open === 1 ? '' : 's'} you can join.`
        : `${orgName} has ${list.length} more server${list.length === 1 ? '' : 's'}, all invite only.`,
      'info', 15000);
    const b = el('button', 'sm', open ? 'See them' : 'See what exists');
    b.onclick = async () => {
      const { orgDirectory } = await import('./core/workspace.js');
      await orgDirectory(orgId);
    };
    t.appendChild(b);
  } catch { /* the rail and Browse servers still get them there */ }
}

let signedInEmail = '';

// ------------------------------------------------------------------ no team
// The screen for somebody who has an account and belongs to nothing yet. It has
// to do three things the old empty <div> did not: say plainly that this is not
// broken, give them something to DO without waiting for anybody, and accept the
// link in the form it actually reaches them - pasted whole out of WhatsApp,
// where nobody is going to extract a token from a URL by hand.
export function showNoTeam(msg) {
  const org = store.orgs[0];
  const box = $('messages');
  // Everything that only makes sense once you are in a Space comes off: the
  // channel bar with its lone "#", the Space search, the composer telling them
  // to "pick a channel" when there are none. Leaving that chrome around the
  // message is what still made it read as broken rather than as a step.
  document.body.classList.add('no-team');
  // WHO is signed in, on the screen, at the top. Somebody who typed the wrong
  // email gets here, and until this said so there was nothing anywhere on the
  // page naming the account they had actually landed in.
  const email = store.myProfile?.email || sbUserEmail() || '';
  box.innerHTML = `
    <div class="noteam">
      <h2>${org ? `You are in ${esc(org.name)}` : 'You are signed in'}</h2>
      <p class="muted">${org
        ? 'You are not in any of its servers yet. Paste the invite your admin sent you, or ask them to add you to one.'
        : 'You are not part of a team yet. Paste the invite link or code your admin sent you.'}</p>
      <label class="field"><span class="field-label">Invite link or code</span>
        <input id="joinCode" placeholder="Paste the whole link, or just the code" autocomplete="off" /></label>
      <button id="joinGo" class="wide">Join</button>
      <div id="joinErr" class="autherr hidden"></div>
      <p class="muted fineprint">Nothing is wrong with your account and your password is saved.
        You just have not been added to a team yet.</p>
      <div class="noteam-who">
        <span class="muted">Signed in as ${email ? `<b>${esc(email)}</b>` : 'this account'}</span>
        <button id="noteamOut" class="sm ghost">Sign out</button>
      </div>
      <p class="muted fineprint">Wrong account? Sign out and come back with the email your
        invite was sent to. You do not need a code to leave this screen.</p>
    </div>`;
  if (msg) { $('joinErr').textContent = msg; $('joinErr').classList.remove('hidden'); }

  const go = async () => {
    const raw = $('joinCode').value.trim();
    if (!raw) return;
    const btn = $('joinGo');
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = '…';
    $('joinErr').classList.add('hidden');
    try {
      // Accept every shape the same link arrives in: the full URL, the hash
      // alone, or the bare token. An org token and a Space token are different
      // RPCs and the link does not always say which, so try the org first and
      // fall back rather than making somebody guess which kind they were sent.
      const token = extractToken(raw);
      const isOrg = looksLikeOrgInvite(raw);
      let landed = null;
      if (isOrg) {
        const o = await api.rpc('redeem_org_invite', { p_token: token });
        landed = o?.name;
      } else {
        try {
          const ws = await api.redeemInvite(token);
          landed = ws?.name;
        } catch {
          const o = await api.rpc('redeem_org_invite', { p_token: token });
          landed = o?.name;
        }
      }
      await loadSpaces();
      const s = store.spaces[0];
      if (s) {
        document.body.classList.remove('no-team');
        await switchWorkspace(s);
        toast('You are in ' + (landed || s.name), 'success');
        // Same as the signed-in redeem path: one server is usually not all of
        // them, and nothing else on screen would ever say so.
        if (s.org_id) offerTheRest(s.org_id, landed || s.name);
      } else {
        throw new Error('That invite was accepted but did not put you in a server. Ask your admin to add you to one.');
      }
    } catch (e) {
      $('joinErr').textContent = /not valid|invalid|expired|revoked/i.test(e.message || '')
        ? 'That link or code is not valid any more. Ask your admin for a fresh one.'
        : (e.message || 'Could not join with that');
      $('joinErr').classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = was;
    }
  };
  $('joinGo').onclick = go;
  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('noteamOut').onclick = () => import('./core/auth.js').then((m) => m.signOutEverywhere());
}

// Set once at boot, because store.myProfile is a profiles row and profiles does
// not carry the address. The no-team screen has to be able to say which account
// somebody actually signed into.
function sbUserEmail() { return signedInEmail; }

function subscribeUser(uid) {
  import('./sb.js').then(({ subscribe }) => {
    // mention / unread / dm all land here and each bare refreshUnread() is three
    // RPCs (get_unread + rail rollup + DM list), so a twenty-message burst in a
    // Space you are not looking at was sixty requests. Leading-edge coalescing:
    // the first event paints immediately, repeats inside the window collapse
    // into one trailing catch-up. Explicit paths - Mark as read, tab return,
    // sign-in - keep calling refreshUnread() directly and stay instant.
    const coalescedUnread = debounceLead(() => refreshUnread(), 700);
    subscribe('user', 'user:' + uid, {
      mention: () => { coalescedUnread(); flashTitle(); },
      unread: () => coalescedUnread(),
      // set_status / clear_status broadcast here. This was an empty function, so
      // a status set on the phone never appeared on the laptop, and shell.js's
      // 'status:changed' listener had no publisher anywhere in the app - the
      // sidebar foot kept saying "Active" after a write that had succeeded.
      status: (p) => {
        store.myProfile = { ...(store.myProfile || {}), ...(p || {}), id: store.me };
        store.profiles.set(store.me, store.myProfile);
        bus.emit('status:changed');
        bus.emit('profiles');
      },
      // set_presence_status broadcasts the availability the same way, so a hold
      // chosen on one device is reflected on the other rather than being fought
      // over by two beats.
      presence: (p) => {
        if (p?.status) { store.myPresence = p.status; bus.emit('presence:mine', p.status); }
        bus.emit('status:changed');
      },
      claims_changed: async () => {
        const { data } = await sb.auth.refreshSession();
        if (data?.session) sb.realtime.setAuth(data.session.access_token);
      },
      // A direct message, on the topic this client holds for the whole session.
      // Until 0063 the only DM event was on dm:<conversation>, which nothing
      // subscribes to unless that exact conversation is already open - so a DM
      // reached a person only if they happened to be looking straight at it. This
      // is what makes one arrive while you are reading a channel, or in your other
      // Space, or with the phone in your pocket.
      dm: (p) => {
        // refreshUnread() defaults to full, and a full refresh already ENDS in
        // `await refreshDMList()`. Calling it again here was a second, identical
        // request a few milliseconds behind the first, on every incoming DM, for
        // every recipient.
        coalescedUnread();
        flashTitle();
        // Raise an actual notification. This event is the only DM signal that
        // reaches a client which does not already have that conversation open,
        // and until now it only nudged a badge and flashed the title - so a DM
        // arriving while you were reading a channel, in another Space, or with
        // the phone in your pocket told you nothing at all.
        // 'dm:incoming', not 'dm:new': 'dm:new' is the name the sidebar, the
        // DMs panel and Ctrl+Shift+K emit to OPEN the New message picker, and
        // core/dms.js answers it by opening that dialog - so this arrival, on
        // the same name, popped the picker on whoever had just been messaged.
        bus.emit('dm:incoming', p);
        if (p?.conversation_id && p.conversation_id === store.currentDM) {
          import('./core/dms.js').then(({ reconcileDM }) => reconcileDM?.());
        }
      },
      reminder: (p) => toast('Reminder: ' + (p?.note || 'you asked to be reminded')),
      // Leave (0131). Two directions on one event: an approver is told a request
      // is waiting, and an applicant is told what was decided. Both also raise a
      // push and both land in Activity; this is what makes an open panel correct
      // itself without a reload, which matters most for the person watching the
      // screen waiting to hear.
      leave: (p) => {
        bus.emit('leave:changed', p || {});
        coalescedUnread();
        if (p?.what === 'decided') {
          toast(p.status === 'approved' ? 'Your leave was approved' : 'Your leave was not approved');
        }
      },
      // Direct calls (0119). All three ride this topic because it is the one
      // per-person topic that is already authorised and already open on every
      // signed-in client - a call has no channel to broadcast on, and a topic
      // invented for it would need an RLS policy this repo cannot verify. The
      // handlers are one line each on purpose: js/core/call.js owns the state
      // machine, and main.js must not grow a second opinion about it.
      call_ring: (p) => bus.emit('call:ring', { payload: p }),
      call_state: (p) => bus.emit('call:state', { payload: p }),
      call_signal: (p) => bus.emit('call:signalled', { payload: p }),
    });
  });
}

let titleTimer = null;
function flashTitle() {
  // Inside an embed a flashing document.title is invisible - the host tab's
  // title is not ours - and the clear-on-visible listener below cannot fire
  // when the HOST collapses the panel, because visibilitychange reflects the
  // top-level tab, not the panel's layout. wireReports' unread message is the
  // badge surface that works there.
  if (embed.active) return;
  if (document.visibilityState === 'visible') return;
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => {
    document.title = (on = !on) ? '● Dek' : 'Dek';
  }, 900);
  document.addEventListener('visibilitychange', function once() {
    clearInterval(titleTimer);
    document.title = 'Dek';
    document.removeEventListener('visibilitychange', once);
  });
}

// ------------------------------------------------------------------ quick switcher
function quickSwitcher() {
  const box = el('div', 'switcher');
  box.innerHTML = '<input id="qsInput" placeholder="Jump to a channel, person or command…" /><div id="qsRows"></div>';
  const m = modal({ title: '', body: box, wide: true });
  const input = box.querySelector('#qsInput');
  const rows = box.querySelector('#qsRows');
  let items = [];
  let idx = 0;

  const draw = () => {
    rows.innerHTML = items.map((it, i) =>
      `<div class="qs-row${i === idx ? ' sel' : ''}" data-i="${i}">
        <span class="qs-ico">${it.icon || ''}</span><span>${esc(it.label)}</span>
        <span class="muted">${esc(it.hint || '')}</span></div>`).join('');
    rows.querySelectorAll('.qs-row').forEach((n) => {
      n.onclick = () => { m.close(); items[+n.dataset.i].run(); };
    });
  };
  const run = () => {
    // A leading # means full-text search, not channel matching: Ctrl+K is the
    // one entry point now that the Ctrl+F hijack is gone (browser find is
    // muscle memory and stealing it reads as the app being broken).
    if (input.value.startsWith('#')) {
      const q = input.value.slice(1).trim();
      items = [{ icon: '#', hint: 'full-text',
        label: q ? `Search messages for "${q}"` : 'Search all messages',
        run: () => openPanel('search', { q }) }];
      idx = 0;
      draw();
      return;
    }
    const q = input.value.replace(/^[#@>]/, '').trim();
    items = ui.getSwitcherSources().flatMap((s) => {
      try { return s.search(q) || []; } catch { return []; }
    }).slice(0, 12);
    idx = 0;
    draw();
  };
  input.oninput = run;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) { m.close(); items[idx].run(); } }
  };
  run();
}

// ------------------------------------------------------------------ shortcuts
function initShortcuts() {
  wireEscLayers();
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSwitcher(); return; }
    if (e.key === 'Escape') {
      // Layered surfaces (menu, popover, modal, lightbox, inline edit, live
      // recording) are peeled by the LIFO stack in ui.js - its capture
      // fallback or a CloseWatcher cancel gets there first. Reaching this line
      // with a non-empty stack means the press was synthetic or already
      // claimed; standing down keeps one press = one layer unconditional.
      if (escDepth()) return;
      // Stack empty: embedded mode must not collapse the panel - a dock is
      // furniture, not a dialog, and Escape mid-sentence closing it is a
      // data-loss-shaped event. The host decides: we ask.
      if (!typing) {
        if (embed.active) notifyHost('close-request', {});
        else popPanel();
      }
      return;
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('composer')?.focus(); }
    // Plain Shift+T no longer cycles themes: it had no modifier exclusion, so
    // Ctrl+Shift+T (reopen closed tab muscle memory, and our own Threads
    // shortcut) cycled the theme too, and the binding was documented nowhere.
    // Theme switching stays in Appearance (shell menu) and the picker.
  });
}

// ------------------------------------------------------------------ events
bus.on('thread:openById', async ({ threadId, channelId, rootMessageId }) => {
  const c = store.channels.find((x) => x.id === channelId);
  if (c && store.current?.id !== c.id) await openChannel(c, { keepPanel: true });
  const { data } = await sb.from('messages').select('*').eq('id', rootMessageId).maybeSingle();
  if (data) openThread(data);
});

bus.on('message:jump', async ({ messageId }) => {
  const { data } = await sb.from('messages').select('channel_id,seq').eq('id', messageId).maybeSingle();
  if (!data) return;
  const c = store.channels.find((x) => x.id === data.channel_id);
  if (c) openChannel(c, { jumpSeq: data.seq });
});

bus.on('message:editLast', async ({ id }) => {
  const m = store.msgCache.get(id);
  if (!m) return;
  const { formModal } = ui;
  const out = await formModal({
    title: 'Edit message',
    fields: [{ name: 'text', label: '', type: 'textarea', value: m.body_text, rows: 5, required: true }],
    submitLabel: 'Save',
  });
  if (out) api.edit(id, out.text).catch((e) => toast(e.message, 'error'));
});

// A thread reply the author chose to broadcast should show up in the channel
// immediately for them too.
bus.on('thread:alsoSent', ({ message }) => {
  if (!message || message.channel_id !== store.current?.id) return;
  import('./core/channels.js').then(({ reconcile }) => reconcile());
});

// ------------------------------------------------------------------ start
async function main() {
  // Target sizing follows the last pointer ACTUALLY used, not the device's
  // primary one: a touchscreen laptop reports (hover: hover), so media queries
  // never see its fingers no matter how it is being driven. Seeded once from
  // any-pointer:fine so the attribute is honest before the first click, then
  // corrected by every pointerdown for the rest of the session. CSS keys the
  // touch floors off html[data-input="touch"]; see the twins beside each
  // (hover: none) block.
  const inputRoot = document.documentElement;
  inputRoot.dataset.input = matchMedia('(any-pointer: fine)').matches ? 'mouse' : 'touch';
  addEventListener('pointerdown', (e) => {
    inputRoot.dataset.input = e.pointerType === 'mouse' ? 'mouse' : 'touch';
  }, { capture: true });

  // First, before a single pixel: whether this is a standalone tab or a panel
  // inside a dashboard changes the layout, the identity source and which chrome
  // exists at all, and a panel that flashes the standalone app for one frame
  // before correcting itself looks broken in exactly the place it can least
  // afford to.
  initEmbed();
  // Asked to run inside a page that is not on the allowlist. embed.js has put
  // the reason on screen; carrying on would paint a sign-in card in a frame we
  // have just said we do not trust.
  if (embed.refused) return;

  // Before anything reads a preference: keys still on the first product name
  // move to dak.* here (see util.js). tasks.js and activityReport.js read
  // theirs at module eval, which happens inside registerFeatures below.
  migrateLegacyKeys();

  // stash an invite arriving before sign-in so it survives the auth round trip
  const r = route();
  // The org variant is tagged so the far side of the email round trip knows
  // which RPC to redeem it with. Same 30 minute TTL, same reason.
  if (r.kind === 'join') stashPendingInvite(r.token);
  if (r.kind === 'joinOrg') stashPendingInvite('org:' + r.token);

  initTheme();
  hydrateIcons(document);
  initAvatarSweep();
  initNarrowWatcher();
  // Wrapped, because everything after this line is the rest of the application.
  // When initAuth threw on a stale shell it took initComposer, initVoice,
  // initShortcuts and every registration below it with it - so one missing
  // button did not break one button, it broke the whole boot.
  try { initAuth(enter); } catch (e) { console.error('initAuth failed', e); }
  initComposer();
  initVoice();
  // Before registerFeatures, so the engine is listening on the bus by the time
  // features/calls.js paints anything - and before the 'auth' handler inside it
  // could miss a call that was live when this tab reloaded.
  initCall();
  initShortcuts();
  wireScroll();
  registerCoreActions();
  registerCoreHeader();
  // Await it: features register header buttons and panels, and a button that
  // appears a second after the app paints reads as a glitch.
  await registerFeatures({ ui, api, store, bus, sb });
  renderHeaderButtons();
  // A panel inside a dashboard is not a thing you install, and it must not be a
  // thing that registers a service worker: the SW is scoped to the whole origin,
  // so an embed installing one would start serving a cached shell to the
  // standalone app in another tab, on a version the person never chose. The
  // standalone app owns that decision.
  if (!embed.active) initPWA();

  // The phone shell. After features register so badge counts read real stores,
  // and skipped entirely inside a dashboard embed where a thumb bar is noise.
  // initTabBar owns the un-hide now; the line that used to sit here un-hid the
  // EMPTY static nav while the populated copy lost an id race.
  if (!embed.active) {
    import('./tabbar.js').then(({ initTabBar }) => initTabBar()).catch(() => {});
  }

  $('panelClose').onclick = closePanel;
  // The chevron peels one drill-down layer and falls back to a plain close
  // when the stack is empty, so it is never a dead button.
  $('panelBack').onclick = () => popPanel();
  $('btnInvite').onclick = () => inviteDialog();
  if ($('markAllRead')) {
    $('markAllRead').onclick = async () => {
      if (!store.ws) return;
      const gen = openGen;
      for (const c of store.channels) {
        if (gen !== openGen) break;
        try { await api.markRead('channel', c.id, c.last_seq || store.cursor); } catch (e) { console.warn('mark all read', e?.message || e); }
      }
      refreshUnread();
      bus.emit('unread:reload');
      updateTotalUnread();
      toast('All channels marked as read');
    };
  }

  function updateTotalUnread() {
    let total = 0;
    for (const v of store.unread.values()) total += v.unread || 0;
    $('totalUnread').textContent = total;
  }
  $('btnSpaces').onclick = spaceChooser;
  $('btnMembersCount').onclick = () => openPanel('members');

  // Binds the global bar, the channel bar overflow and the user menus. This was
  // imported but never called for several deploys, which left the search field,
  // the More menu, both identity menus and 12 of the 16 registered header
  // buttons completely unclickable - most of the app looked present and did
  // nothing.
  initShell();
  bus.on('invite:open', () => inviteDialog());
  $('installBtn').onclick = () => import('./pwa.js').then((m) => m.promptInstall());

  // Mobile: the sidebar is off-canvas until asked for, and any navigation
  // inside it should close it again.
  $('navToggle').onclick = () => {
    const opening = !document.body.classList.contains('nav-open');
    document.body.classList.toggle('nav-open');
    // Hardware Back closes the drawer before it kills the app. Same contract as
    // the panel sheet: one pushed entry per open, consumed by popstate below.
    if (opening && !history.state?.dekPanel) history.pushState({ dekDrawer: 1 }, '');
  };
  // The merged phone header's place switcher opens the same drawer. Gated on
  // the drawer actually being off-canvas: nav-open drops a scrim that is only
  // correct while the drawer is absolute, so firing it at desktop width would
  // eat every click on the message list.
  $('placeSwitcher').onclick = () => {
    if (!window.matchMedia('(max-width: 860px)').matches) return;
    $('navToggle').click();
  };
  // The Back button's whole new job: peel the topmost mobile surface instead of
  // exiting. Panel first (it overlays the drawer), then drawer, then fall
  // through to the browser default.
  window.addEventListener('popstate', () => {
    if (document.body.classList.contains('panel-open')) {
      import('./ui.js').then(({ closePanel }) => closePanel());
    } else if (document.body.classList.contains('nav-open')) {
      document.body.classList.remove('nav-open');
    }
  });
  // Tapping a place you are GOING puts the drawer away. Tapping a server does
  // not, because on a phone the drawer is the only channel picker there is:
  // switching server and closing it in the same tap drops you into whichever
  // channel that server opens on, with the list you were about to choose from
  // now behind another tap on the hamburger. Reported as "I change server and
  // then I want a specific channel - how would I do that". So a .srv row
  // switches underneath the open drawer and repaints it with the new server's
  // channels, and the tap after that is the one that closes it.
  $('sidebar').addEventListener('click', (e) => {
    const row = e.target.closest('.chan');
    if (row && !row.classList.contains('srv')) document.body.classList.remove('nav-open');
  });
  $('messages').addEventListener('click', () => document.body.classList.remove('nav-open'));

  // Awaited nowhere, so a rejection anywhere on the sign-in path - loadSpaces,
  // switchWorkspace, openChannel - was an unhandled rejection that main().catch
  // could never see. What the person got was a half-drawn shell and silence.
  const bootFailed = (e) => {
    console.error('[dek] sign-in path failed', e);
    toast('Something went wrong loading your Spaces. Reload to try again.', 'error');
  };

  // A session can end without this device asking for it: the refresh token was
  // revoked (admin kick, password change, another tab signing out) and GoTrue
  // drops it with a SIGNED_OUT event while the chat is on screen. Left alone,
  // the app keeps running on dead credentials - every RPC 401s, realtime joins
  // are refused, and nothing explains why. So a forced sign-out takes the same
  // path as the menu one: local caches off the device (shared-phone rule), then
  // a clean reload onto the sign-in card. Deliberate sign-outs latch first via
  // markIntentionalSignOut() and never land here - the latch read below is what
  // makes that sentence true.
  sb.auth.onAuthStateChange((evt) => {
    if (evt !== 'SIGNED_OUT' || !store.me || isIntentionalSignOut()) return;
    try { sessionStorage.setItem('dekKicked', '1'); } catch { /* storage blocked */ }
    Promise.all([
      import('./lib/pagecache.js').then((m) => m.wipe()),
      import('./lib/readcache.js').then((m) => m.wipe()),
      // Attachment cache off the device too. 'dek-storage-v1' must match
      // STORAGE in sw.js.
      window.caches ? caches.delete('dek-storage-v1') : Promise.resolve(),
    ]).catch(() => { /* leaving anyway */ }).finally(() => {
      location.hash = '';
      location.reload();
    });
  });

  // Re-identify while running. The boot-wait branch below registers its own
  // embed:authed listener, but a panel that booted ALREADY signed in has no
  // listener at all - so when the host called identify() with a different
  // person, applyAuth swapped the credentials under a live UI and every
  // surface kept showing the previous account. Same rule as SIGNED_OUT above:
  // caches off the device (shared-phone rule), clean reload, session() finds
  // the new identity at boot. The common identify - same person, fresh
  // credentials - is a no-op here. An unidentifiable handover (no uid and no
  // readable claim) also reloads rather than risk running person A's screen on
  // person B's tokens.
  bus.on('embed:authed', ({ userId } = {}) => {
    if (!embed.active || !store.me) return;
    if (userId === store.me) return;
    Promise.all([
      import('./lib/pagecache.js').then((m) => m.wipe()),
      import('./lib/readcache.js').then((m) => m.wipe()),
      window.caches ? caches.delete('dek-storage-v1') : Promise.resolve(),
    ]).catch(() => { /* leaving anyway */ }).finally(() => {
      location.hash = '';
      location.reload();
    });
  });

  const s = await session();
  if (s) { enter().catch(bootFailed); return; }

  // Embedded with nobody signed in yet. The dashboard already knows who this
  // person is, so the sign-in card is the wrong answer to a question that is
  // about to be answered for us - it just has not arrived yet. Wait for it,
  // saying so, and only fall back to the card if the host never speaks or its
  // handover fails. Someone who reaches that fallback can still sign in by hand,
  // which is the right last resort and a much better one than a dead panel.
  if (embed.active) {
    document.documentElement.classList.add('embed-awaiting-auth');
    const wait = el('div', 'embed-wait');
    wait.innerHTML = '<div class="embed-wait-in"><b>Connecting you to Dek</b>'
      + '<div style="margin-top:6px">Signing in with your dashboard account.</div></div>';
    document.body.appendChild(wait);

    const give = (msg) => {
      wait.remove();
      document.documentElement.classList.remove('embed-awaiting-auth');
      if (msg) toast(msg, 'error');
      showAuth();
    };
    // Long enough to cover a host that fetches a handoff token from its own
    // backend on a slow line, short enough that a misconfigured embed does not
    // just spin forever with no way for the person to do anything about it.
    const giveUp = setTimeout(() => give(null), 15000);

    bus.on('embed:authed', () => { clearTimeout(giveUp); wait.remove();
      document.documentElement.classList.remove('embed-awaiting-auth');
      enter().catch(bootFailed); });
    bus.on('embed:authFailed', ({ message }) => { clearTimeout(giveUp);
      give('Your dashboard could not sign you in: ' + message); });
    return;
  }

  showAuth();
}

window.addEventListener('popstate', (e) => {
  if (history.state && history.state.dekPanel) {
    closePanel();
    e.preventDefault();
    history.pushState(null, '');
  } else if (document.body.classList.contains('nav-open')) {
    document.body.classList.remove('nav-open');
    e.preventDefault();
    history.pushState(null, '');
  }
});

window.addEventListener('hashchange', () => {
  if (store.me) applyRoute();
});

main().catch((e) => {
  console.error(e);
  // The screen somebody sees when everything else has already failed, so it may
  // assume nothing. It set color:#f88 and no background at all, which is pale
  // red on whatever the body happened to be: fine on the dark theme it was
  // written against, effectively invisible on a light one. Painting BOTH ends of
  // the pair is what makes it independent of which theme is on - and of whether
  // any theme is on at all.
  //
  // Tokens are almost always there by this point, because index.html's pre-paint
  // snippet stamps the theme onto <html> before a single module runs and
  // tokens.css is a plain <link> in the head. Almost always is not good enough on
  // the one screen whose whole job is to work when the rest of it did not, so
  // every var() carries a literal fallback picked to contrast with the other one:
  // if the stylesheet never arrived this is still dark red on white, rather than
  // an unreadable message about why nothing works.
  //
  // min-height covers the viewport so the ground belongs to the error screen
  // rather than to whatever was painted before it, and pre-wrap keeps a stack
  // trace inside a 400px embed panel instead of pushing it off an edge nobody
  // thinks to scroll.
  document.body.innerHTML = '<pre style="margin:0;padding:20px;min-height:100vh;'
    + 'white-space:pre-wrap;overflow-wrap:anywhere;'
    + 'background:var(--c-bg, #ffffff);color:var(--c-danger, #b42318);'
    + 'font-family:var(--t-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)">'
    + `Dek failed to start:\n${esc(e.stack || e.message)}</pre>`;
});
