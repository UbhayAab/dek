// Sheet access: the roster, the call list and the tracker, kept where the work
// is instead of scrolled away.
//
// Reported by the coordinators, near enough verbatim: "sharing a sheet means
// pasting a link into a channel where it scrolls away." By the next morning
// the link is forty messages up, and on a phone nobody finds it again, so the
// same URL gets pasted three times a week and two of the copies are stale.
//
// Storage is channel_bookmarks and the three RPCs that already exist. Nothing
// new server side: a pinned sheet IS a bookmark, it just needed to be findable,
// named, iconed, grouped first, and openable in one tap. js/lib/sheeturl.js
// does the classifying; this file is the surface.
//
// THE CEILING, said plainly because the UI has to say it too. A normal
// /edit URL cannot be framed - Google refuses it with X-Frame-Options, and
// nothing we do on this side changes that. Reading cell values would need
// Google OAuth and the Sheets API. So there are exactly two behaviours:
// a published sheet opens in a panel here, and everything else opens a tab
// with one line, once, explaining how to move it into the first group.
import { api } from '../api.js';
import { store, bus, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, debounce } from '../util.js';
import { icon } from '../icons.js';
import { classifySheetUrl, sheetEmbedUrl, sheetLabelFrom, isDocKind } from '../lib/sheeturl.js';

// Shown once per device, at the moment it is relevant - the tap that opened a
// tab - rather than in onboarding, where nobody has a sheet in front of them.
const TIP_KEY = 'dak.sheets.pubtip';

let UI = null;
let viewer = null;

function style() {
  if (document.getElementById('sheets-css')) return;
  const s = el('style');
  s.id = 'sheets-css';
  s.textContent = `
    /* flex:1 on the body is load-bearing, not tidying. .modal-body is the
       default flex:0 1 auto, so without this the frame collapsed to its
       min-height and sat 200px tall inside a 686px box on a phone - measured by
       probe-sheets leg 6. background:none drops the scroll-shadow gradients,
       which would otherwise paint two grey bands over an opaque frame. */
    .sht-modal.modal{max-width:min(1120px,96vw);height:min(88dvh,900px)}
    .sht-modal .modal-body{flex:1 1 auto;padding:0;display:flex;flex-direction:column;
      min-height:0;overflow:hidden;background:none}
    .sht-frame{flex:1 1 auto;display:block;width:100%;min-height:200px;border:0;
      background:#fff}
    .sht-modal .modal-foot{gap:var(--s-4);align-items:center;flex-wrap:wrap}
    .sht-foot-note{flex:1 1 180px;min-width:0;font-size:var(--t-xs);
      line-height:var(--t-snug);color:var(--c-text-3)}

    .sht-form .sht-verdict{display:flex;align-items:flex-start;gap:var(--s-3);
      margin:var(--s-2) 0 0;padding:var(--s-4) var(--s-5);border-radius:var(--r-md);
      background:var(--c-surface-2);color:var(--c-text-2);font-size:var(--t-sm);
      line-height:var(--t-snug)}
    .sht-form .sht-verdict.sht-yes{background:var(--c-success-quiet);color:var(--c-text)}
    .sht-form .sht-verdict.sht-no{background:var(--c-warn-quiet);color:var(--c-text)}
    .sht-form .sht-verdict.sht-bad{background:var(--c-danger-quiet);color:var(--c-text)}
    .sht-form .sht-verdict .ico{flex:none;width:15px;height:15px;margin-top:1px}

    /* The bookmark strip is flex-wrap:nowrap with overflow-x:auto, which is right
       for pills and wrong for a sentence: dropped in as-is the tip became a
       min-content column two words wide and 500px tall, parked off the right of
       a scroller with a hidden scrollbar. css/features.css already lets the strip
       wrap when it holds a .bmk-note, for exactly this reason; this is the same
       exemption for the same shape of content. */
    .bmk-bar:has(.sht-tip){flex-wrap:wrap}
    .sht-tip{display:flex;align-items:flex-start;gap:var(--s-3);flex:1 1 100%;min-width:0;
      margin-top:var(--s-2);padding:var(--s-3) var(--s-4);border-radius:var(--r-md);
      background:var(--c-accent-quiet);color:var(--c-text);font-size:var(--t-xs);
      line-height:var(--t-snug);white-space:normal}
    .sht-tip button{flex:none;margin:-2px -2px 0 auto;padding:0 var(--s-3);
      min-height:0;border:0;background:none;color:var(--c-text-2);
      font-size:var(--t-sm);line-height:1.6}
    .sht-tip button:hover{background:none;color:var(--c-text)}

    @media (max-width:860px){
      /* Full width, like every other bottom sheet in the app. Without this the
         .sht-modal.modal specificity beats .modal's own phone rule and the
         viewer floats 8px in from each edge, which reads as a broken dialog. */
      .sht-modal.modal{max-width:100%;height:88dvh}
      .sht-modal .modal-foot{padding-bottom:max(var(--s-5),var(--safe-b))}
    }`;
  document.head.appendChild(s);
}

const canManage = () => hasPerm(PERM.MANAGE_CHANNELS);

// ------------------------------------------------------------------ the tip
// One line, once, dismissible. It mounts into the bookmark bar when that bar is
// on screen, which is where the tap came from in almost every case, and falls
// back to a toast when it is not (the panel, a slash command). Reaching for
// #bmkBar by id rather than importing bookmarks.js keeps the dependency one-way.
function tipSeen() {
  try { return !!localStorage.getItem(TIP_KEY); } catch { return false; }
}
function markTipSeen() {
  try { localStorage.setItem(TIP_KEY, '1'); } catch { /* private mode */ }
}

const TIP_TEXT = 'Opened in a new tab. In Google Sheets, File > Share > Publish to web '
  + 'makes this one open inside Dek instead.';

function showPublishTip() {
  if (tipSeen()) return;
  markTipSeen();
  const bar = document.getElementById('bmkBar');
  if (!bar) { UI?.toast(TIP_TEXT, 'info', 8000); return; }
  const tip = el('div', 'sht-tip');
  tip.appendChild(el('span', null, esc(TIP_TEXT)));
  const x = el('button', null, '✕');
  x.title = 'Got it';
  x.onclick = () => tip.remove();
  tip.appendChild(x);
  bar.appendChild(tip);
}

// ------------------------------------------------------------------ viewer
// A modal rather than a side panel: a sheet is read wide, and the side panel is
// 400px on a laptop and the whole screen on a phone anyway. The modal already
// carries Esc, the backdrop and the phone bottom-sheet geometry, so this is the
// same surface every other dialog uses, sized up and with its padding removed.
function openViewer(row, info) {
  const src = sheetEmbedUrl(info);
  if (!src) { window.open(info.url, '_blank', 'noopener'); return; }
  viewer?.close();

  // The frame is the body, so .modal-body's flex column hands it the whole box.
  // sandbox is set even though the frame is cross-origin: allow-same-origin
  // there means "keep docs.google.com's own origin", not ours, and the list is
  // the minimum a published sheet needs to draw and to open its own links.
  const frame = el('iframe', 'sht-frame');
  frame.src = src;
  frame.title = row.label || info.name;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.setAttribute('sandbox',
    'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms');

  const m = UI.modal({
    title: row.label || info.name,
    body: frame,
    onClose: () => { viewer = null; },
    actions: [{
      label: 'Open in ' + (info.app || 'a new tab'),
      kind: 'ghost',
      onClick: () => window.open(info.url, '_blank', 'noopener'),
    }],
  });
  m.box.classList.add('sht-modal');

  // A cross-origin frame that refuses to render still fires load, so there is no
  // event that means "this did not work". The honest mitigation is to keep the
  // way out in view rather than to guess, and to say what a published view is:
  // Google re-renders it on its own schedule, so a change made thirty seconds
  // ago may not be here yet, and somebody comparing the two needs to know that.
  m.foot.insertBefore(el('span', 'sht-foot-note',
    'Published view - Google refreshes it every few minutes, and it is read only. '
    + 'Blank? Open it in a tab.'), m.foot.firstChild);

  viewer = m;
  return m;
}

// ------------------------------------------------------------------ opening
/** The one entry point every surface calls. Decides frame vs tab, and tips. */
export function openSheetLink(row) {
  const info = classifySheetUrl(row?.url);
  if (!info.valid) { UI?.toast('That bookmark does not point at a web link', 'error'); return null; }
  // bookmarks.js imports this statically, so it is reachable in the window
  // between the module evaluating and register() running. A tap in that window
  // still has to open the sheet, just without the panel.
  if (info.embeddable && UI) return openViewer(row, info);
  window.open(info.url, '_blank', 'noopener');
  if (info.publishable) showPublishTip();
  return null;
}

// ------------------------------------------------------------------ add flow
// Hand-built rather than formModal, because the whole value of this dialog is
// the line that appears WHILE the URL is being pasted. "This one will open
// inside Dek" is the only place the published/not-published distinction can be
// taught without a help page nobody opens, and a fire-and-forget form cannot
// say it. The label is derived from the same parse, and stops being derived the
// moment somebody types over it.
export function addSheetDialog(channelId) {
  if (!UI) return;
  const chId = channelId || store.current?.id;
  if (!chId) { UI.toast('Open a channel first', 'error'); return; }

  const form = el('form', 'form sht-form');
  form.innerHTML = `
    <label class="field"><span class="field-label">Sheet link</span>
      <input class="sht-url" type="url" inputmode="url" autocomplete="off" spellcheck="false"
        placeholder="https://docs.google.com/spreadsheets/..." />
      <span class="field-hint">Paste it from the address bar in Google Sheets, Excel or Drive.</span>
    </label>
    <label class="field"><span class="field-label">Name it</span>
      <input class="sht-label" autocomplete="off" placeholder="Volunteer roster" />
    </label>
    <p class="sht-verdict"></p>`;

  const urlIn = form.querySelector('.sht-url');
  const labelIn = form.querySelector('.sht-label');
  const verdict = form.querySelector('.sht-verdict');
  let labelTouched = false;
  let info = classifySheetUrl('');

  labelIn.addEventListener('input', () => { labelTouched = true; });

  const readUrl = () => {
    info = classifySheetUrl(urlIn.value);
    if (!labelTouched) labelIn.value = sheetLabelFrom(info);
    verdict.className = 'sht-verdict';
    if (!urlIn.value.trim()) { verdict.textContent = ''; verdict.style.display = 'none'; return; }
    verdict.style.display = '';
    let cls = 'sht-no';
    let ico = 'link';
    let text;
    if (!info.valid) {
      cls = 'sht-bad'; ico = 'alert';
      text = 'That is not a web link. It needs to start with https://';
    } else if (info.embeddable) {
      cls = 'sht-yes'; ico = 'check';
      text = `Published ${info.name.toLowerCase()} - this one opens inside Dek.`;
    } else if (info.publishable) {
      ico = 'sheet';
      text = `${info.full} - opens in a new tab. `
        + 'File > Share > Publish to web makes it open inside Dek.';
    } else if (isDocKind(info.kind)) {
      ico = 'sheet';
      text = `${info.full || info.host} - opens in a new tab.`;
    } else {
      text = `Not a sheet, but ${info.host} will be pinned here as a link.`;
    }
    verdict.className = 'sht-verdict ' + cls;
    verdict.innerHTML = icon(ico) + '<span>' + esc(text) + '</span>';
  };
  urlIn.addEventListener('input', debounce(readUrl, 120));
  urlIn.addEventListener('change', readUrl);
  readUrl();

  const m = UI.modal({
    title: 'Add a sheet',
    body: form,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: (c) => c() },
      {
        label: 'Add',
        onClick: async (close) => {
          readUrl();
          if (!info.valid) { UI.toast('That is not a web link', 'error'); return; }
          const label = labelIn.value.trim() || sheetLabelFrom(info) || info.name;
          try {
            const row = await api.addBookmark(chId, label, info.url, null);
            close();
            // The bar owns the pills; it listens for this rather than being
            // reached into, so the slash command and the panel both land in the
            // same place with no import edge between the two features.
            bus.emit('bookmark:added', { channel_id: chId, row: row || { id: null, label, url: info.url } });
            UI.toast('Sheet pinned to the top of the channel');
          } catch (e) { UI.toast(e.message, 'error'); }
        },
      },
    ],
  });
  // Enter submits. Without this the form's own submit event reloads the page,
  // because a bare <form> inside a modal has no handler of its own.
  form.onsubmit = (e) => {
    e.preventDefault();
    m.foot.querySelector('button:last-child')?.click();
  };
  setTimeout(() => urlIn.focus(), 40);
  return m;
}

// ------------------------------------------------------------------ pill bits
/** Icon name for a pinned row, so the bar can draw sheets differently. */
export function sheetIconFor(kind) {
  if (kind === 'gsheet' || kind === 'gsheet-pub' || kind === 'excel') return 'sheet';
  // Not `chart` for slides and not `check` for a form: at 14px a bar chart reads
  // as analytics and a tick reads as a completed task, which is the wrong noun
  // in both cases. A picture and a pencil say deck and fill-this-in.
  if (kind === 'gslides' || kind === 'gslides-pub') return 'image';
  if (kind === 'gform') return 'edit';
  if (kind === 'gdrive') return 'folder';
  return 'doc';
}

/** The title attribute a pinned doc gets: what tapping it will actually do. */
export function sheetHint(info) {
  if (info.embeddable) return 'Opens inside Dek';
  if (info.publishable) return 'Opens in a new tab - publish it to web to open it here';
  return 'Opens in a new tab';
}

export function register({ ui }) {
  style();
  UI = ui;

  ui.addSlashCommand({
    name: 'sheet',
    description: 'Pin a Google Sheet or other tracker to this channel',
    args: '[link]',
    run: (arg) => {
      if (!canManage()) { ui.toast('You need Manage channels to pin a sheet', 'error'); return; }
      const m = addSheetDialog(store.current?.id);
      const first = String(arg || '').trim();
      if (m && first) {
        const input = m.box.querySelector('.sht-url');
        if (input) { input.value = first; input.dispatchEvent(new Event('change')); }
      }
    },
  });

  // Nothing to keep open across a channel switch: a sheet belongs to the
  // channel it was pinned in, and leaving it floating over a different one
  // reads as the new channel's sheet.
  bus.on('channel:open', () => { viewer?.close(); viewer = null; });
  bus.on('dm:open', () => { viewer?.close(); viewer = null; });
}
