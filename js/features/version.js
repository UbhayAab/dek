// Install the app, get the latest version, and be able to say which one you are on.
//
// Reported as a team problem, not a bug: "my team is facing a lot of problem
// with actually being on the same version. It will be great if you can put an
// install button in the menu bar or somewhere, and also an update button."
//
// The mechanics were all in js/pwa.js already. What was missing was anywhere to
// press. Specifically:
//
//   THE UPDATE OFFER WAS A TWENTY-SECOND TOAST. If you were not looking at the
//   screen in that window - a phone in a pocket, which is most of this team most
//   of the time - the offer was gone and there was no second one. So this keeps
//   a chip in the top bar and a row in the drawer for as long as an update is
//   waiting. It does not expire. That is the whole point.
//
//   THERE WAS NO "GET THE LATEST" ANYWHERE. Somebody on an old bundle with no
//   toast had literally no move except closing every tab and hoping. Now there
//   is one button that always does something useful and says what it did.
//
//   NOBODY COULD NAME THEIR VERSION. VERSION lived inside sw.js and the page
//   could not read it, so "are we on the same one?" was unanswerable even in
//   principle. sw.js answers a VERSION message now and this prints it, big
//   enough to read out on a call.
//
//   AND THE INSTALL BUTTON WAS HIDDEN FROM MOST PEOPLE. It was gated on the
//   browser having fired beforeinstallprompt, which on Chromium needs the
//   install criteria met and does not fire twice in a session. pwa.js now gates
//   it on "not already installed" instead, and this adds the row to the drawer
//   and the phone overflow menu, where somebody looking for it would look.
//
// Nothing here talks to the service worker directly: pwa.js owns the
// registration and publishes state on the bus, and two modules holding opinions
// about one worker is how an update button ends up lying.
import { bus } from '../store.js';
import { el, esc } from '../util.js';
import { icon } from '../icons.js';
import { checkForUpdate, applyUpdate, hardReset, promptInstall, updateState, swVersion }
  from '../pwa.js';

const PANEL = 'version';
const CLS = 'vsn';

let uiRef = null;
let navHost = null;
let state = updateState();

// ------------------------------------------------------------------ the chip
// Lives next to Install in the top bar, appears only when an update is actually
// waiting, and does not go away until it is taken.
function paintChip() {
  const host = document.getElementById('installBtn')?.parentElement;
  if (!host) return;
  let chip = document.getElementById('updateBtn');
  if (!state.waiting) { chip?.remove(); return; }
  if (!chip) {
    chip = el('button', 'install ' + CLS + '-chip');
    chip.id = 'updateBtn';
    chip.type = 'button';
    chip.innerHTML = `${icon('download')} <span>Update</span>`;
    chip.title = 'A new version of Dek is ready. Click to take it.';
    chip.onclick = () => applyUpdate();
    host.insertBefore(chip, document.getElementById('installBtn'));
  }
}

// ------------------------------------------------------------------ the drawer
function paintNav(host) {
  navHost = host;
  const rows = [];
  if (state.waiting) {
    rows.push({ id: 'take', ico: 'download', label: 'Update ready - restart now', hot: true,
      onClick: () => applyUpdate() });
  }
  if (state.canInstall) {
    rows.push({ id: 'install', ico: 'download', label: 'Install this app',
      onClick: () => promptInstall() });
  }
  rows.push({ id: 'about', ico: 'contrast',
    label: state.version ? `Version ${shortVersion(state.version)}` : 'App version',
    onClick: () => uiRef?.openPanel(PANEL, {}) });

  let h = '<h3><span>This app</span></h3><div class="navgroup ' + CLS + '-group">';
  for (const r of rows) {
    h += `<div class="chan ${CLS}-row${r.hot ? ' ' + CLS + '-hot' : ''}" data-vsn="${esc(r.id)}"
            title="${esc(r.label)}">
      <span class="ch-ico">${icon(r.ico)}</span>
      <span class="ch-name">${esc(r.label)}</span></div>`;
  }
  h += '</div>';
  host.innerHTML = h;
  host.querySelectorAll('[data-vsn]').forEach((n) => {
    n.onclick = rows.find((r) => r.id === n.dataset.vsn).onClick;
  });
}

// dek-v51 reads better than dek-v51 does in a sentence, but the full string is
// what somebody should read out, so the panel shows all of it and only the row
// is trimmed.
const shortVersion = (v) => String(v || '').replace(/^dek-/, '');

// ------------------------------------------------------------------ the panel
async function renderPanel(host) {
  host.innerHTML = '';
  // Re-ask on open rather than trusting what boot cached: a controllerchange in
  // another tab can have moved this page on since.
  const live = await swVersion().catch(() => null);
  if (live) state = { ...state, version: live };

  const card = el('div', CLS + '-card');
  card.innerHTML = `
    <div class="${CLS}-label">You are running</div>
    <div class="${CLS}-big">${esc(state.version || 'an un-installed copy')}</div>
    <div class="muted">${state.version
      ? 'Read this out to compare with somebody else. If the two differ, the one with the older number should press the button below.'
      : 'No offline copy is installed on this device yet, so this page is whatever the server sent just now. Install it below and it will keep itself current.'}</div>`;
  host.appendChild(card);

  const status = el('div', CLS + '-status');
  host.appendChild(status);
  const say = (text, kind) => {
    status.className = CLS + '-status' + (kind ? ' ' + CLS + '-' + kind : '');
    status.textContent = text;
  };
  say(state.waiting
    ? 'A newer version is downloaded and waiting. Restart to take it.'
    : state.lastCheckedAt
      ? 'Checked ' + rel(state.lastCheckedAt) + '.'
      : 'Not checked yet on this device.', state.waiting ? 'hot' : '');

  const acts = el('div', CLS + '-acts');

  if (state.waiting) {
    acts.appendChild(button('Restart on the new version', 'primary', () => applyUpdate()));
  }

  acts.appendChild(button('Check for a new version', '', async (b) => {
    b.disabled = true;
    say('Checking…');
    const r = await checkForUpdate();
    b.disabled = false;
    if (r.state === 'waiting') {
      say('A newer version is ready. Restart to take it.', 'hot');
      state = updateState();
      uiRef.refreshPanel({});
      return;
    }
    if (r.state === 'current') say('You are on the latest version.', 'ok');
    else if (r.state === 'unsupported') {
      say('This browser cannot keep an offline copy, so this page is always whatever '
        + 'the server sent. Reload the page to be sure.');
    } else say('Could not reach the server to check: ' + (r.error || 'no detail'), 'bad');
  }));

  if (state.canInstall) {
    acts.appendChild(button('Install this app on this device', '', () => promptInstall()));
  }

  host.appendChild(acts);

  const why = el('div', CLS + '-note');
  why.innerHTML = `<b>Why people end up on different versions</b>
    <p class="muted">Dek keeps a copy of itself on your device so it opens instantly and works
      with no signal. A new copy is downloaded in the background and only swapped in when you
      restart, so nothing changes under you mid-conversation. Leave the app open for days and
      you keep the copy you started with.</p>
    <p class="muted">Installing it helps: an installed app checks every time you open it.</p>`;
  host.appendChild(why);

  // The escape hatch. Deliberately last, deliberately plain, deliberately not
  // called "clear cache" - the people who need it are not going to search for
  // that phrase.
  const reset = el('div', CLS + '-note');
  reset.innerHTML = `<b>Still stuck on an old screen?</b>
    <p class="muted">This throws away the stored copy of the app and downloads it again from
      scratch. Your messages, photos and voice notes are not touched, and you stay signed in.
      It takes a few seconds on a slow connection.</p>`;
  const nuke = button('Reinstall the app from scratch', 'danger', async () => {
    const okay = await uiRef.confirmModal({
      title: 'Reinstall Dek on this device?',
      body: 'The stored copy of the app is deleted and downloaded again. Nothing you have '
        + 'written is affected and you stay signed in. Do this if you are stuck on an old screen.',
      confirmLabel: 'Reinstall it',
    });
    if (okay) hardReset();
  });
  reset.appendChild(nuke);
  host.appendChild(reset);
}

function button(label, kind, onClick) {
  const b = el('button', CLS + '-btn' + (kind ? ' ' + CLS + '-' + kind : ''), label);
  b.type = 'button';
  b.onclick = () => onClick(b);
  return b;
}

function rel(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  return `${Math.round(s / 3600)} hours ago`;
}

// ------------------------------------------------------------------ styles
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-row .ch-ico{display:inline-flex;align-items:center;justify-content:center}
.${CLS}-row .ch-ico svg{width:15px;height:15px}
.${CLS}-hot .ch-name{color:var(--c-accent,#5b8cff);font-weight:600}
.${CLS}-chip{background:var(--c-accent,#5b8cff);color:#fff;border:0}
.${CLS}-chip svg{width:14px;height:14px}
.${CLS}-card{margin:10px;padding:12px;border:1px solid var(--line);border-radius:10px;
  background:var(--panel)}
.${CLS}-label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.${CLS}-big{font-size:22px;font-weight:700;margin:2px 0 6px;word-break:break-all}
.${CLS}-card .muted{font-size:12.5px;line-height:1.5}
.${CLS}-status{margin:0 10px 8px;font-size:13px;color:var(--dim)}
.${CLS}-status.${CLS}-hot{color:var(--c-accent,#5b8cff);font-weight:600}
.${CLS}-status.${CLS}-ok{color:var(--green,#3a9d5d)}
.${CLS}-status.${CLS}-bad{color:var(--red,#d64545)}
.${CLS}-acts{display:flex;flex-direction:column;gap:6px;padding:0 10px 10px}
.${CLS}-btn{display:block;width:100%;padding:9px 12px;border-radius:10px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel2);color:var(--text);
  font-size:13.5px;text-align:left}
.${CLS}-btn:hover{border-color:var(--accent)}
.${CLS}-btn[disabled]{opacity:.6;cursor:default}
.${CLS}-primary{background:var(--c-accent,#5b8cff);color:#fff;border-color:transparent;
  font-weight:600}
.${CLS}-danger{color:var(--red,#d64545);border-style:dashed;margin-top:8px}
.${CLS}-note{padding:4px 12px 14px;font-size:13px}
.${CLS}-note p{margin:4px 0}
.${CLS}-note .muted{font-size:12.5px;line-height:1.5}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  style();

  ui.registerPanel({ id: PANEL, title: 'App version', icon: icon('download'), render: renderPanel });

  ui.addNavSection({
    id: 'version',
    // The very bottom of the drawer, under "Run this Space" (60). It is a thing
    // you need twice a month, not twice an hour, and putting it above the
    // channels would be the other mistake.
    order: 70,
    render: (host) => paintNav(host),
  });

  ui.addSlashCommand({
    name: 'version',
    description: 'Which version you are on, and how to get the newest one',
    run: () => ui.openPanel(PANEL, {}),
  });
  ui.addSlashCommand({
    name: 'update',
    description: 'Get the latest version of Dek',
    run: async () => {
      const r = await checkForUpdate();
      if (r.state === 'waiting') return applyUpdate();
      if (r.state === 'current') return ui.toast('You are already on the latest version', 'success');
      return ui.openPanel(PANEL, {});
    },
  });
  ui.addSlashCommand({
    name: 'install',
    description: 'Install Dek as an app on this device',
    run: () => promptInstall(),
  });

  bus.on('version:state', (s) => {
    const was = state;
    state = s || updateState();
    paintChip();
    if (navHost?.isConnected
        && (was.waiting !== state.waiting || was.version !== state.version
            || was.canInstall !== state.canInstall)) {
      paintNav(navHost);
    }
  });

  // The drawer is rebuilt on a Space switch and the chip's host row is rebuilt
  // by the shell, so re-assert both rather than assuming they survived.
  bus.on('workspace', () => { paintChip(); ui.renderNavSections(); });
  bus.on('auth', () => paintChip());
  paintChip();
}

export default { register };
