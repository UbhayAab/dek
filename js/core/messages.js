// Message rendering: grouping, day dividers, the hover action bar, reactions,
// quotes and attachments. Everything that draws a message lives here so threads,
// DMs, search results and pins all look identical.
import { sb } from '../sb.js';
import { api } from '../api.js';
import { store, bus, nameOf, profileOf, roleTagOf, adminKindOf } from '../store.js';
import { $, el, esc, fmt, timeOf, dayOf, plain, hueOf, initials } from '../util.js';
import { QUICK_EMOJI } from '../config.js';
import { getMessageActions, toast, contextMenu } from '../ui.js';
import { attsHtml, hydrateMedia, mediaUrls } from './media.js';
import * as pagecache from '../lib/pagecache.js';
import { openEmojiPicker, customEmojiKeys, hydrateCustomEmoji } from './emoji.js';

// The one fallback, used by both ways a face can fail, because it was written
// twice below and the two copies had to agree.
//
// nameOf, not display_name: a nickname has to reach the INITIALS too, or the
// letters on the circle disagree with the name beside it. Carry the SIZE and
// the colour across - the replacement used to be a bare `avatar` div with
// neither, so a face that failed to load did not fall back to initials, it
// fell back to a zero-sized transparent box and the row it sat in collapsed.
function avatarFallback(img) {
  if (!img.isConnected) return;
  const name = nameOf(img.dataset.user) || '?';
  const box = el('div', 'avatar', esc(initials(name)));
  box.style.cssText = img.style.cssText;
  box.style.background = `hsl(${hueOf(img.dataset.user || name)} 45% 32%)`;
  box.title = name;
  if (img.dataset.user) box.dataset.user = img.dataset.user;
  img.replaceWith(box);
}

// Second paint phase for faces: avatarHtml emits <img class="avatar-img"> with
// the storage key but no src. Fill it from the same signed-URL cache the
// attachment viewer uses (mediaUrls dedupes by key, so fifty rows sharing one
// face cost one mint). A dead key degrades back to coloured initials instead
// of a broken image.
export async function hydrateAvatars(root) {
  // Any img carrying a storage key: avatars, Space logos in the rail, future
  // surfaces. One hydration contract for all of them.
  const imgs = [...root.querySelectorAll('img[data-akey]:not([data-ha])')];
  if (!imgs.length) return;

  // ONE mint for the whole sweep, not one per face.
  //
  // This loop used to `await mediaUrl(key)` per image, so twenty faces on
  // screen were twenty serial POSTs to mint-download, each a full round trip
  // after the last - and a member panel paints fifty. mediaUrls() has taken a
  // batch since it was written and only hydrateMedia (attachments) ever called
  // it. The signed URLs expire in about four minutes, so this is not a
  // once-per-session cost: it recurs every time a sweep finds aged-out keys.
  //
  // Marked BEFORE the await, so a second sweep triggered by the MutationObserver
  // while this one is in flight cannot mint the same keys again.
  imgs.forEach((img) => { img.dataset.ha = '1'; });
  const keys = [...new Set(imgs.map((i) => i.dataset.akey).filter(Boolean))];
  let byKey = new Map();
  try {
    const urls = await mediaUrls(keys);
    byKey = new Map(keys.map((k, i) => [k, urls[i]]));
  } catch { /* every face falls back to initials below, which is the right shape */ }

  for (const img of imgs) {
    const url = byKey.get(img.dataset.akey) || null;
    if (!url || !img.isConnected) {
      avatarFallback(img);
      continue;
    }
    // The same fall back to initials, for the OTHER way a face can fail. Until
    // now it only ran when the signed-URL mint failed; if the mint succeeded and
    // the image then would not load - an expired URL, a blocked request, a
    // storage object that is gone - nothing caught it and the row rendered the
    // browser's grey broken-image glyph forever. A face is the one thing in the
    // app that has a perfectly good fallback, so it should never be able to show
    // as broken.
    img.addEventListener('error', () => avatarFallback(img), { once: true });
    img.src = url;
  }
}

// Faces everywhere, not just message rows: panels render avatarHtml too (DM
// lists, member pickers, profile cards, forum bylines) and used to keep
// initials until their own repaint. One observer sweeps the document after any
// DOM burst; the [data-ha] guard makes re-sweeps free, so fills triggered by
// this very sweep never recurse.
let sweepInstalled = false;
export function initAvatarSweep() {
  if (sweepInstalled || typeof MutationObserver === 'undefined') return;
  sweepInstalled = true;
  let queued = false;
  const sweep = () => {
    queued = false;
    hydrateAvatars(document).catch(() => {});
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(sweep, 50);
  }).observe(document.body, { childList: true, subtree: true });
  hydrateAvatars(document).catch(() => {});
}
import { icon } from '../icons.js';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const GROUP_WINDOW_NARROW_MS = 10 * 60 * 1000;
// Mirrors css/messages.css section 14's `@container dek (max-width: 440px)`
// block: a container query cannot reach JS, so a ResizeObserver on #app keeps
// this flag on the same box the CSS measures. The observer fires once on
// observe(), seeding the flag before the first channel renders. Keep the 440s
// in sync.
let appNarrow = false;
export function initNarrowWatcher() {
  const app = document.getElementById('app');
  if (!app || typeof ResizeObserver === 'undefined') return;
  new ResizeObserver((entries) => {
    for (const e of entries) appNarrow = e.contentRect.width <= 440;
  }).observe(app);
}

// A message row paints its author's name ONCE, from whatever store.profiles held
// at that instant, and nothing ever told it to look again. So any profile that
// arrives after the row does leaves the row saying "someone" - not for a frame,
// but permanently, until something unrelated re-renders it.
//
// Found by probe-apps failing two runs in three on the cold-load leg while the
// realtime leg always passed: on a cold load the rows and the member list are
// two different arrivals racing, and on a realtime delivery the members are
// long since in. It is not an app-specific bug. Anybody whose profile lands late
// hits it - somebody who joined while you were offline, an author of a healed
// message, a member list still in flight when the first page paints.
//
// The repair is narrow on purpose: only what the arriving profile can change,
// and only where it actually differs from what is on screen.
//
// Each fact is checked on its own. Gating the pills on the NAME having changed
// was wrong the moment a second pill existed: on a cold start pagecache paints
// the previous conversation before the bootstrap lands, so a row can already
// carry the correct name while the badge map behind it is still empty - and the
// name-first early return meant that row kept no Admin pill for the rest of the
// session.
export function repaintAuthors(root) {
  const host = root || $('messages');
  if (!host) return 0;
  let fixed = 0;
  let renamed = 0;
  for (const who of host.querySelectorAll('.who[data-user]')) {
    const id = who.dataset.user;
    if (!id) continue;
    const head = who.parentElement;
    if (!head) continue;

    const want = nameOf(id);
    if (who.textContent !== want) { who.textContent = want; renamed++; fixed++; }

    // Both pills are decided by the same late-arriving profile, so they are
    // wrong on exactly the rows this pass exists to fix. Order matters: APP sits
    // directly after the name and the role pill after that, which is the order
    // buildMessage emits them in.
    const isApp = !!profileOf(id)?.is_app;
    const appPill = head.querySelector('.pill-bot');
    if (isApp && !appPill) {
      who.insertAdjacentElement('afterend', el('span', 'pill pill-bot', 'APP'));
      fixed++;
    } else if (!isApp && appPill) { appPill.remove(); fixed++; }

    const tag = roleTagOf(id);
    const rolePill = head.querySelector('.pill-role');
    if (tag && rolePill?.textContent !== tag) {
      rolePill?.remove();
      const span = el('span', 'pill pill-role', esc(tag));
      span.title = tag + ' of this Space';
      (head.querySelector('.pill-bot') || who).insertAdjacentElement('afterend', span);
      fixed++;
    } else if (!tag && rolePill) { rolePill.remove(); fixed++; }
  }
  // The face comes from the same profile row as the name, so only a RENAME can
  // have invalidated it - a badge arriving does not change anybody's avatar, and
  // re-minting signed URLs for every row on screen because a pill appeared is
  // exactly the kind of cost this file is careful about elsewhere.
  if (renamed) hydrateAvatars(host);
  return fixed;
}

export function avatarHtml(userId, size = 36) {
  const p = profileOf(userId);
  const name = nameOf(userId) || '?';
  const h = hueOf(userId || name);
  // A stored face beats initials. The image paints as a placeholder with its
  // storage key and hydrateAvatars fills the signed URL on the same second pass
  // that fills attachments and custom emoji - one paint, no per-row awaits.
  if (p?.avatar_key) {
    return `<img class="avatar avatar-img" style="width:${size}px;height:${size}px"
      data-akey="${esc(p.avatar_key)}" data-user="${esc(userId || '')}" alt="${esc(name)}" />`;
  }
  return `<div class="avatar" style="width:${size}px;height:${size}px;background:hsl(${h} 45% 32%)"
    title="${esc(name)}" data-user="${esc(userId || '')}">${esc(initials(name))}</div>`;
}

// The Owner / Admin / Moderator pill, as markup, in the one place every surface
// can reach. Six things draw a name - a message header, the Members panel, the
// profile card, the profile page, the DM list and the mention menu - and a
// badge that only some of them know how to draw is the state this started in.
export function roleTagHtml(userId) {
  const tag = roleTagOf(userId);
  return tag ? `<span class="pill pill-role" title="${esc(tag)} of this Space">${esc(tag)}</span>` : '';
}

function mentionsMe(m) {
  if (Array.isArray(m.mention_user_ids) && m.mention_user_ids.includes(store.me)) return true;
  return m.mention_scope === 'here' || m.mention_scope === 'channel';
}

function fmtOpts() {
  const meNames = new Set();
  const p = store.myProfile;
  if (p?.username) meNames.add(p.username.toLowerCase());
  if (p?.display_name) meNames.add(p.display_name.toLowerCase());
  // The full roster as lowercase tokens so fmt() can match mentions containing
  // spaces ("@Asha Kumar") instead of cutting them at the first word.
  const nameSet = new Set();
  for (const q of store.profiles.values()) {
    if (q.username) nameSet.add(q.username.toLowerCase());
    if (q.display_name) nameSet.add(q.display_name.toLowerCase());
  }
  return { channels: store.channels, meNames, nameSet, emojiKeys: customEmojiKeys() };
}

// Build one message row. `opts.context` is 'channel' | 'thread' | 'dm' | 'static'
// and decides which actions are offered.
export function buildMessage(m, opts = {}) {
  const context = opts.context || 'channel';
  const mine = m.author_id === store.me;
  const row = el('div', 'msg');
  row.dataset.id = m.id || '';
  row.dataset.seq = m.seq ?? '';
  row.dataset.author = m.author_id || '';
  if (m.id) row.id = 'm' + m.id;
  if (mine) row.classList.add('me');
  if (mentionsMe(m)) row.classList.add('mention');
  if (m.priority === 'urgent') row.classList.add('urgent');
  if (opts.grouped) row.classList.add('grouped');
  // A row can now be built from a cache or from the trimmed window, so the
  // deleted state has to be a property of the message rather than something only
  // applyDelete() knows how to paint.
  const gone = !!m.deleted_at;
  if (gone) row.classList.add('deleted');

  const th = m.id ? store.rootThreads.get(m.id) : null;
  const who = nameOf(m.author_id);
  // An app is a profile with is_app, not a column on the message. The old test
  // read m.bot_id and m.webhook_id, neither of which is a column on messages,
  // so it was permanently false and the APP pill had never once been painted.
  const isBot = !!profileOf(m.author_id)?.is_app;

  row.innerHTML = `
    ${opts.grouped ? `<div class="gutter"><span class="ghost-time">${timeOf(m.created_at)}</span></div>`
      : `<div class="gutter">${avatarHtml(m.author_id)}</div>`}
    <div class="mbody">
      ${opts.grouped ? '' : `<div class="mhead">
        <span class="who" data-user="${esc(m.author_id || '')}">${esc(who)}</span>
        ${isBot ? '<span class="pill pill-bot">APP</span>' : ''}
        ${roleTagHtml(m.author_id)}
        ${m.priority === 'urgent' ? '<span class="pill pill-urgent">URGENT</span>' : ''}
        ${m.topic ? `<span class="pill pill-topic" data-topic="${esc(m.topic)}">${esc(m.topic)}</span>` : ''}
        <span class="t">${timeOf(m.created_at)}</span>
      </div>`}
      ${m.reply_to_id ? `<div class="quote" data-q="${esc(m.reply_to_id)}">↩ …</div>` : ''}
      ${m.also_send_to_channel && m.thread_id
        ? '<div class="thread-origin">↳ also sent to the channel from a thread</div>' : ''}
      <div class="body">${gone ? '<span class="muted">message deleted</span>'
        : fmt(m.body_text, fmtOpts()) + (m.edited_at ? ' <span class="edited">(edited)</span>' : '')}</div>
      ${gone ? '' : attsHtml(m)}
      <div class="rxns" data-rx="${esc(m.id || '')}"></div>
      <div class="threadind" data-th="${esc(m.id || '')}" style="${th ? '' : 'display:none'}"></div>
    </div>
    <div class="actions"></div>`;

  // ---- hover action bar: quick reactions + registered actions ----
  if (context !== 'static' && m.id && !gone) {
    const bar = row.querySelector('.actions');
    for (const e of QUICK_EMOJI) {
      const b = el('button', 'icon quick', e);
      b.title = 'React ' + e;
      b.onclick = () => toggleReaction(m.id, e);
      bar.appendChild(b);
    }
    const more = el('button', 'icon', icon('smile'));
    more.title = 'Pick a reaction';
    more.onclick = () => openEmojiPicker(more, (ch) => toggleReaction(m.id, ch));
    bar.appendChild(more);

    for (const a of getMessageActions({ ...m, _context: context })) {
      if (a.contexts && !a.contexts.includes(context)) continue;
      const b = el('button', 'icon', a.label);
      b.title = a.title || a.label;
      b.onclick = (ev) => a.onClick(m, ev, row);
      bar.appendChild(b);
    }
    row.oncontextmenu = (ev) => {
      if (ev.target.closest('a,img,video,input,textarea')) return;
      ev.preventDefault();
      contextMenu(ev, getMessageActions({ ...m, _context: context })
        .filter((a) => !a.contexts || a.contexts.includes(context))
        .map((a) => ({ label: `${a.label}  ${a.title || ''}`.trim(), danger: a.danger, onClick: () => a.onClick(m, ev, row) })));
    };
  }

  // ---- thread indicator ----
  const ti = row.querySelector('[data-th]');
  if (ti) {
    if (th) paintThreadIndicator(ti, th);
    ti.onclick = () => bus.emit('thread:request', { message: m });
  }

  if (Array.isArray(m.attachments) && m.attachments.length) hydrateMedia(row);
  hydrateCustomEmoji(row).catch(() => {});
  hydrateAvatars(row).catch(() => {});
  if (m.reply_to_id) fillQuote(row, m.reply_to_id);
  if (m.id) {
    store.msgCache.set(m.id, m);
    paintReactions(m.id);
  }

  row.querySelectorAll('[data-user]').forEach((n) => {
    n.onclick = (ev) => { ev.stopPropagation(); bus.emit('profile:open', { userId: n.dataset.user, anchor: n }); };
  });
  row.querySelectorAll('.chanlink').forEach((n) => {
    n.onclick = () => bus.emit('channel:request', { channelId: n.dataset.chan });
  });

  bus.emit('message:render', { msg: m, el: row, context });
  return row;
}

// OWNER / ADMIN only, for a surface that deliberately does not want to call a
// moderator anything. Everything else uses roleTagHtml above; both read the one
// badge map, so the two can never disagree about who runs the Space.
export function adminPillHtml(userId) {
  const kind = adminKindOf(userId);
  if (!kind) return '';
  return `<span class="pill pill-role" data-adm="${kind}">${kind === 'owner' ? 'OWNER' : 'ADMIN'}</span>`;
}

// A badge refresh is a name refresh: repaintAuthors below reconciles the pill on
// every row already on screen, and it is the only thing that should, or two
// passes fight over the same element.
bus.on('badges', () => repaintAuthors());

function paintThreadIndicator(node, th) {
  node.style.display = '';
  const n = th.count || 0;
  node.innerHTML = `<span class="th-dot"></span>${n} ${n === 1 ? 'reply' : 'replies'}
    ${th.last_message_at ? `<span class="muted"> · ${timeOf(th.last_message_at)}</span>` : ''}
    <span class="th-open">View thread</span>`;
}

export function refreshThreadIndicator(rootMessageId) {
  const t = store.rootThreads.get(rootMessageId);
  const node = document.querySelector(`[data-th="${CSS.escape(rootMessageId)}"]`);
  if (node && t) paintThreadIndicator(node, t);
}

async function fillQuote(row, replyToId) {
  const node = row.querySelector(`[data-q="${CSS.escape(replyToId)}"]`);
  if (!node) return;
  let ref = store.msgCache.get(replyToId);
  if (!ref) {
    const { data } = await sb.from('messages')
      .select('id,author_id,body_text,attachments').eq('id', replyToId).maybeSingle();
    if (data) { ref = data; store.msgCache.set(replyToId, data); }
  }
  if (!ref) { node.innerHTML = '↩ <span class="muted">original message unavailable</span>'; return; }
  const hasAtt = Array.isArray(ref.attachments) && ref.attachments.length;
  node.innerHTML = `↩ ${avatarHtml(ref.author_id, 16)} <b>${esc(nameOf(ref.author_id))}</b>
    <span>${esc(plain(ref.body_text, 90)) || (hasAtt ? '[attachment]' : '')}</span>`;
  node.onclick = () => jumpTo(replyToId);
}

export function jumpTo(messageId) {
  const node = document.getElementById('m' + messageId);
  if (!node) { bus.emit('message:jump', { messageId }); return; }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
}

// Is this reader parked on the newest message, or reading further up?
//
// The one question the whole "do not yank me to the bottom" contract turns on,
// and it was answered in four different places with four different thresholds:
// 140px in channels.js nearBottom(), 220px in features/offline.js, 60px in
// wireScroll, and NOT AT ALL in dms.js and threads.js, which is why those two
// scrolled unconditionally. One answer, used by all of them.
//
// The slop scales with the viewport as well as being capped. A fixed 140px is
// most of a short list: with the orientation banner squeezing #messages to 188px
// on a 1366x768 laptop at 125% scaling, a reader could not get more than 48px
// from the bottom without the list ending, so they were permanently "at the
// bottom" and every arrival dragged them down. That banner is fixed, but the
// threshold must not depend on it having been.
export function atBottom(el, slop = 140) {
  if (!el) return true;
  const room = Math.min(slop, Math.max(48, el.clientHeight * 0.25));
  return el.scrollHeight - el.scrollTop - el.clientHeight < room;
}

// Pin to the bottom, and STAY pinned while the list is still settling.
//
// One assignment is not enough. Rows keep growing for a few hundred milliseconds
// after they are attached - the web font swaps in and every line reflows, an
// avatar paints, a quoted message resolves - and each of those makes the list
// taller without moving scrollTop, so the newest message drifts below the fold.
// Measured on a 120-row rebuild: 576px short, about eight messages, after two
// frames.
//
// The correction is only applied while scrollTop is exactly where we left it. If
// the person has touched the list at all, they own it and we do not fight them.
//
// `host` defaults to the channel list, because that is what every existing
// caller means. The thread panel and the DM view are their own scroll
// containers and pass themselves in.
export function scrollDown(host) {
  const m = host || $('messages');
  if (!m) return;
  // A `scroll-behavior: smooth` anywhere in the cascade turns each assignment
  // below into an animation whose read-back is the pre-animation value, which
  // makes the correction ladder stand down on its first tick. layout.css no
  // longer sets it on #messages; this makes the ladder immune to it coming back,
  // or to a third-party container that has it.
  const prev = m.style.scrollBehavior;
  m.style.scrollBehavior = 'auto';
  m.scrollTop = m.scrollHeight;
  let mine = m.scrollTop;
  const fix = () => {
    if (!m.isConnected || Math.abs(m.scrollTop - mine) > 2) {
      m.style.scrollBehavior = prev;
      return;
    }
    m.style.scrollBehavior = 'auto';
    m.scrollTop = m.scrollHeight;
    mine = m.scrollTop;
    m.style.scrollBehavior = prev;
  };
  m.style.scrollBehavior = prev;
  requestAnimationFrame(fix);
  // The ladder runs past the point where the last thing that can change a row's
  // height has landed: the web font swapping in, an avatar decoding, an image
  // getting its intrinsic size. Each tick gives up the moment the person has
  // scrolled themselves, so this can only ever finish a job it started.
  // Measured: at 280ms a 120-row rebuild still ended up to 576px short.
  for (const t of [90, 280, 600, 1200]) setTimeout(fix, t);
}

// ------------------------------------------------------------------ list append
// Where does this message belong? Returns the node it must be inserted BEFORE,
// or null for "at the end", which is the overwhelmingly common case.
//
// A blind appendChild was fine while the only way a message reached the list was
// in arrival order. It stops being fine the moment a gap is healed: the repaired
// older message would render BELOW newer ones and stay there until a reload,
// which reads worse to a person than the message being missing. Ordering is the
// entire point of having a gapless seq, so honour it here.
//
// Rows without a seq are the optimistic ones the sender is still waiting on.
// They sit at the bottom by definition, so they act as a floor: anything
// arriving goes after them, never above.
function orderedSlot(host, m) {
  const seq = +(m.seq || 0);
  if (!seq) return null;
  const rows = host.querySelectorAll(':scope > .msg');
  for (let i = rows.length - 1; i >= 0; i--) {
    const s = +(rows[i].dataset.seq || 0);
    if (!s || s <= seq) return rows[i].nextElementSibling || null;
  }
  return host.firstElementChild || null;
}

// Out-of-order insert: always a full (ungrouped) row, because the neighbours it
// lands between were grouped against each other.
function insertOrdered(host, m, context, before) {
  const t = new Date(m.created_at || Date.now()).getTime();
  const day = dayOf(m.created_at || Date.now());
  const row = buildMessage(m, { context, grouped: false });
  row.dataset.time = t;
  row.dataset.day = day;

  const prev = before.previousElementSibling;
  if (!prev || (prev.dataset.day && prev.dataset.day !== day)) {
    const d = el('div', 'daydiv', `<span>${esc(day)}</span>`);
    d.dataset.day = day;
    host.insertBefore(d, before);
  }
  host.insertBefore(row, before);

  // The row below was grouped against whatever used to be above it. If that is
  // no longer the same author, rebuild it so it grows its avatar back.
  if (before.classList?.contains('grouped') && before.dataset.author !== m.author_id) {
    const cached = store.msgCache.get(before.dataset.id);
    if (cached) appendMessage(host, cached, context, { replacing: before });
  }
  return row;
}

// Appends into `host`, deciding grouping and day dividers from the previous row.
// `opts.replacing` swaps an existing row (the optimistic one) for a freshly
// built row. Grouping is decided from the neighbour ABOVE that row rather than
// from the end of the list, and the new node is inserted before the old one is
// removed, so there is never an instant where the message is missing from the
// DOM - a remove-then-append leaves a gap that anything holding a reference
// (a hover, a scroll, a test) trips over.
export function appendMessage(host, m, context = 'channel', opts = {}) {
  const anchor = opts.replacing || null;
  if (!anchor && !opts.bulk) {
    const before = orderedSlot(host, m);
    if (before) return insertOrdered(host, m, context, before);
  }
  const last = anchor ? anchor.previousElementSibling : host.lastElementChild;
  const lastAuthor = last?.dataset?.author;
  const lastTime = last?.dataset?.time ? +last.dataset.time : 0;
  const t = new Date(m.created_at || Date.now()).getTime();

  const lastDay = last?.dataset?.day;
  const day = dayOf(m.created_at || Date.now());
  if (day !== lastDay && !anchor) {
    const d = el('div', 'daydiv', `<span>${esc(day)}</span>`);
    d.dataset.day = day;
    host.appendChild(d);
  }

  const grouped = !!last && last.classList.contains('msg') &&
    lastAuthor === m.author_id &&
    t - lastTime < (appNarrow ? GROUP_WINDOW_NARROW_MS : GROUP_WINDOW_MS) &&
    !m.reply_to_id && day === lastDay;

  const row = buildMessage(m, { context, grouped });
  row.dataset.time = t;
  row.dataset.day = day;
  if (anchor) {
    anchor.parentNode.insertBefore(row, anchor);
    anchor.remove();
  } else {
    host.appendChild(row);
  }
  return row;
}

// ------------------------------------------------------------------ render window
// Measured on this app, 4x CPU, real render path: 200 messages in the list
// scroll at a flat 60fps, 1000 messages produce a p95 frame of 3.7 SECONDS, and
// 5000 messages take 121s to build, hold 256,654 DOM nodes and scroll at a p50
// frame of 133ms. The list is not virtualised and does not need to be - it needs
// a ceiling. A channel that has been open all day, or paged up through a year of
// history, is the same list.
//
// So the DOM holds a window. Rows that fall out of it are remembered by id -
// their data is already in store.msgCache, which is not the expensive part - and
// re-rendered when the scroll comes back for them. Nothing is refetched.
//
// This is deliberately NOT virtual scrolling: no fixed row heights, no absolute
// positioning, no scroll maths, no fighting the browser's anchoring. The list
// stays an ordinary block of elements, and there are simply never more than
// MAX_RENDERED of them.
export const MAX_RENDERED = 320;
// 24, not a full page: bringing rows back is synchronous, and at 9ms a row a
// chunk of 60 is a 540ms hitch at the exact moment the person is dragging the
// list. Measured p95 frame while scrolling a trimmed list: 900ms at 60, 340ms
// at 24. Small chunks, more often, is the right trade for a scroll.
const RESTORE_CHUNK = 24;      // how many come back per scroll into the edge
const KEEP_ON_JUMP = 120;      // how many stay when jumping to the newest

let trimmedAbove = [];         // ids trimmed off the TOP, ascending
let trimmedBelow = [];         // ids trimmed off the BOTTOM, ascending

export function resetWindow() { trimmedAbove = []; trimmedBelow = []; }
export const windowState = () => ({ above: trimmedAbove.length, below: trimmedBelow.length });

// A live message that arrives while the reader is paged up must not be appended
// under rows that are older than it. It is recorded instead, and comes back with
// the rest of the tail when they scroll down or press "New messages".
export function deferBelow(m) {
  if (!m?.id) return;
  store.msgCache.set(m.id, m);
  if (!trimmedBelow.includes(m.id)) trimmedBelow.push(m.id);
}

function stripLeadingDividers(host) {
  while (host.firstElementChild && host.firstElementChild.classList.contains('daydiv')) {
    host.firstElementChild.remove();
  }
}

// After appending at the bottom: drop rows off the top.
export function capWindow(host, max = MAX_RENDERED) {
  if (!host) return;
  let rows = host.querySelectorAll('.msg');
  if (rows.length <= max) return;
  let drop = rows.length - max;
  for (const row of rows) {
    if (drop-- <= 0) break;
    if (row.dataset.id) trimmedAbove.push(row.dataset.id);
    row.remove();
  }
  stripLeadingDividers(host);
}

// After prepending at the top: drop rows off the bottom.
export function capWindowTop(host, max = MAX_RENDERED) {
  if (!host) return;
  const rows = [...host.querySelectorAll('.msg')];
  if (rows.length <= max) return;
  const doomed = rows.slice(max);
  for (let i = doomed.length - 1; i >= 0; i--) {
    if (doomed[i].dataset.id) trimmedBelow.unshift(doomed[i].dataset.id);
    doomed[i].remove();
  }
}

// Build many rows off-document and attach them in one go. One layout instead of
// fifty, which is most of the difference between a channel that opens and a
// channel that unrolls.
export function renderBatch(host, msgs, context = 'channel') {
  if (!host || !msgs.length) return 0;
  const holder = document.createElement('div');
  let n = 0;
  // bulk: these rows are already in seq order, so the ordered-insert scan would
  // be a linear search per row for an answer it always knows - O(n^2) on a page.
  for (const m of msgs) { appendMessage(holder, m, context, { bulk: true }); n++; }
  const frag = document.createDocumentFragment();
  while (holder.firstChild) frag.appendChild(holder.firstChild);
  host.appendChild(frag);
  return n;
}

// Insert a batch ABOVE what is already there, preserving the scroll position and
// repairing the seam. Without the repair the row that used to be first keeps the
// full avatar+name header it needed when it was first, and may be missing the
// day divider that now belongs above it.
export function prependBatch(host, msgs, context = 'channel') {
  if (!host || !msgs.length) return 0;
  const prevH = host.scrollHeight;
  const prevTop = host.scrollTop;
  const seam = host.querySelector('.msg');
  const holder = document.createElement('div');
  for (const m of msgs) appendMessage(holder, m, context, { bulk: true });
  const frag = document.createDocumentFragment();
  while (holder.firstChild) frag.appendChild(holder.firstChild);
  host.insertBefore(frag, host.firstChild);
  if (seam) stitch(host, seam, context);
  host.scrollTop = prevTop + (host.scrollHeight - prevH);
  return msgs.length;
}

// Rebuild one row so its grouping and day divider agree with the row now above
// it. Cheap: one row, from the cache, no network.
function stitch(host, row, context) {
  const m = store.msgCache.get(row.dataset.id);
  if (!m) return;
  const prev = row.previousElementSibling;
  if (!prev || !prev.classList.contains('msg')) return;
  const day = dayOf(m.created_at || Date.now());
  if (prev.dataset.day !== day) {
    const d = el('div', 'daydiv', `<span>${esc(day)}</span>`);
    d.dataset.day = day;
    host.insertBefore(d, row);
    return;                      // a divider between them means never grouped
  }
  appendMessage(host, m, context, { replacing: row });
}

function rowsFor(ids) {
  const out = [];
  for (const id of ids) { const m = store.msgCache.get(id); if (m) out.push(m); }
  return out;
}

// Scrolled to the top edge with trimmed history behind it: bring a chunk back.
// Returns false when there is nothing left, which is the signal to page the
// server instead.
export function restoreAbove(host, n = RESTORE_CHUNK) {
  if (!trimmedAbove.length) return false;
  const take = trimmedAbove.slice(-n);
  trimmedAbove = trimmedAbove.slice(0, trimmedAbove.length - take.length);
  prependBatch(host, rowsFor(take));
  capWindowTop(host);
  return true;
}

export function restoreBelow(host, n = RESTORE_CHUNK) {
  if (!trimmedBelow.length) return false;
  const take = trimmedBelow.slice(0, n);
  trimmedBelow = trimmedBelow.slice(take.length);
  renderBatch(host, rowsFor(take));
  capWindow(host);
  return true;
}

// "New messages" / scroll-to-latest when a lot has been trimmed: rebuilding the
// tail is bounded work, walking back to it one chunk at a time is not.
export function jumpLatest(host, context = 'channel') {
  if (!trimmedBelow.length) { scrollDown(); return; }
  const domIds = [...host.querySelectorAll('.msg')].map((r) => r.dataset.id).filter(Boolean);
  const all = [...trimmedAbove, ...domIds, ...trimmedBelow];
  const keep = all.slice(-KEEP_ON_JUMP);
  trimmedAbove = all.slice(0, all.length - keep.length);
  trimmedBelow = [];
  host.innerHTML = '';
  renderBatch(host, rowsFor(keep), context);
  scrollDown();
  // Rows whose height is not final until the next layout (avatars, attachments,
  // a wrapped line) leave the first scroll short. One more frame settles it.
  requestAnimationFrame(() => scrollDown());
}

// Promote an optimistic row to a real one WITHOUT replacing the node.
//
// The optimistic row is rendered against a temporary id (the send nonce), so its
// reaction target, thread target and action handlers all point at something the
// server has never heard of. Swapping in a freshly built row fixes that but
// destroys and recreates the element, and anything holding a reference to it -
// a hover, a scroll anchor, a pointer already pressed - is left pointing at a
// detached node. Rebinding in place keeps one stable element for the lifetime of
// the message.
export function upgradeMessageRow(row, m, context = 'channel') {
  if (!row || !m?.id) return row;
  // The nonce this row carried while the send was in flight. Features stamp
  // their per-message UI with it at render time, so they need to know when it
  // stops being true - see the emit at the bottom.
  const from = row.dataset.id !== m.id ? row.dataset.id : null;
  row.id = 'm' + m.id;
  row.dataset.id = m.id;
  row.dataset.seq = m.seq ?? '';
  row.classList.remove('pending');

  row.querySelector('[data-rx]')?.setAttribute('data-rx', m.id);
  row.querySelector('[data-th]')?.setAttribute('data-th', m.id);

  const bar = row.querySelector('.actions');
  if (bar && context !== 'static') {
    bar.innerHTML = '';
    for (const e of QUICK_EMOJI) {
      const b = el('button', 'icon quick', e);
      b.title = 'React ' + e;
      b.onclick = () => toggleReaction(m.id, e);
      bar.appendChild(b);
    }
    const more = el('button', 'icon', icon('smile'));
    more.title = 'Pick a reaction';
    more.onclick = () => openEmojiPicker(more, (ch) => toggleReaction(m.id, ch));
    bar.appendChild(more);
    for (const a of getMessageActions({ ...m, _context: context })) {
      if (a.contexts && !a.contexts.includes(context)) continue;
      const b = el('button', 'icon', a.label);
      b.title = a.title || a.label;
      b.onclick = (ev) => a.onClick(m, ev, row);
      bar.appendChild(b);
    }
  }

  const ti = row.querySelector('[data-th]');
  if (ti) ti.onclick = () => bus.emit('thread:request', { message: m });

  store.msgCache.set(m.id, m);
  paintReactions(m.id);
  // The event the swap never used to have: anything that stamped the nonce at
  // render time (task chips, ack cards) re-stamps and repaints here, instead of
  // every feature re-reading row.dataset.id on every paint and hoping.
  if (from) bus.emit('message:idUpgraded', { from, id: m.id, row });
  return row;
}

// Is this message already on screen INSIDE this particular container?
//
// claimMessage() is a single global gate: one message, one render. That holds
// everywhere except a thread reply sent with "Also send to channel", which
// legitimately belongs in TWO places at once - the thread panel and the channel.
// With one shared gate whichever path ran first consumed the claim and the other
// silently rendered nothing. Containers arbitrate for themselves.
export function renderedIn(host, messageId) {
  if (!host || !messageId) return false;
  return !!host.querySelector(`[data-id="${CSS.escape(messageId)}"]`);
}

// Dedupe gate: returns false when this message was already rendered (by id or by
// the optimistic-send nonce).
export function claimMessage(m) {
  const nonce = m.client_msg_id;
  if (nonce && store.seen.has('n:' + nonce)) {
    const ex = document.getElementById('m' + nonce);
    // Second id-swap site: the realtime echo of my own send can arrive before
    // the send RPC resolves (upgradeMessageRow handles that one). Same duty to
    // tell features the nonce died.
    if (ex && m.id) {
      ex.id = 'm' + m.id; ex.dataset.id = m.id; ex.classList.remove('pending');
      bus.emit('message:idUpgraded', { from: nonce, id: m.id, row: ex });
    }
    if (m.id) { store.seen.add(m.id); store.msgCache.set(m.id, m); }
    return false;
  }
  if (m.id && store.seen.has(m.id)) return false;
  if (m.id) store.seen.add(m.id);
  if (nonce) store.seen.add('n:' + nonce);
  return true;
}

// ------------------------------------------------------------------ reactions
export function paintReactions(messageId) {
  const host = document.querySelector(`[data-rx="${CSS.escape(messageId)}"]`);
  if (!host) return;
  const em = store.rxn.get(messageId);
  if (!em || !em.size) { host.innerHTML = ''; return; }
  let h = '';
  for (const [emoji, users] of em) {
    if (!users.size) continue;
    const mine = users.has(store.me);
    const names = [...users].slice(0, 8).map(nameOf).join(', ');
    h += `<button class="rxn${mine ? ' mine' : ''}" data-e="${esc(emoji)}"
      title="${esc(names)}${users.size > 8 ? ' and more' : ''}">${esc(emoji)} <b>${users.size}</b></button>`;
  }
  h += '<button class="rxn rxn-add" data-add="1" title="Add reaction">＋</button>';
  host.innerHTML = h;
  host.querySelectorAll('.rxn[data-e]').forEach((b) => {
    b.onclick = () => toggleReaction(messageId, b.dataset.e);
  });
  const add = host.querySelector('[data-add]');
  if (add) add.onclick = () => openEmojiPicker(add, (ch) => toggleReaction(messageId, ch));
}

export function applyReaction({ message_id, emoji, user_id, added }) {
  if (!store.rxn.has(message_id)) store.rxn.set(message_id, new Map());
  const em = store.rxn.get(message_id);
  if (!em.has(emoji)) em.set(emoji, new Set());
  if (added) em.get(emoji).add(user_id);
  else { em.get(emoji).delete(user_id); if (!em.get(emoji).size) em.delete(emoji); }
  paintReactions(message_id);
}

// A DM row is a dm_messages row, and its reactions live in dm_message_reactions
// (0119). Both toggle_reaction and message_reactions resolve through
// public.messages, so for a DM the first raised 'forbidden' on a button this
// file had just offered, and the second silently read nothing. The row itself
// says which it is - dm_messages carries conversation_id, messages carries
// channel_id - and while a conversation is open, nothing else is on screen.
export function isDMMessage(messageId) {
  const m = messageId ? store.msgCache.get(messageId) : null;
  if (m?.conversation_id) return true;
  if (m?.channel_id) return false;
  return !!store.currentDM && !store.current;
}

function reactionError(e, dm) {
  const m = String(e?.message || '');
  // PGRST202: the DM half is not on this database yet (migration 0119).
  if (dm && (e?.code === 'PGRST202' || /could not find the function/i.test(m))) {
    return 'Reactions in direct messages are not switched on for this server yet.';
  }
  if (/rate_limited/i.test(m)) return 'Too many reactions at once - give it a moment.';
  if (/\bblocked\b/i.test(m)) return 'You cannot react in this conversation.';
  if (/forbidden|42501/i.test(m)) return 'You cannot react to that message.';
  return m || 'Reaction failed';
}

// Optimistic: paint immediately, persist after. The server broadcast reconciles
// everyone else, and the periodic refetch heals any missed broadcast.
export async function toggleReaction(messageId, emoji) {
  const em = store.rxn.get(messageId);
  const has = em?.get(emoji)?.has(store.me);
  const dm = isDMMessage(messageId);
  applyReaction({ message_id: messageId, emoji, user_id: store.me, added: !has });
  try {
    // One call for both kinds. public.toggle_reaction resolves which table the
    // id lives in (0120), so the client does not have to be right about it -
    // and isDMMessage is only used to word the failure, where being wrong costs
    // a sentence rather than a lost reaction.
    await api.react(messageId, emoji);
  } catch (e) {
    applyReaction({ message_id: messageId, emoji, user_id: store.me, added: !!has });
    toast(reactionError(e, dm), 'error');
  }
}

// `kind` is 'dm' or 'channel'. A DM message's reactions are in
// dm_message_reactions, not message_reactions: message_reactions.message_id is a
// foreign key onto public.messages and its channel_id is NOT NULL, so a DM
// reaction has never been able to live there. Reading one table for both would
// silently paint every DM as having no reactions.
//
// Omitting it asks isDMMessage, which reads the cached row's own shape. Callers
// that KNOW still say so - openDM does - because the sweep in presence.js heals
// whatever is on screen and an explicit answer from the surface beats a guess.
export async function loadReactions(ids, kind) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return;
  // Tolerates the {dm:true} shape a parallel branch used, so a caller written
  // against either signature lands in the right table.
  const fromDM = typeof kind === 'object' && kind !== null
    ? !!kind.dm
    : kind ? kind === 'dm' : isDMMessage(ids[0]);
  const { data } = await sb.from(fromDM ? 'dm_message_reactions' : 'message_reactions')
    .select('message_id,emoji,user_id').in('message_id', ids);
  const byMsg = new Map();
  for (const r of data || []) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, new Map());
    const em = byMsg.get(r.message_id);
    if (!em.has(r.emoji)) em.set(r.emoji, new Set());
    em.get(r.emoji).add(r.user_id);
  }
  for (const id of ids) {
    store.rxn.set(id, byMsg.get(id) || new Map());
    paintReactions(id);
  }
}

// ------------------------------------------------------------------ edit/delete
// Both of these also correct the cached page. A message that was edited or
// deleted while this phone had the channel cached must not come back in its old
// form on the next cold start - a stale page is a fine placeholder, a page that
// contradicts a deletion is not.
export function applyEdit(id, bodyText) {
  const cached = store.msgCache.get(id);
  if (cached) store.msgCache.set(id, { ...cached, body_text: bodyText, edited_at: new Date().toISOString() });
  pagecache.amend(store.me, store.current?.id, id, { body_text: bodyText, edited_at: new Date().toISOString() });
  const row = document.getElementById('m' + id);
  if (!row) return;                     // trimmed out of the window; the cache above has it
  row.querySelector('.body').innerHTML =
    fmt(bodyText, fmtOpts()) + ' <span class="edited">(edited)</span>';
}

export function applyDelete(id) {
  const cached = store.msgCache.get(id);
  if (cached) store.msgCache.set(id, { ...cached, deleted_at: new Date().toISOString(), body_text: '' });
  pagecache.amend(store.me, store.current?.id, id, { deleted_at: new Date().toISOString(), body_text: '' });
  const row = document.getElementById('m' + id);
  if (!row) return;
  row.classList.add('deleted');
  row.querySelector('.body').innerHTML = '<span class="muted">message deleted</span>';
  row.querySelector('.atts')?.remove();
  row.querySelector('.actions')?.remove();
}
