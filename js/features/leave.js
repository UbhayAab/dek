// Leave: applying, approving, and the ledger behind both.
//
// This started as "show who is on leave today in a side section". It is not
// that, and the correction was specific:
//
//   "It has to be two way. Anyone who's applying leave has to apply from this
//    dashboard only, because we need to maintain how many total number of
//    leaves any specific person had raised during their tenure here."
//
// So the sidebar section stays - who is out today is still the thing you look
// at forty times a day - but it is the surface of a system, not the system. The
// five things underneath it:
//
//   APPLY      one form, one row, a date RANGE. A four-day vacation is one
//              decision; nobody is going to file four of anything.
//   VERDICT    the form says which of the two things just happened, out loud.
//              "Filed" and "approved" are different outcomes and a screen that
//              says neither is how somebody ends up believing they have leave
//              they do not have.
//   LEDGER     every application this person ever made, including the ones they
//              cancelled, because that is the question that started this.
//   APPROVE    an inbox for coordinators: what is waiting, who it is from, and
//              what they have already spent this month, side by side.
//   POLICY     each organisation sets its own. Two auto-approved days a month
//              is Jarurat Care's number, not a law of nature.
//
// Every rule lives in the database (0130), never here. This file asks and
// paints. A client that decided what was auto-approved would disagree with the
// server the first time somebody had two tabs open.
import { rpc, table } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { el, esc } from '../util.js';
import { icon } from '../icons.js';

const PANEL = 'leave';
const CLS = 'away';                              // the 0129 class prefix, kept

// Labels and glyphs only. Which of these needs approval, spends the allowance
// or gets flagged is the policy's business and arrives with the balance.
const KINDS = [
  { id: 'leave',     label: 'Leave',                glyph: '🌴' },
  { id: 'sick',      label: 'Sick',                 glyph: '🤒' },
  { id: 'holiday',   label: 'Holiday',              glyph: '🎉' },
  { id: 'exam',      label: 'Exams',                glyph: '📚' },
  { id: 'travel',    label: 'Travelling for work',  glyph: '✈️' },
  { id: 'wfh',       label: 'Working from home',    glyph: '🏠' },
  { id: 'emergency', label: 'Could not show up',    glyph: '⚠️' },
];
const KIND = new Map(KINDS.map((k) => [k.id, k]));

const STATUS = {
  pending:   { label: 'Waiting for approval', cls: 'st-wait' },
  approved:  { label: 'Approved',             cls: 'st-ok' },
  rejected:  { label: 'Refused',              cls: 'st-no' },
  cancelled: { label: 'Cancelled',            cls: 'st-off' },
};

let uiRef = null;
let navHost = null;
let state = { day: null, away: [], mine: [], balance: null, inbox: 0, is_admin: false, org_id: null };
let loadedFor = null;
let inflight = null;

// ------------------------------------------------------------------ dates
// The server answers in Asia/Kolkata and hands back plain YYYY-MM-DD. Parsing
// one into a Date and formatting that would hand it to the browser's timezone
// and move it a day for anybody west of India, which is the whole bug the
// server-side date was chosen to avoid. Parse the parts, build in UTC, format
// in UTC.
function ymd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
const DAY = 86400000;
const fmtDay = (d, o) => d.toLocaleDateString(undefined, { timeZone: 'UTC', ...o });
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function backText(backOn, today) {
  const b = ymd(backOn); const t = ymd(today);
  if (!b || !t) return '';
  const days = Math.round((b - t) / DAY);
  if (days <= 0) return 'back today';
  if (days === 1) return 'back tomorrow';
  if (days <= 6) return 'back ' + fmtDay(b, { weekday: 'long' });
  return 'back ' + fmtDay(b, { day: 'numeric', month: 'short' });
}

function spanText(a) {
  const s = ymd(a.starts_on); const e = ymd(a.ends_on);
  if (!s || !e) return '';
  const f = { day: 'numeric', month: 'short' };
  const one = a.starts_on === a.ends_on;
  const n = a.days || Math.round((e - s) / DAY) + 1;
  return one ? fmtDay(s, f) : `${fmtDay(s, f)} to ${fmtDay(e, f)} (${n} days)`;
}

// ------------------------------------------------------------------ loading
async function load({ force = false } = {}) {
  const ws = store.ws?.id;
  if (!ws) { state = { day: null, away: [], mine: [], balance: null, inbox: 0 }; loadedFor = null; return state; }
  if (!force && loadedFor === ws) return state;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const out = await rpc('who_is_away', { p_workspace: ws });
      state = {
        day: out?.day || todayIst(),
        org_id: out?.org_id || store.ws?.org_id || null,
        is_admin: !!out?.is_admin,
        away: Array.isArray(out?.away) ? out.away : [],
        mine: Array.isArray(out?.mine) ? out.mine : [],
        balance: out?.balance || null,
        inbox: +out?.inbox || 0,
      };
      loadedFor = ws;
    } catch {
      // 0129/0130 not applied: switch the section off rather than painting an
      // error into the sidebar on every repaint.
      state = { day: null, away: [], mine: [], balance: null, inbox: 0, off: true };
      loadedFor = ws;
    } finally { inflight = null; }
    return state;
  })();
  return inflight;
}

async function refresh() {
  await load({ force: true });
  if (navHost?.isConnected) paintNav(navHost);
  if (uiRef?.currentPanel?.() === PANEL) uiRef.refreshPanel({ tab });
  bus.emit('leave:count', { inbox: state.inbox });
}

// ------------------------------------------------------------------ sidebar
// Drawn even when nobody is away. It is one muted line, and it is the only
// place the way in exists - a section that hides itself when empty can never
// teach anybody the feature is there, which is the complaint this app already
// had once about Later.
function paintNav(host) {
  navHost = host;
  if (!store.ws || state.off) { host.innerHTML = ''; return; }
  hydrateNames(state.away.map((a) => a.user_id));

  const waiting = state.mine.filter((m) => m.status === 'pending').length;
  let h = '<h3><span>Time off</span></h3><div class="navgroup ' + CLS + '-group">';

  if (!state.away.length) {
    h += `<div class="${CLS}-none muted">Everyone is in today</div>`;
  } else {
    for (const a of state.away.slice(0, 8)) {
      const k = KIND.get(a.kind) || KINDS[0];
      h += `<div class="chan ${CLS}-row" data-away-user="${esc(a.user_id)}"
              title="${esc(nameOf(a.user_id))}: ${esc(k.label.toLowerCase())}, ${esc(backText(a.back_on, state.day))}">
        <span class="ch-ico">${k.glyph}</span>
        <span class="ch-name">${esc(nameOf(a.user_id))}</span>
        <span class="${CLS}-back muted">${esc(backText(a.back_on, state.day))}</span>
      </div>`;
    }
    if (state.away.length > 8) {
      h += `<div class="chan ${CLS}-row" data-away-tab="today">
        <span class="ch-ico">⋯</span><span class="ch-name">${state.away.length - 8} more away</span></div>`;
    }
  }

  // An approver's inbox, only for an approver: who_is_away returns zero for
  // everybody else, so the row simply does not exist for them.
  if (state.inbox > 0) {
    h += `<div class="chan ${CLS}-row" data-away-tab="approvals">
      <span class="ch-ico">📥</span>
      <span class="ch-name">Leave to approve</span>
      <span class="badge">${state.inbox > 99 ? '99+' : state.inbox}</span></div>`;
  }
  if (waiting) {
    h += `<div class="chan ${CLS}-row" data-away-tab="mine">
      <span class="ch-ico">⏳</span>
      <span class="ch-name">${waiting === 1 ? 'My request is waiting' : `${waiting} of mine waiting`}</span></div>`;
  }

  h += `<div class="chan ${CLS}-row ${CLS}-book" data-away-tab="apply">
      <span class="ch-ico">＋</span><span class="ch-name">Apply for leave</span>
    </div></div>`;
  host.innerHTML = h;

  host.querySelectorAll('[data-away-user]').forEach((n) => {
    n.onclick = () => bus.emit('profile:open', { userId: n.dataset.awayUser, anchor: n });
  });
  host.querySelectorAll('[data-away-tab]').forEach((n) => {
    n.onclick = () => uiRef?.openPanel(PANEL, { tab: n.dataset.awayTab });
  });
}

let hydrating = false;
async function hydrateNames(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !store.profiles.get(id)?.display_name);
  if (!missing.length || hydrating) return;
  hydrating = true;
  try {
    for (const p of await table('profiles', (q) => q.in('id', missing.slice(0, 200)))) {
      store.profiles.set(p.id, { ...(store.profiles.get(p.id) || {}), ...p });
    }
    if (navHost?.isConnected) paintNav(navHost);
  } catch { /* names stay as ids until the next repaint */ } finally { hydrating = false; }
}

// ------------------------------------------------------------------ applying
//
// The balance is shown BEFORE the dates, not after the refusal. Somebody with
// no allowance left should know that while they are choosing, not once they
// have committed to a plan.
async function applyDialog(prefill = {}) {
  const org = state.org_id || store.ws?.org_id;
  if (!org) {
    uiRef?.toast('This Space is not part of an organisation yet, so there is nobody to tell', 'error');
    return;
  }
  const today = state.day || todayIst();
  let bal = state.balance;
  if (!bal) { try { bal = await rpc('leave_balance', { p_org: org, p_user: null, p_month: today }); } catch { bal = null; } }

  const quota = new Set(bal?.quota_kinds || ['leave', 'sick', 'holiday']);
  const free = new Set(bal?.free_kinds || ['wfh', 'travel']);
  const needs = new Set(bal?.approval_kinds || ['exam']);
  const left = Number(bal?.remaining ?? 0);

  // Say what each kind will actually do, on the option itself. This is the
  // whole policy, in the place the choice is made.
  const kindOpts = KINDS.map((k) => {
    let tail = '';
    if (free.has(k.id)) tail = ' - not a leave, no approval';
    else if (needs.has(k.id)) tail = ' - always needs approval';
    else if (quota.has(k.id)) tail = left > 0 ? ` - automatic while you have days left` : ' - needs approval, no days left';
    else if (k.id === 'emergency') tail = ' - recorded and raised with a coordinator';
    return { value: k.id, label: `${k.glyph} ${k.label}${tail}` };
  });

  const fields = [];
  let people = [];
  // Only an org admin may file for somebody else, and apply_leave enforces it,
  // so do not show a control that will be refused. An HR lead entering approved
  // leave for a volunteer with no laptop is the ordinary case here.
  if (state.is_admin) {
    people = await spaceMembers();
    if (people.length) {
      fields.push({
        name: 'who', label: 'Who is applying', type: 'select', value: prefill.who || store.me,
        options: [{ value: store.me, label: 'Me' },
          ...people.filter((p) => p.id !== store.me).map((p) => ({ value: p.id, label: p.name }))],
      });
    }
  }
  fields.push(
    { name: 'kind', label: 'What kind', type: 'select', value: prefill.kind || 'leave', options: kindOpts },
    { name: 'from', label: 'First day off', type: 'date', value: prefill.from || today, required: true },
    { name: 'to', label: 'Last day off', type: 'date', value: prefill.to || prefill.from || today,
      required: true, hint: 'The same day for a single day off' },
    { name: 'note', label: 'Why (optional)', placeholder: 'Reachable on WhatsApp for anything urgent' },
  );

  const note = balanceLine(bal)
    + (bal?.policy_note ? '\n' + bal.policy_note : '')
    + `\nThe longest single application here is ${bal?.max_stretch_days ?? 15} days.`;

  const out = await uiRef.formModal({
    title: 'Apply for leave', submitLabel: 'Send it', fields, note,
  });
  if (!out) return;
  if (out.to < out.from) { uiRef.toast('The last day is before the first day', 'error'); return; }

  try {
    const res = await rpc('apply_leave', {
      p_org: org,
      p_from: out.from,
      p_to: out.to,
      p_kind: out.kind || 'leave',
      p_note: out.note || null,
      p_user: out.who && out.who !== store.me ? out.who : null,
    });
    await refresh();
    verdict(res);
    return res;
  } catch (e) {
    uiRef.toast(explain(e), 'error');
    return null;
  }
}

function balanceLine(b) {
  if (!b) return '';
  const used = Number(b.used || 0);
  const allow = Number(b.allowance || 0);
  const left = Math.max(allow - used, 0);
  const head = left > 0
    ? `${left} of ${allow} automatic ${allow === 1 ? 'day' : 'days'} left this month.`
    : `You have used all ${allow} automatic ${allow === 1 ? 'day' : 'days'} this month, so this one goes to a coordinator.`;
  const pend = Number(b.pending_days || 0);
  return head + (pend ? ` ${pend} more ${pend === 1 ? 'day is' : 'days are'} already waiting on a decision.` : '');
}

// The half that decides whether somebody trusts this screen. Two outcomes, both
// said plainly, neither of them a bare toast that scrolls away in three seconds.
function verdict(res) {
  if (!res) return;
  const k = KIND.get(res.kind) || KINDS[0];
  const when = spanText(res);
  if (res.status === 'approved') {
    uiRef.modal({
      title: 'Approved',
      body: `<p><b>${esc(k.glyph + ' ' + k.label)}, ${esc(when)}</b></p>
        <p>That is approved${res.auto_approved ? ' automatically, under your organisation\'s policy' : ''}.
           Everyone in this Space can see you are out, and your status shows it on the day.</p>
        ${res.balance ? `<p class="muted">${esc(balanceLine(res.balance))}</p>` : ''}`,
      actions: [{ label: 'Done', onClick: (c) => c() }],
    });
  } else {
    uiRef.modal({
      title: 'Sent for approval',
      body: `<p><b>${esc(k.glyph + ' ' + k.label)}, ${esc(when)}</b></p>
        <p>This one needs a coordinator to say yes, so it is <b>not</b> time off yet.
           You will see it change here the moment somebody decides.</p>
        ${res.flagged ? `<p class="${CLS}-flagline">⚠ Raised with a coordinator: ${esc(res.flag_reason || '')}</p>` : ''}
        ${res.balance ? `<p class="muted">${esc(balanceLine(res.balance))}</p>` : ''}`,
      actions: [{ label: 'Done', onClick: (c) => c() }],
    });
  }
}

function explain(e) {
  const m = e?.message || '';
  const h = e?.hint || e?.details || '';
  if (/ends_before_it_starts/.test(m)) return 'The last day is before the first day';
  if (/too_long/.test(m)) return h || 'That is longer than a single application may be';
  if (/overlaps/.test(m)) return h || 'You already have time off booked across those dates';
  if (/not_a_member/.test(m)) return 'That person is not in this organisation';
  if (/already_taken/.test(m)) return h || 'That time off is in the past. Ask a coordinator to correct it.';
  if (/already_cancelled/.test(m)) return 'That one was cancelled, so there is nothing to decide';
  if (/forbidden/.test(m)) return h || 'You are not allowed to do that';
  if (/invalid_kind/.test(m)) return 'Pick one of the reasons in the list';
  return 'Could not do that';
}

let memberCache = { wsId: null, at: 0, list: [] };
async function spaceMembers() {
  const wsId = store.ws?.id;
  if (!wsId) return [];
  if (memberCache.wsId === wsId && Date.now() - memberCache.at < 120000) return memberCache.list;
  const rows = await table('workspace_members', (q) => q.eq('workspace_id', wsId));
  const ids = rows.map((r) => r.user_id);
  const unknown = ids.filter((u) => !store.profiles.has(u));
  if (unknown.length) {
    for (const p of await table('profiles', (q) => q.in('id', unknown.slice(0, 500)))) {
      store.profiles.set(p.id, { ...(store.profiles.get(p.id) || {}), ...p });
    }
  }
  const list = ids.filter((id) => !store.profiles.get(id)?.is_ghost)
    .map((id) => ({ id, name: nameOf(id) }))
    .sort((a, z) => a.name.localeCompare(z.name));
  memberCache = { wsId, at: Date.now(), list };
  return list;
}

// ------------------------------------------------------------------ the panel
let tab = 'today';

async function renderPanel(host, ctx = {}) {
  if (ctx.tab) tab = ctx.tab;
  host.innerHTML = '';
  if (!store.ws) { host.appendChild(el('div', 'muted pad', 'Open a Space first.')); return; }

  await load();
  if (state.off) {
    host.appendChild(el('div', 'muted pad', 'Time off is not switched on for this server yet.'));
    return;
  }

  const tabs = [
    { id: 'today', label: 'Away today' },
    { id: 'mine', label: 'Mine' },
    { id: 'apply', label: 'Apply' },
  ];
  if (state.is_admin) tabs.push({ id: 'approvals', label: `Approvals${state.inbox ? ` (${state.inbox})` : ''}` });
  if (state.is_admin) tabs.push({ id: 'team', label: 'Team' });
  if (state.is_admin) tabs.push({ id: 'policy', label: 'Policy' });
  if (!tabs.some((t) => t.id === tab)) tab = 'today';

  const bar = el('div', CLS + '-tabs');
  for (const t of tabs) {
    const b = el('button', CLS + '-tab' + (t.id === tab ? ' on' : ''), t.label);
    b.type = 'button';
    b.onclick = () => uiRef.openPanel(PANEL, { tab: t.id });
    bar.appendChild(b);
  }
  host.appendChild(bar);

  const body = el('div', CLS + '-body');
  host.appendChild(body);

  if (tab === 'apply') { applyDialog(); tab = 'mine'; }
  if (tab === 'today') return paintToday(body);
  if (tab === 'mine') return paintMine(body);
  if (tab === 'approvals') return paintApprovals(body);
  if (tab === 'team') return paintTeam(body);
  if (tab === 'policy') return paintPolicy(body);
}

function cta(text, fn) {
  const b = el('button', CLS + '-cta', text);
  b.type = 'button';
  b.onclick = fn;
  return b;
}

function paintToday(host) {
  host.appendChild(cta('＋  Apply for leave', () => applyDialog()));
  const sec = el('div', CLS + '-sec');
  sec.appendChild(el('h4', null, `Away today (${state.away.length})`));
  if (!state.away.length) sec.appendChild(el('div', 'muted', 'Everyone is in today.'));
  else for (const a of state.away) sec.appendChild(personCard(a));
  host.appendChild(sec);
}

function personCard(a) {
  const k = KIND.get(a.kind) || KINDS[0];
  const r = el('div', CLS + '-card');
  r.innerHTML = `<span class="${CLS}-glyph">${k.glyph}</span>
    <span class="${CLS}-main">
      <b>${esc(nameOf(a.user_id))}</b>
      <span class="muted">${esc(k.label)}, ${esc(spanText(a))}</span>
      ${a.note ? `<span class="muted">${esc(a.note)}</span>` : ''}
    </span>
    <span class="${CLS}-back muted">${esc(backText(a.back_on, state.day))}</span>`;
  r.onclick = () => bus.emit('profile:open', { userId: a.user_id, anchor: r });
  return r;
}

// ---- mine: the ledger the whole thing exists for --------------------------
async function paintMine(host) {
  host.appendChild(cta('＋  Apply for leave', () => applyDialog()));

  const b = state.balance;
  if (b) {
    const card = el('div', CLS + '-bal');
    card.innerHTML = `
      <div class="${CLS}-balrow"><b>${esc(String(b.remaining))}</b><span>of ${esc(String(b.allowance))} automatic days left this month</span></div>
      <div class="${CLS}-balrow"><b>${esc(String(b.pending_days))}</b><span>day${b.pending_days === 1 ? '' : 's'} waiting on a decision</span></div>
      <div class="${CLS}-balrow"><b>${esc(String(b.tenure_days))}</b><span>days taken here in total, across ${esc(String(b.tenure_requests))} request${b.tenure_requests === 1 ? '' : 's'}</span></div>
      ${+b.flags ? `<div class="${CLS}-balrow ${CLS}-flagline"><b>${esc(String(b.flags))}</b><span>raised with a coordinator</span></div>` : ''}`;
    host.appendChild(card);
  }

  const sec = el('div', CLS + '-sec');
  sec.appendChild(el('h4', null, 'Everything I have applied for'));
  sec.appendChild(el('div', 'muted', 'Loading'));
  host.appendChild(sec);

  let rows = [];
  try {
    rows = await rpc('list_leave', { p_org: state.org_id, p_status: null, p_user: null, p_from: null, p_limit: 200 }) || [];
  } catch { /* falls through to the empty state */ }

  sec.innerHTML = '';
  sec.appendChild(el('h4', null, 'Everything I have applied for'));
  if (!rows.length) {
    sec.appendChild(el('div', 'muted',
      'Nothing yet. Apply above and it is recorded here for as long as you are with the organisation.'));
    return;
  }
  for (const r of rows) sec.appendChild(ledgerCard(r, { mine: true }));
}

function ledgerCard(r, { mine = false, approver = false } = {}) {
  const k = KIND.get(r.kind) || KINDS[0];
  const st = STATUS[r.status] || STATUS.pending;
  const card = el('div', CLS + '-card ' + CLS + '-ledger');
  card.innerHTML = `<span class="${CLS}-glyph">${k.glyph}</span>
    <span class="${CLS}-main">
      <b>${esc(mine ? k.label : nameOf(r.user_id))}</b>
      <span class="muted">${esc(mine ? '' : k.label + ', ')}${esc(spanText(r))}</span>
      ${r.note ? `<span class="muted">${esc(r.note)}</span>` : ''}
      ${r.decision_note ? `<span class="muted">Coordinator: ${esc(r.decision_note)}</span>` : ''}
      ${r.flagged ? `<span class="${CLS}-flagline">⚠ ${esc(r.flag_reason || 'Raised with a coordinator')}</span>` : ''}
    </span>
    <span class="${CLS}-side">
      <span class="${CLS}-st ${st.cls}">${esc(st.label)}</span>
      ${r.auto_approved ? '<span class="muted tiny">automatic</span>' : ''}
    </span>`;

  const acts = el('div', CLS + '-acts');
  if (approver && r.status === 'pending') {
    const yes = el('button', 'sm', 'Approve');
    yes.type = 'button';
    yes.onclick = (e) => { e.stopPropagation(); decide(r, true); };
    const no = el('button', 'sm ghost', 'Refuse');
    no.type = 'button';
    no.onclick = (e) => { e.stopPropagation(); decide(r, false); };
    acts.append(yes, no);
  }
  if (approver) {
    const f = el('button', 'sm ghost', r.flagged ? 'Clear flag' : 'Flag');
    f.type = 'button';
    f.onclick = (e) => { e.stopPropagation(); flag(r); };
    acts.appendChild(f);
  }
  if (mine && (r.status === 'pending' || r.status === 'approved')) {
    const x = el('button', 'sm ghost', r.status === 'pending' ? 'Withdraw' : 'Cancel');
    x.type = 'button';
    x.onclick = (e) => { e.stopPropagation(); cancel(r); };
    acts.appendChild(x);
  }
  if (acts.childNodes.length) card.appendChild(acts);
  return card;
}

async function decide(r, approve) {
  const out = await uiRef.formModal({
    title: approve ? 'Approve this leave?' : 'Refuse this leave?',
    submitLabel: approve ? 'Approve' : 'Refuse',
    fields: [{ name: 'note', label: 'A note for them (optional)', type: 'textarea', rows: 2,
      placeholder: approve ? 'Have a good break' : 'Clashes with the camp, can you move it?' }],
    note: `${nameOf(r.user_id)}: ${(KIND.get(r.kind) || KINDS[0]).label}, ${spanText(r)}`,
  });
  if (!out) return;
  try {
    await rpc('decide_leave', { p_id: r.id, p_approve: approve, p_note: out.note || null });
    uiRef.toast(approve ? 'Approved' : 'Refused', 'success');
    await refresh();
  } catch (e) { uiRef.toast(explain(e), 'error'); }
}

async function flag(r) {
  if (r.flagged) {
    try { await rpc('flag_leave', { p_id: r.id, p_on: false, p_reason: null }); await refresh(); }
    catch (e) { uiRef.toast(explain(e), 'error'); }
    return;
  }
  const out = await uiRef.formModal({
    title: 'Raise this with the team',
    submitLabel: 'Raise it',
    fields: [{ name: 'reason', label: 'What happened', required: true,
      placeholder: 'Said the work was done but did not show up to the meet' }],
    note: 'A flag stays on the record and the person cannot remove it themselves.',
  });
  if (!out) return;
  try { await rpc('flag_leave', { p_id: r.id, p_on: true, p_reason: out.reason }); await refresh(); }
  catch (e) { uiRef.toast(explain(e), 'error'); }
}

async function cancel(r) {
  const okay = await uiRef.confirmModal({
    title: r.status === 'pending' ? 'Withdraw this request?' : 'Cancel this time off?',
    body: `${spanText(r)} will be marked cancelled. It stays on your record as a cancelled request rather than disappearing.`,
    confirmLabel: r.status === 'pending' ? 'Withdraw it' : 'Cancel it',
  });
  if (!okay) return;
  try { await rpc('cancel_leave', { p_id: r.id, p_reason: null }); await refresh(); }
  catch (e) { uiRef.toast(explain(e), 'error'); }
}

// ---- approvals -------------------------------------------------------------
async function paintApprovals(host) {
  host.appendChild(el('div', 'muted pad', 'Loading'));
  let inbox = null;
  try { inbox = await rpc('leave_inbox', { p_org: state.org_id, p_limit: 100 }); }
  catch (e) { host.innerHTML = ''; host.appendChild(el('div', 'muted pad', explain(e))); return; }
  host.innerHTML = '';

  const used = inbox?.month_used || {};
  hydrateNames([...(inbox?.pending || []), ...(inbox?.flagged || [])].map((r) => r.user_id));

  const wait = el('div', CLS + '-sec');
  wait.appendChild(el('h4', null, `Waiting on you (${(inbox?.pending || []).length})`));
  if (!(inbox?.pending || []).length) {
    wait.appendChild(el('div', 'muted', 'Nothing waiting. Anything the policy does not approve automatically lands here.'));
  } else {
    for (const r of inbox.pending) {
      const card = ledgerCard({ ...r, status: 'pending' }, { approver: true });
      const spent = +used[r.user_id] || 0;
      card.querySelector(`.${CLS}-main`)
        ?.appendChild(el('span', 'muted tiny', `${spent} day${spent === 1 ? '' : 's'} already taken this month`));
      wait.appendChild(card);
    }
  }
  host.appendChild(wait);

  const flagged = el('div', CLS + '-sec');
  flagged.appendChild(el('h4', null, `Raised (${(inbox?.flagged || []).length})`));
  if (!(inbox?.flagged || []).length) {
    flagged.appendChild(el('div', 'muted', 'Nothing raised. Emergency no-shows and absences filed after they began land here.'));
  } else {
    for (const r of inbox.flagged) flagged.appendChild(ledgerCard(r, { approver: true }));
  }
  host.appendChild(flagged);
}

// ---- team ------------------------------------------------------------------
// One read, not one per person. This asked leave_balance once for each member,
// which is fifty round trips and about five seconds of an admin watching
// "Loading" in a fifty-person organisation.
async function paintTeam(host) {
  host.appendChild(el('div', 'muted pad', 'Loading'));
  let out = null;
  try { out = await rpc('leave_team', { p_org: state.org_id, p_month: null }); }
  catch (e) { host.innerHTML = ''; host.appendChild(el('div', 'muted pad', explain(e))); return; }
  host.innerHTML = '';

  const people = Array.isArray(out?.people) ? out.people : [];
  hydrateNames(people.map((p) => p.user_id));

  const sec = el('div', CLS + '-sec');
  sec.appendChild(el('h4', null, 'This month, and since they joined'));
  if (!people.length) { sec.appendChild(el('div', 'muted', 'Nobody to show.')); host.appendChild(sec); return; }

  const allow = +out.allowance || 0;
  for (const p of people) {
    const r = el('div', CLS + '-card ' + CLS + '-team');
    r.innerHTML = `<span class="${CLS}-main">
        <b>${esc(nameOf(p.user_id))}${p.away_today ? ' <span class="muted">· out today</span>' : ''}</b>
        <span class="muted">${esc(String(p.used))} of ${esc(String(allow))} this month
          · ${esc(String(p.tenure_days))} days in total across ${esc(String(p.tenure_requests))} request${p.tenure_requests === 1 ? '' : 's'}
          ${+p.pending_days ? ` · ${esc(String(p.pending_days))} waiting` : ''}</span>
      </span>
      ${+p.flags ? `<span class="${CLS}-flagline">⚠ ${esc(String(p.flags))}</span>` : ''}`;
    r.onclick = () => bus.emit('profile:open', { userId: p.user_id, anchor: r });
    sec.appendChild(r);
  }
  host.appendChild(sec);
}

// ---- policy ----------------------------------------------------------------
async function paintPolicy(host) {
  host.appendChild(el('div', 'muted pad', 'Loading'));
  let pol = null;
  try { pol = await rpc('get_leave_policy', { p_org: state.org_id }); }
  catch (e) { host.innerHTML = ''; host.appendChild(el('div', 'muted pad', explain(e))); return; }
  host.innerHTML = '';

  const sec = el('div', CLS + '-sec');
  sec.appendChild(el('h4', null, 'How leave works in this organisation'));
  const kindNames = (arr) => (arr || []).map((k) => (KIND.get(k) || { label: k }).label).join(', ') || 'none';
  const card = el('div', CLS + '-bal');
  card.innerHTML = `
    <div class="${CLS}-balrow"><b>${esc(String(pol.auto_approve_per_month))}</b><span>days a month approved automatically, per person</span></div>
    <div class="${CLS}-balrow"><b>${esc(String(pol.max_stretch_days))}</b><span>days is the longest single application</span></div>
    <div class="${CLS}-balrow"><span>Spends the allowance: ${esc(kindNames(pol.quota_kinds))}</span></div>
    <div class="${CLS}-balrow"><span>Not a leave at all: ${esc(kindNames(pol.free_kinds))}</span></div>
    <div class="${CLS}-balrow"><span>Always needs approval: ${esc(kindNames(pol.approval_kinds))}</span></div>
    <div class="${CLS}-balrow"><span>Always raised: ${esc(kindNames(pol.flag_kinds))}${pol.flag_backdated ? ', and anything filed after it began' : ''}</span></div>
    ${pol.note ? `<div class="${CLS}-balrow"><span>${esc(pol.note)}</span></div>` : ''}`;
  sec.appendChild(card);
  sec.appendChild(cta('Change the policy', () => policyDialog(pol, state.org_id)));
  host.appendChild(sec);
}

async function policyDialog(pol, orgId) {
  const multi = (name, label, value, hint) => ({
    name, label, value: (value || []).join(', '), hint,
  });
  const out = await uiRef.formModal({
    title: 'Leave policy',
    submitLabel: 'Save',
    wide: true,
    fields: [
      { name: 'auto', label: 'Days approved automatically each month', type: 'number',
        value: pol.auto_approve_per_month, min: 0, max: 31, required: true },
      { name: 'stretch', label: 'Longest single application, in days', type: 'number',
        value: pol.max_stretch_days, min: 1, max: 366, required: true,
        hint: 'Exams are the reason this is usually more than a week' },
      multi('quota', 'Kinds that spend the allowance', pol.quota_kinds,
        'Comma separated: leave, sick, holiday, exam, travel, wfh, emergency'),
      multi('free', 'Kinds that are not leave at all', pol.free_kinds,
        'No approval, and they spend nothing'),
      multi('approval', 'Kinds that always need approval', pol.approval_kinds, ''),
      multi('flag', 'Kinds that are always raised', pol.flag_kinds, ''),
      { name: 'backdated', label: 'Also raise anything filed after it began', type: 'checkbox',
        value: pol.flag_backdated },
      { name: 'note', label: 'A line for the application form', value: pol.note || '',
        placeholder: 'Exam leave needs two weeks notice' },
    ],
    note: 'This applies to everybody in the organisation, in every Space.',
  });
  if (!out) return;
  const list = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase())
    .filter((x) => KIND.has(x));
  try {
    await rpc('set_leave_policy', {
      p_org: orgId || state.org_id,
      p_auto_per_month: Number(out.auto),
      p_max_stretch: Number(out.stretch),
      p_quota_kinds: list(out.quota),
      p_free_kinds: list(out.free),
      p_approval_kinds: list(out.approval),
      p_flag_kinds: list(out.flag),
      p_flag_backdated: !!out.backdated,
      p_note: out.note || null,
    });
    uiRef.toast('Policy saved. It applies to everybody, in every Space.', 'success');
    await refresh();
    bus.emit('leave:policy:saved', { orgId: orgId || state.org_id });
  } catch (e) { uiRef.toast(explain(e), 'error'); }
}

// ------------------------------------------------------------------ styles
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-row .ch-ico{display:inline-flex;align-items:center;justify-content:center;font-size:13px}
.${CLS}-row .${CLS}-back{margin-left:auto;font-size:11px;white-space:nowrap}
.${CLS}-row .badge{margin-left:auto}
.${CLS}-none{padding:2px 10px 4px;font-size:12px}
.${CLS}-book .ch-name{opacity:.85}
.${CLS}-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 4px}
.${CLS}-tab{font-size:12px;padding:4px 10px;border-radius:13px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel2);color:var(--text)}
.${CLS}-tab.on{border-color:var(--accent);color:var(--accent)}
.${CLS}-cta{display:block;width:calc(100% - 20px);margin:10px;padding:8px 10px;
  border:1px dashed var(--line);border-radius:10px;background:var(--panel2);
  color:var(--text);font-size:13px;cursor:pointer;text-align:left}
.${CLS}-cta:hover{border-color:var(--accent);color:var(--accent)}
.${CLS}-sec{padding:4px 10px 12px}
.${CLS}-sec h4{margin:6px 0;font-size:12px;text-transform:uppercase;
  letter-spacing:.04em;color:var(--dim)}
.${CLS}-bal{margin:0 10px 10px;padding:8px 10px;border:1px solid var(--line);
  border-radius:10px;background:var(--panel)}
.${CLS}-balrow{display:flex;align-items:baseline;gap:8px;font-size:12.5px;padding:2px 0;color:var(--dim)}
.${CLS}-balrow b{font-size:15px;color:var(--text);min-width:1.4em}
.${CLS}-card{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;margin-bottom:6px;
  border:1px solid var(--line);border-radius:10px;background:var(--panel);cursor:pointer;
  flex-wrap:wrap}
.${CLS}-card:hover{border-color:var(--accent)}
.${CLS}-glyph{font-size:16px;line-height:1.3}
.${CLS}-main{display:flex;flex-direction:column;gap:1px;font-size:13px;min-width:0;flex:1}
.${CLS}-main .muted{font-size:12px}
.${CLS}-main .tiny{font-size:11px}
.${CLS}-side{display:flex;flex-direction:column;align-items:flex-end;gap:2px;margin-left:auto}
.${CLS}-card .${CLS}-back{margin-left:auto;font-size:11px;white-space:nowrap}
.${CLS}-st{font-size:11px;font-weight:600;white-space:nowrap;padding:1px 8px;border-radius:11px;
  border:1px solid currentColor}
.st-ok{color:var(--green,#3a9d5d)}
.st-wait{color:var(--amber,#c8791a)}
.st-no{color:var(--red,#d64545)}
.st-off{color:var(--faint,#9aa0a6)}
.${CLS}-flagline{color:var(--red,#d64545);font-size:12px}
.${CLS}-acts{display:flex;gap:6px;width:100%;margin-top:4px}
.${CLS}-team{cursor:pointer}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  style();

  ui.registerPanel({ id: PANEL, title: 'Time off', icon: icon('calendar'), render: renderPanel });

  ui.addNavSection({
    id: 'away',
    order: 25,                       // under Topics (20), above Coordination (30)
    render: async (host) => { await load(); paintNav(host); },
  });

  ui.addSlashCommand({
    name: 'leave',
    description: 'Apply for leave, or see who is off today',
    run: (arg) => (/(who|today|team|off)/i.test(arg || '')
      ? ui.openPanel(PANEL, { tab: 'today' })
      : applyDialog()),
  });
  // NOT /away. features/shortcuts.js has owned that since long before this
  // feature existed and it means "set my presence to away", which is a
  // different thing that happens on this device in a second. Two registrations
  // of one name resolve to whichever module finished loading last, so taking it
  // would have made an existing command stop working at random.
  ui.addSlashCommand({
    name: 'timeoff',
    description: 'Who is off today',
    run: () => ui.openPanel(PANEL, { tab: 'today' }),
  });

  // status.js offers "On leave" as a status; choosing it should BE an
  // application, because "even if I just put my status as leave, it's as if I
  // auto applied for it". status.js emits this rather than importing us, since
  // a feature may never import another feature.
  bus.on('leave:apply', (p) => applyDialog(p || {}));

  // The organisation console (features/orgadmin.js) renders the policy as a
  // page and hands the editing back here, so there is one form writing one row
  // rather than two that drift.
  bus.on('leave:policy', async (p) => {
    const orgId = p?.orgId || state.org_id || store.ws?.org_id;
    if (!orgId) return;
    try {
      const pol = await rpc('get_leave_policy', { p_org: orgId });
      policyDialog(pol, orgId);
    } catch (e) { ui.toast(explain(e), 'error'); }
  });

  bus.on('workspace', () => {
    loadedFor = null;
    memberCache = { wsId: null, at: 0, list: [] };
    refresh();
  });

  // main.js turns the per-person realtime event into this. A request filed, or
  // a decision made, anywhere - including on this person's other device - and
  // the sidebar and whatever tab is open correct themselves without a reload.
  bus.on('leave:changed', () => refresh());

  // Midnight matters here more than anywhere else in the app: a panel that
  // still says somebody is away the morning they are back is worse than no
  // panel. One cheap comparison, and a request only when the day has turned.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.day) return;
    if (todayIst() !== state.day) refresh();
  });
}

export default { register };
