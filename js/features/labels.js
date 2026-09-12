// Message labels: Important, High priority, Pending, Blocked, FYI.
//
// Asked for as "Add labels such as Important, High Priority, Pending, and Task."
// Four of those are labels. The fifth is not, and this file deliberately does
// not pretend otherwise.
//
// WHY TASK IS IN THE MENU BUT IS NOT A LABEL. Dek already has tasks: a row with
// an assignee, a due date, a state machine, a place in Later and a notification
// that chases the person holding it. A label spelled "task" would be a second,
// weaker task system sitting next to the real one, and the first time somebody
// labelled a message Task and it never appeared in Later, the feature would have
// lied to them. So Task sits in the same menu, in the same place a thumb expects
// it, and routes to the real create-a-task dialog. The person gets what they
// asked for and there stays exactly one answer to "what work exists".
//
// The menu is reached from the message action bar and from the right-click menu,
// both of which core builds from ui.getMessageActions - so this file adds one
// entry and inherits both surfaces.
//
// State lives in one Map keyed by message id, refilled from one bulk read per
// render batch rather than one query per row. Exactly how reactions are loaded,
// for the same reason: fifty rows painting is one request, not fifty.
import { rpc, table } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { getSub } from '../sb.js';
import { el, esc, relTime } from '../util.js';
import { icon } from '../icons.js';
import { openChannel } from '../core/channels.js';

const PANEL = 'labels';
const CLS = 'lbl';

// The database check constraint is the authority on this list; adding one here
// without adding it there is a 22023 the person sees as "could not label that".
export const LABELS = [
  { id: 'important', label: 'Important',     glyph: '★' },
  { id: 'high',      label: 'High priority', glyph: '▲' },
  { id: 'pending',   label: 'Pending',       glyph: '◷' },
  { id: 'blocked',   label: 'Blocked',       glyph: '■' },
  { id: 'fyi',       label: 'FYI',           glyph: '●' },
];
const BY_ID = new Map(LABELS.map((l) => [l.id, l]));

// message id -> Set of label ids. One shared truth, so a pill on a row, a pill
// in the panel and the tick in the menu can never disagree.
const onMsg = new Map();
let uiRef = null;

const labelsOf = (id) => onMsg.get(id) || null;

// ------------------------------------------------------------------ loading
// message:render fires once per row, and a channel open paints fifty of them in
// the same tick. Collect the ids and ask once.
let pending = new Set();
let flushTimer = null;

function want(id) {
  if (!id) return;
  pending.add(id);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 60);
}

// An .in() filter rides in the URL, and restoreAbove/restoreBelow can hand this
// several hundred ids inside one debounce window - which is a 12KB query string
// and a refused request. Eighty per read, which is a page and a half.
const CHUNK = 80;

async function flush() {
  const ids = [...pending];
  pending = new Set();
  if (!ids.length) return;
  const got = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    // Deliberately not skipping ids already in the Map: re-opening a channel is
    // exactly when somebody else's label from an hour ago needs to appear.
    const rows = await table('message_labels', (q) => q.in('message_id', ids.slice(i, i + CHUNK)));
    for (const r of rows) {
      if (!got.has(r.message_id)) got.set(r.message_id, new Set());
      got.get(r.message_id).add(r.label);
    }
  }
  for (const id of ids) {
    const set = got.get(id) || null;
    if (set) onMsg.set(id, set); else onMsg.delete(id);
    paintRow(id);
  }
}

// ------------------------------------------------------------------ painting
// A labelled row gets a strip of pills under its body and above its reactions,
// which is the one place that exists on a grouped row as well as a headed one -
// a follow-up message in a run has no name line to hang a pill off.
function paintRow(messageId) {
  if (!messageId) return;
  const sel = `.msg[data-id="${CSS.escape(messageId)}"]`;
  for (const row of document.querySelectorAll(sel)) decorate(row, messageId);
}

function decorate(row, messageId) {
  const body = row.querySelector('.mbody');
  if (!body) return;
  const set = labelsOf(messageId);
  let strip = body.querySelector('.' + CLS + '-strip');
  if (!set || !set.size) { strip?.remove(); row.classList.remove(CLS + '-on'); return; }

  if (!strip) {
    strip = el('div', CLS + '-strip');
    const rx = body.querySelector('.rxns');
    body.insertBefore(strip, rx || null);
  }
  strip.innerHTML = '';
  // Menu order, not insertion order, so the same two labels always read the
  // same way round on every row.
  for (const def of LABELS) {
    if (!set.has(def.id)) continue;
    const pill = el('span', `${CLS}-pill ${CLS}-${def.id}`);
    pill.innerHTML = `<i>${def.glyph}</i>${esc(def.label)}`;
    pill.title = `Labelled ${def.label} - click to see everything labelled this way`;
    pill.onclick = (ev) => { ev.stopPropagation(); uiRef?.openPanel(PANEL, { label: def.id }); };
    strip.appendChild(pill);
  }
  row.classList.add(CLS + '-on');
}

// ------------------------------------------------------------------ writing
async function toggle(messageId, labelId) {
  const set = onMsg.get(messageId) || new Set();
  const had = set.has(labelId);
  // Optimistic, then corrected by the broadcast the RPC emits. A label is a
  // triage gesture made in a hurry; waiting a round trip to see it land is the
  // difference between using this and not.
  if (had) set.delete(labelId); else set.add(labelId);
  onMsg.set(messageId, set);
  paintRow(messageId);
  try {
    const added = await rpc('toggle_message_label', { p_message: messageId, p_label: labelId });
    if (!!added !== !had) {                       // the server disagreed: it wins
      if (added) set.add(labelId); else set.delete(labelId);
      onMsg.set(messageId, set);
      paintRow(messageId);
    }
  } catch (e) {
    if (had) set.add(labelId); else set.delete(labelId);
    onMsg.set(messageId, set);
    paintRow(messageId);
    uiRef?.toast(/forbidden/i.test(e.message || '')
      ? 'You can label messages in channels you can post in'
      : 'Could not label that', 'error');
  }
}

// The menu. Ticks show what is already on, so a second tap takes it off - and
// Task is last, under the labels, because it is a different kind of thing.
function openMenu(m, ev) {
  const set = labelsOf(m.id);
  const items = LABELS.map((def) => ({
    label: `${set?.has(def.id) ? '✓' : ' '} ${def.glyph}  ${def.label}`,
    onClick: () => toggle(m.id, def.id),
  }));

  // Routed to whatever module owns tasks, through the public registry rather
  // than an import: a feature may never import another feature, and this way a
  // Dek with tasks switched off simply does not offer the row.
  const mk = uiRef?.getMessageActions?.({ ...m, _context: 'channel' })
    ?.find((a) => a.id === 'make-task');
  if (mk) items.push({ label: '＋  Make this a task', onClick: () => mk.onClick(m, ev) });
  items.push({ label: '⋯  See everything labelled', onClick: () => uiRef?.openPanel(PANEL, {}) });
  uiRef?.contextMenu(ev, items);
}

// ------------------------------------------------------------------ realtime
// Core owns the 'chan' subscription and replaces the object on every switch and
// every recovered drop, so bind onto whatever is current and re-bind when core
// says it swapped one in.
const bound = new WeakSet();
let rebind = null;
function bindChannel() {
  const ch = getSub('chan');
  if (!ch) return false;
  if (bound.has(ch)) return true;
  bound.add(ch);
  ch.on('broadcast', { event: 'label' }, ({ payload }) => {
    const id = payload?.message_id;
    if (!id || !payload.label) return;
    const set = onMsg.get(id) || new Set();
    if (payload.added) set.add(payload.label); else set.delete(payload.label);
    onMsg.set(id, set);
    paintRow(id);
  });
  return true;
}
function scheduleBind() {
  clearInterval(rebind);
  let tries = 0;
  rebind = setInterval(() => { if (bindChannel() || ++tries > 20) clearInterval(rebind); }, 400);
}

// ------------------------------------------------------------------ the panel
let filter = null;

async function renderPanel(host, ctx = {}) {
  uiRef?.closePopovers?.();
  if (ctx.label !== undefined) filter = ctx.label || null;
  host.innerHTML = '';

  const chips = el('div', CLS + '-chips');
  const chip = (id, text) => {
    const b = el('button', CLS + '-chip' + (filter === id ? ' on' : ''), text);
    b.type = 'button';
    b.onclick = () => uiRef.openPanel(PANEL, { label: id });
    return b;
  };
  chips.appendChild(chip(null, 'All'));
  for (const d of LABELS) chips.appendChild(chip(d.id, `${d.glyph} ${d.label}`));
  host.appendChild(chips);

  const list = el('div', CLS + '-list');
  list.appendChild(el('div', 'muted pad', 'Loading'));
  host.appendChild(list);

  if (!store.ws) { list.innerHTML = ''; list.appendChild(emptyNote()); return; }
  let rows = [];
  try {
    rows = await rpc('list_labelled',
      { p_workspace: store.ws.id, p_label: filter, p_limit: 80 }) || [];
  } catch {
    list.innerHTML = '';
    list.appendChild(el('div', 'muted pad', 'Could not load labelled messages.'));
    return;
  }

  list.innerHTML = '';
  if (!rows.length) { list.appendChild(emptyNote()); return; }

  for (const r of rows) {
    const def = BY_ID.get(r.label);
    const card = el('div', CLS + '-card');
    const chan = store.channels.find((c) => c.id === r.channel_id);
    card.innerHTML = `
      <div class="${CLS}-cardtop">
        <span class="${CLS}-pill ${CLS}-${esc(r.label)}"><i>${def?.glyph || '●'}</i>${esc(def?.label || r.label)}</span>
        <span class="muted">#${esc(r.channel_name || chan?.name || 'channel')}</span>
        <span class="muted ${CLS}-when">${esc(relTime(r.set_at))}</span>
      </div>
      <div class="${CLS}-who">${esc(nameOf(r.author_id))}</div>
      <div class="${CLS}-text">${esc(r.body_text || '')}</div>`;
    card.onclick = () => {
      const c = store.channels.find((x) => x.id === r.channel_id);
      if (c) openChannel(c, { keepPanel: true });
      if (r.message_id) bus.emit('message:jump', { messageId: r.message_id });
    };
    list.appendChild(card);
  }
}

// The empty state is the only instruction anybody gets, so it says what the
// gesture IS rather than "no items". Reported: "it is very unintuitive right
// now, people don't know what to do with it."
function emptyNote() {
  const d = el('div', CLS + '-empty');
  d.innerHTML = `<b>Nothing labelled yet</b>
    <div class="muted">Hover any message and press the tag, or long-press it on a phone,
      to mark it Important, High priority, Pending, Blocked or FYI. Everything labelled
      in this Space collects here, so a coordinator can work through it in one place.</div>`;
  return d;
}

// ------------------------------------------------------------------ styles
// Every colour is a token restated per resolved scheme by the shell, so a pill
// follows whatever theme settles rather than assuming a dark ground - the exact
// mistake polls.js documents having made.
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-strip{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 2px}
.${CLS}-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;
  font-weight:600;letter-spacing:.02em;text-transform:uppercase;
  padding:1px 8px 1px 6px;border-radius:11px;cursor:pointer;
  border:1px solid currentColor;background:transparent;white-space:nowrap}
.${CLS}-pill i{font-style:normal;font-size:11px;line-height:1}
.${CLS}-pill:hover{filter:brightness(1.15)}
.${CLS}-important{color:var(--red,#d64545)}
.${CLS}-high{color:var(--amber,#c8791a)}
.${CLS}-pending{color:var(--accent,#5b8cff)}
.${CLS}-blocked{color:var(--red,#d64545);opacity:.85}
.${CLS}-fyi{color:var(--dim,#8a8f98)}
.${CLS}-chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px}
.${CLS}-chip{font-size:12px;padding:4px 10px;border-radius:13px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel2);color:var(--text)}
.${CLS}-chip.on{border-color:var(--accent);color:var(--accent)}
.${CLS}-list{display:flex;flex-direction:column;gap:6px;padding:0 10px 12px}
.${CLS}-card{border:1px solid var(--line);border-radius:10px;padding:8px 10px;
  background:var(--panel);cursor:pointer}
.${CLS}-card:hover{border-color:var(--accent)}
.${CLS}-cardtop{display:flex;align-items:center;gap:8px;font-size:12px}
.${CLS}-when{margin-left:auto;white-space:nowrap}
.${CLS}-who{font-weight:600;font-size:13px;margin-top:4px}
.${CLS}-text{font-size:13px;color:var(--dim);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.${CLS}-empty{padding:16px 12px;font-size:13px;line-height:1.5}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  style();

  ui.registerPanel({ id: PANEL, title: 'Labelled', icon: icon('tag'), render: renderPanel });

  ui.addMessageAction({
    id: 'label',
    label: icon('tag'),
    title: 'Label this message',
    order: 43,                                  // just before Make this a task
    contexts: ['channel', 'thread'],
    // Labels live on public.messages. A direct message is a different table and
    // toggle_message_label would refuse it, so do not offer what cannot work.
    show: (m) => !!m.id && !m.conversation_id,
    onClick: (m, ev) => { ev?.stopPropagation?.(); openMenu(m, ev); },
  });

  bus.on('message:render', ({ msg, el: row }) => {
    if (!msg?.id || msg.conversation_id) return;
    if (onMsg.has(msg.id)) decorate(row, msg.id);
    want(msg.id);
  });

  bus.on('channel:open', scheduleBind);
  bus.on('channel:subscribed', scheduleBind);
  scheduleBind();

  ui.addSlashCommand({
    name: 'labelled',
    description: 'Everything labelled Important, Pending and the rest',
    run: (arg) => {
      const asked = (arg || '').trim().toLowerCase();
      const hit = LABELS.find((l) => l.id === asked || l.label.toLowerCase() === asked);
      ui.openPanel(PANEL, { label: hit ? hit.id : null });
    },
  });
}

export default { register };
