// The organisation console: a PAGE, at #/admin, not a side panel.
//
// Why a page and not another tab in the existing console. That one is scoped to
// one Space, opens as a 780px drawer over the conversation, and answers "how is
// this server doing". Running an organisation is a different job: it is about
// people who are in several servers or none, servers that need creating and
// deleting, and rules that apply across all of them. None of that fits beside a
// channel list, and doing it in a drawer means the thing you are changing is
// hidden behind the thing you are changing it in.
//
// The rule that shapes every screen here: an admin acts on the ORGANISATION,
// and never has to join a server to manage it. The org-scoped RPCs in 0069 are
// what make that possible; before them, authority stopped at the server door.
import { store, bus } from '../store.js';
import { api } from '../api.js';
import { $, el, esc, initials, hueOf, relTime } from '../util.js';
import { icon } from '../icons.js';
import { loadSpaces, switchWorkspace } from '../core/workspace.js';
import { resetPersonPassword, addPeopleDialog } from './people.js';
import { embed } from '../embed.js';
import { drawApps, APPS_CSS } from './apps.js';

let UI = null;
let current = null;        // { org, overview, section }
let mounted = false;

export const isOrgAdmin = (orgId) =>
  (store.orgs || []).find((o) => o.org_id === orgId)?.org_role === 'admin';

// Which org this admin is looking at. The rail's current Space decides, so
// opening the console from inside Jarurat lands on Jarurat.
function pickOrg(explicit) {
  const orgs = (store.orgs || []).filter((o) => o.org_role === 'admin');
  if (!orgs.length) return null;
  return orgs.find((o) => o.org_id === explicit)
    || orgs.find((o) => o.org_id === store.ws?.org_id)
    || orgs[0];
}

// ------------------------------------------------------------------ shell
const SECTIONS = [
  ['overview', 'Overview'],
  ['people', 'People'],
  ['servers', 'Servers'],
  ['permissions', 'Permissions'],
  ['apps', 'Apps'],
  ['rules', 'Rules'],
  // Leave is an organisation-level policy - one number that applies to
  // everybody in every Space - so this is where somebody goes looking for it.
  // The editor itself lives in features/leave.js, reached by a bus event: two
  // copies of a form that writes the same row is how they end up disagreeing.
  ['leave', 'Leave'],
];

export async function openAdminPage(orgId, section) {
  const org = pickOrg(orgId);
  if (!org) {
    UI?.toast('Only an admin of an organisation can open this.', 'error');
    return;
  }
  current = {
    org,
    section: section || current?.section || 'overview',
    // Which server the Permissions section is scoped to. Kept across a reopen so
    // coming back from a toast does not silently move you from one server's
    // rules to the whole organisation's.
    permServer: current?.org?.org_id === org.org_id ? current?.permServer || null : null,
  };

  document.body.classList.add('admin-page');
  $('chat')?.classList.add('hidden');
  $('auth')?.classList.add('hidden');

  let page = $('adminPage');
  if (!page) {
    page = el('div', 'adminpage');
    page.id = 'adminPage';
    document.getElementById('app').appendChild(page);
  }
  page.classList.remove('hidden');
  mounted = true;
  await draw();
}

export function closeAdminPage() {
  mounted = false;
  document.body.classList.remove('admin-page');
  $('adminPage')?.classList.add('hidden');
  $('chat')?.classList.remove('hidden');
  if (location.hash.startsWith('#/admin')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

async function draw() {
  if (!mounted) return;
  const page = $('adminPage');
  const { org, section } = current;

  page.innerHTML = `
    <header class="ap-top">
      <button class="ap-back" id="apBack">← Back to Dek</button>
      <div class="ap-title">
        <span class="ap-mark" style="--h:${hueOf(org.org_id)}">${esc(initials(org.name))}</span>
        <div>
          <h1 id="apOrgName">${esc(org.name)}</h1>
          <p class="muted">Organisation settings</p>
        </div>
      </div>
    </header>
    <div class="ap-body">
      <nav class="ap-nav">${SECTIONS.map(([id, label]) =>
        `<button data-sec="${id}" class="${id === section ? 'on' : ''}">${esc(label)}</button>`).join('')}</nav>
      <main class="ap-main" id="apMain"><div class="loading-space"><span class="spin"></span>Loading…</div></main>
    </div>`;

  page.querySelector('#apBack').onclick = closeAdminPage;
  page.querySelectorAll('[data-sec]').forEach((b) => {
    b.onclick = () => {
      current.section = b.dataset.sec;
      history.replaceState(null, '', location.pathname + location.search + '#/admin/' + b.dataset.sec);
      draw();
    };
  });

  const main = page.querySelector('#apMain');
  try {
    const painter = { overview: drawOverview, people: drawPeople, servers: drawServers,
      permissions: drawPermissions, rules: drawRules, apps: drawApps,
      leave: drawLeave }[section];
    await painter(main, org);
  } catch (e) {
    main.innerHTML = `<div class="loadfail">
      <h2>Could not load this</h2>
      <p class="muted">${esc(e.message || 'no further detail')}</p>
      <button id="apRetry" class="wide">Try again</button></div>`;
    main.querySelector('#apRetry').onclick = draw;
  }
}

const refresh = () => draw();

// ------------------------------------------------------------------ overview
async function drawOverview(host, org) {
  const o = await api.orgOverview(org.org_id);
  if (!o) throw new Error('You are not an admin of this organisation.');
  current.overview = o;

  const stat = (n, label, bad) =>
    `<div class="ap-stat${bad && n > 0 ? ' bad' : ''}"><b>${n}</b><span>${esc(label)}</span></div>`;

  host.innerHTML = `
    <div class="ap-stats">
      ${stat(o.people, 'people')}
      ${stat(o.admins, 'admins')}
      ${stat(o.servers, 'servers')}
      ${stat(o.not_started, 'have not set a password', true)}
      ${stat(o.no_server, 'are in no server', true)}
      ${stat(o.archived, 'archived servers')}
    </div>
    ${(o.not_started > 0 || o.no_server > 0) ? `
      <div class="ap-note">
        ${o.not_started > 0 ? `<div><b>${o.not_started}</b> have never set a password. Send them the one you gave them again - do <b>not</b> reset them, that stops the one they hold working.</div>` : ''}
        ${o.no_server > 0 ? `<div><b>${o.no_server}</b> are in no server, so they sign in and see nothing to read. Put them in one under People.</div>` : ''}
      </div>` : '<div class="ap-note ok">Everybody has a password and a server. Nothing needs doing.</div>'}

    <h2 class="ap-h2">Name</h2>
    <div class="ap-form">
      <label class="field"><span class="field-label">Organisation name</span>
        <input id="apName" value="${esc(o.name)}" maxlength="60" /></label>
      <button id="apRename" class="sm">Save</button>
      <p class="field-hint">Everybody in the organisation sees this, in the rail and on the join screen.</p>
    </div>`;

  host.querySelector('#apRename').onclick = async () => {
    const btn = host.querySelector('#apRename');
    btn.disabled = true;
    try {
      const name = host.querySelector('#apName').value.trim();
      await api.renameOrganization(org.org_id, name);
      org.name = name;
      const local = (store.orgs || []).find((x) => x.org_id === org.org_id);
      if (local) local.name = name;
      UI.toast('Renamed', 'success');
      await draw();
    } catch (e) { UI.toast(e.message, 'error'); } finally { btn.disabled = false; }
  };
}

// ------------------------------------------------------------------ people
const STATE_LABEL = {
  not_started: 'no password yet',
  stalled: 'signed in, no password',
  done: 'set up',
};

async function drawPeople(host, org) {
  const [people, servers] = await Promise.all([
    api.listOrgPeople(org.org_id),
    api.listOrgServers(org.org_id),
  ]);
  const live = servers.filter((s) => !s.archived_at);

  host.innerHTML = `
    <div class="ap-rowhead">
      <h2 class="ap-h2">People <span class="muted">${people.length}</span></h2>
      <div class="ap-rowhead-tools">
        <input id="apSearch" class="ap-search" placeholder="Search by name, email or title" />
        <button class="sm" id="apAddPeople">＋ Add people</button>
      </div>
    </div>
    <div class="ap-table" id="apPeople"></div>`;

  // The servers come from list_org_servers rather than store.spaces: an org
  // admin runs servers they are not in, and those are the ones a new starter is
  // most likely to belong to.
  host.querySelector('#apAddPeople').onclick = () => addPeopleDialog(org, UI, {
    servers: live,
    onDone: draw,
  });

  const list = host.querySelector('#apPeople');
  const paint = (q = '') => {
    const needle = q.trim().toLowerCase();
    const rows = people.filter((p) => !needle
      || [p.display_name, p.email, p.title].some((v) => String(v || '').toLowerCase().includes(needle)));
    if (!rows.length) { list.innerHTML = '<div class="empty">Nobody matches that.</div>'; return; }
    list.innerHTML = rows.map((p) => `
      <div class="ap-person" data-u="${p.user_id}">
        <span class="ap-av" style="--h:${hueOf(p.user_id)}">${esc(initials(p.display_name || p.email))}</span>
        <div class="ap-person-main">
          <b>${esc(p.display_name || '(no name)')}</b>
          ${p.org_role === 'admin' ? '<span class="ap-chip admin">admin</span>' : ''}
          ${p.title ? `<span class="ap-chip">${esc(p.title)}</span>` : ''}
          <div class="muted ap-person-sub">${esc(p.email || '')}</div>
        </div>
        <div class="ap-person-meta">
          <span class="ap-chip ${p.state === 'done' ? 'ok' : 'warn'}">${esc(STATE_LABEL[p.state])}</span>
          <span class="ap-chip ${p.servers ? '' : 'warn'}">${p.servers} server${p.servers === 1 ? '' : 's'}</span>
        </div>
        <button class="sm ghost" data-manage>Manage</button>
      </div>`).join('');
    list.querySelectorAll('[data-manage]').forEach((b) => {
      b.onclick = () => managePerson(
        people.find((x) => x.user_id === b.closest('.ap-person').dataset.u), org, live);
    });
  };
  host.querySelector('#apSearch').oninput = (e) => paint(e.target.value);
  paint();
}

// One person, everything an admin can do to them, in one place.
async function managePerson(person, org, servers) {
  const box = el('div', 'ap-manage');
  box.innerHTML = '<div class="loading-space"><span class="spin"></span>Loading…</div>';
  const m = UI.modal({ title: person.display_name || person.email, body: box, wide: true });

  const paint = async () => {
    // Which servers they are in, and which roles they hold in each. Read per
    // server because roles are a per-server thing - the same person can be a
    // lead in one team and a plain member of another.
    const rolesByServer = new Map();
    // Membership is READ, not inferred. Inferring it from "holds a role here"
    // was wrong for everybody in a server that has no roles - they showed as
    // absent from a team they are on, and the fix an admin would reach for is
    // ticking a box that already should have been ticked.
    const memberOf = new Set(await api.orgMemberServers(org.org_id, person.user_id).catch(() => []));
    for (const s of servers) {
      const [roles, held] = await Promise.all([
        api.orgServerRoles(org.org_id, s.id),
        api.orgMemberRoles(org.org_id, s.id, person.user_id).catch(() => []),
      ]);
      rolesByServer.set(s.id, { roles: roles.filter((r) => !r.is_everyone), held: new Set(held || []) });
    }
    const people = await api.listOrgPeople(org.org_id);
    const fresh = people.find((p) => p.user_id === person.user_id) || person;

    box.innerHTML = `
      <div class="ap-manage-head">
        <span class="ap-av big" style="--h:${hueOf(person.user_id)}">${esc(initials(fresh.display_name || fresh.email))}</span>
        <div>
          <b>${esc(fresh.display_name || '(no name)')}</b>
          <div class="muted">${esc(fresh.email || '')}</div>
          <div class="muted">${esc(STATE_LABEL[fresh.state])} · in ${fresh.servers} server${fresh.servers === 1 ? '' : 's'}</div>
        </div>
      </div>

      <h3 class="ap-h3">Their details</h3>
      <div class="ap-form">
        <div class="ap-grid2">
          <label class="field"><span class="field-label">Name</span>
            <input id="mpName" value="${esc(fresh.display_name || '')}" maxlength="60" /></label>
          <label class="field"><span class="field-label">Title</span>
            <input id="mpTitle" value="${esc(fresh.title || '')}" maxlength="60" placeholder="Interview Intern" /></label>
        </div>
        <button id="mpSave" class="sm">Save details</button>
        <p class="field-hint">A title describes what they do. It grants nothing - roles below do that.</p>
      </div>

      <h3 class="ap-h3">In the organisation</h3>
      <div class="ap-form">
        <label class="field"><span class="field-label">Organisation role</span>
          <select id="mpOrgRole">
            <option value="member"${fresh.org_role === 'member' ? ' selected' : ''}>Member</option>
            <option value="admin"${fresh.org_role === 'admin' ? ' selected' : ''}>Admin - can do everything on this page</option>
          </select></label>
      </div>

      <h3 class="ap-h3">Servers and roles</h3>
      <div class="ap-servers">
        ${servers.map((s) => {
          const info = rolesByServer.get(s.id) || { roles: [], held: new Set() };
          const inIt = memberOf.has(s.id);
          return `
          <div class="ap-server" data-ws="${s.id}">
            <label class="ap-server-head">
              <input type="checkbox" data-member ${inIt ? 'checked' : ''} />
              <b>${esc(s.name)}</b>
            </label>
            <div class="ap-roles">${info.roles.length
              ? info.roles.map((r) => `
                <label class="ap-role${info.held.has(r.id) ? ' on' : ''}">
                  <input type="checkbox" data-role="${r.id}" ${info.held.has(r.id) ? 'checked' : ''} />
                  <span>${esc(r.name)}</span>
                </label>`).join('')
              : '<span class="muted">No roles in this server yet.</span>'}</div>
          </div>`;
        }).join('') || '<div class="empty">This organisation has no live servers.</div>'}
      </div>

      <h3 class="ap-h3">Access</h3>
      <div class="ap-danger">
        <div class="ap-danger-row">
          <div><b>Give them a new password</b>
            <div class="muted">Works once, then they choose their own. Whatever they have now stops working.</div></div>
          <button class="sm ghost" id="mpReset">New password</button>
        </div>
        <div class="ap-danger-row">
          <div><b>Remove from ${esc(org.name)}</b>
            <div class="muted">Out of the organisation and every server in it. Anything they wrote stays.</div></div>
          <button class="sm danger" id="mpRemove">Remove</button>
        </div>
      </div>`;

    box.querySelector('#mpSave').onclick = async () => {
      const btn = box.querySelector('#mpSave');
      btn.disabled = true;
      try {
        await api.adminSetMemberIdentity(org.org_id, person.user_id, {
          display_name: box.querySelector('#mpName').value.trim() || null,
          title: box.querySelector('#mpTitle').value.trim() || null,
        });
        UI.toast('Saved', 'success');
        await paint();
        refresh();
      } catch (e) {
        UI.toast(/field_locked/.test(e.message || '')
          ? 'That field is locked for this organisation. Change it under Rules first.'
          : e.message, 'error');
      } finally { btn.disabled = false; }
    };

    box.querySelector('#mpOrgRole').onchange = async (e) => {
      try {
        await api.setOrgRole(org.org_id, person.user_id, e.target.value);
        UI.toast('Role updated', 'success');
        refresh();
      } catch (err) {
        UI.toast(/last_admin/.test(err.message || '')
          ? 'That is the only admin left. Make somebody else an admin first.'
          : err.message, 'error');
        await paint();
      }
    };

    box.querySelectorAll('.ap-server').forEach((node) => {
      const wsId = node.dataset.ws;
      node.querySelector('[data-member]').onchange = async (e) => {
        const on = e.target.checked;
        try {
          await api.orgSetServerMember(org.org_id, wsId, person.user_id, on);
          UI.toast(on ? 'Added to that server' : 'Taken out of that server', 'success');
          await paint();
          refresh();
        } catch (err) { UI.toast(err.message, 'error'); await paint(); }
      };
      node.querySelectorAll('[data-role]').forEach((cb) => {
        cb.onchange = async (e) => {
          try {
            await api.orgSetMemberRole(org.org_id, wsId, person.user_id, cb.dataset.role, e.target.checked);
            UI.toast(e.target.checked ? 'Role given' : 'Role removed', 'success');
            await paint();
          } catch (err) {
            UI.toast(/not_in_server/.test(err.message || '')
              ? 'Add them to that server first.'
              : err.message, 'error');
            await paint();
          }
        };
      });
    });

    box.querySelector('#mpReset').onclick = async () => {
      if (await resetPersonPassword(fresh, org, UI)) { await paint(); refresh(); }
    };
    box.querySelector('#mpRemove').onclick = async () => {
      const ok = await UI.confirmModal({
        title: `Remove ${fresh.display_name || fresh.email}?`,
        body: `They lose access to ${org.name} and every server inside it, straight away. `
            + 'Anything they have written stays. They can be added again later.',
        confirmLabel: 'Remove', danger: true,
      });
      if (!ok) return;
      try {
        await api.removeOrgMember(org.org_id, person.user_id);
        UI.toast('Removed', 'success');
        m.close();
        refresh();
      } catch (e) {
        UI.toast(/last_admin/.test(e.message || '')
          ? 'That is the only admin left. Make somebody else an admin first.'
          : e.message, 'error');
      }
    };
  };

  await paint().catch((e) => {
    box.innerHTML = `<div class="empty">${esc(e.message || 'Could not load this person.')}</div>`;
  });
}

// ------------------------------------------------------------------ servers
async function drawServers(host, org) {
  // Refetched rather than read from current.overview: this section can be the
  // first one opened, and it needs scheduled_delete_at to know whether the
  // organisation itself is already counting down.
  const [servers, o] = await Promise.all([
    api.listOrgServers(org.org_id),
    api.orgOverview(org.org_id),
  ]);
  current.overview = o;

  const liveServers = servers.filter((s) => !s.archived_at && !s.scheduled_delete_at);
  const noneOpen = liveServers.length > 0 && !liveServers.some((s) => s.join_policy === 'open');

  host.innerHTML = `
    <div class="ap-rowhead">
      <h2 class="ap-h2">Servers <span class="muted">${servers.filter((s) => !s.archived_at).length} live</span></h2>
      <button class="sm" id="apNewServer">＋ New server</button>
    </div>
    ${noneOpen ? `<div class="ap-warn">
      <b>Your invite link cannot put anybody anywhere.</b>
      <span>An invite joins somebody to every server marked "anyone with the link", and
        ${esc(org.name)} has none. They will join the organisation and land in an empty app.
        Open at least one server below, or add people to servers one at a time.</span>
      <button class="sm" id="apOpenFirst">Let anyone into ${esc(liveServers[0].name)}</button>
    </div>` : ''}
    <div class="ap-table">${servers.map((s) => {
      const doomed = !!s.scheduled_delete_at;
      const gone = !!s.archived_at;
      return `
      <div class="ap-server-row${gone ? ' off' : ''}" data-ws="${s.id}">
        <span class="ap-av" style="--h:${hueOf(s.id)}">${esc(initials(s.name))}</span>
        <div class="ap-person-main">
          <b>${esc(s.name)}</b>
          ${doomed ? `<span class="ap-chip warn">deleting ${esc(relTime(s.scheduled_delete_at))}</span>`
            : gone ? '<span class="ap-chip">archived</span>' : ''}
          ${s.join_policy === 'open'
            ? '<span class="ap-chip ok">anyone with the link</span>'
            : '<span class="ap-chip">invite only</span>'}
          <div class="muted ap-person-sub">${s.members} member${s.members === 1 ? '' : 's'} · ${s.channels} channel${s.channels === 1 ? '' : 's'}</div>
        </div>
        <div class="ap-acts">
          ${gone
            ? `<button class="sm ghost" data-a="restore">Restore</button>
               ${doomed ? '<button class="sm danger" data-a="purge">Delete now</button>' : ''}`
            : `<button class="sm ghost" data-a="open">Open</button>
               <button class="sm ghost" data-a="policy">${s.join_policy === 'open'
                 ? 'Make invite only' : 'Let anyone in'}</button>
               <button class="sm ghost" data-a="rename">Rename</button>
               <button class="sm ghost" data-a="archive">Archive</button>
               <button class="sm danger" data-a="delete">Delete</button>`}
        </div>
      </div>`;
    }).join('') || '<div class="empty">No servers yet.</div>'}</div>`;

  host.querySelector('#apOpenFirst')?.addEventListener('click', async () => {
    const first = liveServers[0];
    const ok = await UI.confirmModal({
      title: 'Let anyone into ' + first.name + '?',
      body: 'Anybody who opens an invite link for ' + org.name + ' joins this server '
          + 'automatically. Its private channels stay private. You can close it again at any time.',
      confirmLabel: 'Let them in',
    });
    if (!ok) return;
    try {
      await api.setJoinPolicy(first.id, 'open');
      UI.toast('Your invite link now lands people in ' + first.name, 'success');
      refresh();
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  host.querySelector('#apNewServer').onclick = async () => {
    const out = await UI.formModal({
      title: 'New server',
      note: 'It starts with a #general channel that everybody in it can post in.',
      fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'Field Team' }],
      submitLabel: 'Create',
    });
    if (!out) return;
    try {
      await api.orgCreateServer(org.org_id, out.name.trim());
      UI.toast('Server created', 'success');
      await loadSpaces();
      refresh();
    } catch (e) { UI.toast(e.message, 'error'); }
  };

  host.querySelectorAll('.ap-server-row').forEach((row) => {
    const id = row.dataset.ws;
    const s = servers.find((x) => x.id === id);
    const act = (name, fn) => row.querySelector(`[data-a="${name}"]`)?.addEventListener('click', fn);

    act('open', async () => {
      closeAdminPage();
      await loadSpaces();
      const ws = store.spaces.find((x) => x.id === id);
      if (ws) await switchWorkspace(ws);
      else UI.toast('You are not in that server. Add yourself under People to open it.', 'error');
    });

    act('policy', async () => {
      const toOpen = s.join_policy !== 'open';
      // Opening a server is a privacy decision, so it is confirmed and the
      // consequence is spelled out. Closing one is not - it only ever removes
      // reach - so it goes straight through.
      if (toOpen) {
        const ok = await UI.confirmModal({
          title: 'Let anyone into ' + s.name + '?',
          body: 'Anybody who opens an invite link for ' + org.name + ' joins this server '
              + 'automatically, without anyone approving them. Its private channels stay private. '
              + 'You can close it again at any time.',
          confirmLabel: 'Let them in',
        });
        if (!ok) return;
      }
      try {
        await api.setJoinPolicy(id, toOpen ? 'open' : 'invite');
        UI.toast(toOpen ? 'Anyone with the link can join ' + s.name
                        : s.name + ' is invite only now', 'success');
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    act('rename', async () => {
      const out = await UI.formModal({
        title: 'Rename ' + s.name,
        fields: [{ name: 'name', label: 'Name', value: s.name, required: true }],
        submitLabel: 'Save',
      });
      if (!out) return;
      try {
        await api.updateWorkspace(id, { name: out.name.trim() });
        UI.toast('Renamed', 'success');
        await loadSpaces();
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    act('archive', async () => {
      const ok = await UI.confirmModal({
        title: 'Archive ' + s.name,
        body: 'It keeps every message and every member, stops taking new posts, and comes out of '
            + "everybody's rail. You can put it back at any time.",
        confirmLabel: 'Archive',
      });
      if (!ok) return;
      try {
        await api.archiveWorkspace(id, true);
        UI.toast('Archived', 'success');
        await loadSpaces();
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    act('restore', async () => {
      try {
        // Restoring covers both states: archived, and scheduled for deletion.
        if (s.scheduled_delete_at) await api.restoreWorkspace(id);
        else await api.archiveWorkspace(id, false);
        UI.toast('Restored', 'success');
        await loadSpaces();
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    act('delete', async () => {
      const ok = await UI.typeToConfirm({
        title: 'Delete ' + s.name,
        body: `Every channel, message and file in ${s.name} is destroyed. It is scheduled for seven `
            + 'days out so you can still stop it, and nothing here can bring it back afterwards. '
            + 'Archiving keeps all of it.',
        phrase: s.name,
        confirmLabel: 'Schedule deletion',
      });
      if (!ok) return;
      try {
        const when = await api.deleteWorkspace(id);
        UI.toast(`Scheduled for ${new Date(when).toLocaleDateString()}. You can still cancel it.`, 'success');
        await loadSpaces();
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
    });

    // Seven days is the right default and used to be the only option, so an
    // admin clearing up a mistyped server watched the thing they deleted sit in
    // this list for a week. This is the second deliberate step that ends it.
    act('purge', async () => {
      const ok = await UI.typeToConfirm({
        title: 'Delete ' + s.name + ' now',
        body: `This destroys every channel, message and file in ${s.name} immediately, rather than `
            + 'waiting out the seven days. There is no undo after this.',
        phrase: s.name,
        confirmLabel: 'Delete now',
      });
      if (!ok) return;
      try {
        await api.purgeWorkspaceNow(id);
        UI.toast('Deleted', 'success');
        await loadSpaces();
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
    });
  });

  // The escape hatch that did not exist. An organisation created by mistake
  // could be renamed and emptied of people and never removed - and its last
  // server could not be deleted either, so the mistake outlived everything in
  // it. That is what "I am an admin and I cannot delete a server" was.
  const doomedOrg = !!current.overview?.scheduled_delete_at;
  const box = el('div', 'ap-danger');
  box.style.marginTop = 'var(--s-7)';
  box.innerHTML = `
    <div class="ap-danger-row">
      <div>
        <b>${doomedOrg ? 'This organisation is being deleted' : 'Delete ' + esc(org.name)}</b>
        <div class="muted">${doomedOrg
          ? 'Every server in it is already dark. You can still stop this.'
          : 'Every server, channel, message and file in this organisation, and everybody\'s '
            + 'membership of it. Scheduled seven days out so it can be stopped.'}</div>
      </div>
      <button class="sm ${doomedOrg ? '' : 'danger'}" id="apOrgDelete">
        ${doomedOrg ? 'Cancel deletion' : 'Delete organisation'}</button>
    </div>`;
  host.appendChild(el('h2', 'ap-h2', 'The whole organisation'));
  host.appendChild(box);

  box.querySelector('#apOrgDelete').onclick = async () => {
    if (doomedOrg) {
      try {
        await api.restoreOrganization(org.org_id);
        UI.toast('Deletion cancelled. Every server is back.', 'success');
        current.overview = null;
        await loadSpaces();
        refresh();
      } catch (e) { UI.toast(e.message, 'error'); }
      return;
    }
    const ok = await UI.typeToConfirm({
      title: 'Delete ' + org.name,
      body: `Everything in ${org.name} goes: every server, every channel, every message and file, `
          + 'and everybody\'s place in it. It is scheduled for seven days out so you can still stop '
          + 'it, and after that nothing brings it back.',
      phrase: org.name,
      confirmLabel: 'Schedule deletion',
    });
    if (!ok) return;
    try {
      const when = await api.deleteOrganization(org.org_id);
      UI.toast(`Scheduled for ${new Date(when).toLocaleDateString()}. You can still cancel it.`, 'success');
      await loadSpaces();
      refresh();
    } catch (e) { UI.toast(e.message, 'error'); }
  };
}

// ------------------------------------------------------------------ permissions
//
// The screen the whole 0073 migration exists for. Every row is one sentence with
// one dropdown, because the alternative - forty checkboxes per role over a
// bitfield, which is what the schema actually stores - is not a screen anybody
// running an NGO is going to use correctly.
//
// The wording of the loosest option matters more than it looks. A policy narrows
// a permission and can never grant one, so "Everyone" does not mean everyone can
// do this; it means the rules do not stand in the way and the permission still
// decides. Calling it "Everyone" would be a lie in every row that has a bit
// behind it, and those are most of them.
const SCOPE_LABEL = {
  nobody: 'Nobody at all',
  org_admins: 'Organisation admins only',
  server_admins: 'Server admins and above',
  moderators: 'Moderators and above',
  members: 'Any member',
  everyone: 'Anyone who has the permission',
};
const SCOPE_LABEL_NOBIT = { ...SCOPE_LABEL, everyone: 'Anyone, including guests' };

async function drawPermissions(host, org) {
  const [pol, servers] = await Promise.all([
    api.getPolicies(org.org_id, current.permServer || null),
    api.listOrgServers(org.org_id),
  ]);
  if (!pol) throw new Error('You are not a member of this organisation.');
  const live = servers.filter((s) => !s.archived_at);
  const ranks = new Map(pol.scopes.map((s) => [s.key, s.rank]));
  const ladder = pol.scopes.slice().sort((a, b) => b.rank - a.rank); // loosest first

  const cats = [];
  for (const a of pol.actions) {
    let c = cats.find((x) => x.name === a.category);
    if (!c) { c = { name: a.category, rows: [] }; cats.push(c); }
    c.rows.push(a);
  }

  const optionsFor = (a, selected) => ladder
    .filter((s) => ranks.get(s.key) >= ranks.get(a.floor))
    .map((s) => {
      const label = (a.bit === null ? SCOPE_LABEL_NOBIT : SCOPE_LABEL)[s.key] || s.key;
      return `<option value="${esc(s.key)}"${s.key === selected ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');

  host.innerHTML = `
    <div class="ap-rowhead">
      <h2 class="ap-h2">Who can do what</h2>
      <label class="ap-permscope">
        <span class="muted">Showing</span>
        <select id="apPermServer">
          <option value="">${esc(org.name)} - everywhere</option>
          ${live.map((s) => `<option value="${s.id}"${current.permServer === s.id ? ' selected' : ''}>
            ${esc(s.name)}</option>`).join('')}
        </select>
      </label>
    </div>
    <p class="ap-lede">These take effect the moment you change them, for everybody in
      ${esc(org.name)}. A setting here can only ever <b>narrow</b> what somebody's role already
      lets them do - it never hands anybody a permission they were not given. Somebody who is
      not allowed sees the button greyed out with the reason, rather than being let press it
      and refused afterwards.</p>
    ${current.permServer ? `<div class="ap-note">
      You are looking at one server. A server can be <b>stricter</b> than the organisation and
      never more open, so options above the organisation's setting are not offered here.
      Clear it back to blank to hand the decision back to the organisation.</div>` : ''}

    ${cats.map((c) => `
      <h3 class="ap-h3">${esc(c.name)}</h3>
      <div class="ap-rules">
        ${c.rows.map((a) => {
          const shown = current.permServer && a.scope === 'server'
            ? (a.server_value || a.effective) : (a.org_value || a.effective);
          const inherited = current.permServer && a.scope === 'server' && !a.server_value;
          const orgOnly = current.permServer && a.scope === 'org';
          return `
          <div class="ap-rule" data-action="${esc(a.key)}">
            <div>
              <b>${esc(a.label)}</b>
              ${inherited ? '<span class="ap-chip">from the organisation</span>' : ''}
              ${orgOnly ? '<span class="ap-chip">organisation-wide</span>' : ''}
              <div class="muted">${esc(a.hint || '')}</div>
            </div>
            <select data-key="${esc(a.key)}" ${!pol.can_edit || orgOnly ? 'disabled' : ''}>
              ${current.permServer && a.scope === 'server'
                ? `<option value=""${!a.server_value ? ' selected' : ''}>Same as the organisation</option>`
                : ''}
              ${optionsFor(a, shown)}
            </select>
          </div>`;
        }).join('')}
      </div>`).join('')}

    ${pol.can_edit ? '' : `<div class="ap-note">
      You can read these because they apply to you. Only an admin of ${esc(org.name)} can change them.</div>`}`;

  host.querySelector('#apPermServer').onchange = (e) => {
    current.permServer = e.target.value || null;
    draw();
  };

  if (!pol.can_edit) return;
  host.querySelectorAll('[data-key]').forEach((sel) => {
    let last = sel.value;
    sel.onchange = async () => {
      const key = sel.dataset.key;
      const value = sel.value === '' ? null : sel.value;
      sel.disabled = true;
      try {
        if (current.permServer) await api.setServerPolicy(current.permServer, key, value);
        else await api.setOrgPolicy(org.org_id, key, value);
        last = sel.value;
        UI.toast('Saved. Everybody sees this immediately.', 'success');
        // Repaint: one change can move what a sibling row inherits.
        await draw();
      } catch (e) {
        sel.value = last;
        const m = String(e.message || '');
        UI.toast(
          /below_floor/.test(m) ? 'That would leave nobody able to do this.'
          : /looser_than_org/.test(m) ? 'A server can be stricter than its organisation, never more open.'
          : m, 'error');
      } finally { sel.disabled = false; }
    };
  });
}

// ------------------------------------------------------------------ rules
const RULE_OPTIONS = [
  ['anyone', 'Anyone can change their own'],
  ['admins', 'Only admins can set it'],
  ['locked', 'Locked - nobody can change it, including admins'],
];

async function drawRules(host, org) {
  const o = current.overview || await api.orgOverview(org.org_id);
  const pol = o.identity_policy || {};
  const row = (key, label, hint) => `
    <div class="ap-rule">
      <div><b>${esc(label)}</b><div class="muted">${esc(hint)}</div></div>
      <select data-rule="${key}">${RULE_OPTIONS.map(([v, t]) =>
        `<option value="${v}"${(pol[key] || 'anyone') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
    </div>`;

  host.innerHTML = `
    <h2 class="ap-h2">Who can change what</h2>
    <p class="ap-lede">These apply to everybody in ${esc(org.name)} and take effect the moment you
      save. Somebody whose field is not theirs to change sees it greyed out with the reason, rather
      than being allowed to type into it and refused afterwards.</p>
    <div class="ap-rules">
      ${row('name', 'Names', 'What they are called in the member list and on every message.')}
      ${row('title', 'Titles', 'Their designation. Describes what they do; grants nothing.')}
      ${row('pronouns', 'Pronouns', 'Shown on their profile card.')}
      ${row('avatar', 'Profile pictures', 'Their picture, where one is set.')}
    </div>
    <button id="apSaveRules" class="wide">Save these rules</button>
    <div class="ap-note">
      <div><b>Locked is stronger than admins-only.</b> An admin cannot edit round a locked field
      either, so an organisation that has to say a name is exactly what HR entered can say it.</div>
      <div>Somebody in more than one organisation gets the <b>strictest</b> rule that applies to
      them, so joining a second organisation is never a way out of this one's.</div>
    </div>`;

  host.querySelector('#apSaveRules').onclick = async () => {
    const btn = host.querySelector('#apSaveRules');
    btn.disabled = true;
    try {
      const next = {};
      host.querySelectorAll('[data-rule]').forEach((s) => { next[s.dataset.rule] = s.value; });
      const saved = await api.setOrgIdentityPolicy(org.org_id, next);
      current.overview = { ...o, identity_policy: saved };
      UI.toast('Saved. Everybody sees this immediately.', 'success');
    } catch (e) { UI.toast(e.message, 'error'); } finally { btn.disabled = false; }
  };
}

// ------------------------------------------------------------------ leave
// A summary and one button. get_leave_policy answers for any member of the
// organisation and materialises the defaults when nothing has been configured,
// so this never has a "not set up yet" state to carry.
const LEAVE_KIND_LABEL = {
  leave: 'Leave', sick: 'Sick', holiday: 'Holiday', exam: 'Exams',
  travel: 'Travelling for work', wfh: 'Working from home', emergency: 'Could not show up',
};
const kindList = (a) => (a || []).map((k) => LEAVE_KIND_LABEL[k] || k).join(', ') || 'none';

async function drawLeave(host, org) {
  const pol = await api.rpc('get_leave_policy', { p_org: org.org_id });
  host.innerHTML = `
    <h2 class="ap-h2">How leave works in ${esc(org.name)}</h2>
    <p class="ap-lede">Everybody in this organisation applies from the <b>Time off</b> section in
      the sidebar of any Space. Anything inside the allowance below is approved the moment it is
      filed; everything else waits for an admin here. Nothing is ever deleted, so the total each
      person has taken is answerable for as long as they are with you.</p>
    <div class="ap-rules">
      <div class="ap-rule"><div><b>${esc(String(pol.auto_approve_per_month))} days a month</b>
        <div class="muted">Approved automatically, per person. Everything past this comes to you.</div></div></div>
      <div class="ap-rule"><div><b>${esc(String(pol.max_stretch_days))} days</b>
        <div class="muted">The longest single application anybody may file. Exam leave is the
          reason this is usually more than a week.</div></div></div>
      <div class="ap-rule"><div><b>Spends the allowance</b>
        <div class="muted">${esc(kindList(pol.quota_kinds))}</div></div></div>
      <div class="ap-rule"><div><b>Not a leave at all</b>
        <div class="muted">${esc(kindList(pol.free_kinds))} - no approval, spends nothing.</div></div></div>
      <div class="ap-rule"><div><b>Always needs approval</b>
        <div class="muted">${esc(kindList(pol.approval_kinds))}</div></div></div>
      <div class="ap-rule"><div><b>Always raised with you</b>
        <div class="muted">${esc(kindList(pol.flag_kinds))}${pol.flag_backdated
          ? ', and anything filed after the absence had already begun' : ''}</div></div></div>
      ${pol.note ? `<div class="ap-rule"><div><b>Shown on the form</b>
        <div class="muted">${esc(pol.note)}</div></div></div>` : ''}
    </div>
    <button id="apLeaveEdit" class="wide">Change the policy</button>
    <div class="ap-note">
      <div><b>A flag is not a punishment, it is a record.</b> An absence nobody can see is the one
      that costs the team. Raised entries stay on the person's ledger and only an admin here can
      clear one.</div>
    </div>`;
  host.querySelector('#apLeaveEdit').onclick = () =>
    bus.emit('leave:policy', { orgId: org.org_id });
}

// ------------------------------------------------------------------ register
export function register(app) {
  // Belt and braces beside the registry gate in features/index.js: if this file
  // is ever reached through another path, an embedded frame still must not
  // mount the org console - #/admin in a host's iframe is the exact thing the
  // gating exists to stop.
  if (embed.active) return;
  UI = app.ui;
  injectCss();

  // A real route, so it is linkable and the back button works.
  const openFromHash = () => {
    const m = (location.hash || '').match(/^#\/admin(?:\/([a-z]+))?/);
    if (m) openAdminPage(null, m[1]);
    else if (mounted) closeAdminPage();
  };
  window.addEventListener('hashchange', openFromHash);
  bus.on('auth', () => { if ((location.hash || '').startsWith('#/admin')) openFromHash(); });

  bus.on('orgadmin:open', (o) => {
    history.replaceState(null, '', location.pathname + location.search + '#/admin');
    openAdminPage(o?.orgId);
  });

  app.ui.addHeaderButton({
    id: 'orgadmin',
    // Imported straight from the set rather than reached for through app.ui: the
    // ui object exported by ui.js has never carried an icon(), so the guard this
    // replaces always fell through to its emoji, and the one gear in the header
    // was the only glyph up there drawn by the operating system.
    label: icon('settings'),
    title: 'Organisation settings',
    order: 190,
    show: () => isOrgAdmin(store.ws?.org_id),
    onClick: () => bus.emit('orgadmin:open', { orgId: store.ws?.org_id }),
  });

  app.ui.addSlashCommand({
    name: 'org',
    description: 'Open the organisation settings page',
    run: () => bus.emit('orgadmin:open', { orgId: store.ws?.org_id }),
  });
}

const CSS = `
/* Scoped INSIDE #chat on purpose. A bare "body.admin-page main" also matched
   this page's own <main class="ap-main"> and hid the console inside itself. */
body.admin-page #chat{display:none!important}
body.admin-page #topbar,body.admin-page #spaceRail,body.admin-page #sidebar,
body.admin-page #chat main,body.admin-page #channelbar{display:none!important}
.adminpage{position:fixed;inset:0;z-index:60;overflow-y:auto;background:var(--c-bg);
  padding-bottom:var(--safe-b)}
.adminpage.hidden{display:none}
.ap-top{position:sticky;top:0;z-index:2;background:var(--c-bg);
  border-bottom:1px solid var(--c-border);padding:var(--s-5) var(--s-6);
  padding-top:calc(var(--s-5) + var(--safe-t))}
.ap-back{background:transparent;border:0;padding:0;min-height:0;color:var(--c-text-2);font-size:var(--t-sm)}
.ap-back:hover{color:var(--c-text)}
.ap-title{display:flex;align-items:center;gap:var(--s-5);margin-top:var(--s-4)}
.ap-mark{flex:none;display:grid;place-items:center;width:44px;height:44px;border-radius:var(--r-lg);
  background:hsl(var(--h) 45% 32%);color:#fff;font-weight:700}
.ap-title h1{font-size:var(--t-2xl);font-weight:var(--t-bold);letter-spacing:-.02em;line-height:1.15}
.ap-body{display:grid;grid-template-columns:1fr;max-width:1000px;margin:0 auto;padding:var(--s-6)}
/* Width questions measure the dek container (#app), not the viewport, so the
   wide layout keys off the box this page actually renders into - a same-document
   embed on a big host window must not read the host's width as its own. */
@container dek (min-width:880px){.ap-body{grid-template-columns:180px 1fr;gap:var(--s-7)}
  .ap-nav{position:sticky;top:120px;align-self:start}}
.ap-nav{display:flex;flex-wrap:wrap;gap:2px;margin-bottom:var(--s-5)}
@container dek (min-width:880px){.ap-nav{flex-direction:column;margin-bottom:0}}
.ap-nav button{justify-content:flex-start;background:transparent;border:0;text-align:left;
  padding:var(--s-3) var(--s-4);border-radius:var(--r-md);color:var(--c-text-2);font-size:var(--t-sm)}
.ap-nav button:hover{background:var(--c-surface-2,var(--c-surface));color:var(--c-text)}
.ap-nav button.on{background:var(--c-accent-quiet);color:var(--c-accent);font-weight:var(--t-semibold)}
.ap-main{min-width:0;
  /* display:block, and it MUST be stated. This element is a <main>, and
     css/layout.css:366 styles the bare tag main, display flex, for the app
     shell's three-column frame - which this page is not part of, but the
     selector does not know that. So every section of the organisation console
     laid itself out as a FLEX ROW: on a 390px phone the content measured 988px
     wide inside a 358px box, giving vertical strips of one-word-per-line text
     running off the right edge, with a stranded Save button in the middle of
     them. It was equally wrong on a desktop, just wide enough to hide it. */
  display:block}
.ap-h2{font-size:var(--t-lg);font-weight:var(--t-bold);margin:var(--s-6) 0 var(--s-3)}
${APPS_CSS}
.ap-h2:first-child{margin-top:0}
.ap-h3{font-size:var(--t-base);font-weight:var(--t-semibold);margin:var(--s-6) 0 var(--s-3)}
.ap-lede{color:var(--c-text-2);font-size:var(--t-sm);line-height:var(--t-loose);margin-bottom:var(--s-5);max-width:62ch}
.ap-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--s-4)}
.ap-stat{background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--r-lg);padding:var(--s-5)}
.ap-stat b{display:block;font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.02em}
.ap-stat span{display:block;margin-top:2px;color:var(--c-text-2);font-size:var(--t-xs);line-height:1.4}
.ap-stat.bad b{color:var(--c-danger)}
.ap-note{margin-top:var(--s-5);padding:var(--s-4) var(--s-5);border-radius:var(--r-md);
  background:var(--c-surface);border-left:3px solid var(--c-accent);font-size:var(--t-sm);
  line-height:var(--t-loose);display:flex;flex-direction:column;gap:var(--s-2)}
.ap-note.ok{border-left-color:var(--c-success,#2f855a)}
.ap-form{background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--r-lg);
  padding:var(--s-5);display:flex;flex-direction:column;gap:var(--s-4)}
.ap-grid2{display:grid;grid-template-columns:1fr 1fr;gap:var(--s-4)}
@container dek (max-width:560px){.ap-grid2{grid-template-columns:1fr}}
.ap-rowhead{display:flex;align-items:center;justify-content:space-between;gap:var(--s-4);flex-wrap:wrap}
.ap-rowhead-tools{display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap}
.ap-rowhead-tools button{flex:none}
.ap-search{max-width:280px}
.ap-table{margin-top:var(--s-4);border:1px solid var(--c-border);border-radius:var(--r-lg);overflow:hidden}
.ap-person,.ap-server-row{display:flex;align-items:center;gap:var(--s-4);padding:var(--s-4) var(--s-5);
  border-bottom:1px solid var(--c-border-subtle,var(--c-border));background:var(--c-surface)}
.ap-person:last-child,.ap-server-row:last-child{border-bottom:0}
.ap-server-row.off{opacity:.6}
.ap-av{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;
  background:hsl(var(--h) 45% 32%);color:#fff;font-size:12px;font-weight:600}
.ap-av.big{width:48px;height:48px;font-size:16px}
.ap-person-main{flex:1 1 auto;min-width:0}
.ap-person-sub{font-size:var(--t-xs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-person-meta{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.ap-acts{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
@container dek (max-width:640px){.ap-person-meta{display:none}}
.ap-chip{display:inline-block;padding:1px 7px;margin-left:6px;border-radius:999px;font-size:11px;
  background:var(--c-bg);border:1px solid var(--c-border);color:var(--c-text-2);white-space:nowrap}
.ap-chip.admin{background:var(--c-accent-quiet);color:var(--c-accent);border-color:transparent}
.ap-chip.ok{color:var(--c-success,#2f855a)}
.ap-chip.warn{color:var(--c-danger)}
/* The one state that makes an organisation's invite link do nothing at all:
   every server invite-only, so a person joins the org and lands nowhere. Said
   on the screen that can fix it, with the fix on it. */
.ap-warn{display:grid;gap:var(--s-2);justify-items:start;margin:0 0 var(--s-4);
  padding:var(--s-3) var(--s-4);border-radius:var(--r-md);
  background:var(--c-warn-quiet,var(--c-bg-2));border:var(--bw) solid var(--c-border)}
.ap-warn b{font-weight:var(--t-bold)}
.ap-warn span{color:var(--c-text-2);font-size:var(--t-sm);line-height:var(--t-loose);max-width:64ch}
.ap-manage-head{display:flex;gap:var(--s-4);align-items:center;margin-bottom:var(--s-4)}
.ap-servers{display:flex;flex-direction:column;gap:var(--s-3)}
.ap-server{border:1px solid var(--c-border);border-radius:var(--r-md);padding:var(--s-4)}
.ap-server-head{display:flex;align-items:center;gap:var(--s-3);cursor:pointer;min-height:32px}
.ap-roles{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--s-3);padding-left:26px}
.ap-role{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;
  border:1px solid var(--c-border);font-size:12px;cursor:pointer}
.ap-role.on{background:var(--c-accent-quiet);border-color:transparent;color:var(--c-accent)}
.ap-danger{border:1px solid color-mix(in srgb,var(--c-danger) 32%,var(--c-border));border-radius:var(--r-md);overflow:hidden}
.ap-danger-row{display:flex;align-items:center;justify-content:space-between;gap:var(--s-5);
  padding:var(--s-4);border-bottom:1px solid var(--c-border-subtle,var(--c-border))}
.ap-danger-row:last-child{border-bottom:0}
.ap-danger-row .muted{font-size:var(--t-xs);line-height:var(--t-loose);margin-top:2px}
.ap-rules{display:flex;flex-direction:column;gap:var(--s-3)}
.ap-rule{display:flex;align-items:center;justify-content:space-between;gap:var(--s-5);
  background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--r-md);padding:var(--s-4)}
.ap-rule select{max-width:300px}
.ap-rule select:disabled{opacity:.55;cursor:not-allowed}
.ap-permscope{display:flex;align-items:center;gap:var(--s-3);font-size:var(--t-sm)}
.ap-permscope select{max-width:260px}
.ap-rule .muted{font-size:var(--t-xs);line-height:var(--t-loose);margin-top:2px}
@media(max-width:640px){.ap-rule{flex-direction:column;align-items:stretch}.ap-rule select{max-width:none}}
`;

function injectCss() {
  if (document.getElementById('orgadmin-css')) return;
  const s = document.createElement('style');
  s.id = 'orgadmin-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}
