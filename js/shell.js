// The application shell: the global bar, the channel bar, the user menu and the
// overflow menu.
//
// The header used to carry thirteen identical monochrome icons in a row. That is
// not a toolbar, it is a wall - nothing tells you what any of them do, and the
// one control people reach for most (search) was the same 18px glyph as the
// twelve others. This splits the chrome the way every mature chat client does:
//
//   global bar    where you are | what you are looking for | who you are
//   channel bar   the channel, its topic, and actions ON that channel
//   sidebar foot  your own presence, always visible, always changeable
//
// Anything a feature registers beyond the first few contextual actions goes
// behind one overflow menu rather than being appended to the wall.
import { $, el, esc, hueOf, initials } from './util.js';
import { store, bus, nameOf } from './store.js';
import { icon } from './icons.js';
import ui, { openPanel, contextMenu, toast, closePopovers, closePanel } from './ui.js';
import { openThemePicker, effectiveTheme, THEMES, MODES, storedMode } from './theme.js';
import { api, tryRpc } from './api.js';
import { sb } from './sb.js';
import { embed } from './embed.js';

// How many registered header buttons stay visible on the channel bar before the
// rest collapse into the overflow. Four is about where a row stops being
// scannable at a glance.
// ONE source of truth, and it has to be a function because the answer changes
// with the width. There were three numbers before: this constant, ui.js's own
// inlineCap, and a CSS rule hiding `#channelbar .hdr-actions button:nth-child(n+3)`
// below 860px. ui.js painted four, CSS showed two, and this sliced the overflow
// menu from four - so on every phone, buttons three and four were in NEITHER
// place. Measured with 16 registered buttons: 4 painted, 2 visible, 12 in the
// menu, and 2 reachable nowhere at all.
//
// Two on a phone is the right count; the mistake was expressing it in CSS, where
// the menu cannot see it.
const NARROW = '(max-width: 860px)';
const visibleActions = () => (window.matchMedia(NARROW).matches ? 2 : 4);

function avatarFor(userId, size) {
  const p = store.profiles.get(userId) || store.myProfile || {};
  const name = p.display_name || p.username || '?';
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:hsl(${hueOf(userId || name)} 45% 32%)">${esc(initials(name))}</span>`;
}

// ------------------------------------------------------------------ identity
export function paintIdentity() {
  const name = store.myProfile?.display_name || 'you';
  const av = avatarFor(store.me, 24);
  const a2 = avatarFor(store.me, 28);
  if ($('meAvatar')) $('meAvatar').innerHTML = av;
  if ($('meName')) $('meName').textContent = name;
  if ($('sbMeAvatar')) $('sbMeAvatar').innerHTML = a2;
  if ($('sbMeName')) $('sbMeName').textContent = name;

  const st = $('sbMeStatus');
  if (st) {
    const p = store.myProfile || {};
    // This line is the only always-visible statement of your own state, and it
    // used to say "Active" unconditionally whenever no custom status text was
    // set. So picking Away or Do not disturb changed nothing anybody could see,
    // and the honest report was "availability does not work" even once the write
    // was correct. Availability is the fallback now, and it is also shown
    // alongside a custom status, because the two answer different questions:
    // what I am doing, and whether to expect an answer.
    const avail = { away: 'Away', dnd: 'Do not disturb' }[store.myPresence] || 'Active';
    st.textContent = p.status_text
      ? `${p.status_emoji || ''} ${p.status_text}`.trim() + (store.myPresence && store.myPresence !== 'online' ? ` · ${avail}` : '')
      : avail;
  }
}

// ------------------------------------------------------------------ user menu
function userMenu(ev) {
  // Both axes, because there are two now and "Appearance: Saffron" would leave
  // somebody hunting for where they set dark. The mode reads as the person chose
  // it, so "Match device" stays "Match device" rather than resolving to Dark.
  const lookName = THEMES.find((t) => t.id === effectiveTheme())?.name || 'Theme';
  const modeName = MODES.find((m) => m.id === storedMode())?.name || '';
  const themeName = modeName ? `${lookName}, ${modeName}` : lookName;
  contextMenu(ev, [
    // First, because a wrong name is the thing people notice about themselves
    // and could do nothing about until now.
    { label: 'Your profile', onClick: () => bus.emit('identity:open') },
    { label: 'Set a status', onClick: () => bus.emit('status:open') },
    { label: 'Change your password', onClick: () => bus.emit('password:open') },
    { label: 'Pause notifications', onClick: () => openPanel('notifications') },
    '-',
    { label: `Appearance: ${themeName}`, onClick: () => {
      // The picker anchors to the control that opened it.
      const anchor = $('userMenu') || document.body;
      openThemePicker(anchor);
    } },
    { label: 'Keyboard shortcuts', onClick: () => bus.emit('shortcuts:open') },
    // Install and update, in the menu somebody opens when they want to change
    // something about the app itself. The label is the state, not a noun: "App
    // version" is a thing to read, "Update ready" is a thing to press, and the
    // difference has to be visible without opening it.
    { label: $('updateBtn') ? 'Update ready - restart now' : 'App version and updates',
      onClick: () => openPanel('version', {}) },
    '-',
    { label: 'Invite people to this Space', onClick: () => bus.emit('invite:open') },
    // Roadmap 9: embedded, identity belongs to the host dashboard - the bridge
    // carries the signout verb with the full teardown, and a self-service Sign
    // out here would reload into an auth-wait frame that can never sign back in.
    // One teardown, in core/auth.js, so the no-team screen and this menu can
    // never drift apart about what signing out means.
    ...(embed.active ? [] : [{ label: 'Sign out', danger: true, onClick: () =>
      import('./core/auth.js').then((m) => m.signOutEverywhere()) }]),
  ]);
}

// ------------------------------------------------------------------ overflow
// Everything a feature registered that did not fit inline. Built from the same
// registry, so a feature never has to know whether it landed on the bar or in
// the menu.
//
// Below 480px of app-box width the merged single header hides #topbar and
// #headerActions entirely (css/shell.css container block), so the functions
// that lived there ride here instead - same pattern as the registered buttons:
// the menu is where a control goes when its surface disappears. The cutoff is
// read off #app's box, not the viewport, for the same box-fact reason the CSS
// uses a container query; keep the 480 in sync with that block.
function narrowBox() {
  const app = document.getElementById('app');
  return !!app && app.getBoundingClientRect().width <= 480;
}

function mergedHeaderRows() {
  const rows = [
    { label: 'Search', onClick: () => openPanel('search', {}) },
    { label: 'Mark everything read', onClick: () => $('markAllRead')?.click() },
    { label: 'Keyboard shortcuts', onClick: () => bus.emit('shortcuts:open') },
  ];
  const install = $('installBtn');
  if (install && !install.classList.contains('hidden')) {
    rows.push({ label: 'Install app', onClick: () => install.click() });
  }
  // A waiting update has to be reachable from the phone overflow too. The chip
  // features/version.js puts in the top bar is the first offer; on a narrow
  // screen that bar is the first thing that gets squeezed, and somebody hunting
  // for "why am I on the old screen" opens this menu.
  const update = $('updateBtn');
  if (update) rows.push({ label: 'Update ready - restart now', onClick: () => update.click() });
  rows.push({ label: 'App version', onClick: () => openPanel('version', {}) });
  return rows;
}

function overflowMenu(ev) {
  const all = ui.getHeaderButtons ? ui.getHeaderButtons() : [];
  const rest = all.slice(visibleActions());
  const extra = narrowBox() ? mergedHeaderRows() : [];
  if (!rest.length && !extra.length) {
    contextMenu(ev, [{ label: 'Nothing else here yet', onClick: () => {} }]);
    return;
  }
  const items = rest.map((b) => ({
    label: b.title || b.id,
    onClick: () => b.onClick(ev),
  }));
  if (extra.length) items.push('-', ...extra);
  contextMenu(ev, items);
}

// ------------------------------------------------------------------ channel bar
export function paintChannelBar() {
  const c = store.current;
  const name = $('hdrName');
  const topic = $('hdrTopic');
  if (!name) return;
  if (store.currentDM) {
    const conv = store.dms.find((d) => d.conversation_id === store.currentDM);
    const others = (conv?.other_user_ids || []).filter((u) => u !== store.me);
    name.textContent = others.length ? others.map(nameOf).join(', ') : 'Conversation';
    name.dataset.kind = 'dm';
    topic.textContent = '';
  } else if (c) {
    name.textContent = '# ' + c.name;
    name.dataset.kind = 'channel';
    topic.textContent = c.topic || '';
  }
}

// ------------------------------------------------------------------ init
// ------------------------------------------------------------------ connection
// sb.js has always known when delivery is down - every topic reports its status
// and realtimeHealth() answers "is anything being delivered right now" - and the
// app never told anybody. A socket carrying nothing looks exactly like a channel
// where nobody is talking, and the only way to find out was to send a message
// and watch it not arrive.
//
// Two rules keep this from becoming wallpaper:
//   - it appears ONLY when something is wrong, so its absence is the good news
//     and nobody learns to ignore a permanent green light;
//   - it waits before appearing. A rejoin after a tunnel takes a second or two
//     and flashing a red bar at every one of those is worse than saying nothing.
const CONN_GRACE_MS = 3500;

function initConnectionState() {
  const bar = $('connState');
  if (!bar) return;
  const text = $('connStateText');
  let downSince = 0;
  let timer = null;

  const paint = () => {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const down = offline || (downSince && Date.now() - downSince >= CONN_GRACE_MS);
    bar.classList.toggle('hidden', !down);
    if (down) {
      text.textContent = offline ? 'No connection' : 'Reconnecting…';
      bar.classList.toggle('offline', !!offline);
    }
  };

  const markDown = () => {
    if (!downSince) downSince = Date.now();
    clearTimeout(timer);
    timer = setTimeout(paint, CONN_GRACE_MS);
    paint();
  };
  const markUp = () => {
    downSince = 0;
    clearTimeout(timer);
    paint();
  };

  bus.on('realtime:down', markDown);
  bus.on('realtime:subscribed', markUp);
  bus.on('realtime:status', ({ status }) => {
    if (status === 'SUBSCRIBED') markUp();
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') markDown();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('offline', paint);
    window.addEventListener('online', () => { paint(); retryNow(); });
  }

  async function retryNow() {
    const btn = $('connRetry');
    if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }
    try {
      const { retryAllNow, ensureFreshAuth } = await import('./sb.js');
      await ensureFreshAuth({ force: true }).catch(() => {});
      retryAllNow({ force: true });
    } catch { /* offline; the timer keeps trying anyway */ }
    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Retry now'; } }, 2500);
  }
  $('connRetry')?.addEventListener('click', retryNow);
}

export function initShell() {
  $('userMenu')?.addEventListener('click', userMenu);
  $('sidebarMe')?.addEventListener('click', userMenu);
  $('btnMore')?.addEventListener('click', overflowMenu);
  $('btnHelp')?.addEventListener('click', () => bus.emit('shortcuts:open'));
  $('globalSearch')?.addEventListener('click', () => openPanel('search', {}));

  bus.on('workspace', paintIdentity);
  bus.on('profiles', paintIdentity);
  bus.on('channel:open', paintChannelBar);
  bus.on('dm:open', paintChannelBar);
  bus.on('status:changed', paintIdentity);
  initConnectionState();

  // Rotating a phone, or dragging the docked panel wider, changes how many
  // actions fit. Both sides move together because both read visibleActions().
  const applyCap = () => ui.setInlineCap?.(visibleActions());
  applyCap();

  // The same crossing has to retire the phone-only furniture. nav-open keeps
  // the message-list scrim (layout.css:984, outside every width query) alive at
  // widths where the drawer styles no longer apply, so the conversation sat
  // under an invisible layer that ate every click until a reload. The open
  // panel sheet gets the full closePanel teardown, not just the class strip -
  // aside#panel was unhidden by openPanel and stays a stray visible column
  // otherwise; guarded so an idle crossing emits no spurious panel:close.
  window.matchMedia(NARROW).addEventListener('change', (e) => {
    applyCap();
    if (e.matches) return;
    document.body.classList.remove('nav-open');
    if (document.body.classList.contains('panel-open')) closePanel();
  });

  paintIdentity();
}
