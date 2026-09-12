// Channel bookmarks: the pinned-links strip that lives at the top of a channel,
// not another list buried in the sidebar. The bar is mounted as the first child
// of #messages and stays there because core wipes and refills that node on every
// open - a MutationObserver puts it back rather than us guessing at timings.
//
// SHEETS COME FIRST IN THIS BAR. The coordinator teams work out of Google
// Sheets - the roster, the patient call list, the camp tracker - and the report
// was that sharing one means pasting a URL into a channel where it scrolls away.
// Storage did not need to change for that; a pinned sheet is a bookmark. What it
// needed was to be recognisable (js/lib/sheeturl.js), drawn with its own icon,
// sorted ahead of the ordinary links, added through an affordance that says the
// word "sheet", and opened by features/sheets.js - which decides between an
// in-app frame and a new tab, because only a PUBLISHED sheet can be framed.
import { api, tryRpc } from '../api.js';
import { store, bus, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc, relTime } from '../util.js';
import { icon } from '../icons.js';
import { classifySheetUrl, isDocKind } from '../lib/sheeturl.js';
import { openSheetLink, addSheetDialog, sheetIconFor, sheetHint } from './sheets.js';

const PANEL = 'bookmarks';

let UI = null;           // the kit, reached from DOM handlers outside register()
let bar = null;          // the live bar element for the open channel
let chId = null;         // channel the bar belongs to
let rows = [];           // last loaded bookmarks for that channel
let loadToken = 0;       // guards against a slow load landing on a new channel

function style() {
  if (document.getElementById('bookmarks-css')) return;
  const s = el('style');
  s.id = 'bookmarks-css';
  // WHAT THIS BLOCK IS FOR. css/features.css restates the whole strip with a
  // `:root ` prefix specifically to outrank this injected copy, so in a normal
  // load almost nothing here wins. It still has to be right, for two reasons:
  // it is what paints if that stylesheet ever fails to load, and the rules below
  // that features.css does NOT restate (.bmk-doc, .bmk-addwrap, the icon sizing)
  // are live.
  //
  // The old declarations were written against --panel/--line/--dim. css/panels.css
  // only re-points those retired names inside #panelContent and friends, and this
  // bar renders inside #messages, so as a fallback they resolved to nothing at
  // all. Current tokens only, and the geometry matches what features.css actually
  // does - a sideways scroller, not a wrapping row.
  s.textContent = `
    /* z-index 5, not --z-sticky: the bar is sticky INSIDE #messages, under the
       channel header, and lifting it to the shell's sticky layer would let it
       paint over that header on scroll. */
    .bmk-bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;
      gap:var(--s-3);flex-wrap:nowrap;overflow-x:auto;
      padding:var(--s-3) var(--s-5);margin:0 auto var(--s-5);
      background:var(--c-bg);border-bottom:var(--bw) solid var(--c-border)}
    .bmk-pill{display:inline-flex;align-items:center;gap:var(--s-3);max-width:230px;
      background:var(--c-surface-2);border:var(--bw) solid var(--c-border);border-radius:var(--r-full);
      padding:var(--s-2) var(--s-5);font-size:var(--t-sm);color:var(--c-text);text-decoration:none;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;
      min-height:30px;line-height:var(--t-snug)}
    .bmk-pill:hover{border-color:var(--c-accent);color:var(--c-accent)}
    .bmk-pill .ico{flex:none;width:14px;height:14px;opacity:.85}
    .bmk-pill .bmk-txt{overflow:hidden;text-overflow:ellipsis}
    .bmk-pill.bmk-dead{color:var(--c-text-3);cursor:default}
    .bmk-pill.bmk-dead:hover{border-color:var(--c-border);color:var(--c-text-3)}
    /* A pinned sheet is the thing people came for, so it gets the accent edge
       and the ordinary links stay quiet next to it. */
    .bmk-pill.bmk-doc{background:var(--c-accent-quiet);
      border-color:color-mix(in srgb, var(--c-accent) 40%, transparent)}
    .bmk-pill.bmk-doc .ico{opacity:1;color:var(--c-accent)}
    .bmk-add{color:var(--c-text-2);border-style:dashed}
    .bmk-add:hover{color:var(--c-accent)}
    /* css/features.css makes this strip a sideways SCROLLER on purpose - a
       wrapping row of pills would push the conversation off a phone screen. The
       cost of that is the add affordance being the last item in a scroller with
       a hidden scrollbar: measured at 390px with three pins, "Add a sheet" was
       entirely off the right edge, which is the same as not existing. Sticking
       the add group to the right edge of the scrollport keeps it on screen while
       the pins scroll under it, and the box-shadow in the bar's own background
       colour is the fade that shows a pill going under. */
    .bmk-addwrap{position:sticky;right:0;flex:none;display:flex;align-items:center;
      gap:var(--s-3);padding-left:var(--s-3);background:var(--c-bg);
      box-shadow:-10px 0 10px -5px var(--c-bg),var(--s-5) 0 0 0 var(--c-bg)}
    .bmk-note{font-size:var(--t-xs);color:var(--c-text-2);line-height:var(--t-snug)}
    .bmk-note.bmk-err{color:var(--c-danger)}
    .bmk-row{display:flex;align-items:center;gap:var(--s-4)}
    .bmk-row .bmk-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      font-size:var(--t-xs);color:var(--c-text-2)}
    @media (max-width:520px){
      .bmk-pill{max-width:70vw}
    }`;
  document.head.appendChild(s);
}

// A bookmark URL is user input that ends up in an href. Anything that is not an
// ordinary web link or an in-app hash gets rendered as dead text instead.
function safeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('#')) return s;
  try {
    const u = new URL(s, location.href);
    return /^(https?|mailto):$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

const canManage = () => hasPerm(PERM.MANAGE_CHANNELS);

// ------------------------------------------------------------------ mounting
function ensureMounted() {
  if (!bar || !chId || !bar.childNodes.length) return;
  const host = $('messages');
  if (!host) return;
  if (host.firstChild === bar) return;
  host.insertBefore(bar, host.firstChild);
}

function unmount() {
  bar?.remove();
  bar = null;
  chId = null;
  rows = [];
}

function watchMessages() {
  const host = $('messages');
  if (!host) return;
  // childList only: re-inserting the bar does not re-trigger us into a loop.
  new MutationObserver(() => ensureMounted()).observe(host, { childList: true });
}

// ------------------------------------------------------------------ painting
function pillFor(b, info) {
  const href = safeUrl(b.url);
  const doc = href && isDocKind(info.kind);
  const pill = el(href ? 'a' : 'span',
    'bmk-pill' + (href ? '' : ' bmk-dead') + (doc ? ' bmk-doc' : ''));
  const text = b.label || b.url || 'link';
  pill.innerHTML = (doc ? icon(sheetIconFor(info.kind)) : '')
    + `<span class="bmk-txt">${esc(text)}</span>`;

  if (!href) {
    pill.title = 'This bookmark does not point at a safe link: ' + (b.url || '');
  } else {
    // The title says what the tap will DO, not just where it goes. "Opens
    // inside Dek" versus "opens in a new tab" is the one distinction people
    // have to learn about published sheets, and this is where it is cheapest.
    pill.title = (b.label ? b.label + ' - ' : '') + (b.url || '')
      + (doc ? '\n' + sheetHint(info) : '');
    pill.href = href;
    if (!href.startsWith('#')) { pill.target = '_blank'; pill.rel = 'noopener noreferrer'; }
    // A sheet never navigates the tab away on its own: sheets.js decides
    // between the in-app frame and window.open, and it has to run first. The
    // href stays set so long-press and copy-link-address still work.
    if (doc) pill.onclick = (ev) => { ev.preventDefault(); openSheetLink(b); };
  }
  pill.oncontextmenu = (ev) => { ev.preventDefault(); pillMenu(ev, b); };
  return pill;
}

function paint(note) {
  if (!bar) return;
  bar.innerHTML = '';

  // Sheets and documents first, in the order they were pinned, then everything
  // else. A channel with eight bookmarks had the roster somewhere in the middle
  // of them, which on a phone is behind a wrap.
  const seen = rows.map((b) => ({ b, info: classifySheetUrl(b.url) }));
  const ordered = seen.filter((r) => isDocKind(r.info.kind))
    .concat(seen.filter((r) => !isDocKind(r.info.kind)));
  for (const r of ordered) bar.appendChild(pillFor(r.b, r.info));

  if (canManage()) {
    // Spelled out, not a glyph. The generic + was there the whole time and the
    // report was still "there is no way to attach a sheet" - a control nobody
    // reads as the thing they want is a control that does not exist.
    const wrap = el('div', 'bmk-addwrap');
    const addSheet = el('span', 'bmk-pill bmk-add');
    addSheet.innerHTML = icon('sheet') + '<span class="bmk-txt">Add a sheet</span>';
    addSheet.title = 'Pin a Google Sheet, tracker or roster to this channel';
    addSheet.onclick = () => addSheetDialog(chId);
    wrap.appendChild(addSheet);

    const add = el('span', 'bmk-pill bmk-add', '＋');
    add.title = 'Pin any other link to this channel';
    add.onclick = () => addDialog();
    wrap.appendChild(add);
    bar.appendChild(wrap);

    if (!rows.length && !note) {
      bar.appendChild(el('span', 'bmk-note',
        'Pin what this channel works out of - the roster sheet, the call list, a runbook - '
        + 'and it stays at the top for everyone.'));
    }
  }

  if (note) bar.appendChild(el('span', 'bmk-note' + (note.error ? ' bmk-err' : ''), esc(note.text)));

  // Nothing to show and nothing to add: do not leave an empty strip behind.
  if (!bar.childNodes.length) { bar.remove(); }
  else ensureMounted();
}

// One route in for every surface - bar, long-press menu, panel card - so a
// published sheet opens in the frame from all three and a plain link does not
// go anywhere near it.
function openPin(b) {
  const href = safeUrl(b.url);
  if (!href) return;
  if (href.startsWith('#')) { location.hash = href.slice(1); return; }
  if (isDocKind(classifySheetUrl(b.url).kind)) { openSheetLink(b); return; }
  window.open(href, '_blank', 'noopener');
}

function pillMenu(ev, b) {
  const items = [
    { label: 'Open', onClick: () => openPin(b) },
    { label: 'Copy link', onClick: () => {
      navigator.clipboard?.writeText(b.url || '').then(() => UI.toast('Link copied'), () => {});
    } },
  ];
  if (canManage()) {
    items.push('-');
    items.push({ label: 'Remove bookmark', danger: true, onClick: () => remove(b) });
  }
  UI.contextMenu(ev, items);
}

async function remove(b) {
  try {
    await api.removeBookmark(b.id);
    rows = rows.filter((r) => r.id !== b.id);
    paint();
    UI.toast('Bookmark removed');
    if (UI.currentPanel() === PANEL) UI.refreshPanel();
  } catch (e) { UI.toast(e.message, 'error'); }
}

async function addDialog() {
  if (!chId) { UI.toast('Open a channel first', 'error'); return; }
  const out = await UI.formModal({
    title: 'Add a bookmark',
    fields: [
      { name: 'label', label: 'Label', required: true, placeholder: 'Runbook' },
      { name: 'url', label: 'Link', required: true, placeholder: 'https://…' },
    ],
    submitLabel: 'Add',
    note: 'Bookmarks show at the top of the channel for everyone who can see it.',
  });
  if (!out) return;
  if (!safeUrl(out.url)) { UI.toast('That link is not an http(s) or mailto address', 'error'); return; }
  try {
    // p_position defaults to "after everything else" on the server; forcing 0
    // here would silently stack every new bookmark at the front.
    const row = await api.addBookmark(chId, out.label.trim(), out.url.trim(), null);
    if (row) rows = [...rows, row];
    paint();
    UI.toast('Bookmark added');
    if (UI.currentPanel() === PANEL) UI.refreshPanel();
  } catch (e) { UI.toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ loading
async function openFor(channel) {
  if (!channel) { unmount(); return; }
  const token = ++loadToken;
  chId = channel.id;
  rows = [];
  bar?.remove();
  bar = el('div', 'bmk-bar');
  bar.id = 'bmkBar';
  ensureMounted();
  paint({ text: 'loading bookmarks…' });

  const [data, err] = await tryRpc('list_bookmarks', { p_channel: channel.id });
  if (token !== loadToken) return;          // a newer channel won the race
  if (err) { rows = []; paint({ text: err.message, error: true }); return; }
  rows = Array.isArray(data) ? data : [];
  paint();
}

// ------------------------------------------------------------------ panel
// The bar is the product; this panel is the place to see the full URLs and tidy
// them up, and it gives the feature a surface that survives a narrow window.
function registerPanel(ui) {
  ui.registerPanel({
    id: PANEL,
    title: 'Channel bookmarks',
    async render(body) {
      if (!store.current) {
        body.innerHTML = '<div class="empty">Open a channel to see its bookmarks.</div>';
        return;
      }
      body.innerHTML = '<div class="muted pad">loading…</div>';
      const [data, err] = await tryRpc('list_bookmarks', { p_channel: store.current.id });
      if (err) { body.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
      const list = Array.isArray(data) ? data : [];

      body.innerHTML = '';
      if (!list.length) {
        body.appendChild(el('div', 'empty',
          `No bookmarks in <b>#${esc(store.current.name)}</b> yet. `
          + (canManage()
            ? 'Add one and it appears as a pill at the top of the channel for everyone.'
            : 'Someone who can manage channels can pin links here.')));
      }
      for (const b of list) {
        const href = safeUrl(b.url);
        const card = el('div', 'result');
        const info = classifySheetUrl(b.url);
        const doc = href && isDocKind(info.kind);
        card.innerHTML = `<div class="bmk-row">${doc ? icon(sheetIconFor(info.kind)) : ''}
            <b>${esc(b.label || 'link')}</b>
            <span class="muted">${esc(relTime(b.created_at))}</span></div>
          <div class="bmk-url">${esc(b.url || '')}${href ? '' : ' (not a safe link)'}</div>
          ${doc ? `<div class="bmk-url">${esc(sheetHint(info))}</div>` : ''}`;
        if (href) card.onclick = () => openPin(b);
        if (canManage()) {
          const rm = el('button', 'sm ghost', 'Remove');
          rm.onclick = async (e) => {
            e.stopPropagation();
            try {
              await api.removeBookmark(b.id);
              rows = rows.filter((r) => r.id !== b.id);
              paint();
              ui.refreshPanel();
            } catch (err2) { ui.toast(err2.message, 'error'); }
          };
          card.appendChild(rm);
        }
        body.appendChild(card);
      }
    },
    footer(foot) {
      if (!canManage() || !store.current) return;
      const sh = el('button', 'wide', 'Add a sheet');
      sh.onclick = () => addSheetDialog(store.current.id);
      foot.appendChild(sh);
      const b = el('button', 'wide ghost', 'Add any other link');
      b.onclick = () => addDialog();
      foot.appendChild(b);
    },
  });
}

export function register({ ui }) {
  style();
  UI = ui;
  watchMessages();
  registerPanel(ui);

  // features/sheets.js owns the add-a-sheet dialog and the slash command, and
  // tells the bar what it created rather than reaching into it. One-way import,
  // one place that repaints.
  bus.on('bookmark:added', ({ channel_id, row }) => {
    if (!chId || channel_id !== chId || !row) return;
    if (row.id && rows.some((r) => r.id === row.id)) return;
    rows = [...rows, row];
    paint();
    if (UI.currentPanel() === PANEL) UI.refreshPanel();
  });

  bus.on('channel:open', ({ channel }) => openFor(channel));
  bus.on('dm:open', () => unmount());
  bus.on('channels', () => { if (chId && !store.channels.some((c) => c.id === chId)) unmount(); });
}
