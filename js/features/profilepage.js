// A person, as a PAGE, at #/u/<id>.
//
// The existing profile is a card in a modal: name, pronouns, a presence dot, the
// roles you happen to share. That answers "who just said that" and stops. In an
// NGO the profile is also the staff directory - what do they do, which team, who
// do they report to, which servers are they actually in, what am I allowed to
// change about them - and a 380px modal over a conversation is the wrong shape
// for all of it. Same reasoning as the organisation console: a page, not a
// drawer.
//
// The rule that shapes every section: NOTHING IS DRAWN THAT THE VIEWER CANNOT
// HAVE. The server decides who sees an email address, which servers are listed,
// and which fields are editable; this file draws what it is handed. A field the
// organisation has locked appears locked, with the reason, rather than being
// offered and refused on save - that is the lesson identity_policy already
// taught and it is worth keeping.
import { store, bus } from '../store.js';
import { api } from '../api.js';
import { $, el, esc, initials, hueOf, relTime, fmt } from '../util.js';
// Core, not another feature. Message is the one action on a profile that has to
// land somewhere real rather than emit an event nothing listens for.
import { startDM } from '../core/dms.js';
import { roleTagHtml } from '../core/messages.js';

let UI = null;
let current = null;   // { userId, data }
let mounted = false;

const LOCK_NOTE = {
  admins: 'Your organisation has an admin set this. Ask them to change it.',
  locked: 'Your organisation has locked this field. Nobody can change it, including admins.',
};

// A time in their timezone, so "is it reasonable to message them" is answerable
// without arithmetic. Slack, Teams and Workday all show this and it is the
// single cheapest useful thing on a profile.
function localTime(tz) {
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit', timeZone: tz,
    }).format(new Date());
  } catch { return null; }
}

export async function openProfilePage(userId) {
  if (!userId) return;
  current = { userId, data: null };
  document.body.classList.add('profile-page');
  $('chat')?.classList.add('hidden');

  let page = $('profilePage');
  if (!page) {
    page = el('div', 'profpage');
    page.id = 'profilePage';
    document.getElementById('app').appendChild(page);
  }
  page.classList.remove('hidden');
  mounted = true;
  await draw();
}

export function closeProfilePage() {
  mounted = false;
  document.body.classList.remove('profile-page');
  $('profilePage')?.classList.add('hidden');
  $('chat')?.classList.remove('hidden');
  if (location.hash.startsWith('#/u/')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

const refresh = () => draw();

async function draw() {
  if (!mounted) return;
  const page = $('profilePage');
  page.innerHTML = '<div class="loading-space"><span class="spin"></span>Loading…</div>';

  let p;
  try {
    p = await api.profilePage(current.userId);
  } catch (e) {
    page.innerHTML = `<div class="pp-top">
        <button class="ap-back" id="ppBack">← Back to Dek</button>
      </div>
      <div class="loadfail">
        <h2>Could not open this profile</h2>
        <p class="muted">${esc(/forbidden/.test(e.message || '')
          ? 'You do not share a server with them, so their profile is not yours to read.'
          : (e.message || 'no further detail'))}</p>
      </div>`;
    page.querySelector('#ppBack').onclick = closeProfilePage;
    return;
  }
  current.data = p;

  const can = p.can || {};
  const time = localTime(p.timezone);
  const presence = p.never_signed_in ? { cls: 'new', text: 'has not signed in yet' }
    : p.dnd ? { cls: 'dnd', text: 'do not disturb' }
    : p.online ? { cls: 'on', text: 'online' }
    : { cls: 'off', text: 'offline' };

  const detail = (label, value, extra = '') => value
    ? `<div class="pp-detail"><dt>${esc(label)}</dt><dd>${esc(value)}${extra}</dd></div>` : '';

  const person = (u, sub) => `
    <button class="pp-person" data-goto="${u.user_id}">
      <span class="pp-av sm" style="--h:${hueOf(u.user_id)}">${esc(initials(u.display_name))}</span>
      <span><b>${esc(u.display_name || 'somebody')}</b>
        ${sub || (u.title ? `<span class="muted">${esc(u.title)}</span>` : '')}</span>
    </button>`;

  page.innerHTML = `
    <header class="pp-top">
      <button class="ap-back" id="ppBack">← Back to Dek</button>
    </header>

    <div class="pp-body">
      <section class="pp-hero">
        <span class="pp-av big" style="--h:${hueOf(p.user_id)}">${esc(initials(p.display_name || p.username))}</span>
        <div class="pp-hero-main">
          <h1>${esc(p.display_name || p.username || 'Somebody')}
            ${roleTagHtml(p.user_id)}
            ${p.pronouns ? `<span class="pp-pronouns">${esc(p.pronouns)}</span>` : ''}</h1>
          ${p.title ? `<p class="pp-title">${esc(p.title)}</p>` : ''}
          <p class="pp-presence"><span class="pp-dot ${presence.cls}"></span>${esc(presence.text)}
            ${p.status_text ? ` · ${esc(p.status_emoji || '')} ${esc(p.status_text)}` : ''}
            ${time ? ` · ${esc(time)} their time` : ''}</p>
        </div>
        <div class="pp-hero-acts">
          ${can.message ? '<button class="sm" id="ppMessage">Message</button>' : ''}
          ${can.edit_self ? '<button class="sm ghost" id="ppEditSelf">Edit your profile</button>' : ''}
          ${can.edit_as_admin ? '<button class="sm ghost" id="ppEditAdmin">Edit their details</button>' : ''}
        </div>
      </section>

      ${p.bio ? `<section class="pp-sec"><h2>About</h2>
        <div class="pp-bio">${fmt(p.bio)}</div></section>` : ''}

      <section class="pp-sec">
        <h2>Details</h2>
        <dl class="pp-details">
          ${detail('Title', p.title)}
          ${detail('Team', p.department)}
          ${detail('Where', p.location)}
          ${detail('Started', p.start_date ? new Date(p.start_date).toLocaleDateString(undefined,
            { year: 'numeric', month: 'long', day: 'numeric' }) : null)}
          ${detail('Local time', time ? `${time} (${p.timezone})` : null)}
          ${p.email ? `<div class="pp-detail"><dt>Email</dt><dd>
            <a href="mailto:${esc(p.email)}">${esc(p.email)}</a></dd></div>` : ''}
          ${p.phone ? `<div class="pp-detail"><dt>Phone</dt><dd>
            <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a></dd></div>` : ''}
          ${detail('On Dek since', p.created_at ? relTime(p.created_at) : null)}
        </dl>
        ${!p.email && !p.phone && !p.department && !p.location && !p.start_date
          ? '<p class="muted">Nothing filled in yet.</p>' : ''}
      </section>

      ${(p.manager || (p.reports || []).length) ? `
      <section class="pp-sec">
        <h2>Reporting</h2>
        <p class="muted pp-note">Who somebody reports to is recorded here so a directory can show
          it. It grants nothing and gates nothing - what people are allowed to do comes from their
          roles and from the organisation's rules.</p>
        ${p.manager ? `<h3 class="pp-h3">Reports to</h3>
          <div class="pp-people">${person(p.manager)}</div>` : ''}
        ${(p.reports || []).length ? `<h3 class="pp-h3">Direct reports
          <span class="muted">${p.reports.length}</span></h3>
          <div class="pp-people">${p.reports.map((r) => person(r)).join('')}</div>` : ''}
      </section>` : ''}

      <section class="pp-sec">
        <h2>Servers ${p.is_self ? '' : `<span class="muted">you both have</span>`}</h2>
        ${(p.servers || []).length ? `<div class="pp-servers">
          ${p.servers.map((s) => `
            <div class="pp-server">
              <span class="pp-av sm" style="--h:${hueOf(s.id)}">${esc(initials(s.name))}</span>
              <div class="pp-server-main">
                <b>${esc(s.name)}</b>
                <div class="muted">joined ${esc(relTime(s.joined_at))}</div>
              </div>
              <div class="pp-roles">${(s.roles || []).length
                ? s.roles.map((r) => `<span class="pp-role">${esc(r.name)}</span>`).join('')
                : '<span class="muted">no roles</span>'}</div>
            </div>`).join('')}
        </div>` : `<p class="muted">${p.is_self
          ? 'You are not in any server yet.'
          : 'No servers you can both see.'}</p>`}
      </section>

      ${(p.orgs || []).length ? `
      <section class="pp-sec">
        <h2>Organisations</h2>
        <div class="pp-people">${p.orgs.map((o) => `
          <span class="pp-org">${esc(o.name)}
            ${o.org_role === 'admin' ? '<span class="ap-chip admin">admin</span>' : ''}</span>`).join('')}
        </div>
      </section>` : ''}

      <section class="pp-sec">
        <h2>Work</h2>
        <p>${p.open_tasks > 0
          ? `<b>${p.open_tasks}</b> open task${p.open_tasks === 1 ? '' : 's'} you can see.`
          : 'No open tasks you can see.'}</p>
        <p class="muted pp-note">Tasks in channels you are not in are not counted, and never
          appear here.</p>
      </section>
    </div>`;

  page.querySelector('#ppBack').onclick = closeProfilePage;
  page.querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = () => {
      history.replaceState(null, '', location.pathname + location.search + '#/u/' + b.dataset.goto);
      openProfilePage(b.dataset.goto);
    };
  });
  page.querySelector('#ppMessage')?.addEventListener('click', () => {
    closeProfilePage();
    startDM(p.user_id);
  });
  page.querySelector('#ppEditSelf')?.addEventListener('click', () => editSelf(p));
  page.querySelector('#ppEditAdmin')?.addEventListener('click', () => editAsAdmin(p));
}

// ------------------------------------------------------------------ editing
// A field the organisation has locked is shown locked with the reason. Offering
// it and refusing on save is how somebody types a paragraph and loses it.
async function editSelf(p) {
  const can = p.can || {};
  const lockNote = (rule) => (rule && rule !== 'anyone' ? LOCK_NOTE[rule] : null);
  const fields = [
    { name: 'display_name', label: 'Your name', value: p.display_name || '',
      hint: lockNote(can.name), disabled: can.name !== 'anyone' },
    { name: 'title', label: 'Your title', value: p.title || '', placeholder: 'Interview Intern',
      hint: lockNote(can.title) || 'Describes what you do. It grants nothing.',
      disabled: can.title !== 'anyone' },
    { name: 'pronouns', label: 'Pronouns', value: p.pronouns || '',
      placeholder: 'she/her, he/him, they/them',
      hint: lockNote(can.pronouns), disabled: can.pronouns !== 'anyone' },
    { name: 'bio', label: 'About you', type: 'textarea', rows: 4, value: p.bio || '',
      placeholder: 'What you work on, what to ask you about',
      hint: lockNote(can.bio), disabled: can.bio && can.bio !== 'anyone' },
    { name: 'location', label: 'Where you are', value: p.location || '', placeholder: 'Lucknow' },
    { name: 'phone', label: 'Phone', value: p.phone || '',
      hint: 'Who can see this is your organisation\'s setting, not yours.' },
  ].filter((f) => !f.disabled);

  if (!fields.length) {
    UI.modal({ title: 'Your profile', body: el('div', 'empty',
      'Your organisation sets every one of these. Ask an admin to change them.') });
    return;
  }

  const out = await UI.formModal({
    title: 'Your profile', fields, submitLabel: 'Save',
    note: 'Everybody who shares a server with you sees this.',
  });
  if (!out) return;
  try {
    await api.setMyProfileFields(out);
    UI.toast('Saved', 'success');
    // Keep the rest of the app honest without a reload.
    const patch = { display_name: out.display_name || p.display_name, title: out.title,
      pronouns: out.pronouns };
    store.myProfile = { ...(store.myProfile || {}), ...patch, id: store.me };
    store.profiles.set(store.me, { ...(store.profiles.get(store.me) || {}), ...patch });
    bus.emit('profiles');
    refresh();
  } catch (e) {
    UI.toast(/field_locked/.test(e.message || '')
      ? 'Your organisation does not let people change that themselves.'
      : e.message, 'error');
  }
}

async function editAsAdmin(p) {
  const org = p.can?.org_id;
  if (!org) return;
  let managers = [];
  try { managers = await api.orgManagerOptions(org, p.user_id); } catch { /* picker is optional */ }

  const out = await UI.formModal({
    title: 'Their details',
    note: 'This is what the organisation holds about them. A title and a team describe what '
        + 'somebody does; neither grants anything.',
    fields: [
      { name: 'display_name', label: 'Name', value: p.display_name || '' },
      { name: 'title', label: 'Title', value: p.title || '', placeholder: 'Interview Intern' },
      { name: 'department', label: 'Team', value: p.department || '', placeholder: 'Field Team' },
      { name: 'start_date', label: 'Started', type: 'date',
        value: p.start_date ? String(p.start_date).slice(0, 10) : '' },
      { name: 'manager', label: 'Reports to', type: 'select',
        value: p.manager?.user_id || '',
        hint: 'Shown on their profile. It grants nothing and gates nothing.',
        options: [{ value: '', label: 'Nobody' }].concat(
          managers.map((m) => ({ value: m.user_id, label: m.display_name + (m.title ? ` - ${m.title}` : '') }))) },
    ],
    submitLabel: 'Save',
  });
  if (!out) return;

  try {
    await api.adminSetMemberProfile(org, p.user_id, {
      display_name: out.display_name, title: out.title, department: out.department,
      start_date: out.start_date || null,
      manager: out.manager || null,
      // An empty pick has to mean "clear it", not "leave it": coalesce would
      // otherwise make "Nobody" a no-op and the field unclearable.
      clear_manager: !out.manager,
    });
    UI.toast('Saved', 'success');
    refresh();
  } catch (e) {
    const m = String(e.message || '');
    UI.toast(
      /field_locked/.test(m) ? 'That field is locked for this organisation. Change it under Rules first.'
      : /manager_cycle/.test(m) ? 'Those two would report to each other.'
      : /self_manager/.test(m) ? 'Somebody cannot report to themselves.'
      : /manager_not_in_org/.test(m) ? 'Their manager has to be in this organisation.'
      : m, 'error');
  }
}

// ------------------------------------------------------------------ register
export function register(app) {
  UI = app.ui;
  injectCss();

  const openFromHash = () => {
    const m = (location.hash || '').match(/^#\/u\/([0-9a-f-]{36})/i);
    if (m) openProfilePage(m[1]);
    else if (mounted) closeProfilePage();
  };
  window.addEventListener('hashchange', openFromHash);
  bus.on('auth', () => { if ((location.hash || '').startsWith('#/u/')) openFromHash(); });

  // The one way in, so every caller gets the same page and the same route.
  bus.on('profile:page', (o) => {
    const id = o?.userId || o?.user_id;
    if (!id) return;
    history.replaceState(null, '', location.pathname + location.search + '#/u/' + id);
    openProfilePage(id);
  });

  app.ui.addSlashCommand({
    // NOT /me. In every chat product ever made /me is the IRC action verb, and
    // shortcuts.js implements exactly that. Both were registered, the registry
    // is a Map, and features load in parallel - so which one you got depended on
    // which file's request came back first.
    name: 'myprofile',
    description: 'Open your profile',
    run: () => bus.emit('profile:page', { userId: store.me }),
  });

  app.ui.addSwitcherSource({
    id: 'people',
    search(q) {
      const needle = String(q || '').trim().toLowerCase();
      if (needle.length < 2) return [];
      const out = [];
      for (const [id, pr] of store.profiles) {
        const name = pr?.display_name || pr?.username || '';
        if (!name.toLowerCase().includes(needle)) continue;
        out.push({
          label: name,
          hint: pr?.title || 'profile',
          run: () => bus.emit('profile:open', { userId: id }),
        });
        if (out.length >= 8) break;
      }
      return out;
    },
  });
}

const CSS = `
body.profile-page #chat{display:none!important}
body.profile-page #topbar,body.profile-page #spaceRail,body.profile-page #sidebar,
body.profile-page #chat main,body.profile-page #channelbar{display:none!important}
.profpage{position:fixed;inset:0;z-index:60;overflow-y:auto;background:var(--c-bg);
  padding-bottom:var(--safe-b)}
.profpage.hidden{display:none}
.pp-top{position:sticky;top:0;z-index:2;background:var(--c-bg);
  border-bottom:1px solid var(--c-border);padding:var(--s-5) var(--s-6);
  padding-top:calc(var(--s-5) + var(--safe-t))}
.pp-body{max-width:760px;margin:0 auto;padding:var(--s-6)}
.pp-hero{display:flex;gap:var(--s-5);align-items:flex-start;flex-wrap:wrap}
.pp-hero-main{flex:1 1 240px;min-width:0}
.pp-hero-main h1{font-size:var(--t-2xl);font-weight:var(--t-bold);letter-spacing:-.02em;line-height:1.15}
.pp-pronouns{font-size:var(--t-sm);font-weight:400;color:var(--c-text-2);margin-left:var(--s-3)}
.pp-title{color:var(--c-text-2);margin-top:2px}
.pp-presence{color:var(--c-text-2);font-size:var(--t-sm);margin-top:var(--s-3);
  display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pp-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--c-text-2)}
.pp-dot.on{background:var(--c-success,#2f855a)}
.pp-dot.dnd{background:var(--c-danger)}
.pp-dot.new{background:var(--c-accent)}
.pp-hero-acts{display:flex;gap:var(--s-3);flex-wrap:wrap}
.pp-av{flex:none;display:grid;place-items:center;border-radius:50%;
  background:hsl(var(--h) 45% 32%);color:#fff;font-weight:600}
.pp-av.big{width:76px;height:76px;font-size:26px}
.pp-av.sm{width:32px;height:32px;font-size:12px}
.pp-sec{margin-top:var(--s-7)}
.pp-sec h2{font-size:var(--t-lg);font-weight:var(--t-bold);margin-bottom:var(--s-4)}
.pp-h3{font-size:var(--t-sm);font-weight:var(--t-semibold);color:var(--c-text-2);
  margin:var(--s-4) 0 var(--s-3)}
.pp-note{font-size:var(--t-xs);line-height:var(--t-loose);max-width:60ch;margin-bottom:var(--s-4)}
.pp-bio{background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--r-lg);
  padding:var(--s-5);line-height:var(--t-loose)}
.pp-details{background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--r-lg);
  overflow:hidden}
.pp-detail{display:flex;gap:var(--s-5);padding:var(--s-4) var(--s-5);
  border-bottom:1px solid var(--c-border-subtle,var(--c-border))}
.pp-detail:last-child{border-bottom:0}
.pp-detail dt{flex:0 0 130px;color:var(--c-text-2);font-size:var(--t-sm)}
.pp-detail dd{flex:1 1 auto;min-width:0;word-break:break-word}
@container dek (max-width:520px){.pp-detail{flex-direction:column;gap:2px}.pp-detail dt{flex:none}}
.pp-people{display:flex;flex-wrap:wrap;gap:var(--s-3)}
.pp-person{display:flex;align-items:center;gap:var(--s-3);background:var(--c-surface);
  border:1px solid var(--c-border);border-radius:999px;padding:4px 14px 4px 4px;
  min-height:0;text-align:left}
.pp-person:hover{border-color:var(--c-accent)}
.pp-person .muted{display:block;font-size:var(--t-xs)}
.pp-org{display:inline-flex;align-items:center;background:var(--c-surface);
  border:1px solid var(--c-border);border-radius:999px;padding:5px 14px;font-size:var(--t-sm)}
.pp-servers{display:flex;flex-direction:column;gap:var(--s-3)}
.pp-server{display:flex;align-items:center;gap:var(--s-4);background:var(--c-surface);
  border:1px solid var(--c-border);border-radius:var(--r-md);padding:var(--s-4)}
.pp-server-main{flex:1 1 auto;min-width:0}
.pp-server-main .muted{font-size:var(--t-xs)}
.pp-roles{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.pp-role{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;
  background:var(--c-accent-quiet);color:var(--c-accent);white-space:nowrap}
`;

function injectCss() {
  if (document.getElementById('profilepage-css')) return;
  const s = document.createElement('style');
  s.id = 'profilepage-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}
