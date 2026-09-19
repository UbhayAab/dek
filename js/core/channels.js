// Channel list (categories, text, voice, DMs) and the open-channel lifecycle:
// load a page, subscribe to realtime, page upward on scroll, reconcile any
// broadcast the at-most-once transport dropped.
import { sb, subscribe, unsubscribe } from '../sb.js';
import { api, table } from '../api.js';
import { store, bus, nameOf, resetChannelState, hasPerm } from '../store.js';
import { PERM, MESSAGE_PAGE } from '../config.js';
import { $, el, esc, debounce, initials, hueOf } from '../util.js';
import { toast, contextMenu, formModal, confirmModal, typeToConfirm, renderNavSections, closePanel } from '../ui.js';
import { icon } from '../icons.js';
import { appendMessage, claimMessage, loadReactions, applyEdit, applyDelete, applyReaction,
  refreshThreadIndicator, jumpTo, buildMessage, scrollDown, renderedIn, atBottom,
  renderBatch, prependBatch, capWindow, capWindowTop, resetWindow, windowState,
  restoreAbove, restoreBelow, deferBelow, jumpLatest, repaintAuthors,
  roleTagHtml } from './messages.js';
import * as pagecache from '../lib/pagecache.js';

export { scrollDown };

let loadingOlder = false;

// ------------------------------------------------------------------ delivery state
// One channel open at a time, and every await inside openChannel() is a chance
// for the user to tap a different one. `openGen` is the token that says which
// open is still the real one: anything that resumes after a newer open started
// and finds its generation stale must drop what it was doing. Without it the
// SLOWER of two taps wins - it subscribes last and overwrites store.cursor -
// and the visible channel ends up joined to the wrong realtime topic with a
// cursor from the other channel, at which point neither the socket nor the
// resync can ever deliver a message into it again. Measured: 25s, nothing.
let openGen = 0;

// Is store.cursor a real position in the log yet, or just its zero value?
//
// This distinction is load-bearing and its absence was a hole in the gap check.
// The test used to be `if (store.cursor && seq > store.cursor + 1)`, and a
// channel nobody has posted in yet has a cursor of 0, which is falsy - so for
// exactly as long as a channel is empty, gap detection was switched off. Drop
// the broadcasts for seq 1 and 2, let seq 3 arrive, and the cursor jumped
// straight to 3; resume() was then asked for events after 3 and those two
// messages were gone for good. Measured on a fresh channel: 2 of 3 lost, never
// healed. That is the original bug, alive in the one window nobody looked at -
// and a brand new channel is precisely where the first burst of messages lands.
//
// The guard could not simply be removed, because subscribeChannel() runs BEFORE
// the cursor is known (a broadcast may arrive while the first page is still in
// flight) and every one of those would have looked like a gap back to zero. So
// the flag says which of the two situations a zero cursor is.
let cursorReady = false;

// Telegram waits up to half a second before treating a hole as a gap, because
// the transport is allowed to reorder. Ours can too.
const GAP_GRACE_MS = 300;
const RESUME_PAGE = 200;         // events per resume() call
const RESUME_MAX_PAGES = 5;      // past ~1000 events behind, re-bootstrap instead
const MARK_READ_MS = 1200;

// Messages that arrived ahead of their turn, held until the log fills the hole
// beneath them. Keyed by seq.
const gapBuffer = new Map();
const GAP_BUFFER_MAX = 300;

// Observable delivery counters. The app could previously not answer "did I miss
// anything", which is the only question that matters here.
export const delivery = {
  gaps: 0,          // holes detected in the incoming seq stream
  healed: 0,        // events replayed out of the log
  resyncs: 0,       // resume passes run
  resnapshots: 0,   // times the cursor was too far behind to resume
  buffered: 0,      // messages currently held waiting for a gap to fill
  lastReason: null,
  lastAt: 0,
};

// ------------------------------------------------------------------ nav render
export async function renderChannels() {
  const host = $('channels');
  if (!host || !store.ws) return;
  const um = store.unread;
  // get_bootstrap orders by (position, name) but the fallback read in
  // workspace.js orders by position alone, and every channel a Space is created
  // with shares position 1000 - so which of #general and #random came first
  // depended on which path loaded the list. Sort here and both paths agree.
  const byPos = (a, z) => (+a.position || 0) - (+z.position || 0)
    || String(a.name || '').localeCompare(String(z.name || ''));
  const live = store.channels.filter((c) => !c.archived_at).sort(byPos);
  const text = live.filter((c) => c.kind !== 'voice');
  const voice = live.filter((c) => c.kind === 'voice');

  const byCat = new Map();
  for (const c of text) {
    const k = c.category_id || '';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(c);
  }

  const chanRow = (c) => {
    const u = um.get(c.id);
    const unread = u?.unread > 0;
    const mc = u?.mention_count || 0;
    const muted = store.notify.get(c.id)?.notify_level === 'nothing';
    const mark = c.kind === 'announcement' ? icon('megaphone') : c.kind === 'forum' ? icon('doc') : c.is_private ? icon('lock') : '#';
    return `<div class="chan${store.current?.id === c.id ? ' active' : ''}${unread ? ' unread' : ''}${muted ? ' muted-ch' : ''}"
      data-ch="${c.id}"><span class="ch-ico">${mark}</span><span class="ch-name">${esc(c.name)}</span>
      ${mc ? `<span class="badge">${mc}</span>` : unread ? '<span class="dot-unread"></span>' : ''}</div>`;
  };

  let h = '';

  // ---- servers, when the rail is not on screen ----
  //
  // The rail is 44px of coloured tiles showing two letters each. On a phone that
  // is a column of initials nobody can read - "SS" is Safalta Setu and Sourabh's
  // avatar and a Space called Support - permanently occupying the left edge of a
  // 390px screen. Reported as: take it away, and let me pick the server from the
  // same place I pick the channel.
  //
  // Read what is actually on screen rather than a class somebody has to remember
  // to keep in sync, exactly as the DM section below does with the tab bar: the
  // rail is hidden purely by CSS, so its computed display IS the answer to
  // "does this device have a rail".
  const rail = document.getElementById('spaceRail');
  const hasRail = !!rail && getComputedStyle(rail).display !== 'none';
  if (!hasRail && (store.spaces || []).length) {
    const orgName = new Map((store.orgs || []).map((o) => [o.org_id, o.name]));
    const byOrg = new Map();
    for (const sp of store.spaces) {
      const k = sp.org_id || '';
      if (!byOrg.has(k)) byOrg.set(k, []);
      byOrg.get(k).push(sp);
    }
    const collapsed = localStorage.getItem('dak.cat.servers') === '0';
    h += `<h3 data-cat="servers"><span>${collapsed ? '▸' : '▾'} Servers</span></h3>
      <div class="navgroup" ${collapsed ? 'style="display:none"' : ''}>`;
    // One group per organisation, and its name above its servers - the same
    // shape the rail draws, in words instead of initials.
    const many = byOrg.size > 1;
    for (const [orgId, list] of byOrg) {
      // The organisation name, ALWAYS, and as a control rather than a caption.
      //
      // It used to be drawn only where somebody was in several organisations,
      // on the reasoning that with one there is nothing to tell apart. That held
      // while the rail was on screen, because the rail named the org in a tile
      // of its own. With the rail gone this heading is the only thing anywhere
      // on screen that says which organisation you are standing in, so it is
      // drawn for a single org too.
      //
      // It is also the only entry point left for everything orgMenu carries:
      // invite people, the server directory, manage organisation, leave,
      // delete, and cancelling a deletion that is already counting down. On the
      // rail those answered a right-click and a long-press, which the comment
      // on the rail tile itself admits is "a gesture a laptop user does not
      // think to try on a small tile and a phone user has never been told
      // about". Hiding the same six commands behind the same invisible gesture
      // here would repeat that mistake, so this is a plain left-click, with a
      // glyph and a title attribute that say a menu is behind it.
      //
      // Nothing is drawn for a group with no organisation: a Space whose
      // org_id is null has no name to print and no org for the menu to act on,
      // so that group stays bare exactly as it does today.
      if (orgId) {
        const oName = orgName.get(orgId) || 'Organisation';
        h += `<div class="nav-orglabel nav-orgmenu" data-orgmenu="${esc(orgId)}"
          role="button" tabindex="0" style="cursor:pointer"
          title="${esc(oName)}: invite people, servers in it, leave or delete"
          ><span class="nav-orgname">${esc(oName)}</span><span
          class="nav-orgmenu-mark" aria-hidden="true"> …</span></div>`;
      }
      for (const sp of list) {
        const b = store.spaceBadges.get(sp.id);
        const dead = !!(sp.archived_at || sp.scheduled_delete_at);
        const active = store.ws?.id === sp.id;
        h += `<div class="chan srv${active ? ' active' : ''}${dead ? ' srv-off' : ''}"
          data-space="${esc(sp.id)}" title="${esc(sp.name || '')}">
          <span class="ch-ico srv-ico" style="--h:${hueOf(sp.id)}">${esc(initials(sp.name || '?'))}</span>
          <span class="ch-name">${esc(sp.name || 'Server')}</span>
          ${b?.mention_total ? `<span class="badge">${b.mention_total}</span>`
            : b?.unread_total ? '<span class="dot-unread"></span>' : ''}</div>`;
      }
    }
    // ONE DOOR, AT THE END OF THE LIST OF WHAT YOU ALREADY HAVE.
    //
    // There used to be a "More in <organisation>" row per org, drawn only when
    // somebody belonged to more than one, opening a per-org modal. That is
    // three problems: a person in one organisation - which is most of them -
    // got no door at all, the modal showed one organisation at a time, and it
    // had no search. features/servers.js replaced it with a panel that lists
    // every server in every organisation at once, so one row at the bottom of
    // this group is the whole answer, and it is placed exactly where the list
    // of servers you are in runs out.
    h += `<div class="chan chan-add" data-findserver="1"
      title="Every server in your organisation, joined or not">Find a server</div>`;
    h += '</div>';
  }

  // Channels with no category used to render as a bare group above every
  // category heading, which is how a channel someone had just created appeared
  // to jump to the very top of the sidebar and out of the list: the create
  // dialog defaults to "No category", and this group is drawn before "General".
  // Both organisations reported it. The rows were never in the wrong ORDER - the
  // server hands them back last, by position - they were in an unlabelled group
  // that reads as being outside the list. It gets a heading, like Voice and
  // Direct messages already have.
  const uncat = byCat.get('') || [];
  if (uncat.length) {
    h += `<h3><span>Channels</span></h3><div class="navgroup">${uncat.map(chanRow).join('')}</div>`;
  }
  for (const cat of store.categories) {
    const list = byCat.get(cat.id) || [];
    if (!list.length) continue;
    const collapsed = localStorage.getItem('dak.cat.' + cat.id) === '0';
    h += `<h3 data-cat="${cat.id}"><span>${collapsed ? '▸' : '▾'} ${esc(cat.name)}</span></h3>
      <div class="navgroup" ${collapsed ? 'style="display:none"' : ''}>${list.map(chanRow).join('')}</div>`;
  }
  if (hasPerm(PERM.MANAGE_CHANNELS)) h += '<div class="chan chan-add" data-newch="1">＋ Add channel</div>';

  // The heading used to render only when a voice room already existed, so a
  // Space with none showed NOTHING about voice anywhere - no heading, no button,
  // no hint that rooms are a thing this app has. The only way to make the first
  // one was to guess that "Add channel" hides a Type dropdown with Voice in it.
  // That is why the owner asked for "the option to make multiple voice channels"
  // for a feature that had never had a limit.
  const mayAddVoice = hasPerm(PERM.MANAGE_CHANNELS);
  if (voice.length || mayAddVoice) {
    h += '<h3><span>Voice</span></h3><div class="navgroup">';
    for (const c of voice) {
      const parts = store.voiceParts.get(c.id) || [];
      h += `<div class="chan vchan" data-voice="${c.id}"><span class="ch-ico">${icon('volume')}</span>
        <span class="ch-name">${esc(c.name)}</span>${parts.length ? `<span class="live">${parts.length}</span>` : ''}</div>`;
      if (parts.length) {
        h += '<div class="vparts-nav">' + parts.map((u) =>
          `<span class="vpart-nav" data-vp="${esc(u)}">${esc(nameOf(u))}</span>`).join('') + '</div>';
      }
    }
    if (mayAddVoice) {
      h += '<div class="chan chan-add" data-newvoice="1">＋ New voice room</div>';
    }
    h += '</div>';
  }

  // Direct messages have their own tab on a phone, and this list is the CHANNEL
  // list. Painting both here is why the drawer reads as a dumping ground:
  // "in the channel view I can see DMs - why? We already have a DM tab."
  // On a wide screen there is no tab bar (css/shell.css only shows it below
  // 860px), so the drawer is the only route and the list stays.
  // Read what is actually on screen rather than a class somebody has to remember
  // to keep in sync: the tab bar is shown purely by CSS (css/shell.css shows it
  // below 860px), so its computed display IS the answer to "does this device
  // have a DM tab".
  const tabbar = document.getElementById('tabbar');
  const hasDmTab = !!tabbar && getComputedStyle(tabbar).display !== 'none';
  const dmsBelongHere = !hasDmTab;
  if (dmsBelongHere) {
  // The ＋ in the heading, not only the row at the bottom of the group. With
  // more than a handful of conversations the "New message" row is below the
  // fold of the sidebar, which is how "there is no visible option to start a
  // DM" happens in a list that has one. Both are kept: the heading is where
  // people look, the row is where somebody scrolling to the end lands.
  h += `<h3 class="h3-act"><span>Direct messages</span>
    <button class="h3-plus" type="button" data-newdm="1" title="New message"
      aria-label="New message">＋</button></h3><div class="navgroup">`;
  for (const d of store.dms) {
    const others = (d.other_user_ids || []).filter((u) => u !== store.me);
    const label = others.length ? others.map(nameOf).join(', ') : 'you';
    // get_bootstrap sends dms[].unread as a JSON BOOLEAN while refreshDMList
    // normalises it to 0/1, and this printed it raw - so on the first paint after
    // a cold start the badge on a DM read the literal word "true". There is no
    // per-message DM count on either path, so the honest badge is a dot.
    const unread = d.unread === true || +d.unread > 0;
    const count = typeof d.unread === 'number' && d.unread > 1 ? d.unread : null;
    h += `<div class="chan${store.currentDM === d.conversation_id ? ' active' : ''}${unread ? ' unread' : ''}"
      data-dm="${d.conversation_id}"><span class="ch-ico">@</span><span class="ch-name">${esc(label)}</span>
      ${others.length === 1 ? roleTagHtml(others[0]) : ''}
      ${unread ? (count ? `<span class="badge">${count}</span>` : '<span class="dot-unread"></span>') : ''}</div>`;
  }
  h += '<div class="chan chan-add" data-newdm="1">＋ New message</div></div>';
  }

  host.innerHTML = h;

  host.querySelectorAll('[data-space]').forEach((n) => {
    const spaceOf = () => store.spaces.find((x) => x.id === n.dataset.space);
    n.onclick = () => {
      const sp = spaceOf();
      // The drawer STAYS OPEN. See the sidebar click handler in js/main.js: on a
      // phone this list is the only channel picker, so switching server has to
      // leave you looking at the new server's channels rather than dropping you
      // into whichever one it opens on.
      if (sp && sp.id !== store.ws?.id) import('./workspace.js').then((m) => m.switchWorkspace(sp));
    };
    // Rename, archive, leave: the menu the rail tile carries, on the gesture a
    // phone actually has.
    let timer = null;
    let fired = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    const open = (ev) => import('./workspace.js').then((m) => m.spaceMenu?.(ev, spaceOf()));
    n.oncontextmenu = (e) => { e.preventDefault(); open(e); };
    n.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      fired = false;
      timer = setTimeout(() => { fired = true; open({ clientX: e.clientX, clientY: e.clientY }); }, 500);
    });
    for (const evt of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) {
      n.addEventListener(evt, cancel);
    }
    n.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); fired = false; } }, true);
  });
  // Kept: orgMenu's "Servers in <org>" entry still renders a row carrying this
  // attribute, so the handler has to survive even though the drawer no longer
  // draws one itself.
  host.querySelectorAll('[data-orgdir]').forEach((n) => {
    n.onclick = () => {
      document.body.classList.remove('nav-open');
      import('./workspace.js').then((m) => m.orgDirectory(n.dataset.orgdir));
    };
  });
  // The one door to the directory, at the end of the servers you are in.
  // A dynamic import for the same reason the rows above use one: core must not
  // hard-depend on a feature module, and a feature that failed to load should
  // cost this row rather than the whole drawer.
  host.querySelectorAll('[data-findserver]').forEach((n) => {
    n.onclick = () => {
      document.body.classList.remove('nav-open');
      import('../ui.js').then((m) => m.openPanel('servers', {}));
    };
  });
  // The organisation heading above each group of servers. Every command in
  // orgMenu reaches an ordinary member through this row and nowhere else once
  // the rail is off screen, so it answers the one gesture every device has.
  //
  // The drawer deliberately STAYS OPEN, and it does so by itself: the sidebar
  // click handler in js/main.js closes it for any .chan row that is not a
  // server, and this heading is a .nav-orglabel rather than a .chan, so that
  // handler never matches it. That is the behaviour we want rather than an
  // accident to work around, because the menu is drawn over the drawer and
  // closing the drawer underneath would leave the menu floating over the
  // conversation. Nothing here switches server either: the heading is a sibling
  // of the .srv rows, not their parent, so no [data-space] handler can see this
  // click, and stopPropagation keeps it out of the delegated handlers above.
  //
  // Dynamic import rather than a static one, because workspace.js already
  // imports renderChannels from this file and a static import back would close
  // the cycle. It is the same shape the [data-space] and [data-orgdir] handlers
  // use, and the one workspace.js uses for the organisation console.
  host.querySelectorAll('[data-orgmenu]').forEach((n) => {
    const orgOf = () => (store.orgs || []).find((o) => o.org_id === n.dataset.orgmenu);
    const open = (ev) => {
      const org = orgOf();
      // The drawer can outlive the list it was painted from: an org that was
      // left or purged while this markup was on screen has no row in store.orgs
      // any more, and orgMenu would have nothing to act on.
      if (!org) return;
      import('./workspace.js').then((m) => m.orgMenu?.(ev, org));
    };
    n.onclick = (e) => { e.preventDefault(); e.stopPropagation(); open(e); };
    // A keyboard gets there the same way it gets to a button, since the element
    // claims role="button" and nothing else would honour that claim. The menu
    // positions itself off clientX/clientY, so hand it the corner of the row
    // rather than the 0,0 a synthetic key event would otherwise carry.
    n.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const r = n.getBoundingClientRect();
      open({ clientX: r.left, clientY: r.bottom });
    };
  });
  host.querySelectorAll('[data-ch]').forEach((n) => {
    n.onclick = () => openChannel(store.channels.find((c) => c.id === n.dataset.ch));
    n.oncontextmenu = (e) => { e.preventDefault(); channelMenu(e, store.channels.find((c) => c.id === n.dataset.ch)); };
  });
  host.querySelectorAll('[data-voice]').forEach((n) => {
    n.onclick = () => bus.emit('voice:join', { channelId: n.dataset.voice });
  });
  host.querySelectorAll('[data-dm]').forEach((n) => {
    n.onclick = () => bus.emit('dm:request', { conversationId: n.dataset.dm });
  });
  // querySelector, singular, bound only the FIRST match - so adding the ＋ to the
  // heading would have silently unbound the row at the bottom of the group.
  host.querySelectorAll('[data-newdm]').forEach((n) => {
    n.addEventListener('click', (e) => { e.stopPropagation(); bus.emit('dm:new'); });
  });
  host.querySelector('[data-newch]')?.addEventListener('click', () => createChannelDialog());
  host.querySelector('[data-newvoice]')?.addEventListener('click',
    () => createChannelDialog({ kind: 'voice' }));
  host.querySelectorAll('h3[data-cat]').forEach((n) => {
    n.onclick = () => {
      const k = 'dak.cat.' + n.dataset.cat;
      localStorage.setItem(k, localStorage.getItem(k) === '0' ? '1' : '0');
      renderChannels();
    };
  });

  await renderNavSections();
}

function channelMenu(ev, c) {
  if (!c) return;
  const muted = store.notify.get(c.id)?.notify_level === 'nothing';
  contextMenu(ev, [
    { label: muted ? 'Unmute channel…' : 'Mute channel…', onClick: (ev2) => muteChannelMenu(c, ev2) },
    { label: 'Mark as read', onClick: () => api.markRead('channel', c.id, c.last_seq || 0).then(() => refreshUnread()) },
    { label: 'Copy link', onClick: () => {
      navigator.clipboard?.writeText(location.origin + location.pathname + '#/c/' + c.id);
      toast('Channel link copied');
    } },
    '-',
    { label: 'Edit channel', show: hasPerm(PERM.MANAGE_CHANNELS), onClick: () => editChannelDialog(c) },
    // Archive sits above Delete and is worded as the ordinary choice, because it
    // almost always is: what somebody wants is the channel out of the sidebar,
    // not the conversation destroyed.
    { label: c.archived_at ? 'Unarchive channel' : 'Archive channel', show: hasPerm(PERM.MANAGE_CHANNELS), onClick: async () => {
      try {
        await api.archiveChannel(c.id, !c.archived_at);
        toast(c.archived_at ? 'Channel unarchived' : 'Channel archived, and every message kept');
        bus.emit('channels:reload');
      } catch (e) { toast(e.message, 'error'); }
    } },
    { label: 'Delete channel', danger: true, show: hasPerm(PERM.MANAGE_CHANNELS), onClick: async () => {
      // Typed back, not clicked through. This is the only action in the sidebar
      // that destroys other people's writing, and it sits two items below Mute.
      if (!(await typeToConfirm({
        title: 'Delete #' + c.name,
        body: `Every message in #${c.name} is destroyed with it and cannot be brought back. `
            + 'Archiving keeps them and takes the channel out of the sidebar.',
        phrase: c.name,
        confirmLabel: 'Delete forever',
      }))) return;
      try { await api.deleteChannel(c.id); toast('Channel deleted'); bus.emit('channels:reload'); }
      catch (e) { toast(e.message, 'error'); }
    } },
  ]);
}

export async function toggleMute(c) {
  const muted = store.notify.get(c.id)?.notify_level === 'nothing';
  try {
    await api.setNotifyLevel('channel', c.id, muted ? 'inherit' : 'nothing', null);
    store.notify.set(c.id, { notify_level: muted ? 'inherit' : 'nothing' });
    renderChannels();
    toast(muted ? 'Unmuted' : 'Muted');
  } catch (e) { toast(e.message, 'error'); }
}

// Muting had exactly two states, forever or nothing - the server's mutedUntil
// parameter was passed null by every caller in the app. "For an hour" is what
// people actually want during a meeting or a depot dispatch.
export function muteChannelMenu(c, ev) {
  const muted = store.notify.get(c.id)?.notify_level === 'nothing';
  const apply = async (level, untilIso, label) => {
    try {
      await api.setNotifyLevel('channel', c.id, level, untilIso);
      store.notify.set(c.id, { notify_level: level });
      renderChannels();
      toast(label);
    } catch (e) { toast(e.message, 'error'); }
  };
  const items = muted
    ? [{ label: 'Unmute', onClick: () => apply('inherit', null, 'Unmuted') }]
    : [
      { label: 'Mute for 1 hour', onClick: () => apply('nothing', new Date(Date.now() + 3600000).toISOString(), 'Muted for an hour') },
      { label: 'Mute until tomorrow at 8am', onClick: () => {
        const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0);
        apply('nothing', d.toISOString(), 'Muted until 8am');
      } },
      { label: 'Mute until I turn it back on', onClick: () => apply('nothing', null, 'Muted') },
    ];
  contextMenu(ev, items);
}

// `preset.kind` lets a caller open this already set to what they asked for. The
// Voice section's own add button and the voice rooms panel both mean "a voice
// room", and making somebody who pressed a speaker icon then find Voice in a
// dropdown is the kind of small tax that stops a feature being used at all.
export async function createChannelDialog(preset = {}) {
  const kind = preset.kind || 'text';
  const out = await formModal({
    title: kind === 'voice' ? 'New voice room' : 'Create a channel',
    fields: [
      { name: 'name', label: 'Name', required: true,
        placeholder: kind === 'voice' ? 'standup' : 'product-launch' },
      { name: 'kind', label: 'Type', type: 'select', value: kind, options: [
        { value: 'text', label: 'Text' }, { value: 'voice', label: 'Voice' },
        { value: 'announcement', label: 'Announcement (only admins post)' },
        { value: 'forum', label: 'Forum (threaded posts)' },
      ] },
      // Default to the category of the channel you are standing in. Creating a
      // channel is nearly always "another one of these", and the old default of
      // "No category" is what sent every channel anyone created into the
      // unlabelled group at the top of the sidebar instead of into the list they
      // were looking at.
      { name: 'category', label: 'Category', type: 'select',
        value: store.current?.category_id || '',
        options: [{ value: '', label: 'No category' },
          ...store.categories.map((c) => ({ value: c.id, label: c.name }))] },
      { name: 'is_private', label: 'Private (invite only)', type: 'checkbox' },
    ],
    submitLabel: 'Create',
  });
  if (!out) return;
  try {
    const c = await api.createChannel(
      store.ws.id, out.name.trim().toLowerCase().replace(/\s+/g, '-'),
      out.kind, out.category || null, !!out.is_private);
    toast('Created #' + (c?.name || out.name));
    bus.emit('channels:reload', { open: c?.id });
    if (!!out.is_private && c?.id && hasPerm(PERM.MANAGE_CHANNELS)) {
      // A private channel is born with one member. Open the add-people picker
      // immediately so it does not stay a room of one: the missing second step
      // was the whole complaint behind "the link does not work".
      bus.emit('private-channel-created', {
        channel: { id: c.id, name: c?.name || out.name, workspace_id: store.ws.id },
      });
    }
  } catch (e) { toast(e.message, 'error'); }
}

export async function editChannelDialog(c) {
  const out = await formModal({
    title: 'Edit #' + c.name,
    fields: [
      { name: 'name', label: 'Name', value: c.name },
      { name: 'topic', label: 'Topic', value: c.topic || '', placeholder: 'What is this channel for?' },
      { name: 'category', label: 'Category', type: 'select', value: c.category_id || '',
        options: [{ value: '', label: 'No category' },
          ...store.categories.map((x) => ({ value: x.id, label: x.name }))] },
    ],
    submitLabel: 'Save',
  });
  if (!out) return;
  try {
    await api.updateChannel(c.id, {
      name: out.name !== c.name ? out.name.trim().toLowerCase().replace(/\s+/g, '-') : null,
      topic: out.topic !== (c.topic || '') ? out.topic : null,
      category: (out.category || null) !== (c.category_id || null) ? (out.category || null) : null,
    });
    toast('Channel updated');
    bus.emit('channels:reload');
  } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ open
// How many rows are painted in the FIRST frame. A page is fifty messages and a
// phone screen holds about twelve; building the other thirty-eight before
// showing anything costs 780ms of blank list on a mid-range Android for pixels
// nobody can see yet. The head lands, the list scrolls to the bottom, and the
// rest is stitched in above on the next frame where it is invisible anyway.
const HEAD_ROWS = 16;

// Paint the newest rows, then fill the scrollback in above them. Returns the
// number of rows actually rendered.
function paintPage(list, ordered, { head = HEAD_ROWS } = {}) {
  const gen = openGen;
  armPaging();
  list.innerHTML = '';
  resetWindow();
  if (ordered.length <= head + 8) {
    const n = renderBatch(list, ordered, 'channel');
    scrollDown();
    return n;
  }
  const cut = ordered.length - head;
  renderBatch(list, ordered.slice(cut), 'channel');
  scrollDown();
  // Next frame: the part that is above the fold. A tap on another channel in
  // between makes this batch belong to a conversation that is no longer open.
  requestAnimationFrame(() => {
    if (gen !== openGen || !list.isConnected) return;
    prependBatch(list, ordered.slice(0, cut), 'channel');
    scrollDown();
  });
  return ordered.length;
}

// ---- cold start: the last conversation, before the network
// A returning user on Slow 3G waits 15 seconds for a message that has been in
// this browser's own storage the whole time, because the channel cannot open
// until sign-in, redeem_invite, profiles, get_bootstrap and get_channel_messages
// have all been and gone. None of those are needed to draw what they were
// reading an hour ago.
//
// So the moment there is a user id - before a single round trip - the last
// channel is painted from disk into the (still hidden) chat shell. When
// openChannel() reaches it a few seconds later it finds the rows already there,
// keeps them, and only folds in what changed.
const LAST_CH_KEY = 'dak.lastChannel';
let prepainted = null;          // { id, uid } already on screen from the cache

// PER SERVER, not one global slot. It used to be a single {id, name, uid}, which
// meant the memory belonged to whichever channel was opened last ANYWHERE. Leave
// #dispatch in one server, open a channel in another, come back, and the stored
// id is the other server's - not found in this one's channel list, so the lookup
// fell through to default_channel_id and landed on #general. Reported exactly
// that way: "as soon as I change server by mistake I again go to the default
// general again". One slot cannot remember two rooms.
function readLastMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_CH_KEY) || 'null');
    if (!raw || raw.uid !== store.me) return {};
    // Migrate the old single-slot shape rather than discarding it: somebody
    // mid-session should not lose the one room it did remember.
    if (raw.id && !raw.byWs) return store.ws ? { [store.ws.id]: raw.id } : {};
    return raw.byWs || {};
  } catch { return {}; }
}

function rememberLastChannel(c) {
  const ws = c?.workspace_id || store.ws?.id;
  if (!ws || !c?.id) return;
  try {
    const byWs = readLastMap();
    byWs[ws] = c.id;
    localStorage.setItem(LAST_CH_KEY, JSON.stringify({ uid: store.me, byWs }));
  } catch { /* private mode: the cache is a nicety, not a requirement */ }
}

// The channel this person was last in, IN THIS SERVER. Takes the workspace
// explicitly because workspace.js calls it while store.ws is still the old one.
export function lastChannelId(workspaceId) {
  const ws = workspaceId || store.ws?.id;
  if (!ws) return null;
  return readLastMap()[ws] || null;
}

export async function paintLastChannelFromCache() {
  if (store.current || store.currentDM) return false;
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_CH_KEY) || 'null'); } catch { return false; }
  if (!last?.id || !store.me || last.uid !== store.me) return false;
  const snap = await pagecache.recall(store.me, last.id);
  if (!snap || store.current || store.currentDM) return false;
  const list = $('messages');
  if (!list || list.querySelector('.msg')) return false;
  const hdr = $('hdrName');
  if (hdr && last.name) hdr.textContent = '# ' + last.name;
  prepainted = { id: last.id, uid: store.me };
  paintCached(list, snap);
  return true;
}

export async function openChannel(c, opts = {}) {
  if (!c) return;
  const gen = ++openGen;
  // Already on screen from the cold-start paint: keep the rows, the claim set
  // and the cursor exactly as they are. Wiping and redrawing identical content
  // is a flash for no information.
  const preOpened = !!prepainted && prepainted.id === c.id && prepainted.uid === store.me
    && !!$('messages')?.querySelector('.msg');
  prepainted = null;
  store.current = c;
  store.currentDM = null;
  // The pill belongs to the conversation that was on screen. It is a sibling of
  // #messages, not a child, so emptying the list left the previous channel's
  // "3 new messages" floating over the new one.
  clearNewBelow();
  if (!preOpened) {
    resetChannelState();
    resetWindow();
    cursorReady = false;          // nothing is known about our position yet
  }
  rememberLastChannel(c);
  gapBuffer.clear();
  delivery.buffered = 0;
  if (!opts.keepPanel) closePanel();

  $('hdrName').textContent = '# ' + c.name;
  $('hdrTopic').textContent = c.topic || '';
  const composer = $('composer');
  if (composer) {
    composer.dataset.ph = 'Message #' + c.name;
    composer.placeholder = composer.dataset.ph;
    const d = store.drafts.get('channel:' + c.id);
    composer.value = d || '';
  }
  renderChannels();
  bus.emit('channel:open', { channel: c });

  const list = $('messages');

  // ---- 1. both server reads, at the same time.
  // These never depended on each other. `threads` only decides whether a reply
  // indicator paints under a message; awaiting it before even ASKING for the
  // messages put an unbounded query (224 rows, 19 KB, 193ms on a good line, six
  // seconds on a bad one) in front of the thing the person actually clicked.
  // Now projected to the fields any consumer reads and ordered newest first.
  // On a warm open the pagecache snapshot already holds every thread that has
  // not moved since it was written: reply_count cannot change without
  // last_message_at moving, and nothing deletes threads - so only the delta
  // past snapshot.at crosses the wire and merges over the cached array.
  const THREAD_COLS = 'id,channel_id,root_message_id,reply_count,last_message_at,title';
  const snap0 = pagecache.peek(store.me, c.id);
  const cachedThreads = Array.isArray(snap0?.threads) ? snap0.threads : [];
  let pThreads;
  if (cachedThreads.length) {
    const sinceIso = new Date(snap0.at).toISOString();
    pThreads = table('threads', (q) => q.eq('channel_id', c.id)
        .gt('last_message_at', sinceIso).select(THREAD_COLS)
        .order('last_message_at', { ascending: false }))
      .then((delta) => {
        const byId = new Map(cachedThreads.map((t) => [t.id, t]));
        for (const t of delta || []) byId.set(t.id, t);
        return [...byId.values()].sort((a, z) =>
          new Date(z.last_message_at || 0) - new Date(a.last_message_at || 0));
      })
      .catch(() => cachedThreads.slice());
  } else {
    pThreads = table('threads', (q) => q.eq('channel_id', c.id)
        .select(THREAD_COLS).order('last_message_at', { ascending: false }))
      .catch(() => []);
  }
  // THE MESSAGES READ, AS A DELTA WHEN THIS PHONE ALREADY HAS THE PAGE.
  //
  // The threads read above has worked this way since the efficiency pass: only
  // what changed since the snapshot crosses the wire. Messages did not, so
  // every channel open paid for a full fifty-row page - including the channel
  // you were in ninety seconds ago, whose rows were already painted from disk
  // before the request even went out. Reported as "all the messages are
  // downloading every time", and that is exactly what it was.
  //
  // resume(channel, cursor) is the same call reconcile() already makes after a
  // dropped socket, so this is not new machinery, it is the existing machinery
  // asked one moment earlier. It answers with the events past the cursor -
  // usually none - and reports too_old when our position predates the retention
  // floor, which re-snapshots and lands back on a full page.
  //
  // Only where the cursor is KNOWN and the rows are ALREADY ON SCREEN:
  // preOpened means the cold-start paint drew them, and a synchronous peek hit
  // means the memory snapshot did. The async recall path further down still
  // takes a full page, because the fetch has to be in flight before that await
  // resolves and starting the wrong one to save a round trip is a bad trade.
  //
  // opts.fullPage is the loop breaker, and it is not hypothetical: resnapshot()
  // reopens the channel precisely BECAUSE the delta came back too_old, and the
  // cached page it was too old for is still on screen when it does. Without
  // this the second open takes the delta again, gets too_old again, and
  // resnapshots again, forever - which is what happens to anybody returning
  // after the fourteen-day retention floor. Caught by probe-coldbytes, which
  // hung rather than failed.
  const deltaFrom = preOpened ? (store.cursor || 0) : (+snap0?.cursor || 0);
  const canDelta = !opts.fullPage && deltaFrom > 0 && (preOpened || !!snap0);
  const pMsgs = canDelta ? null : api.channelMessages(c.id, null, MESSAGE_PAGE)
    .then((r) => ({ rows: r || [] }), (e) => ({ err: e }));
  pThreads.then((threads) => {
    if (gen !== openGen) return;
    for (const t of threads) {
      if (!t.root_message_id) continue;
      store.rootThreads.set(t.root_message_id, {
        threadId: t.id, count: t.reply_count, last_message_at: t.last_message_at,
      });
      refreshThreadIndicator(t.root_message_id);
    }
  });

  // ---- 2. whatever this phone already has, on screen now.
  // peek() is synchronous on purpose: coming back to a channel you were in must
  // paint in the same frame as the tap, and even an await that resolves
  // immediately costs a frame.
  let cached = pagecache.peek(store.me, c.id);
  if (preOpened) {
    // The cold-start paint already drew this one. Nothing to do but reconcile.
  } else if (cached) {
    paintCached(list, cached);
  } else {
    list.innerHTML = `<div class="loading-space"><span class="spin"></span>Opening #${esc(c.name)}…</div>`;
    cached = await pagecache.recall(store.me, c.id);
    if (gen !== openGen) return;
    if (cached) paintCached(list, cached);
  }
  // The socket can go up while the page is still in flight. Anything it delivers
  // lands on top of the cached rows, and claimMessage keeps it from doubling.
  subscribeChannel(c);

  // ---- 3. the server's answer, folded into what is already there.
  if (canDelta) {
    // Nothing to fold: the rows are on screen and reconcile() replays only what
    // happened after their cursor, through the same applyEvents every socket
    // delivery uses. It handles too_old by re-snapshotting, which is the full
    // page by another name, and it does its own markRead.
    //
    // The reactions do need asking for: they are state rather than events, so
    // no amount of replay produces them and the painted rows would sit bare
    // until the nine-second sweep in presence.js came round.
    const painted = [...list.querySelectorAll('.msg')].map((n) => n.dataset.id).filter(Boolean);
    if (painted.length) loadReactions(painted.slice(-MESSAGE_PAGE)).catch(() => {});
    await reconcile();
    if (gen !== openGen) return;
    if (opts.jumpSeq) jumpToSeq(c, opts.jumpSeq);
    return;
  }
  const res = await pMsgs;
  if (gen !== openGen) return;
  if (res.err) {
    // A cached page on screen is worth far more than an error replacing it.
    if (!cached) {
      // This used to print the raw database error into the conversation, which
      // tells a person nothing they can act on and reads like the app broke in a
      // way that is their problem. Say what happened, offer the one thing that
      // helps, and keep the detail as fine print for whoever is debugging.
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      list.innerHTML = `
        <div class="loadfail">
          <h2>Could not open #${esc(c.name)}</h2>
          <p class="muted">${offline
            ? 'Your phone is offline. This channel comes back on its own once you have signal.'
            : 'The connection dropped while loading it. Nothing has been lost.'}</p>
          <button id="chanRetry" class="wide">Try again</button>
          <p class="muted fineprint">${esc(res.err.message || 'no further detail')}</p>
        </div>`;
      const btn = list.querySelector('#chanRetry');
      if (btn) {
        btn.onclick = () => {
          btn.disabled = true;
          btn.textContent = 'Loading…';
          openChannel(c).catch(() => { btn.disabled = false; btn.textContent = 'Try again'; });
        };
      }
    }
    return;
  }
  await pThreads;
  if (gen !== openGen) return;

  const ordered = res.rows.slice().reverse();
  const visible = ordered.filter(shouldShowInChannel);

  const onScreen = cached || (preOpened
    ? { msgs: [...store.msgCache.values()].sort((a, z) => (a.seq || 0) - (z.seq || 0)) }
    : null);
  if (!onScreen) {
    if (!visible.length) {
      list.innerHTML = '';
      const empty = el('div', 'empty channel-born',
        `<div class="channel-born-mark">#</div>
         <div class="channel-born-title">This is the beginning of <b>#${esc(c.name)}</b></div>
         <div class="channel-born-sub">Say hello, pin what matters, or drop the first file.</div>`);
      list.appendChild(empty);
    } else {
      for (const m of visible) claimMessage(m);
      paintPage(list, visible);
    }
  } else {
    mergeIntoCached(list, visible, onScreen);
  }

  // The cursor tracks the channel_events log, not message seq: an edit or delete
  // advances last_seq past the newest message. Take the larger of the two - a
  // cursor that is too low only replays idempotent events, one that is too high
  // silently drops them.
  store.cursor = Math.max(c.last_seq || 0, ordered.length ? ordered[ordered.length - 1].seq : 0);
  cursorReady = true;             // 0 from here on means "the log is empty", not "unknown"
  store.oldestSeq = ordered.length ? ordered[0].seq : null;
  pagecache.remember(store.me, c.id, {
    msgs: visible, threads: await pThreads, cursor: store.cursor, oldestSeq: store.oldestSeq,
  });

  loadReactions(ordered.map((m) => m.id)).catch(() => {});
  if (ordered.length) {
    api.markRead('channel', c.id, store.cursor).catch(() => {});
    clearUnreadLocal(c.id);
  }
  if (opts.jumpSeq) jumpToSeq(c, opts.jumpSeq);
}

// Draw a snapshot from disk. Everything here is marked seen, so when the real
// page lands a moment later only the genuinely new rows are added.
function paintCached(list, snap) {
  for (const t of snap.threads || []) {
    if (t.root_message_id) {
      store.rootThreads.set(t.root_message_id, {
        threadId: t.id, count: t.reply_count, last_message_at: t.last_message_at,
      });
    }
  }
  const rows = (snap.msgs || []).filter((m) => !m.deleted_at).filter(shouldShowInChannel);
  for (const m of rows) claimMessage(m);
  paintPage(list, rows);
  store.cursor = snap.cursor || 0;
  cursorReady = true;             // a snapshot from disk is a real position too
  store.oldestSeq = snap.oldestSeq ?? (rows.length ? rows[0].seq : null);
}

// Reconcile the painted-from-disk list against the page the server just sent.
// Three outcomes, in order of how common they are: identical (do nothing, which
// is the whole point), a few new messages at the end (append them), or the cache
// is older than one page so the two do not overlap at all (start again).
function mergeIntoCached(list, fresh, snap) {
  // The server says this channel has nothing visible in it. Whatever this phone
  // is still showing was deleted or moved while it was away.
  if (!fresh.length) {
    if (!snap.msgs?.length) return;
    // A message still being sent belongs to this person, not to the server's
    // answer, so it stays.
    for (const row of [...list.querySelectorAll('.msg')]) {
      if (row.classList.contains('pending') || row.classList.contains('failed')) continue;
      if (row.dataset.id) { store.seen.delete(row.dataset.id); store.msgCache.delete(row.dataset.id); }
      row.remove();
    }
    resetWindow();
    if (!list.querySelector('.msg')) {
      for (const d of [...list.querySelectorAll('.daydiv')]) d.remove();
      list.appendChild(el('div', 'empty',
        `This is the beginning of <b>#${esc(store.current?.name || '')}</b>. Say hello.`));
    }
    return;
  }
  const shownNewest = snap.msgs.length ? +(snap.msgs[snap.msgs.length - 1].seq || 0) : 0;
  const freshOldest = +(fresh[0].seq || 0);
  if (shownNewest && freshOldest > shownNewest + 1) {
    // The gap between the cached page and this one is bigger than a page: there
    // is no honest way to stitch them, so the server's copy wins outright.
    store.seen.clear();
    store.msgCache.clear();
    for (const m of fresh) claimMessage(m);
    paintPage(list, fresh);
    return;
  }
  const added = [];
  for (const m of fresh) {
    if (m.deleted_at) { applyDelete(m.id); continue; }
    const prev = store.msgCache.get(m.id);
    if (prev) {
      // Something changed while this phone was away from the channel.
      if (prev.body_text !== m.body_text) applyEdit(m.id, m.body_text);
      store.msgCache.set(m.id, m);
      continue;
    }
    if (!claimMessage(m)) continue;
    added.push(m);
  }

  // A deletion that happened while the app was CLOSED leaves no trace in this
  // page: get_channel_messages filters `deleted_at is null`, so the row the
  // moderator removed is simply absent from the server's answer rather than
  // present-and-tombstoned. Without this, the cached copy of it stays on screen
  // for the whole session - measured: a message deleted while the app was shut
  // came back on the next cold start and never left.
  //
  // The server's page is authoritative over the span it covers. Anything inside
  // that span which this phone is showing and the server did not send is gone.
  // Outside the span nothing is claimed, so older scrollback is left alone.
  const lo = +(fresh[0].seq || 0);
  const hi = +(fresh[fresh.length - 1].seq || 0);
  if (lo && hi) {
    const present = new Set(fresh.map((m) => m.id));
    // Only the rows this phone actually drew into the channel are candidates.
    // A thread reply the panel is holding, and anything outside the span, are
    // none of this page's business.
    for (const cm of snap.msgs || []) {
      const s = +(cm.seq || 0);
      if (!s || s < lo || s > hi) continue;   // optimistic rows have no seq
      if (present.has(cm.id)) continue;
      if (!shouldShowInChannel(cm)) continue;
      if (store.msgCache.get(cm.id)?.deleted_at || cm.deleted_at) continue;
      applyDelete(cm.id);
    }
  }

  if (!added.length) return;
  const stick = nearBottom();
  // renderBatch appends: it is the fast path and it is only correct when every
  // row being added is NEWER than everything already on screen, which is the
  // ordinary case (the cache holds a page, the server sends the same page plus
  // whatever arrived since). It is not correct when the stored page has a hole
  // in it, and then a blind append prints the recovered older messages under the
  // newer ones - permanently, until the channel is reopened. appendMessage does
  // an ordered insert when it is not in bulk mode, so hand the odd case to it.
  const newestShown = [...list.querySelectorAll('.msg')]
    .reduce((mx, r) => Math.max(mx, +r.dataset.seq || 0), 0);
  const oldestAdded = added.reduce((mn, m) => Math.min(mn, +(m.seq || Infinity)), Infinity);
  if (newestShown && isFinite(oldestAdded) && oldestAdded < newestShown) {
    for (const m of added) appendMessage(list, m, 'channel');
  } else {
    renderBatch(list, added, 'channel');
  }
  capWindow(list);
  if (stick) scrollDown();
}

// A thread reply belongs in the side panel, NOT the channel - unless the author
// ticked "also send to channel". This single predicate is the Slack contract.
function shouldShowInChannel(m) {
  if (!m.thread_id) return true;
  if (m.also_send_to_channel) return true;
  return store.rootThreads.has(m.id); // the root message itself
}

// One threshold for the whole app, in messages.js. This used to be a bare 140px,
// which is a lot of a short list: the orientation banner had #messages down to
// 188px on a 1366x768 laptop at Windows' 125% scaling, so nothing could ever be
// more than 48px from the bottom and every arrival counted as "follow them down".
function nearBottom() {
  return atBottom($('messages'));
}

// ------------------------------------------------------------------ realtime
function subscribeChannel(c) {
  subscribe('chan', 'ch:' + c.id, {
    msg: (m) => onIncoming(m),
    nudge: () => requestResync('nudge'),
    edit: (p) => { advanceOnEvent(p.event_seq); applyEdit(p.id, p.body_text); },
    delete: (p) => { advanceOnEvent(p.event_seq); applyDelete(p.message_id); },
    reaction: (p) => applyReaction(p),
    thread_created: (p) => {
      if (!p.root_message_id) return;
      store.rootThreads.set(p.root_message_id, {
        threadId: p.id, count: p.reply_count || 0, last_message_at: p.last_message_at,
      });
      refreshThreadIndicator(p.root_message_id);
    },
    voice_join: () => bus.emit('voice:refresh'),
    voice_leave: (p) => { bus.emit('voice:left', { userId: p?.user_id }); bus.emit('voice:refresh'); },
  }, {
    onStatus: (status) => {
      // Features bind their own handlers onto whatever object core holds for
      // 'chan'. That object is replaced on every switch AND on every recovered
      // drop, so tell them when a new one is live rather than making them poll
      // for it and give up after eight seconds.
      if (status === 'SUBSCRIBED') bus.emit('channel:subscribed', { channel: c });
    },
  });

  subscribe('typing', 'typ:' + c.id, {
    typing: (p) => { if (p.user_id !== store.me) bus.emit('typing', p); },
  }, { self: false });
}

// An edit or a delete moves the channel's event log forward without changing any
// message's own seq, so the cursor has to follow it or the very next message
// looks like a gap. The payload carries `event_seq` (0056) precisely for this;
// older servers omit it, in which case the next message triggers one harmless
// resync instead.
function advanceOnEvent(eventSeq) {
  const s = +(eventSeq || 0);
  if (!s) return;
  if (cursorReady && s > store.cursor + 1) { onGap(s, null); return; }
  store.cursor = Math.max(store.cursor, s);
}

// The branch this client never had. Telegram states all three:
//   local + count === incoming -> apply
//   local + count  >  incoming -> already applied, ignore
//   local + count  <  incoming -> A GAP. Fill it before applying.
// Dek implemented the middle one (Math.max on the cursor) and used it for the
// third, which quietly advanced the cursor PAST the missing span. reconcile()
// then asked for events after the new cursor and nobody ever asked for the
// dropped ones again. They came back only on a reload. This is that fix: hold
// the early message, leave the cursor where it is, and go and get the hole.
function onGap(seq, msg) {
  delivery.gaps++;
  if (msg && gapBuffer.size < GAP_BUFFER_MAX) gapBuffer.set(seq, msg);
  delivery.buffered = gapBuffer.size;
  requestResync('gap', GAP_GRACE_MS);
}

function onIncoming(m) {
  if (m.channel_id !== store.current?.id) return;
  const seq = +(m.seq || 0);
  if (seq && cursorReady && seq > store.cursor + 1) { onGap(seq, m); return; }
  applyIncoming(m);
}

function applyIncoming(m) {
  if (m.channel_id !== store.current?.id) return;
  if (m.seq) store.cursor = Math.max(store.cursor, m.seq);

  // A thread reply bumps the indicator instead of interrupting the channel.
  if (m.thread_id && !store.rootThreads.has(m.id)) {
    for (const [root, t] of store.rootThreads) {
      if (t.threadId === m.thread_id) {
        t.count = (t.count || 0) + 1;
        t.last_message_at = m.created_at;
        refreshThreadIndicator(root);
        break;
      }
    }
    if (!m.also_send_to_channel) {
      bus.emit('message:new', { msg: m, inThread: true });
      return;
    }
    // Deliberately broadcast into the channel. The thread panel may already have
    // claimed this id, so ask the channel list itself rather than the shared gate.
    const list = $('messages');
    if (renderedIn(list, m.id)) return;
    store.seen.add(m.id);
    const stickA = nearBottom();
    appendMessage(list, m, 'channel');
    if (stickA) scrollDown(); else showNewBelow();
    markReadSoon(store.current.id, m.seq);
    bus.emit('message:new', { msg: m });
    return;
  }

  if (!claimMessage(m)) return;
  const list = $('messages');
  const stick = nearBottom();
  // Paged up far enough that the tail has been trimmed out of the DOM: this
  // message belongs BELOW rows that are not on screen, so appending it here
  // would print it in the wrong place. Record it and let the jump-to-latest
  // path bring the whole tail back in order.
  if (windowState().below) {
    deferBelow(m);
    showNewBelow();
  } else {
    appendMessage(list, m, 'channel');
    capWindow(list);
    if (stick) scrollDown(); else showNewBelow();
  }
  pagecache.note(store.me, m.channel_id, m);
  markReadSoon(store.current.id, m.seq);
  bus.emit('message:new', { msg: m });
}

// mark_read is monotonic server-side (greatest(...)), so a burst of twenty
// messages needs one write, not twenty. Every one of those writes also fans a
// realtime event out to the sender, which nothing listens for.
let readTimer = null;
let readPending = null;
function markReadSoon(channelId, seq) {
  if (!seq) return;
  if (!readPending || readPending.id !== channelId || seq > readPending.seq) {
    readPending = { id: channelId, seq: Math.max(seq, readPending?.id === channelId ? readPending.seq : 0) };
  }
  if (readTimer) return;
  readTimer = setTimeout(() => {
    readTimer = null;
    const p = readPending;
    readPending = null;
    if (p) api.markRead('channel', p.id, p.seq).catch(() => {});
  }, MARK_READ_MS);
}

// The pill that says "something arrived while you were reading up there".
//
// It used to be a static "New messages" with no count, which does not answer the
// question the reader actually has - how much did I miss - and gave them nothing
// to decide whether to go and look. It also survived a channel switch, because it
// is a sibling of #messages inside section.msgs and only the LIST is emptied on
// open, so the pill from the previous conversation stayed on screen over the new
// one. Both organisations asked for exactly this control, so it is worth being
// the real thing: a count, and a reset when the reader gets to the bottom.
let newBelowCount = 0;

export function showNewBelow(n = 1) {
  newBelowCount += Math.max(0, n);
  const host = $('messages')?.parentElement;
  if (!host) return;
  let b = $('newBelow');
  if (!b) {
    b = el('button', 'new-below');
    b.id = 'newBelow';
    // jumpLatest rebuilds the tail in one bounded pass. Walking back down to it
    // a chunk at a time is not bounded, and after a long scroll up it is the
    // difference between instant and several seconds.
    b.onclick = () => { jumpLatest($('messages'), 'channel'); clearNewBelow(); };
    host.appendChild(b);
  }
  b.textContent = newBelowCount === 1
    ? '1 new message ↓'
    : `${newBelowCount} new messages ↓`;
}

export function clearNewBelow() {
  newBelowCount = 0;
  $('newBelow')?.remove();
}

// ------------------------------------------------------------------ resync
// One entry point for "go and find out what I missed", debounced, so that a
// reconnect that fires SUBSCRIBED on four topics at once costs one pass and not
// four. Every caller names its reason; the harness and the tests read it back.
let resyncTimer = null;
let resyncUntil = 0;
let resyncAgain = false;

// How long one pass is allowed to hold the door shut. This used to be a bare
// boolean cleared only in runResync's own finally block, and the pass it guards
// awaits api.resume() -> sb.rpc() -> fetch(), which supabase-js gives no timeout.
// So a request that never settles - the dead-but-open socket of a phone that
// slept, which is exactly what probe-4 and probe-12 model - left the latch set
// for the life of the page, and from that moment EVERY heal trigger was dropped
// at the door: the 25s backstop, visibilitychange, online, focus, rejoin, gap and
// nudge. Nothing but a reload could bring the conversation up to date again,
// which is the second half of "I have to refresh the site to see new messages".
//
// A deadline cannot get stuck. 45s is longer than any pass that is going to
// succeed (the slowest measured resume is under 2s on a bad line) and shorter
// than a person's patience.
const RESYNC_MAX_MS = 45000;

export function requestResync(reason = 'manual', delay = 0) {
  delivery.lastReason = reason;
  delivery.lastAt = Date.now();
  if (resyncTimer) return;
  resyncTimer = setTimeout(() => { resyncTimer = null; runResync(reason); }, delay);
}

async function runResync(reason) {
  if (Date.now() < resyncUntil) { resyncAgain = true; return; }
  resyncUntil = Date.now() + RESYNC_MAX_MS;
  try {
    delivery.resyncs++;
    if (store.current) await reconcile();
    bus.emit('delivery:resync', { reason });     // DMs and anything else with a cursor
  } catch (e) {
    console.warn('resync', e?.message || e);
  } finally {
    resyncUntil = 0;
    if (resyncAgain) { resyncAgain = false; requestResync(reason + '+', 60); }
  }
}

// Realtime is at-most-once, so anything can be dropped and the UI must heal
// itself. Reconciling against `messages` alone is not enough: an edit or a
// delete does not change the message's own seq, so a dropped edit/delete
// broadcast would never be repaired and that user would keep seeing a message
// everyone else has changed or removed.
//
// channel_events is the gapless log that covers all of it - send, edit, delete
// and pin each advance channels.last_seq and append a row. resume() (0056)
// returns everything past our cursor for ONE channel, plus the two numbers the
// client cannot know on its own: how far back the log still goes, and whether
// it withheld anything. That is Discord's RESUME - replay the span, do not
// refetch the world - with Telegram's differenceTooLong on the end of it.
export async function reconcile() {
  if (!store.current) return;
  const gen = openGen;
  const channelId = store.current.id;
  const startCursor = store.cursor;

  for (let page = 0; ; page++) {
    let r;
    try {
      r = await api.resume(channelId, store.cursor, RESUME_PAGE);
    } catch (e) {
      // Older deployment without 0056: fall back to the multi-channel sync().
      if (/schema cache|does not exist|404/i.test(e?.message || '')) return legacyReconcile(channelId, gen);
      return; // transient; an event or the backstop will try again
    }
    if (gen !== openGen || store.current?.id !== channelId) return;

    // Our position predates the retention floor - the span between them was
    // pruned and no replay can produce it. Telegram calls this
    // differenceTooLong and restarts the client's state; so do we.
    if (r?.too_old) { await resnapshot(channelId, 'too_old'); return; }

    const events = Array.isArray(r?.events) ? r.events : [];
    if (!events.length) break;
    await applyEvents(channelId, events, gen);
    if (gen !== openGen || store.current?.id !== channelId) return;

    if (!r.more) break;
    if (page + 1 >= RESUME_MAX_PAGES) { await resnapshot(channelId, 'too_far'); return; }
  }

  flushGapBuffer();
  if (store.cursor > startCursor) {
    api.markRead('channel', channelId, store.cursor).catch(() => {});
    clearUnreadLocal(channelId);
  }
}

// Columns the heal read actually needs. This fetch feeds buildMessage, the
// hover-action show() predicates and the message:new/message:render listeners,
// and every name on the list is read somewhere off live-served rows today, so
// each is provably a real column. Deliberately absent: body jsonb (a duplicate
// of body_text per the efficiency notes) and client_msg_id, which cannot be
// proven to be a physical column from this repo - broadcast payloads may attach
// it server-side, and guessing wrong would error the whole fetch. If the server
// ever refuses the list, or serves rows missing one of these keys (PostgREST
// echoes selected columns as keys even when null), the read retries once with
// '*' so healing degrades to the old behaviour instead of painting blanks.
// Verified against information_schema, not against memory. Three of the names
// that used to be here are not columns on public.messages at all - bot_id and
// webhook_id never existed, and conversation_id belongs to dm_messages, which is
// a different table. So the projected read failed EVERY time and the '*' retry
// below ran on every heal, quietly, fetching search_tsv and the whole body jsonb
// with it. The retry was written as a safety net and had become the only path.
const HEAL_COLUMNS = ['id', 'seq', 'channel_id', 'author_id',
  'body_text', 'created_at', 'edited_at', 'deleted_at', 'attachments',
  'mention_user_ids', 'mention_scope', 'priority', 'topic', 'reply_to_id',
  'thread_id', 'also_send_to_channel', 'ack_required'];

// Apply one page of the log. Anything healed here has to look EXACTLY like a
// live delivery to the rest of the app: same 'message:new' event, same read
// state. It did not before, which is why every reconnect left a phantom unread
// dot on the channel you were reading and why a recovered message never raised
// a notification.
async function applyEvents(channelId, events, gen) {
  const stick = nearBottom();
  const newIds = events.filter((e) => e.kind === 'msg').map((e) => e.message_id);
  const editedIds = events.filter((e) => e.kind === 'edit').map((e) => e.message_id);

  // One round trip for every message the log says we are missing or is stale.
  const wanted = [...new Set([...newIds, ...editedIds])];
  const byId = new Map();
  if (wanted.length) {
    // The error used to be discarded. Fourteen lines below, the loop advances
    // store.cursor per event BEFORE it checks whether the row was actually
    // fetched - so a failed read here (offline mid-pass, an aborted request, a
    // 5xx, or a URL long enough to be rejected on a 200-id `in` filter) marched
    // the cursor across the whole page while rendering nothing, and resume() only
    // ever asks for events AFTER the cursor. Those messages were then
    // unreachable for the life of the session: the exact "I refreshed and there
    // they were" report. Abandoning the pass leaves the cursor where it is, so
    // the next trigger asks for the same span again.
    // Chunked at 50 ids per request: a 200-id `in` filter is a ~7.4 KB URL that
    // the server can reject, and one rejected URL used to abandon the whole
    // healing pass. Any chunk failing still abandons the pass with the cursor
    // left alone, so the next trigger refetches the same span.
    const chunks = Array.from({ length: Math.ceil(wanted.length / 50) }, (_, i) =>
      wanted.slice(i * 50, i * 50 + 50));
    const fetchHealPages = (cols) => Promise.all(
      chunks.map((ids) => sb.from('messages').select(cols).in('id', ids)));
    let pages = await fetchHealPages(HEAL_COLUMNS.join(','));
    if (pages.some((p) => p.error)) {
      // A column this schema lacks fails the projected read wholesale. One
      // unprojected retry keeps the pass alive; if '*' fails too, the same
      // abandon-below handles it exactly as before. Costs nothing while the
      // projection is healthy.
      pages = await fetchHealPages('*');
    } else {
      // Drift guard: an absent key means the list no longer matches the schema.
      const sample = pages.flatMap((p) => p.data || []).find(Boolean);
      if (sample && HEAL_COLUMNS.some((k) => !(k in sample))) {
        pages = await fetchHealPages('*');
      }
    }
    const failed = pages.find((p) => p.error);
    if (failed) {
      console.warn('resync: message fetch failed, leaving the cursor alone', failed.error.message);
      requestResync('refetch', 1500);
      return;
    }
    for (const page of pages) for (const m of page.data || []) byId.set(m.id, m);
  }
  if (gen !== openGen || store.current?.id !== channelId) return;

  // How many messages actually reached the DOM. newIds cannot answer this: it
  // includes thread-only replies, deleted rows and ids already on screen, so
  // counting it would tell the reader they had missed messages they can see.
  let landed = 0;

  for (const e of events) {
    store.cursor = Math.max(store.cursor, e.seq);
    delivery.healed++;
    if (gapBuffer.has(e.seq)) { gapBuffer.delete(e.seq); delivery.buffered = gapBuffer.size; }
    if (e.kind === 'delete') { applyDelete(e.message_id); continue; }
    if (e.kind === 'edit') {
      const m = byId.get(e.message_id);
      if (m) applyEdit(m.id, m.body_text);
      continue;
    }
    if (e.kind !== 'msg') continue;         // 'pin' is repainted by the pins panel

    const m = byId.get(e.message_id);
    if (!m || m.deleted_at) continue;
    if (!shouldShowInChannel(m)) {
      for (const [root, t] of store.rootThreads) {
        if (t.threadId === m.thread_id) { t.count = (t.count || 0) + 1; refreshThreadIndicator(root); break; }
      }
      bus.emit('message:new', { msg: m, inThread: true, healed: true });
      continue;
    }
    if (!claimMessage(m)) continue;
    appendMessage($('messages'), m, 'channel');
    landed++;
    // The cached page has to learn about a healed message too. It did not, and
    // that left a HOLE in the middle of the stored page: a span recovered over
    // resume() reached the screen but never the snapshot, so the next cold start
    // painted [1..12, 21, 22] and then had to stitch the server's page across
    // the missing 13..20. Measured: they landed at the bottom, under messages
    // sent after them, and stayed there.
    pagecache.note(store.me, channelId, m);
    bus.emit('message:new', { msg: m, healed: true });
  }

  if (newIds.length) await loadReactions(newIds);
  if (stick) scrollDown(); else if (landed) showNewBelow(landed);
}

// Messages that arrived early are applied the moment the log has filled in
// everything beneath them. Anything still sitting above a hole stays buffered
// for the next pass rather than being applied out of order.
function flushGapBuffer() {
  if (!gapBuffer.size) return;
  for (const seq of [...gapBuffer.keys()].sort((a, b) => a - b)) {
    if (seq > store.cursor + 1) break;
    const m = gapBuffer.get(seq);
    gapBuffer.delete(seq);
    applyIncoming(m);
  }
  delivery.buffered = gapBuffer.size;
}

// The cursor is beyond what the log can replay. Throw local state away and load
// the channel again - and SAY so, because silently repainting the screen while
// someone is reading it is worse than a sentence explaining why.
async function resnapshot(channelId, why) {
  delivery.resnapshots++;
  const c = store.channels.find((x) => x.id === channelId) || store.current;
  if (!c) return;
  gapBuffer.clear();
  delivery.buffered = 0;
  toast(why === 'too_old'
    ? `You were away a while. Reloading #${c.name} from the server.`
    : `Catching up on #${c.name} - too much to replay.`);
  // fullPage, always. This function exists because the delta could not answer,
  // so reopening in a way that could take the delta again is a loop.
  await openChannel(c, { keepPanel: true, fullPage: true });
}

// Deployment without 0056 applied: sync() has no floor, no head and no "more",
// so this can heal a small gap and nothing else. Kept so a half-deployed client
// degrades instead of breaking.
async function legacyReconcile(channelId, gen) {
  let events;
  try { events = await api.sync([{ channel_id: channelId, seq: store.cursor }]); }
  catch { return; }
  if (gen !== openGen || store.current?.id !== channelId) return;
  if (!Array.isArray(events)) return;
  events = events.filter((e) => e.channel_id === channelId);
  if (!events.length) return;
  await applyEvents(channelId, events, gen);
  flushGapBuffer();
}

// ------------------------------------------------------------------ paging up
export async function loadOlder() {
  if (loadingOlder || !store.current || store.oldestSeq == null || store.oldestSeq <= 1) return;
  const gen = openGen;
  loadingOlder = true;
  const list = $('messages');
  try {
    const older = (await api.channelMessages(store.current.id, store.oldestSeq, MESSAGE_PAGE)) || [];
    if (gen !== openGen) return;
    if (!older.length) { store.oldestSeq = 1; return; }
    const ordered = older.slice().reverse().filter(shouldShowInChannel).filter(claimMessage);
    prependBatch(list, ordered, 'channel');
    capWindowTop(list);
    store.oldestSeq = older[older.length - 1].seq;
    loadReactions(ordered.map((m) => m.id)).catch(() => {});
  } finally { loadingOlder = false; }
}

export async function jumpToSeq(channel, seq) {
  try {
    const rows = (await api.messagesAround(channel.id, seq, 25, 25)) || [];
    if (!rows.length) return;
    const list = $('messages');
    list.innerHTML = '';
    resetChannelState();
    resetWindow();
    armPaging();
    renderBatch(list, rows.filter(shouldShowInChannel).filter(claimMessage), 'channel');
    loadReactions(rows.map((m) => m.id)).catch(() => {});
    store.oldestSeq = rows[0].seq;
    store.cursor = rows[rows.length - 1].seq;
    cursorReady = true;
    const target = rows.find((r) => r.seq === seq) || rows[Math.floor(rows.length / 2)];
    if (target?.id) jumpTo(target.id);
  } catch (e) { toast(e.message || 'Could not jump there', 'error'); }
}

// Three round trips, not one, which is why the caller can now ask for only the
// part that is about the Space actually on screen. `full` defaults to true so
// every existing caller - a channel switch, a manual reload, unread:reload -
// keeps behaving exactly as it did; only the idle poll in presence.js passes
// false, and only for three ticks out of four.
// A stable fingerprint of what the sidebar actually shows, so a poll that
// learned nothing can stop before repainting.
//
// This is the single most expensive thing the app did while nobody was touching
// it. renderChannels() rewrites the whole sidebar with innerHTML and then awaits
// renderNavSections(), which issues list_topics - and topics.js caches for 1500ms,
// so a poll every 20 or 30 seconds NEVER hits that cache. Two polls repainting
// unconditionally was about 285 of the ~1,194 requests an hour a visible idle
// client made, and closer to 855 when the open channel uses topics. A quarter to
// a half of the entire idle budget, spent painting byte-identical HTML from
// byte-identical data.
//
// Only the count and the mention count are in the key, because those are the
// only fields the sidebar renders. Every path that genuinely changes the sidebar
// - openChannel, toggleMute, category collapse, reloadChannels, switchWorkspace,
// a new DM appearing - calls renderChannels directly and is untouched by this.
// The Space id is in the key so a switch can never be mistaken for "nothing
// changed", however the two Spaces' counts happen to line up.
function unreadFingerprint(m) {
  const parts = [store.ws?.id || ''];
  for (const [id, u] of m) parts.push(id + ':' + (u.unread || 0) + ':' + (u.mention_count || 0));
  return parts.sort().join('|');
}

let lastUnreadPrint = null;

// mark_read's answer is known the moment we decide to send it: everything up to
// this scope's cursor is read. Drop the row and repaint locally instead of
// paying refreshUnread's two RPCs plus the DM list for an outcome we authored;
// a failed write heals on the next poll because the server keeps the truth.
export function clearUnreadLocal(scopeId) {
  if (!store.ws || !store.unread.has(scopeId)) return;
  store.unread.delete(scopeId);
  lastUnreadPrint = unreadFingerprint(store.unread);
  bus.emit('unread');
  renderChannels();
}

// `opts || {}`, not a bare destructure default: `.then(refreshUnread)` and
// bus.on('unread:reload', refreshUnread) both hand the resolution/payload in as
// the first argument, and PostgREST returns null for a void RPC - which turns
// `{ full = true } = null` into a TypeError swallowed by the caller's catch.
// The fallback makes every such call read as full=true instead of throwing.
export async function refreshUnread(opts) {
  const { full = true } = opts || {};
  if (!store.ws) return;
  try {
    const rows = (await api.unread(store.ws.id)) || [];
    store.unread = new Map(rows.map((u) => [u.scope_id, u]));
    const print = unreadFingerprint(store.unread);
    if (print !== lastUnreadPrint) {
      lastUnreadPrint = print;
      bus.emit('unread');
      renderChannels();
    }
  } catch { /* transient */ }
  if (!full) return;

  // Badges on the Space rail come from a separate cross-workspace rollup, so a
  // message in another Space still lights up its icon. This one is about the
  // Spaces you are NOT looking at, which is precisely the thing that can wait.
  try {
    const summary = await api.spaceSummary();
    if (Array.isArray(summary)) {
      store.spaceBadges = new Map(summary.map((s) => [s.workspace_id, s]));
      bus.emit('spaces:badges');
    }
  } catch { /* the rail just keeps its last state */ }

  await refreshDMList();
}

// A conversation someone else opens with me is not in the bootstrap snapshot I
// loaded, and there is no realtime event for "a DM now exists". Without this the
// first message from a new person is invisible until a reload, which reads as
// lost mail. Poll the DM list alongside unread.
export async function refreshDMList() {
  if (!store.ws) return;
  try {
    const rows = (await api.dmUnread(store.ws.id)) || [];
    const known = new Set(store.dms.map((d) => d.conversation_id));
    const fresh = rows.filter((r) => !known.has(r.conversation_id));

    if (fresh.length) {
      // Only the new conversations need their member lists resolved.
      const ids = fresh.map((r) => r.conversation_id);
      const members = await table('conversation_members', (q) => q.in('conversation_id', ids));
      const missing = [...new Set(members.map((m) => m.user_id))]
        .filter((u) => !store.profiles.has(u));
      if (missing.length) {
        const profs = await table('profiles', (q) => q.in('id', missing));
        for (const p of profs) store.profiles.set(p.id, p);
      }
      for (const r of fresh) {
        store.dms.push({
          conversation_id: r.conversation_id,
          other_user_ids: members.filter((m) => m.conversation_id === r.conversation_id)
            .map((m) => m.user_id),
          last_message_at: r.last_message_at,
          unread: r.unread ? 1 : 0,
        });
      }
    }
    // Sync every badge from the server answer, including conversations ABSENT
    // from it - a DM read on another device used to keep its lit dot here until
    // a Space switch, because this function used to return early on an empty
    // answer and only ever updated rows the answer still mentioned.
    const byId = new Map(rows.map((r) => [r.conversation_id, r]));
    let dirty = false;
    for (const d of store.dms) {
      const row = byId.get(d.conversation_id);
      const next = row && row.unread ? 1 : 0;
      if ((d.unread ? 1 : 0) !== next) { d.unread = next; dirty = true; }
      if (row) d.last_message_at = row.last_message_at;
    }
    if (dirty) bus.emit('unread');
    if (dirty || fresh.length) renderChannels();
  } catch { /* transient */ }
}

// scroll handler for paging up
//
// The old version fired loadOlder() on any scroll event with scrollTop < 120,
// and scrollTop is 0 for as long as the first page is still being laid out. On a
// 3G phone that is ten seconds, during which it pulled EIGHT more pages nobody
// asked for: 427 messages instead of 49, 27,224 DOM nodes, eight round trips,
// and the newest message not scrolled into view until it was all over. Measured,
// reproducibly, on the first open after every load.
//
// Two gates fix it. Nothing pages until the opening paint has settled, and
// nothing pages until the person has actually moved the list themselves - a
// scroll event the app caused by scrolling to the bottom is not a request for
// history.
let pageGate = 0;
let userScrolled = false;

export function armPaging(delayMs = 900) {
  pageGate = Date.now() + delayMs;
  userScrolled = false;
}

export function wireScroll() {
  const list = $('messages');
  if (!list) return;
  let lastTop = 0;
  list.addEventListener('scroll', () => {
    if (list.scrollTop !== lastTop) {
      if (list.scrollTop > 0 || lastTop > 0) userScrolled = true;
      lastTop = list.scrollTop;
    }
  }, { passive: true });
  for (const ev of ['wheel', 'touchmove', 'keydown']) {
    list.addEventListener(ev, () => { userScrolled = true; }, { passive: true });
  }

  list.addEventListener('scroll', debounce(() => {
    const scrollable = list.scrollHeight - list.clientHeight > 40;
    if (list.scrollTop < 120 && Date.now() > pageGate && (userScrolled || !scrollable)) {
      // Rows this client already had and trimmed out of the DOM come back first.
      // They cost no round trip at all.
      if (!restoreAbove(list)) loadOlder();
    }
    if (atBottom(list, 60)) {
      if (restoreBelow(list)) return;      // more tail to bring back before the button goes
      // Reaching the bottom yourself is the same as having read them, so the
      // count has to go with the pill. It used to only remove the node, and the
      // counter lived on: after five had been read the next arrival said six.
      clearNewBelow();
    }
  }, 120));
}

// Profiles arrived after the rows did. Repaint the author names that are now
// knowable; see repaintAuthors in core/messages.js for why nothing else does.
bus.on('profiles', () => repaintAuthors());

bus.on('channel:request', ({ channelId }) => {
  const c = store.channels.find((x) => x.id === channelId);
  if (c) openChannel(c);
});

// ------------------------------------------------------------------ triggers
// This is the whole point of the rewrite: reconciliation is driven by things
// that HAPPEN, not by a stopwatch. A rejoin is Discord's RESUME moment - the
// socket was away, so by definition it missed whatever was published while it
// was gone, and the cursor is the only thing that can say what.
bus.on('realtime:subscribed', ({ key, rejoined }) => {
  if (!rejoined) return;                        // a first join has nothing to catch up on
  if (key === 'chan' || key === 'user' || key === 'ws') requestResync('rejoin:' + key);
});

// A topic going down is the earliest honest signal that delivery has stopped.
// Nothing can be fetched until it is back, but the moment it is, resync.
bus.on('realtime:down', ({ key }) => { delivery.lastReason = 'down:' + key; });
