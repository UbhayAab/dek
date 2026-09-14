// The two admin jobs that are done constantly, put where a phone can reach them.
//
// Adding somebody to the organisation is the single most repeated administrative
// act there is, and on a phone it was four steps behind a menu nobody opens: tap
// the overflow "..." in the channel bar, find "Admin console", wait for a panel,
// find the People tab, then find the button. Every one of those steps is fine on
// a laptop with sixteen header buttons on screen. On a 390px phone there are two
// visible actions and everything else is behind one unlabelled glyph.
//
// So: a labelled row in the sidebar, in the same group as Tasks and Forms, that
// goes straight to the dialog. Same code path, same permissions, same result
// panel where the temporary password is shown - this adds a door, it does not
// add a second implementation.
//
// The rows only exist for somebody who can actually use them. A row that opens
// something and then says "you do not have permission" is worse than no row.
import { store, bus, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc } from '../util.js';
import { icon } from '../icons.js';
import { embed } from '../embed.js';
import { addPeopleDialog, canManagePeople } from './people.js';

const CLS = 'anav';
let uiRef = null;

// people.js keeps currentOrg() private and exposes the question rather than the
// answer, so ask it the same way and read the org out of the store the same way
// it does.
const currentOrg = () => {
  const orgId = store.ws?.org_id;
  if (!orgId) return null;
  return (store.orgs || []).find((x) => x.org_id === orgId) || null;
};

const ROWS = [
  {
    id: 'addpeople',
    ico: 'plus',
    label: 'Add people',
    show: () => canManagePeople(),
    run: () => {
      const org = currentOrg();
      if (!org) { uiRef.toast('You are not an admin of this organisation', 'error'); return; }
      addPeopleDialog(org, uiRef, { onDone: () => bus.emit('profiles') });
    },
  },
  // The "Browse servers" row used to live here, under a heading that says "Run
  // this Space". Finding the other servers is not an operator's job - it is the
  // single most common complaint from ordinary members - so it moved to
  // features/servers.js, which puts it directly under the channel list where
  // the list of what you already have runs out.
  {
    id: 'invitelink',
    ico: 'link',
    label: 'Invite with a link',
    // Any MEMBER, not only an admin: create_org_invite has minted member links
    // for anybody in the org since 0107, and the whole point of the QR sheet is
    // that somebody standing next to a new colleague can get them in without
    // finding an admin first. It was reachable only by long-pressing the org
    // tile on the rail or by digging through the servers modal - two gestures
    // with nothing on screen to suggest either exists.
    show: () => !embed.active && !!store.ws?.org_id
      && (store.orgs || []).some((o) => o.org_id === store.ws.org_id),
    run: async () => {
      const { openShareSheet } = await import('./orgshare.js');
      await openShareSheet(store.ws.org_id);
    },
  },
  {
    id: 'people',
    ico: 'members',
    label: 'Who is in this Space',
    show: () => !embed.active && (hasPerm(PERM.MANAGE_WORKSPACE) || store.isAdmin),
    run: () => uiRef.openPanel('admin', { tab: 'members' }),
  },
  {
    id: 'org',
    ico: 'shield',
    label: 'Organisation',
    // Everything that is bigger than one Space: the people, the servers, the
    // rules, and removing any of them. It was reachable only by long-pressing a
    // rail tile - a gesture with nothing on screen to suggest it exists - or by
    // typing /org, and on a phone the rail tile is 44px of initials.
    show: () => !embed.active && (store.orgs || []).find((o) => o.org_id === store.ws?.org_id)?.org_role === 'admin',
    run: () => bus.emit('orgadmin:open', { orgId: store.ws?.org_id }),
  },
  {
    id: 'voice',
    ico: 'volume',
    label: 'Voice rooms',
    // Only when there is something to open. An empty room list is a real state
    // and the panel explains it, but it does not deserve a permanent row.
    show: () => (store.channels || []).some((c) => c.kind === 'voice' && !c.archived_at),
    run: () => uiRef.openPanel('voice'),
  },
];

function paint(host) {
  if (!store.ws) { host.innerHTML = ''; return; }
  const rows = ROWS.filter((r) => !r.show || r.show());
  if (!rows.length) { host.innerHTML = ''; return; }

  // Same markup as the channel list and coordnav, so these inherit the sidebar's
  // hover, touch-target and truncation rules instead of inventing their own.
  let h = `<h3><span>Run this Space</span></h3><div class="navgroup ${CLS}-group">`;
  for (const r of rows) {
    h += `<div class="chan ${CLS}-row" data-anav="${esc(r.id)}" title="${esc(r.label)}">
      <span class="ch-ico">${icon(r.ico)}</span>
      <span class="ch-name">${esc(r.label)}</span></div>`;
  }
  h += '</div>';
  host.innerHTML = h;

  host.querySelectorAll('[data-anav]').forEach((n) => {
    const def = ROWS.find((r) => r.id === n.dataset.anav);
    n.onclick = () => {
      // The drawer is an overlay on a phone. Leaving it open over the dialog it
      // just opened is how a modal ends up behind a menu.
      document.body.classList.remove('nav-open');
      def.run();
    };
  });
}

function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  // coordnav's rows have the same problem and solve it the same way: the channel
  // list uses a text glyph in .ch-ico and these are SVGs, so they need a size
  // and have to take the row's colour like everything else in the shell.
  s.textContent = `
.${CLS}-row .ch-ico{display:inline-flex;align-items:center;justify-content:center}
.${CLS}-row .ch-ico .ico{width:16px;height:16px}`;
  document.head.appendChild(s);
}

export function register(app) {
  uiRef = app.ui;
  style();

  app.ui.addNavSection({
    id: CLS,
    // After coordination, which is what everybody uses, and before nothing.
    // Running the Space is a smaller and rarer job than doing the work in it.
    order: 60,
    render: (host) => paint(host),
  });

  // The rows appear and disappear with permissions and with the channel list, so
  // they have to be repainted when either changes rather than only at boot.
  for (const e of ['workspace', 'channels', 'auth', 'voice:state']) {
    bus.on(e, () => app.ui.renderNavSections());
  }

  app.ui.addSlashCommand({
    name: 'addpeople',
    description: 'Add people to this organisation by email',
    run: () => {
      const row = ROWS[0];
      if (!row.show()) { app.ui.toast('Only an organisation admin can add people', 'error'); return; }
      row.run();
    },
  });
}
