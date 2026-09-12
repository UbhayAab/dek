// Activity: the one place that answers "was anything actually for me".
//
// The core panel (js/core/actions.js) is a flat list you can read and nothing
// else. It has no unread state at all - no dot, no way to say "seen it", no way
// to clear one - so the only way to make an item stop nagging you is to open it,
// and the only way to find out whether anything is there is to open the tab and
// read all of it. For somebody who opens this on a phone twice a day, between
// other jobs, that is the same as having no Activity tab.
//
// This replaces it. registerPanel overwrites by id and `replaces: true` declares
// that intent, the same takeover uxfix.js does for Members and Search, so core
// keeps its version as the fallback for a server without migration 0128.
//
// Three things it adds, all of them asked for in the same breath:
//
//   1. A READ STATE PER ITEM, and a way to clear one WITHOUT opening it. Not a
//      watermark: seeing one thing must not mark the other four read, because
//      for this reader the one that was actually for them is the one that gets
//      cleared by the four that were not. Marking something back to unread is
//      the other half - "I have seen it and I still have to do something about
//      it" is a real answer and a watermark cannot express it.
//   2. FILTERS, because "show me only the things with my name on them" is the
//      question a non-power-user actually has and the flat list could not
//      answer it.
//   3. A TAG IN A DIRECT MESSAGE IS ITS OWN KIND. In a group DM "@Neha can you
//      take this" is addressed to one person and the other forty messages are
//      not. 0128 records it; this shows it under Mentions, where it belongs.
import { store, bus, nameOf } from '../store.js';
import { el, esc, fmt, plain, relTime, debounce } from '../util.js';
import { tryRpc, rpc } from '../api.js';
import { icon } from '../icons.js';
import { avatarHtml } from '../core/messages.js';
import { openChannel } from '../core/channels.js';

const PANEL = 'activity';
const CLS = 'act';
const FILTER_KEY = 'dak.activity.filter';

// Unread FIRST, and it is the default. The single most repeated complaint about
// Slack's own version of this tab is that it opens on everything: somebody
// coming back to a phone after half a day wants what they have not dealt with,
// not a scrollback of what they have. Mentions next, because it is the reason
// the tab exists at all.
const FILTERS = [
  { key: 'unread', label: 'Unread' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'dms', label: 'DMs' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'all', label: 'Everything' },
];

// kind -> how the line reads. The verb is what somebody scans, so it goes in
// bold next to the name and the rest is context.
const VERB = {
  mention: 'mentioned you',
  dm_mention: 'tagged you in a direct message',
  dm: 'sent you a direct message',
  reaction: 'reacted to your message',
  dm_reaction: 'reacted to your message',
  thread_reply: 'replied in your thread',
  task: 'gave you a task',
  // Leave (0131). An approver sees the first, an applicant the second, and
  // nobody sees the other one - get_activity decides that, not this map.
  leave_request: 'is asking for time off',
  leave_decision: 'decided on your time off',
};
// The two that mean somebody typed your name. They get the accent dot and they
// are what the tab-bar badge counts; everything else is worth a mark, not an
// alarm.
// leave_request is waiting on YOU to do something and leave_decision is the
// answer somebody has been waiting for; both are as addressed-to-you as a
// mention, so both count.
const BY_NAME = new Set(['mention', 'dm_mention', 'task', 'leave_request', 'leave_decision']);

let uiRef = null;
// `total` deliberately excludes reactions: somebody liking what you wrote is
// worth seeing and is not worth a mark on the tab. `in_feed` is every unread
// row, which is what "4 unread" inside the panel has to mean.
let unread = { total: 0, mentions: 0, dms: 0, tasks: 0, in_feed: 0 };

const readFilter = () => (FILTERS.some((f) => f.key === localStorage.getItem(FILTER_KEY))
  ? localStorage.getItem(FILTER_KEY) : 'unread');

function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
    .${CLS}-bar{display:flex;gap:var(--s-2);margin-bottom:var(--s-4);overflow-x:auto;
      scrollbar-width:none;-webkit-overflow-scrolling:touch}
    .${CLS}-bar::-webkit-scrollbar{height:0}
    .${CLS}-bar button{flex:none;min-height:32px;padding:var(--s-2) var(--s-5);
      border:var(--bw) solid var(--c-border);border-radius:var(--r-full);
      background:none;color:var(--c-text-2);box-shadow:none;
      font-size:var(--t-sm);font-weight:var(--t-semibold);white-space:nowrap}
    .${CLS}-bar button:hover{background:var(--c-surface-2);color:var(--c-text)}
    .${CLS}-bar button.on{background:var(--c-accent-quiet);border-color:var(--c-accent);
      color:var(--c-accent)}
    .${CLS}-bar .${CLS}-n{margin-left:var(--s-2);opacity:.75;font-weight:var(--t-normal)}

    .${CLS}-top{display:flex;align-items:center;gap:var(--s-3);margin-bottom:var(--s-4)}
    .${CLS}-top .${CLS}-count{flex:1;min-width:0;color:var(--c-text-2);font-size:var(--t-sm)}

    /* A row is a button-shaped thing you tap to GO somewhere, with one control
       on it that does not go anywhere. Keeping the mark-read control out of the
       row's own click is the whole point: clearing four items you do not care
       about must not mean visiting four channels. */
    .${CLS}-row{display:flex;gap:var(--s-4);padding:var(--s-4) var(--s-3);
      border-bottom:var(--bw) solid var(--c-border);cursor:pointer}
    .${CLS}-row:hover{background:var(--c-surface-2)}
    .${CLS}-dot{flex:none;width:8px;height:8px;margin-top:var(--s-4);border-radius:50%;
      background:var(--c-accent)}
    .${CLS}-dot.${CLS}-quiet{background:var(--c-text-3,var(--c-text-2));opacity:.55}
    .${CLS}-dot.${CLS}-none{background:none}
    .${CLS}-main{flex:1;min-width:0}
    .${CLS}-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s-2);
      font-size:var(--t-sm);color:var(--c-text-2);line-height:var(--t-snug)}
    .${CLS}-head b{color:var(--c-text);font-weight:var(--t-semibold)}
    .${CLS}-head .${CLS}-verb{color:var(--c-text);font-weight:var(--t-semibold)}
    .${CLS}-body{margin-top:var(--s-2);font-size:var(--t-base);line-height:var(--t-snug);
      overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .${CLS}-read .${CLS}-head b,.${CLS}-read .${CLS}-verb{font-weight:var(--t-normal)}
    .${CLS}-read .${CLS}-body{opacity:.6}
    .${CLS}-mark{flex:none;align-self:flex-start;width:30px;height:30px;min-height:0;
      padding:0;border:none;border-radius:var(--r-sm);background:none;
      color:var(--c-text-2);box-shadow:none;font-size:var(--t-sm)}
    .${CLS}-mark:hover{background:var(--c-surface-3);color:var(--c-text)}
    .${CLS}-day{margin:var(--s-6) 0 var(--s-2);color:var(--c-text-2);
      font-size:var(--t-2xs);font-weight:var(--t-bold);letter-spacing:.07em;
      text-transform:uppercase}
    .${CLS}-day:first-child{margin-top:0}
    .${CLS}-nudge{border:var(--bw) solid var(--c-border);border-radius:var(--r-md);
      padding:var(--s-5);margin-bottom:var(--s-5);background:var(--c-surface-2)}`;
  document.head.appendChild(s);
}

// Today / Yesterday / the date. A feed with no day breaks is a wall, and the
// question "did this happen since I last looked" is most of what somebody is
// asking when they open it.
function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function refreshUnread() {
  if (!store.ws) return;
  const [u] = await tryRpc('activity_unread', { p_workspace: store.ws.id });
  if (!u || typeof u !== 'object') return;
  const next = {
    total: +u.total || 0, mentions: +u.mentions || 0,
    dms: +u.dms || 0, tasks: +u.tasks || 0,
    in_feed: +(u.in_feed ?? u.total) || 0,
  };
  if (JSON.stringify(next) === JSON.stringify(unread)) return;
  unread = next;
  // The tab bar owns its own paint; it only needs telling the number changed.
  bus.emit('activity:unread', unread);
}

export function register(app) {
  const { ui } = app;
  uiRef = ui;
  style();

  ui.registerPanel({
    id: PANEL,
    replaces: true,   // deliberate takeover of the core panel, see the top of this file
    title: 'Activity',
    async render(body, ctx) {
      const filter = ctx?.filter || readFilter();
      localStorage.setItem(FILTER_KEY, filter);
      body.innerHTML = '<div class="muted pad">loading…</div>';
      if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }

      const redraw = (f) => ui.openPanel(PANEL, { filter: f || filter });

      // The counts come WITH the feed, not from whatever the background refresh
      // last left behind. They drive the numbers on the chips, and on a first
      // open the background call has not landed yet - so the chips came up bare
      // exactly when somebody is deciding which one to tap.
      const [[rows, err]] = await Promise.all([
        tryRpc('get_activity', { p_workspace: store.ws.id, p_limit: 60, p_filter: filter }),
        refreshUnread(),
      ]);
      // A server without 0128 does not know p_filter. Rather than showing an
      // error for a tab that used to work, fall back to the old call.
      let list = rows;
      if (err && /p_filter|invalid_filter|schema cache|function/i.test(err.message || '')) {
        const [old] = await tryRpc('get_activity', { p_workspace: store.ws.id, p_limit: 60 });
        list = old;
      } else if (err) {
        body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
        return;
      }
      if (!Array.isArray(list)) list = [];

      body.innerHTML = '';

      // ---- filters ----
      const bar = el('div', CLS + '-bar');
      const counts = {
        unread: unread.in_feed, mentions: unread.mentions,
        dms: unread.dms, tasks: unread.tasks,
      };
      for (const f of FILTERS) {
        const b = el('button', f.key === filter ? 'on' : '');
        b.type = 'button';
        b.innerHTML = `${esc(f.label)}${counts[f.key]
          ? ` <span class="${CLS}-n">${counts[f.key]}</span>` : ''}`;
        b.onclick = () => redraw(f.key);
        bar.appendChild(b);
      }
      body.appendChild(bar);

      // ---- the count, and the one button that clears it ----
      const top = el('div', CLS + '-top');
      const label = el('span', CLS + '-count');
      const unreadHere = list.filter((a) => !a.is_read).length;
      label.textContent = unreadHere
        ? `${unreadHere} unread`
        : list.length ? 'All caught up' : '';
      top.appendChild(label);
      if (unreadHere) {
        const all = el('button', 'sm ghost', 'Mark all read');
        all.type = 'button';
        all.onclick = async () => {
          all.disabled = true;
          try {
            await rpc('mark_all_activity_read', { p_workspace: store.ws.id });
            await refreshUnread();
            redraw();
          } catch (e) { all.disabled = false; ui.toast(e.message || 'That did not work', 'error'); }
        };
        top.appendChild(all);
      }
      body.appendChild(top);

      body.appendChild(notifyNudge(ui, redraw));

      if (!list.length) {
        body.appendChild(el('div', 'empty', emptyFor(filter)));
        return;
      }

      // ---- the feed ----
      let lastDay = null;
      for (const a of list) {
        const day = dayLabel(a.created_at);
        if (day !== lastDay) { body.appendChild(el('div', CLS + '-day', esc(day))); lastDay = day; }
        body.appendChild(row(a, redraw, ui));
      }
    },
  });

  // Read state only exists per Space, and the badge has to follow the Space.
  bus.on('workspace', refreshUnread);
  bus.on('auth', refreshUnread);
  const soon = debounce(refreshUnread, 800);
  // Anything that could add to the feed. Cheap: one small RPC, coalesced.
  bus.on('message:new', soon);
  bus.on('unread', soon);
  bus.on('later:changed', soon);
  bus.on('leave:changed', soon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshUnread();
  });
  refreshUnread();
}

function emptyFor(filter) {
  if (filter === 'unread') {
    return 'You are caught up. Anything addressed to you - a mention, a direct '
      + 'message, a reply, work somebody hands you - lands here first.';
  }
  if (filter === 'mentions') {
    return 'Nobody has typed your name yet. When somebody writes <b>@you</b> in a '
      + 'channel or tags you in a direct message, it lands here.';
  }
  if (filter === 'dms') return 'No direct messages waiting.';
  if (filter === 'tasks') {
    return 'Nothing has been handed to you. Work somebody gives you shows up here '
      + 'and in <b>Later</b>, and leave waiting on your approval shows up here too.';
  }
  if (filter === 'replies') return 'No reactions or thread replies on anything you wrote.';
  return 'Nothing yet. Mentions, replies, reactions, direct messages and work '
    + 'somebody hands you all land here.';
}

function row(a, redraw, ui) {
  const r = el('div', `${CLS}-row${a.is_read ? ' ' + CLS + '-read' : ''}`);
  const dm = a.kind === 'dm' || a.kind === 'dm_mention' || a.kind === 'dm_reaction';
  // The verb already says where, for the two kinds whose verb names the place.
  // "tagged you in a direct message ... in a direct message" is what saying it
  // twice looks like, and on a phone it costs the line the snippet needed.
  const verbSaysWhere = a.kind === 'dm' || a.kind === 'dm_mention';
  // Leave has no channel and no conversation; saying "in #a channel" about it
  // would be inventing a place.
  const isLeave = a.kind === 'leave_request' || a.kind === 'leave_decision';
  const where = verbSaysWhere || isLeave ? ''
    : dm ? 'in a direct message'
      : a.channel_id ? 'in #' + (chanName(a.channel_id) || 'a channel') : '';

  // Three dot states, and they mean three different things: unread and
  // addressed to you by name, unread but incidental, and read.
  const dotCls = a.is_read ? `${CLS}-dot ${CLS}-none`
    : BY_NAME.has(a.kind) ? `${CLS}-dot` : `${CLS}-dot ${CLS}-quiet`;

  const main = el('div', CLS + '-main');
  main.innerHTML = `
    <div class="${CLS}-head">${avatarHtml(a.actor_id, 18)}
      <b>${esc(nameOf(a.actor_id))}</b>
      <span class="${CLS}-verb">${esc(VERB[a.kind] || 'did something')}</span>
      ${where ? `<span>${esc(where)}</span>` : ''}
      <span>· ${esc(relTime(a.created_at))}</span>
    </div>
    <div class="${CLS}-body">${fmt(plain(a.title || a.snippet || '', 200))}</div>`;

  const mark = el('button', CLS + '-mark');
  mark.type = 'button';
  mark.innerHTML = a.is_read ? icon('inbox') : icon('check');
  mark.title = a.is_read ? 'Mark as unread' : 'Mark as read without opening it';
  mark.setAttribute('aria-label', mark.title);
  mark.onclick = async (e) => {
    // The one control on the row that must not open anything. Clearing four
    // items you do not care about should not mean visiting four channels.
    e.stopPropagation();
    mark.disabled = true;
    try {
      await rpc('mark_activity_read', { p_keys: [a.item_key], p_read: !a.is_read });
      await refreshUnread();
      redraw();
    } catch (err) {
      mark.disabled = false;
      ui.toast(err.message || 'That did not work', 'error');
    }
  };

  r.append(el('span', dotCls), main, mark);

  r.onclick = async () => {
    // Opening IS reading. Anything else means an item you have just looked at
    // still counts against you.
    if (!a.is_read) {
      rpc('mark_activity_read', { p_keys: [a.item_key], p_read: true })
        .then(refreshUnread).catch(() => {});
    }
    if (dm && a.conversation_id) { bus.emit('dm:request', { conversationId: a.conversation_id }); return; }
    if (a.kind === 'task') { uiRef?.openPanel('later', { view: 'mine' }); return; }
    // An approver lands on the inbox, the applicant on their own ledger. Same
    // panel, the tab each of them actually needs.
    if (a.kind === 'leave_request') { uiRef?.openPanel('leave', { tab: 'approvals' }); return; }
    if (a.kind === 'leave_decision') { uiRef?.openPanel('leave', { tab: 'mine' }); return; }
    const ch = store.channels.find((c) => c.id === a.channel_id);
    if (ch) openChannel(ch, { keepPanel: true });
    if (a.message_id) bus.emit('message:jump', { messageId: a.message_id });
  };
  return r;
}

const chanName = (id) => store.channels.find((c) => c.id === id)?.name;

// The offer, not a nag: one card, only while there is something to turn on, and
// only outside an embed - a cross-origin iframe can never be granted the
// Notification permission, so a button there is dead on arrival.
function notifyNudge(ui, redraw) {
  const wrap = el('div');
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return wrap;
  if (localStorage.getItem('dak.notifyNudge') === 'off') return wrap;

  const card = el('div', CLS + '-nudge');
  card.innerHTML = `<div><b>Get told when somebody needs you</b></div>
    <div class="muted">Turn notifications on and Dek can reach you when you are
      mentioned or sent a direct message, even when this tab is closed.</div>`;
  const row2 = el('div', 'row gap');
  row2.style.marginTop = 'var(--s-3)';
  const yes = el('button', 'sm', 'Turn on notifications');
  yes.type = 'button';
  yes.onclick = async () => {
    try {
      const res = await Notification.requestPermission();
      ui.toast(res === 'granted' ? 'Notifications on' : 'Not granted - you can turn them on later in Notifications',
        res === 'granted' ? 'success' : 'info');
      if (res === 'granted') bus.emit('push:subscribe');
    } catch (e) { ui.toast(e.message || 'The browser refused the request', 'error'); }
    redraw();
  };
  const no = el('button', 'sm ghost', 'Not now');
  no.type = 'button';
  no.onclick = () => { localStorage.setItem('dak.notifyNudge', 'off'); redraw(); };
  row2.append(yes, no);
  card.appendChild(row2);
  wrap.appendChild(card);
  return wrap;
}
