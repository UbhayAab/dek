// Per-scope notification levels, quiet hours, desktop notifications and web push.
//
// Two rules shape this module. First, permission is only ever requested from a
// real click inside the panel: a browser that is asked on load says "block"
// forever and there is no way back from that. Second, the client never decides
// on its own that something is worth interrupting for - it re-uses exactly the
// same predicate the server uses (mention, or a channel explicitly set to "all")
// so the desktop toast and the push notification agree.
import { store, bus, nameOf } from '../store.js';
import { el, esc, plain } from '../util.js';
import { icon } from '../icons.js';
import { embed } from '../embed.js';

const MIN = 60000;
const HOUR = 3600000;

const LEVELS = [
  { value: 'inherit', label: 'Default' },
  { value: 'all', label: 'All' },
  { value: 'mentions', label: 'Mentions' },
  { value: 'nothing', label: 'Nothing' },
];

const PAUSES = [
  { label: '30 minutes', ms: 30 * MIN },
  { label: '1 hour', ms: HOUR },
  { label: 'Until tomorrow', tomorrow: true },
];

// The VAPID application server public key. It is public by construction - the
// browser hands it to the push service in the clear on every subscribe - but the
// client config has no slot for it, so it is resolved at runtime with a
// deployment fallback. The matching private key stays in the web-push function.
const VAPID_FALLBACK = 'BMOAGjdDdmNngOJeTZvTnap0xG7U_QpGdo19fnvcPWXFQygmPW484rruKsGETRW77ad-D2RwoeYUtE3EdNNXJHs';
const vapidKey = () =>
  (typeof window !== 'undefined' && window.DEK_VAPID_PUBLIC_KEY) ||
  document.querySelector('meta[name="vapid-public-key"]')?.content ||
  VAPID_FALLBACK;

// Local mirror of notification_prefs so the message:new path never has to wait
// on a round trip to decide whether to stay quiet.
let prefs = {};

const tomorrowMorning = () => {
  const d = new Date(Date.now() + 86400000);
  d.setHours(9, 0, 0, 0);
  return d;
};

const hasNotificationApi = () => typeof Notification !== 'undefined';
const permission = () => (hasNotificationApi() ? Notification.permission : 'unsupported');

function mentionsMe(m) {
  if (Array.isArray(m.mention_user_ids) && m.mention_user_ids.includes(store.me)) return true;
  return m.mention_scope === 'here' || m.mention_scope === 'channel';
}

function paused() {
  return !!prefs.dnd_until && new Date(prefs.dnd_until).getTime() > Date.now();
}

// Quiet hours wrap midnight (22 -> 7 is the common case), so the comparison has
// to handle start > end.
function inQuietHours() {
  const s = prefs.quiet_start;
  const e = prefs.quiet_end;
  if (s == null || e == null || s === e) return false;
  // The hour must be the person's own. A device clock lies for anyone whose
  // phone was set once and never updated on travel; the profile carries a
  // timezone (set_profile defaults it) so quiet hours mean the same thing on a
  // laptop in another zone.
  let h;
  try {
    h = Number(new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', hour12: false, timeZone: store.myProfile?.timezone || undefined,
    }).format(new Date()));
  } catch {
    h = new Date().getHours();
  }
  return s < e ? h >= s && h < e : h >= s || h < e;
}

// ------------------------------------------------------------------ web push
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pushSupported = () =>
  'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;

async function pushRegistration() {
  if (!pushSupported()) return null;
  try { return (await navigator.serviceWorker.getRegistration()) || null; } catch { return null; }
}

// Is this subscription bound to the key we are advertising NOW? A push
// subscription is minted against one applicationServerKey and is worthless the
// moment the server signs with a different one - the push service answers
// VapidPkHashMismatch and nothing arrives, forever, with no error anywhere the
// person can see. That is not hypothetical: index.html published one key while
// the sender held another, so every subscription ever made here was void.
function boundToCurrentKey(sub, wantB64) {
  const raw = sub?.options?.applicationServerKey;
  if (!raw) return true;                        // browser will not say; assume ok
  const want = urlBase64ToUint8Array(wantB64);
  const have = new Uint8Array(raw);
  if (have.length !== want.length) return false;
  for (let i = 0; i < have.length; i++) if (have[i] !== want[i]) return false;
  return true;
}

async function subscribeToPush(api) {
  const reg = await pushRegistration();
  if (!reg) throw new Error('The service worker is not registered on this page yet.');
  const key = vapidKey();
  let existing = await reg.pushManager.getSubscription();
  // Re-subscribing is the ONLY way to move to a new key; the old one cannot be
  // re-signed. Drop it rather than keep a subscription that can never deliver.
  if (existing && !boundToCurrentKey(existing, key)) {
    try { await existing.unsubscribe(); } catch { /* it is going away either way */ }
    existing = null;
  }
  const sub = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  const j = sub.toJSON();
  if (!j.keys?.p256dh || !j.keys?.auth) throw new Error('The browser returned a subscription without keys.');
  await api.pushSubscribe(sub.endpoint, j.keys.p256dh, j.keys.auth, navigator.userAgent);
  return sub;
}

// ------------------------------------------------------------------ raising one
function raise(m) {
  if (!m || m.author_id === store.me) return;
  if (document.visibilityState !== 'hidden') return;
  if (permission() !== 'granted') return;
  if (paused() || inQuietHours()) return;

  const level = store.notify.get(m.channel_id)?.notify_level;
  if (level === 'nothing') return;
  if (!(mentionsMe(m) || level === 'all')) return;

  const ch = store.channels.find((c) => c.id === m.channel_id);
  const title = nameOf(m.author_id) + (ch ? ' in #' + ch.name : '');
  const body = plain(m.body_text, 140) ||
    (Array.isArray(m.attachments) && m.attachments.length ? 'sent an attachment' : 'sent a message');
  const url = m.channel_id && m.seq
    ? location.pathname + location.search + '#/m/' + m.channel_id + '/' + m.seq
    : location.pathname;
  const opts = {
    body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'dak-' + (m.channel_id || 'msg'),
    data: { url, messageId: m.id },
  };

  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      n.close();
      if (m.id) bus.emit('message:jump', { messageId: m.id });
    };
  } catch {
    // Chrome on Android forbids the constructor entirely; the service worker
    // path is the only one that works there, and sw.js already handles the click.
    navigator.serviceWorker?.getRegistration()
      .then((reg) => reg?.showNotification(title, opts))
      .catch(() => {});
  }
}

// A direct message. Separate from raise() because every gate in that function is
// a CHANNEL question and none of them mean anything here: a DM has no
// notify_level to consult, and asking whether it mentions you is absurd when the
// whole message is addressed to you. Both of those gates are why routing DMs
// through raise() would have silently dropped every one of them.
//
// This is why nothing arrived. raise() was bound to 'message:new', which only
// channel messages emit; the DM path is separate all the way down, and
// onIncomingDM in core/dms.js opens with `if (store.currentDM !== conversationId)
// return` - so a DM from somebody whose conversation you did not already have on
// screen never reached the client at all. The user-topic 'dm' event in main.js
// DOES arrive for every DM regardless of what you are looking at; it just
// refreshed a badge and flashed the title, and told you nothing.
//
// The payload is {conversation_id, author_id, seq, created_at} - deliberately no
// body text, so the sender's name is all this can say. That is the right amount
// for something that appears on a lock screen anyway.
export function raiseDM(p) {
  if (!p || p.author_id === store.me) return;
  if (document.visibilityState !== 'hidden') return;
  if (permission() !== 'granted') return;
  if (paused() || inQuietHours()) return;

  const title = nameOf(p.author_id) || 'New message';
  const opts = {
    body: 'Sent you a direct message',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'dak-dm-' + (p.conversation_id || 'dm'),
    data: { conversationId: p.conversation_id },
  };
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      n.close();
      if (p.conversation_id) bus.emit('dm:jump', { conversationId: p.conversation_id });
    };
  } catch {
    navigator.serviceWorker?.getRegistration()
      .then((reg) => reg?.showNotification(title, opts))
      .catch(() => {});
  }
}

// ------------------------------------------------------------------ panel
function seg(current, onPick) {
  const host = el('div', 'hnotif-seg');
  for (const lv of LEVELS) {
    const b = el('button', 'sm ghost' + (lv.value === current ? ' on' : ''), esc(lv.label));
    b.title = lv.value === 'inherit' ? 'Follow the Space default' : 'Notify me about ' + lv.label.toLowerCase();
    b.onclick = () => onPick(lv.value, b, host);
    host.appendChild(b);
  }
  return host;
}

const hourOptions = (selected) => Array.from({ length: 24 }, (_, h) =>
  `<option value="${h}"${h === selected ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');

function renderPanel(ui, api) {
  return async function render(body) {
    body.innerHTML = '<div class="muted pad">loading…</div>';
    if (!store.ws) {
      body.innerHTML = '<div class="empty">Open a Space first. Notification levels are stored per Space, per channel.</div>';
      return;
    }

    let data;
    try {
      data = await api.notifySettings(store.ws.id);
    } catch (e) {
      body.innerHTML = `<div class="empty">Could not load your notification settings.<br>${esc(e.message)}</div>`;
      return;
    }
    prefs = data?.prefs || {};
    const levels = new Map((data?.channels || []).map((c) => [c.scope_id, c.notify_level]));

    body.innerHTML = '';

    // ---------------- quiet hours ----------------
    body.appendChild(el('h4', 'sec', 'Quiet hours'));
    const qh = el('div', 'hnotif-block', `
      <div class="hnotif-hours">
        <label class="field"><span class="field-label">From</span>
          <select data-q="start">${hourOptions(prefs.quiet_start ?? 22)}</select></label>
        <label class="field"><span class="field-label">Until</span>
          <select data-q="end">${hourOptions(prefs.quiet_end ?? 7)}</select></label>
        <button class="sm" data-a="qh">Save</button>
      </div>
      <div class="muted hnotif-hint">${prefs.quiet_start == null
        ? 'Not set. Pick a window and nothing will interrupt you inside it.'
        : `Silent between ${String(prefs.quiet_start).padStart(2, '0')}:00 and ${String(prefs.quiet_end).padStart(2, '0')}:00.`}</div>`);
    body.appendChild(qh);
    qh.querySelector('[data-a="qh"]').onclick = async () => {
      const s = +qh.querySelector('[data-q="start"]').value;
      const e = +qh.querySelector('[data-q="end"]').value;
      try {
        const row = await api.setQuietHours(s, e);
        prefs = { ...prefs, quiet_start: row?.quiet_start ?? s, quiet_end: row?.quiet_end ?? e };
        ui.toast('Quiet hours saved');
        ui.refreshPanel();
      } catch (err) { ui.toast(err.message || 'Could not save quiet hours', 'error'); }
    };

    // ---------------- do not disturb ----------------
    body.appendChild(el('h4', 'sec', 'Pause notifications'));
    const dnd = el('div', 'hnotif-block');
    const paintDnd = () => {
      dnd.innerHTML = `<div class="muted hnotif-hint">${paused()
        ? 'Paused until ' + esc(new Date(prefs.dnd_until).toLocaleString([], { hour: '2-digit', minute: '2-digit' }))
        : 'Not paused. Mentions and channels set to All will interrupt you.'}</div>`;
      const row = el('div', 'row gap hnotif-seg');
      for (const opt of PAUSES) {
        const b = el('button', 'sm ghost', esc(opt.label));
        b.onclick = async () => {
          const at = opt.tomorrow ? tomorrowMorning() : new Date(Date.now() + opt.ms);
          try {
            const r = await api.setDnd(at.toISOString());
            prefs = { ...prefs, dnd_until: r?.dnd_until || at.toISOString() };
            paintDnd();
            ui.toast('Notifications paused');
          } catch (e) { ui.toast(e.message || 'Could not pause notifications', 'error'); }
        };
        row.appendChild(b);
      }
      if (paused()) {
        const off = el('button', 'sm ghost', 'Resume now');
        off.onclick = async () => {
          try {
            await api.setDnd(null);
            prefs = { ...prefs, dnd_until: null };
            paintDnd();
            ui.toast('Notifications resumed');
          } catch (e) { ui.toast(e.message || 'Could not resume notifications', 'error'); }
        };
        row.appendChild(off);
      }
      dnd.appendChild(row);
    };
    paintDnd();
    body.appendChild(dnd);

    // ---------------- desktop notifications ----------------
    body.appendChild(el('h4', 'sec', 'This device'));
    const dev = el('div', 'hnotif-block');
    const paintDevice = () => {
      dev.innerHTML = '';
      const p = permission();
      const line = el('div', 'muted hnotif-hint');
      dev.appendChild(line);

      // Embedded mode: Notification.requestPermission() can never succeed from
      // a cross-origin iframe - the Notifications spec deliberately defines no
      // Permissions-Policy feature for it - so instead of a button that is dead
      // on arrival, say who does handle notifications. Push needs the same
      // permission, so the whole device block below is skipped with it.
      if (embed.active) {
        line.textContent = 'Notifications are handled by your dashboard while Dek runs embedded here.';
        return;
      }

      if (p === 'unsupported') {
        line.textContent = 'This browser has no Notification API, so desktop alerts are not available here.';
      } else if (p === 'denied') {
        line.textContent = 'Notifications are blocked for this site in your browser settings. Re-allow them there and reopen this panel.';
      } else if (p === 'granted') {
        line.textContent = 'Desktop notifications are on. You get one when a message mentions you, or arrives in a channel set to All, while Dek is in the background.';
        const test = el('button', 'sm ghost', 'Send a test notification');
        test.onclick = () => {
          try { new Notification('Dek', { body: 'This is what a notification looks like.', icon: './icons/icon-192.png' }); }
          catch { ui.toast('The browser refused to show it from this page', 'error'); }
        };
        dev.appendChild(test);
      } else {
        line.textContent = 'Desktop notifications are off. Turning them on lets Dek alert you while it is in the background.';
        const ask = el('button', 'sm', 'Turn on desktop notifications');
        ask.onclick = async () => {
          try {
            const res = await Notification.requestPermission();
            ui.toast(res === 'granted' ? 'Desktop notifications on' : 'Permission not granted',
              res === 'granted' ? 'success' : 'info');
          } catch (e) { ui.toast(e.message || 'The browser refused the request', 'error'); }
          paintDevice();
        };
        dev.appendChild(ask);
      }

      // ---- web push ----
      const pushLine = el('div', 'muted hnotif-hint');
      dev.appendChild(pushLine);
      const key = vapidKey();
      if (!pushSupported()) {
        pushLine.textContent = 'Web push needs a service worker and the Push API, which this browser does not offer. Desktop notifications above still work while Dek is open.';
      } else if (!key) {
        pushLine.textContent = 'Web push is unavailable: this deployment has not published a VAPID public key to the client, and a subscription cannot be created without one.';
        const b = el('button', 'sm ghost', 'Send pushes to this device');
        b.disabled = true;
        dev.appendChild(b);
      } else {
        pushLine.textContent = 'Web push reaches you even when Dek is closed.';
        const b = el('button', 'sm ghost', 'Send pushes to this device');
        b.onclick = async () => {
          b.disabled = true;
          try {
            if (permission() !== 'granted') {
              const res = await Notification.requestPermission();
              if (res !== 'granted') { ui.toast('Push needs notification permission', 'error'); return; }
            }
            await subscribeToPush(api);
            ui.toast('This device is subscribed to push', 'success');
            pushLine.textContent = 'This device is subscribed to push.';
          } catch (e) {
            ui.toast(e.message || 'Could not subscribe to push', 'error');
            pushLine.textContent = 'Push subscription failed: ' + (e.message || 'unknown error');
          } finally { b.disabled = false; }
        };
        dev.appendChild(b);
        pushRegistration().then(async (reg) => {
          if (!reg) {
            pushLine.textContent = 'The service worker has not taken control of this page yet. Reload once, then subscribe.';
            b.disabled = true;
            return;
          }
          const sub = await reg.pushManager.getSubscription().catch(() => null);
          if (sub) { pushLine.textContent = 'This device is already subscribed to push.'; b.textContent = 'Re-register this device'; }
        }).catch(() => {});
      }
    };
    paintDevice();
    body.appendChild(dev);

    // ---------------- per channel ----------------
    body.appendChild(el('h4', 'sec', 'Channels'));
    const channels = store.channels.filter((c) => c.kind !== 'voice' && !c.archived_at);
    if (!channels.length) {
      body.appendChild(el('div', 'empty',
        'No channels you can see yet. Every channel you join appears here with its own notification level.'));
      return;
    }
    for (const c of channels) {
      const row = el('div', 'hnotif-row');
      row.appendChild(el('div', 'hnotif-name',
        `<span class="ch-ico">${c.is_private ? icon('lock') : '#'}</span> ${esc(c.name)}`));
      row.appendChild(seg(levels.get(c.id) || 'inherit', async (value, btn, host) => {
        const prev = levels.get(c.id) || 'inherit';
        host.querySelectorAll('button').forEach((n) => n.classList.remove('on'));
        btn.classList.add('on');
        try {
          await api.setNotifyLevel('channel', c.id, value, null);
          levels.set(c.id, value);
          store.notify.set(c.id, { ...(store.notify.get(c.id) || {}), notify_level: value });
          // the sidebar dims muted channels, so it has to hear about this
          import('../core/channels.js').then((m) => m.renderChannels()).catch(() => {});
        } catch (e) {
          host.querySelectorAll('button').forEach((n) => n.classList.remove('on'));
          [...host.children][LEVELS.findIndex((l) => l.value === prev)]?.classList.add('on');
          ui.toast(e.message || 'Could not change the level', 'error');
        }
      }));
      body.appendChild(row);
    }
  };
}

// ------------------------------------------------------------------ register
export function register({ ui, api }) {
  injectStyle();

  ui.registerPanel({
    id: 'notifications',
    title: 'Notifications',
    render: renderPanel(ui, api),
  });

  ui.addHeaderButton({
    id: 'notifications',
    label: icon('bell'),
    title: 'Notification settings',
    order: 85,
    onClick: () => ui.openPanel('notifications'),
  });

  ui.addSlashCommand({
    name: 'notify',
    description: 'Set this channel to all, mentions, nothing or default',
    run: async (arg) => {
      if (!store.current) { ui.toast('Open a channel first', 'error'); return; }
      const want = (arg || '').trim().toLowerCase() || 'all';
      const lv = want === 'default' ? 'inherit' : want;
      if (!LEVELS.some((l) => l.value === lv)) {
        ui.toast('Use /notify all, mentions, nothing or default', 'error');
        return;
      }
      await api.setNotifyLevel('channel', store.current.id, lv, null);
      store.notify.set(store.current.id, { ...(store.notify.get(store.current.id) || {}), notify_level: lv });
      import('../core/channels.js').then((m) => m.renderChannels()).catch(() => {});
      ui.toast('#' + store.current.name + ' set to ' + (lv === 'inherit' ? 'default' : lv));
    },
  });

  // A failure here must never break the message render path.
  bus.on('message:new', ({ msg }) => { try { raise(msg); } catch { /* ignore */ } });
  // The DM half, which had no listener at all. main.js emits this from the
  // user-topic 'dm' event, which is the one place every DM arrives whether or
  // not its conversation is open. ('dm:new' is the New-message picker's name.)
  bus.on('dm:incoming', (p) => { try { raiseDM(p); } catch { /* ignore */ } });

  // Somebody just granted the permission from the Activity panel's offer.
  // Permission alone only covers the tab being OPEN; the subscription is what
  // reaches a closed phone, and until now it was a button three taps deep in a
  // settings panel that exactly one account in this deployment had ever found.
  bus.on('push:subscribe', async () => {
    try {
      await subscribeToPush(api);
      ui.toast('You will be notified even when Dek is closed', 'success');
    } catch (e) {
      // Not an error the person caused, and desktop notifications still work
      // while the tab is open, so this is a note rather than a failure.
      console.warn('[dak] push subscribe failed', e);
    }
  });

  // ---- the nudge, on every open ----
  //
  // 16 of 272 accounts on this deployment have a push subscription. The panel
  // above is thorough and nobody finds it: turning notifications on was three
  // taps deep in a settings sheet. So ask on the way in instead.
  //
  // The one thing the browser will not let us do is re-prompt after a refusal.
  // Once permission is 'denied', requestPermission() resolves 'denied'
  // immediately and shows nothing, on every engine. "Ask every single time"
  // therefore has to mean two different things:
  //   default -> actually ask, every open, until they choose
  //   denied  -> we cannot ask, so say plainly where the switch is
  // Anything else would be a button that silently does nothing, which is worse
  // than no button at all.
  let nudgeShown = false;
  const nudge = async () => {
    if (embed.active || nudgeShown) return;
    if (!hasNotificationApi()) return;
    const p = permission();

    // Granted already: the permission is only half of it. The subscription is
    // what reaches a closed phone, and it can be missing because they granted
    // on another device, cleared site data, or the VAPID key was rotated. Fix
    // it silently - there is nothing to ask anybody.
    if (p === 'granted') {
      try {
        const reg = await pushRegistration();
        if (reg && vapidKey() && !(await reg.pushManager.getSubscription())) {
          await subscribeToPush(api);
        }
      } catch { /* desktop alerts still work; nothing to say to anybody */ }
      return;
    }

    nudgeShown = true;
    const wrap = el('div', 'notif-nudge');
    const txt = el('div', 'notif-nudge-txt');
    const row = el('div', 'notif-nudge-row');

    if (p === 'denied') {
      // Deliberately not a "Turn on" button: it cannot work. Per-browser
      // wording, because "check your browser settings" is the advice people
      // read and then still cannot find it.
      const how = /iPhone|iPad|iPod/i.test(navigator.userAgent)
        ? 'iOS: add Dek to your Home Screen, open it from there, then Settings > Notifications > Dek.'
        : /Android/i.test(navigator.userAgent)
          ? 'Android Chrome: tap the lock icon beside the address bar, then Permissions > Notifications > Allow.'
          : 'Click the lock or sliders icon beside the address bar, then set Notifications to Allow.';
      txt.innerHTML = '<b>Notifications are blocked</b><br><span class="notif-nudge-how"></span>';
      txt.querySelector('.notif-nudge-how').textContent = how;
    } else {
      txt.innerHTML = '<b>Turn on notifications</b><br>'
        + '<span class="notif-nudge-how">Get told when somebody messages you, '
        + 'even when Dek is closed.</span>';
      const yes = el('button', 'sm', 'Turn on');
      yes.onclick = async () => {
        yes.disabled = true;
        try {
          const res = await Notification.requestPermission();
          if (res === 'granted') {
            bus.emit('push:subscribe');
            ui.toast('Notifications are on', 'success');
            wrap.remove();
            return;
          }
          ui.toast('Left off. You can turn them on from the bell any time.', 'info');
        } catch { ui.toast('The browser refused the request', 'error'); } finally { yes.disabled = false; }
        wrap.remove();
      };
      row.appendChild(yes);
    }

    const no = el('button', 'sm ghost', 'Not now');
    // Dismissed for THIS open only, deliberately. He asked for it on every
    // open, and the cost of asking again is one tap; the cost of never asking
    // again is the 94% who currently cannot be reached at all.
    no.onclick = () => wrap.remove();
    row.appendChild(no);
    wrap.append(txt, row);
    document.body.appendChild(wrap);
  };

  // After sign-in, not at module load: before a session exists there is nobody
  // to subscribe, and the prompt would land on top of the login card.
  bus.on('auth', () => { setTimeout(() => { nudge().catch(() => {}); }, 2500); });

  // Keep the quiet-hours and pause mirror warm without a panel ever being opened.
  const sync = async () => {
    if (!store.ws) return;
    try { prefs = (await api.notifySettings(store.ws.id))?.prefs || {}; }
    catch { /* the defaults simply mean "nothing is muted" */ }
  };
  bus.on('workspace', sync);
  bus.on('auth', sync);
}

// ------------------------------------------------------------------ style
function injectStyle() {
  if (document.getElementById('hnotif-style')) return;
  const s = document.createElement('style');
  s.id = 'hnotif-style';
  s.textContent = `
    .hnotif-block{padding:2px 4px 10px;display:flex;flex-direction:column;gap:8px}
    .hnotif-hours{display:flex;gap:8px;align-items:flex-end}
    .hnotif-hours .field{margin:0;flex:1}
    .hnotif-hint{font-size:12px;line-height:1.5}
    /* The on-open nudge. Bottom-anchored above the phone tab bar rather than a
       modal, because it must not block the app on the way in: somebody who
       ignores it should still land in their channel. */
    .notif-nudge{position:fixed;left:50%;transform:translateX(-50%);
      bottom:calc(env(safe-area-inset-bottom,0px) + 72px);z-index:60;
      width:min(420px,calc(100vw - 24px));display:flex;align-items:center;gap:12px;
      flex-wrap:wrap;padding:12px 14px;border-radius:var(--r-lg,12px);
      background:var(--c-surface,#1A171E);color:var(--c-text,#fff);
      border:1px solid var(--c-border,#2E2833);box-shadow:var(--e-3,0 8px 28px rgba(0,0,0,.34));
      animation:notifNudgeIn .22s ease both}
    @media (min-width:861px){.notif-nudge{bottom:calc(env(safe-area-inset-bottom,0px) + 20px)}}
    .notif-nudge-txt{flex:1 1 220px;font-size:13px;line-height:1.45}
    .notif-nudge-how{color:var(--c-text-2,#BBAFC2);font-size:12px}
    .notif-nudge-row{display:flex;gap:8px;flex:0 0 auto;margin-left:auto}
    @keyframes notifNudgeIn{from{opacity:0;transform:translateX(-50%) translateY(8px)}
      to{opacity:1;transform:translateX(-50%) translateY(0)}}
    @media (prefers-reduced-motion:reduce){.notif-nudge{animation:none}}
    .hnotif-seg{display:flex;gap:4px;flex-wrap:wrap}
    .hnotif-seg button{padding:4px 8px;font-size:12px}
    .hnotif-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--line)}
    .hnotif-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
    /* .hnotif-name is a nowrap line of text, not a flex row, so the lock has to
       stay in the inline flow - a block SVG inside this span would break the
       line. inline-flex keeps the 16px .ch-ico column the "#" rows already use,
       so private and public channels line up on one left edge. */
    .hnotif-name .ch-ico{display:inline-flex;align-items:center;justify-content:center;vertical-align:-2px}
    .hnotif-name .ch-ico .ico{width:14px;height:14px;margin:0}
    @media (max-width:860px){ .hnotif-row{flex-direction:column;align-items:stretch} }`;
  document.head.appendChild(s);
}
