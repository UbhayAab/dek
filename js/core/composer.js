// The composer: autocomplete (@people, #channels, :emoji, /commands), attachments,
// server-synced drafts, typing broadcast, and optimistic send.
import { api, table } from '../api.js';
import { store, bus, nameOf, roleTagOf } from '../store.js';
import { getSub } from '../sb.js';
import { $, el, esc, debounce, fmtSize } from '../util.js';
import { toast, listSlash, runSlash, renderComposerButtons, addComposerButton } from '../ui.js';
import { uploadFile } from './media.js';
import { openEmojiPicker, searchEmoji } from './emoji.js';
import { appendMessage, claimMessage, scrollDown, upgradeMessageRow } from './messages.js';
import { icon } from '../icons.js';

let pending = [];          // attachments being/already uploaded
let ac = null;             // active autocomplete state
// Voice notes live in features/voicenotes.js - the single owner of recording
// state. A second implementation here once raced it for the same button id and
// shipped a chunk-collection bug that sent the PREVIOUS recording to the chat.

// WHICH BOX THE PICKER IS SERVING.
//
// Reported: "I am not able to tag people when I am within a reply thread."
// It was not a broken binding - it was a binding that was never made. This whole
// engine read one hardcoded `$('composer')` and painted into one hardcoded
// `$('acPop')`, and initComposer() wired it once at boot to the single permanent
// channel box. The thread reply box is a DIFFERENT element (#threadComposer),
// rebuilt from scratch every time a thread opens, and nothing ever taught the
// picker it existed. Typing @ there produced no dropdown at all.
//
// Naively pointing the old code at the thread box would have been worse than
// nothing: #acPop is positioned absolutely inside #composerBar, so the popup
// would have appeared pinned above the CHANNEL composer at the bottom of the
// screen while you typed in the panel on the right.
//
// So the pair becomes a variable. One picker at a time is still correct - you
// can only type in one box - and `ac` stays a singleton for the same reason.
// TWO DIFFERENT QUESTIONS, AND CONFLATING THEM BROKE THE CHANNEL BOX.
//
// composerEl() means "the channel composer" and is what send(), saveDraft(),
// emitTyping(), autogrow() and setComposerEnabled() have always meant by it.
// Pointing it at whichever box the picker was serving made
// setComposerEnabled(true) enable the THREAD textarea and leave the channel one
// disabled - caught by scripts/probe-threadmention.mjs leg 7, which is why that
// leg asserts the box is actually enabled before testing anything else.
//
// acInput() is the other question: which box is the picker reading right now.
// Only the two autocomplete functions below may ask it.
let acTarget = null;                         // { input, pop } currently served
const composerEl = () => $('composer');
const acInput = () => acTarget?.input || $('composer');
const acPopEl = () => acTarget?.pop || $('acPop');

// ------------------------------------------------------------------ autocomplete
function acHide() {
  ac = null;
  const p = acPopEl();
  if (p) { p.classList.add('hidden'); p.innerHTML = ''; }
}

function acShow(items, onPick) {
  const p = acPopEl();
  if (!p) return acHide();
  if (!items.length) return acHide();
  ac = { items, index: 0, onPick };
  p.classList.remove('hidden');
  paintAc();
}

function paintAc() {
  const p = acPopEl();
  if (!p) return;
  p.innerHTML = ac.items.map((it, i) =>
    `<div class="ac-row${i === ac.index ? ' sel' : ''}" data-i="${i}">
      ${it.icon ? `<span class="ac-ico">${it.icon}</span>` : ''}
      <span class="ac-label">${esc(it.label)}</span>
      ${it.hint ? `<span class="ac-hint">${esc(it.hint)}</span>` : ''}</div>`).join('');
  p.querySelectorAll('.ac-row').forEach((n) => {
    n.onmousedown = (e) => { e.preventDefault(); ac.onPick(ac.items[+n.dataset.i]); };
  });
}

// The picker's keyboard, lifted out of initComposer so every composer gets the
// same arrows, Enter, Tab and Escape rather than the channel box having a
// behaviour the thread box has to re-implement and get subtly wrong.
// Returns true when it consumed the key, so the caller knows to stop.
function acKeydown(e) {
  if (!ac) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); ac.index = (ac.index + 1) % ac.items.length; paintAc(); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); ac.index = (ac.index - 1 + ac.items.length) % ac.items.length; paintAc(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); ac.onPick(ac.items[ac.index]); return true; }
  if (e.key === 'Escape') { e.preventDefault(); acHide(); return true; }
  return false;
}

// Give any textarea the same @people / #channels / :emoji picker the channel
// composer has. `pop` must be an element inside a positioned ancestor, because
// .acpop is absolutely positioned - see .thread-composer in css/messages.css.
//
// Returns a function that detaches, for a box that is thrown away: the thread
// footer is rebuilt on every open, and a listener left pointing at a detached
// node would keep the whole panel subtree alive.
export function bindAutocomplete(input, pop) {
  if (!input || !pop) return () => {};
  const claim = () => { acTarget = { input, pop }; };
  const onInput = () => { claim(); updateAutocomplete(); };
  const onKeydown = (e) => { claim(); acKeydown(e); };
  const onFocus = claim;
  const onBlur = () => setTimeout(() => { if (acTarget?.input === input) acHide(); }, 120);
  input.addEventListener('input', onInput);
  // Capture, so the picker gets Enter before the box's own send handler does.
  // Without this, Enter while the dropdown is open sends "@ash" as text instead
  // of completing it - which is the shape of the original complaint.
  input.addEventListener('keydown', onKeydown, true);
  input.addEventListener('focus', onFocus);
  input.addEventListener('blur', onBlur);
  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeydown, true);
    input.removeEventListener('focus', onFocus);
    input.removeEventListener('blur', onBlur);
    if (acTarget?.input === input) { acHide(); acTarget = null; }
  };
}

function replaceToken(re, text) {
  const c = acInput();
  if (!c) return;
  const before = c.value.slice(0, c.selectionStart);
  const after = c.value.slice(c.selectionStart);
  const replaced = before.replace(re, text);
  c.value = replaced + after;
  const pos = replaced.length;
  c.focus();
  c.setSelectionRange(pos, pos);
  acHide();
  // autogrow() sizes the CHANNEL box specifically. A borrowed composer brings
  // its own resize, so fire an input event and let whoever owns that box handle
  // it rather than reaching across and setting a height on somebody else's node.
  if (c.id === 'composer') autogrow();
  else c.dispatchEvent(new Event('input', { bubbles: true }));
}

function updateAutocomplete() {
  const c = acInput();
  if (!c) return acHide();
  const upto = c.value.slice(0, c.selectionStart);

  const slash = upto.match(/^\/(\w*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    const cmds = listSlash().filter((s) => s.name.startsWith(q)).slice(0, 8);
    return acShow(cmds.map((s) => ({ label: '/' + s.name, hint: s.description, icon: '⌘', value: s })),
      (it) => replaceToken(/^\/(\w*)$/, '/' + it.value.name + ' '));
  }

  const at = upto.match(/(?:^|\s)@([\w.-]*)$/);
  if (at) {
    const q = at[1].toLowerCase();
    const people = [...store.profiles.values()]
      .filter((p) => p.id !== store.me)
      .filter((p) => !q || (p.display_name || '').toLowerCase().includes(q) || (p.username || '').toLowerCase().includes(q))
      .slice(0, 7)
      .map((p) => {
        // The role goes in the hint, not the label: the label is what gets
        // typed into the message, and "Admin" is not part of anybody's handle.
        const tag = roleTagOf(p.id);
        const handle = p.username ? '@' + p.username : '';
        return { label: p.display_name || p.username, icon: icon('members'),
          hint: [tag, handle].filter(Boolean).join(' · '),
          value: p.username || p.display_name };
      });
    const groups = [{ label: '@here', hint: 'notify everyone online', icon: icon('megaphone'), value: 'here' },
      { label: '@channel', hint: 'notify the whole channel', icon: icon('megaphone'), value: 'channel' }]
      .filter((g) => !q || g.label.slice(1).startsWith(q));
    // Cached group handles from this Space: "@sales", "@on-call".
    const gitems = getGroupHandles()
      .filter((h) => !q || h.includes(q))
      .slice(0, 4)
      .map((h) => ({ label: '@' + h, hint: 'every member of the group', icon: icon('members'), value: h }));
    const items = [...people, ...groups, ...gitems];
    if (items.length) return acShow(items, (it) => replaceToken(/(?:^|\s)@([\w.-]*)$/, (m) => m.replace(/@[\w.-]*$/, '@' + it.value + ' ')));
  }

  const hash = upto.match(/(?:^|\s)#([\w-]*)$/);
  if (hash) {
    const q = hash[1].toLowerCase();
    const chans = store.channels
      .filter((ch) => ch.kind !== 'voice' && (!q || ch.name.includes(q)))
      .slice(0, 7)
      .map((ch) => ({ label: '#' + ch.name, hint: ch.topic || '', icon: '#', value: ch.name }));
    if (chans.length) return acShow(chans, (it) => replaceToken(/(?:^|\s)#([\w-]*)$/, (m) => m.replace(/#[\w-]*$/, '#' + it.value + ' ')));
  }

  const emo = upto.match(/:([a-z0-9_+-]{2,})$/i);
  if (emo) {
    const found = searchEmoji(emo[1]).slice(0, 8)
      .map((e) => ({ label: `${e.ch}  ${e.name}`, icon: '', value: e.ch }));
    if (found.length) return acShow(found, (it) => replaceToken(/:([a-z0-9_+-]{2,})$/i, it.value + ' '));
  }

  acHide();
}

// ------------------------------------------------------------------ mentions
// Longest-match scan over the roster instead of a no-space regex. The old
// /@[\w.-]+/ extraction stopped at the first space, so autocomplete inserting
// "@Asha Kumar" produced a token "@Asha" that matched nobody - silently, with
 // no notification and no highlight. Names sort longest-first so a display name
// always beats a username that prefixes it.

// ---- @group mentions -------------------------------------------------------
// Groups are an @handle that pings a fixed set of people (roles.js manages
// them), but nothing ever resolved them: typing "@sales" stored zero mention
// ids and notified nobody. Resolution needs member ids synchronously at send
// time, so the roster lives in this cache, refreshed per Space with a short
// TTL and immediately whenever roles.js reports a change.
const groupMentionMap = new Map();   // lowercase handle -> Set<user_id>
let groupWsId = null;
let groupRefreshedAt = 0;

export function getGroupHandles() {
  return [...groupMentionMap.keys()];
}

export async function refreshGroupMentions(force = false) {
  const ws = store.ws && store.ws.id;
  if (!ws) return;
  if (!force && ws === groupWsId && Date.now() - groupRefreshedAt < 60000) return;
  try {
    const [groups, memberships] = await Promise.all([
      table('user_groups', (q) => q.eq('workspace_id', ws)),
      table('user_group_members', (q) => q.eq('workspace_id', ws)),
    ]);
    const byId = new Map((groups || []).map((g) => [g.id, String(g.handle).toLowerCase()]));
    const next = new Map();
    for (const g of groups || []) {
      if (g && g.handle) next.set(String(g.handle).toLowerCase(), new Set());
    }
    for (const m of memberships || []) {
      const set = next.get(byId.get(m.group_id));
      if (set && m.user_id) set.add(m.user_id);
    }
    groupMentionMap.clear();
    for (const [k, v] of next) groupMentionMap.set(k, v);
    groupWsId = ws;
    groupRefreshedAt = Date.now();
  } catch {
    /* Cache stays as-is; mentions of people still work. */
  }
}
bus.on('groups:changed', () => refreshGroupMentions(true));
bus.on('channel:open', () => refreshGroupMentions());

export function resolveMentions(text) {
  const out = [];
  if (!text) return out;
  const cands = [];                        // ['@token', userId]
  for (const p of store.profiles.values()) {
    if (p.username) cands.push([('@' + p.username).toLowerCase(), p.id]);
    if (p.display_name) cands.push([('@' + p.display_name).toLowerCase(), p.id]);
  }
  cands.sort((a, z) => z[0].length - a[0].length);
  const ws = store.ws && store.ws.id;
  const haveGroups = ws === groupWsId && groupMentionMap.size > 0;
  const lower = text.toLowerCase();
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    // A mention opens at a word edge. Mid-word "@" is an email address or a
    // stray symbol, never a person - "mail x@ashakumar" must stay mail.
    if (i > 0 && /[\w.-]/.test(lower[i - 1])) continue;
    let hit = false;
    for (const [name, id] of cands) {
      if (!lower.startsWith(name, i)) continue;
      const end = i + name.length;
      const ch = lower[end];
      // The mention must end at a word edge, or "@asha" inside "@ashakumar"
      // would claim a stranger's handle.
      if (ch !== undefined && !/[\s.,!?;:)'"\]]/.test(ch)) continue;
      if (!out.includes(id)) out.push(id);
      hit = true;
      break;
    }
    if (hit || !haveGroups) continue;
    // Nobody on the roster owns this token - does a group handle?
    const gm = /^@([a-z0-9][a-z0-9._-]*)/.exec(lower.slice(i));
    if (!gm) continue;
    const end = i + gm[0].length;
    const ch = lower[end];
    if (ch !== undefined && !/[\s.,!?;:)'"\]]/.test(ch)) continue;
    for (const id of groupMentionMap.get(gm[1]) || []) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}
bus.resolveMentions = resolveMentions;

export function mentionScope(text) {
  if (/(^|\s)@channel\b/.test(text)) return 'channel';
  if (/(^|\s)@here\b/.test(text)) return 'here';
  return 'none';
}

// ------------------------------------------------------------------ attachments
function renderChips() {
  const host = $('attachChips');
  if (!pending.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  host.classList.remove('hidden');
  host.innerHTML = pending.map((a, i) => `
    <div class="chip${a.uploading ? ' up' : ''}${a.failed ? ' failed' : ''}">
      <span>${icon('doc')}</span>
      <span class="chip-name">${esc(a.name || 'file')}</span>
      <span class="muted">${esc(fmtSize(a.size))}</span>
      ${a.uploading ? `<span class="chip-prog" style="width:${Math.round((a.progress || 0) * 100)}%"></span>` : ''}
      <span class="x" data-i="${i}">✕</span></div>`).join('');
  host.querySelectorAll('.x').forEach((x) => {
    x.onclick = () => { pending.splice(+x.dataset.i, 1); renderChips(); };
  });
}

export async function addFiles(files) {
  for (const f of files) {
    const stub = { name: f.name, mime: f.type, size: f.size, uploading: true, progress: 0 };
    pending.push(stub);
    renderChips();
    try {
      const a = await uploadFile(f, (p) => { stub.progress = p; renderChips(); });
      Object.assign(stub, a, { uploading: false });
    } catch (e) {
      stub.failed = true;
      stub.uploading = false;
      toast(`${f.name}: ${e.message}`, 'error');
      pending = pending.filter((x) => x !== stub);
    }
    renderChips();
  }
}

// ------------------------------------------------------------------ drafts
const saveDraft = debounce(() => {
  const c = composerEl();
  const scope = store.currentDM ? ['dm', store.currentDM] : store.current ? ['channel', store.current.id] : null;
  if (!scope) return;
  const text = c.value;
  store.drafts.set(scope[0] + ':' + scope[1], text);
  api.saveDraft(scope[0], scope[1], text).catch(() => {});
}, 900);

// ------------------------------------------------------------------ typing
// Typing was a heartbeat: one broadcast every 1.8s for as long as your fingers
// moved. Measured on a live two-client run, one 55-character sentence at adult
// thumb speed produced SIX broadcasts, each of them fanned out to every person
// with that channel open and billed per recipient. In a 300-person channel five
// simultaneous typists is 833 messages/second, over the Pro plan's 500/s cap -
// so the indicator, not the messages, is what takes the product down first.
//
// This is the state machine every other chat product uses instead: one edge on
// idle -> typing, one edge on typing -> idle, and a slow keepalive in between so
// a long message does not silently expire on the receiver. Two broadcasts for a
// normal sentence rather than one per 1.8 seconds of effort.
//
// The stop edge rides INSIDE the existing 'typing' event as a payload flag
// rather than as a new broadcast event, deliberately: the handler map for the
// typ: topic lives in channels.js, and a payload field needs no change there
// and no coordination with a client that has not reloaded yet. An old client sends
// no `state` and is read as a start, which is exactly what it means.
//
// Sending itself broadcasts nothing now: the message arriving IS the stop, and
// presence.js clears the author off the indicator when 'message:new' lands.
// Explicit stops remain only where no message is about to arrive - blur,
// hidden, delete-to-empty, the 4s idle timer, and the durable outbox whose
// queued rows produce no echo. A start is gated behind 800ms of sustained
// composition, so "ok" and "done" cost zero broadcasts instead of two.
const TYPING_KEEPALIVE_MS = 10000;   // < the receiver's 12s expiry, so a real typist never flickers
const TYPING_IDLE_MS = 4000;         // fingers stopped: say so rather than let it time out
const TYPING_GATE_MS = 800;          // sub-second replies publish nothing at all
let typingOn = false;
let typingSentAt = 0;
let typingIdleTimer = null;
let typingGateTimer = null;
let lastSendAt = 0;

function sendTyping(state) {
  const sub = getSub('typing');
  if (!sub) return;
  sub.send({
    type: 'broadcast', event: 'typing',
    payload: { user_id: store.me, name: nameOf(store.me), state },
  });
}

export function stopTyping() {
  clearTimeout(typingIdleTimer);
  clearTimeout(typingGateTimer);
  typingIdleTimer = typingGateTimer = null;
  if (!typingOn) return;
  typingOn = false;
  sendTyping('stop');
}

// Send-path clear: retract locally only, because the message itself tells
// everyone else. Broadcasting here spent V billed messages per message and
// arrived AFTER it anyway.
function clearTypingLocal() {
  clearTimeout(typingIdleTimer);
  clearTimeout(typingGateTimer);
  typingIdleTimer = typingGateTimer = null;
  typingOn = false;
}

function fireStart() {
  typingGateTimer = null;
  typingOn = true;
  typingSentAt = Date.now();
  sendTyping('start');
}

// Called on every keystroke. Almost all of them return without touching the
// socket, which is the point.
function emitTyping() {
  const c = composerEl();
  // Nothing in the box is not typing. Deleting back to empty must retract the
  // indicator, not keep publishing it.
  if (!c || !c.value.trim()) { stopTyping(); return; }
  // A hidden tab is a phone in a pocket or a laptop lid coming down. Anything it
  // publishes is fanned out to everyone and read by nobody.
  if (document.visibilityState === 'hidden') { stopTyping(); return; }

  const now = Date.now();
  if (!typingOn) {
    // Not published yet: hold the start until composition looks sustained.
    if (!typingGateTimer) typingGateTimer = setTimeout(fireStart, TYPING_GATE_MS);
  } else if (now - typingSentAt >= TYPING_KEEPALIVE_MS || typingSentAt <= lastSendAt) {
    // Long sentence refreshes the keepalive. A start predating my last send
    // must be republished: that send's message:new can land after the start
    // and clear it on receivers while I am still mid-sentence.
    typingSentAt = now;
    sendTyping('start');
  }
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
}

// Switching channel replaces the 'typing' subscription under us, so there is no
// longer a socket to retract on. Drop the local state instead - the people still
// in the old channel expire the indicator on their own 12s timer. The gate timer
// goes too: firing after the switch would publish onto the NEW channel's topic.
function resetTyping() {
  clearTimeout(typingIdleTimer);
  clearTimeout(typingGateTimer);
  typingIdleTimer = typingGateTimer = null;
  typingOn = false;
  typingSentAt = 0;
}

// ------------------------------------------------------------------ send
// The composer must not accept input before there is somewhere to send it.
// Without this, anything typed during the moment between a workspace switch and
// the first channel opening is sent to `undefined` and silently lost.
export function setComposerEnabled(on, reason) {
  const c = composerEl();
  if (!c) return;
  c.disabled = !on;
  c.placeholder = on ? c.dataset.ph || 'Message' : (reason || 'Pick a channel to start writing');
  $('sendBtn')?.toggleAttribute('disabled', !on);
  $('attachBtn')?.toggleAttribute('disabled', !on);
}

export async function send() {
  const c = composerEl();
  const text = c.value.trim();

  if (!store.current && !store.currentDM) {
    toast('Open a channel or a conversation first');
    return;
  }
  if (pending.some((a) => a.uploading)) { toast('Still uploading…'); return; }
  const atts = pending.filter((a) => a.object_key).map((a) => ({
    object_key: a.object_key, thumb_key: a.thumb_key || null, mime: a.mime,
    width: a.width, height: a.height,
    duration_ms: a.duration_ms, name: a.name, size: a.size,
  }));
  if (!text && !atts.length) return;

  if (text.startsWith('/') && !atts.length) {
    const handled = await runSlash(text);
    if (handled) { c.value = ''; autogrow(); acHide(); return; }
  }

  c.value = '';
  autogrow();
  acHide();
  // The message itself is about to arrive on their screen, which is the
  // receiver's signal to clear the indicator. Retract locally only - a stop
  // broadcast here was V billed messages per message, arriving after the
  // message it retracted.
  lastSendAt = Date.now();
  clearTypingLocal();
  pending = [];
  renderChips();

  const scope = store.currentDM ? ['dm', store.currentDM] : ['channel', store.current?.id];
  store.drafts.delete(scope[0] + ':' + scope[1]);
  api.deleteDraft(scope[0], scope[1]).catch(() => {});

  const nonce = crypto.randomUUID();
  store.seen.add('n:' + nonce);
  const optimistic = {
    id: nonce, client_msg_id: nonce, author_id: store.me, body_text: text,
    attachments: atts, created_at: new Date().toISOString(),
    reply_to_id: store.replyTarget?.id || null,
  };
  const row = appendMessage($('messages'), optimistic, store.currentDM ? 'dm' : 'channel');
  row.classList.add('pending');
  scrollDown();

  const replyTo = store.replyTarget?.id || null;
  clearReply();

  try {
    let data;
    if (store.currentDM) {
      data = await api.sendDM({ conversation: store.currentDM, nonce, text, attachments: atts, replyTo });
    } else {
      data = await api.send({
        channel: store.current.id, nonce, text, attachments: atts,
        mentions: resolveMentions(text), mentionScope: mentionScope(text), replyTo,
      });
    }
    if (data) {
      store.seen.add(data.id);
      // Only if it is the very next event. Jumping the cursor to my own seq
      // would step over anything published between my last applied event and
      // this send, and a cursor that has stepped over an event can never ask
      // for it again - that is precisely the bug gap detection exists to catch,
      // and the sender must not reintroduce it for themselves.
      if (!store.currentDM && data.seq === store.cursor + 1) store.cursor = data.seq;
      if (store.currentDM && data.seq === store.dmCursor + 1) store.dmCursor = data.seq;
      // Re-point the row that is already on screen at the real message. Not a
      // replacement: the optimistic node stays, so its grouping against the
      // message above it survives and nothing holding a reference to it (a
      // hover, a scroll anchor) is left on a detached element.
      upgradeMessageRow(row, data, store.currentDM ? 'dm' : 'channel');
      scrollDown();
    }
  } catch (e) {
    row.classList.remove('pending');
    // The durable outbox owns this row's story when it is running: it has
    // already queued the message, tagged the row, and painted a state strip
    // saying so. Painting a SECOND, different explanation on top of that - and
    // watching it get deleted 140ms later - is the opposite of calm. It also
    // told a lie: "not delivered" for a message that is on disk and will send.
    if (row.dataset.obNonce || row.querySelector('.ob-state')) {
      // A queued row produces no message:new echo for anyone, so the receivers
      // have no arrival to clear the indicator with - send the explicit stop.
      // Skipped when typing has already republished a start, which a late stop
      // here would wrongly kill.
      if (!typingOn) sendTyping('stop');
      return;
    }

    // No outbox: this row is on its own, so explain it here. Quietly - the
    // message is still there, still readable, and one button fixes it.
    row.classList.add('failed');
    const mbody = row.querySelector('.mbody') || row;
    row.querySelector('.send-state')?.remove();
    const strip = el('div', 'send-state');
    strip.innerHTML = `<span>${icon('clock')}</span><span>${esc(sendFailureLine(e))}</span>`;
    const retry = el('button', 'sm', 'Try again');
    retry.onclick = () => {
      row.remove();
      store.seen.delete('n:' + nonce);
      c.value = text;
      autogrow();
      send();
    };
    strip.appendChild(retry);
    const anchor = mbody.querySelector('.rxns');
    if (anchor) mbody.insertBefore(strip, anchor); else mbody.appendChild(strip);
    scrollDown();
    // No red toast on top of it. The row is on screen and says what happened;
    // an alarm about something already explained in place reads as two failures.
    if (!row.isConnected) toast(sendFailureLine(e));
  }
}

// A person who cannot send does not need an error code, they need to know
// whether to try again now or later. Everything else is noise.
function sendFailureLine(e) {
  const msg = String(e?.message || '');
  if (!navigator.onLine || /No connection|Failed to fetch|NetworkError/i.test(msg)) {
    return 'Not sent - no internet. Try again when you are back.';
  }
  if (/rate_limited|53400|too fast/i.test(msg)) return 'Not sent - slow down a moment, then try again.';
  return 'Not sent. ' + (msg || 'Try again.');
}

// ------------------------------------------------------------------ reply bar
export function setReply(m) {
  store.replyTarget = { id: m.id, author_id: m.author_id, body_text: m.body_text };
  const bar = $('replyBar');
  bar.classList.remove('hidden');
  bar.innerHTML = `<span class="reply-ico">↩</span>
    <span>Replying to <b>${esc(nameOf(m.author_id))}</b></span>
    <span class="muted reply-snip">${esc((m.body_text || '').slice(0, 70))}</span>
    <button class="icon" id="cancelReply">✕</button>`;
  $('cancelReply').onclick = clearReply;
  composerEl().focus();
}

export function clearReply() {
  store.replyTarget = null;
  const b = $('replyBar');
  b.classList.add('hidden');
  b.innerHTML = '';
}

function autogrow() {
  const c = composerEl();
  if (!c) return;
  c.style.height = 'auto';
  c.style.height = Math.min(220, c.scrollHeight) + 'px';
}

// ------------------------------------------------------------------ wiring
export function initComposer() {
  const c = composerEl();
  if (!c) return;
  setComposerEnabled(false);
  bus.on('channel:open', () => { resetTyping(); setComposerEnabled(true); });
  bus.on('dm:open', () => { resetTyping(); setComposerEnabled(true); });

  // The channel box goes through the same binder as every other composer, so
  // there is one implementation of the picker rather than this one and a copy.
  bindAutocomplete(c, $('acPop'));

  c.addEventListener('keydown', (e) => {
    // The picker runs in the capture phase and calls preventDefault when it
    // consumes a key, so Enter completing "@ash" must not also send "@ash".
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && store.replyTarget) { clearReply(); return; }
    if (e.key === 'ArrowUp' && !c.value) {
      // Slack muscle memory: up-arrow on an empty composer edits your last message.
      const mine = [...document.querySelectorAll('.msg.me')].pop();
      if (mine?.dataset.id) { e.preventDefault(); bus.emit('message:editLast', { id: mine.dataset.id }); }
    }
  });

  // updateAutocomplete and the blur-hide are bindAutocomplete's job now.
  c.addEventListener('input', () => { autogrow(); emitTyping(); saveDraft(); });
  c.addEventListener('blur', () => { stopTyping(); });
  // A tab going away mid-sentence would otherwise leave "Asha is typing…" on
  // everyone else's screen until it expired, which is the state that makes a
  // typing indicator feel like a lie.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopTyping();
  });
  c.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  $('emojiBtn').onclick = () => openEmojiPicker($('emojiBtn'), (ch) => {
    const cc = composerEl();
    const pos = cc.selectionStart;
    cc.value = cc.value.slice(0, pos) + ch + ' ' + cc.value.slice(pos);
    cc.focus();
    cc.setSelectionRange(pos + ch.length + 1, pos + ch.length + 1);
    autogrow();
  });
  $('sendBtn').onclick = () => send();


  // drag and drop anywhere
  let dragCount = 0;
  const hint = $('dropHint');
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragCount++; hint.classList.remove('hidden'); }
  });
  window.addEventListener('dragleave', () => { if (--dragCount <= 0) { dragCount = 0; hint.classList.add('hidden'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCount = 0;
    hint.classList.add('hidden');
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  renderComposerButtons();
}

export const composerText = () => composerEl().value;
export function setComposerText(t) { composerEl().value = t; autogrow(); composerEl().focus(); }
