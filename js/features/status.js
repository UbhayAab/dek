// Custom status, presence and notification pauses.
//
// The affordance people reach for is their own name in the top bar, so that is
// where this hangs. On narrow screens the shell hides .meName, which would leave
// no way in at all, hence the header button as a second door to the same sheet.
//
// Every preset carries its own expiry. A status that outlives the thing it
// describes is the single reason people stop trusting statuses, so "In a
// meeting" is always 1 hour, never forever.
import { table } from '../api.js';
import { store, bus } from '../store.js';
import { $, el, esc, plain } from '../util.js';
import { icon } from '../icons.js';

const MIN = 60000;
const HOUR = 3600000;

const PRESETS = [
  { emoji: '🗓️', text: 'In a meeting', ms: HOUR, label: '1 hour' },
  { emoji: '🚌', text: 'Commuting', ms: 30 * MIN, label: '30 minutes' },
  { emoji: '🤒', text: 'Out sick', endOfDay: true, label: 'today' },
  { emoji: '🎯', text: 'Focusing', ms: 2 * HOUR, label: '2 hours' },
];

// Availability is a fixed three-state control, not a status somebody picked, so
// it is chrome and gets drawn. Three distinct SHAPES rather than three coloured
// dots: colour on its own is the one difference a red-green colour-blind reader
// cannot see, and the cell that is chosen already carries the accent ring the
// segmented control draws around it - a green label inside a ringed cell would
// say the same thing twice, and features.css says outright that accent-coloured
// 12px text fails AA on that tinted surface.
const PRESENCE = [
  { value: 'online', ico: 'dot', label: 'Active' },
  { value: 'away', ico: 'moon', label: 'Away' },
  { value: 'dnd', ico: 'dnd', label: 'Do not disturb' },
];

const PAUSES = [
  { label: '30 minutes', ms: 30 * MIN },
  { label: '1 hour', ms: HOUR },
  { label: 'Until tomorrow', tomorrow: true },
];

const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
const tomorrowMorning = () => {
  const d = new Date(Date.now() + 86400000);
  d.setHours(9, 0, 0, 0);
  return d;
};

// ------------------------------------------------------------------ local mirror
let myPresence = 'online';
let dndUntil = null;
let expiryTimer = null;
let headerDef = null;

function mergeMyProfile(row) {
  if (!row) return;
  store.myProfile = { ...(store.myProfile || {}), ...row, id: store.me };
  store.profiles.set(store.me, store.myProfile);
}

function paintChip() {
  const chip = $('hstatusChip');
  const p = store.myProfile || {};
  const emoji = p.status_emoji || '';
  const text = p.status_text || '';
  if (chip) {
    if (!emoji && !text) {
      chip.classList.add('hidden');
      chip.innerHTML = '';
      chip.removeAttribute('title');
    } else {
      chip.classList.remove('hidden');
      chip.innerHTML = `${esc(emoji)}${text ? `<span class="hstatus-chip-t">${esc(plain(text, 28))}</span>` : ''}`;
      chip.title = `${emoji} ${text}`.trim();
    }
  }
  // The header button doubles as the status indicator. A status emoji someone
  // chose is CONTENT and shows as-is; with no status set it falls back to the
  // drawn icon so the chrome stays one visual family.
  if (headerDef) {
    headerDef.label = emoji || icon('smile');
    const btn = document.getElementById('hb-status');
    if (btn) btn.innerHTML = headerDef.label;
  }
}

// The server clears expired statuses on its own schedule; this only keeps the
// top bar from showing a stale one until the next reload.
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  const at = store.myProfile?.status_expires_at;
  if (!at) return;
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) {
    mergeMyProfile({ status_text: null, status_emoji: null, status_expires_at: null });
    paintChip();
    return;
  }
  if (ms < 2147483000) {
    expiryTimer = setTimeout(() => {
      mergeMyProfile({ status_text: null, status_emoji: null, status_expires_at: null });
      paintChip();
    }, ms + 500);
  }
}

// ------------------------------------------------------------------ decoration
// Away/dnd state comes from store.presenceStatus, the map core/presence.js
// fills on its existing 20s census read. This used to issue its own
// user_presence fetch - every profile id in the query string - per panel
// mutation, throttled to 8s; the census already carries the column, and the
// 'presence' bus event fires after every tick, so badges now move on that
// tick instead of behind it.
function decorateMembers() {
  for (const row of document.querySelectorAll('.member')) {
    if (row.dataset.hstatus) continue;
    const uid = row.querySelector('[data-user]')?.dataset.user;
    if (!uid) continue;
    row.dataset.hstatus = '1';
    const p = store.profiles.get(uid);
    if (p?.status_text) row.title = String(p.status_text);
    const st = store.presenceStatus?.get(uid);
    if (st !== 'dnd' && st !== 'away') continue;
    // The same two glyphs the availability control uses, so the badge on a member
    // row and the button that set it are visibly the same statement. Sized down to
    // 14 because this one rides beside a name rather than filling a cell.
    const badge = el('span', 'hstatus-badge',
      icon(st === 'dnd' ? 'dnd' : 'moon', { size: 14 }));
    badge.title = st === 'dnd' ? 'Do not disturb' : 'Away';
    row.querySelector('.m-name')?.appendChild(badge);
  }
}

// Repaints the badges from the shared map. No network: cheap enough to call on
// every panel mutation and after every presence tick.
function refreshPresenceDetail() {
  if (!document.querySelector('.member')) return;
  document.querySelectorAll('.hstatus-badge').forEach((n) => n.remove());
  document.querySelectorAll('.member[data-hstatus]').forEach((n) => { delete n.dataset.hstatus; });
  decorateMembers();
}

// ------------------------------------------------------------------ popover
// `it.ico` is a name out of the house icon set and goes in as markup; the label
// beside it is still escaped, because PAUSES and anything added here later carry
// plain text. At 15px plus the 6px gap the pair is about as wide as the emoji and
// space it replaces, so the three cells still fit the 300px popover.
function seg(items, current, onPick) {
  const host = el('div', 'hstatus-seg');
  for (const it of items) {
    const b = el('button', 'sm ghost' + (it.value === current ? ' on' : ''),
      (it.ico ? icon(it.ico, { size: 15 }) : '') + esc(it.label));
    b.onclick = () => onPick(it.value, b);
    host.appendChild(b);
  }
  return host;
}

// Whatever door was used, the sheet has to hang off a control that is really in
// the document. #hb-status only exists when the header button rendered INLINE,
// and at order 95 it never does, so fall through to controls that are always
// there. Prefer the one nearest the door that was used: the identity chip, since
// both the user menu and the sidebar foot live in it.
function statusAnchor() {
  const chip = $('hstatusChip');
  return document.getElementById('hb-status')
    || (chip && !chip.classList.contains('hidden') ? chip : null)
    || $('userMenu') || $('sidebarMe') || $('btnMore') || document.body;
}

function openStatusPopover(anchor, ui, api) {
  const p = store.myProfile || {};
  const box = el('div', 'hstatus-pop');
  box.innerHTML = `
    <div class="hstatus-inputs">
      <input class="hstatus-emoji" maxlength="8" placeholder="🙂" value="${esc(p.status_emoji || '')}" />
      <input class="hstatus-text" maxlength="100" placeholder="What is your status?" value="${esc(p.status_text || '')}" />
    </div>
    <div class="hstatus-presets"></div>
    <div class="row gap hstatus-actions">
      <button class="sm" data-a="save">Save</button>
      <button class="sm ghost" data-a="clear">Clear</button>
      <span class="muted hstatus-exp"></span>
    </div>
    <h4 class="sec">Availability</h4>
    <div data-slot="presence"></div>
    <h4 class="sec">Pause notifications</h4>
    <div data-slot="dnd"></div>
    <div class="muted hstatus-note"></div>`;

  const emojiIn = box.querySelector('.hstatus-emoji');
  const textIn = box.querySelector('.hstatus-text');
  const expLine = box.querySelector('.hstatus-exp');
  const note = box.querySelector('.hstatus-note');

  const pop = ui.popover(anchor, box, { below: true });

  const showExpiry = () => {
    const at = store.myProfile?.status_expires_at;
    expLine.textContent = at && new Date(at) > new Date()
      ? 'Clears at ' + new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
  };
  showExpiry();

  const save = async (text, emoji, expiresAt) => {
    try {
      if (!text && !emoji) {
        const row = await api.clearStatus();
        mergeMyProfile(row || { status_text: null, status_emoji: null, status_expires_at: null });
        ui.toast('Status cleared');
      } else {
        const row = await api.setStatus(text || null, emoji || null, expiresAt || null);
        mergeMyProfile(row || { status_text: text, status_emoji: emoji, status_expires_at: expiresAt });
        ui.toast('Status set');
      }
      paintChip();
      scheduleExpiry();
      pop.close();
    } catch (e) { ui.toast(e.message || 'Could not save the status', 'error'); }
  };

  // ---- presets ----
  const presetHost = box.querySelector('.hstatus-presets');
  for (const pr of PRESETS) {
    const b = el('button', 'sm ghost hstatus-preset',
      `${esc(pr.emoji)} ${esc(pr.text)} <span class="muted">${esc(pr.label)}</span>`);
    b.title = `${pr.text} - clears after ${pr.label}`;
    b.onclick = () => {
      emojiIn.value = pr.emoji;
      textIn.value = pr.text;
      const at = pr.endOfDay ? endOfToday() : new Date(Date.now() + pr.ms);
      save(pr.text, pr.emoji, at.toISOString());
    };
    presetHost.appendChild(b);
  }

  // ON LEAVE IS NOT A STATUS, AND THAT IS THE POINT.
  //
  // "Even if I just put my status as leave, it's as if I auto applied for it."
  // Somebody typing "on leave" into the status box is telling the organisation
  // they are off, and until now that sentence went nowhere: it could not be
  // counted, it did not reach a coordinator, and it spent nothing. So this row
  // sits with the presets, where a thumb already looks for it, and files the
  // application instead - features/leave.js then writes the status back from
  // the approved leave, which is the same end state reached through the door
  // that keeps a record.
  //
  // A bus event, not an import: a feature may never import another feature, and
  // this way a Dek without the leave module simply does not draw the row.
  if (store.ws?.org_id) {
    const lv = el('button', 'sm ghost hstatus-preset',
      '🌴 On leave <span class="muted">apply</span>');
    lv.title = 'Book time off. It is recorded and the team can see you are out.';
    lv.onclick = () => { pop.close(); bus.emit('leave:apply', {}); };
    presetHost.appendChild(lv);
  }

  box.querySelector('[data-a="save"]').onclick = () =>
    save(textIn.value.trim(), emojiIn.value.trim(), null);
  box.querySelector('[data-a="clear"]').onclick = () => save('', '', null);
  textIn.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(textIn.value.trim(), emojiIn.value.trim(), null); }
  };

  // ---- presence ----
  box.querySelector('[data-slot="presence"]').appendChild(
    seg(PRESENCE, myPresence, async (value, btn) => {
      try {
        await api.setPresenceStatus(value);
        myPresence = value;
        // core/presence.js sends whatever this says on its liveness beat. Without
        // telling it, the next beat wrote 'online' straight back over the choice
        // and the picker was inert. shell.js paints it from store.myPresence, so
        // the sidebar foot stops claiming "Active" the moment it changes.
        store.myPresence = value;
        bus.emit('presence:mine', value);
        bus.emit('status:changed');
        btn.parentElement.querySelectorAll('button').forEach((n) => n.classList.remove('on'));
        btn.classList.add('on');
        ui.toast('Availability set to ' + value);
      } catch (e) { ui.toast(e.message || 'Could not change availability', 'error'); }
    }));

  // ---- pause notifications ----
  const dndHost = box.querySelector('[data-slot="dnd"]');
  const paintDnd = () => {
    const active = dndUntil && new Date(dndUntil).getTime() > Date.now();
    note.textContent = active
      ? 'Paused until ' + new Date(dndUntil).toLocaleString([], { hour: '2-digit', minute: '2-digit' })
      : 'Notifications are not paused.';
    dndHost.innerHTML = '';
    for (const opt of PAUSES) {
      const b = el('button', 'sm ghost', esc(opt.label));
      b.onclick = async () => {
        const at = opt.tomorrow ? tomorrowMorning() : new Date(Date.now() + opt.ms);
        try {
          await api.setDnd(at.toISOString());
          dndUntil = at.toISOString();
          paintDnd();
          ui.toast('Notifications paused');
        } catch (e) { ui.toast(e.message || 'Could not pause notifications', 'error'); }
      };
      dndHost.appendChild(b);
    }
    if (active) {
      const off = el('button', 'sm ghost', 'Resume');
      off.onclick = async () => {
        try {
          await api.setDnd(null);
          dndUntil = null;
          paintDnd();
          ui.toast('Notifications resumed');
        } catch (e) { ui.toast(e.message || 'Could not resume notifications', 'error'); }
      };
      dndHost.appendChild(off);
    }
  };
  paintDnd();

  setTimeout(() => textIn.focus(), 30);
  return pop;
}

// ------------------------------------------------------------------ register
export function register({ ui, api }) {
  injectStyle();

  // #meName sits INSIDE <button id="userMenu">, and shell.js binds the identity
  // menu to that button. This used to claim the name's clicks for the status
  // sheet with stopPropagation, so that the name opened status while the avatar
  // and the caret opened the menu.
  //
  // The name is most of the button. Measured on a 1440px window the chip is 96px
  // wide and #meName covers the middle of it, so the overwhelming majority of
  // clicks on the only identity control in the top bar were swallowed here and
  // the identity menu never opened at all. Everything that menu is the only
  // route to went with it - Your profile, Change your password, Keyboard
  // shortcuts, Sign out, and Appearance, which is where the five looks are
  // chosen. Reported as "where do I change the theme from? I don't know."
  //
  // One button, one action. Status is still one tap further in, as "Set a
  // status" in that same menu, which is the affordance people actually find -
  // the comment that used to be here says so itself. The status CHIP keeps its
  // own click, because a chip that is showing your current status is a
  // status-specific control and reads as one.
  const openFrom = (anchor) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    openStatusPopover(anchor, ui, api);
  };

  const nameEl = $('meName');
  const chip = el('span', 'hstatus-chip hidden');
  chip.id = 'hstatusChip';
  if (nameEl && nameEl.parentElement) {
    nameEl.parentElement.insertBefore(chip, nameEl.nextSibling);
  }
  chip.addEventListener('click', openFrom(chip));

  // "Set a status" in the user menu, offered from BOTH identity controls - the
  // top bar and the sidebar foot - emitted this event into nothing. Grep found
  // exactly one hit for 'status:open' in the whole app: the emit. That menu item
  // is the affordance people actually find, which is most of why the feature was
  // reported as not existing.
  bus.on('status:open', () => openStatusPopover(statusAnchor(), ui, api));

  headerDef = {
    id: 'status',
    label: icon('smile'),
    title: 'Your status and availability',
    order: 95,
    // order 95 is far past the inline cap of 4, so this button ALWAYS lands in
    // the overflow menu - where shell.js replays the original #btnMore click long
    // after dispatch ended. e.currentTarget is null by then, and #hb-status was
    // never rendered either, so the old expression handed popover() null: it
    // appended the sheet and THEN threw on getBoundingClientRect, leaving a fixed
    // element with no coordinates parked off the bottom of the page. From the
    // outside, a button that does nothing.
    onClick: () => openStatusPopover(statusAnchor(), ui, api),
  };
  ui.addHeaderButton(headerDef);

  ui.addSlashCommand({
    name: 'status',
    description: 'Set your status. /status clear removes it.',
    run: async (arg) => {
      const raw = (arg || '').trim();
      if (!raw || /^(clear|off|none)$/i.test(raw)) {
        const row = await api.clearStatus();
        mergeMyProfile(row || { status_text: null, status_emoji: null, status_expires_at: null });
        paintChip();
        ui.toast('Status cleared');
        return;
      }
      // A leading emoji (anything before the first space that is not a word) is
      // treated as the emoji, the way people actually type it.
      const m = raw.match(/^(\S+)\s+([\s\S]+)$/);
      const looksEmoji = m && !/^[\w#@/]/.test(m[1]);
      const emoji = looksEmoji ? m[1] : null;
      const text = looksEmoji ? m[2] : raw;
      const row = await api.setStatus(text.slice(0, 100), emoji, null);
      mergeMyProfile(row || { status_text: text, status_emoji: emoji });
      paintChip();
      scheduleExpiry();
      ui.toast('Status set');
    },
  });

  // ---- decorate message authors ----
  bus.on('message:render', ({ msg, el: row }) => {
    if (!row || !msg) return;
    const who = row.querySelector('.mhead .who');
    if (!who) return; // grouped rows have no header to hang it off
    const p = store.profiles.get(msg.author_id);
    const emoji = p?.status_emoji;
    if (!emoji) return;
    const s = el('span', 'hstatus-msg', esc(emoji));
    s.title = p.status_text ? String(p.status_text) : 'status';
    who.insertAdjacentElement('afterend', s);
  });

  // ---- decorate member rows ----
  const panelHost = $('panelContent');
  if (panelHost && typeof MutationObserver !== 'undefined') {
    // New rows only: decorateMembers is idempotent and stops before mutating
    // when there is nothing to paint. refreshPresenceDetail must NOT ride this
    // observer - it removes and re-adds every badge unconditionally, so once an
    // away/dnd badge exists in the subtree each pass generates the childList
    // records that schedule its own next pass, and the page starves (observed
    // live 2026-08-26). Map changes arrive on 'presence' below.
    new MutationObserver(() => { decorateMembers(); })
      .observe(panelHost, { childList: true, subtree: true });
  }
  bus.on('presence', () => { refreshPresenceDetail(); });
  bus.on('profiles', () => { decorateMembers(); });

  // ---- keep the top bar honest ----
  const sync = async () => {
    paintChip();
    scheduleExpiry();
    if (!store.me) return;
    const rows = await table('user_presence', (q) => q.eq('user_id', store.me));
    // 'offline' is what app.reap_presence leaves behind between sessions; it is
    // not a choice anybody made, so it must not become the picker's state or the
    // word in the sidebar. Anything else is a hold this person set, which
    // survives a reload because 0062 stops the beat downgrading it - so re-assert
    // it to the beat rather than letting the session start at 'online'.
    const saved = rows[0]?.status;
    if (saved && saved !== 'offline') {
      myPresence = saved;
      store.myPresence = saved;
      bus.emit('presence:mine', saved);
      bus.emit('status:changed');
    }
    if (!store.ws) return;
    try {
      const s = await api.notifySettings(store.ws.id);
      dndUntil = s?.prefs?.dnd_until || null;
    } catch { /* the popover falls back to "not paused" */ }
  };
  bus.on('auth', sync);
  bus.on('workspace', sync);
  paintChip();
}

// ------------------------------------------------------------------ style
function injectStyle() {
  if (document.getElementById('hstatus-style')) return;
  const s = document.createElement('style');
  s.id = 'hstatus-style';
  s.textContent = `
    .hstatus-chip{display:inline-flex;align-items:center;gap:5px;max-width:190px;font-size:12.5px;
      color:var(--dim);background:var(--panel2);border:1px solid var(--line);border-radius:12px;
      padding:1px 8px;cursor:pointer;white-space:nowrap}
    .hstatus-chip:hover{color:var(--text);border-color:var(--accent)}
    .hstatus-chip-t{overflow:hidden;text-overflow:ellipsis;max-width:130px}
    .hstatus-msg{font-size:12.5px;opacity:.85;cursor:default}
    .hstatus-badge{font-size:11px;opacity:.85}
    .hstatus-pop{width:300px;padding:6px 8px 10px;display:flex;flex-direction:column;gap:8px}
    .hstatus-inputs{display:flex;gap:6px}
    .hstatus-inputs .hstatus-emoji{width:56px;text-align:center;flex:none;padding:8px 4px}
    .hstatus-presets{display:flex;flex-direction:column;gap:4px}
    .hstatus-preset{text-align:left;display:flex;gap:6px;align-items:baseline}
    .hstatus-preset .muted{margin-left:auto;font-size:11.5px}
    .hstatus-actions{align-items:center}
    .hstatus-exp{font-size:11.5px;margin-left:auto}
    .hstatus-seg{display:flex;gap:4px;flex-wrap:wrap}
    .hstatus-note{font-size:11.5px}
    .hstatus-pop h4.sec{margin:4px 2px 0}
    @media (max-width:860px){ .hstatus-chip{max-width:110px} .hstatus-chip-t{display:none} }`;
  document.head.appendChild(s);
}
