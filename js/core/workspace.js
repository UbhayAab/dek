// Workspace (Space) lifecycle: the left rail of orgs, one-call bootstrap, and
// invite links. Dek is multi-org: an admin shares one link and the person who
// opens it lands in exactly that Space.
import { api, table, tryRpc } from '../api.js';
import { sb, subscribe } from '../sb.js';
import { store, bus, hasPerm, setBadges } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc, initials, hueOf, debounceLead, debounce } from '../util.js';
import { icon } from '../icons.js';
import { toast, formModal, modal, confirmModal, typeToConfirm, contextMenu, renderHeaderButtons } from '../ui.js';
import { renderChannels, openChannel, refreshUnread, lastChannelId } from './channels.js';
import { embed, pinnedSpaceOf } from '../embed.js';

// ------------------------------------------------------------------ rail
// The rail groups by ORGANISATION. Until 0064 there was nothing to group by:
// create_space minted a fresh organizations row per Space, so every server was
// its own org and the rail was a flat list of unrelated icons. Measured on the
// live database before that migration: 150 workspaces, 150 organizations, and no
// organization with more than one workspace - which is exactly the thing that was
// reported as "a server itself is an organization".
//
// One group per org, its name above its servers, and the servers of an org that
// this person has not joined reachable through the directory at the end of the
// group rather than being invisible.
export function renderSpaceRail() {
  const r = $('spaceRail');
  if (!r) return;
  const orgs = store.orgs || [];
  const byOrg = new Map();
  for (const s of store.spaces) {
    const k = s.org_id || '';
    if (!byOrg.has(k)) byOrg.set(k, []);
    byOrg.get(k).push(s);
  }

  // This shadows the imported icon() for the length of renderSpaceRail, which is
  // deliberate: in here "icon" has only ever meant a Space's rail tile. Anything
  // that wants a glyph from the SVG set has to be built outside this function.
  const icon = (s) => {
    const b = store.spaceBadges.get(s.id);
    const active = store.ws?.id === s.id;
    // An archived server, or one counting down to deletion, has to LOOK different.
    // Painting it identically is why "I deleted it" and "it is still there" were
    // the same screen.
    const dead = !!(s.archived_at || s.scheduled_delete_at);
    const why = s.scheduled_delete_at ? ' (being deleted)' : s.archived_at ? ' (archived)' : '';
    // The org's own face. icon_key is the white-label surface: an organisation
    // that uploaded a logo sees THAT here, not our letter tile.
    const face = s.icon_key
      ? `<img data-akey="${esc(s.icon_key)}" alt="" />`
      : esc(initials(s.name));
    return `<div class="sicon${active ? ' active' : ''}${dead ? ' sicon-off' : ''}" data-ws="${s.id}"
      title="${esc((s.name || '') + why)}"
      style="--h:${hueOf(s.id)}">${face}
      ${b?.mention_total ? `<span class="sbadge">${b.mention_total}</span>`
        : b?.unread_total ? '<span class="sdot"></span>' : ''}</div>`;
  };

  let h = '';
  const placed = new Set();
  for (const o of orgs) {
    const mine = byOrg.get(o.org_id) || [];
    // An org counting down to deletion has to LOOK different, for exactly the
    // reason a dying Space does: scheduling the delete used to change nothing on
    // this bar for seven days, so "I deleted it" and "it is still there" were the
    // same screen and the button read as broken.
    const dying = !!o.scheduled_delete_at;
    // An org contributing none of my servers gets no heading and no separator -
    // that furniture is what turned an org I had left into a ghost sitting on the
    // rail with nothing under it. One tile is enough to get back in through.
    const bare = mine.length === 0;
    const why = dying ? ' (being deleted)' : bare ? ' (no servers you are in)' : '';
    // The label is what turns "five icons" into "these three are Jarurat Care".
    // Only worth drawing when the person is actually in more than one org.
    if (orgs.length > 1 && !bare) {
      h += `<div class="sorg-label${dying ? ' sorg-off' : ''}" data-org="${o.org_id}"
        title="${esc(o.name + why)}">${esc(initials(o.name))}</div>`;
    }
    for (const s of mine) { h += icon(s); placed.add(s.id); }
    // "in that org there can be multiple servers, which they can look into"
    h += `<div class="sicon sorg-more${dying || bare ? ' sicon-off' : ''}" data-org="${o.org_id}"
      title="${esc((bare ? o.name : 'Servers in ' + o.name) + why)}">…</div>`;
    if (orgs.length > 1 && !bare) h += '<div class="sorg-sep"></div>';
  }
  // A Space whose org this person is not a member of - the demo Space, or one
  // joined by a plain Space invite. Still theirs; just not under a heading.
  for (const s of store.spaces) if (!placed.has(s.id)) h += icon(s);

  h += `<div class="sicon add" data-add="1" title="Create or join">+</div>`;
  r.innerHTML = h;
  // Hydrate any org logos the rail just painted (same signed-URL pipeline as
  // message avatars; dynamic import keeps the module graph cycle-free).
  import('./messages.js').then(({ hydrateAvatars }) => hydrateAvatars(r)).catch(() => {});
  r.querySelectorAll('[data-ws]').forEach((n) => {
    const spaceOf = () => store.spaces.find((x) => x.id === n.dataset.ws);
    n.onclick = () => {
      const s = spaceOf();
      if (s && s.id !== store.ws?.id) switchWorkspace(s);
    };
    n.oncontextmenu = (e) => { e.preventDefault(); spaceMenu(e, spaceOf()); };
    // Long press, because right-click is not a gesture a phone has and this menu
    // is the only place Leave lives for somebody who is not an admin.
    let timer = null;
    let fired = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    n.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      fired = false;
      timer = setTimeout(() => {
        fired = true;
        spaceMenu({ clientX: e.clientX, clientY: e.clientY }, spaceOf());
      }, 500);
    });
    for (const evt of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) {
      n.addEventListener(evt, cancel);
    }
    // Swallow the click the long-press would otherwise also produce, or the menu
    // opens and the Space switches underneath it.
    n.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); fired = false; } }, true);
  });
  r.querySelectorAll('[data-org]').forEach((n) => {
    const orgOf = () => (store.orgs || []).find((o) => o.org_id === n.dataset.org);
    // A plain click opens the MENU, not the directory. Leaving and deleting an
    // organisation lived only behind the right-click and long-press below, which
    // is a gesture a laptop user does not think to try on a small tile and a
    // phone user has never been told about. Reported as "I wanted to delete it,
    // it's still there on my left bar" and "I want to leave one of these
    // organisations and I don't have the option". Nothing is lost: the menu's
    // second row is the directory this used to open.
    n.onclick = (e) => { e.preventDefault(); orgMenu(e, orgOf()); };
    // The org tile had a left-click and nothing else, so leaving or deleting an
    // organisation lived only at #/admin and the rail offered no way out of one
    // at all. Same gesture pair the Space tiles use, for the same reason.
    n.oncontextmenu = (e) => { e.preventDefault(); orgMenu(e, orgOf()); };
    let timer = null;
    let fired = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    n.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      fired = false;
      timer = setTimeout(() => {
        fired = true;
        orgMenu({ clientX: e.clientX, clientY: e.clientY }, orgOf());
      }, 500);
    });
    for (const evt of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) {
      n.addEventListener(evt, cancel);
    }
    n.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); fired = false; } }, true);
  });
  r.querySelector('[data-add]').onclick = spaceChooser;
}

// Everything you can do to an ORGANISATION, on the organisation's own tile.
//
// Before this the tile answered one gesture - left click, open the directory -
// and the two things people actually wanted from an org they regretted were
// somewhere else entirely: leaving lived inside a Space's admin panel, deleting
// lived on a separate page at #/admin. So an organisation you had left every
// server of sat on the rail with no visible way to be rid of it, which is what
// "the ghost of that organization still stays on my left bar" describes.
//
// It is no longer the tile's alone. The rail is hidden outright on some
// devices, and it was the ONLY caller of this menu, so every command below went
// with it: invite, the directory, manage, leave, delete, and cancelling a
// countdown. The organisation heading in the drawer's Servers group calls this
// too now (js/core/channels.js, the [data-orgmenu] handler), which is why it is
// exported rather than local. Anything added here has to read sensibly from a
// drawer row as well as from a 44px tile.
export function orgMenu(ev, org) {
  if (!org) return;
  const admin = org.org_role === 'admin';
  const dying = !!org.scheduled_delete_at;
  const items = [
    { label: 'Invite people to ' + org.name, onClick: () => orgInviteDialog(org.org_id) },
    { label: 'Servers in ' + org.name, onClick: () => orgDirectory(org.org_id) },
  ];
  if (admin) {
    items.push({
      label: 'Manage organisation',
      onClick: () => import('../features/orgadmin.js')
        .then(({ openAdminPage }) => openAdminPage(org.org_id))
        .catch(() => toast('The organisation console did not load', 'error')),
    });
  }
  items.push('-');

  if (dying) {
    // The countdown is reversible right up until it is not, so the way back is
    // the first thing offered, and finishing it early is the deliberate second.
    items.push({
      label: 'Cancel deletion',
      onClick: async () => {
        try {
          await api.restoreOrganization(org.org_id);
          await loadSpaces();
          toast('Deletion cancelled. Every server is back.', 'success');
        } catch (e) { toast(serverError(e), 'error'); }
      },
    });
    if (admin) {
      items.push({
        label: 'Delete now',
        danger: true,
        onClick: async () => {
          const ok = await confirmModal({
            title: 'Finish deleting ' + org.name + ' now?',
            body: 'This skips the rest of the seven days. Every server, channel, message and '
                + 'file in it goes immediately, and nothing brings it back.',
            confirmLabel: 'Delete now',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.purgeOrgNow(org.org_id);
            await loadSpaces();
            toast(org.name + ' is gone.', 'success');
          } catch (e) { toast(serverError(e), 'error'); }
        },
      });
    }
  } else {
    items.push({
      label: 'Leave ' + org.name,
      danger: true,
      onClick: async () => {
        const alone = org.spaces === 0 || org.my_spaces === 0;
        const ok = await confirmModal({
          title: 'Leave ' + org.name + '?',
          body: alone
            ? 'You lose your place in this organisation and it stops showing on your rail.'
            : 'You leave every server in it too, and it stops showing on your rail.',
          confirmLabel: 'Leave',
          danger: true,
        });
        if (!ok) return;
        try {
          // Standing inside one of its servers when you leave? loadSpaces()
          // refreshes the rail and nothing else, so store.ws, store.channels and
          // the messages already painted all stayed exactly as they were and the
          // channel you had just lost access to was still on screen, still
          // scrollable, answering from cache. leaveSpace has always navigated
          // away afterwards; this path never did.
          const wasInside = store.ws?.org_id === org.org_id;
          await api.leaveOrg(org.org_id);
          await loadSpaces();
          if (wasInside) {
            const next = store.spaces.find((x) => !x.archived_at && !x.scheduled_delete_at)
              || store.spaces[0];
            // Nothing left to go to: a full reload is the only way to clear the
            // rendered channel, the caches and the subscriptions in one move.
            if (next) await switchWorkspace(next);
            else { location.hash = ''; location.reload(); return; }
          }
          toast('You have left ' + org.name + '.', 'success');
        } catch (e) { toast(serverError(e), 'error'); }
      },
    });
    if (admin) {
      items.push({
        label: 'Delete ' + org.name,
        danger: true,
        onClick: async () => {
          const ok = await typeToConfirm({
            title: 'Delete ' + org.name,
            body: `Everything in ${org.name} goes: every server, every channel, every message and `
                + 'file, and everybody\'s place in it. It is scheduled for seven days out so you '
                + 'can still stop it, and after that nothing brings it back.',
            phrase: org.name,
            confirmLabel: 'Schedule deletion',
          });
          if (!ok) return;
          try {
            const when = await api.deleteOrganization(org.org_id);
            await loadSpaces();
            toast(`Scheduled for ${new Date(when).toLocaleDateString()}. You can still cancel it.`,
              'success');
          } catch (e) { toast(serverError(e), 'error'); }
        },
      });
    }
  }
  contextMenu(ev, items);
}

// Turn a raise from the server into a sentence. The leave path used to print
// e.message straight into a toast, so somebody who tried to leave a server they
// were the only admin of read the words "last_admin_cannot_leave" and reasonably
// concluded the button was broken.
export function serverError(e) {
  const m = String(e?.message || '');
  if (/last_admin_cannot_leave/.test(m)) {
    return 'You are the only admin of this server, and the organisation has no admin either, '
         + 'so nobody could take it on after you. Hand it over to somebody first.';
  }
  if (/last_admin/.test(m)) {
    return 'You are the only admin, and other people are still in here. Make somebody else '
         + 'an admin first, or delete the organisation instead.';
  }
  if (/not_a_member/.test(m)) return 'You are not in that organisation any more.';
  if (/org_deleted/.test(m)) return 'That organisation is being deleted, so it takes no new people.';
  if (/not_in_server/.test(m)) return 'They are not in this server. Add them to it first.';
  if (/not_scheduled/.test(m)) return 'Schedule the deletion first.';
  if (/workspace_archived/.test(m)) return 'This server is archived, so it takes no new messages.';
  if (/no_such_workspace/.test(m)) return 'That server no longer exists.';
  if (/forbidden/.test(m)) return 'You do not have permission to do that here.';
  return m || 'That did not work.';
}

// Who could take this server on. Read from workspace_members rather than the
// roster cache, because the person leaving may be looking at a server they have
// not opened in this session.
async function otherMembers(wsId) {
  const rows = await table('workspace_members', (q) => q.eq('workspace_id', wsId));
  const ids = rows.map((r) => r.user_id).filter((id) => id !== store.me);
  if (!ids.length) return [];
  const profs = await table('profiles', (q) => q.in('id', ids));
  const byId = new Map(profs.map((p) => [p.id, p]));
  return ids.map((id) => ({
    id,
    name: byId.get(id)?.display_name || byId.get(id)?.username || 'someone',
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// The move the old error message told you to make and gave you no way to make.
export async function handOverDialog(s, { thenLeave = false } = {}) {
  let people;
  try { people = await otherMembers(s.id); }
  catch (e) { toast(serverError(e), 'error'); return false; }

  if (!people.length) {
    await confirmModal({
      title: 'Nobody to hand ' + (s.name || 'this server') + ' to',
      body: 'You are the only person in it. Ask an admin of the organisation to take it over, '
          + 'or delete the server instead.',
      confirmLabel: 'Close',
    });
    return false;
  }

  const out = await formModal({
    title: 'Hand over ' + (s.name || 'this server'),
    note: thenLeave
      ? 'They become an admin of this server, and then you leave it.'
      : 'They become an admin of this server. You keep everything you have.',
    fields: [{
      name: 'user', label: 'Make this person an admin', type: 'select', required: true,
      options: people.map((p) => ({ value: p.id, label: p.name })),
    }],
    submitLabel: thenLeave ? 'Hand over and leave' : 'Hand over',
  });
  if (!out) return false;

  try {
    await api.transferWorkspaceAdmin(s.id, out.user);
    if (!thenLeave) { toast('Handed over', 'success'); return true; }
    await api.leaveWorkspace(s.id);
    toast('Handed over, and you have left ' + (s.name || 'the server'), 'success');
    await loadSpaces();
    if (store.spaces[0]) await switchWorkspace(store.spaces[0]);
    else location.reload();
    return true;
  } catch (e) { toast(serverError(e), 'error'); return false; }
}

export async function leaveSpace(s) {
  if (!s) return;
  // Roadmap 9 pin guard. Embedded, membership is provisioned by the host
  // dashboard; leaving from inside a 400px frame silently orphans this person's
  // account behind a panel that then has nothing to show. The host owns the way
  // out, so the client does not offer one.
  if (embed.active) {
    toast('Membership is managed from your dashboard, so you cannot leave a server from here.');
    return;
  }
  if (!(await confirmModal({
    title: 'Leave ' + (s.name || 'this server') + '?',
    body: 'You lose access immediately and need a fresh invite to come back. '
        + 'Anything you have written stays.',
    confirmLabel: 'Leave', danger: true,
  }))) return;

  try {
    await api.leaveWorkspace(s.id);
    toast('Left ' + (s.name || 'the server'));
    await loadSpaces();
    if (store.spaces[0]) await switchWorkspace(store.spaces[0]);
    else location.reload();
  } catch (e) {
    // The one refusal that has a way out: offer it here rather than making them
    // find the hand-over screen themselves.
    if (/last_admin_cannot_leave/.test(String(e?.message || ''))) {
      const ok = await confirmModal({
        title: 'Hand it over first',
        body: serverError(e),
        confirmLabel: 'Choose somebody',
      });
      if (ok) await handOverDialog(s, { thenLeave: true });
      return;
    }
    toast(serverError(e), 'error');
  }
}

// One menu, reachable three ways: click the server name in the top bar,
// right-click its icon in the rail, or long-press that icon on a phone. Leave
// used to live only on the right-click, which is not a gesture a phone has.
// Exported since the phone drawer draws its own server rows and needs the same
// menu the rail tile carries.
export function spaceMenu(ev, s) {
  if (!s) return;
  const iAmOrgAdmin = (store.orgs || [])
    .find((o) => o.org_id === s.org_id)?.org_role === 'admin';
  const iRunThis = iAmOrgAdmin || (store.ws?.id === s.id && store.isAdmin);

  // Built as a list rather than passed with show flags: contextMenu tests
  // `show === false` literally, and hiding entries in place would leave the
  // separators around them stranded.
  const items = [];
  const canInvite = store.ws?.id !== s.id || hasPerm(PERM.CREATE_INVITE);
  if (canInvite) {
    items.push({ label: 'Invite people', onClick: () => inviteDialog(s) });
    items.push({ label: 'Copy invite link', onClick: () => copyInvite(s) });
  }
  if (iAmOrgAdmin || iRunThis) {
    if (items.length) items.push('-');
    if (iAmOrgAdmin) {
      items.push({ label: 'Organisation settings',
        onClick: () => bus.emit('orgadmin:open', { orgId: s.org_id }) });
    }
    items.push({ label: 'Hand this server over', onClick: () => handOverDialog(s) });
  }
  // Embedded, leaveSpace refuses - never offer the menu row that leads there,
  // and take its separator with it so the menu cannot end on a stray line.
  if (!embed.active) {
    if (items.length) items.push('-');
    items.push({ label: 'Leave this server', danger: true, onClick: () => leaveSpace(s) });
  }
  contextMenu(ev, items);
}

// ------------------------------------------------------------------ load
export async function loadSpaces() {
  const rows = await table('workspaces', (q) => q.order('created_at'));
  store.spaces = rows;
  // Which organisations this person belongs to, for the rail's grouping and for
  // "can I make a server here". tryRpc rather than rpc: a client that reaches a
  // deployment without 0064 gets an empty list and the flat rail it had before,
  // rather than a broken sign-in.
  const [orgs] = await tryRpc('my_orgs', {});
  store.orgs = Array.isArray(orgs) ? orgs : [];
  // Via the shared wrapper, not a bare tryRpc: refreshUnread's full tail asks
  // for the same rollup seconds later and api.spaceSummary() dedups that.
  try {
    const summary = await api.spaceSummary();
    if (Array.isArray(summary)) {
      store.spaceBadges = new Map(summary.map((s) => [s.workspace_id, s]));
    }
  } catch { /* the rail just keeps its last state */ }
  renderSpaceRail();
  return rows;
}

// ------------------------------------------------------------------ the directory
// ONE DIRECTORY, NOT TWO. This used to be a modal that listed a single
// organisation, had no search, and was reached by right-clicking a tile in a
// rail that no longer exists. features/servers.js replaced it with a panel that
// lists every server in EVERY organisation at once, searchable, with a button
// that joins all the open ones in one tap - which is what the complaint was
// actually asking for: people could not see the other servers, and needed to be
// able to join them easily, by search or by group.
//
// Kept as a function because four call sites ask for it by name, and because
// "Servers in <organisation>" is a sharper question than "find a server": the
// panel opens filtered to that organisation. The modal's three footer buttons
// all survive elsewhere - New server is the sidebar's "Create or join a Space"
// row, and Invite people and People and roles are both in orgMenu above.
export async function orgDirectory(orgId) {
  const org = (store.orgs || []).find((o) => o.org_id === orgId);
  const { openPanel } = await import('../ui.js');
  return openPanel('servers', { q: org?.name || '' });
}

// joinError lived here for the directory modal's Join button. The directory is
// features/servers.js now and carries its own explain(), so this had no caller
// left. Removed rather than kept "in case", because a second copy of the same
// three sentences is how two surfaces end up wording a refusal differently.

// ------------------------------------------------------------------ make a server
export async function createTeamSpaceDialog(orgId) {
  const org = (store.orgs || []).find((o) => o.org_id === orgId);
  const out = await formModal({
    title: 'New server' + (org ? ' in ' + org.name : ''),
    note: 'A server is one team: HR, tech, design. It has its own channels and its '
        + 'own members, and nobody outside it can read what is said inside.',
    fields: [
      { name: 'name', label: 'Server name', required: true, placeholder: 'HR' },
      { name: 'join_policy', label: 'Who can join', type: 'select', value: 'invite',
        options: [
          { value: 'invite', label: 'Only people who are added (private)' },
          { value: 'open', label: 'Anyone in ' + (org?.name || 'this organisation') },
        ] },
    ],
    submitLabel: 'Create server',
  });
  if (!out) return;
  try {
    const ws = await api.rpc('create_team_space', {
      p_org: orgId, p_name: out.name.trim(), p_join_policy: out.join_policy || 'invite',
    });
    await loadSpaces();
    const s = store.spaces.find((x) => x.id === ws?.id) || ws;
    if (s) await switchWorkspace(s);
    toast('Created ' + (ws?.name || out.name));
  } catch (e) { toast(e.message || 'Could not create that server', 'error'); }
}

// ------------------------------------------------------------------ org invite
// The one door to the share sheet, kept at this name because the rail menu, the
// servers directory and the + chooser all already call it.
//
// It used to BE the flow: a three-field form that asked for a role, a use cap
// and an expiry before it would give you anything, then printed a URL in a
// read-only input. Nobody sharing an organisation with the twenty-two people in
// their sales area wants to answer three questions first, and none of those
// three answers is one they had an opinion about. The sheet in features/orgshare
// opens with a working link already made and puts the QR code first, because the
// real gesture is holding a phone up in a room. Dynamic import so the QR encoder
// is not in the boot path of a client that never opens it.
export async function orgInviteDialog(orgId) {
  try {
    const { openShareSheet } = await import('../features/orgshare.js');
    await openShareSheet(orgId);
  } catch (e) {
    toast(e?.message || 'Could not open the invite sheet', 'error');
  }
}

// ------------------------------------------------------------------ org people
export async function orgPeopleDialog(orgId) {
  const org = (store.orgs || []).find((o) => o.org_id === orgId);
  const box = el('div', 'orgppl');
  box.innerHTML = '<div class="muted pad">loading…</div>';
  modal({ title: 'People in ' + (org?.name || 'this organisation'), body: box, wide: true });
  const paint = async () => {
    const [rows] = await tryRpc('list_org_members', { p_org: orgId });
    const list = Array.isArray(rows) ? rows : [];
    const iAmAdmin = (store.orgs || []).find((o) => o.org_id === orgId)?.org_role === 'admin';
    box.innerHTML = list.map((p) => `
      <div class="orgppl-row" data-u="${p.user_id}" data-name="${esc(p.display_name || '')}">
        <span class="orgdir-ico" style="--h:${hueOf(p.user_id)}">${esc(initials(p.display_name))}</span>
        <b class="orgppl-name">${esc(p.display_name)}</b>
        <select data-role>
          <option value="member"${p.org_role === 'member' ? ' selected' : ''}>Member</option>
          <option value="admin"${p.org_role === 'admin' ? ' selected' : ''}>Admin</option>
        </select>
        ${iAmAdmin && p.user_id !== store.me
          ? '<button class="sm danger" data-remove>Remove</button>'
          : (p.user_id === store.me ? '<span class="muted orgppl-you">you</span>' : '')}
      </div>`).join('') || '<div class="empty">Nobody yet.</div>';

    // Removing somebody from the organisation, which also takes them out of
    // every server inside it. Kicking from one server is the Space-level action
    // and lives in the admin console; this is the one that means "they have
    // left". Named for what it does to the person, not to the row.
    box.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = async () => {
        const row = btn.closest('.orgppl-row');
        const who = row.dataset.name || 'this person';
        const ok = await confirmModal({
          title: `Remove ${who}?`,
          body: `They lose access to ${org?.name || 'this organisation'} and every server inside it, `
              + 'straight away. Anything they have already written stays. They can be added again later.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          await api.removeOrgMember(orgId, row.dataset.u);
          toast(`${who} removed`, 'success');
          await paint();
        } catch (err) {
          toast(/last_admin/.test(err.message || '')
            ? 'That is the only admin left. Make somebody else an admin first.'
            : err.message || 'Could not remove them', 'error');
          btn.disabled = false;
        }
      };
    });

    box.querySelectorAll('.orgppl-row').forEach((row) => {
      row.querySelector('[data-role]').onchange = async (e) => {
        const value = e.target.value;
        try {
          await api.rpc('set_org_role', { p_org: orgId, p_user: row.dataset.u, p_role: value });
          toast('Role updated');
          const o = (store.orgs || []).find((x) => x.org_id === orgId);
          if (o && row.dataset.u === store.me) o.org_role = value;
        } catch (err) {
          toast(/last_admin/.test(err.message || '')
            ? 'That is the only admin left. Make somebody else an admin first.'
            : err.message || 'Could not change that role', 'error');
          await paint();
        }
      };
    });
  };
  await paint().catch(() => { box.innerHTML = '<div class="empty">Could not load the members.</div>'; });
}

// One round trip for the whole workspace. Falls back to individual queries when
// the consolidated RPC is unavailable, so the client never hard-depends on it.
// Loading a Space is the slowest thing this app does and the one most likely to
// be interrupted: it is one large round trip, and the people using this are on
// mobile data. When it did not finish, nothing said so. The shell had already
// painted, the conversation had not, and the result was a screen with a sidebar
// and nothing in it - which is what "blank screen" meant every time it was
// reported. A request that hangs forever is worse than one that fails, because
// only the failure can be told to the person.
const BOOTSTRAP_TIMEOUT_MS = 12000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);
}

// The screen for "we could not load this". Never silent, always has a way out.
function showSpaceFailed(target, err) {
  const box = $('messages');
  if (!box) return;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  box.innerHTML = `
    <div class="loadfail">
      <h2>Could not open ${esc(target?.name || 'this Space')}</h2>
      <p class="muted">${offline
        ? 'Your phone is offline. Nothing is wrong with your account - this screen comes back as soon as you have signal.'
        : 'The connection dropped part way through loading it. Nothing is lost and nothing is wrong with your account.'}</p>
      <button id="spaceRetry" class="wide">Try again</button>
      <p class="muted fineprint">${esc(err?.message || 'no further detail')}</p>
    </div>`;
  const btn = $('spaceRetry');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try { await switchWorkspace(target); }
      catch { btn.disabled = false; btn.textContent = 'Try again'; }
    };
  }
}

export async function switchWorkspace(target) {
  if (!target) return;
  // Roadmap 9 pin guard. Embedded, the host named one Space in the iframe src
  // and the panel booted into it; every switch surface (rail icons, the org
  // directory, post-join flows) funnels through here, so one guard covers them.
  // Only binds once the pin is actually ON screen - a misconfigured embed that
  // resolved no Space keeps today's free navigation rather than getting stranger.
  if (embed.active && store.ws?.id && target.id !== store.ws.id
      && store.ws.id === pinnedSpaceOf(store.spaces)?.id) {
    toast('Your dashboard pinned this panel to ' + (store.ws.name || 'this server') + '.');
    return;
  }
  store.ws = target;
  store.current = null;
  store.currentDM = null;
  // Admin is a fact about a person IN A SPACE. Carrying the last Space's answer
  // across would badge somebody who is an ordinary member here, for the moment
  // before the bootstrap below refills it.
  setBadges([]);
  // The server name is the menu, Discord-style. Before this the only route to
  // Leave was a right-click on the rail icon, which nothing advertised and a
  // phone cannot perform.
  const nameEl = $('spaceName');
  if (nameEl) {
    nameEl.textContent = target.name || '';
    nameEl.classList.add('spacename-menu');
    nameEl.setAttribute('role', 'button');
    nameEl.setAttribute('tabindex', '0');
    nameEl.title = 'Server menu';
    nameEl.onclick = (e) => spaceMenu(e, store.ws);
    nameEl.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const r = nameEl.getBoundingClientRect();
      spaceMenu({ clientX: r.left, clientY: r.bottom }, store.ws);
    };
  }
  renderSpaceRail();

  // Say that something is happening. An empty conversation area for ten seconds
  // reads as broken; the same ten seconds with a line of text reads as loading.
  const msgs = $('messages');
  if (msgs && !msgs.querySelector('.msg')) {
    msgs.innerHTML = `<div class="loading-space"><span class="spin"></span>Opening ${esc(target.name || 'this Space')}…</div>`;
  }

  let boot = null;
  let bootErr = null;
  try {
    // tryRpc RETURNS the error rather than throwing it, so destructuring only
    // the first element threw the failure away and left bootErr null - which
    // meant a Space that genuinely could not load fell through to the empty
    // state and said "no channels here yet". The error is the whole point.
    const [data, err] = await withTimeout(tryRpc('get_bootstrap', { p_workspace: target.id }),
      BOOTSTRAP_TIMEOUT_MS, 'Loading this Space');
    boot = data;
    bootErr = err;
  } catch (e) { bootErr = e; }

  if (!boot?.channels) {
    // The pre-0047 fallback is a second chance, not a guarantee. If it cannot
    // produce channels either, this Space did not load and that is the whole
    // truth - so say it rather than painting an empty room.
    try {
      await withTimeout(legacyLoad(target), BOOTSTRAP_TIMEOUT_MS, 'Loading this Space');
    } catch (e) { bootErr = bootErr || e; }
    if (!store.channels?.length) {
      // A Space really can have no channels. Only call it a failure when
      // something actually failed.
      if (bootErr) { showSpaceFailed(target, bootErr); return; }
    }
  }

  if (boot && boot.channels) {
    store.categories = boot.categories || [];
    store.channels = boot.channels || [];
    store.dms = boot.dms || [];
    store.profiles = new Map((boot.members || []).map((m) => [m.user_id, { id: m.user_id, ...m }]));
    // Kept beside the profiles rather than inside them: see store.badges.
    setBadges(boot.members || []);
    store.online = new Set((boot.members || []).filter((m) => m.online).map((m) => m.user_id));
    // The member list REPLACED here, silently, was the last piece of the
    // "someone" bug. This app is local-first: pagecache paints the previous
    // conversation before the network answers, so rows are already on screen
    // when the bootstrap lands. Every other place that touches store.profiles
    // emits this - member_joined, member_status, reloadMembers - and the one
    // that replaces the whole map did not, so nothing repainted the names it
    // had just made knowable. Rows kept saying "someone" until something
    // unrelated re-rendered them.
    bus.emit('profiles');
    store.unread = new Map((boot.unread || []).map((u) => [u.scope_id, u]));
    store.notify = new Map((boot.notify || []).map((n) => [n.scope_id, n]));
    store.drafts = new Map((boot.drafts || []).map((d) => [d.scope_type + ':' + d.scope_id, d.body_text]));
    store.voiceParts = new Map();
    for (const v of boot.voice || []) {
      if (!store.voiceParts.has(v.channel_id)) store.voiceParts.set(v.channel_id, []);
      store.voiceParts.get(v.channel_id).push(v.user_id);
    }
    store.perms = BigInt(boot.me?.permissions ?? 0);
    store.isAdmin = !!boot.me?.is_admin || (store.perms & PERM.ADMINISTRATOR) !== 0n;
    if (boot.me) store.myProfile = { id: store.me, ...boot.me };
  }
  // legacyLoad already ran above when the bootstrap came back empty; running it
  // a second time here was a duplicate round trip on the slowest path there is.

  bus.emit('workspace', { ws: target });
  // Not awaited: a badge is not worth holding the first channel for, and rows
  // already painted are patched when it lands (messages.js repaintAdminPills).
  reloadAdmins();
  renderHeaderButtons();
  await renderChannels();
  subscribeWorkspace(target);

  // Open where they left off. Two reasons, and the second is the important one:
  // going back to the conversation you were in is what every other chat app
  // does, and the cold-start paint has ALREADY drawn that channel from this
  // phone's storage - opening a different one instead would swap the screen out
  // from under the person a few seconds after showing it to them.
  // Explicitly THIS server's memory. Passing target rather than reading store.ws
  // matters: this runs during the switch, so the two are not the same thing yet.
  const lastId = lastChannelId(target.id);
  const first = store.channels.find((c) => c.id === lastId && c.kind !== 'voice' && !c.archived_at)
    // What the Space chose for people arriving, before falling back to a name
    // this code happens to know. Somebody's first view of an organisation
    // should be the channel its admin picked, not whichever sorts first.
    || store.channels.find((c) => c.id === target.default_channel_id && !c.archived_at)
    || store.channels.find((c) => c.name === 'general' && c.kind !== 'voice')
    || store.channels.find((c) => c.kind !== 'voice' && !c.archived_at);
  if (first) {
    await openChannel(first);
  } else {
    // Genuinely no channels, as distinct from "we could not load them" - which
    // is handled above and says something completely different. The two used to
    // render the same sentence, so an admin whose Space failed to load was told
    // their Space was empty.
    const canMake = (store.perms & PERM.MANAGE_CHANNELS) !== 0n
      || (store.perms & PERM.ADMINISTRATOR) !== 0n;
    $('messages').innerHTML = `<div class="empty">
      <b>${esc(target.name || 'This Space')} has no channels yet.</b><br />
      ${canMake
        ? 'Use ＋ Add channel in the sidebar to make the first one.'
        : 'Ask whoever runs this Space to create one.'}</div>`;
  }
}

// Pre-0047 path: individual queries. Kept so a stale deploy still works.
async function legacyLoad(target) {
  const [cats, chans, mem] = await Promise.all([
    table('categories', (q) => q.eq('workspace_id', target.id).order('position')),
    table('channels', (q) => q.eq('workspace_id', target.id).order('position')),
    table('workspace_members', (q) => q.eq('workspace_id', target.id)),
  ]);
  store.categories = cats;
  store.channels = chans;
  const ids = mem.map((m) => m.user_id);
  if (ids.length) {
    const profs = await table('profiles', (q) => q.in('id', ids));
    store.profiles = new Map(profs.map((p) => [p.id, p]));
  }
  const convs = await table('conversations', (q) => q.eq('workspace_id', target.id));
  const convIds = convs.map((c) => c.id);
  const cmem = convIds.length ? await table('conversation_members', (q) => q.in('conversation_id', convIds)) : [];
  store.dms = convs.map((c) => ({
    conversation_id: c.id, kind: c.kind,
    other_user_ids: cmem.filter((m) => m.conversation_id === c.id).map((m) => m.user_id),
    last_message_at: c.last_message_at, unread: 0,
  }));
  const [unread] = await tryRpc('get_unread', { p_workspace: target.id });
  store.unread = new Map((unread || []).map((u) => [u.scope_id, u]));
  const [notif] = await tryRpc('get_notify_settings', { p_workspace: target.id });
  store.notify = new Map((notif?.channels || []).map((n) => [n.scope_id, n]));
  store.myProfile = store.profiles.get(store.me) || store.myProfile;
  store.perms = 0n;
  store.isAdmin = false;
}

function subscribeWorkspace(ws) {
  subscribe('ws', 'ws:' + ws.id, {
    channel_created: () => bus.emit('channels:reload'),
    channel_updated: () => bus.emit('channels:reload'),
    channel_deleted: () => bus.emit('channels:reload'),
    // The payload carries the profile, so one person joining a 300-member Space
    // costs every other client zero queries instead of one each.
    member_joined: (p) => {
      reloadAdminsSoon();
      if (!p?.user_id) { reloadMembers(); return; }
      store.profiles.set(p.user_id, {
        id: p.user_id, display_name: p.display_name, username: p.username,
        avatar_key: p.avatar_key, status_text: p.status_text,
        status_emoji: p.status_emoji, member_type: p.member_type,
      });
      bus.emit('profiles');
    },
    member_left: (p) => {
      if (p?.user_id) store.profiles.delete(p.user_id);
      bus.emit('profiles');
      reloadAdminsSoon();
    },
    // Somebody tapped "Ask to join" on this server (request_join wrote the row
    // and broadcast this). The admin console caches its queue for the life of
    // the open panel, so announce on the bus - admin.js and onboarding.js
    // invalidate and repaint - and toast whoever is online and can admit people.
    // Without this the request sat in a table nobody re-read: the exact
    // "admin never receives anything" report.
    join_request: () => {
      bus.emit('join-requests', { workspace: ws.id });
      if (store.ws?.id === ws.id
        && (hasPerm(PERM.MANAGE_WORKSPACE) || hasPerm(PERM.KICK))) {
        toast('Someone asked to join ' + (ws.name || 'this server')
          + ' - open the admin console to let them in', 'info');
      }
    },
    // Everything 0051 broadcasts that can change who counts as an admin here.
    // set_org_role broadcasts nothing this client hears, which is why the
    // Members panel also re-asks on every open (features/uxfix.js).
    members_updated: () => reloadAdminsSoon(),
    member_updated: () => reloadAdminsSoon(),
    role_updated: () => reloadAdminsSoon(),
    role_deleted: () => reloadAdminsSoon(),
    ownership_transferred: () => reloadAdminsSoon(),
    // A colleague changed their custom status. Without this it only showed up
    // after a full reload: core/presence.js deliberately fetches profiles ONLY
    // for ids it has never seen, so an existing member's status_text was never
    // refetched. 0062 is what publishes this event.
    member_status: (p) => {
      if (!p?.user_id) return;
      const prev = store.profiles.get(p.user_id);
      if (!prev) return;                      // not someone on screen here
      store.profiles.set(p.user_id, {
        ...prev,
        status_text: p.status_text ?? null,
        status_emoji: p.status_emoji ?? null,
      });
      bus.emit('profiles');
    },
  });
}

export async function reloadMembers() {
  if (!store.ws) return;
  const mem = await table('workspace_members', (q) => q.eq('workspace_id', store.ws.id));
  const ids = mem.map((m) => m.user_id);
  if (!ids.length) return;
  const profs = await table('profiles', (q) => q.in('id', ids));
  for (const p of profs) store.profiles.set(p.id, { ...(store.profiles.get(p.id) || {}), ...p });
  bus.emit('profiles');
  reloadAdmins();
}

// Who runs this Space, for everybody in it to see. get_bootstrap already carries
// it per member on a cold start; this is the refresh - after a promotion, on the
// ws-topic role events below, and on every Members open. Any member may call it:
// the RPC returns one bit per person and no permission bitfields, which is the
// whole point. The Members panel used to derive the same thing from
// member_roles, a table RLS hides from anybody who cannot manage roles, so the
// pill was drawn only for people who already knew the answer.
//
// Fire-and-forget. A failed refresh leaves the badges as the bootstrap left
// them, which is the honest fallback.
let adminsGen = 0;
let adminsRpcMissing = false;
export async function reloadAdmins() {
  const ws = store.ws;
  if (!ws || adminsRpcMissing) return false;
  const gen = ++adminsGen;
  const [rows, err] = await tryRpc('get_member_badges', { p_workspace: ws.id });
  if (gen !== adminsGen || store.ws?.id !== ws.id) return false;   // a switch overtook this
  if (err) {
    // PGRST202 = not in the schema cache = migration not applied. Stop asking
    // for the rest of this session instead of once per member event.
    if (err.code === 'PGRST202' || /could not find the function/i.test(err.message || '')) {
      adminsRpcMissing = true;
    }
    return false;
  }
  if (!Array.isArray(rows)) return false;
  const before = JSON.stringify([...store.badges].sort());
  setBadges(rows);
  if (JSON.stringify([...store.badges].sort()) === before) return true;
  // Two events on purpose. 'badges' is the narrow one: the Members panel drops
  // its own five-minute role cache on it, and message rows reconcile their pill.
  // 'profiles' is the broad repaint every surface that draws a name listens for.
  bus.emit('badges');
  bus.emit('profiles');
  return true;
}
// The name the rest of this codebase reaches for. One function, two doors.
export const refreshMemberBadges = reloadAdmins;
// A role change lands as a burst of ws-topic events; one re-read per burst.
const reloadAdminsSoon = debounce(() => { reloadAdmins(); }, 800);

export async function reloadChannels(openId) {
  if (!store.ws) return;
  const [boot] = await tryRpc('get_bootstrap', { p_workspace: store.ws.id });
  if (boot?.channels) {
    store.categories = boot.categories || [];
    store.channels = boot.channels || [];
  } else {
    store.channels = await table('channels', (q) => q.eq('workspace_id', store.ws.id).order('position'));
    store.categories = await table('categories', (q) => q.eq('workspace_id', store.ws.id).order('position'));
  }
  await renderChannels();
  if (openId) {
    const c = store.channels.find((x) => x.id === openId);
    if (c) openChannel(c);
  }
}

// ------------------------------------------------------------------ create / join
export async function spaceChooser() {
  const box = el('div', 'chooser');
  const orgs = store.orgs || [];
  // A server inside an organisation you are already in is the common case now,
  // and it is what "let ppl make servers" asked for - so it is offered first,
  // by name, and every member gets it rather than only admins. Starting a whole
  // new organisation is the rare thing and reads as such.
  box.innerHTML = `
    ${orgs.map((o) => `
    <button class="chooser-card" data-org="${o.org_id}">
      <div class="cc-ico">${icon('plus')}</div><div><b>New server in ${esc(o.name)}</b>
      <div class="muted">One team - HR, tech, design. Its own channels, its own
        members, and nobody outside it can read them.</div></div>
    </button>`).join('')}
    ${orgs.map((o) => `
    <button class="chooser-card" data-dir="${o.org_id}">
      <div class="cc-ico">${icon('folder')}</div><div><b>Browse ${esc(o.name)}</b>
      <div class="muted">${o.spaces} server${o.spaces === 1 ? '' : 's'} - see what exists and join.</div></div>
    </button>`).join('')}
    ${orgs.filter((o) => !o.scheduled_delete_at).map((o) => `
    <button class="chooser-card" data-inv="${o.org_id}">
      <div class="cc-ico">${icon('mail')}</div><div><b>Invite people to ${esc(o.name)}</b>
      <div class="muted">A link that joins the organisation itself, so they land in every
        open server at once instead of being added one at a time.</div></div>
    </button>`).join('')}
    <button class="chooser-card" data-a="create">
      <div class="cc-ico">${icon('building')}</div><div><b>Start a new organisation</b>
      <div class="muted">A separate organisation of your own, unrelated to the ones above.</div></div>
    </button>
    <button class="chooser-card" data-a="join">
      <div class="cc-ico">${icon('link')}</div><div><b>Join with a link</b>
      <div class="muted">Someone sent you an invite link or code? Paste it here.</div></div>
    </button>`;
  const m = modal({ title: 'Servers', body: box });
  box.querySelectorAll('[data-org]').forEach((n) => {
    n.onclick = () => { m.close(); createTeamSpaceDialog(n.dataset.org); };
  });
  box.querySelectorAll('[data-dir]').forEach((n) => {
    n.onclick = () => { m.close(); orgDirectory(n.dataset.dir); };
  });
  box.querySelectorAll('[data-inv]').forEach((n) => {
    n.onclick = () => { m.close(); orgInviteDialog(n.dataset.inv); };
  });
  box.querySelector('[data-a="create"]').onclick = () => { m.close(); createSpaceDialog(); };
  box.querySelector('[data-a="join"]').onclick = () => { m.close(); joinDialog(); };
}

export async function createSpaceDialog() {
  const out = await formModal({
    title: 'Create a Space',
    note: 'A Space is your organization. Channels, members and roles all live inside it.',
    fields: [{ name: 'name', label: 'Space name', required: true, placeholder: 'Acme Inc' }],
    submitLabel: 'Create Space',
  });
  if (!out) return;
  try {
    const data = await api.createSpace(out.name.trim());
    await loadSpaces();
    const s = store.spaces.find((x) => x.id === data.id) || data;
    await switchWorkspace(s);
    toast('Space created');
    await inviteDialog(s, true);
  } catch (e) { toast(e.message, 'error'); }
}

export async function joinDialog() {
  const out = await formModal({
    title: 'Join a Space',
    fields: [{ name: 'link', label: 'Invite link or code', required: true,
      placeholder: 'https://…/#/join/abc123  or just abc123' }],
    submitLabel: 'Join',
  });
  if (!out) return;
  const token = extractToken(out.link.trim());
  try {
    const wsRow = await api.redeemInvite(token);
    await loadSpaces();
    const s = store.spaces.find((x) => x.id === wsRow.id) || wsRow;
    await switchWorkspace(s);
    toast('Joined ' + (s.name || 'the Space'));
  } catch (e) { toast(e.message || 'That invite did not work', 'error'); }
}

// Accepts the whole link, the hash alone, or a bare token. `join-org` has to be
// matched too and has to be matched FIRST: `join\/` alone does not match
// "join-org/", so an organisation link pasted whole came back as the entire URL
// and was then sent to the server as if it were the token. Nobody is going to
// pull a token out of a URL by hand on a phone, so every shape the link arrives
// in has to work.
export const extractToken = (s) => {
  const m = (s || '').match(/join-org\/([^/?#\s]+)/) || (s || '').match(/join\/([^/?#\s]+)/);
  return m ? decodeURIComponent(m[1]) : (s || '').trim();
};

// Which redeem an invite string is for, when the app has to choose. Only the
// link form says; a bare token does not, and the caller falls back.
export const looksLikeOrgInvite = (s) => /join-org\//.test(s || '');

export function inviteLinkFor(token) {
  return location.origin + location.pathname + '#/join/' + token;
}

// The rail's right-click shortcut. It minted an UNLIMITED, NEVER-EXPIRING link,
// which made the one-use default in inviteDialog a fiction: the fastest path an
// admin actually reaches for was the one with no limit on it at all. One person,
// seven days, same as the dialog.
export async function copyInvite(space) {
  const ws = space || store.ws;
  if (!ws) return;
  try {
    const token = await api.createInvite(
      ws.id, 1, new Date(Date.now() + 7 * 86400000).toISOString(), null);
    const link = inviteLinkFor(token);
    // Optional chaining made a missing clipboard a silent no-op that still said
    // "copied". Inside an iframe, and on some older phones, that is exactly what
    // happens - and the admin then pastes whatever was on the clipboard before.
    if (!navigator.clipboard?.writeText) {
      toast('Could not reach the clipboard. Open Invite to see the link.', 'error');
      return link;
    }
    await navigator.clipboard.writeText(link);
    toast('One-time invite link copied. It lets one person in.');
    return link;
  } catch (e) { toast(e.message, 'error'); }
}

// One link, one person.
//
// The old dialog defaulted to an unlimited link with a "Max uses" number box
// nobody filled in, so in practice every invite ever handed out was reusable
// forever by anyone it was forwarded to. For an invite-only product where an
// account is a person, that is the wrong default in the only direction that
// matters: a link that leaks lets strangers in, a link that is too tight only
// costs somebody one more tap.
//
// So it is one use by default, and the moment you copy it, a FRESH one is
// generated for the next person. That last part is the whole ergonomic idea:
// inviting five people is copy, paste, copy, paste, and each of the five gets a
// link that stops working the moment they use it.
//
// GENERATING A NEW LINK DOES NOT REVOKE THE OLD ONE, and that is deliberate.
// "Refresh" revoking the previous link would break the person you sent it to
// thirty seconds ago, which is exactly the sequence inviting several people
// produces. Live links are listed underneath with a Revoke button, so cleaning
// up is possible and explicit rather than a silent side effect of copying.
export async function inviteDialog(space, isNew = false) {
  const ws = space || store.ws;
  if (!ws) return;
  const box = el('div', 'invite-box');
  box.innerHTML = `
    ${isNew ? `<p class="muted">Your Space <b>${esc(ws.name)}</b> is live. Send this to the first person you want in it.</p>` : ''}
    <div class="invite-row"><input id="inviteLink" readonly value="generating…" />
      <button id="copyInvite">Copy</button></div>
    <div class="invite-note muted" id="invNote">
      This link lets <b>one person</b> in and then stops working.
      Copying it makes a new one for the next person.</div>
    <div class="invite-note muted">A server link opens the front door only -
      private channels stay private until a coordinator adds each person.</div>
    <div class="invite-opts">
      <label class="field"><span class="field-label">Lets in</span>
        <!-- Short enough to survive a 140px select on a phone. The sentence
             above the options is where the full explanation lives. -->
        <select id="invMax">
          <option value="1">One person</option>
          <option value="5">Up to 5</option>
          <option value="25">Up to 25</option>
          <option value="">Anyone</option></select></label>
      <label class="field"><span class="field-label">Expires</span>
        <select id="invExp">
          <option value="7">7 days</option>
          <option value="1">1 day</option>
          <option value="30">30 days</option>
          <option value="">Never</option></select></label>
      <label class="field"><span class="field-label">Joins as</span>
        <select id="invRole">
          <option value="">Member</option>
          <option value="moderator">Moderator</option></select></label>
      <button class="ghost" id="regen">New link</button>
    </div>
    <div id="inviteList" class="invite-list"></div>`;
  modal({ title: 'Invite to ' + ws.name, body: box, wide: true });

  const $q = (s) => box.querySelector(s);
  const linkEl = $q('#inviteLink');
  const copyBtn = $q('#copyInvite');

  const say = () => {
    const max = $q('#invMax').value;
    $q('#invNote').innerHTML = max === '1'
      ? 'This link lets <b>one person</b> in and then stops working. '
        + 'Copying it makes a new one for the next person.'
      : max
        ? `This link lets <b>up to ${esc(max)} people</b> in.`
        : '<b>Anyone</b> who gets this link can join, as many times as it is forwarded. '
          + 'Only use this for a link you are posting somewhere you control.';
  };

  let busy = false;
  const make = async () => {
    if (busy) return;
    busy = true;
    copyBtn.disabled = true;
    linkEl.value = 'generating…';
    const days = $q('#invExp').value;
    const max = $q('#invMax').value;
    try {
      // The select cannot produce a 0 today, but "0" is truthy and `max ? +max`
      // would send it, and a link that lets nobody in is indistinguishable from
      // a good one until somebody tries it. Validated rather than trusted, the
      // same way the admin console does it.
      const n = Number(max);
      const uses = Number.isInteger(n) && n > 0 ? n : null;
      const role = $q('#invRole').value || null;
      const token = await api.createInvite(
        ws.id, uses,
        days ? new Date(Date.now() + +days * 86400000).toISOString() : null, role);
      linkEl.value = inviteLinkFor(token);
      copyBtn.disabled = false;
      refreshList();
    } catch (e) {
      // A link that failed to generate must not look like a link. Leaving the
      // previous one in the box after a failed refresh is how somebody sends the
      // same one-use link to two people.
      linkEl.value = '';
      linkEl.placeholder = 'Could not make a link: ' + (e.message || 'try again');
      toast('Could not make an invite link', 'error');
    } finally { busy = false; }
  };

  const refreshList = async () => {
    const [rows] = await tryRpc('list_invites', { p_workspace: ws.id });
    const host = $q('#inviteList');
    const live = (Array.isArray(rows) ? rows : []).filter((r) => !r.revoked_at);
    if (!live.length) { host.innerHTML = ''; return; }

    const spent = (r) => r.max_uses && (r.uses || 0) >= r.max_uses;
    host.innerHTML = '<div class="muted" style="margin:12px 0 4px">Links you have made</div>'
      + live.map((r) => {
        const used = r.uses || 0;
        const state = spent(r) ? 'used up'
          : r.max_uses ? `${used} of ${r.max_uses} used`
            : `${used} ${used === 1 ? 'person has' : 'people have'} joined`;
        return `<div class="inv-row${spent(r) ? ' inv-spent' : ''}">
          <span>${esc(state)}</span>
          <span class="muted">${r.expires_at
            ? 'expires ' + new Date(r.expires_at).toLocaleDateString()
            : 'never expires'}</span>
          <button class="icon" data-rev="${esc(r.id)}">Revoke</button></div>`;
      }).join('');
    host.querySelectorAll('[data-rev]').forEach((b) => {
      b.onclick = async () => { await api.revokeInvite(b.dataset.rev).catch(() => {}); refreshList(); };
    });
  };

  copyBtn.onclick = async () => {
    const link = linkEl.value;
    if (!link || busy) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // No clipboard permission, which is ordinary inside an iframe and on some
      // older phones. Select the text so it can be copied by hand, and do NOT
      // rotate the link - they have not got it yet.
      linkEl.focus();
      linkEl.select();
      toast('Could not reach the clipboard - the link is selected, copy it by hand', 'error');
      return;
    }
    // Only after the clipboard genuinely has it. Rotating first and failing to
    // copy would hand somebody a link they never received.
    toast('Copied. Making a new link for the next person.');
    if ($q('#invMax').value === '1') make();
  };

  $q('#regen').onclick = make;
  $q('#invMax').onchange = () => { say(); make(); };
  $q('#invExp').onchange = make;
  say();
  await make();
}

// channel_created/updated/deleted all land here as a payload-free emit, and
// reloadChannels() is a full get_bootstrap - an admin renaming five channels in
// a row was five bootstraps on every connected client. Payload-free emits
// coalesce under a leading-edge debounce (first repaint immediate, one trailing
// catch-up); an emit carrying {open} bypasses it, because that is "and now open
// this channel", which must neither be swallowed nor reordered behind a batch.
const coalescedChannelReload = debounceLead(() => reloadChannels(), 700);
bus.on('channels:reload', (p) => (p?.open ? reloadChannels(p.open) : coalescedChannelReload()));
bus.on('spaces:badges', renderSpaceRail);
