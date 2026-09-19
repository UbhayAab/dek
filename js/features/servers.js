// Finding the other servers, which until now you could not.
//
// Reported as the most heard complaint: "people are not able to see or find all
// servers... we can't see the other servers. People need to be very easily able
// to join all servers - search, or by group."
//
// THE NUMBERS SAY THIS IS NOT A PERMISSIONS PROBLEM. Safalta Setu's servers are
// already join_policy = 'open' and still hold 19, 17 and 17 of its 51 people.
// They are open and unfindable. Jarurat Care is worse: 64 of 68 people are in
// the main server, 14 in HR Psy-Connect, 4 in HR.
//
// And the backend has been ready the whole time. list_org_spaces() returns every
// server in an organisation with member_count and is_member, to any member of
// that organisation. join_team_space() joins one. Neither needed writing. What
// did not exist was anywhere to press:
//
//   - the only directory was a MODAL, opened by right-clicking or long-pressing
//     an organisation tile in a rail that is now gone, and whose own code
//     comments admit the gesture is one "a phone user has never been told
//     about";
//   - it showed one organisation at a time, so somebody in two organisations
//     had to know to look twice;
//   - it had no search;
//   - and it offered one Join button per row, so being in everything meant
//     finding the list, then tapping, waiting, tapping, waiting.
//
// So: one panel, every organisation at once, a search box, and a single button
// that puts you in everything that is open. Grouping by organisation is not
// decoration - "HR" is the name of a server in BOTH organisations here, and a
// flat list would be two identical rows.
import { tryRpc, rpc } from '../api.js';
import { store, bus } from '../store.js';
import { el, esc, initials, hueOf } from '../util.js';
import { icon } from '../icons.js';
import { loadSpaces, switchWorkspace } from '../core/workspace.js';

const PANEL = 'servers';
const CLS = 'srvd';

let uiRef = null;
let query = '';
let rows = [];              // [{ org, orgName, isAdmin, spaces: [...] }]
let loading = false;
let loadedFor = '';

const isOrgAdmin = (orgId) =>
  (store.orgs || []).find((o) => o.org_id === orgId)?.org_role === 'admin';

// ------------------------------------------------------------------ loading
// One read per organisation. A person is in one or two, so this is one or two
// requests, and doing it per-org is what lets the panel show which organisation
// each server belongs to without a second lookup.
async function load({ force = false } = {}) {
  const orgs = store.orgs || [];
  const key = orgs.map((o) => o.org_id).join(',');
  if (!force && key === loadedFor && rows.length) return rows;
  loading = true;
  const out = [];
  for (const o of orgs) {
    const [list] = await tryRpc('list_org_spaces', { p_org: o.org_id });
    out.push({
      org: o.org_id,
      orgName: o.name || 'Organisation',
      isAdmin: o.org_role === 'admin',
      spaces: (Array.isArray(list) ? list : []).filter((s) => !s.archived_at),
    });
  }
  rows = out;
  loadedFor = key;
  loading = false;
  return rows;
}

// What a search has to match. The organisation name counts: "show me everything
// in Safalta Setu" is a thing somebody will type, and it is the one word that
// tells two servers called HR apart.
const matches = (s, orgName, q) => !q
  || String(s.name || '').toLowerCase().includes(q)
  || String(s.slug || '').toLowerCase().includes(q)
  || String(orgName || '').toLowerCase().includes(q)
  || String(s.created_by_name || '').toLowerCase().includes(q);

// ------------------------------------------------------------------ actions
async function join(space, orgId) {
  await rpc('join_team_space', { p_workspace: space.id });
  await loadSpaces();
  await load({ force: true });
}

async function openIt(space) {
  const s = (store.spaces || []).find((x) => x.id === space.id);
  if (s) { await switchWorkspace(s); uiRef.closePanel?.(); return; }
  // Just joined in another tab, or the list is a moment stale.
  await loadSpaces();
  const again = (store.spaces || []).find((x) => x.id === space.id);
  if (again) { await switchWorkspace(again); uiRef.closePanel?.(); }
}

function explain(e) {
  const m = e?.message || '';
  const h = e?.hint || e?.details || '';
  if (/invite_only/.test(m)) return 'That server is invite only. Ask a coordinator to add you.';
  if (/not_gated/.test(m)) return 'That server is invite only and is not taking requests. Ask a coordinator to add you.';
  if (/already_member/.test(m)) return 'You are already in that one';
  if (/banned/.test(m)) return 'You cannot join that server';
  if (/forbidden/.test(m)) return h || 'You are not allowed to join that one';
  return 'Could not join that server';
}

// THE BUTTON THE COMPLAINT WAS ACTUALLY ASKING FOR. "People need to be very
// easily able to join all servers." One tap, everything open in this
// organisation, one refresh at the end rather than one per server.
async function joinAllOpen(group, btn) {
  const todo = group.spaces.filter((s) => !s.is_member && (s.join_policy === 'open' || group.isAdmin));
  if (!todo.length) return;
  btn.disabled = true;
  btn.textContent = `Joining ${todo.length}…`;
  let done = 0;
  const failed = [];
  for (const s of todo) {
    try { await rpc('join_team_space', { p_workspace: s.id }); done++; }
    catch { failed.push(s.name); }
  }
  await loadSpaces();
  await load({ force: true });
  uiRef.toast(failed.length
    ? `Joined ${done}. Could not join: ${failed.join(', ')}`
    : `You are now in ${done} more ${done === 1 ? 'server' : 'servers'}`,
  failed.length ? 'error' : 'success');
  uiRef.refreshPanel({});
}

// An org admin can open a server to everybody from the row itself, because the
// alternative is explaining where the org console is to the one person who can
// fix the complaint everybody else is making.
async function openToEveryone(space) {
  const okay = await uiRef.confirmModal({
    title: `Let everyone into ${space.name}?`,
    body: 'Anybody in this organisation will be able to join it themselves, and it will '
      + 'show as joinable in this list. Private channels inside it stay private - this '
      + 'only affects who can walk in the front door.',
    confirmLabel: 'Open it',
  });
  if (!okay) return;
  try {
    await rpc('set_workspace_join_policy', { p_workspace: space.id, p_policy: 'open' });
    await load({ force: true });
    uiRef.toast(`${space.name} is open to everyone`, 'success');
    uiRef.refreshPanel({});
  } catch (e) { uiRef.toast(explain(e), 'error'); }
}

// ------------------------------------------------------------------ painting
async function renderPanel(host, ctx = {}) {
  if (typeof ctx.q === 'string') query = ctx.q;
  host.innerHTML = '';

  const search = el('input', CLS + '-search');
  search.type = 'search';
  search.placeholder = 'Search servers';
  search.value = query;
  search.setAttribute('aria-label', 'Search servers');
  host.appendChild(search);

  const body = el('div', CLS + '-body');
  host.appendChild(body);

  const paint = () => {
    body.innerHTML = '';
    const q = query.trim().toLowerCase();
    let shown = 0;

    for (const g of rows) {
      const list = g.spaces.filter((s) => matches(s, g.orgName, q));
      if (!list.length) continue;
      shown += list.length;

      const sec = el('div', CLS + '-org');
      const head = el('div', CLS + '-orghead');
      const joinable = g.spaces.filter((s) => !s.is_member && (s.join_policy === 'open' || g.isAdmin));
      head.innerHTML = `<span class="${CLS}-orgname">${esc(g.orgName)}</span>
        <span class="muted">${g.spaces.filter((s) => s.is_member).length} of ${g.spaces.length} joined</span>`;
      sec.appendChild(head);

      if (joinable.length > 1) {
        const all = el('button', CLS + '-all',
          `＋  Join all ${joinable.length} servers I am not in`);
        all.type = 'button';
        all.onclick = () => joinAllOpen(g, all);
        sec.appendChild(all);
      }

      for (const s of list) sec.appendChild(row(s, g));
      body.appendChild(sec);
    }

    if (!shown) {
      body.appendChild(el('div', CLS + '-empty', q
        ? `Nothing matches "${query.trim()}".`
        : 'No servers to show. If you have just been invited, pull down to refresh.'));
    }
  };

  body.appendChild(el('div', 'muted pad', 'Loading'));
  await load();
  paint();

  let t = null;
  search.oninput = () => {
    query = search.value;
    clearTimeout(t);
    t = setTimeout(paint, 120);
  };
  // A phone keyboard covering the list is worse than no autofocus, and this
  // panel is most often opened to browse rather than to search.
  if (!ctx.focus) search.blur();
  else search.focus();
}

function row(s, g) {
  const r = el('div', CLS + '-row' + (s.is_member ? ' ' + CLS + '-in' : ''));
  const locked = s.join_policy !== 'open';
  // requires_approval arrived with 0077. Rows listed before that migration is
  // applied carry undefined: offer the ask and let request_join arbitrate, so
  // an older server never renders a dead end in either direction.
  const gated = s.requires_approval !== false;
  r.innerHTML = `
    <span class="${CLS}-ico" style="--h:${hueOf(s.id)}">${esc(initials(s.name || '?'))}</span>
    <span class="${CLS}-main">
      <span class="${CLS}-name">${esc(s.name || 'Server')}${
        locked ? ` <span class="${CLS}-lock" title="Invite only">${icon('lock')}</span>` : ''}</span>
      <span class="muted">${esc(String(s.member_count ?? 0))} ${
        (s.member_count === 1 ? 'member' : 'members')}${
        s.created_by_name ? ' · started by ' + esc(s.created_by_name) : ''}</span>
    </span>`;

  const act = el('div', CLS + '-act');
  if (s.is_member) {
    const b = el('button', CLS + '-btn ' + CLS + '-openbtn', 'Open');
    b.type = 'button';
    b.onclick = () => openIt(s);
    act.appendChild(b);
  } else if (!locked || g.isAdmin) {
    const b = el('button', CLS + '-btn ' + CLS + '-joinbtn', g.isAdmin && locked ? 'Join (admin)' : 'Join');
    b.type = 'button';
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = 'Joining…';
      try {
        await join(s, g.org);
        uiRef.toast(`You are in ${s.name}`, 'success');
        uiRef.refreshPanel({});
      } catch (e) {
        b.disabled = false;
        b.textContent = 'Join';
        uiRef.toast(explain(e), 'error');
      }
    };
    act.appendChild(b);
  } else if (!gated) {
    // Invite-only and not taking requests: no request row could ever be
    // written (request_join throws not_gated), so there is no button, only the
    // honest label and the coordinator pointer from explain().
    act.appendChild(el('span', CLS + '-locked muted', 'Invite only'));
  } else {
    // Gated: the ask writes a workspace_join_requests row, and 0077's
    // join_request broadcast plus the admin console queue take it from there.
    // (Pre-0077 rows with requires_approval unknown land here too; a not_gated
    // rejection settles them into the label above instead of stranding the tap.)
    const b = el('button', CLS + '-btn ' + CLS + '-askbtn', 'Ask to join');
    b.type = 'button';
    b.onclick = async () => {
      b.disabled = true;
      try {
        await rpc('request_join', { p_workspace: s.id });
        b.textContent = 'Asked';
        uiRef.toast('Asked. A coordinator will let you in.', 'success');
      } catch (e) {
        if (/not_gated/.test(e?.message || '')) {
          // Nothing to ask. Stop pretending there is: the row settles into a
          // label, and the toast says who to go to instead.
          b.replaceWith(el('span', CLS + '-locked muted', 'Invite only'));
        } else {
          b.disabled = false;
        }
        uiRef.toast(explain(e), 'error');
      }
    };
    act.appendChild(b);
  }

  // The one control that fixes the complaint for everybody at once, offered to
  // the only person who can use it.
  if (g.isAdmin && locked) {
    const o = el('button', CLS + '-btn ' + CLS + '-ghost', 'Let everyone in');
    o.type = 'button';
    o.onclick = () => openToEveryone(s);
    act.appendChild(o);
  }

  r.appendChild(act);
  return r;
}

// ------------------------------------------------------------------ styles
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-search{display:block;width:calc(100% - 20px);margin:10px;padding:9px 12px;
  border:1px solid var(--line);border-radius:10px;background:var(--panel2);
  color:var(--text);font-size:14px}
.${CLS}-search:focus{outline:none;border-color:var(--accent)}
.${CLS}-body{padding:0 10px 14px}
.${CLS}-org{margin-bottom:14px}
.${CLS}-orghead{display:flex;align-items:baseline;gap:8px;padding:2px 2px 6px}
.${CLS}-orgname{font-size:12px;font-weight:700;text-transform:uppercase;
  letter-spacing:.05em;color:var(--dim)}
.${CLS}-orghead .muted{font-size:11.5px;margin-left:auto}
.${CLS}-all{display:block;width:100%;margin:0 0 8px;padding:9px 12px;text-align:left;
  border:1px dashed var(--line);border-radius:10px;background:var(--panel2);
  color:var(--text);font-size:13px;cursor:pointer}
.${CLS}-all:hover{border-color:var(--accent);color:var(--accent)}
.${CLS}-all[disabled]{opacity:.6;cursor:default}
.${CLS}-row{display:flex;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;
  border:1px solid var(--line);border-radius:10px;background:var(--panel);flex-wrap:wrap}
.${CLS}-row:hover{border-color:var(--accent)}
.${CLS}-in{background:var(--panel2)}
.${CLS}-ico{flex:none;width:34px;height:34px;border-radius:9px;display:flex;
  align-items:center;justify-content:center;font-size:12.5px;font-weight:700;
  color:#fff;background:hsl(var(--h,210) 45% 45%)}
/* THE min-width IS THE WHOLE ROW LAYOUT, AND IT WAS MISSING.
   With flex:1 and no floor, a row carrying two buttons - Join plus an admin's
   "Let everyone in" - squeezed this column to about 90px, and "4 members ·
   started by Ubhay" wrapped to one word per line with the buttons floating in
   the middle of it. Screenshots caught that; the DOM assertions could not,
   because every element was present and correctly positioned by its own maths.
   A floor here makes the row WRAP the buttons onto their own line instead,
   which is what the flex-wrap above was always for. */
.${CLS}-main{display:flex;flex-direction:column;gap:1px;min-width:150px;flex:1 1 auto}
.${CLS}-name{font-size:14px;font-weight:600;display:flex;align-items:center;gap:5px;
  min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${CLS}-lock{display:inline-flex;flex:none;color:var(--faint)}
.${CLS}-lock svg{width:12px;height:12px}
/* One line, cut with an ellipsis. A server's member count is a glance, not a
   paragraph, and letting it wrap is what made the row three lines tall. */
.${CLS}-main .muted{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${CLS}-act{display:flex;gap:6px;margin-left:auto;flex:none}
.${CLS}-btn{padding:6px 14px;border-radius:9px;cursor:pointer;font-size:13px;
  border:1px solid var(--line);background:var(--panel2);color:var(--text);white-space:nowrap}
.${CLS}-btn:hover{border-color:var(--accent)}
.${CLS}-btn[disabled]{opacity:.6;cursor:default}
.${CLS}-joinbtn{background:var(--c-accent,#5b8cff);color:#fff;border-color:transparent;font-weight:600}
.${CLS}-ghost{color:var(--dim);border-style:dashed}
.${CLS}-locked{font-size:12px;padding:6px 4px;white-space:nowrap}
.${CLS}-empty{padding:16px 4px;font-size:13px;color:var(--dim);line-height:1.5}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  style();

  ui.registerPanel({ id: PANEL, title: 'Find a server', icon: icon('search'), render: renderPanel });

  // NO NAV SECTION HERE. addNavSection paints into #navExtra, which sits below
  // the channel list AND below Direct messages - so a "Find a server" row put
  // there rendered under the DM heading and read as a DM action. Screenshot
  // caught it. The row belongs at the end of the Servers group instead, which
  // is inside #channels, so js/core/channels.js draws it and this file just
  // owns the panel it opens.
  ui.addSlashCommand({
    name: 'servers',
    description: 'Find and join the other servers in your organisation',
    run: (arg) => ui.openPanel(PANEL, { q: (arg || '').trim(), focus: true }),
  });

  // THE QUICK SWITCHER NEVER KNEW SERVERS EXISTED. Ctrl+K searched channels and
  // people, both scoped to the Space already open - so the one keystroke people
  // learn for "take me somewhere" could not take you to another server, joined
  // or not.
  ui.addSwitcherSource({
    id: 'servers',
    search: (q) => {
      const needle = String(q || '').toLowerCase();
      const out = [];
      for (const g of rows) {
        for (const s of g.spaces) {
          if (!matches(s, g.orgName, needle)) continue;
          out.push({
            label: s.name,
            hint: `${g.orgName} · ${s.is_member ? 'joined' : s.join_policy === 'open' ? 'tap to join' : 'invite only'}`,
            icon: icon('building'),
            // `run`, not `onPick`: js/main.js's quick switcher calls
            // items[idx].run() and would silently do nothing for any other name.
            run: () => (s.is_member
              ? openIt(s)
              : ui.openPanel(PANEL, { q: s.name })),
          });
        }
      }
      return out.slice(0, 6);
    },
  });

  // Keep the list warm so the switcher has something to search before anybody
  // has opened the panel, and refresh it when the set of organisations changes.
  bus.on('workspace', () => { load({ force: true }).catch(() => {}); });
  bus.on('auth', () => { load({ force: true }).catch(() => {}); });
  load().catch(() => {});
}

export default { register };
